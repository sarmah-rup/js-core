import {
  FileReloader,
  FileReloaderConfig,
  LoadFailure,
  ReloadResult,
} from '../../../src/data_sources/filedata';
import TestLogger, { LogLevel } from '../../Logger';
import MockFilesystem from './MockFilesystem';
import testPolicy from './testPolicy';

const path = '/data/data.json';
const second = '/data/second.json';

// A reload starts on a microtask after it is requested. Let it begin before asserting.
const flushMicrotasks = () => jest.advanceTimersByTimeAsync(0);

async function repeat(count: number, action: () => Promise<void>): Promise<void> {
  await Array.from({ length: count }).reduce<Promise<void>>(
    (previous) => previous.then(action),
    Promise.resolve(),
  );
}

describe('given a reloader over a mock filesystem', () => {
  let filesystem: MockFilesystem;
  let logger: TestLogger;
  let applied: ReloadResult[];
  let failures: LoadFailure[];
  let reloader: FileReloader;

  beforeEach(() => {
    jest.useFakeTimers();
    filesystem = new MockFilesystem();
    logger = new TestLogger();
    applied = [];
    failures = [];
  });

  afterEach(() => {
    reloader?.close();
    jest.useRealTimers();
  });

  const makeReloader = (configure?: (config: FileReloaderConfig) => void) => {
    const config: FileReloaderConfig = {
      paths: [path],
      policy: testPolicy({ missingFile: 'fail' }),
      filesystem,
      logger,
      apply: (result) => applied.push(result),
      onFailure: (failure) => failures.push(failure),
      debounceDelayMs: 0,
      retryDelayMs: 0,
      skipUnchanged: false,
    };
    configure?.(config);
    reloader = new FileReloader(config);
    return reloader;
  };

  const flagKeys = (result: ReloadResult) => result.flags.map((flag) => flag.key);

  it('applies the initial load', async () => {
    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    makeReloader();

    await reloader.reloadNow();

    expect(applied).toHaveLength(1);
    expect(flagKeys(applied[0])).toEqual(['flag1']);
    expect(applied[0].files).toEqual([{ path, present: true, flags: 1, segments: 0 }]);
    expect(failures).toHaveLength(0);
  });

  it('fails on a missing file when the policy says so, with the original error', async () => {
    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    makeReloader((config) => {
      config.paths = [path, second];
    });

    await reloader.reloadNow();

    expect(applied).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].kind).toEqual('read');
    expect(failures[0].path).toEqual(second);
    expect(failures[0].error.message).toMatch(/ENOENT/);
    expect(failures[0].repeated).toBe(false);
  });

  it('skips a missing file when the policy says so', async () => {
    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    makeReloader((config) => {
      config.paths = [path, second];
      config.policy = testPolicy({ missingFile: 'skip' });
      config.skipUnchanged = true;
    });

    // Step 1: one file exists and one does not. The reload succeeds with the existing file.
    await reloader.reloadNow();
    expect(applied).toHaveLength(1);
    expect(flagKeys(applied[0])).toEqual(['flag1']);
    expect(applied[0].files).toEqual([
      { path, present: true, flags: 1, segments: 0 },
      { path: second, present: false, flags: 0, segments: 0 },
    ]);

    // Step 2: the missing file appears. Its data is merged in.
    filesystem.set(second, '{"flagValues": {"flag2": true}}');
    await reloader.reloadNow();
    expect(applied).toHaveLength(2);
    expect(flagKeys(applied[1])).toEqual(['flag1', 'flag2']);
    expect(applied[1].files[1]).toEqual({ path: second, present: true, flags: 1, segments: 0 });

    // Step 3: the file is deleted. Its data is gone and the reload still succeeds.
    filesystem.remove(second);
    await reloader.reloadNow();
    expect(applied).toHaveLength(3);
    expect(flagKeys(applied[2])).toEqual(['flag1']);
    expect(failures).toHaveLength(0);
  });

  it('reports a read failure that is not a missing file even when missing files are skipped', async () => {
    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    jest.spyOn(filesystem, 'readFile').mockRejectedValue(new Error('EACCES: permission denied'));
    makeReloader((config) => {
      config.policy = testPolicy({ missingFile: 'skip' });
    });

    await reloader.reloadNow();

    expect(applied).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].kind).toEqual('read');
    expect(failures[0].path).toEqual(path);
    expect(failures[0].error.message).toEqual('EACCES: permission denied');
  });

  it('reports a parse failure with the parser error and applies nothing', async () => {
    filesystem.set(path, '{"flagValues"');
    makeReloader();

    await reloader.reloadNow();

    expect(applied).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].kind).toEqual('parse');
    expect(failures[0].path).toEqual(path);
    expect(failures[0].error.message).toMatch(/json/i);
  });

  it('reports a merge failure', async () => {
    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    filesystem.set(second, '{"flagValues": {"flag1": false}}');
    makeReloader((config) => {
      config.paths = [path, second];
    });

    await reloader.reloadNow();

    expect(applied).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].kind).toEqual('merge');
    expect(failures[0].path).toBeUndefined();
    expect(failures[0].error.message).toEqual('duplicate flag flag1');
  });

  it('stops reading after the first failing file', async () => {
    filesystem.set(second, '{"flagValues": {"flag2": true}}');
    const readFile = jest.spyOn(filesystem, 'readFile');
    makeReloader((config) => {
      config.paths = [path, second];
    });

    await reloader.reloadNow();

    expect(failures).toHaveLength(1);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('merges multiple files in the configured order', async () => {
    filesystem.set(path, '{"flagValues": {"flag1": "first"}}');
    filesystem.set(second, '{"flagValues": {"flag1": "second"}}');
    makeReloader((config) => {
      config.paths = [path, second];
      config.policy = testPolicy({ missingFile: 'fail', resolveDuplicateKey: () => 'keepFirst' });
    });

    await reloader.reloadNow();

    expect(applied).toHaveLength(1);
    expect(applied[0].flags).toHaveLength(1);
    expect(applied[0].flags[0].item.variations).toEqual(['first']);
    expect(applied[0].files).toEqual([
      { path, present: true, flags: 1, segments: 0 },
      { path: second, present: true, flags: 0, segments: 0 },
    ]);
  });

  it('hands the policy the flags of the last applied load and keeps them across a failure', async () => {
    const seen: Array<unknown> = [];
    filesystem.set(path, '{"flagValues": {"flag1": "a"}}');
    makeReloader((config) => {
      config.policy = testPolicy({
        missingFile: 'fail',
        makeFlagWithValue: (key, value, previous) => {
          seen.push(previous?.variations[0]);
          return testPolicy().makeFlagWithValue(key, value, previous);
        },
      });
    });

    await reloader.reloadNow();
    filesystem.set(path, '{"flagValues": {"flag1": "b"}}');
    reloader.trigger();
    await jest.advanceTimersByTimeAsync(0);
    // A failed reload does not disturb the remembered flags.
    filesystem.set(path, '{"flagValues"');
    reloader.trigger();
    await jest.advanceTimersByTimeAsync(0);
    filesystem.set(path, '{"flagValues": {"flag1": "c"}}');
    reloader.trigger();
    await jest.advanceTimersByTimeAsync(0);

    expect(seen).toEqual([undefined, 'a', 'b']);
    expect(applied).toHaveLength(3);
    expect(failures).toHaveLength(1);
  });

  it('reloads after a trigger and logs the reason', async () => {
    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    makeReloader();
    await reloader.reloadNow();

    filesystem.set(path, '{"flagValues": {"flag1": false}}');
    reloader.trigger();
    await jest.advanceTimersByTimeAsync(0);

    expect(applied).toHaveLength(2);
    expect(applied[1].flags[0].item.variations).toEqual([false]);
    logger.expectMessages([
      { level: LogLevel.Info, matches: /Reloading flag data after detecting a change/ },
    ]);
  });

  it('coalesces a burst of triggers into one reload', async () => {
    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    makeReloader((config) => {
      config.debounceDelayMs = 400;
    });
    await reloader.reloadNow();

    filesystem.set(path, '{"flagValues": {"flag1": false}}');
    await repeat(20, async () => {
      reloader.trigger();
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(applied).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(400);
    expect(applied).toHaveLength(2);

    await jest.advanceTimersByTimeAsync(1000);
    expect(applied).toHaveLength(2);
  });

  it('extends the debounce window with each trigger', async () => {
    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    makeReloader((config) => {
      config.debounceDelayMs = 250;
    });
    await reloader.reloadNow();

    // Triggers arrive closer together than the window for five windows. No reload runs while
    // they keep arriving.
    await repeat(25, async () => {
      reloader.trigger();
      await jest.advanceTimersByTimeAsync(50);
    });
    expect(applied).toHaveLength(1);

    // One reload runs after the stream stops.
    await jest.advanceTimersByTimeAsync(250);
    expect(applied).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(500);
    expect(applied).toHaveLength(2);
  });

  it('marks a repeated identical failure and re-arms after a success', async () => {
    filesystem.set(path, '{"flagValues"');
    makeReloader((config) => {
      config.retryDelayMs = 10;
    });

    await reloader.reloadNow();
    expect(failures).toHaveLength(1);
    expect(failures[0].repeated).toBe(false);

    // The automatic retries keep failing identically. Each report is marked as a repeat.
    await jest.advanceTimersByTimeAsync(35);
    expect(failures.length).toBeGreaterThan(1);
    expect(failures.slice(1).every((failure) => failure.repeated)).toBe(true);

    // A different failure is a new report.
    filesystem.set(path, '{"flagValues": {bad}}');
    await jest.advanceTimersByTimeAsync(10);
    const different = failures[failures.length - 1];
    expect(different.repeated).toBe(false);
    expect(different.error.message).toMatch(/json/i);

    // A success re-arms reporting. The same failure afterward is a new report.
    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    await jest.advanceTimersByTimeAsync(10);
    expect(applied).toHaveLength(1);
    filesystem.set(path, '{"flagValues"');
    reloader.trigger();
    await jest.advanceTimersByTimeAsync(0);
    expect(failures[failures.length - 1].repeated).toBe(false);
    logger.expectMessages([
      { level: LogLevel.Debug, matches: /Retrying flag data load after earlier failure/ },
    ]);
  });

  it('retries after a failure without further triggers', async () => {
    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    makeReloader((config) => {
      config.retryDelayMs = 20;
    });
    await reloader.reloadNow();
    expect(applied).toHaveLength(1);

    filesystem.set(path, '{"flagValues"');
    reloader.trigger();
    await jest.advanceTimersByTimeAsync(0);
    expect(failures).toHaveLength(1);
    expect(applied).toHaveLength(1);

    // Fix the file without a trigger. Only the automatic retry can observe the fix.
    filesystem.set(path, '{"flagValues": {"flag1": false}}');
    await jest.advanceTimersByTimeAsync(20);
    expect(applied).toHaveLength(2);
    expect(applied[1].flags[0].item.variations).toEqual([false]);
  });

  it('stops retrying after a success', async () => {
    filesystem.set(path, '{"flagValues"');
    makeReloader((config) => {
      config.retryDelayMs = 10;
      config.skipUnchanged = true;
    });
    await reloader.reloadNow();
    expect(failures).toHaveLength(1);

    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    await jest.advanceTimersByTimeAsync(10);
    expect(applied).toHaveLength(1);

    // No reload happens without a trigger once the retry has succeeded.
    filesystem.set(path, '{"flagValues": {"flag1": false}}');
    await jest.advanceTimersByTimeAsync(100);
    expect(applied).toHaveLength(1);
  });

  it('does not retry when the retry delay is disabled', async () => {
    filesystem.set(path, '{"flagValues"');
    makeReloader();
    await reloader.reloadNow();
    expect(failures).toHaveLength(1);

    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    await jest.advanceTimersByTimeAsync(5000);
    expect(applied).toHaveLength(0);
    expect(failures).toHaveLength(1);
  });

  it('skips an application when the content is unchanged', async () => {
    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    makeReloader((config) => {
      config.skipUnchanged = true;
    });
    await reloader.reloadNow();
    expect(applied).toHaveLength(1);

    reloader.trigger();
    await jest.advanceTimersByTimeAsync(0);
    expect(applied).toHaveLength(1);

    filesystem.set(path, '{"flagValues": {"flag1": false}}');
    reloader.trigger();
    await jest.advanceTimersByTimeAsync(0);
    expect(applied).toHaveLength(2);
  });

  it('applies a recovery even when the content is unchanged', async () => {
    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    makeReloader((config) => {
      config.skipUnchanged = true;
    });
    await reloader.reloadNow();
    expect(applied).toHaveLength(1);

    // A reload fails. The consumer hears about it through onFailure.
    filesystem.remove(path);
    reloader.trigger();
    await jest.advanceTimersByTimeAsync(0);
    expect(failures).toHaveLength(1);

    // The file comes back with identical content. Only apply tells the consumer that the
    // interruption is over, so the success is applied.
    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    reloader.trigger();
    await jest.advanceTimersByTimeAsync(0);
    expect(applied).toHaveLength(2);

    // Once recovered, identical content skips again.
    reloader.trigger();
    await jest.advanceTimersByTimeAsync(0);
    expect(applied).toHaveLength(2);
  });

  it('applies every reload when skip unchanged is off', async () => {
    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    makeReloader();
    await reloader.reloadNow();
    reloader.trigger();
    await jest.advanceTimersByTimeAsync(0);
    expect(applied).toHaveLength(2);
  });

  it('does nothing after close', async () => {
    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    makeReloader((config) => {
      config.retryDelayMs = 10;
    });
    await reloader.reloadNow();
    expect(applied).toHaveLength(1);

    reloader.close();
    reloader.close();
    filesystem.set(path, '{"flagValues": {"flag1": false}}');
    reloader.trigger();
    await reloader.reloadNow();
    await jest.advanceTimersByTimeAsync(100);
    expect(applied).toHaveLength(1);
    expect(failures).toHaveLength(0);
  });

  it('does not deliver the result of a reload that completes after close', async () => {
    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    filesystem.deferReads = true;
    makeReloader();

    const pending = reloader.reloadNow();
    await flushMicrotasks();
    expect(filesystem.pendingReads).toHaveLength(1);

    reloader.close();
    filesystem.completePendingReads();
    await pending;

    expect(applied).toHaveLength(0);
    expect(failures).toHaveLength(0);
  });

  it('does not deliver a failure from a reload that completes after close', async () => {
    filesystem.deferReads = true;
    makeReloader((config) => {
      config.retryDelayMs = 10;
    });

    const pending = reloader.reloadNow();
    await flushMicrotasks();
    expect(filesystem.pendingReads).toHaveLength(1);
    reloader.close();
    filesystem.completePendingReads();
    await pending;
    await jest.advanceTimersByTimeAsync(100);

    expect(failures).toHaveLength(0);
  });

  it('runs reloads one at a time', async () => {
    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    filesystem.deferReads = true;
    makeReloader();

    const first = reloader.reloadNow();
    await flushMicrotasks();
    expect(filesystem.readCount).toEqual(1);

    // The second reload waits for the first to finish before it reads anything.
    filesystem.deferReads = false;
    const secondReload = reloader.reloadNow();
    await flushMicrotasks();
    expect(filesystem.readCount).toEqual(1);
    expect(applied).toHaveLength(0);

    filesystem.completePendingReads();
    await first;
    await secondReload;
    expect(filesystem.readCount).toEqual(2);
    expect(applied).toHaveLength(2);
  });

  it('coalesces triggers that arrive while a reload is in progress', async () => {
    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    filesystem.deferReads = true;
    makeReloader();

    const first = reloader.reloadNow();
    await flushMicrotasks();
    expect(filesystem.readCount).toEqual(1);
    reloader.trigger();
    reloader.trigger();
    reloader.trigger();
    await flushMicrotasks();
    expect(filesystem.readCount).toEqual(1);

    filesystem.deferReads = false;
    filesystem.completePendingReads();
    await first;
    await jest.advanceTimersByTimeAsync(0);

    // One reload for the initial load and one for the whole burst.
    expect(filesystem.readCount).toEqual(2);
    expect(applied).toHaveLength(2);
  });

  it('reads the files in the configured order on every reload', async () => {
    filesystem.set(path, '{"flagValues": {"flag1": true}}');
    filesystem.set(second, '{"flagValues": {"flag2": true}}');
    const readFile = jest.spyOn(filesystem, 'readFile');
    makeReloader((config) => {
      config.paths = [second, path];
    });

    await reloader.reloadNow();
    reloader.trigger();
    await jest.advanceTimersByTimeAsync(0);

    expect(readFile.mock.calls.map((call) => call[0])).toEqual([second, path, second, path]);
    expect(flagKeys(applied[1])).toEqual(['flag2', 'flag1']);
  });

  it('uses the policy parser', async () => {
    const parseDocument = jest.fn(() => ({ flagValues: { flag1: true } }));
    filesystem.set('/data/data.yaml', 'flagValues:\n  flag1: true\n');
    makeReloader((config) => {
      config.paths = ['/data/data.yaml'];
      config.policy = testPolicy({ missingFile: 'fail', parseDocument });
    });

    await reloader.reloadNow();

    expect(parseDocument).toHaveBeenCalledWith('/data/data.yaml', 'flagValues:\n  flag1: true\n');
    expect(applied).toHaveLength(1);
    expect(flagKeys(applied[0])).toEqual(['flag1']);
  });
});

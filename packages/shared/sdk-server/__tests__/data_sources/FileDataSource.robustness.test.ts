import { ClientContext } from '@launchdarkly/js-sdk-common';

import { FileDataSourceFactory } from '../../src/integrations';
import Configuration from '../../src/options/Configuration';
import AsyncStoreFacade from '../../src/store/AsyncStoreFacade';
import InMemoryFeatureStore from '../../src/store/InMemoryFeatureStore';
import VersionedDataKinds from '../../src/store/VersionedDataKinds';
import { createBasicPlatform } from '../createBasicPlatform';
import TestLogger from '../Logger';
import MockFilesystem from './filedata/MockFilesystem';

// These tests run on real timers. The source waits for change notifications to settle for
// 100 ms and retries a failed load after one second.

const directory = '/data';
const path = `${directory}/flags.json`;
const document = (value: string) => JSON.stringify({ flagValues: { flag: value } });

const settle = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await condition()) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await settle(20);
  }
  throw new Error('timed out waiting for the condition');
}

describe('given a file data source with automatic updates over a mock filesystem', () => {
  let filesystem: MockFilesystem;
  let featureStore: InMemoryFeatureStore;
  let asyncFeatureStore: AsyncStoreFacade;
  let errorHandler: jest.Mock;
  let initSuccessHandler: jest.Mock;
  let source: ReturnType<FileDataSourceFactory['create']> | undefined;

  beforeEach(() => {
    filesystem = new MockFilesystem();
    featureStore = new InMemoryFeatureStore();
    asyncFeatureStore = new AsyncStoreFacade(featureStore);
    errorHandler = jest.fn();
    initSuccessHandler = jest.fn();
  });

  afterEach(() => {
    source?.close();
    source = undefined;
  });

  const start = () => {
    source = new FileDataSourceFactory({ paths: [path], autoUpdate: true }).create(
      new ClientContext('', new Configuration({ featureStore, logger: new TestLogger() }), {
        ...createBasicPlatform(),
        fileSystem: filesystem,
      }),
      featureStore,
      initSuccessHandler,
      errorHandler,
    );
    source.start();
  };

  const flagValue = async () =>
    (await asyncFeatureStore.get(VersionedDataKinds.Features, 'flag'))?.variations[0];
  const flagVersion = async () =>
    (await asyncFeatureStore.get(VersionedDataKinds.Features, 'flag'))?.version;
  const valueIs = (value: string) => async () => (await flagValue()) === value;

  it('does not leave an unhandled rejection when a file disappears during a reload', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      filesystem.set(path, document('a'));
      start();
      await waitFor(valueIs('a'));

      // The file is removed and the directory reports it. The reload fails to read the file.
      filesystem.remove(path);
      filesystem.emit(directory, 'rename');
      await waitFor(async () => errorHandler.mock.calls.length > 0);
      expect(errorHandler.mock.calls[0][0].message).toMatch(/ENOENT/);
      expect(await flagValue()).toEqual('a');

      // The file comes back without a notification. The retry loads it.
      filesystem.set(path, document('b'));
      await waitFor(valueIs('b'));

      await settle(50);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('detects a file that is replaced by a rename', async () => {
    filesystem.set(path, document('a'));
    start();
    await waitFor(valueIs('a'));

    // A rename-based write replaces the file. The directory reports a rename, not a change
    // to the watched file.
    filesystem.set(path, document('b'));
    filesystem.emit(directory, 'rename');

    await waitFor(valueIs('b'));
  });

  it('retries a failed reload and recovers without another change notification', async () => {
    filesystem.set(path, document('a'));
    start();
    await waitFor(valueIs('a'));

    filesystem.set(path, '{"flagValues"');
    filesystem.emit(directory, 'change');
    await waitFor(async () => errorHandler.mock.calls.length > 0);
    expect(errorHandler.mock.calls[0][0].message).toMatch(/json/i);
    // The last good data stays in effect.
    expect(await flagValue()).toEqual('a');

    // The file is fixed with no further notification. Only the retry can observe it.
    filesystem.set(path, document('b'));
    await waitFor(valueIs('b'));
    expect(errorHandler).toHaveBeenCalledTimes(1);
  });

  it('keeps the version baseline intact across a failed reload', async () => {
    filesystem.set(path, document('a'));
    start();
    await waitFor(valueIs('a'));
    expect(await flagVersion()).toEqual(1);

    filesystem.set(path, document('b'));
    filesystem.emit(directory, 'change');
    await waitFor(valueIs('b'));
    expect(await flagVersion()).toEqual(2);

    // A malformed edit fails the reload. The internal state of the last good load is intact.
    filesystem.set(path, '{"flagValues"');
    filesystem.emit(directory, 'change');
    await waitFor(async () => errorHandler.mock.calls.length > 0);

    // The next value change continues the version sequence from the last good load.
    filesystem.set(path, document('c'));
    filesystem.emit(directory, 'change');
    await waitFor(valueIs('c'));
    expect(await flagVersion()).toEqual(3);
  });

  it('waits for change notifications to settle before reloading', async () => {
    filesystem.set(path, document('a'));
    start();
    await waitFor(valueIs('a'));
    const init = jest.spyOn(featureStore, 'init');

    // Five edits arrive closer together than the settle window.
    await ['b', 'c', 'd', 'e', 'f'].reduce<Promise<void>>(
      (previous, value) =>
        previous.then(async () => {
          filesystem.set(path, document(value));
          filesystem.emit(directory, 'change');
          await settle(20);
        }),
      Promise.resolve(),
    );

    await waitFor(valueIs('f'));
    await settle(150);
    // One reload for the whole burst.
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('reports a file that is missing at start and loads it when it appears', async () => {
    start();

    await waitFor(async () => errorHandler.mock.calls.length > 0);
    expect(errorHandler.mock.calls[0][0].message).toMatch(/ENOENT/);
    expect(initSuccessHandler).not.toHaveBeenCalled();
    expect(await asyncFeatureStore.initialized()).toBe(false);

    // The file appears without a notification. The retry loads it and the source initializes.
    filesystem.set(path, document('a'));
    await waitFor(valueIs('a'));
    expect(initSuccessHandler).toHaveBeenCalledTimes(1);
  });
});

import {
  isFileNotFoundError,
  isYamlPath,
  parseDocumentByContent,
  parseDocumentByExtension,
} from '../../../src/data_sources/filedata';

const flag1 = {
  key: 'flag1',
  on: true,
  fallthrough: { variation: 0 },
  variations: [true],
  version: 2,
};
const segment1 = { key: 'segment1', included: ['user1'], version: 3 };
const jsonDocument = JSON.stringify({
  flags: { flag1 },
  flagValues: { flag2: 'value' },
  segments: { segment1 },
});
const yamlDocument = 'flagValues:\n  flag1: true\n';

describe('given the extension-based parser', () => {
  it('parses a file without a YAML extension as JSON and does not consult the YAML parser', () => {
    const yamlParser = jest.fn();
    const document = parseDocumentByExtension(yamlParser)('data.txt', jsonDocument);
    expect(document.flags).toEqual({ flag1 });
    expect(document.flagValues).toEqual({ flag2: 'value' });
    expect(document.segments).toEqual({ segment1 });
    expect(yamlParser).not.toHaveBeenCalled();
  });

  it('reports a JSON error for a file without a YAML extension whose content is YAML', () => {
    const yamlParser = jest.fn();
    expect(() => parseDocumentByExtension(yamlParser)('data.json', yamlDocument)).toThrow(/json/i);
    expect(yamlParser).not.toHaveBeenCalled();
  });

  it.each(['data.yml', 'data.yaml'])(
    'parses %s with the YAML parser even when the content looks like JSON',
    (path) => {
      const yamlParser = jest.fn(() => ({ flagValues: { flag1: true } }));
      const document = parseDocumentByExtension(yamlParser)(path, jsonDocument);
      expect(yamlParser).toHaveBeenCalledWith(jsonDocument);
      expect(document.flagValues).toEqual({ flag1: true });
    },
  );

  it.each(['data.yml', 'data.yaml'])('reports a missing YAML parser for %s', (path) => {
    expect(() => parseDocumentByExtension()(path, '')).toThrow(
      `Attempted to parse yaml file (${path}) without parser.`,
    );
  });

  it('returns the parsed value as it is, without validation', () => {
    const parse = parseDocumentByExtension();
    expect(parse('data.json', '{"flags": [], "flagValues": null, "segments": 0}')).toEqual({
      flags: [],
      flagValues: null,
      segments: 0,
    });
    expect(parse('data.json', '{"flags": {"flag-a": {"version": 1}}}')).toEqual({
      flags: { 'flag-a': { version: 1 } },
    });
    expect(parse('data.json', 'null')).toBeNull();
  });
});

describe('given the content-based parser', () => {
  it('parses a JSON document with flags, flag values, and segments', () => {
    const document = parseDocumentByContent()('data.json', jsonDocument);
    expect(document.flags).toEqual({ flag1 });
    expect(document.flagValues).toEqual({ flag2: 'value' });
    expect(document.segments).toEqual({ segment1 });
  });

  it('parses a JSON document that only has some members', () => {
    const document = parseDocumentByContent()(
      'data.json',
      JSON.stringify({ flagValues: { flag2: 'value' } }),
    );
    expect(document.flags).toBeUndefined();
    expect(document.flagValues).toEqual({ flag2: 'value' });
    expect(document.segments).toBeUndefined();
  });

  it('treats an empty document as a document with no members', () => {
    expect(parseDocumentByContent()('data.json', '{}')).toEqual({});
  });

  it.each(['data.yml', 'data.yaml'])(
    'parses a file with a YAML extension using the parser: %s',
    (path) => {
      const yamlParser = jest.fn(() => ({ flagValues: { flag1: true } }));
      const document = parseDocumentByContent(yamlParser)(path, yamlDocument);
      expect(yamlParser).toHaveBeenCalledWith(yamlDocument);
      expect(document.flagValues).toEqual({ flag1: true });
    },
  );

  it('detects YAML from the content when the extension is not a YAML extension', () => {
    const yamlParser = jest.fn(() => ({ flagValues: { flag1: true } }));
    const document = parseDocumentByContent(yamlParser)('data.json', yamlDocument);
    expect(yamlParser).toHaveBeenCalledTimes(1);
    expect(document.flagValues).toEqual({ flag1: true });
  });

  it('parses JSON content as JSON without consulting the YAML parser', () => {
    const yamlParser = jest.fn();
    const document = parseDocumentByContent(yamlParser)(
      'data.txt',
      '  \n{"flagValues": {"flag1": true}}',
    );
    expect(yamlParser).not.toHaveBeenCalled();
    expect(document.flagValues).toEqual({ flag1: true });
  });

  it('always parses a file with a YAML extension as YAML, even when the content looks like JSON', () => {
    const yamlParser = jest.fn(() => ({ flagValues: { flag1: true } }));
    parseDocumentByContent(yamlParser)('data.yaml', '{"flagValues": {"flag1": true}}');
    expect(yamlParser).toHaveBeenCalledTimes(1);
  });

  it('reports a YAML file when no parser is available', () => {
    expect(() => parseDocumentByContent()('data.yml', '')).toThrow(
      'Attempted to parse yaml file (data.yml) without parser.',
    );
    expect(() => parseDocumentByContent()('data.json', yamlDocument)).toThrow(
      'Attempted to parse yaml file (data.json) without parser.',
    );
  });

  it('treats a parser result of null or undefined as an empty document', () => {
    expect(parseDocumentByContent(() => null)('empty.yaml', '')).toEqual({});
    expect(parseDocumentByContent(() => undefined)('empty.yaml', '')).toEqual({});
  });

  it('rejects malformed JSON', () => {
    expect(() => parseDocumentByContent()('data.json', '{"flagValues"')).toThrow(/json/i);
  });

  it('rejects a document that is not an object', () => {
    expect(() => parseDocumentByContent(() => ['a'])('data.yaml', '- a\n')).toThrow(
      'file data must be an object',
    );
    expect(() => parseDocumentByContent(() => 'text')('data.yaml', 'text')).toThrow(
      'file data must be an object',
    );
  });

  it('rejects members that are not objects keyed by item key', () => {
    const parse = parseDocumentByContent();
    expect(() => parse('data.json', '{"flags": []}')).toThrow(
      '"flags" must be an object keyed by flag key',
    );
    expect(() => parse('data.json', '{"segments": "x"}')).toThrow(
      '"segments" must be an object keyed by segment key',
    );
    expect(() => parse('data.json', '{"flagValues": [1]}')).toThrow(
      '"flagValues" must be an object keyed by flag key',
    );
  });

  it('rejects a flag or segment entry that is not an object', () => {
    const parse = parseDocumentByContent();
    expect(() => parse('data.json', '{"flags": {"flag1": "x"}}')).toThrow(
      'flag "flag1" must be an object',
    );
    expect(() => parse('data.json', '{"segments": {"segment1": 7}}')).toThrow(
      'segment "segment1" must be an object',
    );
  });

  it('fills a missing entry key from the map key and keeps an existing key', () => {
    const document = parseDocumentByContent()(
      'data.json',
      JSON.stringify({
        flags: { 'flag-a': { on: false, version: 1 }, 'flag-b': { key: 'other', version: 1 } },
        segments: { 'segment-a': { version: 1 } },
      }),
    );
    expect(document.flags?.['flag-a'].key).toEqual('flag-a');
    expect(document.flags?.['flag-b'].key).toEqual('other');
    expect(document.segments?.['segment-a'].key).toEqual('segment-a');
  });
});

it('recognizes YAML paths', () => {
  expect(isYamlPath('a.yml')).toBe(true);
  expect(isYamlPath('a.yaml')).toBe(true);
  expect(isYamlPath('a.json')).toBe(false);
  expect(isYamlPath('a.yaml.json')).toBe(false);
});

it('recognizes a file not found error by its code', () => {
  const err = new Error('missing') as Error & { code: string };
  err.code = 'ENOENT';
  expect(isFileNotFoundError(err)).toBe(true);
  expect(isFileNotFoundError(new Error('other'))).toBe(false);
  expect(isFileNotFoundError(undefined)).toBe(false);
  expect(isFileNotFoundError({ code: 'EACCES' })).toBe(false);
});

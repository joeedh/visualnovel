import type { CatalogEntry, CatalogProp } from '../../../src/shared/ipc';
import {
  blankProps,
  blankValue,
  bulkSize,
  fieldText,
  fieldValue,
  filterCommands,
  matches,
} from '../catalog';

const prop = (over: Partial<CatalogProp> & { name: string }): CatalogProp => ({
  kind: 'string',
  description: '',
  required: false,
  ...over,
});

const entry = (id: string, title: string, props: CatalogProp[] = []): CatalogEntry => ({
  id,
  title,
  description: '',
  mutating: false,
  confirm: false,
  undoable: false,
  checkable: false,
  props,
  usage: `${id}()`,
  schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
});

const ENTRIES = [
  entry('story.assignLineIds', 'Assign line ids'),
  entry('story.setCoverage', 'Set shot coverage'),
  entry('pipeline.run', 'Run the pipeline'),
];

describe('palette matching', () => {
  it('matches on id and on title', () => {
    expect(matches(ENTRIES[0]!, 'assign')).toBe(true);
    expect(matches(ENTRIES[0]!, 'line ids')).toBe(true);
    expect(matches(ENTRIES[0]!, 'coverage')).toBe(false);
  });

  it('requires every term, in any order and any field', () => {
    expect(matches(ENTRIES[0]!, 'story ids')).toBe(true);
    expect(matches(ENTRIES[0]!, 'ids story')).toBe(true);
    expect(matches(ENTRIES[0]!, 'story pipeline')).toBe(false);
  });

  it('is not fuzzy — a typo finds nothing rather than the wrong command', () => {
    expect(matches(ENTRIES[2]!, 'ppeline')).toBe(false);
  });

  it('shows everything for an empty query', () => {
    expect(filterCommands(ENTRIES, '   ')).toHaveLength(3);
    expect(filterCommands(ENTRIES, 'story').map((e) => e.id)).toEqual([
      'story.assignLineIds',
      'story.setCoverage',
    ]);
  });
});

describe('prop form values', () => {
  it('starts a field at its declared default, else the kind blank', () => {
    expect(blankValue(prop({ name: 'scene', default: 'arrival' }))).toBe('arrival');
    expect(blankValue(prop({ name: 'scene' }))).toBe('');
    expect(blankValue(prop({ name: 'n', kind: 'number' }))).toBe(0);
    expect(blankValue(prop({ name: 'mock', kind: 'boolean' }))).toBe(false);
    expect(blankValue(prop({ name: 'lines', kind: 'string[]' }))).toEqual([]);
  });

  it('starts an enum at its first value, so the select is never blank', () => {
    expect(blankValue(prop({ name: 'editor', kind: 'enum', values: ['script', 'branches'] }))).toBe(
      'script',
    );
  });

  it('gives every declared prop a starting value', () => {
    const command = entry('view.open', 'Show an editor', [
      prop({ name: 'editor', kind: 'enum', values: ['script', 'branches'] }),
      prop({ name: 'mock', kind: 'boolean', default: true }),
    ]);
    expect(blankProps(command)).toEqual({ editor: 'script', mock: true });
  });

  it('coerces an edited field back to its declared kind', () => {
    expect(fieldValue(prop({ name: 'n', kind: 'number' }), '12')).toBe(12);
    expect(fieldValue(prop({ name: 'n', kind: 'number' }), '  ')).toBe(0);
    expect(fieldValue(prop({ name: 'mock', kind: 'boolean' }), true)).toBe(true);
    expect(fieldValue(prop({ name: 'scene', kind: 'string' }), 'arrival')).toBe('arrival');
  });

  it('edits a list as comma-separated text, round-tripping through fieldText', () => {
    const spec = prop({ name: 'lines', kind: 'string[]' });
    expect(fieldValue(spec, 'a:L1, a:L2 ,, a:L3')).toEqual(['a:L1', 'a:L2', 'a:L3']);
    expect(fieldText(fieldValue(spec, 'a:L1, a:L2'))).toBe('a:L1, a:L2');
    expect(fieldText('arrival')).toBe('arrival');
  });

  it('summarizes a bulk prop by size, in the unit that reads', () => {
    expect(bulkSize('')).toBe('0 characters');
    expect(bulkSize('x'.repeat(2047))).toBe('2047 characters');
    expect(bulkSize('x'.repeat(2048))).toBe('2 KB');
    expect(bulkSize('x'.repeat(23277))).toBe('23 KB');
    // A list measures as the text the form would have shown, separators and all.
    expect(bulkSize(['ab', 'cd'])).toBe('6 characters');
  });
});

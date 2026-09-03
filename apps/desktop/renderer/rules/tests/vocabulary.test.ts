import type { CatalogEntry, CatalogProp } from '../../../src/shared/ipc';
import type { ThreadHeader } from '../../../src/shared/convo';
import { NO_VOCABULARY, picksAnAsset, vocabularyFor, type ProjectVocabulary } from '../vocabulary';

const prop = (over: Partial<CatalogProp> & { name: string }): CatalogProp => ({
  kind: 'string',
  description: `the ${over.name}`,
  required: true,
  ...over,
});

const entry = (id: string, props: CatalogProp[]): CatalogEntry => ({
  id,
  title: id,
  description: '',
  mutating: false,
  confirm: false,
  undoable: false,
  checkable: false,
  props,
  usage: `${id}()`,
  schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
});

const THREAD: ThreadHeader = {
  id: 'thread-1',
  title: 'the rooftop pass',
  startedAt: '2026-08-31T10:54:00.000Z',
};

const PROJECT: ProjectVocabulary = {
  scenes: [
    { id: 'rooftop_intro', location: 'rooftop', characters: ['aiko'], choices: 1, reachable: true },
    { id: 'orphan', location: 'rooftop', characters: [], choices: 0, reachable: false },
  ],
  characters: [
    { id: 'aiko', name: 'Aiko', status: 'approved' },
    { id: 'haruki', name: '', status: 'candidates' },
  ],
  threads: [THREAD],
  boundModel: 'claude-sonnet-5',
};

describe('which props get a list', () => {
  it('offers the project’s scenes for every prop that names one', () => {
    const command = entry('story.setNext', [
      prop({ name: 'scene' }),
      prop({ name: 'goto', required: false, default: '' }),
    ]);
    const lists = vocabularyFor(command, PROJECT, {});

    expect(lists['scene']?.map((row) => row.value)).toEqual(['rooftop_intro', 'orphan']);
    // `goto` takes an empty value, which is a choice rather than an unfilled field.
    expect(lists['goto']?.map((row) => row.value)).toEqual(['', 'rooftop_intro', 'orphan']);
  });

  it('leaves a prop alone when the project has nothing to offer', () => {
    const command = entry('story.setNext', [prop({ name: 'scene' })]);
    expect(vocabularyFor(command, NO_VOCABULARY, {})).toEqual({});
  });

  it('leaves free text alone, however it is spelled', () => {
    const command = entry('story.setChoice', [
      prop({ name: 'scene' }),
      prop({ name: 'label' }),
      prop({ name: 'note', multiline: true }),
    ]);
    const lists = vocabularyFor(command, PROJECT, {});

    expect(Object.keys(lists)).toEqual(['scene']);
  });

  it('reads `id` as a conversation only where it is one', () => {
    const thread = entry('agent.openThread', [prop({ name: 'id' })]);
    const note = entry('notify.hide', [prop({ name: 'id' })]);

    expect(vocabularyFor(thread, PROJECT, {})['id']?.[0]?.value).toBe('thread-1');
    expect(vocabularyFor(note, PROJECT, {})).toEqual({});
  });

  it('names a character by name and sends the id', () => {
    const command = entry('gate.approve', [prop({ name: 'characterId' })]);
    const rows = vocabularyFor(command, PROJECT, {})['characterId'];

    expect(rows?.map((row) => [row.value, row.label])).toEqual([
      ['aiko', 'Aiko'],
      ['haruki', 'haruki'],
    ]);
  });
});

describe('the model and effort lists', () => {
  const command = entry('report.open', [
    prop({ name: 'model', required: false, default: '' }),
    prop({ name: 'effort', required: false, default: '' }),
    { ...prop({ name: 'source' }), kind: 'boolean' },
  ]);

  it('answers with an empty list when the chosen model has no reasoning setting', () => {
    const lists = vocabularyFor(command, PROJECT, { model: 'gpt-4o' });
    expect(lists['effort']).toEqual([]);
  });

  it('falls back to the bound model when the field is left empty', () => {
    const bound = vocabularyFor(command, PROJECT, { model: '' });
    const named = vocabularyFor(command, PROJECT, { model: PROJECT.boundModel });
    expect(bound['effort']).toEqual(named['effort']);
  });

  it('always offers a model, since the list is the API’s rather than the project’s', () => {
    expect(vocabularyFor(command, NO_VOCABULARY, {})['model']?.length).toBeGreaterThan(1);
  });
});

describe('asset props', () => {
  it('offers the gallery for the props that hold a stored asset', () => {
    expect(picksAnAsset(prop({ name: 'hash' }))).toBe(true);
    expect(picksAnAsset(prop({ name: 'ref' }))).toBe(true);
    // A document's hash, not an asset's.
    expect(picksAnAsset(prop({ name: 'seenHash' }))).toBe(false);
  });
});

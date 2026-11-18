import {
  answer,
  byId,
  bySubject,
  formatFound,
  INDEX,
  isSubject,
  MAX_RESULTS,
  search,
  type ContractIndex,
  type ContractRecord,
} from '../query.js';

const record = (id: string, subjects: string[], extra: Partial<ContractRecord> = {}) => ({
  id,
  rule    : `The rule of ${id}.`,
  prevents: `The failure ${id} prevents.`,
  subjects,
  declared: 'packages/x/src/x.ts',
  ...extra,
});

/** An index built the way the generator builds one, from a list of records. */
function indexOf(contracts: ContractRecord[]): ContractIndex {
  const bySubject: Record<string, string[]> = {};
  for (const c of contracts) for (const s of c.subjects) (bySubject[s] ??= []).push(c.id);
  return { contracts, bySubject };
}

const index = indexOf([
  record('script.lineIds', ['module:packages/scriptedit/src/lineops.ts', 'command:story.x'], {
    detail: 'Longer text.',
    see   : ['docs/a.md#b'],
  }),
  record('log.writers', ['function:packages/taskgraph/src/write.ts#logTask', 'tool:edit_scene']),
  record('gate.perUnit', ['module:packages/stills/src/gate.ts']),
]);

describe('the committed index', () => {
  it('parses as an index', () => {
    expect(Array.isArray(INDEX.contracts)).toBe(true);
    expect(typeof INDEX.bySubject).toBe('object');
  });
});

describe('byId', () => {
  it('answers a summary unless asked for the full record', () => {
    expect(byId('script.lineIds', { index })).toEqual({
      id      : 'script.lineIds',
      rule    : 'The rule of script.lineIds.',
      subjects: ['module:packages/scriptedit/src/lineops.ts', 'command:story.x'],
    });
    expect(byId('script.lineIds', { index, full: true })).toMatchObject({
      prevents: 'The failure script.lineIds prevents.',
      detail  : 'Longer text.',
    });
    expect(byId('script.nothing', { index })).toBeUndefined();
  });
});

describe('bySubject', () => {
  it('matches a subject exactly or by prefix', () => {
    const ids = (s: string) => bySubject(s, { index }).contracts.map((c) => c.id);
    expect(ids('command:story.x')).toEqual(['script.lineIds']);
    expect(ids('module:packages/st')).toEqual(['gate.perUnit']);
    expect(ids('module:packages/')).toEqual(['gate.perUnit', 'log.writers', 'script.lineIds']);
    expect(ids('tool:')).toEqual(['log.writers']);
    expect(ids('command:story.y')).toEqual([]);
  });

  it('finds the functions inside a module it is asked about', () => {
    expect(
      bySubject('module:packages/taskgraph/src/write.ts', { index }).contracts.map((c) => c.id),
    ).toEqual(['log.writers']);
  });

  it('caps the answer and says how many it left out', () => {
    const many = indexOf(
      Array.from({ length: MAX_RESULTS + 5 }, (_, i) =>
        record(`log.n${String(i).padStart(2, '0')}`, ['module:packages/x/src/x.ts']),
      ),
    );
    const found = bySubject('module:packages/x/', { index: many });
    expect(found.contracts).toHaveLength(MAX_RESULTS);
    expect(found.omitted).toBe(5);
    expect(formatFound(found, 'module:packages/x/')).toContain('5 more matched and were left out');
  });
});

describe('search', () => {
  it('matches every word, case-insensitively, over the record', () => {
    expect(search('FAILURE gate', { index }).contracts.map((c) => c.id)).toEqual(['gate.perUnit']);
    expect(search('longer', { index }).contracts.map((c) => c.id)).toEqual(['script.lineIds']);
    expect(search('   ', { index }).contracts).toEqual([]);
  });
});

describe('answer', () => {
  it('reads an id, a subject or text, and refuses a query that names none', () => {
    expect(answer({ id: 'gate.perUnit' }, { index }).output).toBe(
      'gate.perUnit: The rule of gate.perUnit. [module:packages/stills/src/gate.ts]',
    );
    expect(answer({ subject: 'tool:edit_scene', full: true }, { index }).output).toContain(
      'prevents: The failure log.writers prevents.',
    );
    expect(answer({ text: 'nothing like this' }, { index }).output).toBe(
      'No contract matches "nothing like this".',
    );
    expect(answer({}, { index }).ok).toBe(false);
  });

  it('tells a subject from an id or text by its prefix', () => {
    expect(isSubject('module:packages/x')).toBe(true);
    expect(isSubject('gate.perUnit')).toBe(false);
    expect(isSubject('nothing: here')).toBe(false);
  });
});

import {
  makerOf,
  statusCause,
  textDiff,
  type HistoryEntry,
  type InProgress,
  type StatusEntry,
} from '../index.js';

const LOCAL = { name: 'VN Studio', email: 'vnstudio@localhost' };
const QUIET: InProgress = { rebase: null, merge: false, revert: false };

function commit(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    sha     : 'a'.repeat(40),
    parents : ['b'.repeat(40)],
    author  : LOCAL.name,
    email   : LOCAL.email,
    date    : '2026-09-21T10:00:00+00:00',
    subject : 'Set the heading of rooftop',
    body    : '',
    trailers: {},
    files   : [],
    ...over,
  };
}

describe('makerOf', () => {
  const ctx = { local: LOCAL, housekeeping: ['New project', 'Existing project files'] };

  it('reads a command trailer from the ui as the author', () => {
    const c = commit({ trailers: { 'Vn-Command': 'story.setHeading', 'Vn-Source': 'ui' } });
    expect(makerOf(c, ctx)).toBe('author');
  });

  it('reads an agent turn, by source or by command, as the agent', () => {
    expect(
      makerOf(commit({ trailers: { 'Vn-Command': 'agent.run', 'Vn-Source': 'ui' } }), ctx),
    ).toBe('agent');
    expect(
      makerOf(
        commit({ trailers: { 'Vn-Command': 'story.setHeading', 'Vn-Source': 'agent' } }),
        ctx,
      ),
    ).toBe('agent');
  });

  it('reads a batch as the agent when any act in it was the agent’s', () => {
    const c = commit({
      trailers: { 'Vn-Command': 'story.setHeading, agent.run', 'Vn-Source': 'ui, menu' },
    });
    expect(makerOf(c, ctx)).toBe('agent');
  });

  it('reads a pipeline run, an art command and a graph run as the pipeline', () => {
    for (const id of ['pipeline.run', 'pipeline.approveAndRun', 'art.generate', 'gengraph.run']) {
      expect(makerOf(commit({ trailers: { 'Vn-Command': id, 'Vn-Source': 'ui' } }), ctx)).toBe(
        'pipeline',
      );
    }
  });

  it('reads a sweep, a root commit and a scaffolding subject as housekeeping', () => {
    expect(makerOf(commit({ trailers: { 'Vn-Sweep': 'true' } }), ctx)).toBe('housekeeping');
    expect(makerOf(commit({ parents: [] }), ctx)).toBe('housekeeping');
    expect(makerOf(commit({ subject: 'New project' }), ctx)).toBe('housekeeping');
  });

  it('reads another identity as someone else, whatever the trailers say', () => {
    const c = commit({
      author  : 'Other',
      email   : 'other@example.com',
      trailers: { 'Vn-Command': 'story.setHeading', 'Vn-Source': 'ui' },
    });
    expect(makerOf(c, ctx)).toBe('other');
  });

  it('falls back to the name when no email is configured', () => {
    const named = { local: { name: 'VN Studio', email: null } };
    expect(makerOf(commit({ email: 'whatever@x' }), named)).toBe('unknown');
    expect(makerOf(commit({ author: 'Other', email: 'whatever@x' }), named)).toBe('other');
  });

  it('reads a commit with no trailer and no known shape as unknown', () => {
    expect(makerOf(commit({ subject: 'Hand-edited' }), ctx)).toBe('unknown');
  });

  it('cannot say who made it when no identity is configured, so nothing is someone else', () => {
    const c = commit({
      author  : 'Other',
      email   : 'other@example.com',
      trailers: { 'Vn-Command': 'x' },
    });
    expect(makerOf(c, { local: { name: null, email: null } })).toBe('author');
  });
});

describe('statusCause', () => {
  const entry = (path: string, unmerged = false): StatusEntry => ({
    x: 'M',
    y: ' ',
    path,
    unmerged,
  });

  it('is clean with nothing changed and nothing pending', () => {
    expect(statusCause([], 0, QUIET)).toEqual({
      cause     : 'clean',
      outside   : [],
      conflicted: [],
      pending   : 0,
    });
  });

  it('names a stopped rebase before anything else, with the conflicted paths', () => {
    const rebase = { branch: 'main', onto: 'x', current: 1, total: 1, stoppedSha: null };
    const status = statusCause([entry('a.txt', true), entry('b.txt')], 3, {
      ...QUIET,
      rebase,
    });
    expect(status).toMatchObject({ cause: 'rebase', conflicted: ['a.txt'], pending: 0 });
  });

  it('names a pending batch before dirt, since the batch explains it', () => {
    expect(statusCause([entry('a.txt')], 2, QUIET)).toMatchObject({
      cause  : 'pending',
      pending: 2,
      outside: [],
    });
  });

  it('names dirt with no batch as changed outside the app', () => {
    expect(statusCause([entry('a.txt')], 0, QUIET)).toMatchObject({
      cause  : 'outside',
      outside: ['a.txt'],
    });
  });

  it('does not count the app’s own logs as outside dirt', () => {
    const own = ['vngen/state/'];
    expect(statusCause([entry('vngen/state/commands.jsonl')], 0, QUIET, own).cause).toBe('clean');
    expect(
      statusCause([entry('vngen/state/commands.jsonl'), entry('a.txt')], 0, QUIET, own),
    ).toMatchObject({ cause: 'outside', outside: ['a.txt'] });
  });
});

describe('textDiff', () => {
  it('diffs prose by words inside paragraphs, and everything else by lines', () => {
    const prose = textDiff(
      'wiki',
      'The old town.\n\nUnchanged.\n',
      'The new town.\n\nUnchanged.\n',
    );
    expect(prose.kind).toBe('prose');
    if (prose.kind === 'prose') {
      expect(prose.paragraphs.map((p) => p.kind)).toEqual(['changed', 'same']);
    }
    const lines = textDiff('other', 'a\nb\n', 'a\nc\n');
    expect(lines.kind).toBe('lines');
    if (lines.kind === 'lines') {
      expect(lines.lines.map((l) => l.kind)).toEqual(['same', 'removed', 'added']);
    }
  });
});

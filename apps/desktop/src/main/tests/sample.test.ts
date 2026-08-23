/**
 * Exercises the shipped template through the path a first launch takes: seed `templates/basic`
 * into a scratch workspace, then open it. Every other session test builds its project with
 * testkit, so this is the only test that fails when the committed sample stops loading — from a
 * broken heading, a scene chunk whose front-matter disagrees with its filename, or a `start:`
 * naming a scene that was renamed.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { WorkspaceSession, type SessionDeps } from '../session.js';
import { seedWorkspace } from '../workspace.js';
import { setNext } from '@vn/scriptedit';

const TEMPLATE = resolve(__dirname, '../../../../../templates/basic');

const deps: SessionDeps = {
  emitEvent: () => {},
  emitReport: () => {},
  requestPlan: () => Promise.resolve({ approved: false }),
  requestAnswer: () => Promise.resolve([]),
  requestConfirm: () => Promise.resolve(false),
  pushBusy: () => {},
};

describe('templates/basic, seeded and opened', () => {
  let parent: string;
  let session: WorkspaceSession;

  beforeAll(async () => {
    parent = await mkdtemp(join(tmpdir(), 'vn-sample-'));
    const target = join(parent, 'mySampleRepo');
    expect((await seedWorkspace(TEMPLATE, target)).seeded).toBe(true);
    session = new WorkspaceSession(target, true, deps);
  });

  afterAll(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it('loads with no error diagnostics, one file per scene', async () => {
    const index = await session.index();
    expect(index.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(index.title).toBe('The Transfer Student');
    // Chunk order is the directory's; the entry comes from `start:`, not from sorting first.
    expect(index.scenes.map((s) => s.id)).toEqual([
      'arrival',
      'ending',
      'greet',
      'observe',
      'rooftop',
    ]);
    expect(index.entry).toBe('arrival');
    expect(index.screenplay).toBeUndefined();
    expect(index.scenes.every((s) => s.file?.endsWith(`scenes${sep}${s.id}.md`))).toBe(true);
  });

  it('draws the branching graph the sample authors', async () => {
    const graph = await session.storyGraph();
    expect(graph.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      'arrival->greet',
      'arrival->observe',
      'greet->rooftop',
      'observe->rooftop',
      'rooftop->ending',
    ]);
    expect(graph.scenes.every((s) => s.reachable)).toBe(true);
  });

  it('is writable: a rewire lands in the one chunk that owns the scene', async () => {
    const rewire = await session.editBranches((g) =>
      setNext(g, { scene: 'ending', goto: 'greet' }),
    );
    expect(rewire.ok).toBe(true);
    expect(rewire.written).toEqual(['scenes/ending.md']);
    expect((await session.storyGraph()).edges.map((e) => `${e.from}->${e.to}`)).toContain(
      'ending->greet',
    );
  });
});

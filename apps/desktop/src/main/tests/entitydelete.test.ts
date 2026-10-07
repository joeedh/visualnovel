/**
 * `character.delete`, `location.delete` and `story.deleteScene` over a project the mock pipeline
 * has run, through a real `CommandStack` with an undo journal. Each test works on its own copy of
 * one run, so the run is paid for once.
 */
import { cp, mkdtemp, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { CommandStack, type CommandOutcome } from '@vn/commands';
import { UndoJournal } from '@vn/commands/snapshot';
import { openGit } from '@vn/git';
import { errors } from '@vn/model';
import { makeProject, TestProject } from '@vn/testkit';
import { UNDO_EXCLUDES } from '../../shared/affects.js';
import { createDesktopRegistry, type CommandHost } from '../commands/index.js';
import { WorkspaceSession, type SessionDeps } from '../session.js';

const deps: SessionDeps = {
  emitEvent     : () => {},
  emitReport    : () => {},
  requestPlan   : () => Promise.resolve({ approved: false }),
  requestAnswer : () => Promise.resolve([]),
  requestConfirm: () => Promise.resolve(false),
  pushBusy      : () => {},
};

/** The authored documents and the storyboards, which undo restores. */
const DOCUMENTS = ['project.yaml', 'scenes', 'characters', 'locations', 'wiki', 'vngen/work/shots'];
const MEDIA = new Set(['.png', '.jpg', '.jpeg', '.webp']);

let built: TestProject;
let p: TestProject;
let stack: CommandStack<CommandHost>;
let session: WorkspaceSession;

beforeAll(async () => {
  built = await makeProject();
  await built.run();
  await built.approveAll();
  await built.run();
}, 60_000);

afterAll(async () => {
  await built.cleanup();
});

beforeEach(async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'vn-entitydelete-')));
  await cp(built.dir, dir, { recursive: true });
  p = new TestProject(dir);
  session = new WorkspaceSession(dir, true, deps);
  const host = { session, ui: () => {}, uiAll: () => {} } as unknown as CommandHost;
  stack = new CommandStack<CommandHost>({
    registry: createDesktopRegistry(),
    context: {
      root: dir,
      git : openGit(dir),
      host,
      log    : () => {},
      confirm: () => Promise.resolve(true),
    },
    journal : new UndoJournal({ root: dir, exclude: UNDO_EXCLUDES }),
  });
});

afterEach(async () => {
  await p.cleanup();
});

const run = (id: string, props: Record<string, unknown>): Promise<CommandOutcome> =>
  stack.exec(id, props, 'ui');

const messageOf = (outcome: CommandOutcome): string => {
  if (!outcome.ok) throw new Error(`refused: ${outcome.error}`);
  return outcome.record.message;
};

/** Every non-media document under `DOCUMENTS`, by workspace-relative path. */
async function documents(): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const walk = async (path: string): Promise<void> => {
    const info = await stat(path).catch(() => null);
    if (!info) return;
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await walk(join(path, name));
    } else if (!MEDIA.has(extname(path))) {
      found.set(relative(p.dir, path).replaceAll('\\', '/'), await readFile(path, 'utf8'));
    }
  };
  for (const root of DOCUMENTS) await walk(join(p.dir, root));
  return found;
}

/** The project still loads, plans, and validates with nothing blocking. */
async function stillSound(): Promise<void> {
  const { model } = await p.reload();
  expect(errors(model)).toEqual([]);
  await p.run({ dryRun: true });
  const blocking = (await session.validateProject()).filter((f) => f.severity === 'blocking');
  expect(blocking).toEqual([]);
}

async function shotsText(): Promise<string> {
  const dir = join(p.dir, 'vngen', 'work', 'shots');
  const names = await readdir(dir);
  return (await Promise.all(names.map((n) => readFile(join(dir, n), 'utf8')))).join('\n');
}

describe('character.delete', () => {
  it('leaves a sound project that names haruki nowhere, and undo restores every document', async () => {
    const before = await documents();
    const message = messageOf(
      await run('character.delete', { character: 'haruki', lines: 'narrate', mergeInto: '' }),
    );

    expect(message).toMatch(/^Deleted character haruki\./);
    expect(message).toMatch(/Undo restores every file here except the picture/);
    expect(await shotsText()).not.toMatch(/"haruki"/);
    const { model } = await p.reload();
    expect(model.characters.has('haruki')).toBe(false);
    await stillSound();

    expect((await stack.undo()).ok).toBe(true);
    expect(await documents()).toEqual(before);
  }, 60_000);

  it('gives the lines to another character on merge', async () => {
    messageOf(
      await run('character.delete', { character: 'haruki', lines: 'merge', mergeInto: 'aiko' }),
    );
    const rooftop = await readFile(p.paths.sceneFile('rooftop'), 'utf8');
    expect(rooftop).not.toMatch(/HARUKI/);
    const { model } = await p.reload();
    const said = model.scenes.get('rooftop')!.lines.find((l) => l.id === 'rooftop:L3');
    expect(said).toMatchObject({ speaker: 'aiko', text: "Most people don't come up here." });
    await stillSound();
  }, 60_000);
});

describe('location.delete', () => {
  it('refuses while a scene is set there, and names it', async () => {
    const outcome = await run('location.delete', { location: 'hall', replaceWith: '' });
    expect(outcome.ok ? '(ran)' : outcome.error).toMatch(/bad_end/);
  });

  it('moves the scenes to the replacement, and undo restores every document', async () => {
    const before = await documents();
    messageOf(await run('location.delete', { location: 'hall', replaceWith: 'classroom' }));

    const badEnd = await readFile(p.paths.sceneFile('bad_end'), 'utf8');
    expect(badEnd).toMatch(/^INT\. CLASSROOM - NIGHT/m);
    const { model } = await p.reload();
    expect(model.locations.has('hall')).toBe(false);
    await stillSound();

    expect((await stack.undo()).ok).toBe(true);
    expect(await documents()).toEqual(before);
  }, 60_000);
});

describe('story.deleteScene', () => {
  it('moves start: when it deletes the entry scene, and undo moves it back', async () => {
    const before = await documents();
    messageOf(await run('story.deleteScene', { scene: 'arrival', edges: 'bypass' }));

    const { config } = await p.reload();
    expect(config.start).toBe('rooftop');
    await stillSound();

    expect((await stack.undo()).ok).toBe(true);
    expect(await documents()).toEqual(before);
  }, 60_000);

  it('cuts a choice that led to it', async () => {
    messageOf(await run('story.deleteScene', { scene: 'bad_end', edges: 'cut' }));
    const rooftop = await readFile(p.paths.sceneFile('rooftop'), 'utf8');
    expect(rooftop).not.toMatch(/bad_end/);
    await stillSound();
  }, 60_000);
});

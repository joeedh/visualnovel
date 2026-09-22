/**
 * The executed tier: run a command over a real project and compare what the workspace diff finds
 * against what the command declared it may write.
 *
 * `affects` is an upper bound, so a run that writes less than it declared passes and an empty diff
 * is not a failure. What fails is a path outside the declaration — in the diff, or in the
 * command's own `written` list, which catch different things. The diff misses media, since a
 * capture skips it wherever it sits; `written` misses whatever the command forgot to report.
 *
 * `RUNS`, `PROMPT_RUNS`, `GIT_RUNS`, the two `SYNC_*` tables and `SKIPS` partition the mutating
 * commands, and a test says so, since a command added later that is in none of the tables would
 * otherwise pass by being invisible.
 */
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { userSkillsDir } from '@vn/config';
import { openGit } from '@vn/git';
import { makeProject, type TestProject } from '@vn/testkit';
import { covers } from '../../../shared/affects.js';
import { readGroupDoc } from '../../doctree/graphs.js';
import { createDesktopRegistry } from '../index.js';
import { openAffectsHarness, type AffectsHarness, type RunResult } from './__fixtures__/affects.js';

const registry = createDesktopRegistry();

/** What a `Run` reads and writes as it goes: node ids, group refs, asset hashes. */
type Ids = Record<string, string>;

interface Context {
  harness: AffectsHarness;
  ids: Ids;
}

/** One command the executed tier runs, in the order the table lists it. */
interface Run {
  id: string;
  /** Props to run it with. A function may read what the commands before it created. */
  props: Record<string, unknown> | ((ctx: Context) => Promise<Record<string, unknown>>);
  /** Where to file `data.node` or `data.slug`, for a later command to name. */
  remember?: string;
  /** Set where the command is expected to refuse, and only the refusal is being pinned. */
  refuses?: true;
}

/** `data.node` or `data.slug` from one outcome, as the string a prop takes. */
function idOf(data: unknown): string {
  const record = (data ?? {}) as { node?: unknown; slug?: unknown };
  return String(record.node ?? record.slug ?? '');
}

const lineIds = async (ctx: Context, scene: string): Promise<string[]> =>
  (await ctx.harness.session.sceneCoverage(scene)).lines.map((line) => line.id);

const shotIds = async (ctx: Context, scene: string): Promise<string[]> =>
  (await ctx.harness.session.sceneCoverage(scene)).shots.map((shot) => shot.id);

/**
 * The graph half of the table. Every one of these writes `vngen/work/graphs`, but they reach it
 * through three different files — the graph, a definition under `lib/`, and an instance override
 * back in the graph — so running them is what shows the declaration covers all three.
 */
const GRAPH_RUNS: Run[] = [
  { id: 'gengraph.create', props: { name: 'portrait' } },
  {
    id      : 'gengraph.addNode',
    props   : { slug: 'portrait', type: 'GenTemplate', x: 0, y: 0 },
    remember: 'template',
  },
  {
    id      : 'gengraph.addNode',
    props   : { slug: 'portrait', type: 'GenImage', x: 40, y: 0 },
    remember: 'image',
  },
  {
    id      : 'gengraph.addNode',
    props   : { slug: 'portrait', type: 'GenOutput', x: 80, y: 0 },
    remember: 'output',
  },
  {
    id   : 'gengraph.link',
    props: ({ ids }) =>
      Promise.resolve({
        slug      : 'portrait',
        from      : ids['template'],
        fromSocket: 'text',
        to        : ids['image'],
        toSocket  : 'prompt',
      }),
  },
  {
    id   : 'gengraph.link',
    props: ({ ids }) =>
      Promise.resolve({
        slug      : 'portrait',
        from      : ids['image'],
        fromSocket: 'image',
        to        : ids['output'],
        toSocket  : 'image',
      }),
  },
  {
    id   : 'gengraph.setProp',
    props: ({ ids }) =>
      Promise.resolve({ slug: 'portrait', node: ids['output'], key: 'slot', value: 'shot:cafe/1' }),
  },
  {
    id   : 'gengraph.setActiveOutput',
    props: ({ ids }) => Promise.resolve({ slug: 'portrait', node: ids['output'] }),
  },
  {
    id   : 'gengraph.moveNodes',
    props: ({ ids }) =>
      Promise.resolve({
        slug : 'portrait',
        moves: JSON.stringify([{ node: ids['image'], x: 12, y: 34 }]),
      }),
  },
  {
    id      : 'gengraph.duplicateNode',
    props   : ({ ids }) => Promise.resolve({ slug: 'portrait', node: ids['image'], x: 0, y: 90 }),
    remember: 'spare',
  },
  {
    id   : 'gengraph.removeNode',
    props: ({ ids }) => Promise.resolve({ slug: 'portrait', node: ids['spare'] }),
  },
  {
    id   : 'gengraph.unlink',
    props: ({ ids }) =>
      Promise.resolve({
        slug      : 'portrait',
        to        : ids['image'],
        toSocket  : 'prompt',
        from      : ids['template'],
        fromSocket: 'text',
      }),
  },
  {
    id      : 'gengraph.createGroup',
    props: ({ ids }) =>
      Promise.resolve({ slug: 'portrait', nodes: `${ids['template']}, ${ids['image']}`, name: '' }),
    remember: 'instance',
  },
  {
    id   : 'gengraph.expose',
    props: async ({ harness }) => ({
      group: 'group-1',
      node : await innerNode(harness, 'GenTemplate'),
      key  : 'template',
      label: '',
    }),
  },
  {
    id   : 'gengraph.expose',
    props: async ({ harness }) => ({
      group: 'group-1',
      node : await innerNode(harness, 'GenImage'),
      key  : '',
      label: 'Picture',
    }),
  },
  { id: 'gengraph.reorderExposed', props: { group: 'group-1', from: 1, to: 0 } },
  {
    id   : 'gengraph.repointExposed',
    props: async ({ harness }) => ({
      group: 'group-1',
      index: 0,
      node : await innerNode(harness, 'GenTemplate'),
      key  : '',
    }),
  },
  { id: 'gengraph.unexpose', props: { group: 'group-1', index: 1 } },
  {
    id   : 'gengraph.addBoundary',
    props: { group: 'group-1', dir: 'in', key: 'extra', type: 'TextSocket' },
  },
  { id: 'gengraph.removeBoundary', props: { group: 'group-1', dir: 'in', key: 'extra' } },
  {
    id   : 'gengraph.addNode',
    props: { slug: 'portrait', type: 'GenRewrite', x: 0, y: 0, group: 'group-1' },
  },
  { id: 'gengraph.addGroup', props: { slug: 'portrait', ref: 'group-1', x: 10, y: 20 } },
  {
    id   : 'gengraph.ungroup',
    props: ({ ids }) => Promise.resolve({ slug: 'portrait', node: ids['instance'] }),
  },
  {
    id   : 'gengraph.apply',
    props: ({ ids }) =>
      Promise.resolve({
        slug       : 'portrait',
        description: JSON.stringify({
          nodes: [{ id: Number(ids['output']), type: 'GenOutput' }],
          links: [],
        }),
      }),
  },
  {
    id      : 'gengraph.createForSlot',
    props   : { slot: 'plate:cafe/night', name: '', open: false },
    remember: 'plate',
  },
  {
    id   : 'gengraph.delete',
    props: ({ ids }) => Promise.resolve({ slug: ids['plate'] }),
  },
];

/** One node of a type inside the `group-1` definition, by the id the definition gave it. */
async function innerNode(harness: AffectsHarness, type: string): Promise<string> {
  const read = await readGroupDoc(harness.root, 'group-1');
  if (!read.ok) throw new Error(read.reason);
  const found = read.def.subgraph.nodes.find((node) => node.def.typeName === type);
  if (!found) throw new Error(`the group-1 definition holds no ${type}`);
  return String(found.id);
}

/** The prose and storyboard half, over the `branching` script's four scenes. */
const STORY_RUNS: Run[] = [
  { id: 'story.assignLineIds', props: { scene: '' } },
  {
    id   : 'story.setLineText',
    props: async (ctx) => ({ line: (await lineIds(ctx, 'arrival'))[0]!, text: 'The door slides.' }),
  },
  {
    id   : 'story.insertLine',
    props: async (ctx) => ({
      scene  : 'arrival',
      text   : 'She looks around.',
      after  : (await lineIds(ctx, 'arrival'))[0]!,
      kind   : 'narration',
      speaker: '',
    }),
  },
  {
    id   : 'story.moveLine',
    props: async (ctx) => {
      const lines = await lineIds(ctx, 'arrival');
      return { line: lines[1]!, after: lines[2]! };
    },
  },
  {
    id   : 'story.setSpeaker',
    props: async (ctx) => {
      const coverage = await ctx.harness.session.sceneCoverage('arrival');
      const line = coverage.lines.find((l) => l.kind === 'dialogue')!;
      return { line: line.id, speaker: 'haruki' };
    },
  },
  { id: 'story.setHeading', props: { scene: 'arrival', heading: 'INT. CLASSROOM - DAY' } },
  { id: 'story.setSceneOutfit', props: { scene: 'arrival', character: 'aiko', outfit: 'gala' } },
  { id: 'story.newScene', props: { scene: 'annex', heading: 'INT. ANNEX - DAY' } },
  { id: 'story.setNext', props: { scene: 'annex', goto: 'rooftop' } },
  { id: 'story.spliceScene', props: { scene: 'annex', from: 'arrival', edge: -1 } },
  {
    id   : 'story.setChoice',
    props: { scene: 'rooftop', goto: 'good_end', label: 'Stay a while', index: 0 },
  },
  { id: 'story.removeChoice', props: { scene: 'rooftop', index: 1 } },
  {
    id   : 'story.newShot',
    props: async (ctx) => ({
      scene   : 'arrival',
      lines   : (await lineIds(ctx, 'arrival')).slice(0, 2).join(','),
      framing : 'medium',
      subjects: 'aiko',
    }),
  },
  {
    id   : 'story.newShot',
    props: async (ctx) => ({
      scene   : 'arrival',
      lines   : (await lineIds(ctx, 'arrival')).slice(2).join(','),
      framing : 'wide',
      subjects: 'haruki',
    }),
  },
  {
    id   : 'story.setCoverage',
    props: async (ctx) => ({
      scene: 'arrival',
      shot : (await shotIds(ctx, 'arrival'))[0]!,
      lines: (await lineIds(ctx, 'arrival'))[0]!,
    }),
  },
  {
    id   : 'story.setSubjects',
    props: async (ctx) => ({
      scene   : 'arrival',
      shot    : (await shotIds(ctx, 'arrival'))[0]!,
      subjects: 'aiko,haruki',
    }),
  },
  {
    id   : 'story.requireCast',
    props: async (ctx) => ({
      scene   : 'arrival',
      shot    : (await shotIds(ctx, 'arrival'))[0]!,
      required: false,
    }),
  },
  {
    id   : 'story.setPanels',
    props: async (ctx) => ({
      scene : 'arrival',
      shot  : (await shotIds(ctx, 'arrival'))[0]!,
      panels: JSON.stringify([
        {
          shape: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
          framing    : 'medium',
          subjects   : [],
          coversLines: [(await lineIds(ctx, 'arrival'))[0]!],
        },
      ]),
    }),
  },
  // After setPanels, so the shot is a page with a lettered line to place a bubble on
  {
    id   : 'story.setBubbles',
    props: async (ctx) => ({
      scene  : 'arrival',
      shot   : (await shotIds(ctx, 'arrival'))[0]!,
      bubbles: JSON.stringify([
        { lineId: (await lineIds(ctx, 'arrival'))[0]!, anchor: [0.5, 0.3], tail: [0.4, 0.6] },
      ]),
    }),
  },
  {
    id   : 'story.setOutfit',
    props: async (ctx) => ({
      scene    : 'arrival',
      shot     : (await shotIds(ctx, 'arrival'))[0]!,
      character: 'aiko',
      outfit   : 'gala',
    }),
  },
  {
    id   : 'story.setVariant',
    props: async (ctx) => ({
      scene  : 'arrival',
      shot   : (await shotIds(ctx, 'arrival'))[0]!,
      variant: 'night',
    }),
  },
  {
    id   : 'story.setSheet',
    props: async (ctx) => ({
      scene: 'arrival',
      shot : (await shotIds(ctx, 'arrival'))[0]!,
      sheet: 'g1',
    }),
  },
  {
    id   : 'story.setSheet',
    props: async (ctx) => ({
      scene: 'arrival',
      shot : (await shotIds(ctx, 'arrival'))[1]!,
      sheet: 'g1',
    }),
  },
  {
    id   : 'story.setSheetGroup',
    props: { scene: 'arrival', sheet: 'g1', seed: 3, notes: 'one room' },
  },
  // Reaches `vngen/work/graphs` from the story half: the sheet graph and, on this first scaffold,
  // the `sheet-cell` definition under `lib/`
  { id: 'gengraph.scaffoldSheet', props: { scene: 'arrival', sheet: 'g1', name: '', open: false } },
  {
    id   : 'story.moveShot',
    props: async (ctx) => {
      const shots = await shotIds(ctx, 'arrival');
      return { scene: 'arrival', shot: shots[0]!, after: shots[1]! };
    },
  },
  {
    id   : 'story.deleteShot',
    props: async (ctx) => ({ scene: 'arrival', shot: (await shotIds(ctx, 'arrival'))[0]! }),
  },
  {
    id   : 'story.deleteLine',
    props: async (ctx) => ({ line: (await lineIds(ctx, 'arrival')).at(-1)! }),
  },
  {
    id   : 'story.splitScene',
    props: async (ctx) => ({
      scene: 'arrival',
      at   : (await lineIds(ctx, 'arrival'))[1]!,
      into : 'arrival_b',
    }),
  },
  { id: 'story.mergeScene', props: { scene: 'arrival_b', into: 'arrival' } },
  {
    id   : 'story.deleteLines',
    props: async (ctx) => ({ lines: (await lineIds(ctx, 'arrival')).slice(-2) }),
  },
  { id: 'story.deleteScene', props: { scene: 'bad_end' } },
  { id: 'story.export', props: {} },
  { id: 'story.screenplay', props: { clean: false } },
];

/** Everything else the scaffolded project reaches. */
const OTHER_RUNS: Run[] = [
  { id: 'doc.create', props: { kind: 'note', name: 'Factions', open: false } },
  { id: 'doc.rename', props: { path: 'wiki/factions.md', name: 'The factions' } },
  {
    id   : 'doc.write',
    props: async ({ harness }) => {
      const read = await harness.session.readDoc('wiki/factions.md');
      if (!read.ok) throw new Error(read.reason);
      return {
        path    : 'wiki/factions.md',
        text    : `${read.file.text}\nTwo of them.\n`,
        seenHash: read.file.hash,
      };
    },
  },
  { id: 'project.setArtStyle', props: { style: 'soft watercolour' } },
  { id: 'project.setStoryboardNotes', props: { notes: 'pages of four to six panels' } },
  { id: 'project.setLettering', props: { lettering: 'model' } },
  { id: 'project.setBubbleNames', props: { on: true } },
  { id: 'project.setShotForm', props: { form: 'pages' } },
  // The catalog comes from the checkout, through `VN_RESOURCES` set for this tier
  { id: 'project.setBuiltinSkills', props: { ids: ['branching'] } },
  { id: 'skill.cloneToProject', props: { id: 'new-character' } },
  // Writes only the user folder under `$VNAUTHOR_HOME`, which `afterAll` empties again
  { id: 'skill.cloneToUser', props: { id: 'branching' } },
  { id: 'view.resetLayout', props: { scope: 'shipped' } },
  { id: 'workspace.reindex', props: {} },
];

/**
 * The prompt commands, which key off an asset hash and so need a project the mock pipeline has
 * already run over. That run is the dominant cost of this suite, and the reason `art.setNotes`
 * and `art.setSeed` stay in `SKIPS` rather than joining these.
 */
const PROMPT_RUNS: Run[] = [
  {
    id   : 'prompt.setChunk',
    props: async (ctx) => ({
      hash : ctx.ids['asset']!,
      chunk: await someChunk(ctx),
      op   : 'append',
      text : 'lit from the left',
    }),
  },
  {
    id   : 'prompt.moveChunk',
    props: async (ctx) => {
      const view = await ctx.harness.session.promptView(ctx.ids['asset']!);
      return {
        hash : ctx.ids['asset']!,
        chunk: view!.chunks[0]!.key,
        after: view!.chunks.at(-1)!.key,
      };
    },
  },
  {
    id   : 'prompt.setCustom',
    props: ({ ids }) => Promise.resolve({ hash: ids['asset']!, text: 'A portrait.' }),
  },
  {
    id   : 'prompt.clear',
    props: ({ ids }) => Promise.resolve({ hash: ids['asset']!, part: 'custom' }),
  },
  {
    id   : 'prompt.addRef',
    props: async (ctx) => ({
      hash : ctx.ids['asset']!,
      chunk: await someChunk(ctx),
      ref  : ctx.ids['ref']!,
    }),
  },
  {
    id   : 'prompt.dropRef',
    props: async (ctx) => ({
      hash : ctx.ids['asset']!,
      chunk: await someChunk(ctx),
      ref  : ctx.ids['ref']!,
    }),
  },
];

/** A chunk key the asset's prompt actually carries, so an edit has something to land on. */
async function someChunk(ctx: Context): Promise<string> {
  const view = await ctx.harness.session.promptView(ctx.ids['asset']!);
  const chunk = view?.chunks.find((c) => c.authored !== undefined) ?? view?.chunks[0];
  if (!chunk) throw new Error('the fixture asset has no prompt chunks');
  return chunk.key;
}

const RUNS: Run[] = [...GRAPH_RUNS, ...STORY_RUNS, ...OTHER_RUNS];

/**
 * The `git.*` writes, over a project under git with a committer on the stack. The order is what
 * gives each one something to act on: an edit made outside the app is saved, a checkpoint is
 * named on it, the project goes back to before it, that going-back is taken back, the file is
 * brought back from the first save, and the checkpoint is dropped.
 */
const GIT_RUNS: Run[] = [
  {
    id   : 'git.save',
    props: async ({ harness }) => {
      const file = join(harness.root, 'project.yaml');
      await writeFile(file, `${await readFile(file, 'utf8')}# edited outside the app\n`);
      return { message: 'Edited outside the app' };
    },
  },
  { id: 'git.checkpoint', props: { name: 'Before the rain pass', note: 'Safe.' } },
  { id: 'git.goBack', props: async (ctx) => ({ sha: await firstSave(ctx) }) },
  { id: 'git.takeBack', props: async (ctx) => ({ sha: await latestSave(ctx) }) },
  {
    id   : 'git.restoreFile',
    props: async (ctx) => ({ sha: await firstSave(ctx), path: 'project.yaml' }),
  },
  { id: 'git.dropCheckpoint', props: { name: 'before-the-rain-pass' } },
];

const firstSave = async (ctx: Context): Promise<string> =>
  (await ctx.harness.session.gitHistory('project')).saves.at(-1)!.sha;

const latestSave = async (ctx: Context): Promise<string> =>
  (await ctx.harness.session.gitHistory('project')).saves[0]!.sha;

/** One sync run, on whichever of the two connected projects `who` names. */
interface SyncRun extends Run {
  who: 'a' | 'b';
  /** What the outcome must say, where the run is there to pin more than its declaration. */
  expect?: (result: RunResult) => void;
}

/** The layout both authors change; `-merge` in `.gitattributes`, so git never splices the two. */
const LAYOUT = '.vnstudio/layouts/mine.json';
/** The scene both authors append a line to, which git merges line by line and leaves marked. */
const SCENE = 'scenes/arrival.md';
/** The storyboard both authors write, which git merges the same way. */
const SHOTS = 'vngen/work/shots/arrival.json';

const shotsFile = (who: 'a' | 'b'): string =>
  `{\n  "version": 1,\n  "scene": "arrival",\n  "nextShot": ${who === 'a' ? 2 : 3},\n  "shots": []\n}\n`;

const sceneLine = (who: 'a' | 'b'): string =>
  who === 'a' ? 'The bell rings.\n' : 'Outside, a bell rings.\n';

/**
 * A `git.save` over one edit each to the layout, the scene and the storyboard, made outside the
 * app, so a pull from the other author stops on all three.
 */
function collidingSave(who: 'a' | 'b', panes: number): SyncRun {
  return {
    who,
    id   : 'git.save',
    props: async ({ harness }) => {
      await writeFile(join(harness.root, LAYOUT), `{"panes":${panes}}\n`);
      await appendFile(join(harness.root, SCENE), `\n${sceneLine(who)}`);
      await mkdir(join(harness.root, 'vngen', 'work', 'shots'), { recursive: true });
      await writeFile(join(harness.root, SHOTS), shotsFile(who));
      return { message: `Set the layout to ${panes} pane${panes === 1 ? '' : 's'}` };
    },
  };
}

/** The file as git left it, markers and all, read straight off B's disk. */
const marked = async ({ harness }: Context, path: string): Promise<string> =>
  readFile(join(harness.root, path), 'utf8');

/** B's own merge of the scene: both appended lines, the markers gone. */
const mergedScene = async (ctx: Context): Promise<string> => {
  const text = await marked(ctx, SCENE);
  const cut = text.indexOf('<<<<<<< ');
  if (cut < 0) throw new Error(`${SCENE} holds no markers`);
  return `${text.slice(0, cut)}${sceneLine('a')}\n${sceneLine('b')}`;
};

const outcome = (result: RunResult): Record<string, unknown> =>
  result.data as Record<string, unknown>;

/**
 * Project A connects the shared copy and sends the first saves. `ids.remote` is the bare
 * repository's path, seeded by the suite before the first run.
 */
const SYNC_CONNECT: SyncRun[] = [
  {
    who  : 'a',
    id   : 'git.save',
    props: async ({ harness }) => {
      await mkdir(join(harness.root, '.vnstudio', 'layouts'), { recursive: true });
      await writeFile(
        join(harness.root, '.gitattributes'),
        `${LAYOUT.replace('mine', '*')} -merge\n`,
      );
      await writeFile(join(harness.root, LAYOUT), '{"panes":1}\n');
      return { message: 'Added a layout' };
    },
  },
  {
    who   : 'a',
    id    : 'git.addRemote',
    props : ({ ids }) => Promise.resolve({ name: 'origin', url: ids['remote']! }),
    expect: (result) => expect(outcome(result)).toEqual({ syncsWith: true }),
  },
  {
    who   : 'a',
    id    : 'git.push',
    props : {},
    expect: (result) => expect(outcome(result)).toEqual({ remote: 'origin', sent: null }),
  },
];

/**
 * Both projects change the layout; A sends first, so B's pull stops on it. B gives the sync up
 * once, pulls again, keeps its own side, finishes, and sends. Every sync mutator runs here, in
 * the order an author would meet them.
 */
const SYNC_COLLIDE: SyncRun[] = [
  {
    who   : 'b',
    id    : 'git.fetch',
    props : { remote: 'origin' },
    expect: (result) => expect(outcome(result)).toEqual({ remote: 'origin', behind: 0 }),
  },
  { who: 'b', id: 'git.syncWith', props: { name: 'origin' } },
  collidingSave('b', 2),
  collidingSave('a', 3),
  {
    who   : 'a',
    id    : 'git.push',
    props : { remote: 'origin' },
    expect: (result) => expect(outcome(result)).toEqual({ remote: 'origin', sent: 1 }),
  },
  {
    who   : 'b',
    id    : 'git.fetch',
    props : {},
    expect: (result) => expect(outcome(result)).toEqual({ remote: 'origin', behind: 1 }),
  },
  {
    who    : 'b',
    id     : 'git.push',
    props  : {},
    refuses: true,
    expect: (result) =>
      expect(result.error).toBe('“origin” has 1 save you do not; get their saves first.'),
  },
  {
    who   : 'b',
    id    : 'git.pull',
    props : {},
    expect: (result) =>
      expect(outcome(result)).toEqual({
        got       : 1,
        replayed  : 0,
        conflicted: [LAYOUT, SCENE, SHOTS],
        rewrote   : [],
        finished  : false,
      }),
  },
  { who: 'b', id: 'git.abandonSync', props: {} },
  {
    who   : 'b',
    id    : 'git.pull',
    props : {},
    expect: (result) =>
      expect(outcome(result)).toMatchObject({ conflicted: [LAYOUT, SCENE, SHOTS] }),
  },
  {
    who    : 'b',
    id     : 'git.continueSync',
    props  : {},
    refuses: true,
    expect : (result) => expect(result.error).toBe('3 files still need a decision.'),
  },
  {
    who   : 'b',
    id    : 'git.status',
    props : {},
    expect: (result) =>
      expect(outcome(result)).toMatchObject({ marked: [SCENE, SHOTS], decided: [] }),
  },
  // Only a file git merged line by line has a text to edit; the layout offers its two sides
  {
    who    : 'b',
    id     : 'git.conflictText',
    props  : { path: LAYOUT },
    refuses: true,
    expect: (result) =>
      expect(result.error).toBe(`${LAYOUT} was not merged line by line; keep a side instead.`),
  },
  {
    who   : 'b',
    id    : 'git.conflictText',
    props : { path: SCENE },
    expect: (result) => {
      const { text } = outcome(result) as { text: string };
      expect(text).toMatch(/^<<<<<<< HEAD$/m);
      expect(text).toContain(sceneLine('a'));
      expect(text).toContain(sceneLine('b'));
    },
  },
  // A merge saved part way, markers still in, is allowed for prose but stops Continue
  {
    who  : 'b',
    id   : 'git.writeResolution',
    props: async (ctx) => ({ path: SCENE, text: await marked(ctx, SCENE) }),
  },
  { who: 'b', id: 'git.resolve', props: { path: LAYOUT, side: 'mine' } },
  { who: 'b', id: 'git.resolve', props: { path: SHOTS, side: 'theirs' } },
  {
    who    : 'b',
    id     : 'git.continueSync',
    props  : {},
    refuses: true,
    expect: (result) =>
      expect(result.error).toBe(
        `${SCENE} still holds conflict markers; keep a side or edit them out first.`,
      ),
  },
  {
    who   : 'b',
    id    : 'git.status',
    props : {},
    expect: (result) =>
      expect(outcome(result)).toMatchObject({
        conflicted: [],
        marked    : [],
        decided: [
          { path: LAYOUT, decision: 'theirs' },
          { path: SCENE, decision: 'merged' },
          { path: SHOTS, decision: 'ours' },
        ],
      }),
  },
  // Each decision comes back, and the storyboard is then merged by hand rather than kept whole
  { who: 'b', id: 'git.undoResolution', props: { path: SCENE } },
  { who: 'b', id: 'git.undoResolution', props: { path: SHOTS } },
  {
    who    : 'b',
    id     : 'git.undoResolution',
    props  : { path: SHOTS },
    refuses: true,
    expect : (result) => expect(result.error).toBe(`${SHOTS} was not decided at this stop.`),
  },
  {
    who    : 'b',
    id     : 'git.writeResolution',
    props  : async (ctx) => ({ path: SHOTS, text: await marked(ctx, SHOTS) }),
    refuses: true,
    expect : (result) => expect(result.error).toBe(`${SHOTS} still holds conflict markers.`),
  },
  {
    who    : 'b',
    id     : 'git.writeResolution',
    props  : { path: SHOTS, text: '{"version":1,"scene":"arrival",' },
    refuses: true,
    expect : (result) => expect(result.error).toMatch(/is not valid JSON/),
  },
  {
    who  : 'b',
    id   : 'git.writeResolution',
    props: { path: SHOTS, text: shotsFile('b').replace('"nextShot": 3', '"nextShot": 4') },
  },
  {
    who  : 'b',
    id   : 'git.writeResolution',
    props: async (ctx) => ({ path: SCENE, text: await mergedScene(ctx) }),
  },
  {
    who   : 'b',
    id    : 'git.continueSync',
    props : {},
    expect: (result) =>
      expect(outcome(result)).toMatchObject({
        replayed  : 1,
        conflicted: [],
        finished  : true,
        rewrote: [
          {
            from: expect.stringMatching(/^[0-9a-f]{40}$/),
            to  : expect.stringMatching(/^[0-9a-f]{40}$/),
          },
        ],
      }),
  },
  {
    who   : 'b',
    id    : 'git.push',
    props : {},
    expect: (result) => expect(outcome(result)).toEqual({ remote: 'origin', sent: 1 }),
  },
  {
    who  : 'b',
    id   : 'git.setRemoteUrl',
    props: ({ ids }) => Promise.resolve({ name: 'origin', url: ids['remote']! }),
  },
  { who: 'b', id: 'git.removeRemote', props: { name: 'origin' } },
];

/**
 * The mutating commands the executed tier does not reach, each with the reason. A skip is a
 * written-down limit rather than an omission: the declaration lint and the undo rule still cover
 * all 95, and only this tier is partial.
 */
const SKIPS: Record<string, string> = {
  'agent.compact'          : 'summarizes a live conversation through a real text model',
  'agent.renameThread'     : 'renames a thread only a real agent turn creates',
  'agent.run'              : 'sends a turn to a real model',
  'art.generate'           : 'draws a concept through a real image provider',
  'art.promote'            : 'promotes a concept that only a real draw produces',
  'art.redraw'             : 'draws again through a real image provider',
  'art.setNotes':
    'keys off an asset hash, so it needs the rendered fixture the prompt commands use',
  'art.setSeed'            : 'keys off an asset hash, the same way art.setNotes does',
  'art.setModel'           : 'keys off an asset hash, the same way art.setNotes does',
  'asset.accept'           : 'accepts a take a run has to have produced and a slot has to want',
  'asset.adopt'            : 'points a slot at bytes already in the store',
  'asset.regenerate'       : 'requeues a planned task and then runs it for real',
  'pipeline.draw'          : 'requeues one slot’s task and then runs it for real',
  'asset.replace'          : 'replaces a slot from a file outside the workspace',
  'asset.restore'          : 'restores a superseded take, which needs two of them',
  'asset.unapprove'        : 'takes approval back off an approved asset',
  'asset.upload'           : 'copies an image in from outside the workspace',
  'gate.approve'           : 'approves a portrait candidate a real run has to have drawn',
  'gate.lock'              : 'locks an approval that gate.approve has to have written first',
  'gengraph.run': 'executes a graph through real providers; the command declares no mock',
  'models.refresh'         : 'asks OpenRouter for its model listing over the network',
  'notify.deleteAll':
    'truncates the notification log, which is a process-global rather than a session member',
  'pipeline.approveAndRun' : 'runs the pipeline with real keys, by design',
  'pipeline.run':
    'is what builds the rendered fixture, so measuring it here would measure the fixture',
  'plugin.install'         : 'installs from the network into the user directory',
  'plugin.prices'          : 'asks a provider for a price table',
  'plugin.remove'          : 'removes a plugin the network installed',
  'project.installPages'   : 'needs a repository with an origin remote and a branch',
  'project.setImageModel':
    'is refused until the model’s vendor has a key, and a credential is what nothing here may leave behind',
  'project.setKey'         : 'writes a credential, which nothing here may capture or leave behind',
  'project.setTextModel':
    'is refused until the model’s vendor has a key, and a credential is what nothing here may leave behind',
  'project.setVisionModels':
    'is refused until each model’s vendor has a key, and a credential is what nothing here may leave behind',
  'prompt.condense'        : 'asks a real text model to rewrite the clauses',
  'prompt.repin':
    'moves a reference the derived prompt pinned to a slot, and the mock fixture draws none',
  'story.decomposeAll'     : 'storyboards every scene through a real text model',
  'upload.files'           : 'copies documents in from outside the workspace',
  'upload.pick'            : 'opens a file chooser',
  'view.saveLayout'        : 'takes an arrangement only a live renderer can serialize',
  'workspace.create'       : 'creates a project in a different tree and reopens the app on it',
  'workspace.import'       : 'needs a project still in the screenplay form',
  'workspace.open'         : 'replaces the workspace this harness is bound to',
  'workspace.pick'         : 'opens a directory chooser',
};

/** The paths one run touched that its declaration does not reach, each labelled by its source. */
function uncovered(id: string, result: RunResult, declared?: readonly string[]): string[] {
  const affects = declared ?? registry.get(id)?.affects ?? [];
  return [
    ...result.diff.filter((path) => !covers(affects, path)).map((path) => `diff ${path}`),
    ...result.written.filter((path) => !covers(affects, path)).map((path) => `written ${path}`),
  ];
}

/** One line per uncovered path, naming the command, the path, and the declaration it broke. */
function failure(id: string, result: RunResult): string[] {
  const affects = registry.get(id)?.affects ?? [];
  return uncovered(id, result).map(
    (path) => `${id} touched ${path}; declares ${affects.join(', ')}`,
  );
}

/** Run the table in order, collecting what each command reached outside its declaration. */
async function drive(harness: AffectsHarness, runs: Run[], ids: Ids = {}): Promise<string[]> {
  const problems: string[] = [];
  for (const run of runs) {
    const ctx: Context = { harness, ids };
    const props = typeof run.props === 'function' ? await run.props(ctx) : run.props;
    const result = await harness.run(run.id, props);
    if (!result.ok && !run.refuses) {
      problems.push(`${run.id} refused: ${result.error}`);
      continue;
    }
    if (run.remember) ids[run.remember] = idOf(result.data);
    problems.push(...failure(run.id, result));
  }
  return problems;
}

describe('the executed tier', () => {
  let project: TestProject;
  let harness: AffectsHarness;

  beforeAll(async () => {
    project = await makeProject({
      title     : 'Affects',
      // An outfit and a second variant, so `story.setOutfit` and `story.setVariant` have
      // something to name that the project's own sheets declare.
      characters: [
        { id: 'aiko', outfits: { uniform: 'the school uniform', gala: 'a long dress' } },
        'haruki',
      ],
      locations : [{ id: 'classroom', variants: ['day', 'night'] }, 'rooftop', 'hall'],
    });
    // Under jest `builtinSkillsDir()` finds no catalog on its own, and the skill commands need one
    process.env.VN_RESOURCES = join(__dirname, '..', '..', '..', '..', '..', '..');
    harness = await openAffectsHarness(project);
  }, 120_000);

  afterAll(async () => {
    delete process.env.VN_RESOURCES;
    await harness.dispose();
    await rm(project.dir, { recursive: true, force: true, maxRetries: 3 });
    // `$VNAUTHOR_HOME` is per worker, not per file: a skill left here is a user skill to every
    // later suite on the same worker
    await rm(userSkillsDir(), { recursive: true, force: true, maxRetries: 3 });
  });

  it('runs each command in RUNS and finds nothing written outside its declaration', async () => {
    expect(await drive(harness, RUNS)).toEqual([]);
  }, 240_000);

  /**
   * `gengraph.setProp` reaches exactly one file, so the tier has to report it when its
   * declaration is narrowed to a sibling subtree. `doc.write` would prove nothing here, because
   * its truthful declaration covers most of the vocabulary and nothing it writes falls outside.
   */
  it('reports a run against a declaration narrowed to the wrong subtree', async () => {
    const added = await harness.run('gengraph.create', { name: 'narrowed' });
    expect(added.error).toBeUndefined();
    const node = await harness.run('gengraph.addNode', {
      slug: 'narrowed',
      type: 'GenImage',
      x   : 0,
      y   : 0,
    });
    const result = await harness.run('gengraph.setProp', {
      slug : 'narrowed',
      node : idOf(node.data),
      key  : 'aspect',
      value: '3:2',
    });
    expect(result.error).toBeUndefined();
    expect(uncovered('gengraph.setProp', result, ['vngen/work/graphs/lib'])).toEqual([
      'diff vngen/work/graphs/narrowed.json',
      'written vngen/work/graphs/narrowed.json',
    ]);
  }, 60_000);
});

describe('the prompt commands, over a project the pipeline has run', () => {
  let project: TestProject;
  let harness: AffectsHarness;
  const ids: Ids = {};

  beforeAll(async () => {
    project = await makeProject({ title: 'Prompts' });
    await project.run();
    harness = await openAffectsHarness(project);
    const { store } = await project.current();
    const assets = store.manifest();
    const shot = assets.find((asset) => asset.kind === 'shot_image');
    const ref = assets.find((asset) => asset.hash !== shot?.hash);
    ids['asset'] = shot?.hash ?? assets[0]!.hash;
    ids['ref'] = ref?.hash ?? '';
  }, 300_000);

  afterAll(async () => {
    await harness.dispose();
    await rm(project.dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('runs each prompt command and finds nothing written outside its declaration', async () => {
    expect(await drive(harness, PROMPT_RUNS, ids)).toEqual([]);
  }, 120_000);
});

describe('the git writes, over a project under git with a committer', () => {
  let project: TestProject;
  let harness: AffectsHarness;

  beforeAll(async () => {
    project = await makeProject({ title: 'Recovery', git: true });
    harness = await openAffectsHarness(project, { committed: true });
  }, 120_000);

  afterAll(async () => {
    await harness.dispose();
    await rm(project.dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('runs each git write and finds nothing written outside its declaration', async () => {
    expect(await drive(harness, GIT_RUNS)).toEqual([]);
    // Each write that moved the tree landed as its own save, under the subject the command gave
    const { saves } = await harness.session.gitHistory('project');
    expect(saves.map((s) => s.subject)).toEqual([
      expect.stringMatching(/^Brought back project\.yaml from save [0-9a-f]{7}$/),
      'Took back: Went back to: Fixture inputs',
      'Went back to: Fixture inputs',
      'Edited outside the app',
      'Fixture inputs',
    ]);
    expect(saves.map((s) => s.trailers['Vn-Command'])).toEqual([
      'git.restoreFile',
      'git.takeBack',
      'git.goBack',
      'git.save',
      undefined,
    ]);
    expect(await project.git!.checkpoints()).toEqual([]);
  }, 120_000);
});

/** Runs git directly, for the two verbs the wrapper has no reason to expose: a bare init and a clone. */
function sh(dir: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${stderr}`));
      else resolve();
    });
  });
}

describe('the sync writes, over two projects and a shared copy', () => {
  let project: TestProject;
  let bare: string;
  let cloneDir: string;
  const harnesses: Partial<Record<'a' | 'b', AffectsHarness>> = {};
  const ids: Ids = {};

  beforeAll(async () => {
    project = await makeProject({ title: 'Sync', git: true });
    // The bare copy is born pointing at A's branch, or a clone of it would check nothing out
    const branch = await openGit(project.dir).branch();
    bare = await mkdtemp(join(tmpdir(), 'vn-bare-'));
    await sh(bare, ['init', '--bare', '-q', `--initial-branch=${branch}`]);
    ids['remote'] = bare.replaceAll('\\', '/');
    harnesses.a = await openAffectsHarness(project, { committed: true });
  }, 120_000);

  afterAll(async () => {
    await harnesses.a?.dispose();
    await harnesses.b?.dispose();
    for (const dir of [project.dir, cloneDir, bare]) {
      if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  /** One run on the project it names, held to its declaration and to what it had to say. */
  async function step(run: SyncRun): Promise<void> {
    const harness = harnesses[run.who]!;
    const ctx: Context = { harness, ids };
    const props = typeof run.props === 'function' ? await run.props(ctx) : run.props;
    const result = await harness.run(run.id, props);
    if (run.refuses) expect(result.ok).toBe(false);
    else expect(`${run.who} ${run.id}: ${result.error ?? ''}`).toBe(`${run.who} ${run.id}: `);
    expect(failure(run.id, result)).toEqual([]);
    run.expect?.(result);
  }

  it('connects A, clones B, and carries a collision through to both copies agreeing', async () => {
    for (const run of SYNC_CONNECT) await step(run);

    // B is a second author's copy: the same history, a different name on its saves
    cloneDir = await mkdtemp(join(tmpdir(), 'vn-clone-'));
    await sh(cloneDir, ['clone', '-q', '-c', 'core.autocrlf=false', ids['remote']!, '.']);
    const other = openGit(cloneDir);
    await other.config('user.email', 'other@example.com');
    await other.config('user.name', 'Other');
    harnesses.b = await openAffectsHarness({ dir: cloneDir }, { committed: true });

    for (const run of SYNC_COLLIDE) await step(run);

    // One line: B's save replayed on top of A's, the layout is the side B kept, and the two
    // merged files read as B wrote them
    const { saves } = await harnesses.b.session.gitHistory('project');
    expect(saves.map((s) => s.subject)).toEqual([
      'Set the layout to 2 panes',
      'Set the layout to 3 panes',
      'Added a layout',
      'Fixture inputs',
    ]);
    expect(await readFile(join(cloneDir, LAYOUT), 'utf8')).toBe('{"panes":2}\n');
    expect(await readFile(join(cloneDir, SHOTS), 'utf8')).toContain('"nextShot": 4');
    const scene = await readFile(join(cloneDir, SCENE), 'utf8');
    expect(scene).not.toMatch(/^<<<<<<< /m);
    expect(scene).toContain(sceneLine('a'));
    expect(scene).toContain(sceneLine('b'));
    expect(await openGit(bare).resolve('HEAD')).toBe(saves[0]!.sha);
    expect(await other.remotes()).toEqual([]);
  }, 180_000);
});

describe('RUNS and SKIPS', () => {
  const mutating = registry
    .list()
    .filter((command) => command.mutating)
    .map((command) => command.id);

  /** The reads a sync run makes between writes, to pin what a write left; not part of the tier. */
  const READS = ['git.status', 'git.conflictText'];

  it('partition the mutating commands exactly', () => {
    const runs = new Set(
      [...RUNS, ...PROMPT_RUNS, ...GIT_RUNS, ...SYNC_CONNECT, ...SYNC_COLLIDE]
        .map((run) => run.id)
        .filter((id) => !READS.includes(id)),
    );
    const skips = new Set(Object.keys(SKIPS));
    expect([...runs].filter((id) => skips.has(id))).toEqual([]);
    expect(mutating.filter((id) => !runs.has(id) && !skips.has(id))).toEqual([]);
    expect([...runs, ...skips].filter((id) => !mutating.includes(id)).sort()).toEqual([]);
  });

  it('gives every skipped command a reason', () => {
    for (const [id, reason] of Object.entries(SKIPS)) {
      expect(`${id}: ${reason}`).toMatch(/: \S.*\S$/);
    }
  });
});

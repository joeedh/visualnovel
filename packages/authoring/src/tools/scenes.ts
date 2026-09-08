/** Scene prose editing and branch wiring — the agent's one write path for scenes/<id>.md. */
import { z } from 'zod';
import {
  deleteLine,
  deleteLines,
  deleteScene,
  insertLine,
  insertLines,
  mergeScene,
  moveLine,
  newScene,
  removeChoice,
  setChoice,
  setHeading,
  setLineText,
  setNext,
  setSpeaker,
  spliceScene,
  splitScene,
  type BranchOp,
  type LineOp,
  type SceneMap,
  type ScriptState,
} from '@vn/scriptedit';
import {
  applyMarkerPlan,
  applyScenePlan,
  planMarkerEdit,
  planSceneEdit,
  scenePlanMessage,
} from '@vn/scriptedit/write';
import { deleteShots, writeShots } from '@vn/store';
import type { Workspace } from '../workspace.js';
import { ok, fail, rel, type Tool } from './core.js';

// ── Scene prose (execute mode) ──────────────────────────────────────────────

/**
 * The scene ops, named exactly as the desktop's `story.*` commands are, because each op invokes
 * the same decision its command does: an agent transcript and a command history should read as
 * the same vocabulary. `insertLines` and `deleteLines` have no button behind them — a person
 * types or removes one line at a time while a model rewrites forty, and `@vn/scriptedit` still
 * allocates every id. `newShot` and `deleteShot` write the storyboard rather than prose — they are here,
 * not their own tools, because the author experiences making a shot as a scene edit, and the
 * shared-vocabulary rule above outranks which file the write lands in.
 */
const SCENE_OPS = [
  'setLineText',
  'insertLine',
  'insertLines',
  'deleteLine',
  'deleteLines',
  'moveLine',
  'moveShot',
  'newShot',
  'deleteShot',
  'setSpeaker',
  'newScene',
  'setHeading',
  'deleteScene',
  'splitScene',
  'mergeScene',
] as const;

type SceneOp = (typeof SCENE_OPS)[number];

const LINE_KINDS = [
  'dialogue',
  'parenthetical',
  'narration',
  'transition',
  'lyric',
  'centered',
] as const;

const sceneEditShape = z.object({
  op      : z.enum(SCENE_OPS).describe('which act; the arguments each one needs are listed below'),
  scene: z
    .string()
    .optional()
    .describe(
      'insertLine, moveShot, newShot, deleteShot, newScene, setHeading, deleteScene, ' +
        'splitScene, mergeScene',
    ),
  line    : z.string().optional().describe('a line id like arrival:L3 — the four line edits'),
  shot: z
    .string()
    .optional()
    .describe('moveShot: the shot id to move, e.g. arrival__beat1; deleteShot: the one to remove'),
  text    : z.string().optional().describe('setLineText, insertLine'),
  lines: z
    .array(
      z.object({
        kind   : z.enum(LINE_KINDS).optional().describe('defaults to dialogue'),
        speaker: z.string().optional().describe('the character cue; omit for narration'),
        text   : z.string().min(1),
      }),
    )
    .optional()
    .describe('insertLines: a run of lines to add in order, each after the one before it'),
  lineIds: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'deleteLines: the line ids to remove, in any order; all of them or none. ' +
        'newShot: the lines the shot covers from birth — at least one, and only uncovered ones',
    ),
  framing: z
    .enum(['wide', 'medium', 'close', 'establishing'])
    .optional()
    .describe('newShot: how the frame is composed; defaults to medium'),
  subjects: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'newShot: the character ids on screen. Defaults to the speakers of the covered lines, ' +
        'which is wrong for a reaction on a listener, an establishing frame over narration, or ' +
        'anyone present and silent. Nothing can change a shot’s cast afterwards',
    ),
  after: z
    .string()
    .optional()
    .describe(
      'insertLine, moveLine: the line to sit after; moveShot: the shot to sit after; ' +
        'omit for the top of the scene',
    ),
  kind    : z.enum(LINE_KINDS).optional().describe('insertLine; defaults to dialogue'),
  speaker: z
    .string()
    .optional()
    .describe('insertLine, setSpeaker: the character cue; empty makes the line narration'),
  heading: z
    .string()
    .optional()
    .describe(
      'newScene, setHeading: e.g. INT. CLASSROOM - EVENING. setHeading moves the scene, so its ' +
        'rendered shots are drawn again and its prose is left describing the old place',
    ),
  at      : z.string().optional().describe('splitScene: the line id that starts the second half'),
  into: z.string().optional().describe('splitScene: the new scene id; mergeScene: the absorber'),
});

type SceneEditArgs = z.infer<typeof sceneEditShape>;

/**
 * The arguments each op cannot be attempted without. Only absence is checked here — whether a
 * line may be empty, whether a dialogue line needs a speaker, and whether a scene may be deleted
 * are judgments `@vn/scriptedit` already makes, and making them twice here would let the two
 * answers disagree.
 */
const SCENE_OP_ARGS: Record<SceneOp, readonly (keyof SceneEditArgs)[]> = {
  setLineText: ['line', 'text'],
  insertLine : ['scene', 'text'],
  insertLines: ['scene', 'lines'],
  deleteLine : ['line'],
  deleteLines: ['lineIds'],
  moveLine   : ['line'],
  moveShot   : ['scene', 'shot'],
  newShot    : ['scene', 'lineIds'],
  deleteShot : ['scene', 'shot'],
  setSpeaker : ['line'],
  newScene   : ['scene', 'heading'],
  setHeading : ['scene', 'heading'],
  deleteScene: ['scene'],
  splitScene : ['scene', 'at', 'into'],
  mergeScene : ['scene', 'into'],
};

/**
 * The one `@vn/scriptedit` decision an op names, with the tool's defaults filled in. Async only
 * because `moveShot`'s rule needs the scene's storyboard, which is read off disk; the other ops
 * are pure and resolve immediately.
 */
async function sceneDecider(
  a: SceneEditArgs,
  workspace: Workspace,
): Promise<(state: ScriptState) => LineOp> {
  const scene = a.scene ?? '';
  const line = a.line ?? '';
  const text = a.text ?? '';
  const after = a.after ?? '';
  const speaker = a.speaker ?? '';
  const into = a.into ?? '';
  switch (a.op) {
    case 'setLineText':
      return (s) => setLineText(s, { line, text });
    case 'insertLine':
      return (s) => insertLine(s, { scene, after, kind: a.kind ?? 'dialogue', speaker, text });
    case 'insertLines':
      return (s) =>
        insertLines(s, {
          scene,
          after,
          lines: (a.lines ?? []).map((l) => ({
            kind   : l.kind ?? 'dialogue',
            speaker: l.speaker ?? '',
            text   : l.text,
          })),
        });
    case 'deleteLine':
      return (s) => deleteLine(s, { line });
    case 'deleteLines':
      return (s) => deleteLines(s, { lines: a.lineIds ?? [] });
    case 'moveLine':
      return (s) => moveLine(s, { line, after });
    case 'moveShot':
      return workspace.shotOrder(scene, a.shot ?? '', after);
    case 'newShot':
    case 'deleteShot':
      // Handled in run() before the decider is asked: both write the storyboard, not prose, so
      // they never go through `planSceneEdit`.
      throw new Error(`${a.op} does not go through planSceneEdit`);
    case 'setSpeaker':
      return (s) => setSpeaker(s, { line, speaker });
    case 'newScene':
      return (s) => newScene(s, { scene, heading: a.heading ?? '' });
    case 'setHeading':
      return (s) => setHeading(s, { scene, heading: a.heading ?? '' });
    case 'deleteScene':
      return (s) => deleteScene(s, { scene });
    case 'splitScene':
      return (s) => splitScene(s, { scene, at: a.at ?? '', into });
    case 'mergeScene':
      return (s) => mergeScene(s, { scene, into });
  }
}

/**
 * The agent's one prose write path, over the same decisions the palette and the branch editor run.
 * It exists so that `vnauthor` goes through them: a whole-file overwrite can duplicate line ids
 * and strand storyboards, and nothing downstream would notice.
 */
const editSceneTool: Tool<SceneEditArgs> = {
  name       : 'edit_scene',
  description:
    'Edit scene prose: retype, insert, delete, move or re-attribute a line; create, delete, ' +
    'split or merge a scene; reorder a shot, which moves the lines it covers. The only way to ' +
    'change a scenes/<id>.md — write_file refuses them. Reports what the edit costs the ' +
    'storyboard; moveShot costs it nothing, since no coverage and no covered prose changes. ' +
    'newShot and deleteShot edit the storyboard instead: read it with read_shots first. A new ' +
    'shot covers the lineIds you pass and is a new frame the pipeline will owe — the first one ' +
    'on an undecomposed scene writes the storyboard and ends decomposition for that scene — and ' +
    'its subjects are the covered lines’ speakers unless you name them, which is the one chance ' +
    'to say who is on screen; ' +
    'deleting a shot releases its lines as gaps and orphans any art already paid for; deleting ' +
    'the last one deletes the file, so the scene is decomposed again. ' +
    'newScene leaves the scene unreachable on purpose: follow it with edit_branches to link it in. ' +
    'Drafting a run of prose is insertLines and clearing one is deleteLines, one call for the ' +
    'whole run — do not call insertLine or deleteLine forty times.',
  mutating   : true,
  args       : sceneEditShape,
  async run(a, ctx) {
    const missing = SCENE_OP_ARGS[a.op].filter((name) => a[name] === undefined);
    if (missing.length > 0) return fail(`${a.op} needs: ${missing.join(', ')}`);

    // Both storyboard ops write `work/shots/<scene>.json` rather than prose, so they take
    // `set_outfit`'s write path and run the `shotcreate` rules behind `story.newShot` and
    // `story.deleteShot`. A refusal here is verbatim the one the Coverage strip shows.
    if (a.op === 'newShot') {
      const op = await ctx.workspace.newShot(
        a.scene ?? '',
        a.lineIds ?? [],
        a.framing,
        a.subjects ?? [],
      );
      if (!op.ok) return fail(op.error);
      await writeShots(ctx.workspace.paths, a.scene!, op.shots, { nextShot: op.nextShot });
      const shotsFile = `vngen/work/shots/${a.scene}.json`;
      return ok(op.message, {
        written: [shotsFile],
        data   : { paths: [shotsFile], shot: op.shot.id, created: op.created },
      });
    }
    if (a.op === 'deleteShot') {
      const op = await ctx.workspace.deleteShot(a.scene ?? '', a.shot ?? '');
      if (!op.ok) return fail(op.error);
      if (op.deleteFile) await deleteShots(ctx.workspace.paths, a.scene!);
      else await writeShots(ctx.workspace.paths, a.scene!, op.shots, { nextShot: op.nextShot });
      const shotsFile = `vngen/work/shots/${a.scene}.json`;
      return ok(op.message, { written: [shotsFile], data: { paths: [shotsFile] } });
    }

    const input = await ctx.workspace.sceneEditInput();
    const plan = await planSceneEdit(input, await sceneDecider(a, ctx.workspace));
    if (!plan.ok) return fail(plan.message);

    const { written, removed } = await applyScenePlan(input, plan);
    const paths = [...written, ...removed].map((file) => rel(ctx.workspace.root, file));
    return ok(scenePlanMessage(plan), { written: paths, data: { paths, fallout: plan.fallout } });
  },
};

// ── Branch wiring (execute mode) ────────────────────────────────────────────

const BRANCH_OPS = ['setChoice', 'removeChoice', 'setNext', 'spliceScene'] as const;

type BranchOpName = (typeof BRANCH_OPS)[number];

const branchEditShape = z.object({
  op   : z.enum(BRANCH_OPS).describe('which rewire; the arguments each one needs are listed below'),
  scene: z
    .string()
    .min(1)
    .describe('the scene being wired; for spliceScene, the one going in the middle'),
  goto: z
    .string()
    .optional()
    .describe('setChoice: where the choice leads. setNext: the continuation; omit to clear it'),
  label: z.string().optional().describe('setChoice: what the player reads on the button'),
  index: z
    .number()
    .int()
    .optional()
    .describe('setChoice: which choice to replace, omit to append. removeChoice: which to drop'),
  from : z.string().optional().describe('spliceScene: the scene whose outgoing edge is being cut'),
  edge: z
    .number()
    .int()
    .optional()
    .describe("spliceScene: which of `from`'s choices to splice into; omit for its next"),
});

type BranchEditArgs = z.infer<typeof branchEditShape>;

/** As with {@link SCENE_OP_ARGS}, only absence is checked; the rules judge everything else. */
const BRANCH_OP_ARGS: Record<BranchOpName, readonly (keyof BranchEditArgs)[]> = {
  setChoice   : ['goto', 'label'],
  removeChoice: ['index'],
  setNext     : [],
  spliceScene : ['from'],
};

const branchDecider =
  (a: BranchEditArgs) =>
  (scenes: SceneMap): BranchOp => {
    const scene = a.scene;
    switch (a.op) {
      case 'setChoice':
        return setChoice(scenes, {
          scene,
          goto : a.goto ?? '',
          label: a.label ?? '',
          ...(a.index === undefined ? {} : { index: a.index }),
        });
      case 'removeChoice':
        return removeChoice(scenes, { scene, index: a.index ?? 0 });
      case 'setNext':
        return setNext(scenes, { scene, ...(a.goto === undefined ? {} : { goto: a.goto }) });
      case 'spliceScene':
        return spliceScene(scenes, {
          scene,
          from: a.from ?? '',
          ...(a.edge === undefined ? {} : { edge: a.edge }),
        });
    }
  };

/**
 * The agent's one way to say what leads where, over the same `@vn/scriptedit` rules the branch
 * editor runs mid-drag, so a refused rewire is refused in the same sentence an author would read.
 *
 * It exists because `newScene` leaves the new scene with nothing pointing at it: `write_file`
 * refuses `scenes/`, `edit_scene` writes prose, and a scene nothing reaches never appears in the
 * story. Creating one deliberately stays two acts rather than a `goto` argument on `newScene` —
 * where a new scene belongs is a separate authorial decision, and `spliceScene` (putting it
 * between two scenes) is the right answer often enough that folding one of the four ops into
 * `newScene` would make the other three look optional.
 */
const editBranchesTool: Tool<BranchEditArgs> = {
  name       : 'edit_branches',
  description:
    'Wire the story graph: add or replace a choice, drop one, set or clear a scene’s linear ' +
    'continuation, or splice a scene into an existing edge so A→B becomes A→C→B. This is how a ' +
    'scene created by edit_scene is linked in — until something points at it, the story never ' +
    'reaches it. A goto may name a scene that does not exist yet; that is a dangling edge the ' +
    'editor reports, not an error.',
  mutating   : true,
  args       : branchEditShape,
  async run(a, ctx) {
    const missing = BRANCH_OP_ARGS[a.op].filter((name) => a[name] === undefined);
    if (missing.length > 0) return fail(`${a.op} needs: ${missing.join(', ')}`);

    const { op, sources } = await ctx.workspace.branchEdit(branchDecider(a));
    if (!op.ok) return fail(op.error);

    const plan = planMarkerEdit(sources, op.edits);
    if (!plan.ok) return fail(plan.message);
    if (plan.patches.length === 0)
      return ok(`${op.message} (already wired that way — nothing written)`);

    const files = await applyMarkerPlan(plan.patches);
    const paths = files.map((file) => rel(ctx.workspace.root, file));
    return ok(op.message, { written: paths, data: { paths } });
  },
};

export { editSceneTool, editBranchesTool };

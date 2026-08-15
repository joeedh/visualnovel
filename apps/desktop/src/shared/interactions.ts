/**
 * The app's direct-manipulation gestures, declared: what each one carries, which targets would
 * take it, and the command each drop commits.
 *
 * Every decision here delegates to the same rule module the matching `story.*` command runs in
 * main — `branchops` for the branch editor, `coverage` for the timeline, `lineops` for the script.
 * So the sentence shown while a card hovers over a wire it cannot be spliced into is produced by
 * the function that would have refused the drop, and `interaction.targets` answers with that same
 * sentence without anything being attempted.
 *
 * It is in `shared/` rather than in the renderer because both halves need it: the surfaces run
 * `targets` during a gesture, and main runs it to answer an agent. See
 * `docs/plans/interaction-model.md`.
 */
import { defineInteraction, InteractionRegistry, UNRESOLVED, type Verdict } from '@vn/commands';
import { moveLine, planShotMove, sceneIdOf, type ScriptState } from '@vn/scriptedit';
import { removeChoice, setChoice, setNext, spliceScene } from './branchops.js';
import type { BranchOp, SceneMap } from './branchops.js';
import { resolveDrag, setCoverage, spansFor, type Edge } from './coverage.js';
import type { CoverageLine, CoverageShot, PropValue, StoryEdge, StoryGraph } from './ipc.js';
import { effectiveOrder, moveChunk, TOP_CHUNK, type PromptOrderState } from './promptops.js';

/** A new choice has to be called something before the author has named it. */
export const NEW_CHOICE = 'New choice';

/** `branch.unwire`'s only target — named so a caller can address it. */
export const CANVAS = 'canvas';

/**
 * The insertion point above a scene's first line — the empty `after` of `story.moveLine` and
 * `story.moveShot`, which is not addressable as a target. Safe as a name because every line id is
 * `<scene>:L<n>` and every shot id is `<scene>__<raw>`.
 */
export const TOP = 'top';

export interface Intent {
  id: string;
  props: Record<string, PropValue>;
  /** What the command will report — used as the drop preview, so the two read the same. */
  note: string;
}

export type Decision = { ok: true; intent: Intent } | { ok: false; reason: string };

const decide = (op: BranchOp, id: string, props: Record<string, PropValue>): Decision =>
  op.ok ? { ok: true, intent: { id, props, note: op.message } } : { ok: false, reason: op.error };

/**
 * A single-target decision as the verdict for that target. `note` is lifted off the intent so
 * `invoke` is exactly an `Invocation` — it is handed straight to `command:exec`, which rejects
 * unknown keys.
 */
const verdict = (decision: Decision, target: string): Verdict => {
  if (!decision.ok) return { target, accept: false, reason: decision.reason };
  const { note, id, props } = decision.intent;
  return { target, accept: true, note, invoke: { id, props } };
};

// ---------------------------------------------------------------------------
// The per-target decisions. Each is `can(gesture, target)`: the whole verdict, before acting.
// ---------------------------------------------------------------------------

/**
 * Wire `from` to `to`. A scene with nothing leaving it continues linearly; anything else gains
 * a choice — including a scene that already has a bare `next`, whose fallthrough the runner
 * will then stop following. That is not refused: the now-inert edge is drawn struck through,
 * which says it better than a modal would.
 */
export function connect(scenes: SceneMap, from: string, to: string): Decision {
  const scene = scenes.get(from);
  if (scene && scene.choices.length === 0 && scene.next === undefined) {
    return decide(setNext(scenes, { scene: from, goto: to }), 'story.setNext', {
      scene: from,
      goto: to,
    });
  }
  return decide(
    setChoice(scenes, { scene: from, goto: to, label: NEW_CHOICE }),
    'story.setChoice',
    { scene: from, goto: to, label: NEW_CHOICE },
  );
}

/** Drop scene `scene` onto `edge`: `A→B` becomes `A→scene→B`. */
export function splice(scenes: SceneMap, scene: string, edge: StoryEdge): Decision {
  const target = edgeTarget(edge);
  return decide(spliceScene(scenes, { scene, ...target }), 'story.spliceScene', {
    scene,
    from: target.from,
    ...(target.edge !== undefined ? { edge: target.edge } : {}),
  });
}

/** Pull an edge's endpoint off its target: remove the choice, or clear the continuation. */
export function unwire(scenes: SceneMap, edge: StoryEdge): Decision {
  if (edge.kind === 'next') {
    return decide(setNext(scenes, { scene: edge.from }), 'story.setNext', {
      scene: edge.from,
      goto: '',
    });
  }
  const index = edge.index ?? 0;
  return decide(removeChoice(scenes, { scene: edge.from, index }), 'story.removeChoice', {
    scene: edge.from,
    index,
  });
}

/**
 * Retype a choice's decision text. The edge keeps its index, so it stays the same choice.
 *
 * Not an interaction: it commits from an inline text input, so there is no carried object and
 * no enumerable target set — the thing an interaction exists to describe.
 */
export function relabel(scenes: SceneMap, edge: StoryEdge, label: string): Decision {
  if (edge.kind !== 'choice' || edge.index === undefined) {
    return { ok: false, reason: 'Only a choice carries a label.' };
  }
  const props = { scene: edge.from, goto: edge.to, label, index: edge.index };
  return decide(setChoice(scenes, props), 'story.setChoice', props);
}

// ---------------------------------------------------------------------------
// The state the gestures are judged against, projected from the graph the view draws.
// ---------------------------------------------------------------------------

/**
 * The branch structure the graph describes, back in `Scene` terms. Choice order comes from
 * `StoryEdge.index` rather than array position, so it is the same index the command takes.
 *
 * This inverse is the load-bearing half: it is what lets a drop be judged by the *real*
 * `branchops` while the pointer is still down, rather than by a copy of the rules that could
 * disagree with them.
 */
export function scenesOf(story: StoryGraph): SceneMap {
  const scenes = new Map<string, { id: string; choices: { label: string; goto: string }[] }>();
  for (const scene of story.scenes) scenes.set(scene.id, { id: scene.id, choices: [] });

  const nexts = new Map<string, string>();
  const choices = new Map<string, { index: number; label: string; goto: string }[]>();
  for (const edge of story.edges) {
    if (!scenes.has(edge.from)) continue;
    if (edge.kind === 'next') nexts.set(edge.from, edge.to);
    else {
      const list = choices.get(edge.from) ?? [];
      list.push({ index: edge.index ?? list.length, label: edge.label ?? '', goto: edge.to });
      choices.set(edge.from, list);
    }
  }

  const out = new Map<string, { id: string; choices: { label: string; goto: string }[] }>();
  for (const [id, scene] of scenes) {
    const list = (choices.get(id) ?? [])
      .sort((a, b) => a.index - b.index)
      .map(({ label, goto }) => ({ label, goto }));
    const next = nexts.get(id);
    out.set(id, { ...scene, choices: list, ...(next !== undefined ? { next } : {}) });
  }
  return out;
}

/** The `story.spliceScene` arguments that address an edge. A `next` edge has no index. */
export const edgeTarget = (edge: StoryEdge): { from: string; edge?: number } => ({
  from: edge.from,
  ...(edge.kind === 'choice' && edge.index !== undefined ? { edge: edge.index } : {}),
});

/** Everything the three gestures are judged against. */
export interface BranchState {
  scenes: SceneMap;
  edges: StoryEdge[];
}

export const branchState = (story: StoryGraph): BranchState => ({
  scenes: scenesOf(story),
  edges: story.edges,
});

// ---------------------------------------------------------------------------
// The interactions.
// ---------------------------------------------------------------------------

export const branchConnect = defineInteraction<BranchState>({
  id: 'branch.connect',
  title: 'Wire a scene to another',
  description:
    "Drag a card's ⌄ handle onto another scene. A scene with nothing leaving it gains a linear " +
    'continuation; one that already leads somewhere gains a choice.',
  grab: "a scene card's ⌄ connect handle",
  carries: 'the scene the wire leaves',
  accepts: 'any scene card, including one already wired to',
  commands: ['story.setNext', 'story.setChoice'],
  cancellable: true,
  targets: (state, from) =>
    [...state.scenes.keys()].map((to) => verdict(connect(state.scenes, from, to), to)),
});

export const branchSplice = defineInteraction<BranchState>({
  id: 'branch.splice',
  title: 'Splice a scene into an edge',
  description:
    'Drop a scene card on a wire: A→B becomes A→C→B, as one patch. Refused when C already ' +
    'forks (its next would never be followed) or is already an endpoint of that edge.',
  grab: 'a scene card',
  carries: 'the scene to splice in',
  accepts: 'any wire',
  commands: ['story.spliceScene'],
  cancellable: true,
  targets: (state, scene) =>
    state.edges.map((edge) => verdict(splice(state.scenes, scene, edge), edge.id)),
});

/**
 * The one gesture with a single target: the arrowhead is pulled *off* whatever it points at,
 * so there is nowhere else it could land. It is still an interaction rather than a bare
 * command because the verdict — whether that edge can be removed at all — is worth asking for.
 */
export const branchUnwire = defineInteraction<BranchState>({
  id: 'branch.unwire',
  title: 'Unwire an edge',
  description:
    "Pull a wire's arrowhead off its target scene. A choice is removed; a linear continuation " +
    'is cleared.',
  grab: "a wire's arrowhead",
  carries: 'the edge being pulled',
  accepts: 'empty canvas — anywhere off the scene it points at',
  commands: ['story.removeChoice', 'story.setNext'],
  cancellable: true,
  targets: (state, edgeId) => {
    const edge = state.edges.find((e) => e.id === edgeId);
    if (!edge) return [{ target: CANVAS, accept: false, reason: `No edge "${edgeId}".` }];
    return [verdict(unwire(state.scenes, edge), CANVAS)];
  },
});

// ---------------------------------------------------------------------------
// The timeline's two gestures: one moves a bracket's edge, the other moves the bracket.
// ---------------------------------------------------------------------------

/** Everything `timeline.cover` is judged against: exactly `SceneCoverage` minus `decomposed`. */
export interface CoverState {
  sceneId: string;
  lines: CoverageLine[];
  shots: CoverageShot[];
}

/** `<shotId>#start` / `<shotId>#end` — the handle, as one token. */
export const handleId = (shotId: string, edge: Edge): string => `${shotId}#${edge}`;

const parseHandle = (carried: string): { shotId: string; edge: Edge } | null => {
  const cut = carried.lastIndexOf('#');
  const edge = carried.slice(cut + 1);
  if (cut <= 0 || (edge !== 'start' && edge !== 'end')) return null;
  return { shotId: carried.slice(0, cut), edge };
};

/**
 * Dragging a bracket's outer handle onto a line. Unlike the branch gestures, most targets are
 * *not* candidates at all: dropping the handle back where it already is changes nothing, so those
 * rows are dropped from the list rather than reported as an accept the author would learn nothing
 * from — "no target" and "a target that refuses" are different answers.
 */
export const timelineCover = defineInteraction<CoverState>({
  id: 'timeline.cover',
  title: 'Drag a shot’s coverage',
  description:
    "Drag a bracket's start or end handle onto a line of the scene. Extending claims every line " +
    'it sweeps, taking each off whatever shot held it; retracting releases them as gaps. Refused ' +
    'when it would leave another shot covering nothing.',
  grab: "a shot bracket's start or end handle",
  carries: 'the handle — `<shotId>#start` or `<shotId>#end`',
  accepts: 'any line of the scene',
  commands: ['story.setCoverage'],
  cancellable: true,
  targets: (state, carried) => {
    const handle = parseHandle(carried);
    if (!handle) {
      return [
        {
          target: UNRESOLVED,
          accept: false,
          reason: `Malformed handle "${carried}" (expected "<shotId>#start" or "<shotId>#end").`,
        },
      ];
    }
    const coverage = spansFor(state.lines, state.shots);
    if (!coverage.spans.some((s) => s.shot.id === handle.shotId)) {
      return [
        {
          target: UNRESOLVED,
          accept: false,
          // A shot covering nothing draws no bracket, so it has no handle to have been grabbed.
          reason: `No shot "${handle.shotId}" covers anything in ${state.sceneId}.`,
        },
      ];
    }

    const lineOrder = state.lines.map((l) => l.id);
    const verdicts: Verdict[] = [];
    for (const row of coverage.rows) {
      const lines = resolveDrag(coverage, handle.shotId, handle.edge, row.index);
      if (!lines) continue;
      const op = setCoverage(state.shots, { shot: handle.shotId, lines, lineOrder });
      verdicts.push(
        op.ok
          ? {
              target: row.line.id,
              accept: true,
              note: op.message,
              invoke: {
                id: 'story.setCoverage',
                props: { scene: state.sceneId, shot: handle.shotId, lines: lines.join(',') },
              },
            }
          : { target: row.line.id, accept: false, reason: op.error },
      );
    }
    return verdicts;
  },
});

/**
 * Dragging a whole bracket onto another one. The targets are the *other shots* rather than the
 * lines, because that is what the act is about: a shot's position is where its covered lines sit,
 * so "put this shot after that one" is the only way to say it without the author computing rows.
 * {@link TOP} is a target too — the same insertion point `script.moveLine` offers.
 *
 * The refusal that matters is the interleaved shot: it is on screen in more than one place and has
 * no single position, and here it comes back as a refusal on every target rather than a gesture
 * that quietly does something else.
 */
export const timelineReorder = defineInteraction<CoverState>({
  id: 'timeline.reorder',
  title: 'Reorder a shot',
  description:
    'Drag a shot bracket onto another one to put it after that shot, taking the lines it covers ' +
    'with it. Coverage does not change and no covered prose changes, so nothing drifts and ' +
    'nothing re-renders.',
  grab: 'a shot bracket, anywhere but its start and end handles',
  carries: 'the shot being moved',
  accepts: 'another shot of the same scene, or `top`',
  commands: ['story.moveShot'],
  cancellable: true,
  targets: (state, carried) => {
    if (!state.shots.some((s) => s.id === carried)) {
      return [
        { target: UNRESOLVED, accept: false, reason: `No shot "${carried}" in ${state.sceneId}.` },
      ];
    }
    const scene = { id: state.sceneId, lineOrder: state.lines.map((l) => l.id) };
    const verdicts: Verdict[] = [];
    for (const target of [TOP, ...state.shots.map((s) => s.id)]) {
      if (target === carried) continue;
      const after = target === TOP ? '' : target;
      const move = planShotMove(scene, state.shots, { shot: carried, after });
      // A drop that would reorder nothing is left out entirely, the same distinction
      // `timeline.cover` and `script.moveLine` draw: no target, rather than a pointless accept.
      if (!move.ok && move.noop) continue;
      verdicts.push(
        move.ok
          ? {
              target,
              accept: true,
              note: move.message,
              invoke: {
                id: 'story.moveShot',
                props: { scene: state.sceneId, shot: carried, after },
              },
            }
          : { target, accept: false, reason: move.error },
      );
    }
    return verdicts;
  },
});

// ---------------------------------------------------------------------------
// The script's one gesture. It was declared and tested here before any surface ran it, which is
// the point of the layer; STUDIO's script column is now its first consumer.
// ---------------------------------------------------------------------------

/**
 * Dragging a line to another position in its own scene. The targets are *insertion points*, so
 * there is one more of them than there are lines: {@link TOP}, then "after each line".
 *
 * Two kinds of non-target, and the distinction is the same one `timeline.cover` draws: a drop
 * that would reorder nothing is left out of the list entirely rather than reported as an accept
 * the author would learn nothing from, while a drop `lineops` refuses comes back as a refusal
 * carrying its sentence. A line id from another scene is not a near-miss target — coverage cannot
 * cross a scene boundary — so it is the whole gesture that is unresolved.
 */
export const scriptMoveLine = defineInteraction<ScriptState>({
  id: 'script.moveLine',
  title: 'Move a line within its scene',
  description:
    'Drag a line to another position in the same scene. Line ids do not change, so no shot ' +
    'detaches — but a shot was made to depict its covered lines in order, so rendered art ' +
    'covering the moved line drifts.',
  grab: "a line's drag handle in the script column",
  carries: 'the line being moved',
  accepts: 'an insertion point in the same scene — `top`, or any other line to sit after',
  commands: ['story.moveLine'],
  cancellable: true,
  targets: (state, carried) => {
    const scene = state.scenes.get(sceneIdOf(carried));
    if (!scene?.lines.some((l) => l.id === carried)) {
      return [
        {
          target: UNRESOLVED,
          accept: false,
          reason: scene
            ? `Scene "${scene.id}" has no line "${carried}".`
            : `"${carried}" is not a line of any loaded scene.`,
        },
      ];
    }

    const order = scene.lines.map((l) => l.id).join('\n');
    const verdicts: Verdict[] = [];
    for (const target of [TOP, ...scene.lines.map((l) => l.id)]) {
      if (target === carried) continue;
      const props = { line: carried, after: target === TOP ? '' : target };
      const op = moveLine(state, props);
      if (!op.ok) {
        verdicts.push({ target, accept: false, reason: op.error });
        continue;
      }
      const after = op.writes.find((s) => s.id === scene.id);
      if (after && after.lines.map((l) => l.id).join('\n') === order) continue;
      verdicts.push({
        target,
        accept: true,
        note: op.message,
        invoke: { id: 'story.moveLine', props },
      });
    }
    return verdicts;
  },
});

// ---------------------------------------------------------------------------
// The asset pane's one gesture: the order the clauses of a prompt are said in.
// ---------------------------------------------------------------------------

/** Everything `prompt.reorder` is judged against: one asset's chunks and the mode in force. */
export interface PromptDragState extends PromptOrderState {
  /** The asset whose prompt this is — every `prompt.*` command addresses one by hash. */
  hash: string;
}

/**
 * Dragging a chunk card to another position in the same prompt. The targets are *insertion points*,
 * so there is one more of them than there are cards: {@link TOP_CHUNK}, then "after each chunk".
 *
 * It earns its place as an interaction rather than a click handler because it has two real
 * refusals. A drop that would reorder nothing is left out of the list entirely — no target, rather
 * than an accept the author would learn nothing from. And in custom mode the whole gesture is
 * unresolved: the cards are still drawn, but only as what the agent would be given, so there is no
 * order in force for a drop to change.
 *
 * An accept's note carries the reorder-invalidates-a-condensation warning (see `moveChunk`), so the
 * author reads it while the pointer is still down rather than after the prompt is already held.
 *
 */
export const promptReorder = defineInteraction<PromptDragState>({
  id: 'prompt.reorder',
  title: 'Reorder a prompt chunk',
  description:
    'Drag a chunk card onto another one to say its sentence after that chunk. The prompt is one ' +
    'string, so this moves what the image model reads first — and it moves the task hash, so the ' +
    'asset re-renders.',
  grab: "a chunk card's drag rail in the asset pane",
  carries: 'the chunk being moved, by key',
  accepts: 'another chunk of the same prompt, or `top`',
  commands: ['prompt.moveChunk'],
  cancellable: true,
  targets: (state, carried) => {
    if (state.mode === 'custom') {
      return [
        {
          target: UNRESOLVED,
          accept: false,
          reason:
            'A custom prompt has no chunk order; the list below is only what the agent would be given.',
        },
      ];
    }
    const keys = effectiveOrder(state.chunks, state.order).map((c) => c.key);
    if (!keys.includes(carried)) {
      return [
        { target: UNRESOLVED, accept: false, reason: `No chunk "${carried}" in this prompt.` },
      ];
    }
    const verdicts: Verdict[] = [];
    for (const target of [TOP_CHUNK, ...keys]) {
      if (target === carried) continue;
      const after = target === TOP_CHUNK ? '' : target;
      const move = moveChunk(state, { chunk: carried, after });
      if (!move.ok && move.noop) continue;
      verdicts.push(
        move.ok
          ? {
              target,
              accept: true,
              note: move.message,
              invoke: {
                id: 'prompt.moveChunk',
                props: { hash: state.hash, chunk: carried, after },
              },
            }
          : { target, accept: false, reason: move.error },
      );
    }
    return verdicts;
  },
});

export const INTERACTION_IDS = [
  'branch.connect',
  'branch.splice',
  'branch.unwire',
  'prompt.reorder',
  'script.moveLine',
  'timeline.cover',
  'timeline.reorder',
] as const;

/**
 * Every gesture the app declares. The registry is state-agnostic (`any`) because its members are
 * judged against different states — the caller supplies the one the gesture wants.
 */
export function createDesktopInteractions(): InteractionRegistry {
  const registry = new InteractionRegistry();
  registry.registerAll([
    branchConnect,
    branchSplice,
    branchUnwire,
    promptReorder,
    timelineCover,
    timelineReorder,
    scriptMoveLine,
  ]);
  return registry;
}

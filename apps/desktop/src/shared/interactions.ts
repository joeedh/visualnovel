/**
 * The branch editor's gestures, declared: what each one carries, which targets would take it,
 * and the command each drop commits.
 *
 * Every decision here delegates to `branchops`, the same module the `story.*` commands run in
 * main. So the sentence shown while a card hovers over a wire it cannot be spliced into is
 * produced by the function that would have refused the drop, and `interaction.targets` answers
 * with that same sentence without anything being attempted.
 *
 * It is in `shared/` rather than in the renderer because both halves need it: the editor runs
 * `targets` mid-drag, and main runs it to answer an agent. See
 * `docs/plans/interaction-model.md`.
 */
import { defineInteraction, InteractionRegistry, type Verdict } from '@vn/commands';
import { removeChoice, setChoice, setNext, spliceScene } from './branchops.js';
import type { BranchOp, SceneMap } from './branchops.js';
import type { PropValue, StoryEdge, StoryGraph } from './ipc.js';

/** A new choice has to be called something before the author has named it. */
export const NEW_CHOICE = 'New choice';

/** `branch.unwire`'s only target — named so a caller can address it. */
export const CANVAS = 'canvas';

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

export const branchConnect = defineInteraction<BranchState, string>({
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

export const branchSplice = defineInteraction<BranchState, string>({
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
export const branchUnwire = defineInteraction<BranchState, string>({
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

export const INTERACTION_IDS = ['branch.connect', 'branch.splice', 'branch.unwire'] as const;

export function createBranchInteractions(): InteractionRegistry<BranchState> {
  const registry = new InteractionRegistry<BranchState>();
  registry.registerAll([branchConnect, branchSplice, branchUnwire]);
  return registry;
}

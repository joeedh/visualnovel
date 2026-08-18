/**
 * The pure half of the `story.*` mutating commands: turn a gesture ("connect these two",
 * "splice C into A→B") into the `SceneMarkerEdit[]` that `applySceneMarkerEdit` applies as one
 * atomic patch.
 *
 * It lives apart from the command definitions because this is where the semantics are — which
 * rewires are legal, which silently produce an edge the runner would ignore — and those are
 * exactly what wants a node test rather than an Electron session.
 *
 * It is in this package rather than in the app for the same reason `lineops.ts` is. The branch
 * editor runs these *same functions* mid-drag, so the refusal an author reads while dragging is
 * produced by the code that will run on drop — and the agent's `edit_branches` runs them too, so
 * the one thing it can do after `newScene` says *nothing points at it yet* is the thing the app
 * would do. A package may not import an app; while these rules were in `apps/desktop/src/shared/`,
 * the agent could create a scene and then had no way to wire it in.
 */
import type { Choice, Scene } from '@vn/types';
import type { SceneMarkerEdit } from '@vn/model';

/** Just enough of a `Scene` to decide a rewire. Keyed by scene id. */
export type SceneMap = ReadonlyMap<string, Pick<Scene, 'id' | 'choices' | 'next'>>;

export type BranchOp =
  | { ok: true; edits: SceneMarkerEdit[]; message: string }
  | { ok: false; error: string };

const refuse = (error: string): BranchOp => ({ ok: false, error });

/** `choices` is copied on read; every op returns a fresh array rather than mutating the model. */
const choicesOf = (scene: { choices: Choice[] }): Choice[] =>
  scene.choices.map((c) => ({ label: c.label, goto: c.goto }));

/**
 * Add a choice, or replace the one at `index`. `goto` may name a scene that does not exist
 * yet — a dangling edge is a story diagnostic the editor *shows*, not something to forbid at
 * the point of authoring.
 */
export function setChoice(
  scenes: SceneMap,
  args: { scene: string; goto: string; label: string; index?: number },
): BranchOp {
  const scene = scenes.get(args.scene);
  if (!scene) return refuse(`No scene "${args.scene}".`);

  const choices = choicesOf(scene);
  const { index } = args;
  const choice = { label: args.label, goto: args.goto };

  if (index === undefined) {
    choices.push(choice);
    return {
      ok: true,
      edits: [{ sceneId: scene.id, choices }],
      message: `${scene.id} → ${args.goto} ("${args.label}").`,
    };
  }
  if (index < 0 || index >= choices.length) {
    return refuse(`${scene.id} has no choice at index ${index}.`);
  }
  choices[index] = choice;
  return {
    ok: true,
    edits: [{ sceneId: scene.id, choices }],
    message: `${scene.id} choice ${index} → ${args.goto} ("${args.label}").`,
  };
}

export function removeChoice(scenes: SceneMap, args: { scene: string; index: number }): BranchOp {
  const scene = scenes.get(args.scene);
  if (!scene) return refuse(`No scene "${args.scene}".`);

  const choices = choicesOf(scene);
  const removed = choices[args.index];
  if (!removed) return refuse(`${scene.id} has no choice at index ${args.index}.`);
  choices.splice(args.index, 1);
  return {
    ok: true,
    edits: [{ sceneId: scene.id, choices }],
    message: `Removed ${scene.id} → ${removed.goto} ("${removed.label}").`,
  };
}

/** Set the linear continuation, or clear it when `goto` is omitted. */
export function setNext(scenes: SceneMap, args: { scene: string; goto?: string }): BranchOp {
  const scene = scenes.get(args.scene);
  if (!scene) return refuse(`No scene "${args.scene}".`);

  const goto = args.goto?.trim() ?? '';
  if (!goto) {
    if (scene.next === undefined) return refuse(`${scene.id} has no next scene to clear.`);
    return {
      ok: true,
      edits: [{ sceneId: scene.id, next: null }],
      message: `Cleared ${scene.id} → ${scene.next}.`,
    };
  }
  return {
    ok: true,
    edits: [{ sceneId: scene.id, next: goto }],
    message: `${scene.id} continues to ${goto}.`,
  };
}

/**
 * Splice `scene` into the edge leaving `from`: `A→B` becomes `A→C→B`, as one two-scene patch.
 *
 * Four rules, each a refusal or a deliberate non-action:
 *
 * 1. **`C` must not already have choices.** `next` is only followed when a scene has none, so
 *    writing `C.next = B` on a scene that forks produces an edge the runner ignores — the
 *    story would never reach `B`. A silently dead edge is the failure this editor exists to
 *    catch, so it refuses with a reason rather than writing it.
 * 2. **It is a rewire, not a move.** `C`'s existing inbound edges are untouched; it stays
 *    reachable from wherever it already was, and gains one more way in.
 * 3. **Cycles are legal** — looping back to a hub scene is normal VN structure, so nothing here
 *    validates against them. Only the degenerate drops are refused: `C` as either endpoint of
 *    the edge it is being spliced into.
 * 4. **The label stays with the decision.** If `A→B` read *"Tell the truth"*, `A→C` still does.
 *    The decision hasn't changed, only where it leads first.
 */
export function spliceScene(
  scenes: SceneMap,
  args: { scene: string; from: string; edge?: number },
): BranchOp {
  const middle = scenes.get(args.scene);
  const source = scenes.get(args.from);
  if (!middle) return refuse(`No scene "${args.scene}".`);
  if (!source) return refuse(`No scene "${args.from}".`);

  const { edge } = args;
  const choices = choicesOf(source);
  const target = edge === undefined ? source.next : choices[edge]?.goto;
  if (target === undefined) {
    return refuse(
      edge === undefined
        ? `${source.id} has no next scene to splice into.`
        : `${source.id} has no choice at index ${edge}.`,
    );
  }

  if (middle.id === source.id) return refuse(`${middle.id} cannot be spliced into its own edge.`);
  if (middle.id === target) return refuse(`${middle.id} is already the target of that edge.`);
  if (middle.choices.length > 0) {
    return refuse(
      `${middle.id} already forks into ${middle.choices.length} choice(s), and a scene's ` +
        'next is only followed when it has none — the spliced edge would never be taken.',
    );
  }

  const edits: SceneMarkerEdit[] =
    edge === undefined
      ? [
          { sceneId: source.id, next: middle.id },
          { sceneId: middle.id, next: target },
        ]
      : [
          {
            sceneId: source.id,
            choices: choices.map((c, i) => (i === edge ? { ...c, goto: middle.id } : c)),
          },
          { sceneId: middle.id, next: target },
        ];

  // Overwriting an existing `next` is what splicing *is*, but it silently drops an edge, so
  // it goes in the message and therefore into the CommandRecord.
  const replaced =
    middle.next !== undefined && middle.next !== target
      ? ` (replacing ${middle.id} → ${middle.next})`
      : '';
  return {
    ok: true,
    edits,
    message: `Spliced ${middle.id} into ${source.id} → ${target}${replaced}.`,
  };
}

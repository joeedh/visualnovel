/**
 * The pure half of the `story.*` prose commands: turn one authorial act ("retype this line",
 * "split the scene here") into the scenes to write whole and the chunks to remove.
 *
 * It is the sibling of the desktop's `branchops.ts` — that module decides which *wires* are legal,
 * this one decides which *edits* are — and it is pure for the same reason: a surface previewing a
 * gesture runs these functions, so the refusal shown mid-drag is the refusal the command would
 * give rather than a second copy of the rules. It is a *package* rather than app-local because
 * `vnauthor` needs the same answers, and a package cannot import an app.
 *
 * Two things every caller has to understand, because they are the whole reason these decisions
 * are worth reading before they run:
 *
 * - **A line id is scene-scoped** (`arrival:L4`), so an id names its own scene and no prose op
 *   takes a scene as well. Within a scene every edit is safe: inserting allocates a fresh id,
 *   deleting retires one, reordering keeps them. Across a scene boundary an id cannot survive —
 *   but the renaming is known, so `splitScene` and `mergeScene` both hand back the mapping
 *   (`moved`) and `shotfallout.ts` walks coverage across it rather than dropping it.
 * - **Prose edits do not invalidate art — they let it drift.** `buildShotPrompt` never reads a
 *   line's text; only the P7 reviewer spec does, and that never enters a task's `inputs`. So
 *   retyping, re-attributing or reordering a covered line rehashes nothing and re-renders
 *   nothing: the frame keeps illustrating prose the scene no longer contains. The ids whose
 *   contribution changed come back in `retyped` so a command can *say* which rendered shots
 *   drifted; spending money to fix one stays the author's decision.
 */
import { headingPrefixOf, parseHeading, slug } from '@vn/model';
import type { Scene, SceneLine } from '@vn/types';

/** The scenes an edit is decided against, as their chunk files parse. */
export interface ScriptState {
  /** Every scene, keyed by id — the same map `buildModel` would key. */
  scenes: ReadonlyMap<string, Scene>;
  /** The entry scene `start:` names, so deleting or merging it away can refuse. */
  entry?: string;
}

/** What one authorial act does to the scene files, or why it will not happen. */
export type LineOp =
  | {
      ok: true;
      message: string;
      /** Scenes to write whole. A chunk not named here is left exactly as it is. */
      writes: Scene[];
      /** Scene chunks to delete. */
      removes: string[];
      /** Line ids that stop existing. Every shot covering one silently stops covering it. */
      retired: string[];
      /** Line ids that changed scene, `[old, new]`. Coverage *can* follow these. */
      moved: [string, string][];
      /**
       * Line ids whose prose changed — retyped, re-attributed or reordered. Art covering one
       * was made from text that no longer reads that way, and nothing will re-render it.
       */
      retyped: string[];
    }
  | { ok: false; error: string };

/** An op that is going to happen — what `shotfallout.ts` reads the coverage consequence off. */
export type AppliedLineOp = Extract<LineOp, { ok: true }>;

type Applied = AppliedLineOp;

const refuse = (error: string): LineOp => ({ ok: false, error });

/** An accepted op; every consequence a caller does not name is empty rather than absent. */
const done = (message: string, change: Partial<Omit<Applied, 'ok' | 'message'>> = {}): LineOp => ({
  ok: true,
  message,
  writes: [],
  removes: [],
  retired: [],
  moved: [],
  retyped: [],
  ...change,
});

/** The scene half of a composed `${sceneId}:L<n>` line id. */
export function sceneIdOf(lineId: string): string {
  const colon = lineId.lastIndexOf(':');
  return colon < 0 ? '' : lineId.slice(0, colon);
}

/** The local half — what a `[[line:]]` mark carries, and what survives a scene rename. */
const localOf = (lineId: string): string => lineId.slice(lineId.lastIndexOf(':') + 1);

/** The scene's allocator, derived past every id in use when the scene carries none. */
function nextIdOf(scene: Scene): number {
  let max = 0;
  for (const line of scene.lines) {
    const m = /^L(\d+)$/.exec(localOf(line.id));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return Math.max(scene.nextLineId ?? 1, max + 1);
}

/** A scene with different prose. Every other field — heading, wiring, synopsis — is carried. */
const withLines = (scene: Scene, lines: SceneLine[], nextLineId: number): Scene => ({
  ...scene,
  lines,
  nextLineId,
});

/** A copy with no continuation, so a caller can set one or leave the scene a leaf. */
function unwired(scene: Scene): Scene {
  const copy = { ...scene };
  delete copy.next;
  return copy;
}

/** Find a line, or the sentence explaining why it is not there. */
function locate(state: ScriptState, lineId: string): { scene: Scene; index: number } | string {
  const sceneId = sceneIdOf(lineId);
  if (!sceneId) return `"${lineId}" is not a line id (expected <scene>:L<n>).`;
  const scene = state.scenes.get(sceneId);
  if (!scene) return `No scene "${sceneId}".`;
  const index = scene.lines.findIndex((l) => l.id === lineId);
  if (index < 0) return `Scene "${sceneId}" has no line "${lineId}".`;
  return { scene, index };
}

/** Where a line id sits in `scene`, refusing an id that belongs to a different scene. */
function positionIn(scene: Scene, lineId: string): number | string {
  if (sceneIdOf(lineId) !== scene.id) return `Line "${lineId}" is not in scene "${scene.id}".`;
  const index = scene.lines.findIndex((l) => l.id === lineId);
  return index < 0 ? `Scene "${scene.id}" has no line "${lineId}".` : index;
}

/** Everything pointing at `sceneId`, named the way a refusal has to name it. */
function referrers(state: ScriptState, sceneId: string): string[] {
  const out: string[] = [];
  for (const scene of state.scenes.values()) {
    if (scene.id === sceneId) continue;
    if (scene.next === sceneId) out.push(`${scene.id} (next)`);
    scene.choices.forEach((choice, i) => {
      if (choice.goto === sceneId) out.push(`${scene.id} (choice ${i}: "${choice.label}")`);
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The five line edits. Each is one line of one scene; ids elsewhere never move.
// ---------------------------------------------------------------------------

/** Replace one line's text. The id survives, so coverage does; the art it made now drifts. */
export function setLineText(state: ScriptState, args: { line: string; text: string }): LineOp {
  const found = locate(state, args.line);
  if (typeof found === 'string') return refuse(found);

  const text = args.text.trim();
  if (!text) return refuse('A line cannot be empty — delete it instead.');

  const { scene, index } = found;
  const before = scene.lines[index] as SceneLine;
  const lines = scene.lines.map((l, i) => (i === index ? { ...l, text } : l));
  return done(`${args.line} retyped.`, {
    writes: [withLines(scene, lines, nextIdOf(scene))],
    retyped: before.text === text ? [] : [args.line],
  });
}

/**
 * Add a line after `after`, or at the top of the scene when it is empty. The new line takes the
 * next id from the scene's allocator, which is why inserting leaves every other line's id — and
 * therefore every shot's coverage — exactly where it was.
 */
export function insertLine(
  state: ScriptState,
  args: { scene: string; after: string; kind: SceneLine['kind']; speaker: string; text: string },
): LineOp {
  const scene = state.scenes.get(args.scene);
  if (!scene) return refuse(`No scene "${args.scene}".`);

  const text = args.text.trim();
  if (!text) return refuse('A line needs some text.');

  const speaker = args.speaker.trim();
  const attributed = args.kind === 'dialogue' || args.kind === 'parenthetical';
  if (attributed && !speaker) return refuse(`A ${args.kind} line needs a speaker.`);
  if (!attributed && speaker) return refuse(`A ${args.kind} line is not spoken by anyone.`);

  let at = 0;
  if (args.after) {
    const position = positionIn(scene, args.after);
    if (typeof position === 'string') return refuse(position);
    at = position + 1;
  }

  const next = nextIdOf(scene);
  const line: SceneLine = {
    id: `${scene.id}:L${next}`,
    kind: args.kind,
    ...(speaker ? { speaker } : {}),
    text,
  };
  const lines = [...scene.lines.slice(0, at), line, ...scene.lines.slice(at)];
  const where = args.after ? `after ${args.after}` : `at the top of ${scene.id}`;
  return done(`Inserted ${line.id} (${args.kind}) ${where}.`, {
    writes: [withLines(scene, lines, next + 1)],
  });
}

/**
 * Remove a line. Its id is retired and never handed out again, so a shot that covered it
 * covers one line fewer — possibly none, which is a state the timeline shows rather than an
 * error. An empty scene is legitimate: the chunk stays, with no lines in it.
 */
export function deleteLine(state: ScriptState, args: { line: string }): LineOp {
  const found = locate(state, args.line);
  if (typeof found === 'string') return refuse(found);

  const { scene, index } = found;
  const lines = scene.lines.filter((_, i) => i !== index);
  return done(`Deleted ${args.line}; ${lines.length} line(s) left in ${scene.id}.`, {
    writes: [withLines(scene, lines, nextIdOf(scene))],
    retired: [args.line],
  });
}

/**
 * Reorder within a scene. Ids do not change, so nothing detaches — but a shot's covered prose is
 * read in scene order, so moving a covered line still changes what its art was made to depict.
 */
export function moveLine(state: ScriptState, args: { line: string; after: string }): LineOp {
  const found = locate(state, args.line);
  if (typeof found === 'string') return refuse(found);
  if (args.after === args.line) return refuse('A line cannot be moved after itself.');

  const { scene, index } = found;
  const rest = scene.lines.filter((_, i) => i !== index);
  let at = 0;
  if (args.after) {
    const position = positionIn(scene, args.after);
    if (typeof position === 'string') return refuse(position);
    at = rest.findIndex((l) => l.id === args.after) + 1;
  }

  const lines = [...rest.slice(0, at), scene.lines[index] as SceneLine, ...rest.slice(at)];
  const where = args.after ? `after ${args.after}` : 'to the top';
  return done(`Moved ${args.line} ${where} in ${scene.id}.`, {
    writes: [withLines(scene, lines, nextIdOf(scene))],
    retyped: [args.line],
  });
}

/**
 * Whether attribution means anything for a line of this kind — the kinds {@link setSpeaker} will
 * act on. Exported because a surface offering the edit has to decide *which rows get the
 * affordance* synchronously, and an affordance that can only be refused is worse than none.
 */
export function isSpeakable(kind: SceneLine['kind']): boolean {
  return kind === 'dialogue' || kind === 'parenthetical' || kind === 'narration';
}

/**
 * Change or clear who speaks a line — and with it the line's kind, since attribution is what
 * separates dialogue from narration. A transition, lyric or centered line is refused: there is
 * nobody for it to be spoken by, and `sceneToFountain` has no cue to write it under.
 */
export function setSpeaker(state: ScriptState, args: { line: string; speaker: string }): LineOp {
  const found = locate(state, args.line);
  if (typeof found === 'string') return refuse(found);

  const { scene, index } = found;
  const before = scene.lines[index] as SceneLine;
  if (!isSpeakable(before.kind)) {
    return refuse(`A ${before.kind} line is not spoken by anyone.`);
  }

  const speaker = args.speaker.trim();
  if (!speaker && before.speaker === undefined) {
    return refuse(`${args.line} has no speaker to clear.`);
  }

  // Clearing attribution makes the line narration; giving a narration line a speaker makes it
  // dialogue. A parenthetical stays one — it is a delivery note either way.
  const line: SceneLine = speaker
    ? { ...before, kind: before.kind === 'parenthetical' ? 'parenthetical' : 'dialogue', speaker }
    : { id: before.id, kind: 'narration', text: before.text };
  const lines = scene.lines.map((l, i) => (i === index ? line : l));
  return done(
    speaker ? `${args.line} is spoken by ${speaker}.` : `${args.line} is now narration.`,
    {
      writes: [withLines(scene, lines, nextIdOf(scene))],
      retyped: [args.line],
    },
  );
}

// ---------------------------------------------------------------------------
// The four scene edits. These are where line ids can change scope, so these are where
// the coverage consequence has to be stated before the author commits.
// ---------------------------------------------------------------------------

/**
 * Create an empty chunk. It is deliberately not wired to anything: a new scene is unreachable
 * until something points at it, and inventing an edge is `story.setNext`'s job, not this one's.
 */
export function newScene(state: ScriptState, args: { scene: string; heading: string }): LineOp {
  const id = args.scene.trim();
  if (!id) return refuse('A scene needs an id.');
  if (id !== slug(id)) return refuse(`Scene ids are slugs — "${id}" would be "${slug(id)}".`);
  if (state.scenes.has(id)) return refuse(`Scene "${id}" already exists.`);

  const heading = args.heading.trim();
  if (!heading) return refuse('A scene needs a heading, e.g. INT. CLASSROOM - EVENING.');
  const mined = parseHeading(heading);
  if (!mined.id) return refuse(`"${heading}" names no location.`);

  const prefix = headingPrefixOf(heading);
  const scene: Scene = {
    id,
    location: mined.id,
    locationVariant: mined.variant,
    ...(prefix ? { headingPrefix: prefix } : {}),
    characters: [],
    lines: [],
    nextLineId: 1,
    choices: [],
    shots: [],
  };
  return done(`Created ${id} (${mined.id}/${mined.variant}); nothing points at it yet.`, {
    writes: [scene],
  });
}

/**
 * Remove a chunk, refusing while anything still points at it. That is the same failure as a
 * `dangling_goto` diagnostic, and it is better to refuse than to let a delete manufacture one.
 */
export function deleteScene(state: ScriptState, args: { scene: string }): LineOp {
  const scene = state.scenes.get(args.scene);
  if (!scene) return refuse(`No scene "${args.scene}".`);
  if (state.entry === scene.id) {
    return refuse(`${scene.id} is the entry scene — point start: in project.yaml elsewhere first.`);
  }

  const pointing = referrers(state, scene.id);
  if (pointing.length > 0) {
    return refuse(`${pointing.join(', ')} still point(s) at ${scene.id}.`);
  }
  return done(`Deleted ${scene.id} and its ${scene.lines.length} line(s).`, {
    removes: [scene.id],
    retired: scene.lines.map((l) => l.id),
  });
}

/**
 * One scene becomes two at a line boundary: `at` and everything below it move into a new chunk,
 * and the original continues to it. The branch out of the scene belongs to the *tail* — it is
 * where the scene now ends — so `choices` and `next` go with the new half.
 *
 * Line ids keep their local part (`arrival:L7` → `rooftop:L7`), which is what lets a shot follow
 * its lines across the split. It is also why the new scene inherits the original's allocator
 * rather than starting from 1: two halves must never hand out the same local id.
 */
export function splitScene(
  state: ScriptState,
  args: { scene: string; at: string; into: string },
): LineOp {
  const scene = state.scenes.get(args.scene);
  if (!scene) return refuse(`No scene "${args.scene}".`);

  const into = args.into.trim();
  if (!into) return refuse('The new half needs an id.');
  if (into !== slug(into))
    return refuse(`Scene ids are slugs — "${into}" would be "${slug(into)}".`);
  if (state.scenes.has(into)) return refuse(`Scene "${into}" already exists.`);

  const position = positionIn(scene, args.at);
  if (typeof position === 'string') return refuse(position);
  if (position === 0) {
    return refuse(`${args.at} is the first line of ${scene.id}; the split would leave it empty.`);
  }

  const next = nextIdOf(scene);
  const tailLines = scene.lines
    .slice(position)
    .map((l) => ({ ...l, id: `${into}:${localOf(l.id)}` }));
  const moved: [string, string][] = scene.lines
    .slice(position)
    .map((l, i) => [l.id, (tailLines[i] as SceneLine).id]);
  const tail: Scene = {
    id: into,
    location: scene.location,
    ...(scene.locationVariant !== undefined ? { locationVariant: scene.locationVariant } : {}),
    ...(scene.headingPrefix !== undefined ? { headingPrefix: scene.headingPrefix } : {}),
    characters: [],
    lines: tailLines,
    nextLineId: next,
    choices: scene.choices.map((c) => ({ ...c })),
    ...(scene.next !== undefined ? { next: scene.next } : {}),
    shots: [],
  };
  const head: Scene = {
    ...scene,
    lines: scene.lines.slice(0, position),
    nextLineId: next,
    choices: [],
    next: into,
  };
  return done(
    `Split ${scene.id} at ${args.at}: ${tail.lines.length} line(s) moved into ${into}, which ` +
      `${scene.id} now continues to.`,
    { writes: [head, tail], moved },
  );
}

/**
 * Two scenes become one: `scene`'s lines are appended to the scene that continues to it, and its
 * chunk is removed. Only a linear continuation is joinable — merging across a choice would
 * silently drop the decision — and only when nothing else points at the scene being absorbed.
 *
 * The absorbed lines are renumbered into the surviving scene's allocator — `arrival:L1` cannot
 * stay itself inside `rooftop` — but the renumbering is a *mapping*, so it comes back as `moved`
 * and coverage can follow it, exactly as it does across a split.
 */
export function mergeScene(state: ScriptState, args: { scene: string; into: string }): LineOp {
  const scene = state.scenes.get(args.scene);
  if (!scene) return refuse(`No scene "${args.scene}".`);
  const into = state.scenes.get(args.into);
  if (!into) return refuse(`No scene "${args.into}".`);
  if (scene.id === into.id) return refuse(`${scene.id} cannot be merged into itself.`);
  if (state.entry === scene.id) {
    return refuse(`${scene.id} is the entry scene — point start: in project.yaml elsewhere first.`);
  }

  if (into.choices.length > 0) {
    return refuse(
      `${into.id} forks into ${into.choices.length} choice(s), so it does not continue to ` +
        `${scene.id} — there is no boundary to remove.`,
    );
  }
  if (into.next !== scene.id) {
    return refuse(`${into.id} does not continue to ${scene.id}; a merge only removes a boundary.`);
  }
  const pointing = referrers(state, scene.id).filter((r) => !r.startsWith(`${into.id} `));
  if (pointing.length > 0) {
    return refuse(`${pointing.join(', ')} also point(s) at ${scene.id}.`);
  }

  let next = nextIdOf(into);
  const absorbed = scene.lines.map((l) => ({ ...l, id: `${into.id}:L${next++}` }));
  const moved: [string, string][] = scene.lines.map((l, i) => [
    l.id,
    (absorbed[i] as SceneLine).id,
  ]);
  const merged: Scene = {
    ...unwired(into),
    lines: [...into.lines, ...absorbed],
    nextLineId: next,
    choices: scene.choices.map((c) => ({ ...c })),
    ...(scene.next !== undefined ? { next: scene.next } : {}),
  };
  return done(`Merged ${scene.id} into ${into.id}: ${absorbed.length} line(s) appended.`, {
    writes: [merged],
    removes: [scene.id],
    moved,
  });
}

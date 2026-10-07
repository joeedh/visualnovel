/**
 * The rules behind `character.delete` and `location.delete`: what deleting an entity does to every
 * document that names it. A delete rewrites those references rather than refusing on them, and it
 * lists for the author what it cannot rewrite safely (prose that mentions the entity by name).
 *
 * Its functions are pure, like those in `lineops`. The write side (`entityplan.ts`) reads the
 * storyboards, the wiki pages and the manifest, hands them in as an {@link EntityWorld}, proves the
 * result and writes it. Two parts stay with the host because this package cannot reach them: the
 * price of the changed shots (`priceShotChanges` in `@vn/artgen`) and the files to remove, which
 * come from where the sheet was found.
 */
import {
  cueResolver,
  variantEntries,
  wardrobeEntries,
  type CharacterEdit,
  type LocationEdit,
} from '@vn/model';
import type {
  ChunkRef,
  Character,
  Location,
  PromptOverride,
  Scene,
  SceneLine,
  Shot,
} from '@vn/types';
import { nextIdOf, type AppliedLineOp, type ScriptState } from './lineops.js';
import { dropPins } from './pins.js';
import { shotFallout, type ShotsByScene } from './shotfallout.js';

/** Everything an entity delete is decided against. */
export interface EntityWorld {
  state: ScriptState;
  /** Every scene's storyboard, read unfiltered. */
  shots: ShotsByScene;
  characters: ReadonlyMap<string, Character>;
  locations: ReadonlyMap<string, Location>;
  /** Hashes of every manifest row bound to the entity being deleted: its takes. */
  takes: ReadonlySet<string>;
  /** The wiki's pages, workspace-relative and without the deleted sheet, searched for mentions. */
  pages: readonly { path: string; text: string }[];
}

/** What happens to the lines a deleted character speaks. */
export type CharacterLines = 'narrate' | 'delete' | 'merge';

/** The values {@link CharacterLines} takes, for a command's enum prop. */
export const CHARACTER_LINES: readonly CharacterLines[] = ['narrate', 'delete', 'merge'];

/** A surviving sheet whose overrides lose pins. */
export type SheetEdit =
  | { kind: 'character'; id: string; edit: CharacterEdit }
  | { kind: 'location'; id: string; edit: LocationEdit };

/** A shot whose task inputs change: the shot as it will be, and its scene's new location if moved. */
export interface ChangedShot {
  sceneId: string;
  shot: Shot;
  location?: string;
}

/** Prose that names the deleted entity, which a delete lists and never rewrites. */
export interface Mention {
  kind: 'scene' | 'page';
  /** A scene id or a workspace-relative page path. */
  where: string;
  count: number;
}

/** What deleting one entity does, or why it will not happen. */
export type EntityOp =
  | {
      ok: true;
      kind: 'character' | 'location';
      id: string;
      /** One sentence per consequence, in the order the check lists them. */
      notes: string[];
      /** The scene rewrites, shaped as a prose edit so they are proved the same way. */
      op: AppliedLineOp;
      /** Storyboards to write whole, and storyboards whose last shot went. */
      shots: { writes: Map<string, Shot[]>; removes: string[] };
      sheets: SheetEdit[];
      changed: ChangedShot[];
      mentions: Mention[];
    }
  | { ok: false; error: string };

const refuse = (error: string): EntityOp => ({ ok: false, error });

/** Builds an applied line op holding only the parts an entity delete uses. */
function lineOp(change: Partial<Omit<AppliedLineOp, 'ok' | 'message'>>): AppliedLineOp {
  return {
    ok       : true,
    message  : '',
    writes   : [],
    removes  : [],
    retired  : [],
    moved    : [],
    retyped  : [],
    relocated: [],
    ...change,
  };
}

/** Formats `n thing(s)` with the plural spelled out. */
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Lists up to five names, then says how many more there are. */
function named(names: readonly string[]): string {
  if (names.length <= 5) return names.join(', ');
  return `${names.slice(0, 5).join(', ')} and ${names.length - 5} more`;
}

/**
 * Answers every storyboard as the prose half of a delete leaves it, with each shot passed through
 * `edit`. The prose edit's shot fallout is applied first, so `edit` sees each shot where the
 * fallout leaves it.
 */
function editBoards(
  world: EntityWorld,
  op: AppliedLineOp,
  edit: (shot: Shot, sceneId: string) => Shot,
): { writes: Map<string, Shot[]>; removes: string[]; note: string; restaged: string[] } {
  const fallout = shotFallout(op, world.shots);
  const writes = new Map<string, Shot[]>();
  for (const [sceneId, before] of world.shots) {
    if (fallout.removes.includes(sceneId)) continue;
    const board = fallout.writes.get(sceneId) ?? before;
    const after = board.map((shot) => edit(shot, sceneId));
    const touched = after.some((shot, i) => shot !== board[i]);
    if (touched || fallout.writes.has(sceneId)) writes.set(sceneId, [...after]);
  }
  return { writes, removes: fallout.removes, note: fallout.note, restaged: fallout.restaged };
}

/** A pin filter that counts every pin it drops across the overrides it is given. */
interface PinPass {
  dropped: number;
  drop(override: PromptOverride | undefined): PromptOverride | undefined;
}

function pinPass(drops: (ref: ChunkRef) => boolean): PinPass {
  const pass: PinPass = {
    dropped: 0,
    drop(override) {
      const result = dropPins(override, drops);
      pass.dropped += result.dropped;
      return result.override;
    },
  };
  return pass;
}

/** Copies a shot with `override` in place of its own, removing the key when there is none. */
function withOverride(shot: Shot, override: PromptOverride | undefined): Shot {
  const { promptOverride: _old, ...rest } = shot;
  return override ? { ...rest, promptOverride: override } : rest;
}

/**
 * Builds the sheet edits that drop pins from every surviving character and location. The entity
 * being deleted is skipped, since its sheet is removed whole.
 */
function sheetPins(world: EntityWorld, skip: string, pins: PinPass): SheetEdit[] {
  const edits: SheetEdit[] = [];
  for (const character of world.characters.values()) {
    if (character.id === skip) continue;
    const before = pins.dropped;
    const portrait = pins.drop(character.promptOverride);
    const portraitChanged = pins.dropped !== before;
    const outfits = character.outfits.map((outfit) => {
      const was = pins.dropped;
      const override = pins.drop(outfit.promptOverride);
      if (pins.dropped === was) return outfit;
      const next = { ...outfit };
      if (override) next.promptOverride = override;
      else delete next.promptOverride;
      return next;
    });
    const outfitsChanged = outfits.some((o, i) => o !== character.outfits[i]);
    if (!portraitChanged && !outfitsChanged) continue;
    const edit: CharacterEdit = {};
    // An empty override has to be stated to be cleared; `undefined` means "leave it"
    if (portraitChanged) edit.promptOverride = portrait ?? { mode: 'chunks' };
    if (outfitsChanged) edit.outfits = wardrobeEntries(outfits);
    edits.push({ kind: 'character', id: character.id, edit });
  }
  for (const location of world.locations.values()) {
    if (location.id === skip || location.mined) continue;
    const variants = location.variants.map((variant) => {
      const was = pins.dropped;
      const override = pins.drop(variant.promptOverride);
      if (pins.dropped === was) return variant;
      const next = { ...variant };
      if (override) next.promptOverride = override;
      else delete next.promptOverride;
      return next;
    });
    if (variants.every((v, i) => v === location.variants[i])) continue;
    edits.push({ kind: 'location', id: location.id, edit: { variants: variantEntries(variants) } });
  }
  return edits;
}

/** Escapes a string for use inside a regular expression. */
const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Finds where the scenes (as they will be written) and the wiki pages name the entity by any of
 * `names`, as a whole word and in any case.
 */
function mentionsOf(
  world: EntityWorld,
  scenes: ReadonlyMap<string, Scene>,
  names: readonly string[],
): Mention[] {
  const alternatives = [...new Set(names.filter(Boolean))].map(escaped).join('|');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives})(?![\\p{L}\\p{N}_])`, 'giu');
  const hits = (text: string): number => text.match(pattern)?.length ?? 0;
  const out: Mention[] = [];
  for (const scene of scenes.values()) {
    const n = scene.lines.reduce((sum, line) => sum + hits(line.text), 0);
    if (n > 0) out.push({ kind: 'scene', where: scene.id, count: n });
  }
  for (const page of world.pages) {
    const n = hits(page.text);
    if (n > 0) out.push({ kind: 'page', where: page.path, count: n });
  }
  return out;
}

/** Answers the scenes as a delete leaves them, with the op's rewrites laid over the state. */
function scenesAfter(state: ScriptState, op: AppliedLineOp): Map<string, Scene> {
  const scenes = new Map(state.scenes);
  for (const scene of op.writes) scenes.set(scene.id, scene);
  return scenes;
}

/**
 * Builds a cue for `target` that resolves back to it, carrying the extension (`(V.O.)`) of the
 * cue it replaces.
 */
function cueFor(
  target: Character,
  resolve: (cue: string) => string | undefined,
  replacing: string,
): string {
  const extension = /\s*\([^)]*\)\s*$/.exec(replacing)?.[0] ?? '';
  const byName = target.name.toUpperCase();
  const base = resolve(byName) === target.id ? byName : target.id.toUpperCase();
  return `${base}${extension}`;
}

/**
 * Deletes a character from the story. Every line it speaks becomes narration, is deleted, or is
 * given to `mergeInto`; every `[[outfit:]]` marker naming it is cleared; it leaves every shot it
 * is in, taking its outfit override and its panels with it, and a shot left with nobody becomes a
 * background plate; and every pin on its portrait or sheets, or on any of its takes, is dropped
 * from every override. A parenthetical it speaks is treated as `story.setSpeaker` treats one.
 */
export function deleteCharacter(
  world: EntityWorld,
  args: { id: string; lines: CharacterLines; mergeInto?: string },
): EntityOp {
  const character = world.characters.get(args.id);
  if (!character) return refuse(`No character "${args.id}".`);
  let heir: Character | undefined;
  if (args.lines === 'merge') {
    const into = (args.mergeInto ?? '').trim();
    if (!into)
      return refuse(`Choose mergeInto, the character who takes over ${character.id}'s lines.`);
    if (into === character.id) return refuse(`${character.id} cannot take over its own lines.`);
    heir = world.characters.get(into);
    if (!heir) return refuse(`No character "${into}" to take over ${character.id}'s lines.`);
  }

  const resolve = cueResolver(world.characters);
  const speaks = (cue: string | undefined): boolean =>
    cue !== undefined && resolve(cue) === character.id;
  const writes: Scene[] = [];
  const retired: string[] = [];
  const retyped: string[] = [];
  const spokenIn = new Set<string>();
  let markers = 0;
  for (const scene of world.state.scenes.values()) {
    const lines: SceneLine[] = [];
    for (const line of scene.lines) {
      if (!speaks(line.speaker)) {
        lines.push(line);
        continue;
      }
      spokenIn.add(scene.id);
      if (args.lines === 'delete') {
        retired.push(line.id);
      } else if (heir) {
        retyped.push(line.id);
        lines.push({ ...line, speaker: cueFor(heir, resolve, line.speaker!) });
      } else {
        retyped.push(line.id);
        lines.push({ id: line.id, kind: 'narration', text: line.text });
      }
    }
    const outfits = { ...scene.outfits };
    for (const key of Object.keys(outfits)) {
      if (key !== character.id && resolve(key) !== character.id) continue;
      delete outfits[key];
      markers++;
    }
    const outfitsChanged = Object.keys(outfits).length !== Object.keys(scene.outfits ?? {}).length;
    if (
      lines.length === scene.lines.length &&
      lines.every((l, i) => l === scene.lines[i]) &&
      !outfitsChanged
    ) {
      continue;
    }
    const written: Scene = { ...scene, lines, nextLineId: nextIdOf(scene) };
    if (outfitsChanged) {
      if (Object.keys(outfits).length > 0) written.outfits = outfits;
      else delete written.outfits;
    }
    writes.push(written);
  }
  const op = lineOp({ writes, retired, retyped });

  const pins = pinPass(
    (ref) =>
      world.takes.has(ref.pin) ||
      ((ref.from?.kind === 'portrait' || ref.from?.kind === 'sheet') &&
        ref.from.characterId === character.id),
  );
  const changed: ChangedShot[] = [];
  let left = 0;
  let plates = 0;
  const boards = editBoards(world, op, (shot, sceneId) => {
    let next = shot;
    if (shot.subjects.some((s) => s.characterId === character.id)) {
      const subjects = shot.subjects.filter((s) => s.characterId !== character.id);
      const panels = shot.panels?.map((p) => ({
        ...p,
        subjects: p.subjects.filter((s) => s.characterId !== character.id),
      }));
      next = { ...shot, subjects, ...(panels ? { panels } : {}) };
      if (subjects.length === 0) {
        delete next.castOptional;
        plates++;
      }
      left++;
    }
    const was = pins.dropped;
    const override = pins.drop(shot.promptOverride);
    if (pins.dropped !== was) next = withOverride(next, override);
    if (next !== shot) changed.push({ sceneId, shot: next });
    return next;
  });
  const sheets = sheetPins(world, character.id, pins);

  const notes: string[] = [];
  const spoken = count(retired.length + retyped.length, 'line');
  const where = count(spokenIn.size, 'scene');
  if (spokenIn.size > 0) {
    notes.push(
      args.lines === 'delete'
        ? `Deletes the ${spoken} ${character.id} speaks in ${where}.`
        : heir
          ? `Gives the ${spoken} ${character.id} speaks in ${where} to ${heir.id}.`
          : `Turns the ${spoken} ${character.id} speaks in ${where} into narration.`,
    );
  }
  if (markers > 0) notes.push(`Clears ${count(markers, 'outfit marker')} naming ${character.id}.`);
  if (left > 0) {
    const plate =
      plates > 0 ? `; ${count(plates, 'shot is', 'shots are')} left as a background plate` : '';
    notes.push(`Takes ${character.id} out of ${count(left, 'shot')}${plate}.`);
  }
  if (pins.dropped > 0) {
    notes.push(
      `Drops ${count(pins.dropped, 'reference image')} of ${character.id} from other prompts.`,
    );
  }
  if (boards.note) notes.push(boards.note);

  return {
    ok  : true,
    kind: 'character',
    id  : character.id,
    notes,
    op,
    shots: { writes: boards.writes, removes: boards.removes },
    sheets,
    changed,
    mentions: mentionsOf(world, scenesAfter(world.state, op), [character.name, character.id]),
  };
}

/**
 * Deletes a location. Refused without `replaceWith` while any scene is set there; with it, each
 * such scene's heading names `replaceWith` instead, keeping its INT./EXT. and its time of day, and
 * its shots are restaged to that time of day. Every pin on one of the location's plates, or on any
 * of its takes, is dropped from every override.
 */
export function deleteLocation(
  world: EntityWorld,
  args: { id: string; replaceWith?: string },
): EntityOp {
  const location = world.locations.get(args.id);
  if (!location) return refuse(`No location "${args.id}".`);
  const at = [...world.state.scenes.values()].filter((s) => s.location === location.id);
  const into = (args.replaceWith ?? '').trim();
  if (at.length > 0 && !into) {
    return refuse(
      `${count(at.length, 'scene is', 'scenes are')} set at ${location.id} (${named(at.map((s) => s.id))}). ` +
        'Choose replaceWith, the location to set them in instead.',
    );
  }
  if (into === location.id) return refuse(`${location.id} cannot replace itself.`);
  const heir = into ? world.locations.get(into) : undefined;
  if (into && !heir) return refuse(`No location "${into}" to set those scenes in.`);

  const writes = at.map((scene): Scene => ({ ...scene, location: into }));
  const relocated = at.map((scene): [string, string] => [scene.id, scene.locationVariant ?? 'day']);
  const op = lineOp({ writes, relocated });
  const moved = new Set(at.map((s) => s.id));

  const pins = pinPass(
    (ref) =>
      world.takes.has(ref.pin) ||
      (ref.from?.kind === 'plate' && ref.from.locationId === location.id),
  );
  const changed: ChangedShot[] = [];
  const boards = editBoards(world, op, (shot, sceneId) => {
    const was = pins.dropped;
    const override = pins.drop(shot.promptOverride);
    const next = pins.dropped !== was ? withOverride(shot, override) : shot;
    // Every shot in a moved scene changes inputs, restaged or not, because the scene's plate is
    // the first of its refs
    if (moved.has(sceneId)) changed.push({ sceneId, shot: next, location: into });
    else if (next !== shot) changed.push({ sceneId, shot: next });
    return next;
  });
  const sheets = sheetPins(world, location.id, pins);

  const notes: string[] = [];
  if (at.length > 0) {
    notes.push(
      `Sets ${count(at.length, 'scene')} in ${into} instead (${named(at.map((s) => s.id))}), ` +
        'keeping each heading’s INT./EXT. and time of day.',
    );
  }
  if (pins.dropped > 0) {
    notes.push(
      `Drops ${count(pins.dropped, 'reference image')} of ${location.id} from other prompts.`,
    );
  }
  if (boards.note) notes.push(boards.note);

  return {
    ok  : true,
    kind: 'location',
    id  : location.id,
    notes,
    op,
    shots: { writes: boards.writes, removes: boards.removes },
    sheets,
    changed,
    mentions: mentionsOf(world, scenesAfter(world.state, op), [location.name, location.id]),
  };
}

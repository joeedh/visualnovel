/**
 * Writing an art rung — notes or seed: the refusals, and the two files either can land in.
 *
 * The rung vocabulary is `artnotes.ts`; this is the half that touches disk. An entity rung goes
 * through `@vn/model`'s `apply*Edit` into the sheet the model was built from — the same path
 * `edit_character` takes, so one authorial act has one answer — and a shot rung goes into
 * `work/shots/<sceneId>.json`, one of the handful of writers that file has.
 *
 * Two layers, as everywhere else here: {@link artNotesOf} decides and {@link setArtNotes} re-asks
 * before writing, so an act never trusts that a check ran.
 */
import type { LocationVariant, Outfit, ProjectModel, Shot } from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import {
  applyCharacterEdit,
  applyLocationEdit,
  docToMarkdown,
  modelFromInputs,
  variantEntries,
  wardrobeEntries,
  type CharacterEdit,
  type LocationEdit,
} from '@vn/model';
import type { EntityDoc } from '@vn/parse';
import { entityDoc, loadInputs, readShots, writeShots, type ProjectPaths } from '@vn/store';
import { VnError, writeFileAtomic } from '@vn/util';
import { parseArtTarget, rungAt, type ArtRung, type ArtTarget } from './artnotes.js';
import type { Decided } from './slotgraph.js';

export interface SetNotesDeps {
  /**
   * Only what the model is built with. An agent may hold a project whose `project.yaml` will not
   * load, and neither field reaches a prompt — a full `ProjectConfig` satisfies this.
   */
  config: Pick<ProjectConfig, 'title' | 'start'>;
  paths: ProjectPaths;
}

/** How the new text meets what the rung already says. */
export type NotesMode = 'replace' | 'append' | 'clear';

export interface SetNotesRequest {
  /** A rung, in `artnotes.ts`'s vocabulary: `character:aiko/gala`, `shot:greet/s2`, … */
  target: string;
  /** The text. Ignored by `clear`, and blank text in `replace` clears the rung. */
  notes: string;
  /** Default `replace` — what `art.setNotes` has always done. */
  mode?: NotesMode;
}

/** What writing a rung would do, once the model and the storyboard have been asked. */
export interface SetNotesPlan {
  target: ArtTarget;
  /** The rung as it stands, before the write. */
  rung: ArtRung;
  /** The text that will be authored there, after `mode` is applied. Blank removes the note. */
  notes: string;
  /** The file the write lands in — a sheet, or a scene's storyboard. */
  file: string;
  /** The sentence a surface shows before committing to it. */
  note: string;
}

/**
 * Every refusal writing a rung can give. Never creates an outfit, a variant or a shot — a note on
 * something that does not exist is a typo, and inventing the thing would hide it.
 */
export async function artNotesOf(
  deps: SetNotesDeps,
  req: SetNotesRequest,
): Promise<Decided<SetNotesPlan>> {
  const located = await locateRung(deps, req.target);
  if (!located.ok) return located;
  const { target, rung, file } = located.plan;

  const notes = resolveNotes(rung.notes, req);
  const said = noteSentence(req.mode ?? 'replace', notes, rung.label);
  return { ok: true, plan: { target, rung, notes, file, note: said } };
}

/** A rung found on disk: what it says today, and the file that says it. */
interface LocatedRung {
  target: ArtTarget;
  rung: ArtRung;
  /** The file the write lands in — a sheet, or a scene's storyboard. */
  file: string;
  model: ProjectModel;
  docs: EntityDoc[];
}

/**
 * Every refusal a rung write can give before the field being written matters: the target is not a
 * rung, the thing it names does not exist, or the sheet is not on disk. One place, because notes
 * and seeds are the same five rungs and a second copy would drift into two vocabularies.
 */
async function locateRung(deps: SetNotesDeps, address: string): Promise<Decided<LocatedRung>> {
  const parsed = parseArtTarget(address);
  if (!parsed) {
    return {
      ok: false,
      code: 'BAD_TARGET',
      reason: `"${address}" names no art-notes rung; expected character:<id>[/<outfit>], location:<id>[/<variant>] or shot:<sceneId>/<shotId>.`,
    };
  }
  const { model, docs } = await loadFor(deps, parsed);
  const shots = new Map<string, readonly Shot[]>();
  if (parsed.kind === 'shot') {
    const scene = model.scenes.get(parsed.sceneId);
    if (scene) {
      const loaded = await readShots(
        deps.paths,
        scene.id,
        new Set(scene.lines.map((l) => l.id)),
      ).catch(() => undefined);
      if (loaded) shots.set(scene.id, loaded.shots);
    }
  }
  const rung = rungAt(parsed, { model, shots });
  // The rung vocabulary is named for the field that came first; a seed rides the same five rungs,
  // and one wording for the refusal is what keeps both hosts saying the same sentence.
  if (!rung)
    return { ok: false, code: 'NO_SUCH_RUNG', reason: `No such art-notes rung: ${address}.` };

  if (parsed.kind === 'shot') {
    const file = deps.paths.shotsFile(parsed.sceneId);
    return { ok: true, plan: { target: parsed, rung, file, model, docs } };
  }
  const found = entityDoc(docs, parsed.id);
  if (!found) {
    return {
      ok: false,
      code: 'NO_SHEET',
      reason: `No sheet on disk for ${parsed.kind} "${parsed.id}".`,
    };
  }
  return { ok: true, plan: { target: parsed, rung, file: found.file, model, docs } };
}

/**
 * Write one rung, and answer with the plan that was carried out. Re-decides against a fresh load
 * rather than taking a plan in: the sheet may have moved since a surface last asked.
 */
export async function setArtNotes(deps: SetNotesDeps, req: SetNotesRequest): Promise<SetNotesPlan> {
  const decided = await artNotesOf(deps, req);
  if (!decided.ok) throw new VnError(decided.code, decided.reason);
  const { plan } = decided;
  const target = plan.target;

  if (target.kind === 'shot') {
    const { model } = await loadFor(deps, target);
    const scene = model.scenes.get(target.sceneId);
    if (!scene) throw new VnError('NO_SCENE', `No scene "${target.sceneId}".`);
    const loaded = await readShots(deps.paths, scene.id, new Set(scene.lines.map((l) => l.id)));
    if (!loaded)
      throw new VnError('NO_SHOTS', `Scene "${scene.id}" has no storyboard to write to.`);
    const next = loaded.shots.map((s) =>
      s.id === target.shotId ? withArtNotes(s, plan.notes) : s,
    );
    await writeShots(deps.paths, scene.id, next);
    return plan;
  }

  const { model, docs } = await loadFor(deps, target);
  const found = entityDoc(docs, target.id);
  if (!found) {
    throw new VnError('NO_SHEET', `No sheet on disk for ${target.kind} "${target.id}".`);
  }
  const edited =
    target.kind === 'character'
      ? applyCharacterEdit(
          found.doc,
          characterNotesEdit(model.characters.get(target.id)?.outfits ?? [], target, plan.notes),
        )
      : applyLocationEdit(
          found.doc,
          locationNotesEdit(model.locations.get(target.id)?.variants ?? [], target, plan.notes),
        );
  if (!edited.ok) throw new VnError('EDIT_REJECTED', `Edit rejected: ${edited.diagnostic.message}`);
  await writeFileAtomic(found.file, docToMarkdown(edited.value.doc));
  return plan;
}

export interface SetSeedRequest {
  /** A rung, in the same vocabulary {@link SetNotesRequest.target} uses. */
  target: string;
  /** The seed to author, or `null` to clear the rung back to whatever it inherits. */
  seed: number | null;
}

/** What writing a seed would do. The mirror of {@link SetNotesPlan}, one field over. */
export interface SetSeedPlan {
  target: ArtTarget;
  /** The rung as it stands, before the write. */
  rung: ArtRung;
  /** The seed that will be authored there; `null` removes it. */
  seed: number | null;
  file: string;
  note: string;
}

/**
 * Every refusal writing a seed can give. The rung refusals are {@link locateRung}'s; the one this
 * adds is the value — an image backend takes a whole non-negative number, and rounding a typo
 * would quietly draw a different picture than the one written down.
 */
export async function artSeedOf(
  deps: SetNotesDeps,
  req: SetSeedRequest,
): Promise<Decided<SetSeedPlan>> {
  if (req.seed !== null && (!Number.isInteger(req.seed) || req.seed < 0)) {
    return {
      ok: false,
      code: 'BAD_SEED',
      reason: `"${req.seed}" is not a seed; expected a whole number of 0 or more.`,
    };
  }
  const located = await locateRung(deps, req.target);
  if (!located.ok) return located;
  const { target, rung, file } = located.plan;
  const note =
    req.seed === null
      ? `Cleared the seed on ${rung.label}.`
      : `Set ${rung.label} to seed ${req.seed}.`;
  return { ok: true, plan: { target, rung, seed: req.seed, file, note } };
}

/**
 * Write one rung's seed, and answer with the plan that was carried out. Re-decides against a fresh
 * load for the same reason {@link setArtNotes} does.
 */
export async function setArtSeed(deps: SetNotesDeps, req: SetSeedRequest): Promise<SetSeedPlan> {
  const decided = await artSeedOf(deps, req);
  if (!decided.ok) throw new VnError(decided.code, decided.reason);
  const { plan } = decided;
  const target = plan.target;
  const seed = plan.seed ?? undefined;

  if (target.kind === 'shot') {
    const { model } = await loadFor(deps, target);
    const scene = model.scenes.get(target.sceneId);
    if (!scene) throw new VnError('NO_SCENE', `No scene "${target.sceneId}".`);
    const loaded = await readShots(deps.paths, scene.id, new Set(scene.lines.map((l) => l.id)));
    if (!loaded)
      throw new VnError('NO_SHOTS', `Scene "${scene.id}" has no storyboard to write to.`);
    const next = loaded.shots.map((s) => (s.id === target.shotId ? withSeed(s, seed) : s));
    await writeShots(deps.paths, scene.id, next);
    return plan;
  }

  const { model, docs } = await loadFor(deps, target);
  const found = entityDoc(docs, target.id);
  if (!found) throw new VnError('NO_SHEET', `No sheet on disk for ${target.kind} "${target.id}".`);
  const edited =
    target.kind === 'character'
      ? applyCharacterEdit(
          found.doc,
          characterSeedEdit(model.characters.get(target.id)?.outfits ?? [], target, plan.seed),
        )
      : applyLocationEdit(
          found.doc,
          locationSeedEdit(model.locations.get(target.id)?.variants ?? [], target, plan.seed),
        );
  if (!edited.ok) throw new VnError('EDIT_REJECTED', `Edit rejected: ${edited.diagnostic.message}`);
  await writeFileAtomic(found.file, docToMarkdown(edited.value.doc));
  return plan;
}

/** A shot with its seed set, or removed when the rung is cleared. */
function withSeed(shot: Shot, seed: number | undefined): Shot {
  const { seed: _drop, ...rest } = shot;
  return seed === undefined ? rest : { ...rest, seed };
}

/** {@link characterNotesEdit}, one field over: an outfit rung still resends the whole wardrobe. */
function characterSeedEdit(
  outfits: readonly Outfit[],
  target: Extract<ArtTarget, { kind: 'character' }>,
  seed: number | null,
): CharacterEdit {
  if (!target.outfit) return { seed };
  return {
    outfits: wardrobeEntries(
      outfits.map((o) => (o.id === target.outfit ? withOutfit(o, { seed: seed ?? undefined }) : o)),
    ),
  };
}

/** The same for a location. */
function locationSeedEdit(
  variants: readonly LocationVariant[],
  target: Extract<ArtTarget, { kind: 'location' }>,
  seed: number | null,
): LocationEdit {
  if (!target.variant) return { seed };
  return {
    variants: variantEntries(
      variants.map((v) =>
        v.id === target.variant ? withVariant(v, { seed: seed ?? undefined }) : v,
      ),
    ),
  };
}

/** The model and the sheets a rung is looked up in, off one load. */
async function loadFor(
  deps: SetNotesDeps,
  target: ArtTarget,
): Promise<{ model: ProjectModel; docs: EntityDoc[] }> {
  const inputs = await loadInputs(deps.paths);
  const model = modelFromInputs(inputs, {
    title: deps.config.title,
    ...(deps.config.start ? { start: deps.config.start } : {}),
  });
  const docs = target.kind === 'location' ? inputs.locationDocs : inputs.characterDocs;
  return { model, docs };
}

/** What the rung says after the mode is applied. Trimmed, because a rung holds trimmed text. */
function resolveNotes(existing: string | undefined, req: SetNotesRequest): string {
  const text = req.notes.trim();
  switch (req.mode ?? 'replace') {
    case 'clear':
      return '';
    case 'append':
      return existing?.trim() ? (text ? `${existing.trim()}\n${text}` : existing.trim()) : text;
    default:
      return text;
  }
}

/** The sentence for what is about to happen — the author's word for it, not the field's. */
function noteSentence(mode: NotesMode, notes: string, label: string): string {
  if (!notes) return `Cleared art notes on ${label}.`;
  return mode === 'append' ? `Appended to art notes on ${label}.` : `Set art notes on ${label}.`;
}

/** A shot with its art notes set, or removed when the text is blank. `Shot` is flat, so this is it. */
function withArtNotes(shot: Shot, notes: string): Shot {
  const { artNotes: _drop, ...rest } = shot;
  return notes ? { ...rest, artNotes: notes } : rest;
}

/** An outfit with one field changed, in the shape `wardrobeEntries` re-serializes. */
function withOutfit(outfit: Outfit, patch: Partial<Outfit>): Outfit {
  const next = { ...outfit, ...patch };
  if (!next.artNotes) delete next.artNotes;
  // Not falsiness: 0 is a seed like any other, and only an absent one means "inherit".
  if (next.seed === undefined) delete next.seed;
  if (!next.promptOverride) delete next.promptOverride;
  return next;
}

/** The same for a variant. */
function withVariant(variant: LocationVariant, patch: Partial<LocationVariant>): LocationVariant {
  const next = { ...variant, ...patch };
  if (!next.artNotes) delete next.artNotes;
  if (next.seed === undefined) delete next.seed;
  if (!next.promptOverride) delete next.promptOverride;
  return next;
}

/**
 * The character edit one rung's worth of notes amounts to. An outfit rung has to resend the whole
 * wardrobe — `applyCharacterEdit` replaces the map — so it is rebuilt through `wardrobeEntries`
 * from what the model already normalized, with the one entry changed. Rebuilding it by hand is
 * how a note comes to erase the prompt override sitting beside it.
 */
function characterNotesEdit(
  outfits: readonly Outfit[],
  target: Extract<ArtTarget, { kind: 'character' }>,
  notes: string,
): CharacterEdit {
  if (!target.outfit) return { artNotes: notes };
  return {
    outfits: wardrobeEntries(
      outfits.map((o) => (o.id === target.outfit ? withOutfit(o, { artNotes: notes }) : o)),
    ),
  };
}

/** The same for a location; a variant rung resends the whole list for the same reason. */
function locationNotesEdit(
  variants: readonly LocationVariant[],
  target: Extract<ArtTarget, { kind: 'location' }>,
  notes: string,
): LocationEdit {
  if (!target.variant) return { artNotes: notes };
  return {
    variants: variantEntries(
      variants.map((v) => (v.id === target.variant ? withVariant(v, { artNotes: notes }) : v)),
    ),
  };
}

import type { AssetBinding, AssetRef, ImageProvider, ProjectModel } from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import type { AssetStore } from '@vn/store';
import { hashParts, VnError } from '@vn/util';
import { imageParams } from './prompts.js';
import { baseRefusal } from './base.js';
import {
  conceptPrompt,
  matchSubject,
  subjectBinding,
  subjectEntity,
  type ConceptSubject,
} from './subject.js';

/** How many existing images of a subject are fed back as identity references. */
const MAX_REFS = 2;

/** How much of the sentence becomes the asset's name in a sidebar row. */
const TITLE_CHARS = 48;

/** The sentence, shortened at a word boundary — what a concept is called on screen. */
export function conceptTitle(sentence: string): string {
  const said = sentence.trim().replace(/\s+/g, ' ');
  if (said.length <= TITLE_CHARS) return said;
  const cut = said.slice(0, TITLE_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > TITLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Everything on-demand generation needs, and nothing about how the caller got it. */
export interface ArtGenDeps {
  config: ProjectConfig;
  model: ProjectModel;
  store: AssetStore;
  image: ImageProvider;
}

export interface ConceptRequest {
  /** What the author asked for, in their words. */
  sentence: string;
  /** Explicit subject. Omitted means {@link matchSubject} decides from the sentence. */
  subject?: ConceptSubject;
}

export interface ConceptResult {
  ref: AssetRef;
  /** What it bound to, however that was decided — so a surface can say which it picked. */
  subject?: ConceptSubject;
  prompt: string;
  /** Absolute path of the bytes, for a surface that wants to name the file. */
  file: string;
}

/**
 * Existing art of the subject, fed back so "an aerial shot of the high school" is a shot of *that*
 * high school. Location plates rather than shot frames: a plate is the place with nothing in front
 * of it. Ordered by hash so the same project always sends the same references.
 */
function subjectRefs(deps: ArtGenDeps, subject?: ConceptSubject): AssetRef[] {
  if (!subject) return [];
  if (subject.kind === 'character') {
    const portrait = deps.model.characters.get(subject.id)?.approvedPortrait;
    return portrait ? [{ hash: portrait, ext: 'png' }] : [];
  }
  return deps.store
    .manifest()
    .filter(
      (a) => a.kind === 'location_ref' && a.satisfies.some((b) => b.locationId === subject.id),
    )
    .sort((a, b) => a.hash.localeCompare(b.hash))
    .slice(0, MAX_REFS)
    .map((a) => ({ hash: a.hash, ext: a.ext }));
}

/**
 * Generate one concept image and store it.
 *
 * The door the planner deliberately does not have: a sentence in, an asset out, with no task node
 * and no place in any plan. The result is bound to what it sketches so the document tree and the
 * backlink panel can find it, and consumed by nothing — every other lookup in the codebase filters
 * by `kind` first, and the planner resolves a plate by task hash rather than by binding.
 */
export async function generateConcept(
  deps: ArtGenDeps,
  req: ConceptRequest,
): Promise<ConceptResult> {
  const sentence = req.sentence.trim();
  if (!sentence) throw new VnError('CONCEPT_EMPTY', 'Nothing to draw: the description is empty.');
  const refusal = baseRefusal(deps.store.base);
  if (refusal) throw new VnError('BASE_UNAVAILABLE', refusal);

  const subject = req.subject ?? matchSubject(deps.model, sentence);
  if (subject && !subjectEntity(deps.model, subject)) {
    throw new VnError('UNKNOWN_SUBJECT', `No ${subject.kind} "${subject.id}" in this project.`);
  }

  const prompt = conceptPrompt(sentence, subject, deps.model, deps.config);
  const params = imageParams(deps.config);
  const refs = subjectRefs(deps, subject);
  const result = await deps.image.generate(prompt, refs, params);
  const ref = await deps.store.write(result.bytes, result.ext, {
    kind: 'concept',
    // Not a node in the task graph — a concept has none. The hash of the request that produced
    // it, so provenance still answers "what made this" in the field that always answers it.
    sourceTask: hashParts('concept', { prompt, params, refs: refs.map((r) => r.hash) }),
    prompt,
    refs: refs.map((r) => r.hash),
    modelId: result.modelId,
    satisfies: subjectBinding(subject),
    title: conceptTitle(sentence),
  });
  return {
    ref,
    ...(subject ? { subject } : {}),
    prompt,
    file: deps.store.pathOf(ref),
  };
}

export interface RedrawRequest {
  /** The concept asset to draw again. */
  hash: string;
  /** What to draw it from. Empty means the prompt it was drawn from — a re-roll. */
  prompt?: string;
  /** What to call the result. Empty keeps the name the original had. */
  title?: string;
}

/** What a redraw would draw, once the manifest has been asked. */
export interface RedrawPlan {
  prompt: string;
  title?: string;
  /** What the new sketch binds to: whatever the original bound to, carried unchanged. */
  satisfies: AssetBinding;
  /** The original's references, resolved to refs the provider can load. */
  refs: AssetRef[];
  /** True when the prompt is the one the bytes were made from, so this is a re-roll. */
  reroll: boolean;
  /** The sentence a surface shows before spending the call. */
  note: string;
}

export interface RedrawResult extends ConceptResult {
  /** The sketch this one was drawn from; it stays in the manifest. */
  from: string;
  /** True when the same prompt and a fixed seed gave back the very same bytes. */
  unchanged: boolean;
}

/**
 * Every refusal a redraw can give, from the manifest alone — the same two-layer shape as
 * `promotionOf`, so a `check` and the act it guards say one sentence.
 *
 * A concept is the one asset kind whose prompt is *authored*: nothing derives it, no builder will
 * ever recompose it, and `derivePrompt` returns nothing for it. So editing that prompt cannot
 * freeze the asset against a future improvement, which is the reason every other kind's prompt is
 * read-only — and a planned asset is refused here by naming the command that does re-run it.
 */
export function redrawOf(
  store: AssetStore,
  req: RedrawRequest,
  opts: { seeded?: boolean } = {},
): { ok: false; code: string; reason: string } | { ok: true; plan: RedrawPlan } {
  const refusal = baseRefusal(store.base);
  if (refusal) return { ok: false, code: 'BASE_UNAVAILABLE', reason: refusal };

  const short = req.hash.slice(0, 8);
  const manifest = store.manifest();
  const asset = manifest.find((a) => a.hash === req.hash);
  if (!asset)
    return { ok: false, code: 'UNKNOWN_ASSET', reason: `No asset "${req.hash}" in the store.` };
  if (asset.kind !== 'concept') {
    return {
      ok: false,
      code: 'NOT_A_CONCEPT',
      reason: `Asset ${short} is a ${asset.kind}: its prompt is derived from the project on every planning pass, so there is nothing to edit. Re-render it with asset.regenerate, or change what it says with art.setNotes.`,
    };
  }
  const prompt = (req.prompt ?? '').trim() || (asset.prompt ?? '');
  if (!prompt) {
    return {
      ok: false,
      code: 'CONCEPT_EMPTY',
      reason: `Asset ${short} records no prompt, so a redraw needs one written out.`,
    };
  }
  const reroll = prompt === asset.prompt;
  const title = (req.title ?? '').trim() || asset.title;
  const byHash = new Map(manifest.map((a) => [a.hash, a]));
  return {
    ok: true,
    plan: {
      prompt,
      ...(title ? { title } : {}),
      satisfies: asset.satisfies[0] ?? {},
      // A reference whose bytes have left the store is dropped rather than fatal: the sketch is
      // still drawable, just less grounded, and saying so is the surface's job.
      refs: asset.refs
        .map((hash) => byHash.get(hash))
        .filter((a) => a !== undefined)
        .map((a) => ({ hash: a.hash, ext: a.ext })),
      reroll,
      note: reroll
        ? opts.seeded
          ? `Would draw ${short} again from the same prompt — image_params.seed is fixed, so expect the same picture. Edit the prompt to change it.`
          : `Would draw ${short} again from the same prompt, as a fresh roll.`
        : `Would draw a new sketch from the edited prompt. ${short} stays where it is.`,
    },
  };
}

/**
 * Draw a concept again, from an edited prompt or the same one.
 *
 * A redraw is a new asset, never an overwrite: bytes are content-addressed, so different bytes are
 * a different hash, and nothing in this repo removes bytes from the store. The original stays under
 * Concepts as the candidate it is. What carries over is the binding and the references, so a redraw
 * of a sketch of the café is still a sketch of that café.
 */
export async function redrawConcept(deps: ArtGenDeps, req: RedrawRequest): Promise<RedrawResult> {
  const params = imageParams(deps.config);
  const decided = redrawOf(deps.store, req, { seeded: params.seed !== undefined });
  if (!decided.ok) throw new VnError(decided.code, decided.reason);
  const { prompt, title, satisfies, refs } = decided.plan;

  const result = await deps.image.generate(prompt, refs, params);
  const ref = await deps.store.write(result.bytes, result.ext, {
    kind: 'concept',
    sourceTask: hashParts('concept', { prompt, params, refs: refs.map((r) => r.hash) }),
    prompt,
    refs: refs.map((r) => r.hash),
    modelId: result.modelId,
    satisfies,
    ...(title ? { title } : {}),
  });
  return {
    ref,
    prompt,
    file: deps.store.pathOf(ref),
    from: req.hash,
    unchanged: ref.hash === req.hash,
  };
}

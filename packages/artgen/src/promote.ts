import type { AssetRef, ProjectModel } from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import type { LoadedInputs } from '@vn/parse';
import { applyLocationEdit, docToMarkdown, modelFromInputs, type LocationEdit } from '@vn/model';
import { entityFile, loadInputs, type AssetStore, type ProjectPaths } from '@vn/store';
import { VnError, writeFileAtomic } from '@vn/util';
import { adoptSlot } from './adoptslot.js';
import { baseRefusal } from './base.js';

/** A variant id an author can type: the same shape `- night` already has in a sheet. */
const VARIANT_ID = /^[a-z0-9][a-z0-9_-]*$/i;

export interface PromoteDeps {
  config: ProjectConfig;
  paths: ProjectPaths;
  store: AssetStore;
}

export interface PromoteRequest {
  /** The concept asset to promote. */
  hash: string;
  /** The variant id it becomes a plate for; created on the sheet if it isn't there. */
  variant: string;
  /** Optional prose for a variant this call creates. Ignored for one that already exists. */
  description?: string;
}

/** What a promotion would do, once the manifest has been asked. */
export interface PromotionPlan {
  locationId: string;
  variant: string;
  /** The sentence a surface shows before committing to it. */
  note: string;
}

export interface PromoteResult {
  ref: AssetRef;
  locationId: string;
  variant: string;
  /** The planner's own task identity for this plate, now recorded `done`. */
  taskHash: string;
  /** True when the sheet gained the variant, false when it already had it. */
  addedVariant: boolean;
  /** The sheet that was written, when one was. */
  file?: string;
}

/** The model, off one load, with the title/entry the config names. */
function modelOf(config: ProjectConfig, inputs: LoadedInputs): ProjectModel {
  return modelFromInputs(inputs, {
    title: config.title,
    ...(config.start ? { start: config.start } : {}),
  });
}

/**
 * Every refusal a promotion can give, decided from the manifest alone, so the precondition a
 * surface shows is the sentence the act itself would use. It stops short of the sheet on purpose:
 * a location the model has and disk does not is a broken project, not a bad request.
 */
export function promotionOf(
  store: AssetStore,
  req: { hash: string; variant: string },
): { ok: false; code: string; reason: string } | { ok: true; plan: PromotionPlan } {
  const refusal = baseRefusal(store.base);
  if (refusal) return { ok: false, code: 'BASE_UNAVAILABLE', reason: refusal };

  const short = req.hash.slice(0, 8);
  const asset = store.manifest().find((a) => a.hash === req.hash);
  if (!asset)
    return { ok: false, code: 'UNKNOWN_ASSET', reason: `No asset "${req.hash}" in the store.` };
  if (asset.kind !== 'concept') {
    return {
      ok    : false,
      code  : 'NOT_A_CONCEPT',
      reason: `Asset ${short} is a ${asset.kind}, not a concept — only a concept is promoted.`,
    };
  }
  const locationId = asset.satisfies.find((b) => b.locationId)?.locationId;
  if (!locationId) {
    return {
      ok    : false,
      code  : 'UNBOUND_CONCEPT',
      reason: asset.satisfies.some((b) => b.characterId)
        ? "That concept is of a character, and a character's look goes through the approval gate — promote a location concept, or approve a portrait with gate.approve."
        : 'That concept is not bound to a location, so there is no sheet to write a variant onto.',
    };
  }
  const variant = req.variant.trim();
  if (!VARIANT_ID.test(variant)) {
    return {
      ok    : false,
      code  : 'BAD_VARIANT',
      reason: `"${req.variant}" is not a usable variant id.`,
    };
  }
  return {
    ok  : true,
    plan: {
      locationId,
      variant,
      note: `Would make ${short} the "${variant}" plate for ${locationId}, adding the variant to its sheet if it is new. The next run adopts it instead of rendering one.`,
    },
  };
}

/**
 * Turn a concept into the location plate the planner would have rendered.
 *
 * Two acts, in this order because the second depends on the first: the variant goes onto the
 * location's sheet, and then the sketch is adopted as `plate:<location>/<variant>` — the general
 * act, which re-records the bytes and logs the plate's task `done`.
 *
 * It cannot forge work that never happened: {@link adoptSlot} derives the identity from the sheet
 * this call just wrote, so the node it marks done is exactly the node whose output this image is.
 */
export async function promoteConcept(
  deps: PromoteDeps,
  req: PromoteRequest,
): Promise<PromoteResult> {
  const decided = promotionOf(deps.store, req);
  if (!decided.ok) throw new VnError(decided.code, decided.reason);
  const { locationId, variant } = decided.plan;

  const inputs = await loadInputs(deps.paths);
  const entry = inputs.locationDocs.find((d) => d.id === locationId);
  const file = entityFile(inputs.locationDocs, locationId);
  if (!entry || !file) {
    throw new VnError('NO_SHEET', `Location "${locationId}" has no sheet on disk to write to.`);
  }

  // The variant list is replaced wholesale by `applyLocationEdit`, so the ones already there are
  // resent in their authored shape — a bare id stays a bare id, and empty keys stay out.
  const known = modelOf(deps.config, inputs).locations.get(locationId)?.variants ?? [];
  const addedVariant = !known.some((v) => v.id === variant);
  if (addedVariant) {
    const edit: LocationEdit = {
      variants: [
        ...known.map((v) =>
          v.description || v.artNotes
            ? {
                id: v.id,
                ...(v.description ? { description: v.description } : {}),
                ...(v.artNotes ? { art_notes: v.artNotes } : {}),
              }
            : v.id,
        ),
        req.description?.trim() ? { id: variant, description: req.description.trim() } : variant,
      ],
    };
    const edited = applyLocationEdit(entry.doc, edit);
    if (!edited.ok) throw new VnError('EDIT_REJECTED', edited.diagnostic.message);
    await writeFileAtomic(file, docToMarkdown(edited.value.doc));
  }

  // The general act, against the sheet this call just wrote: it re-reads the model, so the identity
  // it derives is the one the planner would derive now.
  const adopted = await adoptSlot(deps, {
    hash: req.hash,
    slot: { kind: 'plate', locationId, variant },
  });

  return {
    ref: adopted.ref,
    locationId,
    variant,
    taskHash: adopted.plan.taskHash,
    addedVariant,
    ...(addedVariant ? { file } : {}),
  };
}

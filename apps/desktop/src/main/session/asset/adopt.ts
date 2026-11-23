import { adoptSlot, adoptionForSlot, type AdoptSlotPlan, type AdoptVia } from '@vn/artgen';
import { parseSlot, slotKey, slotLabel } from '@vn/stills';
import type { RefBinding } from '@vn/types';
import type { WorkspaceSession } from '../core.js';
import { type LoadedProject, loadProject } from '../load/project.js';
import { relPath } from '../load/tree.js';
import { portraitOwner } from './approval.js';

/** The clock a hold and its attempt are stamped with. */
const clock = (): string => new Date().toISOString();

/**
 * Both adoption halves follow the same rule. Read the slot address, then let
 * `adoptionForSlot` decide everything else. `bytes` is for the pre-upload case, where the
 * hash is not in the store yet.
 */
export async function adoptPlan(
  session: WorkspaceSession,
  hash: string,
  slot: string,
  replace: boolean,
  bytes?: Uint8Array,
): Promise<
  | { ok: false; code: string; reason: string }
  | { ok: true; project: LoadedProject; slot: RefBinding; plan: AdoptSlotPlan }
> {
  const said = parseSlot(slot);
  if (!said) {
    return {
      ok    : false,
      code  : 'NOT_A_SLOT',
      reason: `"${slot}" is not a picture in this project. A slot reads like plate:cafe/night, sheet:aiko/gala/front or shot:greet/s2.`,
    };
  }
  const project = await loadProject(session.dir);
  const decided = await adoptionForSlot(
    { config: project.config, paths: project.paths, store: project.store },
    { hash, slot: said, replace, via: 'adopt', ...(bytes ? { bytes } : {}) },
  );
  return decided.ok
    ? { ok: true, project, slot: said, plan: decided.plan }
    : { ok: false, code: decided.code, reason: decided.reason };
}

/** What `asset.adopt` would make this picture, without writing anything. */
export async function previewAdopt(
  session: WorkspaceSession,
  hash: string,
  slot: string,
  replace: boolean,
): Promise<{ ok: boolean; message: string }> {
  const decided = await adoptPlan(session, hash, slot, replace);
  return decided.ok
    ? { ok: true, message: decided.plan.note }
    : { ok: false, message: decided.reason };
}

/**
 * Record bytes already in the store as a slot's output — the general form of promotion. The task
 * identity is derived from the project as it stands and logged `done`, so the next run adopts the
 * picture rather than rendering over it.
 */
export async function adoptAsset(
  session: WorkspaceSession,
  hash: string,
  slot: string,
  replace: boolean,
  via: AdoptVia = 'adopt',
): Promise<{ ok: boolean; message: string; hash?: string; written: string[] }> {
  const decided = await adoptPlan(session, hash, slot, replace);
  if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
  const { project, slot: binding } = decided;
  const result = await adoptSlot(
    { config: project.config, paths: project.paths, store: project.store, now: clock },
    { hash, slot: binding, replace, via },
  );
  const superseded = result.plan.supersedes
    ? ` It supersedes the render ${result.plan.supersedes.slice(0, 8)}, whose bytes stay in the store.`
    : '';
  return {
    ok     : true,
    message: `${hash.slice(0, 8)} is now the ${result.plan.label}.${superseded}`,
    hash   : result.ref.hash,
    written: adoptWrote(session, project, binding, result.plan),
  };
}

/**
 * The rule behind both replace halves: the asset names its own slot, so an author replacing
 * the picture in front of them never types one. Refusals come from {@link adoptionForSlot}
 * asked about these very bytes — a portrait, a concept and an upload are refused there by
 * name. Both the preview and the act ask the same question, so the strip on screen and the
 * command it runs apply the same rule.
 */
async function replacePlan(
  session: WorkspaceSession,
  hash: string,
): Promise<{ ok: false; reason: string } | { ok: true; slot: RefBinding; note: string }> {
  const info = await session.assetInfo(hash);
  if (!info) return { ok: false, reason: `No asset "${hash}" in the manifest.` };
  if (!info.slot) {
    return {
      ok    : false,
      reason: `${info.label} fills no slot — nothing planned it, or a later render took the slot over, so there is nothing for a file to replace.`,
    };
  }
  const slot = parseSlot(info.slot);
  if (!slot) return { ok: false, reason: `"${info.slot}" is not a picture in this project.` };

  // Apply every refusal except `MOCK_PLACEHOLDER`: that one judges the incoming bytes, and
  // the chooser has not produced any yet — `uploadOf` refuses mock art at the upload, which is
  // where that check belongs. This call only exists to check the slot itself.
  const decided = await adoptPlan(session, hash, info.slot, false);
  if (!decided.ok && decided.code !== 'MOCK_PLACEHOLDER') {
    return { ok: false, reason: decided.reason };
  }
  const label = decided.ok ? decided.plan.label : slotLabel(slot);
  return {
    ok: true,
    slot,
    note: `Opens a file chooser; what you choose becomes the ${label}, superseding ${hash.slice(0, 8)} — whose bytes stay in the store.`,
  };
}

/**
 * An older take goes back only where it was a take of a slot and a later render has taken that
 * slot over. Anything else has nothing to be put back into.
 *
 * The three kinds `previewAccept` refuses by name are refused here for the same reasons, and the
 * suspension and upstream-approval refusals are the ones accepting would give, because the whole
 * act ends in an accept.
 */
async function restorePlan(
  session: WorkspaceSession,
  hash: string,
): Promise<
  { ok: false; reason: string } | { ok: true; slot: string; newer: string; label: string }
> {
  const info = await session.assetInfo(hash);
  if (!info) return { ok: false, reason: `No asset "${hash}" in the manifest.` };
  if (info.kind === 'portrait') {
    const who = portraitOwner(info);
    const call = who ? `(characterId='${who}' hash='${hash}')` : '';
    return {
      ok    : false,
      reason: `${info.label} is a portrait; an earlier look goes back through gate.approve${call}.`,
    };
  }
  if (info.kind === 'concept' || info.kind === 'reference') {
    return {
      ok    : false,
      reason: `${info.label} is a ${info.kind}; nothing planned it, so it was never a take of anything.`,
    };
  }
  if (info.newerTake === undefined) {
    return {
      ok    : false,
      reason: info.slot
        ? `${info.label} is already the ${info.slot}.`
        : `${info.label} fills no slot, so there is nothing to put it back into.`,
    };
  }
  if (!info.drawnFor) {
    return { ok: false, reason: `${info.label} names no picture in this project any more.` };
  }
  if (info.suspended) {
    return {
      ok    : false,
      reason: `${info.label} is suspended: ${info.suspended}. Repin or regenerate it first.`,
    };
  }
  if (info.unapproved) return { ok: false, reason: info.unapproved };
  const decided = await adoptPlan(session, hash, info.drawnFor, true);
  if (!decided.ok) return { ok: false, reason: decided.reason };
  return { ok: true, slot: info.drawnFor, newer: info.newerTake, label: info.label };
}

/** What `asset.restore` would put back, without writing it. */
export async function previewRestore(
  session: WorkspaceSession,
  hash: string,
): Promise<{ ok: boolean; message: string }> {
  const decided = await restorePlan(session, hash);
  if (!decided.ok) return { ok: false, message: decided.reason };
  return {
    ok     : true,
    message:
      `Would make ${decided.label} the ${decided.slot} again and accept it, superseding ` +
      `${decided.newer.slice(0, 8)} — whose bytes stay in the store, and whose prompt is then ` +
      'the one nothing is drawn from.',
  };
}

/**
 * Put an older take back in its slot and accept it, as one act.
 *
 * Accepting alone would only flip a manifest flag: the slot's task still names the later render,
 * so the runner and the exporter would go on using it. The adoption is what makes the picture
 * the slot's answer, and the accept is what the author meant by clicking Accept.
 *
 * The prompt these bytes were drawn from is kept rather than restamped with the slot's current
 * one, so the picture goes on reporting the drift it really has.
 */
export async function restoreAsset(
  session: WorkspaceSession,
  hash: string,
): Promise<{ ok: boolean; message: string; written: string[] }> {
  const decided = await restorePlan(session, hash);
  if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
  const project = await loadProject(session.dir);
  const slot = parseSlot(decided.slot);
  if (!slot)
    return {
      ok     : false,
      message: `"${decided.slot}" is not a picture in this project.`,
      written: [],
    };
  const result = await adoptSlot(
    { config: project.config, paths: project.paths, store: project.store, now: clock },
    { hash, slot, replace: true, keepPrompt: true, via: 'restore' },
  );
  const accepted = await session.acceptAsset(hash);
  if (!accepted.ok) return { ok: false, message: accepted.message, written: [] };
  return {
    ok     : true,
    message: `${decided.label} is the ${result.plan.label} again, and accepted. It supersedes ${decided.newer.slice(0, 8)}, whose bytes stay in the store.`,
    written: adoptWrote(session, project, slot, result.plan),
  };
}

/** What `asset.replace` would replace, before the chooser is opened. */
export async function previewReplace(
  session: WorkspaceSession,
  hash: string,
): Promise<{ ok: boolean; message: string }> {
  const decided = await replacePlan(session, hash);
  return decided.ok ? { ok: true, message: decided.note } : { ok: false, message: decided.reason };
}

/**
 * Put an outside file in the place of a picture the project generated: upload it, then adopt
 * it onto the slot those bytes fill. It is a single act, so a file that lands but cannot be
 * adopted reports that in one answer — `uploadAsset` produces that message.
 */
export async function replaceAsset(
  session: WorkspaceSession,
  hash: string,
  file: string,
): Promise<{ ok: boolean; message: string; hash?: string; written: string[] }> {
  const decided = await replacePlan(session, hash);
  if (!decided.ok) return { ok: false, message: decided.reason, written: [] };
  return session.uploadAsset(file, '', slotKey(decided.slot), true);
}

/** What an adoption touched: the manifest its kind routes to, the log, and a shot's own file. */
function adoptWrote(
  session: WorkspaceSession,
  project: LoadedProject,
  slot: RefBinding,
  plan: AdoptSlotPlan,
): string[] {
  const manifest = plan.kind === 'shot_image' ? project.paths.manifest : project.paths.baseManifest;
  return [
    ...(slot.kind === 'shot' ? [relPath(session.dir, project.paths.shotsFile(slot.sceneId))] : []),
    relPath(session.dir, manifest),
    relPath(session.dir, project.paths.tasksLog),
  ];
}

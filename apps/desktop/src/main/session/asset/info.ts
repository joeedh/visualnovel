import { isBaseKind } from '@vn/store';
import { basePromptOf } from '@vn/pipeline';
import { rungsFor } from '@vn/artgen';
import {
  assetApproved,
  assetPrereqs,
  prereqRefusal,
  resolveBinding,
  sheetAngleOf,
  slotKey,
  slotOf,
} from '@vn/stills';
import type { AssetInfo, AssetListing } from '../../../shared/ipc.js';
import { labelAssets, labelContext } from '../../assets/assetlabel.js';
import { derivePrompt } from '../../assets/assetprompt.js';
import type { WorkspaceSession } from '../core.js';
import { loadProject, withShots } from '../load/project.js';
import { relPath } from '../load/tree.js';
import { ACCEPTABLE, suspensionsOf } from '../rules/assets.js';

export async function assetLibrary(session: WorkspaceSession): Promise<AssetListing[]> {
  const project = await loadProject(session.dir);
  const manifest = project.store.manifest();
  const labels = labelContext(project.model, project.graph);
  const names = labelAssets(manifest, labels);
  return manifest.map((asset) => {
    const slot = slotOf(asset, labels.angleOf?.(asset.sourceTask));
    return {
      hash    : asset.hash,
      ext     : asset.ext,
      kind    : asset.kind,
      file    : relPath(session.dir, project.store.pathOf(asset)),
      label   : names.get(asset.hash) ?? asset.hash,
      accepted: assetApproved(asset),
      ...(slot ? { slot: slotKey(slot) } : {}),
    };
  });
}

/**
 * Everything the asset editor draws for one asset: what the bytes are, the prompt they were
 * made from, the prompt the builders would write now, and the art-notes rungs that reach it.
 * `null` when the manifest has never heard of the hash.
 */
export async function assetInfo(
  session: WorkspaceSession,
  hash: string,
): Promise<AssetInfo | null> {
  const project = await loadProject(session.dir);
  const manifest = project.store.manifest();
  const asset = manifest.find((a) => a.hash === hash);
  if (!asset) return null;

  const model = await withShots(project);
  const suspended = suspensionsOf(project, model).get(hash);
  const task = project.graph.get(asset.sourceTask);
  const ctx = { model, config: project.config, ...(task ? { task } : {}) };
  const derived = derivePrompt(asset, ctx);
  // The prompt as sent carries any `Corrections:` clause P7 appended; the planner hashed the base.
  const recorded = asset.prompt === undefined ? undefined : basePromptOf(asset.prompt);
  const view = await session.promptPart.promptViewOf(project, hash);
  const labels = labelContext(model, project.graph);
  const label = labelAssets(manifest, labels).get(hash) ?? hash;
  const prereqs = assetPrereqs(asset, { ...labels, assets: manifest });
  // Only for the kinds that can be accepted at all: a portrait, a concept and an upload are each
  // refused by name already, and a second sentence beside those reads as a second rule. Their
  // prereqs are still listed, because what a sketch was drawn from is worth showing regardless.
  const unapproved = ACCEPTABLE.has(asset.kind) ? prereqRefusal(label, prereqs) : undefined;
  const from = slotOf(asset, sheetAngleOf(asset, labels));
  const current = from ? session.gatePart.slotTask(project, from, model) : undefined;
  // What the slot holds now is the current row, not the identity's output: an old take stays
  // current through a re-key until the new identity lands. A slot only counts while these are
  // the bytes in it, because a pane offering to replace a superseded render would supersede a
  // picture already moved past.
  const holder = from ? resolveBinding(from, { ...labels, assets: manifest }) : undefined;
  const slot = from && holder === asset.hash ? from : undefined;
  const failure = from ? session.gatePart.failureOf(project, current, asset.sourceTask) : undefined;
  const newer = holder !== undefined && holder !== asset.hash ? holder : undefined;
  // Only a concept bound to a location promotes to a plate, and only that strip asks for a
  // variant, so nothing else pays for the lookup.
  const conceptOf = asset.kind === 'concept' ? asset.satisfies[0]?.locationId : undefined;
  const locationVariants = conceptOf
    ? (project.model.locations.get(conceptOf)?.variants ?? []).map((v) => v.id)
    : undefined;
  return {
    hash: asset.hash,
    ext : asset.ext,
    kind: asset.kind,
    label,
    base      : isBaseKind(asset.kind),
    accepted  : asset.accepted,
    current   : asset.current === true,
    approved  : assetApproved(asset),
    sourceTask: asset.sourceTask,
    ...(asset.via === undefined ? {} : { via: asset.via }),
    ...(asset.at === undefined ? {} : { at: asset.at }),
    ...(asset.prompt === undefined ? {} : { prompt: asset.prompt }),
    ...(asset.title === undefined ? {} : { title: asset.title }),
    ...(derived === undefined ? {} : { derived }),
    // An unknown derivation is not evidence of drift — it means the project no longer describes
    // this asset, which the editor says a different way. An adopted or promoted picture was
    // never drawn from the derived prompt, so it has none to have gone stale against.
    stale:
      derived !== undefined &&
      recorded !== undefined &&
      derived !== recorded &&
      asset.via !== 'adopt' &&
      asset.via !== 'promote' &&
      asset.via !== 'upload',
    ...(suspended ? { suspended: suspended.reason } : {}),
    ...(slot ? { slot: slotKey(slot) } : {}),
    ...(from ? { drawnFor: slotKey(from) } : {}),
    ...(locationVariants ? { locationVariants } : {}),
    ...(newer ? { newerTake: newer } : {}),
    ...(failure ? { failure } : {}),
    prereqs,
    ...(unapproved ? { unapproved } : {}),
    rungs       : rungsFor(asset, { model }),
    projectModel: project.config.models.image,
    ...(project.config.image_params.seed === undefined
      ? {}
      : { configSeed: project.config.image_params.seed }),
    ...(view ? { promptView: view } : {}),
  };
}

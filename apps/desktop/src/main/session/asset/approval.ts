import { entityFile } from '@vn/store';
import { approvedPortraitOf } from '@vn/pipeline';
import { acceptRefusal } from '@vn/stills';
import type { AssetInfo } from '../../../shared/ipc.js';
import { labelAssets, labelContext } from '../../assets/assetlabel.js';
import type { WorkspaceSession } from '../core.js';
import { loadProject, withShots } from '../load/project.js';
import { relPath } from '../load/tree.js';
import type { PromptWriteResult } from '../types/results.js';

/**
 * Whether accepting this asset is a question worth answering. Three kinds are refused by name:
 * a portrait, because approving one also writes `character.md` and `approved.png` and that is
 * `gate.approve`; a concept, because nothing downstream consumes one, so `accepted` would
 * mean nothing; and a reference, because nothing generated it — it counts by being pointed at.
 * Already accepted is not a refusal — re-accepting is how an author changes their mind.
 */
export async function previewAccept(
  session: WorkspaceSession,
  hash: string,
): Promise<{ ok: boolean; message: string }> {
  const info = await session.assetInfo(hash);
  if (!info) return { ok: false, message: `No asset "${hash}" in the manifest.` };
  if (info.kind === 'portrait') {
    // The character rung is the widest one a portrait has, so its target names the character
    // without asking for the binding a second time.
    const who = info.rungs[0]?.target.split(':')[1];
    const call = who ? `(characterId='${who}' hash='${hash}')` : '';
    return {
      ok     : false,
      message: `${info.label} is a portrait; use gate.approve${call}, which also writes character.md and approved.png.`,
    };
  }
  if (info.kind === 'concept') {
    return {
      ok     : false,
      message: `${info.label} is a concept; nothing downstream consumes one. Use art.promote(hash='${hash}' variant=…) to make it a location plate.`,
    };
  }
  if (info.kind === 'reference') {
    return {
      ok     : false,
      message: `${info.label} is an upload; nothing generated it, so there is no work to bless. It counts by being pointed at with prompt.addRef.`,
    };
  }
  if (info.suspended) {
    // Accepting says these bytes are the answer, and a suspended asset was drawn against a
    // reference that has since moved.
    return {
      ok     : false,
      message: `${info.label} is suspended: ${info.suspended}. Repin or regenerate it first.`,
    };
  }
  // Checked after suspension deliberately: suspension is a claim about these bytes resting on a
  // reference that moved, which is more specific than a claim about the slot or other bytes
  // upstream. The rule itself is shared with the CLI and the testkit.
  const refused = await refusalToAccept(session, hash);
  if (refused) return { ok: false, message: refused };
  return {
    ok     : true,
    message: info.accepted
      ? `${info.label} is already accepted; would re-accept it.`
      : `Would accept ${info.label}.`,
  };
}

/** `acceptRefusal` over the project as it stands: not the slot's take, or unapproved upstream. */
async function refusalToAccept(
  session: WorkspaceSession,
  hash: string,
): Promise<string | undefined> {
  const project = await loadProject(session.dir);
  const manifest = project.store.manifest();
  const asset = manifest.find((a) => a.hash === hash);
  if (!asset) return `No asset "${hash}" in the manifest.`;
  const labels = labelContext(await withShots(project), project.graph);
  const label = labelAssets(manifest, labels).get(hash) ?? hash;
  return acceptRefusal(asset, label, { ...labels, assets: manifest });
}

/**
 * Mark an asset as approved by the author. Generic across both roots, and it asks
 * {@link previewAccept} itself rather than trusting that a check already ran — a caller may
 * skip the check, so the command cannot rely on it having happened.
 *
 * Accepting selects nothing: the take is already the one its slot holds, or the preview refused
 * and named `asset.restore`, which is the act that puts an older take back.
 */
export async function acceptAsset(
  session: WorkspaceSession,
  hash: string,
): Promise<PromptWriteResult> {
  const allowed = await session.previewAccept(hash);
  if (!allowed.ok) return { ...allowed, written: [] };
  const project = await loadProject(session.dir);
  if (!project.store.has(hash))
    return { ok: false, message: `No asset "${hash}" in the store.`, written: [] };
  // Asked before the write, since which root answers is decided by which one holds the hash and
  // an accept moves no bytes between them.
  const manifest = relPath(session.dir, project.store.manifestFileOf(hash));
  await project.store.accept(hash);
  return { ok: true, message: `Accepted ${hash.slice(0, 8)}.`, written: [manifest] };
}

/**
 * Which character a portrait was drawn for, from its widest art-notes rung. The same lookup
 * `previewAccept` uses to name `gate.approve` in its refusal.
 */
export function portraitOwner(info: AssetInfo): string | undefined {
  return info.rungs[0]?.target.split(':')[1];
}

/**
 * Answers whether taking approval back off this asset is worth doing. A concept and a reference
 * are refused by name, for the reason {@link previewAccept} refuses them, since neither is ever
 * approved and there is nothing to take back. An asset that is not the accepted one is refused
 * too, since un-approving is about the answer a slot has rather than about a losing take.
 *
 * A portrait goes through the P3 gate, so its sentence says what else comes back out with it.
 */
export async function previewUnapprove(
  session: WorkspaceSession,
  hash: string,
): Promise<{ ok: boolean; message: string }> {
  const info = await session.assetInfo(hash);
  if (!info) return { ok: false, message: `No asset "${hash}" in the manifest.` };
  if (info.kind === 'concept' || info.kind === 'reference') {
    return {
      ok     : false,
      message: `${info.label} is a ${info.kind}; nothing ever approved it, so there is nothing to take back.`,
    };
  }
  if (info.kind === 'portrait') {
    const who = portraitOwner(info);
    if (!who) return { ok: false, message: `${info.label} names no character.` };
    const project = await loadProject(session.dir);
    const character = project.model.characters.get(who);
    const approved = character
      ? approvedPortraitOf(character, project.store.manifest())
      : undefined;
    if (!character || approved === undefined) {
      return { ok: false, message: `${who} has no approved portrait.` };
    }
    if (approved !== hash) {
      return { ok: false, message: `${who}'s approved portrait is a different take.` };
    }
    return {
      ok     : true,
      message: `Would put ${who} back at the gate, dropping approved.png and the hash in their sheet.`,
    };
  }
  if (!info.accepted) return { ok: false, message: `${info.label} is not accepted.` };
  return { ok: true, message: `Would un-accept ${info.label}, leaving its slot unanswered.` };
}

/**
 * Take approval back off an asset: the manifest flag, which for a portrait is the whole P3
 * gate, since the store clears the sheet's `status:` and `approved_portrait:` and `approved.png`
 * with it.
 *
 * Asks {@link previewUnapprove} itself for the reason {@link acceptAsset} asks its own preview:
 * a caller may skip the check, so the write cannot rely on one having run.
 *
 * The bytes are never touched. Everything drawn from what this un-approves keeps its own
 * approval, and the slot graph reports it as blocked again until something answers the slot.
 */
export async function unapproveAsset(
  session: WorkspaceSession,
  hash: string,
): Promise<{ ok: boolean; message: string; written: string[] }> {
  const allowed = await session.previewUnapprove(hash);
  if (!allowed.ok) return { ...allowed, written: [] };
  const info = await session.assetInfo(hash);
  if (!info) return { ok: false, message: `No asset "${hash}" in the manifest.`, written: [] };
  const project = await loadProject(session.dir);

  const manifest = relPath(session.dir, project.store.manifestFileOf(hash));
  if (info.kind !== 'portrait') {
    await project.store.unaccept(hash);
    return { ok: true, message: `Un-accepted ${info.label}.`, written: [manifest] };
  }

  const who = portraitOwner(info) ?? '';
  const file = entityFile(project.inputs.characterDocs, who);
  if (!file) return { ok: false, message: `No character file for "${who}".`, written: [] };
  await project.store.unaccept(hash);
  return {
    ok     : true,
    message: `${who} is back at the approval gate.`,
    written: [
      relPath(session.dir, file),
      relPath(session.dir, project.paths.approvedPortrait(who)),
      manifest,
    ],
  };
}

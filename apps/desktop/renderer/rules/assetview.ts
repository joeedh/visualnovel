/**
 * What the asset editor decides before it draws: which command approves the asset in front of
 * it, what the header's badges say, and how staleness reads as a sentence.
 *
 * Pure, because the desktop jest project is node-only and the pane itself can only be checked
 * live over CDP — so everything that is a *rule* rather than markup is tested here instead.
 */
import type { AssetInfo } from '../../src/shared/ipc.js';

/** The character an entity-level rung names — `character:aiko/gala` → `aiko`. */
export function characterOf(info: AssetInfo): string {
  for (const rung of info.rungs) {
    const [kind, rest] = splitTarget(rung.target);
    if (kind === 'character' && rest !== '') return rest;
  }
  return '';
}

function splitTarget(target: string): [string, string] {
  const colon = target.indexOf(':');
  if (colon < 0) return [target, ''];
  const rest = target.slice(colon + 1);
  const slash = rest.indexOf('/');
  return [target.slice(0, colon), slash < 0 ? rest : rest.slice(0, slash)];
}

/** The location an entity-level rung names — `location:cafe/night` → `cafe`. */
export function locationOf(info: AssetInfo): string {
  for (const rung of info.rungs) {
    const [kind, rest] = splitTarget(rung.target);
    if (kind === 'location' && rest !== '') return rest;
  }
  return '';
}

/** The approve button: which command it runs, or why there is nothing for it to run. */
export type ApproveAction =
  | { ok: true; id: string; props: Record<string, string>; label: string }
  | { ok: false; reason: string };

/**
 * A portrait is approved through the gate and nothing else — `gate.approve` also writes
 * `character.md` and `approved.png`, which is what actually clears the character — so the pane
 * offers that command rather than the generic `asset.accept` the command itself would refuse.
 * A concept and an upload have no approval at all, for opposite reasons: nothing consumes a
 * concept, and nothing generated an upload.
 */
export function approveAction(info: AssetInfo): ApproveAction {
  if (info.kind === 'concept') {
    return {
      ok: false,
      reason: 'A concept is a sketch — nothing downstream consumes one. Promote it to a plate.',
    };
  }
  if (info.kind === 'reference') {
    return {
      ok: false,
      reason:
        'An upload is not generated art — it counts by being pointed at, not by being blessed.',
    };
  }
  if (info.kind !== 'portrait') {
    return {
      ok: true,
      id: 'asset.accept',
      props: { hash: info.hash },
      label: info.accepted ? 'Re-accept' : 'Accept',
    };
  }
  const characterId = characterOf(info);
  if (characterId === '') {
    return { ok: false, reason: 'This portrait names no character — approve it from the gate.' };
  }
  return {
    ok: true,
    id: 'gate.approve',
    props: { characterId, hash: info.hash },
    label: info.accepted ? 'Re-approve' : 'Approve',
  };
}

/** The promote control: the location a concept would become a plate for, or why it cannot. */
export type PromoteAction = { ok: true; locationId: string } | { ok: false; reason: string };

/**
 * Only a concept is promotable, and only one bound to a location: a character concept would walk
 * around the approval gate, which owns `character.md` and `approved.png`.
 */
export function promoteAction(info: AssetInfo): PromoteAction {
  if (info.kind !== 'concept') {
    return { ok: false, reason: `A ${info.kind} is already what it is — only a concept promotes.` };
  }
  if (characterOf(info) !== '') {
    return {
      ok: false,
      reason:
        "That is a concept of a character, and a character's look goes through the approval gate.",
    };
  }
  const locationId = locationOf(info);
  if (locationId === '') {
    return {
      ok: false,
      reason: 'This concept names no location, so there is no sheet to write to.',
    };
  }
  return { ok: true, locationId };
}

/** The redraw strip: what the boxes start out holding, or why this prompt cannot be edited. */
export type RedrawAction =
  | { ok: true; prompt: string; title: string }
  | { ok: false; reason: string };

/**
 * A concept is the one asset whose prompt is *authored*: nothing derives it, so nothing rewrites
 * it on the next planning pass and an edit survives. Every other kind's prompt is a derivation
 * folded into the task hash — art notes are how those move, and `asset.regenerate` re-runs them.
 *
 * The prompt comes back whole rather than as an empty box, so the style preamble and the
 * framing sentence survive an edit by default.
 */
export function promptEditable(info: AssetInfo): RedrawAction {
  if (info.kind !== 'concept') {
    return {
      ok: false,
      reason: `A ${info.kind}'s prompt is composed from the project on every planning pass — edit it a clause at a time below, not as one string.`,
    };
  }
  return { ok: true, prompt: info.prompt ?? '', title: info.title ?? '' };
}

/** The header's facts, in the order they are read: what it is, where it lives, whether it stands. */
export function badgesOf(info: AssetInfo): string[] {
  const badges = [info.kind, info.base ? 'base' : 'project'];
  if (info.accepted) badges.push('accepted');
  if (info.stale) badges.push('stale');
  if (info.suspended) badges.push('suspended');
  return badges;
}

/**
 * The drift sentence, or none. `stale` is only ever true when a derivation exists, so this says
 * what changed underneath rather than merely that something did.
 *
 * Suspension comes first because it is the stronger claim: the words may still be right, and a
 * reference the picture was drawn *against* is what moved.
 */
export function driftNote(info: AssetInfo): string {
  if (info.suspended) {
    return `Suspended — ${info.suspended}. Repin the reference or regenerate; the bytes stay either way.`;
  }
  if (!info.stale) return '';
  return 'Rendered from an older prompt — the project describes it differently now. Regenerate to catch up.';
}

/** The prompt to show: today's derivation when there is one, else whatever the bytes recorded. */
export function promptShown(info: AssetInfo): { text: string; derived: boolean } {
  if (info.derived !== undefined) return { text: info.derived, derived: true };
  if (info.prompt !== undefined) return { text: info.prompt, derived: false };
  return { text: '', derived: false };
}

/**
 * What has to be approved before a picture can be — the approval frontier, read off one asset.
 *
 * Approval flows **upstream first**: a frame composed from an unapproved plate is a frame nobody
 * has actually signed off on, because the thing under it may still be replaced. So `asset.accept`
 * refuses while any direct prerequisite is unapproved, and the pane lists them so the author can
 * walk up the chain.
 *
 * **Direct prerequisites only**, and the induction is the reason: accepting anything already
 * required its own direct prerequisites to be approved, so the closure holds at accept time. The
 * pane stays short and every row is one click from actionable.
 *
 * Three of the five arms below answer `approved: true` for something that was never approvable —
 * a portrait outside the gate, an upload, a concept, and a hash the manifest has never heard of.
 * Each mirrors a refusal `previewAccept` already gives by name: requiring an approval that cannot
 * be granted would make Approve permanently unreachable for everything drawn from one.
 */
import type { Asset, AssetKind } from '@vn/types';
import { isApproved } from './gate.js';
import { assetSlotLabel } from './describe.js';
import { slotKey, slotOf } from './refcycle.js';
import type { BindingContext } from './refs.js';
import type { RungContext } from './resolve.js';
import { upstreamOf } from './upstream.js';

/** Everything the rule reads: the manifest, the model's gate, and the rungs a pin could hang at. */
export interface PrereqContext extends BindingContext, RungContext {}

/** One picture the subject was drawn from, and whether it stands in the way of approving it. */
export interface Prereq {
  hash: string;
  /** What it is, in the project's own terms — `cafe — night plate`. */
  label: string;
  kind?: AssetKind;
  /** `slotKey` of the slot it fills, so a command can name it. A concept and an upload fill none. */
  slot?: string;
  approved: boolean;
  /** Why it counts as approved, or why it does not yet. Shown as the row's tooltip. */
  note: string;
  /** No manifest record for these bytes. Reported, deliberately not a refusal. */
  missing?: boolean;
}

/**
 * The pictures these bytes were drawn from, in the order the task fed them to the model.
 *
 * Not sorted: a frame's plate comes before its portraits before the author's pins, which is
 * meaningful. Deduped, because a two-subject shot in one outfit pins the same sheet twice.
 */
export function assetPrereqs(asset: Asset, ctx: PrereqContext): Prereq[] {
  const byHash = new Map(ctx.assets.map((a) => [a.hash, a]));
  const out: Prereq[] = [];
  const seen = new Set<string>([asset.hash]);
  for (const hash of upstreamOf(asset, ctx)) {
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push(prereqOf(hash, byHash.get(hash), ctx));
  }
  return out;
}

/** The five-arm rule, in order. */
function prereqOf(hash: string, up: Asset | undefined, ctx: PrereqContext): Prereq {
  if (!up) {
    return {
      hash,
      label: `asset ${hash.slice(0, 8)}`,
      approved: true,
      missing: true,
      note: 'Not in the manifest — there is nothing here to approve.',
    };
  }
  const slot = slotOf(up, ctx.angleOf?.(up.sourceTask));
  const base = {
    hash,
    label: assetSlotLabel(up),
    kind: up.kind,
    ...(slot ? { slot: slotKey(slot) } : {}),
  };
  switch (up.kind) {
    case 'portrait': {
      // The gate owns a portrait, and it owns it twice over: the character has to be approved, and
      // this has to be the portrait they were approved with rather than a draft beside it.
      const id = up.satisfies[0]?.characterId;
      const character = id ? ctx.model.characters.get(id) : undefined;
      const ok = !!character && isApproved(character) && character.approvedPortrait === hash;
      return {
        ...base,
        approved: ok,
        note: ok
          ? 'Approved at the character gate.'
          : `Not approved: ${id ?? 'this character'} has not cleared the character gate with these bytes.`,
      };
    }
    case 'reference':
      return { ...base, approved: true, note: 'An upload is authored input, not generated art.' };
    case 'concept':
      return {
        ...base,
        approved: true,
        note: 'A concept is a sketch — nothing downstream consumes it, so nothing approves it.',
      };
    default:
      return {
        ...base,
        approved: up.accepted,
        note: up.accepted ? 'Approved.' : 'Not approved yet.',
      };
  }
}

/**
 * The one sentence Approve is refused with, or `undefined` when nothing is in the way.
 *
 * Owned here rather than by the pane because four surfaces reach `asset.accept` — the tree's
 * right-click, the palette, the agent and CDP — and a greyed button the command would happily
 * honour is a lie about the rule. The disabled control's tooltip is this string, verbatim.
 */
export function prereqRefusal(label: string, prereqs: readonly Prereq[]): string | undefined {
  const waiting = prereqs.filter((p) => !p.approved);
  const first = waiting[0];
  if (!first) return undefined;
  const more = waiting.length > 1 ? `, and ${waiting.length - 1} more` : '';
  return `Approve what ${label} was drawn from first: ${first.label} is not approved yet${more}.`;
}

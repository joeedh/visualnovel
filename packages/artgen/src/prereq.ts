/**
 * What has to be approved before a picture can be — the approval frontier, read off one asset.
 *
 * Approval flows upstream first: a frame composed from an unapproved plate is a frame nobody has
 * actually signed off on, because the thing under it may still be replaced. So `asset.accept`
 * refuses while any direct prerequisite is unapproved, and the pane lists them so the author can
 * walk up the chain.
 *
 * Only direct prerequisites are read. Accepting anything already required its own direct
 * prerequisites to be approved, so the closure holds at accept time. The pane stays short and every
 * row is one click from actionable.
 *
 * Three things count as approved that nobody ever approved — an upload, a concept, and a hash the
 * manifest has never heard of. Each mirrors a refusal `previewAccept` already gives by name:
 * requiring an approval that cannot be granted would make Approve permanently unreachable for
 * everything drawn from one. What "approved" means otherwise is {@link assetApproved}.
 */
import type { Asset, AssetKind, ProjectModel } from '@vn/types';
import { isApproved } from './gate.js';
import { assetSlotLabel } from './describe.js';
import { slotOf } from './refcycle.js';
import { slotKey } from './slotaddr.js';
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
 * Whether a human has blessed these bytes — the one predicate, so no two surfaces can disagree
 * about what "approved" means.
 *
 * Asymmetric on purpose. A portrait answers to the P3 gate and never to `accepted`, and twice over:
 * the character has to be approved and these have to be the bytes they were approved with, so a
 * draft filed beside the approved one does not count. A concept and an upload were never approvable
 * at all, so they count as approved rather than blocking forever.
 */
export function assetApproved(asset: Asset, model: ProjectModel): boolean {
  switch (asset.kind) {
    case 'portrait': {
      const id = asset.satisfies[0]?.characterId;
      const character = id ? model.characters.get(id) : undefined;
      return !!character && isApproved(character) && character.approvedPortrait === asset.hash;
    }
    case 'reference':
    case 'concept':
      return true;
    default:
      return asset.accepted;
  }
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
  const approved = assetApproved(up, ctx.model);
  const base = {
    hash,
    label: assetSlotLabel(up),
    kind: up.kind,
    ...(slot ? { slot: slotKey(slot) } : {}),
    approved,
  };
  // One verdict with four wordings: the arms differ only in the reason, which is the row's tooltip
  switch (up.kind) {
    case 'portrait':
      return {
        ...base,
        note: approved
          ? 'Approved at the character gate.'
          : `Not approved: ${up.satisfies[0]?.characterId ?? 'this character'} has not cleared the character gate with these bytes.`,
      };
    case 'reference':
      return { ...base, note: 'An upload is authored input, not generated art.' };
    case 'concept':
      return {
        ...base,
        note: 'A concept is a sketch — nothing downstream consumes it, so nothing approves it.',
      };
    default:
      return { ...base, note: approved ? 'Approved.' : 'Not approved yet.' };
  }
}

/**
 * The one sentence Approve is refused with, or `undefined` when nothing is in the way.
 *
 * Owned here rather than by the pane because four surfaces reach `asset.accept` — the tree's
 * right-click, the palette, the agent and CDP — and a greyed button for a command that would in
 * fact accept misstates the rule. The disabled control's tooltip is this string, verbatim.
 */
export function prereqRefusal(label: string, prereqs: readonly Prereq[]): string | undefined {
  const waiting = prereqs.filter((p) => !p.approved);
  const first = waiting[0];
  if (!first) return undefined;
  const more = waiting.length > 1 ? `, and ${waiting.length - 1} more` : '';
  return `Approve what ${label} was drawn from first: ${first.label} is not approved yet${more}.`;
}

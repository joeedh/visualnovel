/**
 * The asset editor's decisions, made before it draws: which command approves the asset on screen,
 * what the header's badges say, and how staleness is worded.
 *
 * These are pure functions so they can be tested here. The desktop jest project is node-only and
 * the pane itself can only be checked live over CDP, so the rules are kept out of the markup.
 */
import type { AssetInfo, PropValue } from '../../src/shared/ipc.js';

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

/**
 * The approve button: which command it runs, or why there is nothing for it to run. A refusal
 * still names the command it is about, so a tour asked for that command can ring the greyed
 * button and say this sentence rather than reporting the button as missing.
 */
export type ApproveAction =
  | { ok: true; id: string; props: Record<string, string>; label: string }
  | { ok: false; reason: string; id: string };

/**
 * A portrait is approved through the gate and nothing else. `gate.approve` also writes
 * `character.md` and `approved.png`, which is what clears the character, so the pane offers that
 * command rather than the generic `asset.accept` the command itself would refuse. A concept and an
 * upload have no approval at all: nothing consumes a concept, and nothing generated an upload.
 *
 * Approval also flows upstream-first, and that refusal is placed ahead of the portrait split so it
 * gates both paths. The sentence comes from main (`previewAccept` refuses `asset.accept` with the
 * same one) so a greyed button states the same rule the command enforces.
 *
 * A picture already approved offers the other direction instead. Approving it again writes what
 * the manifest already says, so the one act left on it is taking that approval back — and the
 * upstream refusal is not consulted for it, since nothing upstream is at stake in undoing one.
 */
export function approveAction(info: AssetInfo): ApproveAction {
  // Which command a refusal below is about: a look goes through the gate, everything else is
  // accepted directly.
  const approving = info.kind === 'portrait' ? 'gate.approve' : 'asset.accept';
  if (info.kind === 'concept') {
    return {
      ok    : false,
      id    : approving,
      reason: 'A concept is a sketch — nothing downstream consumes one. Promote it to a plate.',
    };
  }
  if (info.kind === 'reference') {
    return {
      ok    : false,
      id    : approving,
      reason:
        'An upload is not generated art — it counts by being pointed at, not by being blessed.',
    };
  }
  if (info.accepted) {
    return {
      ok   : true,
      id   : 'asset.unapprove',
      props: { hash: info.hash },
      label: 'Un-approve',
    };
  }
  if (info.unapproved) return { ok: false, id: approving, reason: info.unapproved };
  // An older take, which a later render pushed out of its slot. Accepting one has to put it back
  // as well: the flag alone would leave the slot naming the later render, so the runner and the
  // exporter would go on using it and the click would appear to do nothing. A portrait is left
  // out for the reason it is left out below — an earlier look goes back through the gate.
  if (info.newerTake !== undefined && info.kind !== 'portrait') {
    return { ok: true, id: 'asset.restore', props: { hash: info.hash }, label: 'Accept' };
  }
  if (info.kind !== 'portrait') {
    return { ok: true, id: 'asset.accept', props: { hash: info.hash }, label: 'Accept' };
  }
  const characterId = characterOf(info);
  if (characterId === '') {
    return {
      ok    : false,
      id    : approving,
      reason: 'This portrait names no character — approve it from the gate.',
    };
  }
  return {
    ok   : true,
    id   : 'gate.approve',
    props: { characterId, hash: info.hash },
    label: 'Approve',
  };
}

/**
 * The promote control: `art.promote` on this concept, or why it cannot run. The variant id is not
 * here because it is not known until it is typed — the strip records it as a supplied prop.
 */
export type PromoteAction =
  | {
      ok: true;
      id: string;
      props: Record<string, PropValue>;
      label: string;
      /** The place the plate is for, which is what the strip says above its field. */
      locationId: string;
      /**
       * The variant ids that place already has. Offered beside the field rather than in place of
       * it: promoting to a name the sheet does not carry yet is the other half of what the control
       * does. Empty when the location has no variants, and then no picker is drawn.
       */
      variants: string[];
    }
  | { ok: false; reason: string; id: string };

/**
 * Only a concept is promotable, and only one bound to a location. Promoting a character concept
 * would bypass the approval gate, which owns `character.md` and `approved.png`.
 */
export function promoteAction(info: AssetInfo): PromoteAction {
  if (info.kind !== 'concept') {
    return {
      ok    : false,
      id    : 'art.promote',
      reason: `A ${info.kind} is already what it is — only a concept promotes.`,
    };
  }
  if (characterOf(info) !== '') {
    return {
      ok    : false,
      id    : 'art.promote',
      reason:
        "That is a concept of a character, and a character's look goes through the approval gate.",
    };
  }
  const locationId = locationOf(info);
  if (locationId === '') {
    return {
      ok    : false,
      id    : 'art.promote',
      reason: 'This concept names no location, so there is no sheet to write to.',
    };
  }
  return {
    ok   : true,
    id   : 'art.promote',
    props: { hash: info.hash },
    label: 'Promote',
    locationId,
    variants: info.locationVariants ?? [],
  };
}

/** The prop the promote strip's field fills in, which is not known until it is typed. */
export const PROMOTE_SUPPLIES = ['variant'];

/** The props the two boxes in a rung fill in — the art direction, and the seed to draw it from. */
export const NOTES_SUPPLIES = ['notes'];
export const SEED_SUPPLIES = ['seed'];

/**
 * The `data-anchor` on the concept prompt box, which the `⇱` of a `request` chunk scrolls to.
 * Every `data-anchor` in the app is `<kind>/<key>`, and this one's key is the box itself.
 */
export const REQUEST_ANCHOR = 'request/prompt';

/** The replace strip: the slot a chosen file would fill, or why these bytes have none. */
export type ReplaceAction =
  | {
      ok: true;
      id: string;
      props: Record<string, PropValue>;
      label: string;
      /** The slot the file stands in for, which the strip names beside its button. */
      slot: string;
    }
  | { ok: false; reason: string; id: string };

/**
 * A file can only stand in for a picture the project actually planned, and only while the asset on
 * screen still holds that slot. `AssetInfo.slot` is absent for a concept, an upload and a
 * superseded render alike. A portrait is the one live slot this declines, because replacing a look
 * is approving one and approval belongs to the gate. Both refusals restate `adoptionForSlot`'s.
 */
export function replaceAction(info: AssetInfo): ReplaceAction {
  if (info.slot === undefined) {
    return {
      ok    : false,
      id    : 'asset.replace',
      reason: `A ${info.kind} fills no slot — nothing planned it, or a newer render holds the slot now.`,
    };
  }
  if (info.slot.startsWith('portrait:')) {
    return {
      ok    : false,
      id    : 'asset.replace',
      reason:
        'A portrait is the look the gate owns — upload the file, then approve it with gate.approve.',
    };
  }
  return {
    ok   : true,
    id   : 'asset.replace',
    props: { hash: info.hash },
    label: 'Replace with a file…',
    slot : info.slot,
  };
}

/**
 * The redraw strip: what the boxes start out holding, or why this prompt cannot be edited. The
 * words themselves are supplied by the boxes at commit time, so `props` carries only the subject.
 */
export type RedrawAction =
  | {
      ok: true;
      id: string;
      props: Record<string, PropValue>;
      label: string;
      /** What the two boxes are prefilled with. */
      prompt: string;
      title: string;
    }
  | { ok: false; reason: string; id: string };

/**
 * A concept is the one asset whose prompt is authored: nothing derives it, so nothing rewrites it
 * on the next planning pass and an edit survives. Every other kind's prompt is a derivation folded
 * into the task hash; art notes are how those change, and `asset.regenerate` re-runs them.
 *
 * The prompt comes back whole rather than as an empty box, so the style preamble and the
 * framing sentence survive an edit by default.
 */
export function promptEditable(info: AssetInfo): RedrawAction {
  if (info.kind !== 'concept') {
    return {
      ok    : false,
      id    : 'art.redraw',
      reason: `A ${info.kind}'s prompt is composed from the project on every planning pass — edit it a clause at a time below, not as one string.`,
    };
  }
  return {
    ok    : true,
    id    : 'art.redraw',
    props : { hash: info.hash },
    label : 'Redraw',
    prompt: info.prompt ?? '',
    title : info.title ?? '',
  };
}

/** The prop names the redraw boxes fill in, which no anchor can record before they are typed. */
export const REDRAW_SUPPLIES = ['prompt', 'title'];

/**
 * The Regenerate button: requeue this asset's own task, or offer to run the pipeline instead.
 * Both carry the invocation, so the button and the anchor read the same object; the `pipeline`
 * act reaches it through a form, because what the author confirms there is the work and its cost.
 */
export type RegenerateAction =
  | { act: 'requeue'; id: string; props: Record<string, PropValue>; label: string; hint: string }
  | {
      act: 'pipeline';
      id: string;
      props: Record<string, PropValue>;
      label: string;
      hint: string;
      note: string;
    };

/**
 * Which of the two acts Regenerate performs. A stale asset's own task is an orphan — the prompt
 * moved on, so the planner wants a different hash — and `asset.regenerate` refuses it. The picture
 * the author is asking for still exists, as the fresh task planning already made, so the button
 * offers the run that reaches it rather than reporting a refusal and stopping.
 *
 * A stale asset whose slot has since failed is the exception, and it is checked first for the
 * reason main checks it first: the task to re-run is the one that gave up, and no run reaches it
 * once its retry budget is spent. The order here mirrors `regeneration` in `main/session.ts`.
 * Refusals that need the graph (an asset recording no task, unavailable base assets) are left to
 * the command, which is the only side that can see one.
 */
export function regenerateAction(info: AssetInfo): RegenerateAction {
  const requeue = {
    act  : 'requeue',
    id   : 'asset.regenerate',
    props: { hash: info.hash, run: true },
    label: 'Regenerate',
    hint : 'Requeue the task behind these bytes and run the pipeline',
  } as const;
  if (info.failure?.later) return requeue;
  if (!info.stale) return requeue;
  return {
    act  : 'pipeline',
    id   : 'pipeline.run',
    props: { mock: false },
    label: 'Regenerate',
    hint: 'Offer a pipeline run: this picture is behind the project, and the task that catches it up is already planned',
    note:
      `${info.label} was rendered from a prompt the project has since changed, so re-running its own ` +
      'task would draw the picture you edited away from. A fresh task is already planned for it, and ' +
      'a run is what reaches it. Dry run is unticked because Regenerate asked for the picture rather ' +
      'than a preview of the work.',
  };
}

/** The Task button: hand a task to the inspector, or say there is no task to hand over. */
export type TaskAction =
  | {
      ok: true;
      id: string;
      props: Record<string, PropValue>;
      label: string;
      /**
       * `ShellState` fields to publish before the pane opens. The ordering is load-bearing for the
       * reason `originAction`'s is: the new pane reads the selection on its first `update()`.
       */
      publish: Record<string, string>;
    }
  | { ok: false; reason: string; id: string };

/**
 * The inspector is the pane that reads attempts, and `view.open` has one `subject` while this
 * needs a task hash in the selection — so the act is a publish followed by an open, not one
 * command carrying both.
 */
export function taskAction(taskHash: string | undefined): TaskAction {
  if (taskHash === undefined || taskHash === '') {
    return {
      ok    : false,
      id    : 'view.open',
      reason: 'The manifest records no task for this asset.',
    };
  }
  return {
    ok     : true,
    id     : 'view.open',
    props  : { editor: 'inspector', where: 'elsewhere' },
    label  : 'Task',
    publish: { taskHash },
  };
}

/** Whether a pane follows its slot, and where to. */
export interface SlotWatch {
  /** Carry this back into the next call. */
  holding: boolean;
  /** The asset to move to, or an empty string to stay. */
  follow: string;
}

/**
 * Where a pane goes when the slot it is watching has been filled again.
 *
 * Only the take that held the slot follows: an author who walked back to an earlier one asked for
 * that one, and a jump forward would undo the walk. Which take that is gets decided when the pane
 * arrives on an asset and then kept, because an authored edit re-keys the slot and leaves it empty
 * until something renders. Deciding again inside that window would read every take as the one in
 * the slot, walked-back ones included.
 */
export function watchSlot(was: AssetInfo | undefined, now: AssetInfo, holding: boolean): SlotWatch {
  const held = was?.hash === now.hash ? holding : now.newerTake === undefined;
  return { holding: held, follow: held ? (now.newerTake ?? '') : '' };
}

/** The header's badges, in display order: the kind, the store it lives in, then its status. */
export function badgesOf(info: AssetInfo): string[] {
  const badges = [info.kind, info.base ? 'base' : 'project'];
  if (info.accepted) badges.push('accepted');
  if (info.stale) badges.push('stale');
  if (info.suspended) badges.push('suspended');
  return badges;
}

/**
 * The failure sentence, or an empty string. Four cases, because two things vary: whether the
 * pipeline hit a fault or asked for a human, and whether the task that gave up is the one these
 * bytes came from or a later re-render of the same slot.
 *
 * The retry budget is quoted for a fault only. A `needs_human` shot records one attempt per P7
 * refine pass and none of them carries an error, so counting them against the budget would report
 * a frame reviewed four times as having been tried zero times out of two.
 */
export function failureNote(info: AssetInfo): string {
  const failure = info.failure;
  if (!failure) return '';
  const why = failure.error ?? 'no reason was recorded';
  const tries = `${failure.attempts} of ${failure.maxAttempts} attempts`;
  if (failure.later) {
    const what =
      failure.status === 'failed'
        ? `The re-render failed after ${tries} — ${why}.`
        : `The re-render was flagged for a human — ${why}.`;
    return `${what} What is on screen is the last frame that got through. Regenerate to run the new prompt again — no run will reach it on its own.`;
  }
  if (failure.status === 'failed') {
    return `Generating this failed after ${tries} — ${why}. Regenerate to try again.`;
  }
  return `Flagged for a human — ${why}. Accept it as it stands, or change the art notes and regenerate.`;
}

/**
 * The drift sentence, or an empty string. `stale` is only ever true when a derivation exists, so
 * this says what changed underneath rather than merely that something did.
 *
 * Suspension is reported first because it is the stronger claim: the words may still be right, and
 * a reference the picture was drawn against is what moved.
 */
export function driftNote(info: AssetInfo): string {
  if (info.suspended) {
    return `Suspended — ${info.suspended}. Repin the reference or regenerate; the bytes stay either way.`;
  }
  if (!info.stale) return '';
  // A failed re-render already reports that the project moved on, and already says what to do
  // about it, so this would repeat both about the attempt to catch up
  if (info.failure?.later) return '';
  return 'Rendered from an older prompt — the project describes it differently now. Regenerate to catch up.';
}

/** The prompt to show. Today's derivation if there is one, otherwise the one the bytes recorded. */
export function promptShown(info: AssetInfo): { text: string; derived: boolean } {
  if (info.derived !== undefined) return { text: info.derived, derived: true };
  if (info.prompt !== undefined) return { text: info.prompt, derived: false };
  return { text: '', derived: false };
}

/**
 * Why this picture is not moving, or null when nothing is holding it up. Three states qualify, in
 * the order a reader needs them: the task gave up, something upstream is unapproved, or a
 * reference it was drawn against has moved.
 *
 * Every sentence here is written elsewhere — by the pipeline, by `asset.accept`'s refusal, by the
 * suspension check — so the header's marker cannot say something the body contradicts. It is a
 * summary for the header, not a fourth opinion.
 */
export function blockedNote(info: AssetInfo): string | null {
  if (info.failure) return failureNote(info);
  if (info.unapproved) return info.unapproved;
  if (info.suspended) return info.suspended;
  return null;
}

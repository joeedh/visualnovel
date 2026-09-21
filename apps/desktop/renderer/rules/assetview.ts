/**
 * The asset editor's decisions, made before it draws: which command approves the asset on screen,
 * what the header's badges say, and how staleness is worded.
 *
 * These are pure functions so they can be tested here. The desktop jest project is node-only and
 * the pane itself can only be checked live over CDP, so the rules are kept out of the markup.
 */
import type { ArtRungInfo, AssetFailure, AssetInfo, Prereq } from '../../src/shared/ipc.js';
import { refuse, type Offer } from './anchors.js';
import { openMenu, publish, view } from './effects.js';

/** The two halves of an {@link Offer}, for a control that carries more on one of them. */
type Accepted = Extract<Offer, { ok: true }>;
type Refused = Extract<Offer, { ok: false }>;

/** The refusal a bar control carries while no asset is on screen, still naming what it would run. */
const nothingShown = (control: Pick<Offer, 'id' | 'label' | 'tooltip'>): Refused => ({
  ...refuse('No asset is on screen.'),
  ...control,
});

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

/** What accepting says, by the command it runs. The gate's sentence names what the gate writes. */
const APPROVE_TOOLTIPS = {
  'asset.accept'   : 'Accept these bytes for use downstream',
  'gate.approve'   : 'Approve this look at the gate, which is what clears the character',
  'asset.unapprove':
    'Take approval back off these bytes, leaving what they answered unanswered again',
  'asset.restore':
    'Put this take back in its slot and accept it, superseding the one that replaced it',
} as const;

type ApproveId = keyof typeof APPROVE_TOOLTIPS;

/**
 * The approve button: which command it runs, or why there is nothing for it to run. A refusal
 * still names the command it is about, so a tour asked for that command can ring the greyed
 * button and say this sentence rather than reporting the button as missing.
 *
 * A portrait is approved through the gate and nothing else. `gate.approve` holds the take as well
 * as accepting it, which is what clears the character, so the pane offers that command rather
 * than the generic `asset.accept` the command itself would refuse. A concept and an
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
export function approveAction(info: AssetInfo | undefined): Offer {
  if (!info) {
    return nothingShown({
      id     : 'asset.accept',
      label  : 'Approve',
      tooltip: APPROVE_TOOLTIPS['asset.accept'],
    });
  }
  // Which command a refusal below is about: a look goes through the gate, everything else is
  // accepted directly.
  const approving: ApproveId = info.kind === 'portrait' ? 'gate.approve' : 'asset.accept';
  const no = (reason: string): Offer => ({
    ...refuse(reason),
    id     : approving,
    label  : 'Approve',
    tooltip: APPROVE_TOOLTIPS[approving],
  });
  const yes = (id: ApproveId, label: string, props: Record<string, string>): Offer => ({
    ok: true,
    id,
    props,
    label,
    tooltip: APPROVE_TOOLTIPS[id],
  });
  if (info.kind === 'concept') {
    return no('A concept is a sketch — nothing downstream consumes one. Promote it to a plate.');
  }
  if (info.kind === 'reference') {
    return no(
      'An upload is not generated art — it counts by being pointed at, not by being blessed.',
    );
  }
  if (info.approved) return yes('asset.unapprove', 'Un-approve', { hash: info.hash });
  if (info.unapproved) return no(info.unapproved);
  // An older take, which a later render pushed out of its slot. Accepting one has to put it back
  // as well: the flag alone would leave the slot naming the later render, so the runner and the
  // exporter would go on using it and the click would appear to do nothing. A portrait is left
  // out for the reason it is left out below — an earlier look goes back through the gate.
  if (info.newerTake !== undefined && info.kind !== 'portrait') {
    return yes('asset.restore', 'Accept', { hash: info.hash });
  }
  if (info.kind !== 'portrait') return yes('asset.accept', 'Accept', { hash: info.hash });
  const characterId = characterOf(info);
  if (characterId === '') return no('This portrait names no character — approve it from the gate.');
  return yes('gate.approve', 'Approve', { characterId, hash: info.hash });
}

/**
 * The promote control: `art.promote` on this concept, or why it cannot run. The variant id is not
 * here because it is not known until it is typed — the strip's field supplies it.
 */
export type PromoteAction =
  | (Accepted & {
      /** The place the plate is for, which is what the strip says above its field. */
      locationId: string;
      /**
       * The variant ids that place already has. Offered beside the field rather than in place of
       * it: promoting to a name the sheet does not carry yet is the other half of what the control
       * does. Empty when the location has no variants, and then no picker is drawn.
       */
      variants: string[];
    })
  | Refused;

/**
 * Only a concept is promotable, and only one bound to a location. Promoting a character concept
 * would bypass the approval gate, which owns `character.md` and `approved.png`.
 */
export function promoteAction(info: AssetInfo): PromoteAction {
  const control = {
    id      : 'art.promote',
    label   : 'Promote',
    tooltip : 'Make this sketch the plate for that variant, so the next run adopts it',
    supplies: ['variant'],
  };
  if (info.kind !== 'concept') {
    return {
      ...refuse(`A ${info.kind} is already what it is — only a concept promotes.`),
      ...control,
    };
  }
  if (characterOf(info) !== '') {
    return {
      ...refuse(
        "That is a concept of a character, and a character's look goes through the approval gate.",
      ),
      ...control,
    };
  }
  const locationId = locationOf(info);
  if (locationId === '') {
    return {
      ...refuse('This concept names no location, so there is no sheet to write to.'),
      ...control,
    };
  }
  return {
    ok   : true,
    props: { hash: info.hash },
    ...control,
    locationId,
    variants: info.locationVariants ?? [],
  };
}

/**
 * The `data-anchor` on the concept prompt box, which the `⇱` of a `request` chunk scrolls to.
 * Every `data-anchor` in the app is `<kind>/<key>`, and this one's key is the box itself.
 */
export const REQUEST_ANCHOR = 'request/prompt';

/** The replace strip: the slot a chosen file would fill, or why these bytes have none. */
export type ReplaceAction =
  | (Accepted & {
      /** The slot the file stands in for, which the strip names beside its button. */
      slot: string;
    })
  | Refused;

/**
 * A file can only stand in for a picture the project actually planned, and only while the asset on
 * screen still holds that slot. `AssetInfo.slot` is absent for a concept, an upload and a
 * superseded render alike. A portrait is the one live slot this declines, because replacing a look
 * is approving one and approval belongs to the gate. Both refusals restate `adoptionForSlot`'s.
 */
export function replaceAction(info: AssetInfo): ReplaceAction {
  const label = 'Replace with a file…';
  if (info.slot === undefined) {
    return {
      ...refuse(
        `A ${info.kind} fills no slot — nothing planned it, or a newer render holds the slot now.`,
      ),
      id: 'asset.replace',
      label,
      tooltip: 'Choose a file and let it stand in for this picture from now on',
    };
  }
  if (info.slot.startsWith('portrait:')) {
    return {
      ...refuse(
        'A portrait is the look the gate owns — upload the file, then approve it with gate.approve.',
      ),
      id: 'asset.replace',
      label,
      tooltip: `Choose a file and let it stand in for ${info.slot} from now on`,
    };
  }
  return {
    ok   : true,
    id   : 'asset.replace',
    props: { hash: info.hash },
    label,
    tooltip: `Choose a file and let it stand in for ${info.slot} from now on`,
    slot   : info.slot,
  };
}

/**
 * The redraw strip: what the boxes start out holding, or why this prompt cannot be edited. The
 * words themselves are supplied by the boxes at commit time, so `props` carries only the subject.
 */
export type RedrawAction =
  | (Accepted & {
      /** What the two boxes are prefilled with. */
      prompt: string;
      title: string;
    })
  | Refused;

/**
 * A concept is the one asset whose prompt is authored: nothing derives it, so nothing rewrites it
 * on the next planning pass and an edit survives. Every other kind's prompt is a derivation folded
 * into the task hash; art notes are how those change, and `asset.regenerate` re-runs them.
 *
 * The prompt comes back whole rather than as an empty box, so the style preamble and the
 * framing sentence survive an edit by default.
 */
export function promptEditable(info: AssetInfo): RedrawAction {
  const control = {
    id      : 'art.redraw',
    label   : 'Redraw',
    tooltip : 'Draw this sketch again from the prompt below, as a new one beside it',
    supplies: ['prompt', 'title'],
  };
  if (info.kind !== 'concept') {
    return {
      ...refuse(
        `A ${info.kind}'s prompt is composed from the project on every planning pass — edit it a clause at a time below, not as one string.`,
      ),
      ...control,
    };
  }
  return {
    ok   : true,
    props: { hash: info.hash },
    ...control,
    prompt: info.prompt ?? '',
    title : info.title ?? '',
  };
}

/**
 * The Regenerate button: requeue this asset's own task, or offer to run the pipeline instead.
 * Both carry the invocation, so the button and the anchor read the same object; the `pipeline`
 * act reaches it through a form, because what the author confirms there is the work and its cost.
 * The tooltip is the only place the author can find out which of the two a click is.
 */
export type RegenerateAction =
  | (Accepted & { act: 'requeue' })
  | (Accepted & {
      act: 'pipeline';
      /** What the run's form opens saying, so the author confirms the work rather than a refusal. */
      note: string;
    })
  | Refused;

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
export function regenerateAction(info: AssetInfo | undefined): RegenerateAction {
  const label = 'Regenerate';
  const requeues = 'Requeue the task behind these bytes and run the pipeline';
  if (!info) return nothingShown({ id: 'asset.regenerate', label, tooltip: requeues });
  const requeue = {
    ok   : true,
    act  : 'requeue',
    id   : 'asset.regenerate',
    props: { hash: info.hash, run: true },
    label,
    tooltip: requeues,
  } as const;
  if (info.failure?.later) return requeue;
  if (!info.stale) return requeue;
  return {
    ok   : true,
    act  : 'pipeline',
    id   : 'pipeline.run',
    props: { mock: false },
    label,
    tooltip:
      'Offer a pipeline run: this picture is behind the project, and the task that catches it up is already planned',
    note:
      `${info.label} was rendered from a prompt the project has since changed, so re-running its own ` +
      'task would draw the picture you edited away from. A fresh task is already planned for it, and ' +
      'a run is what reaches it. Dry run is unticked because Regenerate asked for the picture rather ' +
      'than a preview of the work.',
  };
}

/** The Task button: hand a task to the inspector, or say there is no task to hand over. */
export type TaskAction =
  | (Accepted & {
      /**
       * `ShellState` fields to publish before the pane opens. The ordering is load-bearing for the
       * reason `originAction`'s is: the new pane reads the selection on its first `update()`.
       */
      publish: Record<string, string>;
    })
  | Refused;

/**
 * The inspector is the pane that reads attempts, and `view.open` has one `subject` while this
 * needs a task hash in the selection — so the act is a publish followed by an open, not one
 * command carrying both.
 */
export function taskAction(taskHash: string | undefined): TaskAction {
  const control = {
    id     : 'view.open',
    label  : 'Task',
    tooltip: 'Show the task that produced this asset in the inspector',
  };
  if (taskHash === undefined || taskHash === '') {
    return { ...refuse('The manifest records no task for this asset.'), ...control };
  }
  return {
    ok   : true,
    props: { editor: 'inspector', where: 'elsewhere' },
    ...control,
    publish: { taskHash },
  };
}

/** Save a copy of the bytes on screen somewhere the author picks. The project is not touched. */
export function exportAction(info: AssetInfo | undefined): Offer {
  const control = {
    id     : 'asset.export',
    label  : 'Download',
    tooltip: 'Save a copy of this picture wherever you like. The project is not touched',
  };
  if (!info) return { ...refuse('No picture on screen to save'), ...control };
  return { ok: true, props: { hash: info.hash }, ...control };
}

/** Open a conversation about the failure on screen, with what it said already in the composer. */
export function fixAction(info: AssetInfo): Offer {
  return {
    ok     : true,
    id     : 'agent.fixAsset',
    props  : { hash: info.hash },
    label  : 'Fix with agent',
    tooltip:
      'Open a conversation about this failure, with what it said already in the composer. Nothing is sent',
  };
}

/**
 * Open the task that gave up in the inspector. The bar's Task button offers the same command on
 * the asset's own task; this one is told apart by the task that failed, which for a re-render is
 * a different task from the one these bytes came from.
 */
export function failureTaskAction(info: AssetInfo, failure: AssetFailure): Offer {
  return {
    ...taskAction(failure.task),
    on     : failure.task,
    label  : 'Show task',
    tooltip:
      failure.task === info.sourceTask
        ? 'Open this task in the inspector, where its attempts are listed'
        : 'Open the task that gave up in the inspector — a re-render, not the one these bytes came from',
  };
}

/** One rung's art notes box. The label is the box's placeholder; the box supplies the notes. */
export function notesAction(rung: ArtRungInfo): Offer {
  return {
    ok      : true,
    id      : 'art.setNotes',
    props   : { target: rung.target },
    label   : 'e.g. sodium streetlight raking across the formwork',
    tooltip: `Say how ${rung.label} should look. Appended to the prompt, so saving re-renders what this rung reaches on the next run.`,
    on      : rung.target,
    supplies: ['notes'],
  };
}

/**
 * One rung's seed box. The placeholder shows the seed that would be used instead, since an empty
 * box is the only way to say "inherit", and the tooltip says where it comes from.
 */
export function seedAction(rung: ArtRungInfo, configSeed?: number): Offer {
  return {
    ok      : true,
    id      : 'art.setSeed',
    props   : { target: rung.target },
    label   : configSeed === undefined ? 'seed' : String(configSeed),
    tooltip:
      `Draw ${rung.label} from this seed instead. Saving re-renders what this rung reaches on ` +
      'the next run — same words, different picture. Empty inherits ' +
      (configSeed === undefined
        ? 'the wider rung, then the model’s own choice.'
        : `${configSeed}.`),
    on      : rung.target,
    supplies: ['seed'],
  };
}

/**
 * One rung's image-model picker. The rows are the catalog's, with an inherit row first; the model
 * is not in the task hash, so picking one changes nothing on screen until the picture is
 * regenerated, and the tooltip says so.
 */
export function modelAction(rung: ArtRungInfo, projectModel?: string): Offer {
  return {
    ok      : true,
    id      : 'art.setModel',
    props   : { target: rung.target },
    label   : rung.imageModel ?? (projectModel === undefined ? 'model' : `(${projectModel})`),
    tooltip:
      `Draw ${rung.label} with this image model instead of the project's. Pictures already ` +
      'drawn stay; Regenerate draws with it. Inherit takes ' +
      (projectModel === undefined ? 'the wider rung, then the project.' : `${projectModel}.`),
    on      : rung.target,
    supplies: ['model'],
  };
}

/** The promote strip's variant field, beside `promoteAction`; the label is its placeholder. */
export function promoteBox(info: AssetInfo): Offer {
  return {
    ...promoteAction(info),
    on     : 'variant',
    label  : 'variant id, e.g. dawn',
    tooltip: 'Which variant of the location these bytes become the plate for',
  };
}

/** The redraw strip's prompt box, beside `promptEditable`. */
export function redrawBox(info: AssetInfo): Offer {
  return {
    ...promptEditable(info),
    on     : 'prompt',
    tooltip: 'Edit the words this sketch is drawn from. Redraw sends them.',
  };
}

/** The redraw strip's own button, told apart from the bar's Redraw. */
export function redrawGo(info: AssetInfo): Offer {
  return {
    ...promptEditable(info),
    on     : 'go',
    tooltip: 'Spend one image call on this prompt and file the result as a new sketch',
  };
}

/**
 * One prerequisite row: click to retarget this pane on the picture it names, which is what a
 * `wrong-subject` step is sent here to do. Bytes the manifest has no record of are refused with
 * the note that says so.
 */
export function prereqAction(p: Prereq): Offer {
  const control = { on: `asset/${p.hash}`, label: p.label };
  if (p.missing) {
    return { ...refuse(p.note), id: 'ui.publish', ...control, tooltip: `Open ${p.label} here` };
  }
  return {
    ok: true,
    ...publish({ assetHash: p.hash }),
    ...control,
    tooltip: `${p.note} Click to open ${p.label} in this pane.`,
  };
}

/**
 * The bar's `⋯`, which drops down the same menu the tree's right-click gives this asset. Refused
 * while nothing is on screen, since the menu is built from the shown asset.
 */
export function menuAction(info: AssetInfo | undefined): Offer {
  const control = { ...openMenu('tree'), label: '⋯' };
  if (!info) {
    return {
      ...refuse('No asset is on screen, so there is nothing for the menu to act on.'),
      ...control,
      tooltip: 'Everything this asset can be told to do',
    };
  }
  return { ok: true, ...control, tooltip: 'Everything this asset can be told to do' };
}

/** The bar's `⟳`. */
export function reloadAction(): Offer {
  return {
    ok: true,
    ...view('reload'),
    on     : 'reload',
    label  : '⟳',
    tooltip: 'Re-read this asset from the manifest',
  };
}

/**
 * The `← back` chip at the head of DRAWN FROM, drawn on the one hop a prerequisite row made.
 * `hash` is the picture the pane came from, and the chip retargets the pane on it.
 */
export function backAction(hash: string): Offer {
  return {
    ok: true,
    ...publish({ assetHash: hash }),
    on     : 'back',
    label  : '← back',
    tooltip: 'Back to the picture you came here from',
  };
}

/**
 * Every offer the asset editor draws from this module, in the order it draws them: the bar's
 * six, then the body's strips and their fields, the failure band's two, each rung's two boxes,
 * the back chip while there is a hop to undo, and one row per prerequisite. With nothing on
 * screen the bar's buttons other than `⟳` are refusals. A strip's fields are listed only while the
 * strip is drawn, which is when its offer is accepted. `back` is the hash of the picture the
 * pane came from, or `''` when it came from nowhere.
 */
export function controls(info: AssetInfo | undefined, back = ''): readonly Offer[] {
  const bar = [
    approveAction(info),
    regenerateAction(info),
    taskAction(info?.sourceTask),
    exportAction(info),
    menuAction(info),
    reloadAction(),
  ];
  if (!info) return bar;
  const promote = promoteAction(info);
  const redraw = promptEditable(info);
  return [
    ...bar,
    promote,
    replaceAction(info),
    redraw,
    ...(promote.ok ? [promoteBox(info)] : []),
    ...(redraw.ok ? [redrawBox(info), redrawGo(info)] : []),
    ...(info.failure ? [failureTaskAction(info, info.failure), fixAction(info)] : []),
    ...info.rungs.flatMap((rung) => [
      notesAction(rung),
      seedAction(rung, info.configSeed),
      modelAction(rung, info.projectModel),
    ]),
    ...(back === '' ? [] : [backAction(back)]),
    ...info.prereqs.map(prereqAction),
  ];
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
  if (info.approved) badges.push('accepted');
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

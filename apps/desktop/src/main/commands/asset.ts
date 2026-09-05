/**
 * Commands over one generated asset: reading it, accepting it, re-rendering it.
 *
 * The namespace is deliberately generic — it addresses a hash, not a character or a shot — because
 * the manifest is the one place every kind of generated art meets. What an asset should look like
 * is authored input instead, and lives in `art.setNotes`.
 */
import { defineFor, prop, type CheckResult } from '@vn/commands';
import { downloadName } from '../../shared/assetfile.js';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

/** Turns a session preview into a check result, keeping the preview's message in both cases. */
function verdict(result: { ok: boolean; message: string }): CheckResult {
  return result.ok ? { ok: true, note: result.message } : { ok: false, reason: result.message };
}

export const assetInfo = define({
  id         : 'asset.info',
  title      : 'Asset details',
  description:
    'Everything known about one generated asset: its display label and kind, which root holds ' +
    'it, whether it is accepted, the task that made it, the prompt it was rendered from, the ' +
    'prompt the builders would write today, and the art-notes rungs that reach it.',
  notes:
    'One asset: label, kind, root, accepted, its task, the prompt it was rendered from, the prompt the builders would write **today**, and the art-notes rungs reaching it.',
  mutating   : false,
  props      : { hash: prop.string('the asset hash') },
  async run({ hash }, ctx) {
    const info = await ctx.host.session.assetInfo(hash);
    if (!info) throw new Error(`No asset "${hash}" in the manifest.`);
    const drift = info.stale ? ' (rendered from an older prompt)' : '';
    return { message: `${info.label} — ${info.kind}${drift}.`, data: info };
  },
});

export const assetList = define({
  id         : 'asset.list',
  title      : 'Asset library',
  description:
    'Every asset in the manifest, with the display name the document tree gives it, its kind, ' +
    'whether it is accepted, and the picture it fills. Thin on purpose: this answers "what is ' +
    'there to choose from", and `asset.info` answers everything about one of them.',
  notes:
    'Every asset in the manifest: hash, extension, kind, display label, whether it is accepted, and the slot it fills. `asset.info` is the detailed read for one.',
  mutating   : false,
  props      : {},
  async run(_props, ctx) {
    const assets = await ctx.host.session.assetLibrary();
    return { message: `${assets.length} asset(s) in the manifest.`, data: assets };
  },
});

export const assetSuspended = define({
  id         : 'asset.suspended',
  title      : 'Suspended assets',
  description:
    'Every asset drawn against a reference that has moved, plus everything downstream of one, ' +
    'in dependency order with the reason for each. Derived on every call, never a stored flag — ' +
    'the bytes stay; suspension only says they are out of date.',
  notes:
    'Every asset drawn against a reference whose slot has moved, plus everything downstream of one, in dependency order with the reason for each. Derived on every call, never a stored flag — the bytes stay; suspension only says they are out of date.',
  mutating   : false,
  props      : {},
  async run(_props, ctx) {
    const found = await ctx.host.session.suspensions();
    return { message: `${found.length} suspended asset(s).`, data: found };
  },
});

export const assetAccept = define({
  id         : 'asset.accept',
  title      : 'Accept asset',
  description:
    'Mark this asset as the accepted one for what it satisfies. A portrait is refused by name: ' +
    'approving one also writes character.md and approved.png, which is `gate.approve`. So is a ' +
    'concept: nothing downstream consumes one, so making it count is `art.promote`.',
  notes:
    '`store.accept`, generic across both roots. A portrait is refused by name — approving one also writes `character.md` and `approved.png`, which is `gate.approve`. So is a concept: nothing downstream consumes one, so making it count is `art.promote`. And so is an upload — nothing generated it, so there is no work to bless; it counts by being pointed at. A **suspended** asset is refused too, naming what moved.',
  mutating   : true,
  props      : { hash: prop.string('the asset hash to accept') },
  async check({ hash }, ctx) {
    return verdict(await ctx.host.session.previewAccept(hash));
  },
  async run({ hash }, ctx) {
    const result = await ctx.host.session.acceptAsset(hash);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result, written: ['manifest.json'] };
  },
});

export const assetExport = define({
  id         : 'asset.export',
  title      : 'Download image…',
  description:
    "Save a copy of this picture's bytes wherever you choose. The project is not touched — the " +
    'store keeps the asset, and where the copy goes is yours. Cancelling changes nothing.',
  notes:
    "Save a copy of one asset's bytes outside the project, through the native save dialog. `mutating: false`: nothing in the workspace changes, so there is no commit and no undo point. Cancelling changes nothing.",
  mutating   : false,
  props      : { hash: prop.string('the asset to save a copy of') },
  async run({ hash }, ctx) {
    const info = await ctx.host.session.assetInfo(hash);
    if (!info) throw new Error(`No asset "${hash}" in the manifest.`);
    const file = await ctx.host.saveFile(
      {
        title      : 'Download image',
        buttonLabel: 'Save',
        defaultName: downloadName(info.label, info.hash, info.ext),
        extensions : [info.ext],
        filterName : 'Images',
      },
      ctx.origin,
    );
    if (file === undefined) return { message: 'Cancelled.' };

    const result = await ctx.host.session.exportAsset(hash, file);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result };
  },
});

export const assetRestore = define({
  id         : 'asset.restore',
  title      : 'Put this take back',
  description:
    'Make an older take the picture in its slot again, and accept it. Accepting alone only ' +
    'flips a manifest flag — the slot still names the later render, so the runner and the ' +
    'exporter go on using it. The later take stays in the store as a take of the same slot, and ' +
    'the prompt these bytes were drawn from is kept rather than restamped, so the picture goes ' +
    'on reporting the drift it really has.',
  notes:
    '`asset.adopt(replace)` followed by `asset.accept`, as one act. Refused for a take that is already the picture in its slot, for one nothing planned, and — by name — for a portrait (`gate.approve`), a concept and an upload. The suspension and upstream-approval refusals are the ones `asset.accept` would give.',
  mutating   : true,
  // Supersedes a render the project is currently using, which is the bar `asset.adopt` clears too
  confirm    : true,
  props      : { hash: prop.string('the older take to put back') },
  async check({ hash }, ctx) {
    return verdict(await ctx.host.session.previewRestore(hash));
  },
  async run({ hash }, ctx) {
    const result = await ctx.host.session.restoreAsset(hash);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result, written: result.written };
  },
});

export const assetUnapprove = define({
  id         : 'asset.unapprove',
  title      : 'Un-approve asset',
  description:
    'Take approval back off this asset, leaving what it answered unanswered again. A portrait ' +
    'goes back through the P3 gate — the character sheet’s `status:` and `approved_portrait:` ' +
    'and `approved.png` all come back out with it — and everything else is the manifest flag ' +
    '`asset.accept` set. The bytes are never touched, so the same take can be approved again.',
  mutating   : true,
  // Un-approving reopens a gate a run has already passed, which is worth one confirmation
  confirm    : true,
  props      : { hash: prop.string('the asset hash to un-approve') },
  async check({ hash }, ctx) {
    return verdict(await ctx.host.session.previewUnapprove(hash));
  },
  async run({ hash }, ctx) {
    const result = await ctx.host.session.unapproveAsset(hash);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result, written: result.written };
  },
});

export const assetUpload = define({
  id         : 'asset.upload',
  title      : 'Upload reference image',
  description:
    'Bring an image from outside into the base asset store. With no slot it is a reference: ' +
    'nothing generated it, so it is never approved and never planned — it exists only to be ' +
    'pointed at by a prompt chunk. Name a slot and the same image becomes that picture, the way ' +
    'a repainted plate should. Mock placeholder art and anything that is not an image are ' +
    'refused by name.',
  notes:
    'Bring an image from outside into the **base** store. With no `slot` it is a `reference`: nothing generated it, so it is never approved and never planned — it exists to be pointed at by `prompt.addRef`. Name a `slot` and the same act files the bytes and adopts them onto it, which is what a repainted plate wants. Mock placeholder art and anything that is not an image are refused by name; a file that lands but cannot be adopted says so and stays filed as a reference, recoverable with `asset.adopt`.',
  mutating   : true,
  // Writes bytes into the repo from a path the author named, which is worth one confirmation
  confirm    : true,
  props: {
    file   : prop.string('path to the image file (absolute, or relative to the project)'),
    title  : prop.string('what to call it on screen; empty means the filename', { default: '' }),
    slot: prop.string('the picture it becomes, e.g. plate:cafe/night; empty files a reference', {
      default: '',
    }),
    replace: prop.boolean('supersede the render already holding that slot', { default: false }),
    open   : prop.boolean('open the asset editor on it afterwards', { default: true }),
  },
  async check({ file, title, slot, replace }, ctx) {
    return verdict(await ctx.host.session.previewUpload(file, title, slot, replace));
  },
  async run({ file, title, slot, replace, open }, ctx) {
    const result = await ctx.host.session.uploadAsset(file, title, slot, replace);
    if (!result.ok) throw new Error(result.message);
    if (open && result.hash) {
      ctx.host.ui(
        {
          type   : 'view',
          action : 'open',
          editor : 'asset',
          where  : 'elsewhere',
          subject: result.hash,
        },
        ctx.origin,
      );
    }
    return { message: result.message, data: result, written: result.written };
  },
});

export const assetAdopt = define({
  id         : 'asset.adopt',
  title      : 'Adopt as a slot’s art',
  description:
    'Make an asset already in the store the output of the picture a slot names — plate:cafe/' +
    'night, sheet:aiko/gala/front, shot:greet/s2 — so the next run adopts it instead of ' +
    'rendering one. A portrait is refused by name, because approving a look is `gate.approve`; ' +
    'so is an upload or a concept, which are their own identity. Superseding a render that ' +
    'already holds the slot needs `replace`, and the old bytes stay in the store either way.',
  notes:
    'Make an asset already in the store the output of the picture a slot names — `plate:cafe/night`, `sheet:aiko/gala/front`, `shot:greet/s2` — so the next run **adopts** it rather than rendering one. The generalization of `art.promote`, which is now one caller of it. A `portrait:` slot is refused by name (approving a look is `gate.approve`), as is an `asset:` one (an upload and a concept are their own identity). Superseding a render that already holds the slot needs `replace`; the old bytes stay in the store either way, and nothing is auto-accepted.',
  mutating   : true,
  // Makes existing bytes the project's art, and with `replace` it supersedes real work
  confirm    : true,
  props: {
    hash   : prop.string('the asset hash to adopt'),
    slot   : prop.string('the picture it becomes, e.g. plate:cafe/night'),
    replace: prop.boolean('supersede the render already holding that slot', { default: false }),
  },
  async check({ hash, slot, replace }, ctx) {
    return verdict(await ctx.host.session.previewAdopt(hash, slot, replace));
  },
  async run({ hash, slot, replace }, ctx) {
    const result = await ctx.host.session.adoptAsset(hash, slot, replace);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result, written: result.written };
  },
});

export const assetReplace = define({
  id         : 'asset.replace',
  title      : 'Replace with a file…',
  description:
    'Choose an image and put it in the place of a picture the project generated — `asset.upload` ' +
    'with the chooser in front and the slot read off the asset instead of typed. The slot is the ' +
    'one these bytes fill now, so an asset a later render superseded is refused, as is anything ' +
    'nothing planned. Cancelling changes nothing.',
  notes:
    "The asset editor's Replace strip: open an image chooser and make what comes back this picture's slot — `asset.upload` with the chooser in front and the slot read off the asset instead of typed. Refused when these bytes fill no slot (a concept, an upload, a render something later superseded). Cancelling changes nothing.",
  mutating   : true,
  // Supersedes real work with a file from outside, which is the bar `asset.upload` clears too
  confirm    : true,
  props      : { hash: prop.string('the asset the chosen file replaces') },
  async check({ hash }, ctx) {
    return verdict(await ctx.host.session.previewReplace(hash));
  },
  async run({ hash }, ctx) {
    // Choosing a file grants no permission; the same refusals apply after the chooser closes
    const picked = await ctx.host.pickFiles(
      {
        title      : 'Replace with a file',
        buttonLabel: 'Replace',
        extensions : ['png', 'jpg', 'jpeg', 'gif', 'webp'],
        filterName : 'Images',
        single     : true,
      },
      ctx.origin,
    );
    const file = picked[0];
    if (file === undefined) return { message: 'Cancelled.' };

    const result = await ctx.host.session.replaceAsset(hash, file);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result, written: result.written };
  },
});

export const assetRegenerate = define({
  id         : 'asset.regenerate',
  title      : 'Regenerate asset',
  description:
    "Put this asset's task back to pending so the next run re-renders it. With `run` the " +
    'pipeline is run for real straight afterwards — and it is run anyway when the requeue left ' +
    'exactly one task plannable, because a one-task run is not worth a second trip. A fixed ' +
    'image seed makes a plain re-roll deterministic — art notes are how the picture actually ' +
    'changes.',
  notes:
    "Put the asset's task back to `pending`; with `run`, run the pipeline for real straight afterwards. A fixed image seed makes a plain re-roll deterministic, and the refusal text says so. A **concept** is refused by name — the planner never made one, so there is no task to requeue: `art.redraw` is what draws it again. An **upload** is refused for the same reason, pointing at `asset.upload` for a different image.",
  mutating   : true,
  // Requeuing costs nothing by itself, but running spends a real image call, and the gate is on
  // the command rather than the props.
  confirm    : true,
  props: {
    hash: prop.string('the asset hash to re-render'),
    run : prop.boolean('run the pipeline for real once the task is queued', { default: false }),
  },
  async check({ hash }, ctx) {
    return verdict(await ctx.host.session.previewRegenerate(hash));
  },
  async run({ hash, run }, ctx) {
    const { session } = ctx.host;
    const queued = await session.regenerateAsset(hash);
    if (!queued.ok) throw new Error(queued.message);

    const why = run ? 'asked for' : autoRunReason(await session.runPreconditions(false));
    if (!why) return { message: queued.message, data: queued, written: queued.written };

    const result = await session.runPipeline(false);
    const failed = result.failed ? `, ${result.failed} failed` : '';
    return {
      message: `${queued.message} ${result.ran} task(s) ran${failed}.`,
      data   : { queued, run: result, why },
      written: [...queued.written, 'vngen/build/'],
    };
  },
});

/**
 * Why a requeue runs the pipeline on its own, or `''` when it does not.
 *
 * A single queued task runs without asking, because it is a re-roll. More than one pending task
 * stays the author's decision, a closed gate halts rather than runs, and a run whose keys do not
 * resolve is not started. `runPreconditions` names the source that failed, never the value.
 */
export function autoRunReason(pre: {
  pending: number;
  blockedOnGate: boolean;
  keyError: string | null;
}): string {
  const alone = pre.pending === 1 && !pre.blockedOnGate && pre.keyError === null;
  return alone ? 'the only task' : '';
}

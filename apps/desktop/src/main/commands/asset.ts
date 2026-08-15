/**
 * One generated asset as commands: what it is, accepting it, re-rendering it.
 *
 * The namespace is deliberately generic — it addresses a hash, not a character or a shot — because
 * the manifest is the one place every kind of generated art meets. What an asset *should look
 * like* is not here: that is authored input, and it is `art.setNotes`.
 */
import { defineFor, prop, type CheckResult } from '@vn/commands';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

/** A session preview read as a precondition: the plan's own sentence either way. */
function verdict(result: { ok: boolean; message: string }): CheckResult {
  return result.ok ? { ok: true, note: result.message } : { ok: false, reason: result.message };
}

export const assetInfo = define({
  id: 'asset.info',
  title: 'Asset details',
  description:
    'Everything known about one generated asset: its display label and kind, which root holds ' +
    'it, whether it is accepted, the task that made it, the prompt it was rendered from, the ' +
    'prompt the builders would write today, and the art-notes rungs that reach it.',
  mutating: false,
  props: { hash: prop.string('the asset hash') },
  async run({ hash }, ctx) {
    const info = await ctx.host.session.assetInfo(hash);
    if (!info) throw new Error(`No asset "${hash}" in the manifest.`);
    const drift = info.stale ? ' (rendered from an older prompt)' : '';
    return { message: `${info.label} — ${info.kind}${drift}.`, data: info };
  },
});

export const assetSuspended = define({
  id: 'asset.suspended',
  title: 'Suspended assets',
  description:
    'Every asset drawn against a reference that has moved, plus everything downstream of one, ' +
    'in dependency order with the reason for each. Derived on every call, never a stored flag — ' +
    'the bytes stay; suspension only says they are out of date.',
  mutating: false,
  props: {},
  async run(_props, ctx) {
    const found = await ctx.host.session.suspensions();
    return { message: `${found.length} suspended asset(s).`, data: found };
  },
});

export const assetAccept = define({
  id: 'asset.accept',
  title: 'Accept asset',
  description:
    'Mark this asset as the accepted one for what it satisfies. A portrait is refused by name: ' +
    'approving one also writes character.md and approved.png, which is `gate.approve`. So is a ' +
    'concept: nothing downstream consumes one, so making it count is `art.promote`.',
  mutating: true,
  props: { hash: prop.string('the asset hash to accept') },
  async check({ hash }, ctx) {
    return verdict(await ctx.host.session.previewAccept(hash));
  },
  async run({ hash }, ctx) {
    const result = await ctx.host.session.acceptAsset(hash);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result, written: ['manifest.json'] };
  },
});

export const assetUpload = define({
  id: 'asset.upload',
  title: 'Upload reference image',
  description:
    'Bring an image from outside into the base asset store as a reference. Nothing generated ' +
    'it, so it is never approved and never planned — it exists only to be pointed at by a ' +
    'prompt chunk. Mock placeholder art and anything that is not an image are refused by name.',
  mutating: true,
  // It writes bytes into the repo from a path the author named, which is worth one confirmation.
  confirm: true,
  props: {
    file: prop.string('path to the image file (absolute, or relative to the project)'),
    title: prop.string('what to call it on screen; empty means the filename', { default: '' }),
    open: prop.boolean('open the asset editor on it afterwards', { default: true }),
  },
  async check({ file, title }, ctx) {
    return verdict(await ctx.host.session.previewUpload(file, title));
  },
  async run({ file, title, open }, ctx) {
    const result = await ctx.host.session.uploadAsset(file, title);
    if (!result.ok) throw new Error(result.message);
    if (open && result.hash) {
      ctx.host.ui({
        type: 'view',
        action: 'open',
        editor: 'asset',
        where: 'elsewhere',
        subject: result.hash,
      });
    }
    return { message: result.message, data: result, written: result.written };
  },
});

export const assetRegenerate = define({
  id: 'asset.regenerate',
  title: 'Regenerate asset',
  description:
    "Put this asset's task back to pending so the next run re-renders it. With `run` the " +
    'pipeline is run for real straight afterwards. A fixed image seed makes a plain re-roll ' +
    'deterministic — art notes are how the picture actually changes.',
  mutating: true,
  // Requeuing costs nothing by itself, but `run` spends a real image call, and the gate is on
  // the command rather than the props.
  confirm: true,
  props: {
    hash: prop.string('the asset hash to re-render'),
    run: prop.boolean('run the pipeline for real once the task is queued', { default: false }),
  },
  async check({ hash }, ctx) {
    return verdict(await ctx.host.session.previewRegenerate(hash));
  },
  async run({ hash, run }, ctx) {
    const queued = await ctx.host.session.regenerateAsset(hash);
    if (!queued.ok) throw new Error(queued.message);
    if (!run) return { message: queued.message, data: queued, written: queued.written };
    const result = await ctx.host.session.runPipeline(false);
    const failed = result.failed ? `, ${result.failed} failed` : '';
    return {
      message: `${queued.message} ${result.ran} task(s) ran${failed}.`,
      data: { queued, run: result },
      written: [...queued.written, 'vngen/build/'],
    };
  },
});

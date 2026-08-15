/**
 * `/upload`: bringing the author's own documents in.
 *
 * A separate namespace from `asset.upload` on purpose — that brings an *image* into the
 * content-addressed store, this copies a *document* into `archive/` and hands the conversation a
 * question. Different noun, different destination, and one word between them.
 *
 * Neither is `undoable`. The copy is trivially reversible in Explorer, but the act also closes the
 * open conversation and starts a new one, and a shadow snapshot cannot put a conversation back —
 * `vngen/state` is outside it by design.
 */
import { defineFor, prop, type CommandContext } from '@vn/commands';
import { describeUpload, uploadSuggestions } from '@vn/authoring';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

/**
 * What uploading would do, in the sentence a refusal or a confirmation needs. Shared by
 * `upload.files`'s check and `upload.pick`, so the picker cannot accept what the command refuses.
 */
async function wouldUpload(
  paths: string[],
  busy: string | undefined,
): Promise<{ ok: true; note: string } | { ok: false; reason: string }> {
  const named = paths.filter((p) => p.trim() !== '');
  if (named.length === 0) return { ok: false, reason: 'Name at least one file to upload.' };
  if (busy) return { ok: false, reason: `${busy} is still running; wait for it to finish.` };
  return {
    ok: true,
    note:
      `Copies ${named.length} file(s) into archive/, saves the open conversation and starts ` +
      'a new one in plan mode.',
  };
}

/** Archive, then hand the conversation the question the author now has to answer. */
async function upload(
  paths: string[],
  ctx: CommandContext<CommandHost>,
): Promise<{ message: string; data: unknown; written: string[] }> {
  const verdict = await wouldUpload(paths, ctx.host.session.busy());
  if (!verdict.ok) throw new Error(verdict.reason);

  const batch = await ctx.host.session.uploadFiles(paths.filter((p) => p.trim() !== ''));
  const message = describeUpload(batch);
  const written = batch.files.map((f) => f.stored);
  // An upload where every file was refused changes nothing: no bytes landed, so it must not
  // close the conversation the author was having in order to ask about them.
  if (written.length === 0) return { message, data: { batch }, written };

  // The order matters: plan mode before the thread, so an author who types the instant the pane
  // lands is typing at an agent that cannot yet edit anything.
  await ctx.host.session.setMode('plan');
  await ctx.host.session.clearAgent();

  ctx.host.ui({ type: 'view', action: 'open', editor: 'convo', where: 'elsewhere', flash: true });
  return {
    message,
    data: { batch, seed: message, suggestions: uploadSuggestions(batch) },
    written,
  };
}

export const uploadFiles = define({
  id: 'upload.files',
  title: 'Upload documents',
  description:
    "Copy the author's own documents into archive/ unchanged, then open a fresh conversation " +
    'in plan mode asking what to do with them. The archive is outside every directory the agent ' +
    'sweeps, so nothing here turns up in `search` or the story bible — it is read by name only.',
  mutating: true,
  // It copies bytes into the repo from paths the author named — the bar `asset.upload` clears.
  confirm: true,
  props: { paths: prop.stringList('the files to upload (absolute paths)') },
  check: ({ paths }, ctx) => wouldUpload(paths, ctx.host.session.busy()),
  run: ({ paths }, ctx) => upload(paths, ctx),
});

export const uploadPick = define({
  id: 'upload.pick',
  title: 'Upload documents…',
  description:
    'Choose documents in a file dialog, then upload them — `upload.files` with the picker in ' +
    'front. Cancelling changes nothing.',
  mutating: true,
  confirm: true,
  props: {},
  async check(_props, ctx) {
    const busy = ctx.host.session.busy();
    return busy
      ? { ok: false as const, reason: `${busy} is still running; wait for it to finish.` }
      : { ok: true as const, note: 'Opens a file chooser.' };
  },
  async run(_props, ctx) {
    const picked = await ctx.host.pickFiles();
    if (picked.length === 0) return { message: 'Cancelled.' };
    // The dialog is not a permission: files the command would refuse are refused here too.
    return upload(picked, ctx);
  },
});

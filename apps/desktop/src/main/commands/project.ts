/**
 * The project itself as commands: what `project.yaml` says, and the one field in it an author
 * edits often enough to want a pane for.
 *
 * The art style is not like the other settings. It is the first clause of every image prompt, so
 * it is folded into every image task's hash — changing it does not adjust a rendering, it re-keys
 * the whole library and the next run draws it all again. That is why the write is `confirm: true`
 * and why its check counts what it would touch.
 */
import { defineFor, prop, type CheckResult } from '@vn/commands';
import { KEY_VENDORS } from '@vn/config';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

/** A session preview read as a precondition: the plan's own sentence either way. */
function verdict(result: { ok: boolean; message: string }): CheckResult {
  return result.ok ? { ok: true, note: result.message } : { ok: false, reason: result.message };
}

export const projectInfo = define({
  id: 'project.info',
  title: 'Project settings',
  description:
    'What `project.yaml` says: the title, the entry scene, the art style, the model ids and the ' +
    'image parameters — plus how many image tasks the art style reaches. Never the API keys, ' +
    'whose names live in the file and whose values never leave the environment.',
  mutating: false,
  props: {},
  async run(_props, ctx) {
    const view = await ctx.host.session.projectView();
    return { message: `${view.title} — ${view.imageTasks} image task(s).`, data: view };
  },
});

export const projectSetArtStyle = define({
  id: 'project.setArtStyle',
  title: 'Set the art style',
  description:
    "Set the project's art style — the sentence every image prompt opens with. It is not art " +
    'notes on one rung: it reaches every portrait, sheet, plate and shot, so setting it re-keys ' +
    'every image task and the next `pipeline.run` renders the whole library again. The line is ' +
    'spliced into `project.yaml`, so comments and key order survive.',
  mutating: true,
  undoable: true,
  // Every other document mutator changes one document's words. This one changes what the project
  // looks like, and the bill arrives at the next run.
  confirm: true,
  props: {
    style: prop.string('the art style; empty clears it', { default: '' }),
  },
  async check({ style }, ctx) {
    return verdict(await ctx.host.session.previewArtStyle(style));
  },
  async run({ style }, ctx) {
    const result = await ctx.host.session.setProjectArtStyle(style);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result, written: result.written };
  },
});

export const projectSetKey = define({
  id: 'project.setKey',
  title: 'Provide a model key',
  description:
    "Store an API key for one model provider in the project's `keys/` directory — the file " +
    '`resolveKeys` reads when the matching environment variable is unset. The value is written ' +
    'to that file and nowhere else: the history records `<secret>`, and `keys` is added to ' +
    '`.gitignore` before the write so commit-on-save cannot pick it up.',
  mutating: true,
  // Deliberately not undoable: an undo point is a git snapshot, and snapshotting a credential is
  // the one thing this command exists to avoid.
  undoable: false,
  props: {
    provider: prop.oneOf(KEY_VENDORS, 'which model provider the key is for'),
    key: prop.secret('the API key; it is written to a gitignored file and never recorded'),
  },
  async check({ provider }, ctx) {
    return verdict(await ctx.host.session.previewKey(provider));
  },
  async run({ provider, key }, ctx) {
    const result = await ctx.host.session.setKey(provider, key);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, written: result.written };
  },
});

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

/** The two rungs an author can write to. Ordered so the enum's first value is today's default. */
const KEY_SCOPES = ['project', 'user'] as const;

export const projectSetKey = define({
  id: 'project.setKey',
  title: 'Provide a model key',
  description:
    'Store an API key for one model provider — the file `resolveKeys` reads when the matching ' +
    'environment variable is unset. `scope=project` writes it into this project (`keys/`, added ' +
    'to `.gitignore` before the write so commit-on-save cannot pick it up); `scope=user` writes ' +
    'it once for every project on this machine, into a directory no repository contains. Either ' +
    'way the value reaches that file and nowhere else: the history records `<secret>`.',
  mutating: true,
  // Deliberately not undoable: an undo point is a git snapshot, and snapshotting a credential is
  // the one thing this command exists to avoid. That holds doubly at the user scope, where the
  // file is not in a repository at all and there is no snapshot to be had.
  undoable: false,
  props: {
    provider: prop.oneOf(KEY_VENDORS, 'which model provider the key is for'),
    key: prop.secret('the API key; it is written to a gitignored file and never recorded'),
    scope: prop.oneOf(
      KEY_SCOPES,
      'where the key is written: in this project, or once for every project on this machine',
      { default: 'project' },
    ),
  },
  async check({ provider, scope }, ctx) {
    return verdict(await ctx.host.session.previewKey(provider, scope));
  },
  async run({ provider, key, scope }, ctx) {
    const result = await ctx.host.session.setKey(provider, key, scope);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, written: result.written };
  },
});

export const projectTestKey = define({
  id: 'project.testKey',
  title: 'Test a model key',
  description:
    'Make one small real call with a provider’s key and say whether it worked. This is the ' +
    'question `project.keyStatus` cannot answer: a key can resolve and still be revoked, ' +
    'mistyped, or on an account with no credit, and without this the first news of that arrives ' +
    'much later as a run failing. It costs a fraction of a cent, and under `--mock` it does ' +
    'nothing, because a mock run never calls a provider.',
  // It writes nothing. It does spend, which the description says, because a command that quietly
  // costs money is one an author should have been told about rather than have to infer.
  mutating: false,
  props: {
    provider: prop.oneOf(KEY_VENDORS, 'which provider’s key to try'),
  },
  async check({ provider }, ctx) {
    return verdict(await ctx.host.session.previewTestKey(provider));
  },
  async run({ provider }, ctx) {
    const result = await ctx.host.session.testKey(provider);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message };
  },
});

export const projectKeyStatus = define({
  id: 'project.keyStatus',
  title: 'Which model keys are set',
  description:
    'For each model provider, whether a key resolved and **which source** answered — an ' +
    'environment variable by name, this project’s `keys/`, an enclosing repository’s, or the ' +
    'user-level one. Never the key itself. It is also the honest answer to “why is it still ' +
    'asking me”: a set environment variable is read before every file, so it shadows one that ' +
    'was just pasted.',
  mutating: false,
  props: {},
  async run(_props, ctx) {
    const view = await ctx.host.session.keyStatusView();
    const missing = view.vendors.filter((v) => !v.resolved).map((v) => v.vendor);
    return {
      message:
        missing.length === 0 ? 'Every provider has a key.' : `No key for ${missing.join(', ')}.`,
      data: view,
    };
  },
});

/**
 * Commands for the prompt an asset is generated from (docs/plans/archive/chunked-prompts.md §5).
 *
 * Deliberately a separate namespace from `art.*`. `art.setNotes` writes authored input that feeds
 * the derivation: it lands in the sheet and the builders read it back. Everything here writes an
 * override of the derivation, which says what to do to the clauses the builders produced. The two
 * are stored in different places on disk and undo separately.
 *
 * Every command names its asset by hash, and the session resolves hash → owning rung, so no caller
 * has to know whether a picture's prompt lives on a character sheet, a location sheet or a
 * storyboard. Each of these re-keys the tasks that rung reaches, as an art note does.
 */
import { defineFor, prop, type CheckResult } from '@vn/commands';
import type { CommandHost } from './host.js';
import type { ChunkOp, ClearPart } from '../session.js';

const define = defineFor<CommandHost>();

/**
 * Turns a session preview into a precondition result. The preview's message becomes the note when
 * it succeeds and the reason when it refuses.
 */
function verdict(result: { ok: boolean; message: string }): CheckResult {
  return result.ok ? { ok: true, note: result.message } : { ok: false, reason: result.message };
}

export const promptInfo = define({
  id: 'prompt.info',
  title: 'Show a prompt',
  description:
    'The prompt one asset would be generated from: the clauses the builders derived, what the ' +
    'author has done to them, and the one string that gets sent. The same projection the Asset ' +
    'editor draws, so an agent and the pane never disagree about what a picture was asked for.',
  mutating: false,
  props: {
    hash: prop.string('the asset to describe'),
  },
  async run({ hash }, ctx) {
    const view = await ctx.host.session.promptView(hash);
    if (!view) throw new Error(`No asset "${hash}" in the manifest.`);
    const n = view.chunks.filter((c) => !c.muted).length;
    return {
      message:
        `${view.mode} prompt, ${n} clause${n === 1 ? '' : 's'}` +
        (view.held ? ', held (the chunks have moved under it)' : '') +
        (view.missing.length ? `, not found: ${view.missing.join(', ')}` : ''),
      data: view,
    };
  },
});

export const promptSetChunk = define({
  id: 'prompt.setChunk',
  title: 'Edit one prompt clause',
  description:
    'Do one thing to one clause of a derived prompt: `replace` its words, `append` to them, ' +
    '`mute` it so it is not sent, or `clear` whatever was done to it. The clause keys are what ' +
    '`prompt.info` lists. An edit records the derived text it was written against, so the pane ' +
    'can say when the project has moved underneath it. It re-renders what this rung reaches.',
  mutating: true,
  undoable: true,
  props: {
    hash: prop.string('the asset whose prompt to edit'),
    chunk: prop.string('the clause key, e.g. `subject` or `palette`'),
    // A clause is one sentence, so it is not digested — the history line records it verbatim.
    // Digesting is for a whole document (`prompt.setCustom`)
    op: prop.oneOf(['replace', 'append', 'mute', 'clear'] as const, 'what to do to the clause'),
    text: prop.string('the words, for `replace` and `append`', { default: '' }),
  },
  async check({ hash, chunk, op, text }, ctx) {
    return verdict(await ctx.host.session.previewPromptChunk(hash, chunk, op as ChunkOp, text));
  },
  async run({ hash, chunk, op, text }, ctx) {
    const result = await ctx.host.session.setPromptChunk(hash, chunk, op as ChunkOp, text);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result, written: result.written };
  },
});

export const promptMoveChunk = define({
  id: 'prompt.moveChunk',
  title: 'Reorder a prompt clause',
  description:
    'Move one clause of a derived prompt after another one; an empty `after` moves it to the ' +
    'top. Order matters to an image model — what comes first is what it weights — so this is an ' +
    'authorial act and not a display preference. `prompt.clear(part=order)` restores the order ' +
    'the builders derived.',
  mutating: true,
  undoable: true,
  props: {
    hash: prop.string('the asset whose prompt to reorder'),
    chunk: prop.string('the clause to move'),
    after: prop.string('the clause it lands after; empty means first', { default: '' }),
  },
  async check({ hash, chunk, after }, ctx) {
    return verdict(await ctx.host.session.previewMoveChunk(hash, chunk, after));
  },
  async run({ hash, chunk, after }, ctx) {
    const result = await ctx.host.session.movePromptChunk(hash, chunk, after);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result, written: result.written };
  },
});

export const promptSetCustom = define({
  id: 'prompt.setCustom',
  title: 'Write a prompt by hand',
  description:
    'Replace the whole derived prompt with one written by hand. The clauses stay underneath — ' +
    'they are what `prompt.condense` reconciles against, and what the pane checks the custom ' +
    'text for — but they are no longer what gets sent. `prompt.clear(part=custom)` goes back.',
  mutating: true,
  undoable: true,
  props: {
    hash: prop.string('the asset whose prompt to replace'),
    // A whole prompt is bulk content, so this field is digested. That makes it required: the
    // overload set has no digest-plus-default signature.
    text: prop.string('the prompt to send instead', { digest: true }),
  },
  async check({ hash, text }, ctx) {
    return verdict(await ctx.host.session.previewCustomPrompt(hash, text));
  },
  async run({ hash, text }, ctx) {
    const result = await ctx.host.session.setCustomPrompt(hash, text);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result, written: result.written };
  },
});

export const promptCondense = define({
  id: 'prompt.condense',
  title: 'Condense a prompt',
  description:
    'Ask the text model to rewrite the clauses as one fluent prompt, and store the result. It ' +
    'is then **held**: if the clauses move under it, the condensed text is still what gets ' +
    'sent, because re-rendering it would move the task hash and redraw the picture. ' +
    '`force` reconciles against a hand-written prompt instead of refusing over it.',
  mutating: true,
  undoable: true,
  props: {
    hash: prop.string('the asset whose prompt to condense'),
    force: prop.boolean('reconcile an existing custom prompt instead of refusing', {
      default: false,
    }),
  },
  async check({ hash, force }, ctx) {
    return verdict(await ctx.host.session.previewCondense(hash, force));
  },
  async run({ hash, force }, ctx) {
    const result = await ctx.host.session.condenseAssetPrompt(hash, force);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result, written: result.written };
  },
});

export const promptClear = define({
  id: 'prompt.clear',
  title: 'Clear a prompt override',
  description:
    'Discard part of what has been done to a derived prompt: `chunks` (every mute, replacement ' +
    'and appendix), `order`, `custom`, `agent`, or `all` of it. What is left is what the ' +
    'builders derive, byte for byte — which is what makes an untouched project cost nothing.',
  mutating: true,
  undoable: true,
  props: {
    hash: prop.string('the asset whose override to clear'),
    part: prop.oneOf(['all', 'chunks', 'order', 'custom', 'agent'] as const, 'what to discard', {
      default: 'all',
    }),
  },
  async check({ hash, part }, ctx) {
    return verdict(await ctx.host.session.previewClearPrompt(hash, part as ClearPart));
  },
  async run({ hash, part }, ctx) {
    const result = await ctx.host.session.clearPrompt(hash, part as ClearPart);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result, written: result.written };
  },
});

export const promptAddRef = define({
  id: 'prompt.addRef',
  title: 'Attach a reference image',
  description:
    'Attach a reference image to one clause — evidence for that clause, so muting it drops the ' +
    'reference too. Name an asset hash, or the slot it should follow: portrait:<character>, ' +
    'sheet:<character>/<outfit>/<angle>, plate:<location>/<variant>, shot:<scene>/<shot>. A slot ' +
    'pins what fills it today and remembers where it came from; a bare hash pins itself and can ' +
    'never move. References are inside the task hash, so this re-renders the picture.',
  mutating: true,
  undoable: true,
  props: {
    hash: prop.string('the asset whose prompt to attach to'),
    chunk: prop.string('the clause the reference is evidence for'),
    ref: prop.string('an asset hash, or a slot address'),
  },
  async check({ hash, chunk, ref }, ctx) {
    return verdict(await ctx.host.session.previewAddRef(hash, chunk, ref));
  },
  async run({ hash, chunk, ref }, ctx) {
    const result = await ctx.host.session.addPromptRef(hash, chunk, ref);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result, written: result.written };
  },
});

export const promptDropRef = define({
  id: 'prompt.dropRef',
  title: 'Remove a reference image',
  description:
    'Take a reference image off a clause. The bytes stay in the store — this only stops them ' +
    'being sent — and the task is re-keyed, so the picture renders again without it.',
  mutating: true,
  undoable: true,
  props: {
    hash: prop.string('the asset whose prompt to edit'),
    chunk: prop.string('the clause the reference is attached to'),
    ref: prop.string('the pinned hash to remove, or a prefix of it'),
  },
  async check({ hash, chunk, ref }, ctx) {
    return verdict(await ctx.host.session.previewDropRef(hash, chunk, ref));
  },
  async run({ hash, chunk, ref }, ctx) {
    const result = await ctx.host.session.dropPromptRef(hash, chunk, ref);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result, written: result.written };
  },
});

export const promptRepin = define({
  id: 'prompt.repin',
  title: 'Repin a reference image',
  description:
    'Point a linked reference at whatever its slot holds now. A reference pins a hash — that is ' +
    'what the task hashes over — so an approval upstream never moves it on its own; it suspends ' +
    'everything downstream instead, and this is how that is cleared. `regenerate=true` re-keys ' +
    'the task and the next run draws it again; `false` is re-approve, which keeps the existing ' +
    "bytes by recording them as the newly-keyed task's output.",
  mutating: true,
  undoable: true,
  props: {
    hash: prop.string('the asset whose reference to repin'),
    chunk: prop.string('the clause the reference is attached to'),
    ref: prop.string('the pinned hash to move, or a prefix of it'),
    regenerate: prop.boolean('re-render, rather than keeping the existing bytes', {
      default: true,
    }),
  },
  async check({ hash, chunk, ref, regenerate }, ctx) {
    return verdict(await ctx.host.session.previewRepin(hash, chunk, ref, regenerate));
  },
  async run({ hash, chunk, ref, regenerate }, ctx) {
    const result = await ctx.host.session.repinPrompt(hash, chunk, ref, regenerate);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result, written: result.written };
  },
});

export const promptCheck = define({
  id: 'prompt.check',
  title: 'Check a prompt says everything',
  description:
    'Which clauses a hand-written or condensed prompt no longer appears to say. A word-overlap ' +
    'heuristic and nothing more — it answers "not found", never "it was dropped" — so it is a ' +
    'prompt to go and look, not a verdict. In chunks mode nothing can be missing.',
  mutating: false,
  props: {
    hash: prop.string('the asset whose prompt to check'),
  },
  async run({ hash }, ctx) {
    const result = await ctx.host.session.checkPrompt(hash);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result };
  },
});

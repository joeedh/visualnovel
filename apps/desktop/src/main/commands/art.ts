/**
 * Commands for art direction and for drawing a concept image on demand.
 *
 * Art notes are the only thing an author says about the appearance of generated art, and they are
 * authored input rather than a prompt override. They go into the prompt the builders derive, so
 * setting a note re-keys exactly the tasks it reaches and the next run re-renders them. That
 * makes `art.setNotes` a `story.*`-shaped document mutator (undoable and committed) rather than a
 * pipeline command. `art.generate` takes one sentence and produces one `concept` asset, which the
 * planner never plans and nothing downstream consumes.
 */
import { defineFor, prop, type CheckResult } from '@vn/commands';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

/** Turns a session preview into a check result, keeping its message as the note or the refusal. */
function verdict(result: { ok: boolean; message: string }): CheckResult {
  return result.ok ? { ok: true, note: result.message } : { ok: false, reason: result.message };
}

export const artSetNotes = define({
  id: 'art.setNotes',
  title: 'Set art notes',
  description:
    'Set (or clear, with empty notes) the art direction on one rung: `character:aiko`, ' +
    '`character:aiko/gala`, `location:cafe`, `location:cafe/night` or `shot:greet/s2`. It is ' +
    'appended to the prompt, so it re-renders the assets that rung reaches on the next run. ' +
    'Never creates an outfit, a variant or a shot — a note on one that does not exist is refused.',
  notes:
    'Art direction on one rung — `character:aiko`, `character:aiko/gala`, `location:cafe`, `location:cafe/night`, `shot:greet/s2`. Appended to the prompt, so it **re-renders** what that rung reaches. Never creates the rung it names.',
  mutating: true,
  undoable: true,
  props: {
    target: prop.string('the rung to write: kind:id[/outfit|variant|shotId]'),
    notes: prop.string('the art direction; empty removes it', { default: '' }),
  },
  async check({ target, notes }, ctx) {
    return verdict(await ctx.host.session.previewArtNotes(target, notes));
  },
  async run({ target, notes }, ctx) {
    const result = await ctx.host.session.setArtNotes(target, notes);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result, written: result.written };
  },
});

export const artSetSeed = define({
  id: 'art.setSeed',
  title: 'Set image seed',
  description:
    'Set the image seed on one rung — the same five `art.setNotes` writes. The seed is part of ' +
    'what an image was drawn with, so setting one re-keys the tasks that rung reaches and the ' +
    'next run draws them again. It is how to ask for a different picture of the same words; ' +
    'what the picture should *look* like is art notes. A rung with no seed inherits the one ' +
    'above it, and the project config is the floor.',
  mutating: true,
  undoable: true,
  props: {
    target: prop.string('the rung to write: kind:id[/outfit|variant|shotId]'),
    // -1 rather than a second prop, because 0 is a real seed and no in-range value can mean none
    seed: prop.number('the seed; -1 clears it, leaving the rung to inherit', { default: -1 }),
  },
  async check({ target, seed }, ctx) {
    return verdict(await ctx.host.session.previewArtSeed(target, seedOrClear(seed)));
  },
  async run({ target, seed }, ctx) {
    const result = await ctx.host.session.setArtSeed(target, seedOrClear(seed));
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result, written: result.written };
  },
});

/** Maps the prop's negative sentinel to the `null` the session uses for no seed at this rung. */
function seedOrClear(seed: number): number | null {
  return seed < 0 ? null : seed;
}

export const artGenerate = define({
  id: 'art.generate',
  title: 'Draw a concept image',
  description:
    'Draw a concept image from a sentence, e.g. "an aerial shot of the high school". It binds to ' +
    'the location or character it names — say which, or let the sentence decide — and files under ' +
    'Concepts. A concept is a sketch and nothing more: the pipeline never plans it, no scene ' +
    'renders it, and `vngen export` ignores it. It costs one image generation.',
  notes:
    'Draw a concept from a sentence and file it under Concepts, bound to the location or character it names. Spends one image generation; the pipeline never plans one and `vngen export` ignores it.',
  mutating: true,
  // Spends a real image call, the same bar `asset.regenerate(run=true)` clears. It is neither
  // undoable nor journalled, because it writes new content-addressed bytes and there is no prior
  // state to restore
  confirm: true,
  props: {
    sentence: prop.string('what to draw, in plain words'),
    subject: prop.string('location:<id> or character:<id>; empty lets the sentence decide', {
      default: '',
    }),
    open: prop.boolean('show the result in the Asset editor', { default: true }),
  },
  async check({ sentence, subject }, ctx) {
    return verdict(await ctx.host.session.previewConcept(sentence, subject));
  },
  async run({ sentence, subject, open }, ctx) {
    const result = await ctx.host.session.drawConcept(sentence, subject);
    if (!result.ok || !result.hash) throw new Error(result.message);
    // Same route as a click on an asset in the document tree, so the picture opens in a pane other
    // than the one that asked for it
    if (open) {
      ctx.host.ui(
        {
          type: 'view',
          action: 'open',
          editor: 'asset',
          where: 'elsewhere',
          subject: result.hash,
        },
        ctx.origin,
      );
    }
    return { message: result.message, data: result, written: result.written };
  },
});

export const artRedraw = define({
  id: 'art.redraw',
  title: 'Redraw a concept',
  description:
    'Draw a concept again, from an edited prompt or the same one. A concept is the one asset ' +
    'whose prompt is authored rather than derived from the project, so it is the one prompt an ' +
    'author can rewrite. The result is a new sketch beside the original — bytes are ' +
    'content-addressed, so nothing is overwritten. A planned asset is refused by name: its ' +
    'prompt comes from the builders, and re-rendering it is `asset.regenerate`.',
  notes:
    'Draw a concept again from an edited prompt — the one asset whose prompt is authored rather than derived, so the one prompt there is to rewrite. The result is a **new** sketch beside the original; nothing is overwritten. A planned asset is refused by name: re-rendering one is `asset.regenerate`.',
  mutating: true,
  // One image call, like `art.generate`, and not undoable because new bytes have no prior state
  // to restore
  confirm: true,
  props: {
    hash: prop.string('the concept asset to draw again'),
    prompt: prop.string('the prompt to draw from; empty re-rolls the recorded one', {
      default: '',
    }),
    title: prop.string('a new name for it; empty keeps the one it has', { default: '' }),
    open: prop.boolean('show the result in the Asset editor', { default: true }),
  },
  async check({ hash, prompt, title }, ctx) {
    return verdict(await ctx.host.session.previewRedraw(hash, prompt, title));
  },
  async run({ hash, prompt, title, open }, ctx) {
    const result = await ctx.host.session.redrawAsset(hash, prompt, title);
    if (!result.ok || !result.hash) throw new Error(result.message);
    if (open) {
      ctx.host.ui(
        {
          type: 'view',
          action: 'open',
          editor: 'asset',
          where: 'elsewhere',
          subject: result.hash,
        },
        ctx.origin,
      );
    }
    return { message: result.message, data: result, written: result.written };
  },
});

export const artPromote = define({
  id: 'art.promote',
  title: 'Promote a concept to a plate',
  description:
    'Make a concept the location plate for one variant: the variant is added to the location ' +
    "sheet if it is new, the bytes are re-recorded as a plate, and that plate's task is marked " +
    'done — so the next run adopts the picture instead of rendering its own. Only a concept ' +
    'bound to a location can be promoted; a character concept is refused, because a look goes ' +
    'through the approval gate.',
  notes:
    "Make a concept the location plate for one variant: the variant joins the sheet if it is new, the bytes are re-recorded as a plate, and that plate's task is logged `done` so the next run **adopts** the picture. A character concept is refused — a look goes through the gate.",
  mutating: true,
  // Writes a sheet, a manifest row and a `done` task record across two trees, which no document
  // snapshot covers, so it is committed like any other act but never undone
  confirm: true,
  props: {
    hash: prop.string('the concept asset to promote'),
    variant: prop.string('the location variant it becomes the plate for'),
    description: prop.string('prose for a variant this creates; ignored for one that exists', {
      default: '',
    }),
  },
  async check({ hash, variant }, ctx) {
    return verdict(await ctx.host.session.previewPromote(hash, variant));
  },
  async run({ hash, variant, description }, ctx) {
    const result = await ctx.host.session.promoteAsset(hash, variant, description);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result, written: result.written };
  },
});

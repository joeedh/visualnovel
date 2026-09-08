// ── Concept images: sketches bound to a subject, drawn from a sentence ──────
import { z } from 'zod';
import { formatSubject, parseSubject } from '@vn/artgen';
import { ok, fail, rel, type Tool } from './core.js';

const generateImageTool: Tool<{ sentence: string; subject?: string }> = {
  name       : 'generate_image',
  description:
    'Draw a concept image from a sentence, e.g. "an aerial shot of the high school". It is bound to the location or character it names — say which, or let the sentence decide — and appears under Concepts in the project. A concept is a sketch and nothing more: the pipeline never plans it, no scene renders it, and `vngen export` ignores it; promoting one to a real location plate is a separate, human decision. It costs one image generation, so ask before drawing several.',
  mutating   : true,
  confirm    : true,
  args: z.object({
    sentence: z.string().min(1).describe('what to draw, in plain words'),
    subject: z
      .string()
      .optional()
      .describe('location:<id> or character:<id>; omitted means the sentence decides'),
  }),
  async run(a, ctx) {
    if (!ctx.art) {
      return fail('image generation is not available in this session; nothing was drawn.');
    }
    const subject = a.subject ? parseSubject(a.subject) : undefined;
    if (a.subject && !subject) {
      return fail(`"${a.subject}" is not a subject — write location:<id> or character:<id>.`);
    }
    try {
      const res = await ctx.art.generate({
        sentence: a.sentence,
        ...(subject ? { subject } : {}),
      });
      const file = rel(ctx.workspace.root, res.file);
      const of = res.subject
        ? ` of ${formatSubject(res.subject)}`
        : ' bound to nothing in the project';
      return ok(`Drew a concept${of}: ${file}. It is a sketch — nothing in the pipeline uses it.`, {
        written: [file, rel(ctx.workspace.root, ctx.workspace.paths.baseManifest)],
        data: {
          hash: res.ref.hash,
          file,
          prompt: res.prompt,
          ...(res.subject ? { subject: formatSubject(res.subject) } : {}),
        },
      });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
};

const listImagesTool: Tool<Record<string, never>> = {
  name       : 'list_images',
  description:
    'List the concept sketches this project holds: hash, name, what each is bound to, and the prompt it was drawn from. Read-only. Use it before `edit_image` — a concept is named by its hash, and this is where one comes from.',
  mutating   : false,
  args       : z.object({}).strict(),
  async run(_a, ctx) {
    if (!ctx.art) return fail('image generation is not available in this session.');
    const concepts = await ctx.art.list();
    if (concepts.length === 0) {
      return ok('No concept sketches yet. `generate_image` draws one from a sentence.');
    }
    const lines = concepts.map((c) => {
      const of = c.subject ? ` of ${formatSubject(c.subject)}` : '';
      return `${c.hash.slice(0, 12)}  ${c.title ?? '(unnamed)'}${of}\n  ${rel(ctx.workspace.root, c.file)}\n  prompt: ${c.prompt ?? '(none recorded)'}`;
    });
    return ok(`${concepts.length} concept sketch(es):\n${lines.join('\n')}`, {
      data: concepts.map((c) => ({
        hash: c.hash,
        ...(c.title ? { title: c.title } : {}),
        ...(c.prompt ? { prompt: c.prompt } : {}),
        ...(c.subject ? { subject: formatSubject(c.subject) } : {}),
      })),
    });
  },
};

const editImageTool: Tool<{ hash: string; prompt?: string; title?: string }> = {
  name       : 'edit_image',
  description:
    'Draw a concept sketch again, from an edited prompt. A concept is the one asset whose prompt is authored rather than derived from the project, so it is the one prompt you may rewrite — pass the whole prompt, starting from the one `list_images` reports, so the style preamble and the framing line survive. The result is a NEW sketch beside the original; nothing is overwritten and nothing downstream sees either. Omitting the prompt re-rolls the recorded one, which is pointless when `image_params.seed` is fixed. It costs one image generation, so confirm with the author before drawing.',
  mutating   : true,
  confirm    : true,
  args: z.object({
    hash  : z.string().min(4).describe('the concept to redraw; a hash prefix from list_images'),
    prompt: z
      .string()
      .optional()
      .describe('the whole prompt to draw from; omitted re-rolls the recorded one'),
    title : z.string().optional().describe('a new name for it; omitted keeps the one it has'),
  }),
  async run(a, ctx) {
    if (!ctx.art) {
      return fail('image generation is not available in this session; nothing was drawn.');
    }
    try {
      // A 64-char hash is passed straight through so `redrawConcept` can refuse a derived asset
      // by name; anything shorter is a prefix, and an ambiguous prefix is refused with its
      // candidates rather than resolved by guessing.
      let hash = a.hash;
      if (hash.length < 64) {
        const matches = (await ctx.art.list()).filter((c) => c.hash.startsWith(hash));
        if (matches.length === 0) {
          return fail(`no concept starts with "${hash}" — run list_images to see what there is.`);
        }
        if (matches.length > 1) {
          return fail(
            `"${hash}" names ${matches.length} concepts (${matches.map((m) => m.hash.slice(0, 12)).join(', ')}); say more of the hash.`,
          );
        }
        hash = matches[0]!.hash;
      }

      const res = await ctx.art.redraw({
        hash,
        ...(a.prompt === undefined ? {} : { prompt: a.prompt }),
        ...(a.title === undefined ? {} : { title: a.title }),
      });
      const file = rel(ctx.workspace.root, res.file);
      const same = res.unchanged
        ? ' The same prompt and a fixed seed gave back the very same picture.'
        : ` ${res.from.slice(0, 12)} is still there.`;
      return ok(`Redrew ${res.from.slice(0, 12)} as ${file}.${same}`, {
        written: [file, rel(ctx.workspace.root, ctx.workspace.paths.baseManifest)],
        data   : { hash: res.ref.hash, from: res.from, file, prompt: res.prompt },
      });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
};

export { generateImageTool, listImagesTool, editImageTool };

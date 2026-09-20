/**
 * The model catalog: the image models OpenRouter routes to and the text models of OpenRouter,
 * Anthropic and Gemini, cached per user and refreshed when the author asks, or once by the Project
 * editor when the cache holds no text listing. The listing bills nothing, so there is no
 * confirmation, and the file sits outside every workspace, so the command is not undoable.
 */
import { defineFor } from '@vn/commands';
import { userModelFile } from '@vn/gengraph/state';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

export const modelsRefresh = define({
  id         : 'models.refresh',
  title      : 'Refresh the model list',
  description:
    'Fetch the image models OpenRouter routes to, with each one’s aspect ratios, seed support ' +
    'and per-picture price, and the text models of OpenRouter and of each vendor whose key ' +
    'resolves, into your own model list. Every model picker draws that list, and the graph ' +
    'estimate prices OpenRouter models from it. Fetched once by the Project editor when the list ' +
    'holds no text models, and otherwise only when you ask.',
  mutating   : true,
  affects    : ['<user>/models.json'],
  undoable   : false,
  props      : {},
  async check() {
    return { ok: true, note: `writes ${userModelFile()}` };
  },
  async run(_props, ctx) {
    const done = await ctx.host.session.refreshModelCatalog();
    if (!done.ok) throw new Error(done.reason);
    return { message: done.message, data: { listed: done.listed } };
  },
});

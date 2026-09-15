/**
 * The image-model catalog: what OpenRouter routes to, cached per user and refreshed only when the
 * author asks. The listing bills nothing and needs no key, so there is no confirmation, and the
 * file sits outside every workspace, so the command is not undoable.
 */
import { defineFor } from '@vn/commands';
import { userModelFile } from '@vn/gengraph/state';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

export const modelsRefresh = define({
  id         : 'models.refresh',
  title      : 'Refresh the image-model list',
  description:
    'Fetch the image models OpenRouter routes to, with each one’s aspect ratios, seed support ' +
    'and per-picture price, into your own model list. Every image-model picker draws that list, ' +
    'and the graph estimate prices OpenRouter models from it. Nothing is fetched until you ask.',
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

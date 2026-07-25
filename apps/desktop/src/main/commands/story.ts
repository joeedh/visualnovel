/** The playable: build it in memory for the PLAY room, or write it to disk. */
import { defineFor } from '@vn/commands';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

export const storyPlay = define({
  id: 'story.play',
  title: 'Build playable',
  description: 'Project the model + asset store into the playable, in memory (no file written).',
  mutating: false,
  props: {},
  async run(_props, ctx) {
    const playable = await ctx.host.session.playable();
    return {
      message: `Playable built: ${Object.keys(playable.scenes).length} scene(s).`,
      data: playable,
    };
  },
});

export const storyExport = define({
  id: 'story.export',
  title: 'Export playable',
  description: 'Write vngen/build/story.play.json — the `vngen export` equivalent.',
  mutating: true,
  props: {},
  async run(_props, ctx) {
    const { scenes } = await ctx.host.session.exportPlayable();
    return {
      message: `Exported ${scenes} scene(s) to story.play.json.`,
      written: ['vngen/build/story.play.json'],
    };
  },
});

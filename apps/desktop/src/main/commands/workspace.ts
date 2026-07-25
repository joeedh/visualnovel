import { defineFor } from '@vn/commands';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

export const workspaceIndex = define({
  id: 'workspace.index',
  title: 'Workspace index',
  description: 'The project index: characters, locations, screenplay files, diagnostics.',
  mutating: false,
  props: {},
  async run(_props, ctx) {
    const index = await ctx.host.session.index();
    return { message: `Indexed ${ctx.root}.`, data: index };
  },
});

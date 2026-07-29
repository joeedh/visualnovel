/**
 * The workspace as commands: what is in it, and the one-time migration into the chunk format.
 *
 * `workspace.import` is `mutating` but deliberately not `undoable`: it restructures the whole
 * worktree, which is what a shadow snapshot is worst at, and the `.imported` rename it leaves
 * behind is a reversal the author can perform themselves.
 */
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

export const workspaceImport = define({
  id: 'workspace.import',
  title: 'Import the screenplay',
  description:
    'Convert a screenplay/*.fountain project into one scenes/<id>.md chunk per scene — the ' +
    '`vngen import` equivalent. Refuses over existing chunks; the original is moved aside, ' +
    'not deleted.',
  mutating: true,
  props: {},
  async check(_props, ctx) {
    const preview = await ctx.host.session.previewImport();
    return preview.ok
      ? { ok: true, note: preview.message }
      : { ok: false, reason: preview.message };
  },
  async run(_props, ctx) {
    const result = await ctx.host.session.importScreenplay();
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, written: result.written };
  },
});

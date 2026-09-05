/**
 * Windows as commands. A window is a renderer, not a document: it holds a mesh of panes and
 * nothing else, so opening one is a view act with no undo, no provenance and nothing written.
 *
 * They live here rather than in `view.ts` because a `view.*` command pushes an effect into a
 * window that already exists, and these three are the ones that decide which windows there are.
 * Everything a window remembers (its mesh, its selection, its layout template) is keyed by the
 * index main hands it.
 */
import { defineFor, prop } from '@vn/commands';
import { EDITOR_IDS, editorTitle, type EditorId } from '../../shared/editors.js';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

export const windowNew = define({
  id         : 'window.new',
  title      : 'New window',
  description:
    'Open another window onto the same project, so panes can be spread across monitors. It is ' +
    'a second view, not a second app: one process, one undo history, one set of files. Name an ' +
    'editor to have the new window open showing it rather than the arrangement it last had.',
  notes:
    'Open another window onto the same project. A second *view*, not a second app: one process, one `WorkspaceSession`, one undo history. Both props are optional; naming an editor opens showing it.',
  mutating   : false,
  props: {
    editor: prop.oneOf(
      ['', ...EDITOR_IDS] as const,
      'which editor it opens showing; empty ' +
        'restores the arrangement that window index last had',
      { default: '' },
    ),
    subject: prop.string(
      'what that editor shows: a workspace-relative path for the Wiki editor, an asset hash for ' +
        'the Asset editor',
      { default: '' },
    ),
  },
  async run({ editor, subject }, ctx) {
    const id = await ctx.host.newWindow({
      editor : editor || undefined,
      subject: subject || undefined,
    });
    const showing = editor ? ` showing ${editorTitle(editor as EditorId)}` : '';
    return { message: `Opened window ${id}${showing}.`, data: { window: id } };
  },
});

export const windowClose = define({
  id         : 'window.close',
  title      : 'Close window',
  description:
    'Close this window. Its panes and its selection are remembered against its index, so the ' +
    'next window to take that index opens where this one left off. Closing the last window ' +
    'quits, which is the one case worth knowing before pressing it.',
  notes:
    'Close the asking window. Its note says how many stay open, or that this is the last one and closing it quits.',
  mutating   : false,
  props      : {},
  check(_props, ctx) {
    return Promise.resolve(
      ctx.host.windowCount() <= 1
        ? { ok: true as const, note: 'this is the last window, so closing it quits vnstudio' }
        : { ok: true as const, note: `${ctx.host.windowCount() - 1} window(s) stay open` },
    );
  },
  run(_props, ctx) {
    // No origin means the agent or CDP asked, so the focused window is closed, which is where an
    // unaddressed effect lands too
    const closed = ctx.host.closeWindow(ctx.origin);
    if (!closed) throw new Error('there is no window to close');
    return Promise.resolve({ message: 'Closed the window.' });
  },
});

export const windowQuit = define({
  id         : 'window.quit',
  title      : 'Quit vnstudio',
  description:
    'Close every window and quit. Work already saved stays saved — this is not a discard — but ' +
    'a window still holding an unsaved edit asks before it goes.',
  mutating   : false,
  props      : {},
  check(_props, ctx) {
    const open = ctx.host.windowCount();
    return Promise.resolve({
      ok  : true as const,
      note: open > 1 ? `closes all ${open} windows` : 'closes the window and quits',
    });
  },
  run(_props, ctx) {
    ctx.host.quitApp();
    return Promise.resolve({ message: 'Quitting.' });
  },
});

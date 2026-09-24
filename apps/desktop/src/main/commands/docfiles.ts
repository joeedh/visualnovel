/**
 * Commands that create files and folders in the document tree, as opposed to `doc.ts`'s commands
 * over one document's contents. Every path they take must be under `FILE_ROOTS`, which is also
 * exactly what they declare in `affects`, so for these commands the declaration is enforced by
 * their own check rather than being only an upper bound.
 */
import { defineFor, prop, type CheckResult } from '@vn/commands';
import { isTextPath } from '../../shared/editors.js';
import { FILE_ROOTS } from '../../shared/fileops.js';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

/** Turns a file planner's answer into a check result, keeping its sentence in both cases. */
function verdict(result: { ok: true; note: string } | { ok: false; reason: string }): CheckResult {
  return result.ok ? { ok: true, note: result.note } : { ok: false, reason: result.reason };
}

export const docMkdir = define({
  id         : 'doc.mkdir',
  title      : 'New folder',
  description:
    'Create an empty folder inside another folder. Git does not record empty folders, so the ' +
    'folder exists on this disk only until a file is put in it.',
  notes:
    'Only under wiki/, characters/, locations/ and archive/. An empty folder is in no undo snapshot, so undo walks past this command to the one before it, and the folder stays; like every mutating command it still clears redo.',
  mutating   : true,
  affects    : FILE_ROOTS,
  undoable   : true,
  props: {
    parent: prop.string('the folder to create it in'),
    name  : prop.string('the name of the new folder'),
  },
  async check({ parent, name }, ctx) {
    return verdict(await ctx.host.session.previewMkdir(parent, name));
  },
  async run({ parent, name }, ctx) {
    const made = await ctx.host.session.mkdir(parent, name);
    if (!made.ok) throw new Error(made.reason);
    ctx.host.ui({ type: 'docs', action: 'reveal', paths: [made.path] }, ctx.origin);
    return { message: `Created the folder ${made.path}.`, data: made };
  },
});

export const docNewFile = define({
  id         : 'doc.newFile',
  title      : 'New file',
  description:
    'Create an empty file with the given name inside a folder, and open it. Refused for a name ' +
    'already taken there, and for a file the model would read as a character or location sheet.',
  notes:
    'Only under wiki/, characters/, locations/ and archive/. The name is used as typed, extension included. Media extensions are refused, because undo does not keep media files.',
  mutating   : true,
  affects    : FILE_ROOTS,
  undoable   : true,
  props: {
    parent: prop.string('the folder to create it in'),
    name  : prop.string('the file name, with its extension'),
    open: prop.boolean('show the new file in the Wiki editor, when it is text', {
      default: true,
    }),
  },
  async check({ parent, name }, ctx) {
    return verdict(await ctx.host.session.previewNewFile(parent, name));
  },
  async run({ parent, name, open }, ctx) {
    const made = await ctx.host.session.newFile(parent, name);
    if (!made.ok) throw new Error(made.reason);
    ctx.host.ui({ type: 'docs', action: 'reveal', paths: [made.path] }, ctx.origin);
    // The Wiki editor reads text only, so a file with any other extension is left in the tree
    if (open && isTextPath(made.path)) {
      ctx.host.ui(
        { type: 'view', action: 'open', editor: 'wiki', where: 'elsewhere', subject: made.path },
        ctx.origin,
      );
    }
    return { message: `Created ${made.path}.`, data: made, written: [made.path] };
  },
});

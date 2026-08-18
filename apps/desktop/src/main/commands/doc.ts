/**
 * Authored markdown documents as commands: the wiki, character sheets, location sheets. The
 * namespace is `doc.*` rather than `wiki.*` because a character tagged `type:` under `wiki/` is
 * authored in either place — naming half of what these reach would be a lie about the other half.
 *
 * `scenes/**` is refused outright. Prose has exactly one write path and it is `story.*`; a chunk
 * written whole is unvalidated, and the refusal is the same code the agent's `write_file` runs.
 */
import { defineFor, prop, type CheckResult } from '@vn/commands';
import type { NewDocKind } from '../session.js';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

const NEW_DOC_KINDS = ['character', 'location', 'note', 'skill'] as const;

/** A `DocResult` read as a precondition: the plan's own sentence either way. */
function verdict(result: { ok: true; note: string } | { ok: false; reason: string }): CheckResult {
  return result.ok ? { ok: true, note: result.note } : { ok: false, reason: result.reason };
}

export const docRead = define({
  id: 'doc.read',
  title: 'Read a document',
  description:
    'The text of one workspace document — a wiki note, a character or location sheet — with the ' +
    'content hash it was read at, which a later save presents back. Bounded and text only.',
  mutating: false,
  props: {
    path: prop.string('workspace-relative path to the file'),
  },
  async run(props, ctx) {
    const read = await ctx.host.session.readDoc(props.path);
    if (!read.ok) throw new Error(read.reason);
    return { message: `Read ${read.file.path} (${read.file.bytes} bytes).`, data: read.file };
  },
});

export const docWrite = define({
  id: 'doc.write',
  title: 'Save a document',
  description:
    'Overwrite one workspace document with the given text. `seenHash` is the hash `doc.read` ' +
    'returned: a file that changed underneath the edit is refused rather than overwritten. ' +
    'Front-matter that will not parse is refused, and so is a save dropping a `type:` tag the ' +
    'file had — that deletes an entity. Front-matter that parses but fails the entity schema ' +
    'saves, with the diagnostic beside it.',
  mutating: true,
  undoable: true,
  props: {
    path: prop.string('workspace-relative path to the file'),
    text: prop.string('the whole new contents of the file', { digest: true }),
    seenHash: prop.string('the hash the text was read at; empty to create a new file', {
      default: '',
    }),
  },
  async check({ path, text, seenHash }, ctx) {
    return verdict(await ctx.host.session.previewDoc(path, text, seenHash));
  },
  async run({ path, text, seenHash }, ctx) {
    const saved = await ctx.host.session.saveDoc(path, text, seenHash);
    if (!saved.ok) throw new Error(saved.reason);
    const note = saved.diagnostic ? ` ${saved.diagnostic}` : '';
    return {
      message: `Saved ${saved.path} (${saved.bytes} bytes).${note}`,
      data: saved,
      written: [saved.path],
    };
  },
});

export const docRename = define({
  id: 'doc.rename',
  title: 'Rename a document',
  description:
    'Change the name a document is known by, in place. A character or location sheet is renamed ' +
    'through its `name:` field; anything else through its title — front-matter `title:`, else the ' +
    'first heading — so the new name is read back from wherever the old one was. **The file does ' +
    'not move**: an id is derived from a name once, at creation, and afterwards it is what shots, ' +
    'cast lists and `[[goto:]]` markers point at.',
  mutating: true,
  undoable: true,
  props: {
    path: prop.string('workspace-relative path to the file'),
    name: prop.string('the new name'),
  },
  async check({ path, name }, ctx) {
    return verdict(await ctx.host.session.previewRename(path, name));
  },
  async run({ path, name }, ctx) {
    const saved = await ctx.host.session.renameDoc(path, name);
    if (!saved.ok) throw new Error(saved.reason);
    return {
      message: `Renamed ${saved.path}: ${saved.what} is now "${name.trim()}".`,
      data: saved,
      written: [saved.path],
    };
  },
});

export const docCreate = define({
  id: 'doc.create',
  title: 'Create a document',
  description:
    'Scaffold a character sheet, a location sheet, a wiki note or a skill from a name, in its ' +
    'conventional home. Refuses rather than overwriting a document already at that path.',
  mutating: true,
  undoable: true,
  props: {
    kind: prop.oneOf(NEW_DOC_KINDS, 'what to create'),
    name: prop.string('the name it is known by; the id is derived from it'),
  },
  async check({ kind, name }, ctx) {
    return verdict(await ctx.host.session.previewCreate(kind as NewDocKind, name));
  },
  async run({ kind, name }, ctx) {
    const made = await ctx.host.session.createDoc(kind as NewDocKind, name);
    if (!made.ok) throw new Error(made.reason);
    return {
      message: `Created ${made.path}.`,
      data: made,
      written: [made.path],
    };
  },
});

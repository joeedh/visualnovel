/**
 * UI state as commands. These run in main like every other command and push an effect the
 * renderer applies, so the palette, the menu bar and CDP all reach the same vocabulary
 * rather than the renderer maintaining a second registry to keep in sync.
 *
 * They address editors, not rooms. The shell is a mesh of panes, so `view.open`, `view.focus` and
 * the two layout verbs name an editor and optionally where to put it. The names come from
 * `shared/editors.ts`, which is also what the renderer registers them under.
 */
import { defineFor, prop } from '@vn/commands';
import { EDITOR_IDS, OPEN_WHERE, editorTitle, type OpenWhere } from '../../shared/editors.js';
import {
  DEFAULT_LAYOUT,
  LAYOUT_DIR,
  layoutSlug,
  parseLayoutFile,
  type LayoutFile,
} from '../../shared/layouts.js';
import { listLayouts, readLayout, resetLayouts, writeLayout } from '../layouts.js';
import type { CommandHost } from './host.js';
import { templateKey } from '../../shared/sessionkeys.js';

const define = defineFor<CommandHost>();

/**
 * Which template the asking window is showing, remembered beside its live mesh.
 *
 * The key is derived from who asked rather than being a module constant: with a flat
 * `pathux.template`, `view.applyLayout` in window A wrote it and `view.resetLayout` in window B
 * then re-applied A's template to B. The workspace is not part of it, because the key routes to
 * the project's own session file (`../sessionstate.ts`).
 *
 * A command with no origin (the agent, CDP, main itself) is recorded against the window its
 * effect will land in, which is the focused one.
 */
function templateKeyFor(ctx: { origin?: number; host: CommandHost }): string {
  return templateKey(ctx.origin ?? ctx.host.focusedWindow());
}

const WHERE: Record<OpenWhere, string> = {
  here     : 'in this pane',
  left     : 'to the left',
  right    : 'to the right',
  above    : 'above',
  below    : 'below',
  elsewhere: 'in another pane',
  window   : 'in a new window',
  popup    : 'in a floating window',
};

/** What the optional subject is, said once — both `view.*` verbs take it and mean the same. */
const SUBJECT =
  'what to show once it is there: a workspace-relative path for the Wiki editor, an asset ' +
  'hash for the Asset editor';

/** ` on wiki/history.md`, or nothing — the half of the sentence a subject adds. */
const onSubject = (subject: string): string => (subject ? ` on ${subject}` : '');

export const viewOpen = define({
  id         : 'view.open',
  title      : 'Show an editor',
  description:
    'Show an editor: in the active pane, in a new pane split off it, `elsewhere` — the ' +
    'biggest pane that is not the active one — or `popup`, a floating window over the mesh. ' +
    'Already open and asked for `here`, `elsewhere` or `popup`, it is focused rather than ' +
    'opened twice.',
  notes:
    'Shows an editor, in the active pane or in a new pane split off it. `elsewhere` is anywhere but the asking pane; `window` is not a pane at all — it opens a second window showing the editor.',
  mutating   : false,
  props: {
    editor : prop.oneOf(EDITOR_IDS, 'which editor to show'),
    where  : prop.oneOf(OPEN_WHERE, 'where to put it', { default: 'here' }),
    subject: prop.string(SUBJECT, { default: '' }),
  },
  async run({ editor, where, subject }, ctx) {
    // A mesh cannot open a window for itself, so this case is answered in main rather than
    // pushed as an effect; the new renderer opens showing the editor
    if (where === 'window') {
      const id = await ctx.host.newWindow({ editor, subject: subject || undefined });
      return {
        message: `Showing ${editorTitle(editor)}${onSubject(subject)} in window ${id}.`,
        data   : { window: id },
      };
    }

    ctx.host.ui({ type: 'view', action: 'open', editor, where, subject }, ctx.origin);
    return {
      message: `Showing ${editorTitle(editor)}${onSubject(subject)} ${WHERE[where]}.`,
    };
  },
});

export const viewFocus = define({
  id         : 'view.focus',
  title      : 'Focus an editor',
  description: 'Make the pane already showing an editor the active one, without moving anything.',
  notes      : 'Makes the pane already showing an editor the active one.',
  mutating   : false,
  props: {
    editor : prop.oneOf(EDITOR_IDS, 'which editor to focus'),
    subject: prop.string(SUBJECT, { default: '' }),
  },
  run({ editor, subject }, ctx) {
    ctx.host.ui({ type: 'view', action: 'focus', editor, subject }, ctx.origin);
    return Promise.resolve({ message: `Focused ${editorTitle(editor)}${onSubject(subject)}.` });
  },
});

export const viewClose = define({
  id         : 'view.close',
  title      : 'Close the active pane',
  description: 'Collapse the active pane into its neighbour. The last pane is kept.',
  notes      : 'Collapses the active pane into its neighbour; the last pane is kept.',
  mutating   : false,
  props      : {},
  run(_props, ctx) {
    ctx.host.ui({ type: 'view', action: 'close' }, ctx.origin);
    return Promise.resolve({ message: 'Closed the pane.' });
  },
});

export const viewLayout = define({
  id         : 'view.layout',
  title      : 'Rebuild the default arrangement',
  description:
    'Throw the arrangement away and build the one the app ships with, ignoring the layout ' +
    'templates in the project entirely. The escape hatch for a mesh no template can fix; the ' +
    'menu offers `view.applyLayout` instead.',
  notes:
    "Throws the remembered arrangement away and rebuilds the default one, ignoring the project's layout templates. The escape hatch; the menu offers `view.applyLayout` instead.",
  mutating   : false,
  props      : {},
  run(_props, ctx) {
    ctx.host.ui({ type: 'view', action: 'reset' }, ctx.origin);
    return Promise.resolve({ message: 'Layout reset.' });
  },
});

export const viewLayouts = define({
  id         : 'view.layouts',
  title      : 'List the layout templates',
  description:
    'Every named arrangement this project has, and which one the window is showing. A layout ' +
    'that cannot be applied — one a merge left unresolved, one naming an editor this build has ' +
    'not got — is listed with the reason rather than left out.',
  notes:
    'Every layout template the project has, and which one the window is showing. One a merge left unresolved is listed with the reason rather than left out.',
  mutating   : false,
  props      : {},
  async run(_props, ctx) {
    const layouts = await listLayouts(ctx.root);
    const active = ctx.host.state.get(templateKeyFor(ctx), '');
    const broken = layouts.filter((entry) => entry.problem).length;
    return {
      message: `${layouts.length} layout${layouts.length === 1 ? '' : 's'}${
        broken ? `, ${broken} unusable` : ''
      }.`,
      data   : { active, layouts },
    };
  },
});

export const viewApplyLayout = define({
  id         : 'view.applyLayout',
  title      : 'Rearrange the window to a layout',
  description:
    'Rearrange the whole window to one of the project’s layout templates. Not undoable and not ' +
    'a write: which panes you have open is a window fact, remembered per install.',
  notes:
    "Rearranges the whole window to one of the project's layout templates. Refuses a missing or unreadable one by name.",
  mutating   : false,
  props      : { name: prop.string('the layout’s slug, as `view.layouts` lists it') },
  async run({ name }, ctx) {
    const read = await readLayout(ctx.root, name);
    if (!read.ok) throw new Error(read.reason);

    ctx.host.state.set(templateKeyFor(ctx), name);
    ctx.host.ui(
      {
        type       : 'view',
        action     : 'apply',
        slug       : name,
        fingerprint: read.fingerprint,
        layout     : read.file,
      },
      ctx.origin,
    );
    return { message: `Rearranged the window to ${read.file.title}.` };
  },
});

export const viewSaveLayout = define({
  id         : 'view.saveLayout',
  title      : 'Save the current layout as a template',
  description:
    'File the arrangement on screen in the project as a named layout, so it can be applied ' +
    'again and travels to whoever else works on the story. Saving over one that exists is ' +
    'allowed and is one undo away.',
  notes:
    'Files the arrangement on screen in the project as `.vnstudio/layouts/<slug>.json`. Saving over one that exists is allowed and is one undo away.',
  mutating   : true,
  undoable   : true,
  props: {
    name  : prop.string('what to call it; the filename is derived from this'),
    // Composed by the renderer, because only a live screen can serialize a mesh or say which
    // editors are in it. Main still decides the slug, the title and where the file goes.
    layout: prop.string('the arrangement, as the renderer serialized it', { digest: true }),
  },
  async check({ name, layout }, ctx) {
    const slug = layoutSlug(name);
    if (!slug)
      return { ok: false, reason: `"${name}" has nothing in it a filename can be made of` };
    const parsed = parseLayoutFile(layout);
    if (!parsed.ok)
      return { ok: false, reason: `that arrangement cannot be saved: ${parsed.problem}` };

    const existing = (await listLayouts(ctx.root)).find((entry) => entry.slug === slug);
    return {
      ok  : true,
      note: existing
        ? `replaces the ${existing.title} layout at ${LAYOUT_DIR}/${slug}.json`
        : `writes ${LAYOUT_DIR}/${slug}.json`,
    };
  },
  async run({ name, layout }, ctx) {
    const slug = layoutSlug(name);
    if (!slug) throw new Error(`"${name}" has nothing in it a filename can be made of`);
    const parsed = parseLayoutFile(layout);
    if (!parsed.ok) throw new Error(`that arrangement cannot be saved: ${parsed.problem}`);

    const file: LayoutFile = { ...parsed.file, slug, title: name.trim(), source: 'saved' };
    const path = await writeLayout(ctx.root, file);
    ctx.host.state.set(templateKeyFor(ctx), slug);
    return { message: `Saved the ${file.title} layout.`, data: { slug, path }, written: [path] };
  },
});

export const viewResetLayout = define({
  id         : 'view.resetLayout',
  title      : 'Reset the layout templates',
  description:
    'Put the layouts the app ships with back the way they shipped, overwriting any edits to ' +
    'them, and rearrange the window to the one it was showing. Undoable — the edits come back, ' +
    'and so does the arrangement.',
  notes:
    'Puts the layouts the app ships with back the way they shipped and re-applies the one on screen. `all` also deletes the ones the author saved.',
  mutating   : true,
  undoable   : true,
  confirm    : true,
  props: {
    scope: prop.oneOf(['shipped', 'all'] as const, 'which layouts to put back', {
      default: 'shipped',
    }),
  },
  async check({ scope }, ctx) {
    const layouts = await listLayouts(ctx.root);
    const mine = layouts.filter((entry) => entry.source === 'saved');
    const kept =
      scope === 'all'
        ? `deletes the ${mine.length} you saved yourself`
        : `leaves the ${mine.length} you saved yourself alone`;
    return { ok: true, note: `rewrites the shipped layouts and ${kept}` };
  },
  async run({ scope }, ctx) {
    const written = await resetLayouts(ctx.root, scope as 'shipped' | 'all');

    // Re-apply the arrangement that was on screen, so the window is never left showing an
    // arrangement no file describes any more
    const wanted = ctx.host.state.get(templateKeyFor(ctx), DEFAULT_LAYOUT) || DEFAULT_LAYOUT;
    let read = await readLayout(ctx.root, wanted);
    let slug = wanted;
    if (!read.ok) {
      slug = DEFAULT_LAYOUT;
      read = await readLayout(ctx.root, slug);
    }
    if (read.ok) {
      ctx.host.state.set(templateKeyFor(ctx), slug);
      ctx.host.ui(
        {
          type  : 'view',
          action: 'apply',
          slug,
          fingerprint: read.fingerprint,
          layout     : read.file,
        },
        ctx.origin,
      );
    }

    return { message: `Put ${written.length} layout file(s) back.`, written };
  },
});

export const viewPalette = define({
  id         : 'view.palette',
  title      : 'Toggle palette',
  description: 'Open or close the command palette.',
  notes      : 'Opens or closes the command palette.',
  mutating   : false,
  props      : { open: prop.boolean('true to open, false to close', { default: true }) },
  run({ open }, ctx) {
    ctx.host.ui({ type: 'palette', open }, ctx.origin);
    return Promise.resolve({ message: open ? 'Palette opened.' : 'Palette closed.' });
  },
});

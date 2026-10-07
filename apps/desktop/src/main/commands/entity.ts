/**
 * Deleting a character or a location. Each removes the entity's sheet and its `vngen/work` folder
 * and rewrites every document that referred to it, so the next run plans a project with no
 * dangling reference: `@vn/scriptedit`'s `deleteCharacter` and `deleteLocation` decide the
 * rewrites, and `session.deleteEntity` proves, prices and writes them.
 *
 * Both are undoable, because everything they write is a document. The approved portrait under
 * `vngen/work/characters/<id>/` is media, which no snapshot keeps; the check says so.
 */
import {
  defineFor,
  prop,
  type CheckResult,
  type CommandContext,
  type CommandOutput,
} from '@vn/commands';
import {
  CHARACTER_LINES,
  deleteCharacter,
  deleteLocation,
  type EntityOp,
  type EntityWorld,
} from '@vn/scriptedit';
import type { CommandHost } from './host.js';
import { askBeforeRemoving } from './removals.js';

const define = defineFor<CommandHost>();

/** Everything an entity delete may write: scenes, sheets wherever they sit, and `vngen/work`. */
const ENTITY_AFFECTS = ['scenes', 'characters', 'locations', 'wiki', 'vngen/work'];

function verdict(preview: { ok: boolean; message: string }): CheckResult {
  return preview.ok ? { ok: true, note: preview.message } : { ok: false, reason: preview.message };
}

async function remove(
  ctx: CommandContext<CommandHost>,
  kind: 'character' | 'location',
  id: string,
  decide: (world: EntityWorld) => EntityOp,
): Promise<CommandOutput> {
  const result = await ctx.host.session.deleteEntity(kind, id, decide);
  if (!result.ok) throw new Error(result.message);
  return {
    message: result.message,
    data   : result.graph,
    written: [...result.written, ...result.removed],
  };
}

export const characterDelete = define({
  id         : 'character.delete',
  title      : 'Delete a character',
  description:
    'Remove a character and every reference to it: its lines become narration, are deleted or ' +
    'go to another character; its outfit markers are cleared; it leaves every shot; and pins on ' +
    'its pictures are dropped. Prose that mentions it by name is listed, not rewritten.',
  notes:
    'Removes the sheet and `vngen/work/characters/<id>/`. A shot left with nobody becomes a background plate. Undo restores every document but not `approved.png`.',
  mutating   : true,
  affects    : ENTITY_AFFECTS,
  undoable   : true,
  props: {
    character: prop.string('the character to delete'),
    lines: prop.oneOf(
      CHARACTER_LINES,
      'what happens to the lines it speaks: narrate keeps the words as narration, delete ' +
        'removes them, merge gives them to mergeInto',
      { default: 'narrate' },
    ),
    mergeInto: prop.string('with lines=merge, the character who speaks those lines instead', {
      default: '',
    }),
  },
  async check({ character, lines, mergeInto }, ctx) {
    const preview = await ctx.host.session.previewEntityDelete('character', character, (world) =>
      deleteCharacter(world, { id: character, lines, mergeInto }),
    );
    return verdict(preview);
  },
  confirmWhen({ character }, ctx) {
    return askBeforeRemoving(ctx, async () => [`${character}'s sheet`]);
  },
  run({ character, lines, mergeInto }, ctx) {
    return remove(ctx, 'character', character, (world) =>
      deleteCharacter(world, { id: character, lines, mergeInto }),
    );
  },
});

export const locationDelete = define({
  id         : 'location.delete',
  title      : 'Delete a location',
  description:
    'Remove a location. Every scene set there moves to replaceWith, keeping its INT./EXT. and ' +
    'time of day, and its shots are drawn again; pins on its plates are dropped. Prose that ' +
    'mentions it by name is listed, not rewritten.',
  notes:
    'Refused without `replaceWith` while any scene is set there. Removes the sheet and `vngen/work/locations/<id>/` if present. Always asks first.',
  mutating   : true,
  affects    : ENTITY_AFFECTS,
  undoable   : true,
  confirm    : true,
  props: {
    location   : prop.string('the location to delete'),
    replaceWith: prop.string(
      'the location the scenes set there move to; needed only while some scene is',
      { default: '' },
    ),
  },
  async check({ location, replaceWith }, ctx) {
    const preview = await ctx.host.session.previewEntityDelete('location', location, (world) =>
      deleteLocation(world, { id: location, replaceWith }),
    );
    return verdict(preview);
  },
  confirmWhen({ location }, ctx) {
    return askBeforeRemoving(ctx, async () => [`${location}'s sheet`]);
  },
  run({ location, replaceWith }, ctx) {
    return remove(ctx, 'location', location, (world) =>
      deleteLocation(world, { id: location, replaceWith }),
    );
  },
});

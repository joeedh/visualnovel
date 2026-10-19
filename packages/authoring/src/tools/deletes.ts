/**
 * The agent's deletes: a character, a location, and files under the file roots. Each runs the rule
 * its desktop command runs, with one difference: where a reference needs a decision (whose lines
 * these become, where these scenes are set), the tool refuses by name and the agent makes that
 * decision with its other tools first. The delete itself rewrites what needs no decision (outfit
 * markers, shot subjects, pins).
 *
 * All three are `confirm: true`, so the author answers before anything is removed, and none can be
 * undone from the app: the agent's writes reach history only through its commit.
 */
import { z } from 'zod';
import { deleteCharacter, deleteLocation, spokenBy } from '@vn/scriptedit';
import {
  applyEntityPlan,
  applyFileDelete,
  entityPlanMessage,
  planEntityDelete,
  planFileDelete,
  type AppliedEntityPlan,
} from '@vn/scriptedit/write';
import type { Workspace } from '../workspace.js';
import { fail, ok, rel, type Tool, type ToolResult } from './core.js';

/** Formats `n thing(s)` with the plural spelled out. */
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Writes a proved entity delete and reports it, every written and removed path included. */
async function applyEntity(workspace: Workspace, plan: AppliedEntityPlan): Promise<ToolResult> {
  const { written, removed } = await applyEntityPlan({ paths: workspace.paths }, plan);
  const paths = [...written, ...removed].map((file) => rel(workspace.root, file));
  const message = entityPlanMessage(plan, workspace.root, undefined, 'Deleted', false);
  return ok(message, {
    written: paths,
    data   : { paths, removed: removed.map((f) => rel(workspace.root, f)) },
  });
}

const characterArgs = z
  .object({ character: z.string().min(1).describe('the character id, e.g. aiko') })
  .strict();

/**
 * Deletes a character once it speaks no line. Its outfit markers are cleared, it leaves every
 * shot, and pins on its pictures are dropped; its sheet and generated work are removed.
 */
const deleteCharacterTool: Tool<z.infer<typeof characterArgs>> = {
  name       : 'delete_character',
  description:
    'Delete a character: removes its sheet and its generated work, clears its outfit markers, ' +
    'takes it out of every shot (a shot left with nobody becomes a background plate) and drops ' +
    'its pictures from other prompts. Refused while it speaks any line: first give those lines ' +
    'to someone else or make them narration (edit_scene op=setSpeaker), or delete them ' +
    '(op=deleteLines). Prose that still names it is listed, never rewritten. The author is ' +
    'asked first, and the app cannot undo it.',
  mutating   : true,
  confirm    : true,
  args       : characterArgs,
  async run(a, ctx) {
    const id = a.character.trim();
    const input = await ctx.workspace.entityDeleteInput();
    const plan = await planEntityDelete(input, 'character', id, (world) => {
      const spoken = spokenBy(world, id);
      if (spoken.length > 0) {
        const lines = spoken.reduce((sum, s) => sum + s.lines, 0);
        const where = spoken.map((s) => `${s.scene} (${s.lines})`).join(', ');
        return {
          ok   : false,
          error:
            `${id} still speaks ${count(lines, 'line')}: ${where}. Decide what happens to them ` +
            'first: edit_scene op=setSpeaker gives a line to someone else or makes it narration, ' +
            'and op=deleteLines removes them. Then delete the character.',
        };
      }
      return deleteCharacter(world, { id, lines: 'narrate' });
    });
    if (!plan.ok) return fail(plan.message);
    return applyEntity(ctx.workspace, plan);
  },
};

const locationArgs = z
  .object({ location: z.string().min(1).describe('the location id, e.g. classroom') })
  .strict();

/** Deletes a location once no scene is set there. Pins on its plates are dropped. */
const deleteLocationTool: Tool<z.infer<typeof locationArgs>> = {
  name       : 'delete_location',
  description:
    'Delete a location: removes its sheet and its generated work and drops its plates from ' +
    'other prompts. Refused while any scene is set there: first move each one with edit_scene ' +
    'op=setHeading. Prose that still names it is listed, never rewritten. The author is asked ' +
    'first, and the app cannot undo it.',
  mutating   : true,
  confirm    : true,
  args       : locationArgs,
  async run(a, ctx) {
    const id = a.location.trim();
    const input = await ctx.workspace.entityDeleteInput();
    const plan = await planEntityDelete(input, 'location', id, (world) => {
      const at = [...world.state.scenes.values()].filter((s) => s.location === id);
      if (world.locations.has(id) && at.length > 0) {
        return {
          ok   : false,
          error:
            `${count(at.length, 'scene is', 'scenes are')} set at ${id}: ` +
            `${at.map((s) => s.id).join(', ')}. Move each one first with edit_scene ` +
            'op=setHeading, then delete the location.',
        };
      }
      return deleteLocation(world, { id });
    });
    if (!plan.ok) return fail(plan.message);
    return applyEntity(ctx.workspace, plan);
  },
};

const fileArgs = z
  .object({
    paths: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        'workspace-relative files or folders under wiki/, characters/, locations/ or archive/',
      ),
  })
  .strict();

/** Deletes files and folders under the file roots, by `doc.delete`'s rule. */
const deleteFilesTool: Tool<z.infer<typeof fileArgs>> = {
  name       : 'delete_files',
  description:
    'Delete files or folders under wiki/, characters/, locations/ or archive/. A character or ' +
    'location sheet, or a folder holding one, is refused: delete the entity with ' +
    'delete_character or delete_location, which also rewrites what refers to it. Scenes are ' +
    'deleted with edit_scene op=deleteScene. The author is asked first, and the app cannot ' +
    'undo it.',
  mutating   : true,
  confirm    : true,
  args       : fileArgs,
  async run(a, ctx) {
    const plan = await planFileDelete(ctx.workspace.paths, a.paths, (kind) => `delete_${kind}`);
    if (!plan.ok) return fail(plan.reason);
    await applyFileDelete(ctx.workspace.root, plan);
    const paths = [...new Set([...plan.items, ...plan.files])];
    return ok(`Deleted ${plan.items.join(', ')} (${count(plan.files.length, 'file')}).`, {
      written: paths,
      data   : { paths, removed: plan.items },
    });
  },
};

export { deleteCharacterTool, deleteLocationTool, deleteFilesTool };

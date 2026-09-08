/** Wardrobe overrides: which outfit a character wears, and which variant a shot is drawn in. */
import { z } from 'zod';
import { applyMarkerPlan, planMarkerEdit } from '@vn/scriptedit/write';
import { writeShots } from '@vn/store';
import { ok, fail, rel, type Tool } from './core.js';

const outfitShape = z.object({
  scene    : z.string().min(1).describe('the scene the change applies to'),
  character: z.string().min(1).describe('who is being dressed'),
  outfit: z
    .string()
    .describe('an outfit id from the character sheet, or "" to clear and inherit the level below'),
  shot: z
    .string()
    .optional()
    .describe('omit to mark the whole scene; name a shot to override that shot alone'),
});

/**
 * Both levels of the outfit chain in one tool, because the author states both the same way —
 * "put Aiko in her tracksuit for the club scene" and "...for this one frame" differ by a word,
 * and the file each lands in is a consequence rather than a choice the author makes. `shot` picks
 * the level. When it is omitted, a `[[outfit:]]` marker is spliced into the scene chunk. When it
 * names a shot, the subject's override is written to the storyboard, which re-hashes that shot.
 *
 * Both rules come from `@vn/scriptedit`, so a refusal here is verbatim the one `story.setOutfit` or
 * `story.setSceneOutfit` would give in the app.
 */
const setOutfitTool: Tool<z.infer<typeof outfitShape>> = {
  name       : 'set_outfit',
  description:
    'Say what a character wears: for a whole scene (a [[outfit:]] marker) or for one shot of it ' +
    '(a subject override, which re-renders that frame). Pass outfit="" to clear either and let ' +
    'the level below answer. The wardrobe itself is authored on the character sheet.',
  mutating   : true,
  args       : outfitShape,
  async run(a, ctx) {
    if (a.shot !== undefined) {
      const op = await ctx.workspace.shotOutfit(a.scene, a.shot, a.character, a.outfit);
      if (!op.ok) return fail(op.error);
      await writeShots(ctx.workspace.paths, a.scene, op.shots);
      const shotsFile = `vngen/work/shots/${a.scene}.json`;
      return ok(op.message, { written: [shotsFile], data: { paths: [shotsFile] } });
    }

    const { op, sources } = await ctx.workspace.sceneOutfit(a.scene, a.character, a.outfit);
    if (!op.ok) return fail(op.error);

    const plan = planMarkerEdit(sources, op.edits);
    if (!plan.ok) return fail(plan.message);
    if (plan.patches.length === 0) return ok(`${op.message} (already so — nothing written)`);

    const files = await applyMarkerPlan(plan.patches);
    const paths = files.map((file) => rel(ctx.workspace.root, file));
    return ok(op.message, { written: paths, data: { paths } });
  },
};

const variantShape = z.object({
  scene  : z.string().min(1).describe('the scene the shot belongs to'),
  shot   : z.string().min(1).describe('the shot id, e.g. arrival__beat1'),
  variant: z.string().min(1).describe('a variant id of the scene’s location, e.g. night'),
});

/**
 * The only way to change a shot's variant after the storyboard is written. `write_storyboard`
 * takes one per shot but is refused once a file exists, and the field is easy to get wrong at
 * write time because a variant id and a location id look alike.
 *
 * The rule is `@vn/scriptedit`'s, so a refusal is verbatim the one `story.setVariant` gives.
 */
const setVariantTool: Tool<z.infer<typeof variantShape>> = {
  name       : 'set_variant',
  description:
    'Change which variant of its scene’s location one shot is drawn in — the @night read_shots ' +
    'shows. That variant is the plate the frame is drawn against, so the shot re-hashes and the ' +
    'next run draws it again. The variants themselves are authored on the location.',
  mutating   : true,
  args       : variantShape,
  async run(a, ctx) {
    const op = await ctx.workspace.shotVariant(a.scene, a.shot, a.variant);
    if (!op.ok) return fail(op.error);
    await writeShots(ctx.workspace.paths, a.scene, op.shots);
    const shotsFile = `vngen/work/shots/${a.scene}.json`;
    return ok(op.message, { written: [shotsFile], data: { paths: [shotsFile] } });
  },
};

export { setOutfitTool, setVariantTool };

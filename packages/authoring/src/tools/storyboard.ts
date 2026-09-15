// ── Storyboards: reading one, covering lines, and making one whole ──────────
import { z } from 'zod';
import { decomposeScene, realizeDecomposition } from '@vn/artgen';
import { readShots, writeShots } from '@vn/store';
import type { Scene, Shot, ShotSubject } from '@vn/types';
import { ok, fail, type Tool } from './core.js';

/**
 * A storyboard as the model reads it back: every shot with its framing, variant, cast and the
 * line ids it covers, then the gaps. One renderer for `read_shots` and `propose_storyboard`, so
 * what the agent proposes and what it later reads back are the same picture.
 */
function formatStoryboard(scene: Scene, shots: readonly Shot[]): string {
  const covered = new Set(shots.flatMap((s) => s.coversLines));
  const rows = shots.map((s) => {
    const cast =
      s.subjects.map((x) => x.characterId + (x.outfit ? `/${x.outfit}` : '')).join(', ') ||
      'nobody in frame';
    const lines = s.coversLines.length
      ? `covers ${s.coversLines.join(', ')}`
      : 'covers nothing — never shown';
    const kind = s.panels ? `page · ${s.panels.length}` : s.framing;
    const panels = (s.panels ?? []).map((p, i) => {
      const who = p.subjects.map((x) => x.characterId).join(', ') || 'nobody';
      const held = p.coversLines.length ? p.coversLines.join(', ') : 'no lines';
      return `\n    panel ${i + 1} (${p.framing}): ${who} — ${held}`;
    });
    return `${s.id}  [${kind} @${s.location}]  ${cast}\n    ${lines}${panels.join('')}`;
  });
  const gaps = scene.lines.filter((l) => !covered.has(l.id)).map((l) => l.id);
  const tail = gaps.length
    ? `Uncovered: ${gaps.join(', ')} — the runner holds the previous image over them.`
    : 'Every line is covered.';
  return [...rows, tail].join('\n');
}

/**
 * A proposal's shots as `write_storyboard`'s `shots` argument. Only the fields that tool takes,
 * so what `propose_storyboard` prints can be restated without editing; `sceneId` and `status` are
 * the scene's and the pipeline's, not the caller's.
 */
function storyboardArgsOf(shots: readonly Shot[]): unknown[] {
  const subjectsOf = (list: readonly ShotSubject[]): unknown[] =>
    list.map((x) => ({
      characterId: x.characterId,
      ...(x.pose === undefined ? {} : { pose: x.pose }),
      ...(x.expression === undefined ? {} : { expression: x.expression }),
    }));
  return shots.map((s) => ({
    id      : s.id,
    framing : s.framing,
    location: s.location,
    subjects: subjectsOf(s.subjects),
    ...(s.camera === undefined ? {} : { camera: s.camera }),
    ...(s.aspect === undefined ? {} : { aspect: s.aspect }),
    // A realized page carries its outlines, so the restatement needs no layout name
    ...(s.panels === undefined
      ? {}
      : {
          panels: s.panels.map((p) => ({
            shape  : p.shape,
            framing: p.framing,
            ...(p.camera === undefined ? {} : { camera: p.camera }),
            subjects   : subjectsOf(p.subjects),
            coversLines: p.coversLines,
            ...(p.artNotes === undefined ? {} : { artNotes: p.artNotes }),
          })),
        }),
    ...(s.sheet === undefined ? {} : { sheet: s.sheet }),
    coversLines: s.coversLines,
  }));
}

const readShotsTool: Tool<{ scene: string }> = {
  name       : 'read_shots',
  description:
    'Read a scene’s storyboard: each shot’s framing, cast and the line ids it covers, plus the ' +
    'lines nothing covers. The @night after the framing is the variant of the scene’s location ' +
    'that shot is drawn against, changed with set_variant. The look before any storyboard write ' +
    '— set_coverage, edit_scene’s newShot and deleteShot, set_outfit with a shot, ' +
    'write_storyboard. A scene with ' +
    'no storyboard says so, and names both doors: propose then write one, or place the first ' +
    'shot by hand.',
  mutating   : false,
  args: z.object({ scene: z.string().min(1).describe('the scene whose storyboard to read') }),
  async run(a, ctx) {
    const { model } = await ctx.workspace.load();
    const scene = model.scenes.get(a.scene);
    if (!scene) return fail(`No scene "${a.scene}".`);
    const loaded = await readShots(
      ctx.workspace.paths,
      a.scene,
      new Set(scene.lines.map((l) => l.id)),
    );
    if (!loaded) {
      return ok(
        `Scene "${a.scene}" has no storyboard yet — nothing has decomposed it and no shot was ` +
          'placed by hand. propose_storyboard drafts one to review; edit_scene op=newShot places ' +
          'the first shot by hand, which ends decomposition for the scene.',
      );
    }
    return ok(
      `Storyboard for "${a.scene}" (${loaded.shots.length} shot(s)):\n` +
        formatStoryboard(scene, loaded.shots),
      { data: { shots: loaded.shots } },
    );
  },
};

const coverageShape = z.object({
  scene: z.string().min(1).describe('the scene the shot belongs to'),
  shot : z.string().min(1).describe('the shot whose coverage is being restated'),
  lines: z
    .array(z.string())
    .describe(
      'the full set of line ids the shot covers after the edit — a line it had that is not ' +
        'listed is released as a gap',
    ),
});

const setCoverageTool: Tool<z.infer<typeof coverageShape>> = {
  name       : 'set_coverage',
  description:
    'Restate which line ids one shot is on screen for — the whole set, not a delta. Free on a ' +
    'frame: coverage is not in its task hash, so nothing re-renders. Not free on a page under ' +
    'lettering: model, whose lines are in its prompt: the page is drawn again, and a line it ' +
    'gains joins the panel holding the line before it. Claiming a line takes it from ' +
    'whichever shot had it, and a claim that would leave a neighbour empty is refused — delete ' +
    'the neighbour first if that is what you mean. A released line is a gap the runner shows as ' +
    'the previous image held too long. Read what covers what with read_shots first.',
  mutating   : true,
  args       : coverageShape,
  async run(a, ctx) {
    const op = await ctx.workspace.shotCoverage(a.scene, a.shot, a.lines);
    if (!op.ok) return fail(op.error);
    await writeShots(ctx.workspace.paths, a.scene, op.shots);
    const shotsFile = `vngen/work/shots/${a.scene}.json`;
    return ok(op.message, { written: [shotsFile], data: { paths: [shotsFile] } });
  },
};

const proposeStoryboardTool: Tool<{ scene: string }> = {
  name       : 'propose_storyboard',
  description:
    'Ask the decomposer for a storyboard proposal for one scene and read it back into the ' +
    'conversation — shots, coverage, and where the answer came from (the model, or the ' +
    'deterministic baseline with the reason no model answered). Writes nothing, but spends one ' +
    'structured text call. Persisting is write_storyboard, restating the shots the author ' +
    'approved — in this same conversation, because a reopened thread is read-only, so an ' +
    'unpersisted proposal dies with its conversation and a re-proposal is a new roll of the dice.',
  mutating   : false,
  args       : z.object({ scene: z.string().min(1).describe('the scene to storyboard') }),
  async run(a, ctx) {
    if (!ctx.text) {
      return fail('no text model is wired into this session, so there is nothing to propose with.');
    }
    const { model, style } = await ctx.workspace.load();
    const scene = model.scenes.get(a.scene);
    if (!scene) return fail(`No scene "${a.scene}".`);
    const loaded = await readShots(
      ctx.workspace.paths,
      a.scene,
      new Set(scene.lines.map((l) => l.id)),
    );
    if (loaded) {
      return fail(
        `Scene "${a.scene}" already has a storyboard, and the file wins forever — edit it with ` +
          'edit_scene (newShot/deleteShot), set_coverage and set_outfit instead.',
      );
    }
    const result = await decomposeScene(scene, model, { text: ctx.text }, style);
    const source =
      result.source === 'model'
        ? 'Proposed by the model.'
        : `The deterministic baseline — no model answer was used: ${result.reason ?? 'unknown'}.`;
    return ok(
      `${source}\n${formatStoryboard(scene, result.shots)}\n` +
        'Nothing is written. If the author approves, restate these shots to write_storyboard — ' +
        'this is exactly the `shots` array it takes:\n' +
        JSON.stringify(storyboardArgsOf(result.shots), null, 2),
      { data: { source: result.source, reason: result.reason, shots: result.shots } },
    );
  },
};

// Both shapes are `.strict()` for the reason `@vn/types`'s art-direction shapes are: a misspelled
// key here is dropped silently, and a shot's variant sent as `variant` cost one conversation
// fifteen items and seven wrong frames before the agent worked out it had never arrived.
const framingShape = z.enum(['wide', 'medium', 'close', 'establishing']);

const subjectShape = z.object({
  characterId: z.string().min(1),
  pose       : z.string().optional(),
  expression : z.string().optional(),
});

const fraction = z.number().min(0).max(1);

const panelShape = z
  .object({
    shape: z
      .array(z.tuple([fraction, fraction]))
      .min(3)
      .optional()
      .describe(
        'the panel outline as page fractions, clockwise from the top left; left out, the ' +
          'shot’s layout places it',
      ),
    framing    : framingShape,
    camera     : z.string().optional(),
    subjects: z
      .array(subjectShape)
      .describe('who is in this panel; each must be in the shot’s cast'),
    coversLines: z.array(z.string()).describe('the line ids lettered in this panel'),
    artNotes   : z.string().optional(),
  })
  .strict();

const storyboardShotShape = z
  .object({
    id: z.string().min(1).describe('the shot id from the proposal, e.g. arrival__establishing'),
    framing: framingShape
      .optional()
      .describe('required on a frame; a page may leave it out and take its first panel’s'),
    location: z
      .string()
      .min(1)
      .describe(
        'the location variant id, e.g. "night" — not the location id; the scene already fixes ' +
          'the location',
      ),
    subjects: z
      .array(subjectShape)
      .describe('who is in frame; wardrobe is deliberately not here — outfits are set_outfit’s'),
    camera     : z.string().optional(),
    aspect: z
      .string()
      .regex(/^[1-9]\d*:[1-9]\d*$/, 'an aspect ratio such as 3:4')
      .optional()
      .describe('this shot’s own ratio; a page without one takes the project’s page_aspect'),
    layout: z
      .string()
      .optional()
      .describe(
        'a layout template by name (two-tier, three-tier, diagonal-split, splash-with-insets) ' +
          'for panels that carry no shape',
      ),
    panels: z
      .array(panelShape)
      .min(1)
      .max(6)
      .optional()
      .describe('present on a page shot: one entry per panel, in reading order'),
    sheet      : z.string().optional().describe('the staging-sheet group this shot belongs to'),
    coversLines: z.array(z.string()).describe('the line ids this shot is on screen for'),
  })
  .strict();

const writeStoryboardShape = z
  .object({
    scene: z.string().min(1).describe('the scene the storyboard is for'),
    shots: z
      .array(storyboardShotShape)
      .min(1)
      .describe('the full shot list, restated from the proposal the author approved'),
  })
  .strict();

/**
 * A line naming every shot whose variant was not one of the scene's location and what
 * `realizeDecomposition` fell back to, or the empty string when none was. The coercion is silent
 * on disk, and a shot drawn against the wrong plate looks like a model failure rather than a
 * dropped argument, so the write says which frames it changed.
 */
function coercedVariants(
  asked: readonly { id: string; location: string }[],
  written: readonly Shot[],
): string {
  // Realization namespaces a bare shot id with its scene, so the two lists rarely match on id
  const askedFor = (s: Shot): { location: string } | undefined =>
    asked.find((x) => x.id === s.id || `${s.sceneId}__${x.id}` === s.id);
  const changed = written.filter((s) => {
    const from = askedFor(s);
    return from !== undefined && from.location !== s.location;
  });
  if (changed.length === 0) return '';
  const each = changed.map((s) => `${s.id}: "${askedFor(s)!.location}" → "${s.location}"`);
  return (
    `The scene’s location has no such variant, so these shots were moved to one it has — ` +
    `${each.join('; ')}. Change any of them with set_variant.\n`
  );
}

const writeStoryboardTool: Tool<z.infer<typeof writeStoryboardShape>> = {
  name       : 'write_storyboard',
  description:
    'Persist a whole storyboard for a scene that has none — the mutating half of ' +
    'propose_storyboard. Takes the full shot list as arguments on purpose: the decomposer is ' +
    'non-deterministic, so what is written is exactly what the author read and approved, never a ' +
    'fresh roll. Every shot is a frame the pipeline will owe; a shot with panels is a page, one ' +
    'image of several panels, each with its own framing, cast and lettered lines. It refuses when a storyboard ' +
    'already exists (no force — the file wins forever; edit it instead), and it runs the same ' +
    'validation the batch decomposer does: unknown characters and invented line ids are dropped, ' +
    'and a list that binds none of the scene’s lines is refused rather than repaired into the ' +
    'baseline.',
  mutating   : true,
  args       : writeStoryboardShape,
  async run(a, ctx) {
    const { model } = await ctx.workspace.load();
    const scene = model.scenes.get(a.scene);
    if (!scene) return fail(`No scene "${a.scene}".`);
    const existing = await readShots(
      ctx.workspace.paths,
      a.scene,
      new Set(scene.lines.map((l) => l.id)),
    );
    if (existing) {
      return fail(
        `Scene "${a.scene}" already has a storyboard, and the file wins forever — edit it with ` +
          'edit_scene (newShot/deleteShot), set_coverage and set_outfit instead.',
      );
    }
    const result = realizeDecomposition({ shots: a.shots }, scene, model);
    if (result.source === 'baseline') {
      return fail(`refused: ${result.reason ?? 'the shots were unusable'} — nothing was written.`);
    }
    await writeShots(ctx.workspace.paths, a.scene, result.shots, { sheets: result.sheets });
    const shotsFile = `vngen/work/shots/${a.scene}.json`;
    return ok(
      `Wrote the storyboard for "${a.scene}" — ${result.shots.length} shot(s), each a frame the ` +
        `pipeline will owe. This ends decomposition for the scene.\n` +
        coercedVariants(a.shots, result.shots) +
        formatStoryboard(scene, result.shots),
      { written: [shotsFile], data: { paths: [shotsFile], shots: result.shots } },
    );
  },
};

export { readShotsTool, setCoverageTool, proposeStoryboardTool, writeStoryboardTool };

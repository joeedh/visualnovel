/**
 * Staging sheets: one picture that draws a group of a scene's shots as cells of a grid, so the
 * room, its furniture and its light are decided once and every member shot is drawn from its
 * cell. The sheet itself is a generation graph's business; this module holds what every host
 * derives before that graph runs — which shots a group has, how its cells are laid out, the
 * sheet's prompt and references, and the key that puts the sheet's inputs into each member's
 * task identity.
 */
import type {
  Asset,
  AssetRef,
  PanelBox,
  ProjectModel,
  PromptChunk,
  Scene,
  SheetGroup,
  Shot,
} from '@vn/types';
import type { ProjectConfig } from '@vn/config';
import { hashParts } from '@vn/util';
import { chunk, chunkList, composePrompt } from './chunks.js';
import { resolveBinding } from './refs.js';
import { stylePreamble, subjectWords } from './prompts.js';

/** The most cells one sheet carries; a longer group is the author's to split. */
export const MAX_SHEET_CELLS = 8;

/** The aspect a frame's cell is laid out at, which is the frame's own default. */
const FRAME_CELL_ASPECT = '16:9';

/**
 * The ratios a sheet may be asked for, which are the ones every image backend the project can
 * name accepts. A grid's natural ratio is rounded to the nearest of these, and the cells are the
 * grid's equal divisions of it, so a cell is close to its shot's aspect rather than exactly it.
 */
export const SHEET_ASPECTS: readonly string[] = ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9'];

/** Rows and columns for `n` cells: one row up to two cells, two rows beyond, reading order. */
export function sheetGrid(n: number): { rows: number; cols: number } {
  const count = Math.max(1, Math.min(MAX_SHEET_CELLS, n));
  if (count <= 2) return { rows: 1, cols: count };
  return { rows: 2, cols: Math.ceil(count / 2) };
}

function ratioOf(aspect: string): number {
  const [w, h] = aspect.split(':').map(Number);
  return w && h ? w / h : 1;
}

/** The listed aspect nearest a ratio, measured in log space so 2:1 and 1:2 are equally far from 1:1. */
export function nearestAspect(ratio: number): string {
  let best = SHEET_ASPECTS[0]!;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const aspect of SHEET_ASPECTS) {
    const gap = Math.abs(Math.log(ratioOf(aspect)) - Math.log(ratio));
    if (gap < bestGap) {
      best = aspect;
      bestGap = gap;
    }
  }
  return best;
}

/** The cell aspect a group is laid out at: a frame's for a group of frames, the page aspect otherwise. */
export function cellAspect(
  members: readonly Pick<Shot, 'panels'>[],
  config: ProjectConfig,
): string {
  return members.some((m) => m.panels) ? config.image_params.page_aspect : FRAME_CELL_ASPECT;
}

/** One sheet's geometry: the ratio to ask for and each cell's box in sheet fractions, reading order. */
export interface SheetLayout {
  aspect: string;
  rows: number;
  cols: number;
  cells: PanelBox[];
}

/** Lays `n` cells of `cell` aspect out on a sheet of the nearest listed aspect. */
export function sheetCells(n: number, cell: string): SheetLayout {
  const { rows, cols } = sheetGrid(n);
  const aspect = nearestAspect((cols * ratioOf(cell)) / rows);
  const cells: PanelBox[] = [];
  for (let i = 0; i < Math.min(n, rows * cols); i++) {
    cells.push({
      x: (i % cols) / cols,
      y: Math.floor(i / cols) / rows,
      w: 1 / cols,
      h: 1 / rows,
    });
  }
  return { aspect, rows, cols, cells };
}

/** The shots of one group, in the scene's own order, which is the sheet's reading order. */
export function sheetMembers(scene: Pick<Scene, 'shots'>, group: string): Shot[] {
  return scene.shots.filter((s) => s.sheet === group);
}

/** The group ids a scene's shots name, in first-appearance order. */
export function sheetGroups(scene: Pick<Scene, 'shots'>): string[] {
  const seen: string[] = [];
  for (const shot of scene.shots) {
    if (shot.sheet !== undefined && !seen.includes(shot.sheet)) seen.push(shot.sheet);
  }
  return seen;
}

/** What one cell asks for: the shot's framing (or its page's panels), its cast, camera and notes. */
function cellWords(shot: Shot, scene: Scene, model: ProjectModel): string {
  const who = shot.subjects.map((s) => subjectWords(s, s, scene, model));
  const framing = shot.panels
    ? `manga page of ${shot.panels.length} panel${shot.panels.length === 1 ? '' : 's'}: ` +
      shot.panels.map((p) => p.framing).join(', ')
    : `${shot.framing} shot`;
  const bits = [
    `${framing}: ${who.length ? who.join('; ') : 'no characters'}`,
    shot.camera ? `camera: ${shot.camera}` : '',
    shot.artNotes?.trim() ? `art direction: ${shot.artNotes.trim()}` : '',
  ].filter(Boolean);
  return `${bits.join('. ')}.`;
}

/**
 * The sheet's prompt as chunks: the style, one sentence about the grid and the room, one
 * `cell-<i>` per member, the group's notes, and a scaffolding sentence asking for a wordless grid.
 * Nothing here is overridable, so the chunks carry no keys an override could name.
 */
export function buildSheetChunks(
  scene: Scene,
  members: readonly Shot[],
  model: ProjectModel,
  config: ProjectConfig,
  group?: SheetGroup,
): PromptChunk[] {
  const location = model.locations.get(scene.location);
  const layout = sheetCells(members.length, cellAspect(members, config));
  const variants = [...new Set(members.map((m) => m.location))];
  const n = members.length;
  return chunkList(
    chunk('style', 'style', stylePreamble(config), { kind: 'project', field: 'art_style' }),
    chunk(
      'sheet',
      'framing',
      `A staging sheet of ${n} cell${n === 1 ? '' : 's'} in a ${layout.rows} by ${layout.cols} grid, ` +
        `read left to right then top to bottom, all in ${location?.name ?? scene.location} ` +
        `(${variants.join(', ')}): one continuous space, the same furniture, light and time of day ` +
        'in every cell.',
      { kind: 'builder' },
    ),
    ...members.map((shot, i) =>
      chunk(`cell-${i + 1}`, 'panel', `Cell ${i + 1}, ${cellWords(shot, scene, model)}`, {
        kind   : 'shot',
        sceneId: shot.sceneId,
        shotId : shot.id,
        field  : 'sheet',
      }),
    ),
    chunk(
      'notes',
      'art-notes',
      group?.notes?.trim() ? `Across the sheet: ${group.notes.trim()}` : '',
      {
        kind: 'builder',
      },
    ),
    chunk(
      'scaffolding',
      'scaffolding',
      `Render as one image divided into an exact ${layout.rows} by ${layout.cols} grid of equal ` +
        'cells with thin white gutters; each cell is one complete shot. No text, no lettering, ' +
        'no captions, no cell numbers.',
      { kind: 'builder' },
    ),
  );
}

/**
 * The pictures a sheet is drawn from: the plate of the first member's variant, then the approved
 * portrait of each character any member casts, in first-appearance order. Resolved from the
 * manifest rather than from a task graph, so the planner, the runner and an interactive run
 * answer the same list from the same project.
 */
export function sheetRefs(
  scene: Scene,
  members: readonly Shot[],
  model: ProjectModel,
  assets: readonly Asset[],
): AssetRef[] {
  const refs: AssetRef[] = [];
  const first = members[0];
  if (first) {
    const plate = resolveBinding(
      { kind: 'plate', locationId: scene.location, variant: first.location },
      { model, assets },
    );
    const asset = assets.find((a) => a.hash === plate);
    if (plate && asset) refs.push({ hash: plate, ext: asset.ext });
  }
  const cast = new Set<string>();
  for (const member of members) {
    for (const subject of member.subjects) {
      if (cast.has(subject.characterId)) continue;
      cast.add(subject.characterId);
      const portrait = model.characters.get(subject.characterId)?.approvedPortrait;
      if (!portrait) continue;
      const asset = assets.find((a) => a.hash === portrait);
      refs.push({ hash: portrait, ext: asset?.ext ?? 'png' });
    }
  }
  return refs;
}

/** Everything a host seeds a sheet graph with, and the geometry its scaffold and crops share. */
export interface SheetSeeds {
  group: string;
  members: Shot[];
  prompt: string;
  refs: AssetRef[];
  layout: SheetLayout;
  /** The group's own seed, when it authored one. */
  seed?: number;
}

/**
 * The seeds for one group, derived once per group by whichever host is about to draw it: the
 * planner for the members' keys, the scheduled runner and the interactive run for the graph's
 * seeded inputs. `undefined` when the scene has no such group.
 */
export function sheetSeeds(
  scene: Scene,
  group: string,
  model: ProjectModel,
  config: ProjectConfig,
  assets: readonly Asset[],
): SheetSeeds | undefined {
  const members = sheetMembers(scene, group);
  if (members.length === 0) return undefined;
  const settings = scene.sheets?.[group];
  const seeds: SheetSeeds = {
    group,
    members,
    prompt: composePrompt(buildSheetChunks(scene, members, model, config, settings)).text,
    refs  : sheetRefs(scene, members, model, assets),
    layout: sheetCells(members.length, cellAspect(members, config)),
  };
  if (settings?.seed !== undefined) seeds.seed = settings.seed;
  return seeds;
}

/**
 * What a member shot's `params.extra.sheet` carries: a hash of the sheet's prompt, its
 * references in order and the group seed. Anything that changes what the sheet is drawn from
 * changes this, and with it every member's task identity.
 */
export function sheetKey(seeds: Pick<SheetSeeds, 'prompt' | 'refs' | 'seed'>): string {
  return hashParts(
    seeds.prompt,
    seeds.refs.map((r) => r.hash),
    seeds.seed ?? null,
  );
}

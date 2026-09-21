import { projectConfig, type Asset, type Shot } from '@vn/types';
import { character, location, model, scene } from '@vn/testkit';
import {
  MAX_SHEET_CELLS,
  buildSheetChunks,
  cellAspect,
  nearestAspect,
  sheetCells,
  sheetGrid,
  sheetGroups,
  sheetKey,
  sheetMembers,
  sheetSeeds,
  shotInputs,
} from '../index.js';

const config = projectConfig.parse({ title: 'Test', art_style: 'ink', models: {} });

const frame = (id: string, extra: Partial<Shot> = {}): Shot => ({
  id,
  sceneId    : 'room',
  framing    : 'medium',
  location   : 'day',
  subjects   : [{ characterId: 'aiko' }],
  coversLines: [],
  ...extra,
});

function fixture() {
  const aiko = character('aiko', 'approved', 'a'.repeat(64));
  const ren = character('ren', 'approved', 'b'.repeat(64));
  const room = scene('room', ['aiko', 'ren'], 'classroom');
  room.shots = [
    frame('room__1', { framing: 'establishing', subjects: [], sheet: 'g1' }),
    frame('room__2', { sheet: 'g1', camera: 'over the shoulder' }),
    frame('room__3', { subjects: [{ characterId: 'ren' }], sheet: 'g1' }),
    frame('room__4'),
  ];
  room.sheets = { g1: { seed: 7, notes: 'the window stays on the left' } };
  const m = model([aiko, ren], [room], [location('classroom')]);
  const plate: Asset = {
    hash      : 'c'.repeat(64),
    ext       : 'png',
    kind      : 'location_ref',
    sourceTask: 't',
    refs      : [],
    modelId   : 'm',
    satisfies : [{ locationId: 'classroom', variant: 'day' }],
    accepted  : true,
  };
  // The portrait rows the two characters are approved with, which is where the seeds read them
  const portraits: Asset[] = [aiko, ren].map((c) => ({
    hash      : c.approvedPortrait!,
    ext       : 'png',
    kind      : 'portrait',
    sourceTask: `t-${c.id}`,
    refs      : [],
    modelId   : 'm',
    satisfies : [{ characterId: c.id }],
    accepted  : true,
    current   : true,
  }));
  return { m, room, assets: [plate, ...portraits] };
}

describe('the sheet grid', () => {
  it('lays one row up to two cells and two rows beyond, capped at the bound', () => {
    expect(sheetGrid(1)).toEqual({ rows: 1, cols: 1 });
    expect(sheetGrid(2)).toEqual({ rows: 1, cols: 2 });
    expect(sheetGrid(3)).toEqual({ rows: 2, cols: 2 });
    expect(sheetGrid(6)).toEqual({ rows: 2, cols: 3 });
    expect(sheetGrid(MAX_SHEET_CELLS)).toEqual({ rows: 2, cols: 4 });
    expect(sheetGrid(12)).toEqual({ rows: 2, cols: 4 });
  });

  it('rounds the grid to a listed aspect and divides it into equal cells', () => {
    expect(nearestAspect(16 / 9)).toBe('16:9');
    expect(nearestAspect(0.5)).toBe('9:16');
    const six = sheetCells(6, '16:9');
    expect(six.aspect).toBe('21:9');
    expect(six.cells).toHaveLength(6);
    expect(six.cells[4]).toEqual({ x: 1 / 3, y: 0.5, w: 1 / 3, h: 0.5 });
    const pages = sheetCells(4, '3:4');
    expect(pages.aspect).toBe('3:4');
    expect(cellAspect([{}, {}], config)).toBe('16:9');
    expect(cellAspect([{}, { panels: [] }], config)).toBe(config.image_params.page_aspect);
  });
});

describe('the sheet prompt and key', () => {
  it('names the grid, the room, each cell in scene order, and the group notes', () => {
    const { m, room } = fixture();
    const members = sheetMembers(room, 'g1');
    expect(members.map((s) => s.id)).toEqual(['room__1', 'room__2', 'room__3']);
    expect(sheetGroups(room)).toEqual(['g1']);
    const text = buildSheetChunks(room, members, m, config, room.sheets!.g1)
      .map((c) => c.text)
      .join(' ');
    expect(text).toContain('3 cells in a 2 by 2 grid');
    expect(text).toContain('classroom (day)');
    expect(text).toContain('Cell 1, establishing shot: no characters.');
    expect(text).toContain('Cell 2, medium shot: AIKO, wearing');
    expect(text).toContain('camera: over the shoulder');
    expect(text).toContain('Across the sheet: the window stays on the left');
    expect(text).toContain('No text, no lettering');
  });

  it('references the plate then each cast portrait once, and keys on prompt, refs and seed', () => {
    const { m, room, assets } = fixture();
    const seeds = sheetSeeds(room, 'g1', m, config, assets)!;
    expect(seeds.refs.map((r) => r.hash)).toEqual(['c'.repeat(64), 'a'.repeat(64), 'b'.repeat(64)]);
    expect(seeds.seed).toBe(7);
    expect(seeds.layout.cells).toHaveLength(3);
    const key = sheetKey(seeds);
    expect(sheetKey({ ...seeds, seed: 8 })).not.toBe(key);
    expect(sheetKey({ ...seeds, refs: seeds.refs.slice(1) })).not.toBe(key);
    expect(sheetKey(sheetSeeds(room, 'g1', m, config, assets)!)).toBe(key);
    expect(sheetSeeds(room, 'none', m, config, [])).toBeUndefined();
  });

  it('puts the key in a member’s params and leaves a shot in no group untouched', () => {
    const { m, room } = fixture();
    const params = { modelId: 'x', aspect: '16:9' };
    const plain = shotInputs(room.shots[3]!, room, m, config, params, []);
    expect(plain.params).toEqual(params);
    const member = shotInputs(room.shots[1]!, room, m, config, params, [], 'k1');
    expect(member.params.extra).toEqual({ sheet: 'k1' });
    expect(member.params.aspect).toBe('16:9');
  });
});

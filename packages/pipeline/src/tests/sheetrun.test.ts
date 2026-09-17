/**
 * A shot in a staging-sheet group, drawn through a bound graph. The runner seeds the graph's
 * sheet nodes from the group the shot belongs to, the same derivation the planner keyed the
 * shot on, and the graph cuts the member's cell out of the sheet on the way to the frame.
 */
import {
  GenCrop,
  GenDerivedPrompt,
  GenImage,
  GenOutput,
  GenRefList,
  GenSheetPrompt,
  GenSheetRefs,
  Graph,
  registerGenRuntimes,
  sheetCellDef,
  sheetGraph as scaffoldSheet,
} from '@vn/gengraph';
import type { GraphJournalRecord, Node } from '@vn/gengraph';
import { graphJournalFile } from '@vn/gengraph/state';
import { writeShots } from '@vn/store';
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import type { Shot } from '@vn/types';
import { readText } from '@vn/util';

import { sheetReviewNote } from '../runners.js';
import type { SheetSeeds } from '@vn/artgen';

jest.setTimeout(120_000);

registerGenRuntimes();

const SLUG = 'sheet';

function setProp(node: Node, key: string, value: unknown): void {
  const prop = node.props[key];
  if (prop === undefined) {
    throw new Error(`this node has no prop '${key}'`);
  }
  prop.setValue(value);
}

interface SheetGraph {
  graph: Graph;
  sheet: GenImage;
  crop: GenCrop;
  frame: GenImage;
}

/**
 * The sheet drawn from the seeded prompt and refs, the member's cell cut out of it, and the
 * frame drawn from the derived prompt with the cell and the sheet as references.
 */
function sheetGraph(slot: string, rect: string): SheetGraph {
  const graph = new Graph();
  const prompt = new GenSheetPrompt();
  const refs = new GenSheetRefs();
  const sheet = new GenImage();
  const crop = new GenCrop();
  const list = new GenRefList();
  const derived = new GenDerivedPrompt();
  const frame = new GenImage();
  const output = new GenOutput();

  for (const node of [prompt, refs, sheet, crop, list, derived, frame, output]) graph.add(node);
  graph.connect(prompt.outputs.prompt, sheet.inputs.prompt);
  graph.connect(refs.outputs.refs, sheet.inputs.refs);
  graph.connect(sheet.outputs.image, crop.inputs.image);
  graph.connect(crop.outputs.image, list.inputs.a);
  graph.connect(sheet.outputs.image, list.inputs.b);
  graph.connect(derived.outputs.prompt, frame.inputs.prompt);
  graph.connect(list.outputs.refs, frame.inputs.refs);
  graph.connect(frame.outputs.image, output.inputs.image);
  setProp(crop, 'rect', rect);
  setProp(output, 'slot', slot);

  return { graph, sheet, crop, frame };
}

async function journalRecords(p: TestProject): Promise<GraphJournalRecord[]> {
  const text = await readText(graphJournalFile(p.paths, SLUG));
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as GraphJournalRecord);
}

async function doneRecords(p: TestProject): Promise<Map<string, GraphJournalRecord>> {
  const out = new Map<string, GraphJournalRecord>();
  for (const record of await journalRecords(p)) {
    if (record.status === 'done') out.set(String(record.nodeId), record);
  }
  return out;
}

const frame = (id: string, sheet?: string): Shot => ({
  id,
  sceneId    : 'arrival',
  framing    : 'medium',
  location   : 'day',
  subjects   : [{ characterId: 'aiko' }],
  camera     : `static, take ${id}`,
  coversLines: [],
  status     : 'pending',
  ...(sheet === undefined ? {} : { sheet }),
});

/** Two shots of Aiko sharing a sheet and a third outside it, run up to the gate and past it. */
async function sheetProject(): Promise<TestProject> {
  const p = await makeProject({ script: SCRIPTS.linear });
  await writeShots(p.paths, 'arrival', [frame('s1', 'g'), frame('s2', 'g'), frame('s3')], {
    sheets: { g: { notes: 'the same corridor throughout' } },
  });
  await p.run();
  await p.approve('aiko');
  return p;
}

describe('a sheet member drawn through a bound graph', () => {
  it('seeds the sheet nodes from the group, cuts the cell, and draws the frame from both', async () => {
    const p = await sheetProject();
    try {
      const { graph, sheet, crop, frame: image } = sheetGraph('shot:arrival/s1', '0,0,0.5,1');
      const summary = await p.run({ graphs: { [SLUG]: graph } });
      const done = await doneRecords(p);

      expect(summary.failed).toEqual([]);
      expect(
        summary.ran.filter((t) => t.kind === 'shot_image' && t.status === 'done'),
      ).toHaveLength(3);

      const drawnSheet = done.get(String(sheet.id))?.output as { prompt: string } | undefined;
      expect(drawnSheet?.prompt).toMatch(/A staging sheet of 2 cells in a 1 by 2 grid/);
      expect(drawnSheet?.prompt).toMatch(/the same corridor throughout/);
      expect(done.get(String(crop.id))).toBeDefined();

      const drawnFrame = done.get(String(image.id))?.output as
        { refs: { store: string }[] } | undefined;
      expect(drawnFrame?.refs.map((r) => r.store)).toEqual(['blob', 'blob']);
    } finally {
      await p.cleanup();
    }
  });

  it('draws the sheet once for every member of the scaffolded graph, each from its own seeds', async () => {
    const p = await sheetProject();
    try {
      const graph = scaffoldSheet(
        [
          { slot: 'shot:arrival/s1', rect: { x: 0, y: 0, w: 0.5, h: 1 }, aspect: '16:9' },
          { slot: 'shot:arrival/s2', rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, aspect: '16:9' },
        ],
        '32:9',
        sheetCellDef(),
      );
      const summary = await p.run({ graphs: { [SLUG]: graph } });
      const records = await journalRecords(p);

      expect(summary.failed).toEqual([]);
      const sheetNode = graph.nodes.find(
        (n) => n instanceof GenImage && n.inputs.prompt.edges.length > 0,
      )!;
      // One draw of the sheet however many members run, in one process or across two
      expect(
        records.filter((r) => r.nodeId === sheetNode.id && r.status === 'running'),
      ).toHaveLength(1);

      const frames = summary.ran.filter((t) => t.kind === 'shot_image' && t.status === 'done');
      expect(frames).toHaveLength(3);
      const prompts = records
        .filter((r) => String(r.nodeId).endsWith('/image') && r.status === 'done')
        .map((r) => (r.output as { prompt: string }).prompt)
        .sort();
      expect(prompts[0]).toMatch(/^The first reference is cell 1 of 2 .*static, take s1/s);
      expect(prompts[1]).toMatch(/^The first reference is cell 2 of 2 .*static, take s2/s);
    } finally {
      await p.cleanup();
    }
  });

  it('seeds nothing for a shot in no group, and the sheet nodes carry empty values', async () => {
    const p = await sheetProject();
    try {
      const { graph, sheet } = sheetGraph('shot:arrival/s3', '0,0,0.5,1');
      const summary = await p.run({ graphs: { [SLUG]: graph } });
      const done = await doneRecords(p);

      expect(summary.failed).toEqual([]);
      const drawnSheet = done.get(String(sheet.id))?.output as { prompt: string } | undefined;
      expect(drawnSheet?.prompt).toBe('');
    } finally {
      await p.cleanup();
    }
  });
});

describe('sheetReviewNote', () => {
  it('names the cell by its position in the group', () => {
    const seeds = {
      members: [frame('s1', 'g'), frame('s2', 'g')],
    } as unknown as SheetSeeds;
    expect(sheetReviewNote(seeds, 's2')).toMatch(/^This frame was drawn from cell 2 of a 2-cell/);
  });
});

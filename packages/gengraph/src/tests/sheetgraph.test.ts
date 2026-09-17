/**
 * The graph a staging-sheet group is scaffolded as. What is checked here is that the sheet is
 * drawn once however many members run, that each member's cell is cut at its own rectangle
 * and drawn behind its own cell sentence, and that the shape the scaffold writes is the one
 * `force` is refused on.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GenOutput,
  Graph,
  GroupNode,
  activeOutputs,
  bindSlots,
  registerGenNodes,
  registerGenRuntimes,
  replayJournal,
  rectText,
  sheetCellDef,
  sheetGraph,
  validateGenGraph,
} from '../index.js';
import type { GraphJournalRecord } from '../index.js';
import { executeGenGraph, sharedAncestors } from '../execute.js';
import { readGraphDoc, writeGraphDoc, writeGroupDef } from '../document.js';
import type { GenRunContext } from '../execute.js';
import { mockServices } from '../nodes/tests/__fixtures__/services.js';
import type { MockServices } from '../nodes/tests/__fixtures__/services.js';

registerGenNodes();
registerGenRuntimes();

const CELLS = [
  { slot: 'shot:room/room__1', rect: { x: 0, y: 0, w: 0.5, h: 1 }, aspect: '16:9' },
  { slot: 'shot:room/room__2', rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, aspect: '9:16' },
];

const SEEDS = {
  GenSheetPrompt  : { prompt: 'a staging sheet of the room' },
  GenSheetRefs    : { assets: '[]' },
  GenDerivedPrompt: { prompt: 'aiko at the window' },
  GenTaskRefs     : { assets: '[]' },
};

function scaffold(): Graph {
  return sheetGraph(CELLS, '21:9', sheetCellDef());
}

function outputsOf(graph: Graph): GenOutput[] {
  return graph.nodes.filter((n): n is GenOutput => n instanceof GenOutput);
}

describe('the scaffolded sheet graph', () => {
  it('binds one output per member, the first active, and validates clean', () => {
    const graph = scaffold();
    const { bound, conflicts } = bindSlots([{ graph }]);

    expect(outputsOf(graph)).toHaveLength(2);
    expect(activeOutputs(graph).map((o) => o.slot)).toEqual(['shot:room/room__1']);
    expect(bound.has('shot:room/room__1')).toBe(true);
    expect(conflicts).toEqual([]);
    expect(validateGenGraph(graph)).toEqual([]);
  });

  it('overrides each instance with its own cell, number and aspect', () => {
    const graph = scaffold();
    const instances = graph.nodes.filter((n): n is GroupNode => n instanceof GroupNode);
    const inner = (i: number, id: string, key: string): unknown =>
      instances[i]!.subgraph.nodeIdMap.get(id)?.props[key]?.getValue();

    expect(inner(0, 'crop', 'rect')).toBe('0,0,0.5,1');
    expect(inner(1, 'crop', 'rect')).toBe('0.5,0,0.5,1');
    expect(inner(0, 'template', 'template')).toMatch(/^This is cell 1 of 2 /);
    expect(inner(1, 'template', 'template')).toMatch(/^This is cell 2 of 2 /);
    expect(inner(0, 'image', 'aspect')).toBe('16:9');
    expect(inner(1, 'image', 'aspect')).toBe('9:16');
    expect(inner(1, 'image', 'model')).toBe('');
  });

  it('names the sheet image as feeding every output, which is what refuses a forced run', () => {
    const graph = scaffold();
    const shared = sharedAncestors(graph);

    expect(shared).toHaveLength(3);
    expect(shared.every((key) => typeof key === 'number')).toBe(true);
  });

  it('writes a rectangle to four places and no trailing zeros', () => {
    expect(rectText({ x: 1 / 3, y: 0.5, w: 1 / 3, h: 0.5 })).toBe('0.3333,0.5,0.3333,0.5');
  });
});

describe('the scaffold on disk', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vn-sheetgraph-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps every override through the definition file and the graph file', async () => {
    await writeGroupDef(root, 'sheet-cell', sheetCellDef());
    await writeGraphDoc(root, 'room-sheet', scaffold());
    const read = await readGraphDoc(root, 'room-sheet');
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const instances = read.graph.nodes.filter((n): n is GroupNode => n instanceof GroupNode);
    const inner = (i: number, id: string, key: string): unknown =>
      instances[i]!.subgraph.nodeIdMap.get(id)?.props[key]?.getValue();
    expect(instances).toHaveLength(2);
    expect(inner(1, 'crop', 'rect')).toBe('0.5,0,0.5,1');
    expect(inner(1, 'template', 'template')).toMatch(/^This is cell 2 of 2 /);
    expect(inner(1, 'image', 'aspect')).toBe('9:16');
    expect(sharedAncestors(read.graph)).toHaveLength(3);
  });
});

describe('running the scaffold', () => {
  let mock: MockServices;
  const records: GraphJournalRecord[] = [];

  beforeEach(() => {
    mock = mockServices();
    records.length = 0;
  });

  function context(): GenRunContext {
    return {
      services: mock,
      journal : replayJournal(records.map((r) => JSON.stringify(r)).join('\n')),
      record: (record) => {
        records.push(record);
        return Promise.resolve();
      },
    };
  }

  it('draws the sheet once across the members and cuts each at its own cell', async () => {
    const graph = scaffold();
    const [first, second] = outputsOf(graph);

    const one = await executeGenGraph(graph, context(), { targets: [first!.id], seeds: SEEDS });
    const two = await executeGenGraph(graph, context(), { targets: [second!.id], seeds: SEEDS });

    expect(one.failures).toEqual([]);
    expect(two.failures).toEqual([]);
    // Three pictures: the sheet, then one frame per member; the second run resumed the sheet
    expect(mock.images).toHaveLength(3);
    expect(mock.images[0]!.prompt).toBe('a staging sheet of the room');
    expect(mock.images[0]!.params.aspect).toBe('21:9');
    expect(mock.crops.map((c) => c.rect)).toEqual([CELLS[0]!.rect, CELLS[1]!.rect]);

    const frames = mock.images.slice(1);
    expect(frames[0]!.prompt).toBe(
      'This is cell 1 of 2 on the attached staging sheet; match its staging and camera. aiko at the window',
    );
    expect(frames[1]!.prompt).toMatch(/^This is cell 2 of 2 /);
    expect(frames.map((f) => f.params.aspect)).toEqual(['16:9', '9:16']);
    // The cell first, then the whole sheet, ahead of nothing else because the task refs are empty
    expect(frames[0]!.refs).toHaveLength(2);
  });
});

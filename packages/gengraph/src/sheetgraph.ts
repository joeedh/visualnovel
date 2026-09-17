/**
 * The graph a staging-sheet group is scaffolded as: the sheet drawn once from the seeded sheet
 * prompt and references, and one instance of the `sheet-cell` group per member, which cuts
 * the member's cell out, puts the cell and the sheet ahead of the task's own references, and
 * draws the frame from the derived prompt behind a sentence naming the cell. Every host that
 * scaffolds a sheet builds the same graph, so a sheet drawn from the desktop or the agent is
 * the sheet the pipeline's own path would draw.
 */
import { Graph, GroupDef, GroupNode } from 'pathux-graph';
import type { Node } from 'pathux-graph';
import type { PanelBox } from '@vn/types';

import {
  GenCrop,
  GenDerivedPrompt,
  GenImage,
  GenOutput,
  GenRefList,
  GenSheetPrompt,
  GenSheetRefs,
  GenTaskRefs,
  GenTemplate,
  registerGenNodes,
} from './nodes/types.js';
import { ImageSocket } from './nodes/sockets.js';

/** The ref the per-member chain is written under, once per project. */
export const SHEET_CELL_REF = 'sheet-cell';

/** The inner node ids of the cell definition that a member's instance overrides. */
export const CELL_CROP = 'crop';
export const CELL_TEMPLATE = 'template';
export const CELL_IMAGE = 'image';

/** The words a member's frame is drawn behind; `{varB}` is the member's derived prompt. */
export function cellTemplate(index: number, count: number): string {
  return (
    `This is cell ${index} of ${count} on the attached staging sheet; match its staging and ` +
    'camera. {varB}'
  );
}

/** A cell's box as the Crop node's `rect` prop writes it, in sheet fractions. */
export function rectText(box: PanelBox): string {
  const n = (v: number): string => String(Number(v.toFixed(4)));
  return [box.x, box.y, box.w, box.h].map(n).join(',');
}

const COLUMN = 220;
const ROW = 120;

function place(node: Node, x: number, y: number): void {
  node.pos[0] = x;
  node.pos[1] = y;
}

/**
 * Builds the per-member chain as a group definition with one boundary input, the sheet, and
 * one boundary output, the frame. The derived prompt and the task's references are read
 * inside it, because they are seeded per run for the output the run targets. The crop's
 * rectangle, the template's cell number and the image's aspect are the values an instance
 * overrides; the image's model is left empty so every cell follows the project's model.
 */
export function sheetCellDef(): GroupDef {
  registerGenNodes();

  const def = new GroupDef();
  const graph = def.subgraph;
  const crop = new GenCrop();
  const refs = new GenTaskRefs();
  const list = new GenRefList();
  const prompt = new GenDerivedPrompt();
  const template = new GenTemplate();
  const image = new GenImage();

  crop.id = CELL_CROP;
  template.id = CELL_TEMPLATE;
  image.id = CELL_IMAGE;

  place(crop, COLUMN, 0);
  place(refs, 0, ROW);
  place(list, COLUMN * 2, ROW / 2);
  place(prompt, 0, ROW * 2);
  place(template, COLUMN, ROW * 2);
  place(image, COLUMN * 3, ROW);

  for (const node of [crop, refs, list, prompt, template, image]) {
    graph.add(node);
  }

  const sheetIn = def.declareInput(
    'sheet',
    new ImageSocket('in', { uiName: 'Sheet', description: 'The staging sheet to cut from.' }),
  );
  const frameOut = def.declareOutput(
    'image',
    new ImageSocket('out', { uiName: 'Image', description: "The member's frame." }),
  );
  place(def.inputNode(), 0, 0);
  place(def.outputNode(), COLUMN * 4, ROW);

  graph.connect(sheetIn, crop.inputs.image);
  graph.connect(refs.outputs.refs, list.inputs.list);
  graph.connect(crop.outputs.image, list.inputs.a);
  graph.connect(sheetIn, list.inputs.b);
  graph.connect(prompt.outputs.prompt, template.inputs.varB);
  graph.connect(template.outputs.text, image.inputs.prompt);
  graph.connect(list.outputs.refs, image.inputs.refs);
  graph.connect(image.outputs.image, frameOut);

  template.props.template?.setValue(cellTemplate(1, 1));
  return def;
}

/** One member of the sheet the graph is scaffolded for. */
export interface SheetCell {
  /** The slot the member's output fills, as the document tree writes it. */
  slot: string;
  /** The member's cell on the sheet, in sheet fractions. */
  rect: PanelBox;
  /** The aspect the member's own frame is drawn at; empty asks for none. */
  aspect: string;
}

/**
 * Builds the sheet graph: the two seeded sheet nodes feeding one image node drawn at
 * `sheetAspect`, and per member one instance of `def` (bound under {@link SHEET_CELL_REF})
 * with its cell, number and aspect overridden, feeding an output bound to the member's slot.
 * The outputs stay at the root because an output cannot be grouped, and the first is the
 * active one.
 */
export function sheetGraph(cells: readonly SheetCell[], sheetAspect: string, def: GroupDef): Graph {
  registerGenNodes();

  const graph = new Graph();
  const prompt = new GenSheetPrompt();
  const refs = new GenSheetRefs();
  const sheet = new GenImage();

  place(prompt, 0, 0);
  place(refs, 0, ROW);
  place(sheet, COLUMN, ROW / 2);
  for (const node of [prompt, refs, sheet]) {
    graph.add(node);
  }
  graph.connect(prompt.outputs.prompt, sheet.inputs.prompt);
  graph.connect(refs.outputs.refs, sheet.inputs.refs);
  sheet.props.aspect?.setValue(sheetAspect);

  cells.forEach((cell, i) => {
    const instance = new GroupNode();
    instance.ref = SHEET_CELL_REF;
    place(instance, COLUMN * 2, ROW * i);
    graph.add(instance);
    instance.setDefinition(SHEET_CELL_REF, def);
    instance.syncToDefinition();

    const inner = instance.subgraph.nodeIdMap;
    inner.get(CELL_CROP)?.props.rect?.setValue(rectText(cell.rect));
    inner.get(CELL_TEMPLATE)?.props.template?.setValue(cellTemplate(i + 1, cells.length));
    inner.get(CELL_IMAGE)?.props.aspect?.setValue(cell.aspect);

    const output = new GenOutput();
    place(output, COLUMN * 3, ROW * i);
    graph.add(output);
    output.props.slot?.setValue(cell.slot);
    output.props.active?.setValue(i === 0);

    graph.connect(sheet.outputs.image, instance.inputs.sheet!);
    graph.connect(instance.outputs.image!, output.inputs.image);
  });

  return graph;
}

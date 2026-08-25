/**
 * The graph library under `vngen/work/graphs/lib/`. A group definition is a file of its own,
 * reached by name rather than by path, so what is checked here is that a definition written by
 * one graph is the definition every other graph loads, and that a missing one is reported
 * against the instance referencing it rather than closing the document.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GenTemplate,
  Graph,
  GroupDef,
  GroupNode,
  registerGenNodes,
  TextSocket,
} from '@vn/gengraph';
import { graphGroupFile } from '@vn/gengraph/state';
import { ProjectPaths } from '@vn/store';
import { exists } from '@vn/util';

import { graphSlugs, readGraph, readGroupDef, writeGraph, writeGroupDef } from '../graphs.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vn-graphs-'));
  registerGenNodes();
});

/** A definition whose one inner node prefixes whatever feeds the group's boundary input. */
function inkWashDef(): GroupDef {
  const def = new GroupDef();
  const inner = new GenTemplate();
  def.subgraph.add(inner);

  const inText = def.declareInput('text', new TextSocket('in'));
  const outText = def.declareOutput('text', new TextSocket('in'));
  def.subgraph.connect(inText, inner.inputs.a);
  def.subgraph.connect(inner.outputs.text, outText);
  inner.props.template!.setValue('{a}, in ink wash');

  return def;
}

/** A graph holding one instance of the named definition, saved to disk. */
async function graphUsing(slug: string, ref: string): Promise<void> {
  const graph = new Graph();
  const instance = new GroupNode();
  instance.ref = ref;
  graph.add(instance);
  await writeGraph(root, slug, graph);
}

describe('the project graph library', () => {
  it('round-trips a group definition through work/graphs/lib', async () => {
    const written = await writeGroupDef(root, 'inkwash', inkWashDef());
    expect(written).toBe('vngen/work/graphs/lib/inkwash.json');
    expect(await exists(graphGroupFile(new ProjectPaths(root), 'inkwash'))).toBe(true);

    const back = await readGroupDef(root, 'inkwash');
    expect(back).toBeDefined();
    expect(Object.keys(back!.inputs)).toEqual(['text']);
    expect(Object.keys(back!.outputs)).toEqual(['text']);
    expect(back!.subgraph.nodes.some((n) => n.def.typeName === 'GenTemplate')).toBe(true);
  });

  it('answers nothing for a name with no file and for one that is not a name', async () => {
    expect(await readGroupDef(root, 'missing')).toBeUndefined();
    expect(await readGroupDef(root, '../elsewhere')).toBeUndefined();
  });

  it('reconciles a group instance against the library when the graph loads', async () => {
    await writeGroupDef(root, 'inkwash', inkWashDef());
    await graphUsing('portrait', 'inkwash');

    const read = await readGraph(root, 'portrait');
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    expect(read.diagnostics).toEqual([]);
    const instance = read.graph.nodes[0] as GroupNode;
    expect(instance.definition).toBeDefined();
    expect(Object.keys(instance.inputs)).toEqual(['text']);
    expect(instance.subgraph.nodes.some((n) => n.def.typeName === 'GenTemplate')).toBe(true);
  });

  it('opens a graph whose definition is gone, and names the instance that wanted it', async () => {
    await graphUsing('portrait', 'inkwash');

    const read = await readGraph(root, 'portrait');
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const unresolved = read.diagnostics.filter((d) => d.code === 'unresolved-group');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.message).toMatch(/group 'inkwash' did not load/);
    expect(unresolved[0]!.nodeId).toBe(read.graph.nodes[0]!.id);
  });

  it('leaves the library out of the graph listing, because a group is not a graph', async () => {
    await writeGroupDef(root, 'inkwash', inkWashDef());
    await graphUsing('portrait', 'inkwash');

    expect(await graphSlugs(root)).toEqual(['portrait']);
  });
});

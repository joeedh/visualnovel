/**
 * Bundled and run in a bare node process by headless.test.ts. Every failure here throws,
 * so a non-zero exit is the whole report; the marker on the last line proves the run
 * reached the end.
 */
import { Graph, readGraphFile, validateGenGraph, writeGraphFile } from '../../index.js';
import { TestOutput, TestSource, registerTestNodes, setProp } from './nodes.js';

function check(ok: boolean, what: string): void {
  if (!ok) {
    throw new Error(what);
  }
}

check(!('document' in globalThis), 'a DOM is present, so this proves nothing about node');

registerTestNodes();

const graph = new Graph();
const source = new TestSource();
const output = new TestOutput();

graph.add(source);
graph.add(output);
graph.connect(source.outputs.blob, output.inputs.image);
setProp(output, 'slot', 'portrait:ada');

const read = readGraphFile(JSON.parse(JSON.stringify(writeGraphFile(graph))) as unknown);
check(
  read.diagnostics.length === 0,
  `the graph did not survive JSON: ${JSON.stringify(read.diagnostics)}`,
);
check(read.graph !== undefined, 'the graph did not load');
check(read.graph!.nodes.length === 2, 'the loaded graph lost a node');
check(read.graph!.sort().cycles.length === 0, 'the loaded graph reported a cycle');
check(validateGenGraph(read.graph!).length === 0, 'the loaded graph failed validation');

console.log('GENGRAPH-HEADLESS-OK');

/**
 * The held graph and group parses a session serves the renderer. What is pinned is that a change
 * to a definition file, made by something this process never saw write it, reaches a graph that
 * instances it on the next read, with no `noteWrites` in between.
 */
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Graph, GenTemplate, GroupNode, createGroup } from '@vn/gengraph';
import { writeGraph, writeGroupDef } from '../graphs.js';
import { WorkspaceSession, type SessionDeps } from '../session.js';

const deps: SessionDeps = {
  emitEvent: () => {},
  emitReport: () => {},
  requestPlan: () => Promise.resolve({ approved: false }),
  requestAnswer: () => Promise.resolve([]),
  requestConfirm: () => Promise.resolve(false),
  pushBusy: () => {},
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vn-graphdoc-'));
  await writeFile(join(root, 'project.yaml'), 'title: Graphs\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

/** A graph holding one instance of a one-node definition, both on disk. */
async function seeded(): Promise<{ lib: string }> {
  const graph = new Graph();
  const template = new GenTemplate();
  graph.add(template);
  createGroup(graph, [template.id], 'inkwash');
  const def = (graph.nodes[0] as GroupNode).definition!;
  const lib = join(root, await writeGroupDef(root, 'inkwash', def));
  await writeGraph(root, 'portrait', graph);
  return { lib };
}

/** Rewrites the definition file with its template changed, dated after whatever was held. */
async function editDefinition(lib: string, text: string): Promise<void> {
  const json = JSON.parse(await readFile(lib, 'utf8')) as unknown;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (record.apiname === 'template') record.data = text;
      Object.values(record).forEach(walk);
    }
  };
  walk(json);
  await writeFile(lib, JSON.stringify(json));
  const later = new Date(Date.now() + 5_000);
  await utimes(lib, later, later);
}

function templateOf(read: { ok: boolean; file?: Record<string, unknown> }): string {
  return JSON.stringify(read.file);
}

describe('graphDoc', () => {
  it('re-reads a graph when a definition it instances changes on disk', async () => {
    const { lib } = await seeded();
    const session = new WorkspaceSession(root, true, deps);

    const first = await session.graphDoc('portrait');
    expect(first.ok).toBe(true);
    expect(await session.graphDoc('portrait')).toBe(first);

    await editDefinition(lib, 'in ink wash');
    const second = await session.graphDoc('portrait');
    expect(second).not.toBe(first);
    expect(templateOf(second)).toContain('in ink wash');
  });

  it('serves a definition, and re-reads it when its file changes', async () => {
    const { lib } = await seeded();
    const session = new WorkspaceSession(root, true, deps);

    const first = await session.groupDoc('inkwash');
    expect(first.ok).toBe(true);
    expect(first.ok && first.path).toBe('vngen/work/graphs/lib/inkwash.json');
    expect(await session.groupDoc('inkwash')).toBe(first);

    await editDefinition(lib, 'in ink wash');
    const second = await session.groupDoc('inkwash');
    expect(second).not.toBe(first);
    expect(templateOf(second)).toContain('in ink wash');

    expect(await session.groupDoc('missing')).toEqual({
      ok: false,
      reason: 'there is no missing group in this project',
    });
  });
});

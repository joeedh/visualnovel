/**
 * The executed tier: run a command over a real project and compare what the workspace diff finds
 * against what the command declared it may write.
 *
 * `affects` is an upper bound, so a run that writes less than it declared passes and an empty diff
 * is not a failure. What fails is a path outside the declaration — in the diff, or in the
 * command's own `written` list, which catch different things. The diff misses media, since a
 * capture skips it wherever it sits; `written` misses whatever the command forgot to report.
 */
import { rm } from 'node:fs/promises';
import { makeProject, type TestProject } from '@vn/testkit';
import { covers } from '../../../shared/affects.js';
import { createDesktopRegistry } from '../index.js';
import { openAffectsHarness, type AffectsHarness, type RunResult } from './__fixtures__/affects.js';

const registry = createDesktopRegistry();

/** The paths one run touched that its declaration does not reach, each labelled by where it came from. */
function uncovered(id: string, result: RunResult, declared?: readonly string[]): string[] {
  const affects = declared ?? registry.get(id)?.affects ?? [];
  return [
    ...result.diff.filter((path) => !covers(affects, path)).map((path) => `diff ${path}`),
    ...result.written.filter((path) => !covers(affects, path)).map((path) => `written ${path}`),
  ];
}

describe('a command writes only inside what it declared', () => {
  let project: TestProject;
  let harness: AffectsHarness;
  let node: string;

  beforeAll(async () => {
    project = await makeProject({ title: 'Affects' });
    harness = await openAffectsHarness(project);
    const made = await harness.run('gengraph.create', { name: 'portrait' });
    expect(made.ok).toBe(true);
    const added = await harness.run('gengraph.addNode', {
      slug: 'portrait',
      type: 'GenImage',
      x   : 0,
      y   : 0,
    });
    expect(added.error).toBeUndefined();
    node = String((added.data as { node?: unknown }).node);
  }, 60_000);

  afterAll(async () => {
    await harness.dispose();
    await rm(project.dir, { recursive: true, force: true, maxRetries: 3 });
  });

  /**
   * `gengraph.setProp` is the proof because its reach is exactly one file under
   * `vngen/work/graphs/`. `doc.write` would prove nothing: its truthful declaration is most of the
   * vocabulary, so nothing it wrote could fall outside one.
   */
  it('measures gengraph.setProp against its one subtree', async () => {
    const result = await harness.run('gengraph.setProp', {
      slug: 'portrait',
      node,
      key  : 'aspect',
      value: '3:2',
    });
    expect(result.error).toBeUndefined();
    expect(result.diff).toEqual(['vngen/work/graphs/portrait.json']);
    expect(uncovered('gengraph.setProp', result)).toEqual([]);
  });

  it('fails the same run against a declaration narrowed to the wrong subtree', async () => {
    const result = await harness.run('gengraph.setProp', {
      slug: 'portrait',
      node,
      key  : 'aspect',
      value: '1:1',
    });
    expect(result.error).toBeUndefined();
    expect(uncovered('gengraph.setProp', result, ['vngen/work/graphs/lib'])).toEqual([
      'diff vngen/work/graphs/portrait.json',
      'written vngen/work/graphs/portrait.json',
    ]);
  });
});

/**
 * `ux_check` against a real stack over a testkit project: a refused command comes back as
 * `refuse` with the rule's own sentence, a blank fills a required string so the precondition is
 * reached, and a required prop with no blank leaves the command `unjudged`, naming the prop.
 */
import { rm } from 'node:fs/promises';
import { catalogProps, type PropValue } from '@vn/commands';
import { makeProject, type TestProject } from '@vn/testkit';
import type { Tool, ToolContext } from '@vn/authoring';
import { uxCheckTool } from '../agent/uxdocs.js';
import { createDesktopRegistry } from '../commands/index.js';
import { openAffectsHarness, type AffectsHarness } from '../commands/tests/__fixtures__/affects.js';

const ctx = {} as ToolContext;
const registry = createDesktopRegistry();

let project: TestProject;
let harness: AffectsHarness;
let tool: Tool<{ command: string; props?: Record<string, PropValue> }>;

beforeAll(async () => {
  project = await makeProject({ title: 'Checked' });
  harness = await openAffectsHarness(project);
  tool = uxCheckTool({
    check: (id, props) => harness.check(id, props),
    props: (id) => {
      const command = registry.get(id);
      return command === undefined ? undefined : catalogProps(command.props);
    },
  });
}, 120_000);

afterAll(async () => {
  await harness.dispose();
  await rm(project.dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('ux_check', () => {
  it('reports a refusal in the rule’s own words', async () => {
    const result = await tool.run({ command: 'story.setNext', props: { scene: 'rooftop' } }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toBe('story.setNext: refuse — rooftop has no next scene to clear.');
    expect(result.data).toEqual({
      state  : 'refuse',
      message: 'rooftop has no next scene to clear.',
    });
  });

  it('blanks a required string it was not given, so the precondition is reached', async () => {
    const result = await tool.run(
      { command: 'gate.approve', props: { characterId: 'nobody' } },
      ctx,
    );
    expect(result.output).toMatch(/^gate\.approve: refuse — /);
    expect(result.output).not.toMatch(/invalid props/);
  });

  it('reports accept and undeclared as the stack does', async () => {
    const accepted = await tool.run(
      { command: 'story.setNext', props: { scene: 'arrival', goto: '' } },
      ctx,
    );
    expect(accepted.output).toMatch(/^story\.setNext: accept — /);
    const read = await tool.run({ command: 'story.graph' }, ctx);
    expect(read.output).toMatch(/^story\.graph: undeclared — /);
  });

  it('leaves a command with a required number it was not given unjudged, naming it', async () => {
    const result = await tool.run({ command: 'gengraph.unexpose', props: { group: 'g' } }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toBe(
      'gengraph.unexpose: unjudged — "index" is required and has no blank value, so give it to be judged.',
    );
    expect(result.data).toEqual({ state: 'unjudged', prop: 'index' });
  });

  it('refuses an id that is not a command', async () => {
    const effect = await tool.run({ command: 'pane.view' }, ctx);
    expect(effect.ok).toBe(false);
    expect(effect.output).toBe('pane.view is not a command.');
  });
});

/**
 * The three readers over a temp tree: what they list, read and find, the search cap, and the
 * refusal for a path that climbs out of the tree. `show_me`'s description is checked beside them
 * because it is what points the model at the pages, and it must not when there are none.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool, ToolContext } from '@vn/authoring';
import { describeShowMe, showMeTool } from '../agent/showme.js';
import { UX_SEARCH_CAP, uxDocsTools } from '../agent/uxdocs.js';

/** No tool here touches the workspace. */
const ctx = {} as ToolContext;

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'vn-uxdocs-'));
  await fs.mkdir(join(root, 'commands', 'gate'), { recursive: true });
  await fs.mkdir(join(root, 'effects'), { recursive: true });
  await fs.writeFile(join(root, 'README.md'), '# How to read this\n\nStart at commands/.\n');
  await fs.writeFile(
    join(root, 'commands', 'gate', 'approve.md'),
    [
      '# gate.approve',
      '',
      '## Drawn by',
      '',
      '| Editor | Module | Situations | Label |',
      '| --- | --- | --- | --- |',
      '| taskgraph | taskGraph | gate-unasked | aiko → |',
      '',
      '## Refused when',
      '',
      '| taskgraph | taskGraph | gate-without-candidates | No candidate portraits are on file. |',
      '',
    ].join('\n'),
  );
  await fs.writeFile(join(root, 'effects', 'pane.pin.md'), '# pane.pin\n\nPins the pane.\n');
  await fs.writeFile(join(root, 'not-a-page.txt'), 'candidate\n');
  // Enough matching lines to run past the cap
  const many = Array.from({ length: UX_SEARCH_CAP + 5 }, (_, i) => `| row ${i} | crowded |`);
  await fs.writeFile(join(root, 'commands', 'crowd.md'), `# crowd\n\n${many.join('\n')}\n`);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function tool(name: string): Tool {
  const found = uxDocsTools(root).find((t) => t.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
}

const run = (name: string, args: unknown) => tool(name).run(args, ctx);

describe('ux_list', () => {
  it('lists the root, directories marked', async () => {
    const result = await run('ux_list', {});
    expect(result.ok).toBe(true);
    expect(result.output.split('\n')).toEqual([
      'README.md',
      'commands/',
      'effects/',
      'not-a-page.txt',
    ]);
  });

  it('lists one directory', async () => {
    const result = await run('ux_list', { dir: 'commands/gate' });
    expect(result.output).toBe('approve.md');
  });

  it('refuses a directory outside the tree, and names one that is not there', async () => {
    const out = await run('ux_list', { dir: '../..' });
    expect(out.ok).toBe(false);
    expect(out.output).toBe('path "../.." is outside the UX docs tree');
    const gone = await run('ux_list', { dir: 'commands/nope' });
    expect(gone.ok).toBe(false);
    expect(gone.output).toMatch(/no such directory/);
  });
});

describe('ux_read', () => {
  it('reads a page whole', async () => {
    const result = await run('ux_read', { path: 'effects/pane.pin.md' });
    expect(result.ok).toBe(true);
    expect(result.output).toBe('# pane.pin\n\nPins the pane.\n');
  });

  it('reads a line range', async () => {
    const result = await run('ux_read', { path: 'commands/gate/approve.md', offset: 4, limit: 2 });
    expect(result.output).toBe(
      '| Editor | Module | Situations | Label |\n| --- | --- | --- | --- |',
    );
  });

  it('refuses a path that escapes the tree, in the words read_file uses', async () => {
    const result = await run('ux_read', { path: '../outside.md' });
    expect(result.ok).toBe(false);
    expect(result.output).toBe('path "../outside.md" is outside the UX docs tree');
  });

  it('names a page that is not there and where to look', async () => {
    const result = await run('ux_read', { path: 'commands/gate/reject.md' });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/no such page .*ux_list/);
  });
});

describe('ux_search', () => {
  it('returns path:line hits over every page, and only pages', async () => {
    const result = await run('ux_search', { query: 'candidate' });
    expect(result.ok).toBe(true);
    expect(result.output).toBe(
      'commands/gate/approve.md:11: | taskgraph | taskGraph | gate-without-candidates | No candidate portraits are on file. |',
    );
  });

  it('takes a regex when asked, and refuses a broken one', async () => {
    const result = await run('ux_search', { query: '^# (gate|pane)', regex: true });
    expect(result.output.split('\n')).toEqual([
      'commands/gate/approve.md:1: # gate.approve',
      'effects/pane.pin.md:1: # pane.pin',
    ]);
    const broken = await run('ux_search', { query: '(', regex: true });
    expect(broken.ok).toBe(false);
    expect(broken.output).toMatch(/invalid regex/);
  });

  it('says when nothing matched', async () => {
    const result = await run('ux_search', { query: 'unicorn' });
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/No matches for "unicorn"/);
  });

  it('stops at the cap and says how many more there were', async () => {
    const result = await run('ux_search', { query: 'crowded' });
    const lines = result.output.split('\n');
    expect(lines).toHaveLength(UX_SEARCH_CAP + 1);
    expect(lines[UX_SEARCH_CAP]).toBe('… and 5 more. Narrow the query.');
  });
});

describe('describeShowMe', () => {
  const deps = { commands: { get: () => undefined }, interactions: { get: () => undefined } };

  it('points at ux_read only when the pages are there', () => {
    expect(describeShowMe({ pages: true })).toMatch(/ux_read/);
    expect(describeShowMe({ pages: false })).not.toMatch(/ux_/);
    expect(describeShowMe({ pages: false })).toMatch(/interaction\.list/);
  });

  it('is what the tool advertises, pages or not', () => {
    expect(showMeTool({ ...deps, pages: true }).description).toBe(describeShowMe({ pages: true }));
    expect(showMeTool(deps).description).toBe(describeShowMe({ pages: false }));
  });
});

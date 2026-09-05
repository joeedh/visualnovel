import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool, ToolResult } from '@vn/authoring';
import { Budget, createSourceTools, DEFAULT_READ_BUDGET } from '../sourcetools.js';

interface Fixture {
  dir: string;
  source: string;
  project: string;
}

const write = async (path: string, text: string): Promise<void> => {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, text, 'utf8');
};

async function fixture(): Promise<Fixture> {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'vn-srctools-')));
  const source = join(dir, 'source');
  const project = join(dir, 'project');

  await write(join(source, 'CLAUDE.md'), '# map\n\nthe needle is in the map too\n');
  await write(join(source, 'package.json'), '{ "name": "vn" }\n');
  await write(join(source, 'packages', 'agentreport', 'src', 'thing.ts'), 'const needle = 1;\n');
  await write(join(source, 'packages', 'agentreport', 'node_modules', 'dep.ts'), 'needle\n');
  await write(join(source, 'docs', 'plan.md'), 'no match here\n');
  await write(join(source, 'vngen', 'notes.md'), 'needle in the build tree\n');

  await write(join(project, 'scenes', 'one.fountain'), 'INT. ROOM - DAY\n');
  await write(join(project, 'keys', 'gemini.txt'), 'sk-not-a-real-key\n');
  return { dir, source, project };
}

const tools = (fx: Fixture, over: Partial<Parameters<typeof createSourceTools>[0]> = {}) =>
  createSourceTools({ sourceRoot: fx.source, projectRoot: fx.project, ...over });

const call = (registry: Map<string, Tool>, name: string, args: unknown): Promise<ToolResult> =>
  (registry.get(name) as Tool<Record<string, unknown>>).run(
    args as Record<string, unknown>,
    {
      root: '',
    } as never,
  );

let fx: Fixture;

beforeAll(async () => {
  fx = await fixture();
});

afterAll(async () => {
  await fs.rm(fx.dir, { recursive: true, force: true });
});

describe('the registry', () => {
  it('is three read tools and nothing that writes', () => {
    const registry = tools(fx);
    expect([...registry.keys()].sort()).toEqual(['fetch_api_docs', 'grep', 'read_file']);
    for (const tool of registry.values()) expect(tool.mutating).toBe(false);
  });
});

describe('grep', () => {
  it('answers with file:line out of the readable roots', async () => {
    const res = await call(tools(fx), 'grep', { pattern: 'needle' });
    expect(res.ok).toBe(true);
    expect(res.output).toContain('packages/agentreport/src/thing.ts:1:');
    expect(res.output).toContain('CLAUDE.md:3:');
  });

  it('does not walk what the build does not ship', async () => {
    const res = await call(tools(fx), 'grep', { pattern: 'needle' });
    expect(res.output).not.toContain('node_modules');
    expect(res.output).not.toContain('vngen/notes.md');
  });

  it('narrows to a glob', async () => {
    const res = await call(tools(fx), 'grep', { pattern: 'needle', glob: 'packages/' });
    expect(res.output).toContain('packages/agentreport/src/thing.ts');
    expect(res.output).not.toContain('CLAUDE.md');
  });

  it('searches the project when asked to', async () => {
    const res = await call(tools(fx), 'grep', { pattern: 'INT\\.', where: 'project' });
    expect(res.output).toContain('scenes/one.fountain:1:');
  });

  it('says how much it looked at when it found nothing', async () => {
    const res = await call(tools(fx), 'grep', { pattern: 'zzz-not-here' });
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/No matches in \d+ file\(s\) under source\./);
  });

  it('refuses a regex it cannot compile, by name', async () => {
    const res = await call(tools(fx), 'grep', { pattern: '(' });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('invalid regex');
  });

  it('says it stopped rather than letting a cap read as "that is all"', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'vn-srccap-')));
    for (const name of ['a', 'b', 'c']) {
      await write(join(dir, 'packages', `${name}.ts`), 'needle\n'.repeat(60));
    }
    await write(join(dir, 'CLAUDE.md'), '# map\n');
    const res = await call(
      tools({ ...fx, source: dir } as Fixture, { projectRoot: fx.project }),
      'grep',
      { pattern: 'needle' },
    );
    expect(res.output).toContain('Stopped at 100 matches');
    expect(res.output).toContain('file(s) unscanned');
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('read_file', () => {
  it('reads a file out of the source', async () => {
    const res = await call(tools(fx), 'read_file', {
      path: 'packages/agentreport/src/thing.ts',
    });
    expect(res.ok).toBe(true);
    expect(res.output).toContain('const needle = 1;');
  });

  it('refuses a path that climbs out of the root', async () => {
    const res = await call(tools(fx), 'read_file', { path: '../project/keys/gemini.txt' });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('outside the source root');
  });

  it('refuses a source path outside the readable roots, and names them', async () => {
    const res = await call(tools(fx), 'read_file', { path: 'vngen/notes.md' });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('Readable roots:');
    expect(res.output).toContain('packages');
  });

  it('refuses a denied path even under a readable root', async () => {
    const res = await call(tools(fx), 'read_file', {
      path: 'packages/agentreport/node_modules/dep.ts',
    });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('not part of what this build ships');
  });

  it('reads the project, but never its credentials', async () => {
    const registry = tools(fx);
    const scene = await call(registry, 'read_file', {
      path : 'scenes/one.fountain',
      where: 'project',
    });
    expect(scene.ok).toBe(true);

    const key = await call(registry, 'read_file', { path: 'keys/gemini.txt', where: 'project' });
    expect(key.ok).toBe(false);
    expect(key.output).toContain('never readable');
    expect(key.output).not.toContain('sk-');
  });

  it('does not follow a link out of the root', async () => {
    const link = join(fx.source, 'packages', 'linked.ts');
    try {
      await fs.symlink(join(fx.project, 'keys', 'gemini.txt'), link, 'file');
    } catch {
      return; // Windows without developer mode; the refusal is unreachable here.
    }
    const res = await call(tools(fx), 'read_file', { path: 'packages/linked.ts' });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('symbolic link');
    await fs.rm(link, { force: true });
  });

  it('stops on the budget with a sentence saying it was a budget', async () => {
    const registry = tools(fx, { budget: new Budget(4) });
    const res = await call(registry, 'read_file', {
      path: 'packages/agentreport/src/thing.ts',
    });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('reading budget');
    expect(res.output).toContain('say in it that you stopped early');
  });
});

describe('fetch_api_docs', () => {
  const page = '<html><style>x{}</style><body><h1>Messages</h1><p>Send a &amp; get one.</p></body>';
  const fetching = (body = page) => {
    const calls: string[] = [];
    const impl = (async (url: unknown) => {
      calls.push(String(url));
      return { ok: true, status: 200, text: async () => body } as Response;
    }) as unknown as typeof globalThis.fetch;
    return { calls, impl };
  };

  it('takes a provider and a topic, never a URL', () => {
    const tool = tools(fx).get('fetch_api_docs') as Tool<Record<string, unknown>>;
    const shape = Object.keys((tool.args as unknown as { shape: Record<string, unknown> }).shape);
    expect(shape.sort()).toEqual(['provider', 'topic']);
  });

  it('refuses a provider that is not on the list, and says what is', async () => {
    const res = await call(tools(fx), 'fetch_api_docs', {
      provider: 'evil.com',
      topic   : 'messages',
    });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('anthropic');
    expect(res.output).toContain('gemini');
  });

  it('refuses a topic that provider has no page for', async () => {
    const res = await call(tools(fx), 'fetch_api_docs', {
      provider: 'anthropic',
      topic   : 'billing',
    });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('Topics:');
  });

  it('fetches the documented page and hands back prose', async () => {
    const { calls, impl } = fetching();
    const res = await call(tools(fx, { fetchImpl: impl }), 'fetch_api_docs', {
      provider: 'Anthropic',
      topic   : 'Messages',
    });
    expect(res.ok).toBe(true);
    expect(calls).toEqual(['https://docs.claude.com/en/api/messages']);
    expect(res.output).toContain('Send a & get one.');
    expect(res.output).not.toContain('<h1>');
  });

  it('reports a page that answered badly instead of inventing one', async () => {
    const impl = (async () =>
      ({
        ok    : false,
        status: 503,
        text  : async () => '',
      }) as Response) as unknown as typeof globalThis.fetch;
    const res = await call(tools(fx, { fetchImpl: impl }), 'fetch_api_docs', {
      provider: 'gemini',
      topic   : 'models',
    });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('503');
  });

  it('reads the cache the second time, and refetches on a new day', async () => {
    const cacheDir = join(fx.dir, 'cache');
    const { calls, impl } = fetching();
    const args = { provider: 'anthropic', topic: 'errors' };

    const first = tools(fx, { fetchImpl: impl, cacheDir, today: '2026-01-01' });
    await call(first, 'fetch_api_docs', args);
    const second = tools(fx, { fetchImpl: impl, cacheDir, today: '2026-01-01' });
    const hit = await call(second, 'fetch_api_docs', args);
    expect(hit.ok).toBe(true);
    expect(calls).toHaveLength(1);

    const later = tools(fx, { fetchImpl: impl, cacheDir, today: '2026-01-02' });
    await call(later, 'fetch_api_docs', args);
    expect(calls).toHaveLength(2);
  });
});

describe('Budget', () => {
  it('charges what was handed over and stops at the limit', () => {
    const budget = new Budget(100);
    expect(budget.remaining).toBe(100);
    expect(budget.take(60)).toBeUndefined();
    expect(budget.spent).toBe(60);
    expect(budget.take(60)).toContain('60 of 100 bytes');
    expect(budget.spent).toBe(60);
  });

  it('defaults to a limit generous enough to read around a bug', () => {
    expect(new Budget().remaining).toBe(DEFAULT_READ_BUDGET);
  });

  it('is shared across the tools of one analysis', async () => {
    const budget = new Budget(200);
    const registry = tools(fx, { budget });
    await call(registry, 'read_file', { path: 'package.json' });
    expect(budget.spent).toBeGreaterThan(0);
    const before = budget.spent;
    await call(registry, 'grep', { pattern: 'needle' });
    expect(budget.spent).toBeGreaterThan(before);
  });
});

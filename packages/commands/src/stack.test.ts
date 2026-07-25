import { toCatalog } from './catalog.js';
import { defineCommand, defineFor, type CommandContext, type CommandRecord } from './command.js';
import { prop } from './props.js';
import { CommandRegistry } from './registry.js';
import { CommandStack } from './stack.js';
import type { Git } from '@vn/git';

/** Just the slice of Git the stack touches, so tests need no repo on disk. */
function fakeGit(over: Partial<Record<'isRepo' | 'head' | 'isDirty', unknown>> = {}): Git {
  return {
    isRepo: () => Promise.resolve(true),
    head: () => Promise.resolve('a7c9ff4'),
    isDirty: () => Promise.resolve(false),
    ...over,
  } as unknown as Git;
}

interface Host {
  seen: string[];
}

const define = defineFor<Host>();

const greet = define({
  id: 'demo.greet',
  title: 'Greet',
  description: 'Say hello.',
  mutating: true,
  props: { who: prop.string('who to greet') },
  run(props, ctx) {
    ctx.host.seen.push(props.who);
    return Promise.resolve({
      message: `hello ${props.who}`,
      data: { who: props.who },
      written: ['a.md'],
    });
  },
});

const explode = define({
  id: 'demo.explode',
  title: 'Explode',
  description: 'Always throws.',
  mutating: false,
  props: {},
  run() {
    return Promise.reject(new Error('boom'));
  },
});

const guarded = define({
  id: 'demo.guarded',
  title: 'Guarded',
  description: 'Needs confirmation.',
  mutating: true,
  confirm: true,
  props: {},
  run(_p, ctx) {
    ctx.host.seen.push('guarded');
    return Promise.resolve({ message: 'ran' });
  },
});

function setup(over: Partial<CommandContext<Host>> = {}) {
  const registry = new CommandRegistry<Host>();
  registry.registerAll([greet, explode, guarded]);
  const host: Host = { seen: [] };
  const persisted: CommandRecord[] = [];
  const logs: string[] = [];
  const context: CommandContext<Host> = {
    root: '/ws',
    git: fakeGit(),
    host,
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...over,
  };
  const stack = new CommandStack<Host>({
    registry,
    context,
    onRecord: (r) => void persisted.push(r),
    now: () => '2026-07-25T00:00:00.000Z',
  });
  return { stack, host, persisted, logs, registry };
}

describe('CommandStack.exec', () => {
  it('runs a command and records provenance', async () => {
    const { stack, host, persisted } = setup();
    const outcome = await stack.exec('demo.greet', { who: 'aiko' }, 'ui');

    expect(outcome).toMatchObject({ ok: true, data: { who: 'aiko' } });
    expect(host.seen).toEqual(['aiko']);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      seq: 1,
      id: 'demo.greet',
      invocation: "demo.greet(who='aiko')",
      source: 'ui',
      mutating: true,
      gitHead: 'a7c9ff4',
      gitDirty: false,
      status: 'ok',
      message: 'hello aiko',
      written: ['a.md'],
    });
  });

  it('numbers records monotonically regardless of outcome', async () => {
    const { stack } = setup();
    await stack.exec('demo.greet', { who: 'a' }, 'ui');
    await stack.exec('demo.explode', {}, 'ui');
    await stack.exec('demo.greet', { who: 'b' }, 'ui');
    expect(stack.history().map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('records a thrown command as an error rather than propagating', async () => {
    const { stack } = setup();
    const outcome = await stack.exec('demo.explode', {}, 'cdp');
    expect(outcome).toMatchObject({ ok: false, error: 'boom' });
    expect(stack.history()).toHaveLength(1);
    expect(stack.history()[0]).toMatchObject({ status: 'error', error: 'boom' });
  });

  it('rejects an unknown command without recording it', async () => {
    const { stack } = setup();
    expect(await stack.exec('demo.nope', {}, 'ui')).toEqual({
      ok: false,
      error: 'unknown command "demo.nope"',
    });
    expect(stack.history()).toEqual([]);
  });

  it('rejects invalid props before running, and does not record', async () => {
    const { stack, host } = setup();
    const outcome = await stack.exec('demo.greet', {}, 'ui');
    expect(outcome.ok).toBe(false);
    expect(host.seen).toEqual([]);
    expect(stack.history()).toEqual([]);
  });

  it('degrades to null provenance outside a repo', async () => {
    const { stack } = setup({ git: fakeGit({ isRepo: () => Promise.resolve(false) }) });
    await stack.exec('demo.greet', { who: 'a' }, 'ui');
    expect(stack.history()[0]).toMatchObject({ gitHead: null, gitDirty: false });
  });

  it('records a dirty worktree', async () => {
    const { stack } = setup({ git: fakeGit({ isDirty: () => Promise.resolve(true) }) });
    await stack.exec('demo.greet', { who: 'a' }, 'ui');
    expect(stack.history()[0]!.gitDirty).toBe(true);
  });

  it('warns but still records when persistence fails', async () => {
    const registry = new CommandRegistry<Host>();
    registry.registerAll([greet]);
    const logs: string[] = [];
    const stack = new CommandStack<Host>({
      registry,
      context: {
        root: '/ws',
        git: fakeGit(),
        host: { seen: [] },
        log: (l, m) => logs.push(`${l}: ${m}`),
      },
      onRecord: () => Promise.reject(new Error('disk full')),
    });
    await stack.exec('demo.greet', { who: 'a' }, 'ui');
    expect(stack.history()).toHaveLength(1);
    expect(logs.join()).toMatch(/history not persisted.*disk full/);
  });
});

describe('confirmation gate', () => {
  it('refuses rather than assuming consent when no gate is wired', async () => {
    const { stack, host } = setup();
    expect(await stack.exec('demo.guarded', {}, 'cdp')).toMatchObject({ ok: false });
    expect(host.seen).toEqual([]);
  });

  it('runs when confirmed and skips when declined', async () => {
    const yes = setup({ confirm: () => Promise.resolve(true) });
    await yes.stack.exec('demo.guarded', {}, 'ui');
    expect(yes.host.seen).toEqual(['guarded']);

    const no = setup({ confirm: () => Promise.resolve(false) });
    expect(await no.stack.exec('demo.guarded', {}, 'ui')).toMatchObject({ ok: false });
    expect(no.host.seen).toEqual([]);
    expect(no.stack.history()).toEqual([]);
  });
});

describe('execDsl', () => {
  it('parses and dispatches', async () => {
    const { stack, host } = setup();
    expect(await stack.execDsl("demo.greet(who='haruki')", 'dsl')).toMatchObject({ ok: true });
    expect(host.seen).toEqual(['haruki']);
  });

  it('reports a parse failure without recording', async () => {
    const { stack } = setup();
    const outcome = await stack.execDsl('demo.greet(who=', 'dsl');
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.ok === false && outcome.error).toMatch(/could not parse command/);
    expect(stack.history()).toEqual([]);
  });
});

describe('undo (v1)', () => {
  it('refuses and points at the strategy report', async () => {
    const { stack } = setup();
    await stack.exec('demo.greet', { who: 'a' }, 'ui');
    expect(stack.canUndo()).toBe(false);
    expect(stack.canRedo()).toBe(false);
    for (const outcome of [await stack.undo(), await stack.redo()]) {
      expect(outcome).toMatchObject({ ok: false });
      expect(outcome.ok === false && outcome.error).toMatch(/docs\/gitUndoOptions\.md/);
    }
  });
});

describe('registry', () => {
  it('rejects malformed and duplicate ids', () => {
    const registry = new CommandRegistry<Host>();
    registry.register(greet);
    expect(() => registry.register(greet)).toThrow(/duplicate/);
    expect(() => registry.register({ ...greet, id: 'nonamespace' })).toThrow(/invalid command id/);
    expect(() => registry.register({ ...greet, id: 'Bad.Case' })).toThrow(/invalid command id/);
  });

  it('lists commands in a stable, id-sorted order', () => {
    const { registry } = setup();
    expect(registry.list().map((c) => c.id)).toEqual([
      'demo.explode',
      'demo.greet',
      'demo.guarded',
    ]);
    expect(registry.namespaces()).toEqual(['demo']);
  });
});

describe('toCatalog', () => {
  it('projects props to a usage template and a JSON Schema', () => {
    const { registry } = setup();
    const catalog = toCatalog(registry, '@vn/test');
    expect(catalog.version).toBe(1);
    expect(catalog.source).toBe('@vn/test');

    const entry = catalog.commands.find((c) => c.id === 'demo.greet')!;
    expect(entry.usage).toBe("demo.greet(who='')");
    expect(entry).toMatchObject({ mutating: true, confirm: false, undoable: false });
    expect(entry.props).toEqual([
      { name: 'who', kind: 'string', description: 'who to greet', required: true },
    ]);
    expect(entry.schema).toEqual({
      type: 'object',
      properties: { who: { type: 'string', description: 'who to greet' } },
      required: ['who'],
      additionalProperties: false,
    });
  });

  it('carries defaults, enums and bounds into the schema', () => {
    const registry = new CommandRegistry();
    registry.register(
      defineCommand({
        id: 'demo.opts',
        title: 'Opts',
        description: 'Every kind.',
        mutating: false,
        props: {
          mode: prop.oneOf(['plan', 'execute'] as const, 'mode'),
          count: prop.number('n', { default: 2, min: 0, max: 9 }),
          paths: prop.stringList('files', { default: [] }),
        },
        run: () => Promise.resolve({ message: '' }),
      }),
    );
    const entry = toCatalog(registry, 'x').commands[0]!;
    expect(entry.usage).toBe("demo.opts(mode='plan' count=2 paths=[])");
    expect(entry.schema.required).toEqual(['mode']);
    expect(entry.schema.properties.mode).toMatchObject({ enum: ['plan', 'execute'] });
    expect(entry.schema.properties.count).toMatchObject({ minimum: 0, maximum: 9, default: 2 });
    expect(entry.schema.properties.paths).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    });
  });
});

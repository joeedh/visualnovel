import { toCatalog } from '../catalog.js';
import { defineCommand, defineFor, type CommandContext, type CommandRecord } from '../command.js';
import { prop } from '../props.js';
import { CommandRegistry } from '../registry.js';
import { CommandStack } from '../stack.js';
import type { Snapshot, UndoJournal, UndoPoint } from '../undo.js';
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

/** A precondition and the run it does *not* gate: `check` refuses, `run` goes ahead anyway. */
const checked = define({
  id: 'demo.checked',
  title: 'Checked',
  description: 'Declares a precondition.',
  mutating: true,
  props: { who: prop.string('who to greet'), count: prop.number('n', { default: 1 }) },
  check(props) {
    return Promise.resolve(
      props.who === 'nobody'
        ? { ok: false, reason: 'there is no one to greet' }
        : { ok: true, note: `would greet ${props.who} ${props.count} time(s)` },
    );
  },
  run(_p, ctx) {
    ctx.host.seen.push('checked');
    return Promise.resolve({ message: 'ran' });
  },
});

const brokenCheck = define({
  id: 'demo.brokenCheck',
  title: 'Broken check',
  description: 'Its precondition throws.',
  mutating: true,
  props: {},
  check() {
    return Promise.reject(new Error('the model is not loaded'));
  },
  run: () => Promise.resolve({ message: 'ran' }),
});

function setup(over: Partial<CommandContext<Host>> = {}) {
  const registry = new CommandRegistry<Host>();
  registry.registerAll([greet, explode, guarded, checked, brokenCheck]);
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

describe('CommandStack.check', () => {
  it('reports the command’s own accept, with what it found', async () => {
    const { stack } = setup();
    expect(await stack.check('demo.checked', { who: 'aiko' })).toEqual({
      state: 'accept',
      // The default landed, so the check saw exactly what `run` would.
      message: 'would greet aiko 1 time(s)',
    });
  });

  it('reports a refusal with the rule’s own sentence', async () => {
    const { stack } = setup();
    expect(await stack.check('demo.checked', { who: 'nobody' })).toEqual({
      state: 'refuse',
      message: 'there is no one to greet',
    });
  });

  /**
   * The rule the whole three-state design exists for. A command with no precondition has said
   * nothing about whether it would run; answering `accept` would be inventing an opinion.
   */
  it('reports a command with no check as undeclared, never as an accept', async () => {
    const { stack } = setup();
    expect(await stack.check('demo.greet', { who: 'aiko' })).toEqual({
      state: 'undeclared',
      message: '"demo.greet" declares no precondition',
    });
  });

  it('refuses unknown props and unknown commands', async () => {
    const { stack } = setup();
    expect(await stack.check('demo.checked', { nope: 1 })).toMatchObject({ state: 'refuse' });
    expect(await stack.check('demo.nope', {})).toEqual({
      state: 'refuse',
      message: 'unknown command "demo.nope"',
    });
  });

  it('says a check failed to answer rather than passing the crash off as a refusal', async () => {
    const { stack } = setup();
    expect(await stack.check('demo.brokenCheck', {})).toEqual({
      state: 'refuse',
      message: 'check for "demo.brokenCheck" failed: the model is not loaded',
    });
  });

  it('changes nothing: a check is neither recorded nor a gate on exec', async () => {
    const { stack, host, persisted } = setup();
    await stack.check('demo.checked', { who: 'nobody' });
    expect(stack.history()).toEqual([]);
    expect(persisted).toEqual([]);

    // A refused check does not stop the command. `run` re-decides against the state it finds,
    // and a check that gated would turn a lost race into an unreachable command.
    expect(await stack.exec('demo.checked', { who: 'nobody' }, 'ui')).toMatchObject({ ok: true });
    expect(host.seen).toEqual(['checked']);
  });
});

/**
 * The workspace as one value, so the stack's bookkeeping can be tested without a repo. The
 * journal's own git behaviour is exercised against a real one in `undo.test.ts`.
 */
const ROOT = '/ws';

class FakeJournal {
  private n = 0;
  readonly trees = new Map<string, string>();
  readonly captured: string[] = [];
  pruneCalls = 0;
  constructor(private readonly world: { value: string }) {}

  capture(seq: number, label: string): Promise<Snapshot> {
    const commit = `c${++this.n}`;
    const snap = { commit, tree: this.world.value };
    this.trees.set(commit, this.world.value);
    this.captured.push(`${seq}/${label}`);
    return Promise.resolve({ ...snap, repos: { [ROOT]: snap } });
  }
  point(pre: Snapshot, post: Snapshot): UndoPoint {
    return { pre: pre.commit, post: post.commit, changed: pre.tree !== post.tree };
  }
  currentTree(): Promise<string> {
    return Promise.resolve(this.world.value);
  }
  check(
    point: UndoPoint,
    side: 'pre' | 'post',
  ): Promise<{ ok: true; trees: Record<string, string> } | { ok: false; error: string }> {
    const tree = this.trees.get(point[side])!;
    return Promise.resolve(
      tree === this.world.value
        ? { ok: true, trees: { [ROOT]: tree } }
        : { ok: false, error: 'the workspace has changed since that command ran' },
    );
  }
  restore(
    _trees: Record<string, string>,
    point: UndoPoint,
    side: 'pre' | 'post',
  ): Promise<{ moved: string[]; error?: string }> {
    this.world.value = this.trees.get(point[side])!;
    return Promise.resolve({ moved: [ROOT] });
  }
  prune(): Promise<void> {
    this.pruneCalls++;
    return Promise.resolve();
  }
}

/** A stack whose one mutating command sets the workspace to a named state. */
function undoSetup() {
  const world = { value: 'w0' };
  const registry = new CommandRegistry<Host>();
  registry.registerAll([
    define({
      id: 'demo.edit',
      title: 'Edit',
      description: 'Set the workspace to a value.',
      mutating: true,
      undoable: true,
      props: { to: prop.string('the new value') },
      run(props) {
        world.value = props.to;
        return Promise.resolve({ message: `set ${props.to}` });
      },
    }),
    // Mutating but not opted in — undo must name it rather than reach past it.
    define({
      id: 'demo.generate',
      title: 'Generate',
      description: 'Writes generated output only.',
      mutating: true,
      props: {},
      run: () => Promise.resolve({ message: 'generated' }),
    }),
    // Opted in and half-runs: the workspace may have moved, but there is no post-state.
    define({
      id: 'demo.editFails',
      title: 'Edit (fails)',
      description: 'Mutates, then throws.',
      mutating: true,
      undoable: true,
      props: {},
      run() {
        world.value = 'half-written';
        return Promise.reject(new Error('boom'));
      },
    }),
    define({
      id: 'demo.look',
      title: 'Look',
      description: 'Reads and writes nothing.',
      mutating: false,
      props: {},
      run: () => Promise.resolve({ message: 'looked' }),
    }),
    greet,
    explode,
  ]);
  const journal = new FakeJournal(world);
  const stack = new CommandStack<Host>({
    registry,
    context: { root: '/ws', git: fakeGit(), host: { seen: [] }, log: () => {} },
    journal: journal as unknown as UndoJournal,
    now: () => '2026-07-25T00:00:00.000Z',
  });
  return { stack, world, journal };
}

describe('undo/redo', () => {
  it('brackets an undoable command with snapshots, and leaves others unbracketed', async () => {
    const { stack, journal } = undoSetup();
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    await stack.exec('demo.generate', {}, 'ui');
    const [edit, generate] = stack.history();
    expect(edit!.undo).toEqual({ pre: 'c1', post: 'c2', changed: true });
    expect(generate!.undo).toBeUndefined();
    // Only the opted-in command is snapshotted, and only it pays for the housekeeping.
    expect(journal.captured).toEqual(['1/pre', '1/post']);
    expect(journal.pruneCalls).toBe(1);
  });

  it('does not snapshot a command that claims undoable without being mutating', async () => {
    const world = { value: 'w0' };
    const registry = new CommandRegistry<Host>();
    registry.register(
      define({
        id: 'demo.claims',
        title: 'Claims',
        description: 'Says undoable but writes nothing.',
        mutating: false,
        undoable: true,
        props: {},
        run: () => Promise.resolve({ message: 'read' }),
      }),
    );
    const journal = new FakeJournal(world);
    const stack = new CommandStack<Host>({
      registry,
      context: { root: '/ws', git: fakeGit(), host: { seen: [] }, log: () => {} },
      journal: journal as unknown as UndoJournal,
    });

    // `undoable` is only meaningful with `mutating`, and the stack enforces that rather than
    // trusting the pairing — an unbracketed record is honest, a bracketed no-op is not.
    await stack.exec('demo.claims', {}, 'ui');
    expect(journal.captured).toEqual([]);
    expect(stack.history()[0]!.undo).toBeUndefined();
    expect(stack.canUndo()).toBe(false);
  });

  it('does not make a failed command an undo point, even a half-written one', async () => {
    const { stack, world } = undoSetup();
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    expect(await stack.exec('demo.editFails', {}, 'ui')).toMatchObject({ ok: false });
    expect(world.value).toBe('half-written');

    // No post-state was captured, so there is nothing to restore *to*. Undo reaches back to
    // the last command that completed — and the drift check is what catches the debris.
    const failed = stack.history()[1]!;
    expect(failed).toMatchObject({ status: 'error' });
    expect(failed.undo).toBeUndefined();
    expect(stack.undoCandidate()).toMatchObject({ id: 'demo.edit' });
    expect(await stack.undo()).toMatchObject({ ok: false });
    expect(world.value).toBe('half-written');
  });

  it('walks past a bracketed command that changed nothing', async () => {
    const { stack, world } = undoSetup();
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    // The same value again: the command reports success, and the two trees are identical.
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    expect(stack.history()[1]!.undo).toMatchObject({ changed: false });

    // Undo names the edit that is actually visible, not the one that wrote nothing.
    expect(stack.undoState().undoLabel).toBe("demo.edit(to='w1')");
    expect(stack.undoCandidate()!.seq).toBe(1);
    await stack.undo();
    expect(world.value).toBe('w0');
  });

  it('restores the pre-state and records the undo as history, not as an undo point', async () => {
    const { stack, world } = undoSetup();
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    expect(world.value).toBe('w1');

    expect(await stack.undo()).toMatchObject({ ok: true });
    expect(world.value).toBe('w0');
    expect(stack.history()[1]).toMatchObject({
      id: 'stack.undo',
      stack: 'undo',
      mutating: true,
      message: "Undid demo.edit(to='w1').",
    });
    // The undo entry itself must not become the next candidate.
    expect(stack.undoCandidate()).toBeNull();
    expect(stack.canUndo()).toBe(false);
  });

  it('redoes by restoring the post-state', async () => {
    const { stack, world } = undoSetup();
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    await stack.undo();
    expect(stack.canRedo()).toBe(true);

    expect(await stack.redo()).toMatchObject({ ok: true });
    expect(world.value).toBe('w1');
    expect(stack.history()[2]).toMatchObject({ id: 'stack.redo', stack: 'redo' });
    expect(stack.canRedo()).toBe(false);
    expect(stack.canUndo()).toBe(true);
  });

  it('walks back through several edits, newest first', async () => {
    const { stack, world } = undoSetup();
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    await stack.exec('demo.edit', { to: 'w2' }, 'ui');
    await stack.undo();
    expect(world.value).toBe('w1');
    await stack.undo();
    expect(world.value).toBe('w0');
    await stack.redo();
    expect(world.value).toBe('w1');
  });

  it('skips non-mutating and failed records when choosing a candidate', async () => {
    const { stack } = undoSetup();
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    await stack.exec('demo.explode', {}, 'ui');
    expect(stack.undoCandidate()).toMatchObject({ id: 'demo.edit' });
    expect(stack.undoState().undoLabel).toBe("demo.edit(to='w1')");
  });

  it('names a candidate that is not undoable rather than reaching past it', async () => {
    const { stack, world } = undoSetup();
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    await stack.exec('demo.generate', {}, 'ui');

    const outcome = await stack.undo();
    expect(outcome).toMatchObject({
      ok: false,
      error: '"demo.generate" was not recorded as undoable',
    });
    expect(world.value).toBe('w1');
    expect(stack.canUndo()).toBe(false);
  });

  it('refuses when the workspace moved since the command ran', async () => {
    const { stack, world } = undoSetup();
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    world.value = 'hand-edited'; // an author, an editor, another process

    const outcome = await stack.undo();
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toMatch(/workspace has changed/);
    expect(world.value).toBe('hand-edited');
  });

  it('refuses a redo when the workspace moved, and keeps it available', async () => {
    const { stack, world } = undoSetup();
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    await stack.undo();
    world.value = 'hand-edited';

    const outcome = await stack.redo();
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toMatch(/cannot redo.*workspace has changed/);
    expect(world.value).toBe('hand-edited');
    // A refusal is not a consumption: the redo stays on the stack for once the drift is dealt
    // with, and no `stack.redo` record is written, because nothing was redone.
    expect(stack.canRedo()).toBe(true);
    expect(stack.history()).toHaveLength(2);
  });

  it('surfaces a failed restore without marking anything undone', async () => {
    const { stack, world, journal } = undoSetup();
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    journal.restore = () => Promise.reject(new Error('index.lock exists'));

    const outcome = await stack.undo();
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toMatch(/undo failed: index.lock exists/);
    expect(world.value).toBe('w1');
    // The candidate is untouched, so the author can retry once the lock clears.
    expect(stack.undoCandidate()).toMatchObject({ id: 'demo.edit' });
    expect(stack.canRedo()).toBe(false);
  });

  it('keeps the redo stack across a non-mutating command', async () => {
    const { stack, world } = undoSetup();
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    await stack.undo();
    await stack.exec('demo.look', {}, 'ui');

    // Only a new *act* invalidates the branch a redo belongs to. Looking around is not one.
    expect(stack.undoState()).toMatchObject({ canRedo: true, redoLabel: "demo.edit(to='w1')" });
    expect(await stack.redo()).toMatchObject({ ok: true });
    expect(world.value).toBe('w1');
  });

  it('drops the redo stack when a new act lands on top', async () => {
    const { stack, world } = undoSetup();
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    await stack.undo();
    await stack.exec('demo.edit', { to: 'w2' }, 'ui');

    expect(stack.canRedo()).toBe(false);
    expect(await stack.redo()).toMatchObject({ ok: false, error: 'nothing to redo' });
    expect(world.value).toBe('w2');
  });

  it('reports nothing to undo on a fresh stack', async () => {
    const { stack } = undoSetup();
    expect(stack.undoState()).toEqual({
      canUndo: false,
      canRedo: false,
      undoLabel: null,
      redoLabel: null,
    });
    expect(await stack.undo()).toMatchObject({ ok: false, error: 'nothing to undo' });
  });

  it('refuses both when no journal is wired', async () => {
    const { stack } = setup();
    await stack.exec('demo.greet', { who: 'a' }, 'ui');
    expect(stack.canUndo()).toBe(false);
    expect(stack.canRedo()).toBe(false);
    for (const outcome of [await stack.undo(), await stack.redo()]) {
      expect(outcome).toMatchObject({ ok: false });
      expect(outcome.ok === false && outcome.error).toMatch(/no snapshot journal is wired/);
    }
  });

  it('records the command anyway when a snapshot fails', async () => {
    const world = { value: 'w0' };
    const registry = new CommandRegistry<Host>();
    registry.register(
      define({
        id: 'demo.edit',
        title: 'Edit',
        description: 'Set the workspace.',
        mutating: true,
        undoable: true,
        props: {},
        run: () => Promise.resolve({ message: 'edited' }),
      }),
    );
    const logs: string[] = [];
    const broken = new FakeJournal(world);
    broken.capture = () => Promise.reject(new Error('no repo'));
    const stack = new CommandStack<Host>({
      registry,
      context: {
        root: '/ws',
        git: fakeGit(),
        host: { seen: [] },
        log: (l, m) => logs.push(`${l}: ${m}`),
      },
      journal: broken as unknown as UndoJournal,
    });

    // Provenance must never be able to fail the act it describes.
    expect(await stack.exec('demo.edit', {}, 'ui')).toMatchObject({ ok: true });
    expect(stack.history()[0]!.undo).toBeUndefined();
    expect(logs.join()).toMatch(/undo snapshot.*no repo/);
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
      'demo.brokenCheck',
      'demo.checked',
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
    expect(entry).toMatchObject({
      mutating: true,
      confirm: false,
      undoable: false,
      checkable: false,
    });
    // The flag says a precondition exists to ask, not that asking would accept.
    expect(catalog.commands.find((c) => c.id === 'demo.checked')!.checkable).toBe(true);
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

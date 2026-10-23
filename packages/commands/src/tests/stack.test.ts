import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@vn/util';
import { toCatalog } from '../catalog.js';
import { EMPTY_DIGEST, digestOf } from '../digest.js';
import {
  defineCommand,
  defineFor,
  type CommandContext,
  type CommandRecord,
  type UndoPoint,
} from '../command.js';
import { prop } from '../props.js';
import { CommandRegistry } from '../registry.js';
import { CHECKPOINT_TIMEOUT_MS, CommandStack } from '../stack.js';
import { UndoJournal } from '../undo.js';
import type { Git } from '@vn/git';

/** Just the slice of Git the stack touches, so tests need no repo on disk. */
function fakeGit(over: Partial<Record<'isRepo' | 'head' | 'isDirty', unknown>> = {}): Git {
  const git = {
    isRepo : () => Promise.resolve(true),
    head   : () => Promise.resolve('a7c9ff4'),
    isDirty: () => Promise.resolve(false),
    ...over,
  } as unknown as Git;
  git.provenance = async () => {
    if (!(await git.isRepo())) return { head: null, dirty: false };
    return { head: await git.head(), dirty: await git.isDirty() };
  };
  return git;
}

interface Host {
  seen: string[];
}

const define = defineFor<Host>();

const greet = define({
  id         : 'demo.greet',
  title      : 'Greet',
  description: 'Say hello.',
  mutating   : true,
  props      : { who: prop.string('who to greet') },
  run(props, ctx) {
    ctx.host.seen.push(props.who);
    return Promise.resolve({
      message: `hello ${props.who}`,
      data   : { who: props.who },
      written: ['a.md'],
    });
  },
});

/** A whole document as a prop: the command wants the text, the history must not keep it. */
const save = define({
  id         : 'demo.save',
  title      : 'Save',
  description: 'Writes a document.',
  mutating   : true,
  props: { path: prop.string('where'), text: prop.string('the whole file', { digest: true }) },
  run(props, ctx) {
    ctx.host.seen.push(props.text);
    return Promise.resolve({ message: `wrote ${props.path}` });
  },
});

/** A credential as a prop: the command wants the key, nothing written down may contain it. */
const setKey = define({
  id         : 'demo.setKey',
  title      : 'Set key',
  description: 'Stores an API key.',
  mutating   : true,
  props      : { provider: prop.string('vendor'), key: prop.secret('the API key') },
  run(props, ctx) {
    ctx.host.seen.push(props.key);
    return Promise.resolve({ message: `stored ${props.provider}` });
  },
});

const explode = define({
  id         : 'demo.explode',
  title      : 'Explode',
  description: 'Always throws.',
  mutating   : false,
  props      : {},
  run() {
    return Promise.reject(new Error('boom'));
  },
});

const guarded = define({
  id         : 'demo.guarded',
  title      : 'Guarded',
  description: 'Needs confirmation.',
  mutating   : true,
  confirm    : true,
  props      : {},
  run(_p, ctx) {
    ctx.host.seen.push('guarded');
    return Promise.resolve({ message: 'ran' });
  },
});

/** This command declares a precondition but does not gate on it: `check` refuses while `run` proceeds anyway. */
const checked = define({
  id         : 'demo.checked',
  title      : 'Checked',
  description: 'Declares a precondition.',
  mutating   : true,
  props      : { who: prop.string('who to greet'), count: prop.number('n', { default: 1 }) },
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
  id         : 'demo.brokenCheck',
  title      : 'Broken check',
  description: 'Its precondition throws.',
  mutating   : true,
  props      : {},
  check() {
    return Promise.reject(new Error('the model is not loaded'));
  },
  run: () => Promise.resolve({ message: 'ran' }),
});

function setup(over: Partial<CommandContext<Host>> = {}) {
  const registry = new CommandRegistry<Host>();
  registry.registerAll([greet, save, setKey, explode, guarded, checked, brokenCheck]);
  const host: Host = { seen: [] };
  const persisted: CommandRecord[] = [];
  const logs: string[] = [];
  const context: CommandContext<Host> = {
    root: '/ws',
    git : fakeGit(),
    host,
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...over,
  };
  const stack = new CommandStack<Host>({
    registry,
    context,
    onRecord: (r) => void persisted.push(r),
    now     : () => '2026-07-25T00:00:00.000Z',
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
      seq       : 1,
      id        : 'demo.greet',
      invocation: "demo.greet(who='aiko')",
      source    : 'ui',
      mutating  : true,
      gitHead   : 'a7c9ff4',
      gitDirty  : false,
      status    : 'ok',
      message   : 'hello aiko',
      written   : ['a.md'],
    });
  });

  it('carries a rewrite table from the output onto the record, and omits it otherwise', async () => {
    const { stack, persisted, registry } = setup();
    registry.register(
      define({
        id         : 'demo.pull',
        title      : 'Pull',
        description: 'Rebases unsent saves.',
        mutating   : true,
        props      : {},
        run: () =>
          Promise.resolve({
            message: 'rebased',
            rewrote: [
              { from: 'a'.repeat(40), to: 'b'.repeat(40) },
              { from: 'c'.repeat(40), to: null },
            ],
          }),
      }),
    );
    await stack.exec('demo.pull', {}, 'ui');
    await stack.exec('demo.greet', { who: 'aiko' }, 'ui');
    expect(persisted[0]?.rewrote).toEqual([
      { from: 'a'.repeat(40), to: 'b'.repeat(40) },
      { from: 'c'.repeat(40), to: null },
    ]);
    expect('rewrote' in persisted[1]!).toBe(false);
  });

  /**
   * The bytes are in the file and in the undo snapshot, and `commands.jsonl` keeps a fingerprint.
   * The second assertion matters most: it checks that the command itself is not digested.
   */
  it('records a digest of a bulk prop, and still hands the command the real text', async () => {
    const { stack, host, persisted } = setup();
    const text = '# Ada\n\n' + 'lore '.repeat(1000);
    const outcome = await stack.exec('demo.save', { path: 'wiki/ada.md', text }, 'ui');

    expect(outcome.ok).toBe(true);
    expect(host.seen).toEqual([text]);
    // Pinned against `@vn/util`'s node-crypto sha256, which this deliberately does not import.
    const digest = `<sha256:${sha256(text).slice(0, 12)}+5007>`;
    expect(persisted[0]?.props).toEqual({ path: 'wiki/ada.md', text: digest });
    expect(persisted[0]?.invocation).toBe(`demo.save(path='wiki/ada.md' text='${digest}')`);
  });

  /**
   * A digest carries the byte length, so an empty bulk value is recognisable in a record where a
   * secret is not. `EMPTY_DIGEST` is that value written down, and has to stay what `digestOf`
   * would produce — the tour layer reads it to tell a blank field from a typed one.
   */
  it('records a bulk prop with nothing in it as the empty digest', async () => {
    expect(await digestOf('')).toBe(EMPTY_DIGEST);
    expect(await digestOf([])).toBe(EMPTY_DIGEST);
    expect(await digestOf('a')).not.toBe(EMPTY_DIGEST);
  });

  /**
   * The digest treatment would be worse than nothing here: a hash of a live credential plus its
   * exact length is a fingerprint of the credential. Both places a prop is written must be clean.
   */
  it('records a secret prop as <secret> in props and in the invocation', async () => {
    const { stack, host, persisted } = setup();
    const key = 'sk-ant-notarealkey-000';
    const outcome = await stack.exec('demo.setKey', { provider: 'anthropic', key }, 'ui');

    expect(outcome.ok).toBe(true);
    expect(host.seen).toEqual([key]);
    expect(persisted[0]?.props).toEqual({ provider: 'anthropic', key: '<secret>' });
    expect(persisted[0]?.invocation).toBe("demo.setKey(provider='anthropic' key='<secret>')");
    expect(JSON.stringify(persisted[0])).not.toContain(key);
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
      ok   : false,
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

  it('reads fresh provenance once per command without separate Git probes', async () => {
    const git = fakeGit();
    git.provenance = jest
      .fn()
      .mockResolvedValueOnce({ head: 'old-head', dirty: false })
      .mockResolvedValueOnce({ head: 'new-head', dirty: true });
    const probe = jest.spyOn(git, 'isRepo');
    const { stack } = setup({ git });
    await stack.exec('demo.greet', { who: 'a' }, 'ui');
    await stack.exec('demo.greet', { who: 'b' }, 'ui');
    expect(git.provenance).toHaveBeenCalledTimes(2);
    expect(probe).not.toHaveBeenCalled();
    expect(stack.history().map((r) => [r.gitHead, r.gitDirty])).toEqual([
      ['old-head', false],
      ['new-head', true],
    ]);
  });

  it('warns but still records when persistence fails', async () => {
    const registry = new CommandRegistry<Host>();
    registry.registerAll([greet]);
    const logs: string[] = [];
    const stack = new CommandStack<Host>({
      registry,
      context: {
        root: '/ws',
        git : fakeGit(),
        host: { seen: [] },
        log : (l, m) => logs.push(`${l}: ${m}`),
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
    expect(await no.stack.exec('demo.guarded', {}, 'ui')).toMatchObject({
      ok   : false,
      error: '"demo.guarded" was declined',
    });
    expect(no.host.seen).toEqual([]);
    expect(no.stack.history()).toEqual([]);
  });

  it('asks with the fixed sentence, naming the command and the window that ran it', async () => {
    const asked: unknown[] = [];
    const { stack } = setup({
      confirm: (message, about) => {
        asked.push({ message, about });
        return Promise.resolve(true);
      },
    });
    await stack.exec('demo.guarded', {}, 'ui', { origin: 4 });
    expect(asked).toEqual([{ message: 'Run Guarded?', about: { title: 'Guarded', origin: 4 } }]);
  });

  it('does not ask when the caller already confirmed', async () => {
    const asked: string[] = [];
    const { stack, host } = setup({
      confirm: (message) => {
        asked.push(message);
        return Promise.resolve(false);
      },
    });
    expect(await stack.exec('demo.guarded', {}, 'ui', { confirmed: true })).toMatchObject({
      ok: true,
    });
    expect(asked).toEqual([]);
    expect(host.seen).toEqual(['guarded']);
  });

  /** Asks only when `who` is `everyone`, the way a delete asks only in an uncommitted project. */
  const sometimes = define({
    id         : 'demo.sometimes',
    title      : 'Sometimes',
    description: 'Asks in one state only.',
    mutating   : true,
    props      : { who: prop.string('who to greet') },
    confirmWhen(props, ctx) {
      ctx.host.seen.push(`asked about ${props.who}`);
      return Promise.resolve(props.who === 'everyone' ? 'Greet everyone at once?' : undefined);
    },
    run(props, ctx) {
      ctx.host.seen.push(props.who);
      return Promise.resolve({ message: 'ran' });
    },
  });

  function sometimesSetup(answer: boolean) {
    const asked: string[] = [];
    const made = setup({
      confirm: (message) => {
        asked.push(message);
        return Promise.resolve(answer);
      },
    });
    made.registry.register(sometimes);
    return { ...made, asked };
  }

  it('asks the confirmWhen sentence only when it returns one', async () => {
    const { stack, host, asked } = sometimesSetup(true);
    await stack.exec('demo.sometimes', { who: 'aiko' }, 'ui');
    await stack.exec('demo.sometimes', { who: 'everyone' }, 'ui');
    expect(asked).toEqual(['Greet everyone at once?']);
    expect(host.seen).toEqual(['asked about aiko', 'aiko', 'asked about everyone', 'everyone']);
  });

  it('refuses a declined confirmWhen and records nothing', async () => {
    const { stack, host, asked } = sometimesSetup(false);
    expect(await stack.exec('demo.sometimes', { who: 'everyone' }, 'ui')).toMatchObject({
      ok   : false,
      error: '"demo.sometimes" was declined',
    });
    expect(asked).toHaveLength(1);
    expect(host.seen).toEqual(['asked about everyone']);
    expect(stack.history()).toEqual([]);
  });

  it('does not evaluate confirmWhen when the caller already confirmed', async () => {
    const { stack, host, asked } = sometimesSetup(false);
    await stack.exec('demo.sometimes', { who: 'everyone' }, 'ui', { confirmed: true });
    expect(asked).toEqual([]);
    expect(host.seen).toEqual(['everyone']);
  });

  it('refuses when confirmWhen throws, without running', async () => {
    const { stack, host, registry } = setup({ confirm: () => Promise.resolve(true) });
    registry.register(
      define({
        id         : 'demo.unsure',
        title      : 'Unsure',
        description: 'Cannot tell whether to ask.',
        mutating   : true,
        props      : {},
        confirmWhen: () => Promise.reject(new Error('no repo list')),
        run(_p, c) {
          c.host.seen.push('unsure');
          return Promise.resolve({ message: 'ran' });
        },
      }),
    );
    expect(await stack.exec('demo.unsure', {}, 'ui')).toMatchObject({
      ok   : false,
      error: 'could not decide whether "demo.unsure" needs confirmation: no repo list',
    });
    expect(host.seen).toEqual([]);
  });

  it('asks confirmWhen after the mutating command queued ahead of it has run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { stack, host, registry } = sometimesSetup(true);
    registry.register(
      define({
        id         : 'demo.hold',
        title      : 'Hold',
        description: 'Holds the chain until released.',
        mutating   : true,
        props      : {},
        async run(_p, c) {
          await gate;
          c.host.seen.push('held');
          return { message: 'held' };
        },
      }),
    );
    const first = stack.exec('demo.hold', {}, 'ui');
    const second = stack.exec('demo.sometimes', { who: 'everyone' }, 'ui');
    await Promise.resolve();
    expect(host.seen).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(host.seen).toEqual(['held', 'asked about everyone', 'everyone']);
  });

  it('gives a question asked from inside run the command and its window', async () => {
    const asked: unknown[] = [];
    const { stack, registry } = setup({
      confirm: (message, about) => {
        asked.push({ message, about });
        return Promise.resolve(true);
      },
    });
    registry.register(
      define({
        id         : 'demo.inner',
        title      : 'Inner',
        description: 'Asks from inside run.',
        mutating   : true,
        props      : {},
        async run(_p, c) {
          await c.confirm?.('Install it?');
          return { message: 'ran' };
        },
      }),
    );
    await stack.exec('demo.inner', {}, 'ui', { origin: 2, confirmed: true });
    expect(asked).toEqual([{ message: 'Install it?', about: { title: 'Inner', origin: 2 } }]);
  });

  it('reports the confirmWhen sentence from check without asking', async () => {
    const { stack, asked } = sometimesSetup(true);
    expect(await stack.check('demo.sometimes', { who: 'everyone' })).toEqual({
      state  : 'undeclared',
      message: '"demo.sometimes" declares no precondition',
      confirm: 'Greet everyone at once?',
    });
    expect(await stack.check('demo.sometimes', { who: 'aiko' })).toEqual({
      state  : 'undeclared',
      message: '"demo.sometimes" declares no precondition',
    });
    expect(asked).toEqual([]);
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
      state  : 'accept',
      // The default landed, so the check saw exactly what `run` would.
      message: 'would greet aiko 1 time(s)',
    });
  });

  it('reports a refusal with the rule’s own sentence', async () => {
    const { stack } = setup();
    expect(await stack.check('demo.checked', { who: 'nobody' })).toEqual({
      state  : 'refuse',
      message: 'there is no one to greet',
    });
  });

  /**
   * This is the reason the three-state design exists. A command with no precondition carries
   * no information about whether it would run, so answering `accept` would invent an opinion.
   */
  it('reports a command with no check as undeclared, never as an accept', async () => {
    const { stack } = setup();
    expect(await stack.check('demo.greet', { who: 'aiko' })).toEqual({
      state  : 'undeclared',
      message: '"demo.greet" declares no precondition',
    });
  });

  it('refuses unknown props and unknown commands', async () => {
    const { stack } = setup();
    expect(await stack.check('demo.checked', { nope: 1 })).toMatchObject({ state: 'refuse' });
    expect(await stack.check('demo.nope', {})).toEqual({
      state  : 'refuse',
      message: 'unknown command "demo.nope"',
    });
  });

  it('says a check failed to answer rather than passing the crash off as a refusal', async () => {
    const { stack } = setup();
    expect(await stack.check('demo.brokenCheck', {})).toEqual({
      state  : 'refuse',
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
 * The workspace as one value, so the stack's bookkeeping can be tested without touching disk. The
 * journal's own filesystem behaviour is exercised against real directories in `undo.test.ts`.
 */
class FakeJournal {
  private n = 0;
  /** Snapshot id → the workspace value it was taken over, standing in for a tree hash. */
  readonly trees = new Map<string, string>();
  readonly captured: string[] = [];
  pruneCalls = 0;
  constructor(private readonly world: { value: string }) {}

  capture(seq: number): Promise<string> {
    const id = `c${++this.n}`;
    this.trees.set(id, this.world.value);
    this.captured.push(`${seq}/${id}`);
    return Promise.resolve(id);
  }
  point(pre: string, post: string): UndoPoint {
    return { pre, post, changed: this.trees.get(pre) !== this.trees.get(post) };
  }
  currentTree(): Promise<string> {
    return Promise.resolve(this.world.value);
  }
  check(
    point: UndoPoint,
    side: 'pre' | 'post',
  ): Promise<{ ok: true; tree: string } | { ok: false; error: string }> {
    const tree = this.trees.get(point[side])!;
    return Promise.resolve(
      tree === this.world.value
        ? { ok: true, tree }
        : { ok: false, error: 'the workspace has changed since that command ran' },
    );
  }
  restore(
    _from: string,
    point: UndoPoint,
    side: 'pre' | 'post',
  ): Promise<{ error?: string; changed: string[] }> {
    this.world.value = this.trees.get(point[side])!;
    // The one file this fake's whole world is, so a restore here reports a move like the real one.
    return Promise.resolve({ changed: ['world.md'] });
  }
  /** Seqs the next prune reports as dropped, as the real journal does once it passes `keep`. */
  dropNext: number[] = [];
  prune(): number[] {
    this.pruneCalls++;
    return this.dropNext.splice(0);
  }

  // A checkpoint's scope is one directory inside a document tree this fake models as a single
  // string, so its scoped methods reuse the whole-tree ones — the scope argument names nothing
  // this fake needs to act on differently, unlike the real `UndoJournal`, which is exercised
  // against real directories in `undo.test.ts`.
  captureScoped(_scope: string, seq: number): Promise<string | null> {
    return this.capture(seq);
  }
  currentTreeScoped(_scope: string): Promise<string | null> {
    return this.currentTree();
  }
  checkScoped(
    _scope: string,
    point: UndoPoint,
    side: 'pre' | 'post',
  ): Promise<{ ok: true; tree: string } | { ok: false; error: string }> {
    return this.check(point, side);
  }
  restoreScoped(
    _scope: string,
    from: string,
    point: UndoPoint,
    side: 'pre' | 'post',
  ): Promise<{ error?: string; changed: string[] }> {
    return this.restore(from, point, side);
  }
}

/** A hand-driven stand-in for `setTimeout`, so a test fires the checkpoint timeout by hand. */
function fakeTimer() {
  const armed = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    set(fn: () => void, ms: number): number {
      const handle = next++;
      armed.set(handle, { fn, ms });
      return handle;
    },
    clear(handle: unknown): void {
      armed.delete(handle as number);
    },
    armedMs(): number | null {
      return [...armed.values()][0]?.ms ?? null;
    },
    fire(): void {
      const due = [...armed.values()];
      armed.clear();
      for (const { fn } of due) fn();
    },
  };
}

/** A stack whose one mutating command sets the workspace to a named state. */
function undoSetup() {
  const world = { value: 'w0' };
  const registry = new CommandRegistry<Host>();
  registry.registerAll([
    define({
      id         : 'demo.edit',
      title      : 'Edit',
      description: 'Set the workspace to a value.',
      mutating   : true,
      undoable   : true,
      props      : { to: prop.string('the new value') },
      run(props) {
        world.value = props.to;
        return Promise.resolve({ message: `set ${props.to}` });
      },
    }),
    // Mutating but not opted in — undo must name it rather than reach past it.
    define({
      id         : 'demo.generate',
      title      : 'Generate',
      description: 'Writes generated output only.',
      mutating   : true,
      props      : {},
      run        : () => Promise.resolve({ message: 'generated' }),
    }),
    // Opted in and half-runs: the workspace may have moved, but there is no post-state.
    define({
      id         : 'demo.editFails',
      title      : 'Edit (fails)',
      description: 'Mutates, then throws.',
      mutating   : true,
      undoable   : true,
      props      : {},
      run() {
        world.value = 'half-written';
        return Promise.reject(new Error('boom'));
      },
    }),
    define({
      id         : 'demo.look',
      title      : 'Look',
      description: 'Reads and writes nothing.',
      mutating   : false,
      props      : {},
      run        : () => Promise.resolve({ message: 'looked' }),
    }),
    greet,
    explode,
  ]);
  const journal = new FakeJournal(world);
  const stack = new CommandStack<Host>({
    registry,
    context: { root: '/ws', git: fakeGit(), host: { seen: [] }, log: () => {} },
    journal: journal as unknown as UndoJournal,
    now    : () => '2026-07-25T00:00:00.000Z',
  });
  return { stack, world, journal };
}

describe('undo/redo', () => {
  it('selects each queued undo/redo target after pending edits and moves finish', async () => {
    const { stack, world } = undoSetup();
    const first = await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    // Enqueue without awaiting: both undos must see different candidates, and the
    // redos must see the undo history created ahead of them in the same queue.
    const pending = stack.exec('demo.edit', { to: 'w2' }, 'ui');
    const undoSecond = stack.undo();
    const undoFirst = stack.undo();
    const redoFirst = stack.redo();
    const redoSecond = stack.redo();
    const [second, u2, u1, r1, r2] = await Promise.all([
      pending,
      undoSecond,
      undoFirst,
      redoFirst,
      redoSecond,
    ]);
    expect(second.ok).toBe(true);
    for (const [result, target] of [
      [u2, second.record!.seq],
      [u1, first.record!.seq],
      [r1, first.record!.seq],
      [r2, second.record!.seq],
    ] as const) {
      expect(result).toMatchObject({ ok: true, record: { props: { target } } });
    }
    expect(world.value).toBe('w2');
  });

  it('brackets an undoable command with snapshots, and leaves others unbracketed', async () => {
    const { stack, journal } = undoSetup();
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    await stack.exec('demo.generate', {}, 'ui');
    const [edit, generate] = stack.history();
    expect(edit!.undo).toEqual({ pre: 'c1', post: 'c2', changed: true });
    expect(generate!.undo).toBeUndefined();
    // Only the opted-in command is snapshotted, and only it pays for the housekeeping.
    expect(journal.captured).toEqual(['1/c1', '1/c2']);
    expect(journal.pruneCalls).toBe(1);
  });

  it('does not snapshot a command that claims undoable without being mutating', async () => {
    const world = { value: 'w0' };
    const registry = new CommandRegistry<Host>();
    registry.register(
      define({
        id         : 'demo.claims',
        title      : 'Claims',
        description: 'Says undoable but writes nothing.',
        mutating   : false,
        undoable   : true,
        props      : {},
        run        : () => Promise.resolve({ message: 'read' }),
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

    // No post-state was captured, so there is nothing to restore to. Undo reaches back to
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

    // Undo names the edit that changed the tree; the no-op edit before it is skipped.
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
      id      : 'stack.undo',
      stack   : 'undo',
      mutating: true,
      message : "Undid demo.edit(to='w1').",
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
      ok   : false,
      error: '"demo.generate" was not recorded as undoable',
    });
    expect(world.value).toBe('w1');
    expect(stack.canUndo()).toBe(false);
    expect(stack.undoState()).toMatchObject({ undoLabel: null, blocked: 'demo.generate()' });
  });

  it('refuses when the workspace moved since the command ran', async () => {
    const { stack, world } = undoSetup();
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    world.value = 'hand-edited'; // a change from outside the stack: another editor or process

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

    // Only a new act invalidates the branch a redo belongs to. Looking around is not one.
    expect(stack.undoState()).toMatchObject({ canRedo: true, redoLabel: "demo.edit(to='w1')" });
    expect(await stack.redo()).toMatchObject({ ok: true });
    expect(world.value).toBe('w1');
  });

  it('names the act to undo or redo by its command title', async () => {
    const { stack } = undoSetup();
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    expect(stack.undoState()).toMatchObject({ undoTitle: 'Edit', redoTitle: null });
    await stack.undo();
    expect(stack.undoState()).toMatchObject({ undoTitle: null, redoTitle: 'Edit' });
  });

  it('drops the redo stack when a new act lands on top', async () => {
    const { stack, world } = undoSetup();
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    await stack.undo();
    // Redo must observe the branch invalidated by the edit ahead of it in the queue.
    const branch = stack.exec('demo.edit', { to: 'w2' }, 'ui');
    const staleRedo = stack.redo();
    expect((await branch).ok).toBe(true);

    expect(stack.canRedo()).toBe(false);
    expect(await staleRedo).toMatchObject({ ok: false, error: 'nothing to redo' });
    expect(world.value).toBe('w2');
  });

  it('reports nothing to undo on a fresh stack', async () => {
    const { stack } = undoSetup();
    expect(stack.undoState()).toEqual({
      canUndo  : false,
      canRedo  : false,
      undoLabel: null,
      redoLabel: null,
      undoTitle: null,
      redoTitle: null,
      blocked  : null,
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
        id         : 'demo.edit',
        title      : 'Edit',
        description: 'Set the workspace.',
        mutating   : true,
        undoable   : true,
        props      : {},
        run        : () => Promise.resolve({ message: 'edited' }),
      }),
    );
    const logs: string[] = [];
    const broken = new FakeJournal(world);
    broken.capture = () => Promise.reject(new Error('no repo'));
    const stack = new CommandStack<Host>({
      registry,
      context: {
        root: '/ws',
        git : fakeGit(),
        host: { seen: [] },
        log : (l, m) => logs.push(`${l}: ${m}`),
      },
      journal: broken as unknown as UndoJournal,
    });

    // Provenance must never be able to fail the act it describes.
    expect(await stack.exec('demo.edit', {}, 'ui')).toMatchObject({ ok: true });
    expect(stack.history()[0]!.undo).toBeUndefined();
    expect(logs.join()).toMatch(/undo snapshot.*no repo/);
  });
});

/**
 * A stack whose `demo.collect` keeps something outside the snapshot, as `asset.collect` does. Each
 * phase logs the direction and the workspace value it saw, so the order against the restore shows.
 */
function sidecarSetup() {
  const world = { value: 'w0' };
  const log: string[] = [];
  const released: string[] = [];
  const failing = { phase: '' };
  const registry = new CommandRegistry<Host>();
  const phase =
    (name: string) =>
    (record: CommandRecord, direction: string): Promise<string[]> => {
      log.push(`${name}:${direction}:${world.value}`);
      if (failing.phase === name) {
        failing.phase = '';
        return Promise.reject(new Error(`${name} stopped`));
      }
      return Promise.resolve([`held/${record.sidecar}/${name}`]);
    };
  registry.registerAll([
    define({
      id         : 'demo.edit',
      title      : 'Edit',
      description: 'Set the workspace to a value.',
      mutating   : true,
      undoable   : true,
      props      : { to: prop.string('the new value') },
      run(props) {
        world.value = props.to;
        return Promise.resolve({ message: `set ${props.to}` });
      },
    }),
    define({
      id         : 'demo.collect',
      title      : 'Collect',
      description: 'Moves files aside, and with a value also sets the workspace.',
      mutating   : true,
      undoable   : true,
      props: {
        to  : prop.string('the new value, or empty to leave the snapshot alone', { default: '' }),
        keep: prop.boolean('keep for undo', { default: true }),
      },
      run(props) {
        if (props.to) world.value = props.to;
        return Promise.resolve(
          props.keep
            ? { message: 'collected', written: ['a.png'], sidecar: 'h1' }
            : { message: 'collected', written: ['a.png'], noUndo: true as const },
        );
      },
      sidecar: {
        beforeRestore: phase('before'),
        afterRestore : phase('after'),
        release(record) {
          released.push(record.sidecar!);
          return Promise.resolve();
        },
      },
    }),
    define({
      id         : 'demo.generate',
      title      : 'Generate',
      description: 'Writes generated output only.',
      mutating   : true,
      props      : {},
      run        : () => Promise.resolve({ message: 'generated' }),
    }),
  ]);
  const journal = new FakeJournal(world);
  const stack = new CommandStack<Host>({
    registry,
    context: { root: '/ws', git: fakeGit(), host: { seen: [] }, log: () => {} },
    journal: journal as unknown as UndoJournal,
    now    : () => '2026-10-19T00:00:00.000Z',
  });
  return { stack, world, journal, log, released, failing };
}

describe('undo with a sidecar', () => {
  it('runs beforeRestore and afterRestore on either side of the restore, both ways', async () => {
    const { stack, log } = sidecarSetup();
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    await stack.exec('demo.collect', { to: 'w2' }, 'ui');
    expect(stack.history()[1]).toMatchObject({ sidecar: 'h1', undo: { changed: true } });

    await stack.undo();
    await stack.redo();
    expect(log).toEqual(['before:undo:w2', 'after:undo:w1', 'before:redo:w1', 'after:redo:w2']);
  });

  it('stops undo at a sidecar record whose snapshot changed nothing', async () => {
    const { stack, world, log } = sidecarSetup();
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    await stack.exec('demo.collect', {}, 'ui');
    expect(stack.history()[1]!.undo).toMatchObject({ changed: false });

    expect(stack.undoCandidate()).toMatchObject({ id: 'demo.collect' });
    await stack.undo();
    expect(log).toEqual(['before:undo:w1', 'after:undo:w1']);
    expect(world.value).toBe('w1');
    expect(stack.undoCandidate()).toMatchObject({ id: 'demo.edit' });
  });

  it('reports what each phase moved in the undo record, naming the command it undid', async () => {
    const { stack } = sidecarSetup();
    await stack.exec('demo.collect', { to: 'w1' }, 'ui');
    const outcome = await stack.undo();
    expect(outcome.ok && outcome.record).toMatchObject({
      id     : 'stack.undo',
      target : 'demo.collect',
      written: ['world.md', 'held/h1/before', 'held/h1/after'],
    });
  });

  it('releases on a later act that cannot be undone, and not before', async () => {
    const { stack, released } = sidecarSetup();
    await stack.exec('demo.collect', { to: 'w1' }, 'ui');
    await stack.exec('demo.edit', { to: 'w2' }, 'ui');
    expect(released).toEqual([]);
    await stack.exec('demo.generate', {}, 'ui');
    expect(released).toEqual(['h1']);
  });

  it('releases an undone collection once a fresh act clears the redo stack', async () => {
    const { stack, released } = sidecarSetup();
    await stack.exec('demo.collect', { to: 'w1' }, 'ui');
    await stack.undo();
    expect(released).toEqual([]);
    await stack.exec('demo.edit', { to: 'w3' }, 'ui');
    expect(released).toEqual(['h1']);
  });

  it('releases when the journal drops the record, and on dispose, but not when quitting flushes commits', async () => {
    const pruned = sidecarSetup();
    await pruned.stack.exec('demo.collect', { to: 'w1' }, 'ui');
    pruned.journal.dropNext = [1];
    await pruned.stack.exec('demo.edit', { to: 'w2' }, 'ui');
    expect(pruned.released).toEqual(['h1']);

    const disposed = sidecarSetup();
    await disposed.stack.exec('demo.collect', { to: 'w1' }, 'ui');
    await disposed.stack.flushCommits();
    expect(disposed.released).toEqual([]);
    await disposed.stack.dispose();
    expect(disposed.released).toEqual(['h1']);
  });

  it('leaves no undo point when run asks for none, so undo names it', async () => {
    const { stack, released } = sidecarSetup();
    await stack.exec('demo.edit', { to: 'w1' }, 'ui');
    await stack.exec('demo.collect', { keep: false }, 'ui');
    expect(stack.history()[1]!.undo).toBeUndefined();
    expect(stack.undoState()).toMatchObject({
      undoLabel: null,
      blocked  : "demo.collect(to='' keep=false)",
    });
    expect(released).toEqual([]);
  });

  it('records a phase that stops part way, and finishes when run again', async () => {
    const { stack, world, log, failing } = sidecarSetup();
    await stack.exec('demo.collect', { to: 'w1' }, 'ui');
    failing.phase = 'after';

    const stopped = await stack.undo();
    expect(stopped).toMatchObject({ ok: false, error: 'undo failed: after stopped' });
    expect(!stopped.ok && stopped.record).toMatchObject({
      status : 'error',
      message: "Undo of demo.collect(to='w1' keep=true) stopped part way.",
      written: ['world.md', 'held/h1/before'],
    });
    expect(world.value).toBe('w0');

    // The tree is already at the far side, so the second attempt skips the restore
    expect(await stack.undo()).toMatchObject({ ok: true });
    expect(log).toEqual(['before:undo:w1', 'after:undo:w0', 'before:undo:w0', 'after:undo:w0']);
    expect(stack.canRedo()).toBe(true);
  });
});

/** A stack for exercising `beginCheckpoint`/`endCheckpoint`/`failCheckpoint`. */
function checkpointSetup() {
  const world = { value: 'w0' };
  const registry = new CommandRegistry<Host>();
  registry.registerAll([
    define({
      id         : 'demo.edit',
      title      : 'Edit',
      description: 'Set the workspace to a value.',
      mutating   : true,
      props      : { to: prop.string('the new value') },
      run(props) {
        world.value = props.to;
        return Promise.resolve({ message: `set ${props.to}`, written: ['graphs/scene.json'] });
      },
    }),
    define({
      id         : 'demo.editFails',
      title      : 'Edit (fails)',
      description: 'Mutates, then throws.',
      mutating   : true,
      props      : { to: prop.string('the new value') },
      run(props) {
        world.value = props.to;
        return Promise.reject(new Error('boom'));
      },
    }),
    define({
      id         : 'demo.outside',
      title      : 'Outside',
      description: 'Reports a write outside the checkpoint scope.',
      mutating   : true,
      props      : {},
      run: () => Promise.resolve({ message: 'wrote elsewhere', written: ['elsewhere/file.md'] }),
    }),
  ]);
  const journal = new FakeJournal(world);
  const timer = fakeTimer();
  const logs: string[] = [];
  const persisted: CommandRecord[] = [];
  const stack = new CommandStack<Host>({
    registry,
    context: {
      root: '/ws',
      git : fakeGit(),
      host: { seen: [] },
      log : (l, m) => logs.push(`${l}: ${m}`),
    },
    journal : journal as unknown as UndoJournal,
    onRecord: (r) => void persisted.push(r),
    timer,
    now: () => '2026-07-25T00:00:00.000Z',
  });
  return { stack, world, journal, timer, logs, persisted };
}

describe('checkpoints', () => {
  it('groups several commands into one undo point', async () => {
    const { stack, world, persisted } = checkpointSetup();
    const handle = await stack.beginCheckpoint('Delete nodes', 'Deleted 2 nodes', 'graphs');

    expect(await stack.exec('demo.edit', { to: 'w1' }, 'ui', { checkpoint: handle })).toMatchObject(
      {
        ok: true,
      },
    );
    expect(await stack.exec('demo.edit', { to: 'w2' }, 'ui', { checkpoint: handle })).toMatchObject(
      {
        ok: true,
      },
    );
    const closed = await stack.endCheckpoint(handle);
    expect(closed).toMatchObject({
      ok    : true,
      record: { id: 'stack.checkpoint', label: 'Delete nodes' },
    });

    // Both inner commands are tagged and carry no undo point of their own; the aggregate record
    // is the one candidate, and undoing it reverts both edits at once.
    const inner = persisted.filter((r) => r.id === 'demo.edit');
    expect(inner).toHaveLength(2);
    for (const r of inner) {
      expect(r.checkpoint).toBe(handle.seq);
      expect(r.undo).toBeUndefined();
    }
    expect(stack.undoCandidate()).toMatchObject({ id: 'stack.checkpoint' });
    expect(stack.undoState()).toMatchObject({
      undoLabel: 'Delete nodes',
      undoTitle: 'Delete nodes',
    });

    expect(await stack.undo()).toMatchObject({ ok: true });
    expect(world.value).toBe('w0');
  });

  it('rolls back to the checkpoint start when an inner command fails, and refuses what was still queued', async () => {
    const { stack, world, persisted } = checkpointSetup();
    const handle = await stack.beginCheckpoint('Batch', 'A batch', 'graphs');

    await stack.exec('demo.edit', { to: 'w1' }, 'ui', { checkpoint: handle });
    // Dispatched without awaiting, the way `GenGraphEditor`'s selection loop does — both land on
    // the checkpoint's own tail in arrival order.
    const failing = stack.exec('demo.editFails', { to: 'w2' }, 'ui', { checkpoint: handle });
    const queuedAfter = stack.exec('demo.edit', { to: 'w3' }, 'ui', { checkpoint: handle });

    expect(await failing).toMatchObject({ ok: false, error: 'boom' });
    expect(await queuedAfter).toMatchObject({
      ok   : false,
      error: `no open checkpoint ${handle.seq}`,
    });

    // The rollback restored to the checkpoint's own pre-state, before even the first inner edit.
    expect(world.value).toBe('w0');
    const rollback = persisted.find((r) => r.id === 'stack.checkpointRollback')!;
    expect(rollback).toMatchObject({ status: 'error', checkpoint: handle.seq, error: 'boom' });
    expect(rollback.message).toBe('Rolled back "Batch": boom');

    // A late endCheckpoint reports the same failure and appends no aggregate record.
    expect(await stack.endCheckpoint(handle)).toMatchObject({ ok: false, error: 'boom' });
    expect(persisted.some((r) => r.id === 'stack.checkpoint')).toBe(false);
  });

  it('fails and releases a checkpoint left open past its timeout', async () => {
    const { stack, world, timer, persisted } = checkpointSetup();
    const handle = await stack.beginCheckpoint('Batch', 'A batch', 'graphs');
    await stack.exec('demo.edit', { to: 'w1' }, 'ui', { checkpoint: handle });
    expect(timer.armedMs()).toBe(CHECKPOINT_TIMEOUT_MS);

    timer.fire();
    // The internal rollback work is not awaited by `fire()`; a real macrotask boundary drains
    // every microtask `failCheckpoint`'s own chain of `await`s queues, however many there are.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(world.value).toBe('w0');
    const rollback = persisted.find((r) => r.id === 'stack.checkpointRollback')!;
    expect(rollback.error).toMatch(/timed out/);

    // The chain-holding gate released, and a fresh checkpoint can open.
    const next = await stack.beginCheckpoint('Next', 'Next batch', 'graphs');
    expect(next.seq).not.toBe(handle.seq);
    // The stale handle refuses rather than reaching the new checkpoint.
    expect(await stack.endCheckpoint(handle)).toMatchObject({
      ok   : false,
      error: `no open checkpoint ${handle.seq}`,
    });
  });

  it('refuses a stale or absent checkpoint handle immediately', async () => {
    const { stack } = checkpointSetup();
    expect(await stack.exec('demo.edit', { to: 'w1' }, 'ui', { checkpoint: { seq: 999 } })).toEqual(
      {
        ok   : false,
        error: 'no open checkpoint 999',
      },
    );

    const handle = await stack.beginCheckpoint('Batch', 'A batch', 'graphs');
    expect(await stack.exec('demo.edit', { to: 'w1' }, 'ui', { checkpoint: { seq: 999 } })).toEqual(
      {
        ok   : false,
        error: 'no open checkpoint 999',
      },
    );
    await stack.endCheckpoint(handle);
  });

  it('throws when a checkpoint is already open, rather than queuing', async () => {
    const { stack } = checkpointSetup();
    await stack.beginCheckpoint('Batch', 'A batch', 'graphs');
    await expect(stack.beginCheckpoint('Second', 'Second batch', 'graphs')).rejects.toThrow(
      /already open/,
    );
  });

  it('refuses to open when the scope has nothing to checkpoint', async () => {
    const { stack, journal } = checkpointSetup();
    journal.captureScoped = () => Promise.resolve(null);
    await expect(stack.beginCheckpoint('Batch', 'A batch', 'graphs')).rejects.toThrow(
      /no graphs to checkpoint/,
    );
  });

  it('logs rather than refuses when an inner command writes outside the declared scope', async () => {
    const { stack, logs } = checkpointSetup();
    const handle = await stack.beginCheckpoint('Batch', 'A batch', 'graphs');
    expect(await stack.exec('demo.outside', {}, 'ui', { checkpoint: handle })).toMatchObject({
      ok: true,
    });
    expect(logs.join()).toMatch(/wrote outside its scope: elsewhere\/file\.md/);
    await stack.endCheckpoint(handle);
  });

  it('produces a no-op undo point for an empty checkpoint', async () => {
    const { stack, persisted } = checkpointSetup();
    const handle = await stack.beginCheckpoint('Nothing', 'Nothing happened', 'graphs');
    const closed = await stack.endCheckpoint(handle);
    expect(closed).toMatchObject({ ok: true, record: { undo: { changed: false } } });
    expect(stack.undoCandidate()).toBeNull();
    expect(persisted.find((r) => r.id === 'stack.checkpoint')).toBeDefined();
  });

  it('queues a no-handle mutating command behind an open checkpoint rather than interleaving it', async () => {
    const { stack, world } = checkpointSetup();
    const handle = await stack.beginCheckpoint('Batch', 'A batch', 'graphs');
    void stack.exec('demo.edit', { to: 'from-checkpoint' }, 'ui', { checkpoint: handle });

    // No handle: this must not run until the checkpoint closes.
    const outside = stack.exec('demo.edit', { to: 'from-outside' }, 'ui');
    await stack.endCheckpoint(handle);
    expect(await outside).toMatchObject({ ok: true });
    expect(world.value).toBe('from-outside');
  });
});

/**
 * `FakeJournal`'s scoped methods alias its whole-tree ones (see the class above), so the
 * `checkpoints` suite above cannot tell a `moveBody` that calls the wrong pair apart from one
 * that calls the right one — both "work" against the fake. This suite runs the same round trip
 * against a real `UndoJournal` and real files, where a scoped and a whole-tree hash are
 * genuinely different values, to prove `stack.undo()` actually reverts a checkpoint.
 */
describe('checkpoints, against a real UndoJournal', () => {
  async function realCheckpointSetup() {
    const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'vn-checkpoint-real-')));
    await fs.mkdir(join(dir, 'graphs'), { recursive: true });
    await fs.writeFile(join(dir, 'graphs', 'a.json'), '{"nodes":[]}\n');

    const registry = new CommandRegistry<Host>();
    registry.registerAll([
      define({
        id         : 'demo.writeGraph',
        title      : 'Write graph',
        description: 'Overwrite the scoped graph file.',
        mutating   : true,
        props      : { text: prop.string('file contents') },
        async run(props) {
          await fs.writeFile(join(dir, 'graphs', 'a.json'), props.text);
          return { message: `wrote ${props.text}`, written: ['graphs/a.json'] };
        },
      }),
      define({
        id         : 'demo.writeGraphFails',
        title      : 'Write graph (fails)',
        description: 'Overwrite the scoped graph file, then throw.',
        mutating   : true,
        props      : { text: prop.string('file contents') },
        async run(props) {
          await fs.writeFile(join(dir, 'graphs', 'a.json'), props.text);
          throw new Error('boom');
        },
      }),
    ]);
    const stack = new CommandStack<Host>({
      registry,
      context: { root: dir, git: fakeGit(), host: { seen: [] }, log: () => {} },
      journal: new UndoJournal({ root: dir }),
    });
    return { dir, stack, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
  }

  it('reverts the file undo() cannot reach without record.undoScope', async () => {
    const { dir, stack, cleanup } = await realCheckpointSetup();
    try {
      const handle = await stack.beginCheckpoint('Duplicate', 'Duplicated a node', 'graphs');
      const written = await stack.exec('demo.writeGraph', { text: '{"nodes":[1]}\n' }, 'ui', {
        checkpoint: handle,
      });
      expect(written).toMatchObject({ ok: true });

      const closed = await stack.endCheckpoint(handle);
      expect(closed).toMatchObject({
        ok    : true,
        record: { id: 'stack.checkpoint', undoScope: 'graphs', undo: { changed: true } },
      });
      expect(await fs.readFile(join(dir, 'graphs', 'a.json'), 'utf8')).toBe('{"nodes":[1]}\n');

      const undone = await stack.undo();
      expect(undone).toMatchObject({ ok: true });
      expect(await fs.readFile(join(dir, 'graphs', 'a.json'), 'utf8')).toBe('{"nodes":[]}\n');
    } finally {
      await cleanup();
    }
  });

  /**
   * `written` is read as root-relative everywhere else (a pane's `onWrote` matches it against
   * its own document path), but `restoreScoped` reports paths relative to the scope directory.
   * Without the scope folded back on, a checkpoint's undo/redo record named `a.json` instead of
   * `graphs/a.json`, so an open Gen Graph pane never recognized the write and never reloaded —
   * the redo (and undo) worked on disk but looked like nothing happened on screen.
   */
  it('reports undo/redo written paths root-relative, not scope-relative', async () => {
    const { stack, cleanup } = await realCheckpointSetup();
    try {
      const handle = await stack.beginCheckpoint('Duplicate', 'Duplicated a node', 'graphs');
      await stack.exec('demo.writeGraph', { text: '{"nodes":[1]}\n' }, 'ui', {
        checkpoint: handle,
      });
      await stack.endCheckpoint(handle);

      const undone = await stack.undo();
      expect(undone).toMatchObject({ ok: true, record: { written: ['graphs/a.json'] } });

      const redone = await stack.redo();
      expect(redone).toMatchObject({ ok: true, record: { written: ['graphs/a.json'] } });
    } finally {
      await cleanup();
    }
  });

  /** Same root cause as the undo/redo case above, but for `failCheckpoint`'s own rollback restore. */
  it('reports a checkpoint rollback written path root-relative too', async () => {
    const { dir, stack, cleanup } = await realCheckpointSetup();
    try {
      const handle = await stack.beginCheckpoint('Duplicate', 'Duplicated a node', 'graphs');
      await stack.exec('demo.writeGraph', { text: '{"nodes":[1]}\n' }, 'ui', {
        checkpoint: handle,
      });
      const failed = await stack.exec('demo.writeGraphFails', { text: '{"nodes":[1,2]}\n' }, 'ui', {
        checkpoint: handle,
      });
      expect(failed).toMatchObject({ ok: false, error: 'boom' });

      const outcome = await stack.endCheckpoint(handle);
      expect(outcome).toMatchObject({ ok: false, error: 'boom' });
      expect(await fs.readFile(join(dir, 'graphs', 'a.json'), 'utf8')).toBe('{"nodes":[]}\n');

      const rollback = stack.history().find((r) => r.id === 'stack.checkpointRollback');
      expect(rollback).toMatchObject({ status: 'error', written: ['graphs/a.json'] });
    } finally {
      await cleanup();
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
      'demo.brokenCheck',
      'demo.checked',
      'demo.explode',
      'demo.greet',
      'demo.guarded',
      'demo.save',
      'demo.setKey',
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
      mutating : true,
      confirm  : false,
      undoable : false,
      checkable: false,
    });
    // The flag says a precondition exists to ask, not that asking would accept.
    expect(catalog.commands.find((c) => c.id === 'demo.checked')!.checkable).toBe(true);
    expect(entry.props).toEqual([
      { name: 'who', kind: 'string', description: 'who to greet', required: true },
    ]);
    expect(entry.schema).toEqual({
      type                : 'object',
      properties          : { who: { type: 'string', description: 'who to greet' } },
      required            : ['who'],
      additionalProperties: false,
    });
  });

  it('carries defaults, enums and bounds into the schema', () => {
    const registry = new CommandRegistry();
    registry.register(
      defineCommand({
        id         : 'demo.opts',
        title      : 'Opts',
        description: 'Every kind.',
        mutating   : false,
        props: {
          mode : prop.oneOf(['plan', 'execute'] as const, 'mode'),
          count: prop.number('n', { default: 2, min: 0, max: 9 }),
          paths: prop.stringList('files', { default: [] }),
        },
        run        : () => Promise.resolve({ message: '' }),
      }),
    );
    const entry = toCatalog(registry, 'x').commands[0]!;
    expect(entry.usage).toBe("demo.opts(mode='plan' count=2 paths=[])");
    expect(entry.schema.required).toEqual(['mode']);
    expect(entry.schema.properties.mode).toMatchObject({ enum: ['plan', 'execute'] });
    expect(entry.schema.properties.count).toMatchObject({ minimum: 0, maximum: 9, default: 2 });
    expect(entry.schema.properties.paths).toMatchObject({
      type : 'array',
      items: { type: 'string' },
    });
  });
});

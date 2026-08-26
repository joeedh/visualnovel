/**
 * `ctx.origin` — who asked, as a number the framework never interprets.
 *
 * It is a per-execution overlay rather than a field on the shared context, and these tests
 * are the reason: commands overlap. A mutable `context.origin` set before `run` and read inside
 * it is correct exactly until two windows dispatch at once, at which point the second write
 * lands while the first command is still awaiting, and its effect goes to the wrong window. The
 * bug is invisible in a single-window app and unreproducible by hand in a multi-window one.
 */
import { defineFor, type CommandContext } from '../command.js';
import { prop } from '../props.js';
import { CommandRegistry } from '../registry.js';
import { CommandStack } from '../stack.js';
import type { Git } from '@vn/git';

const fakeGit = (): Git =>
  ({
    isRepo: () => Promise.resolve(true),
    head: () => Promise.resolve('a7c9ff4'),
    isDirty: () => Promise.resolve(false),
  }) as unknown as Git;

interface Host {
  /** Every origin a run or a check saw, in the order it saw it. */
  seen: (number | undefined)[];
  /** Lets a test hold one command inside `run` while another goes through. */
  gate?: Promise<void>;
}

const define = defineFor<Host>();

const slow = define({
  id: 'demo.slow',
  title: 'Slow',
  description: 'Reads its origin, waits, then reads it again.',
  mutating: false,
  props: { tag: prop.string('which caller this is') },
  async run(_props, ctx) {
    const before = ctx.origin;
    await (ctx.host.gate ?? Promise.resolve());
    // This second read of ctx.origin used to return the wrong value, because another exec had already run by now.
    return { message: 'done', data: { before, after: ctx.origin } };
  },
  check(_props, ctx) {
    ctx.host.seen.push(ctx.origin);
    return Promise.resolve({ ok: true as const, note: `from ${String(ctx.origin)}` });
  },
});

function setup() {
  const registry = new CommandRegistry<Host>();
  registry.registerAll([slow]);
  const host: Host = { seen: [] };
  const context: CommandContext<Host> = {
    root: '/ws',
    git: fakeGit(),
    host,
    log: () => {},
  };
  const stack = new CommandStack<Host>({
    registry,
    context,
    now: () => '2026-07-25T00:00:00.000Z',
  });
  return { stack, host, context };
}

describe('ctx.origin', () => {
  it('is undefined when nobody said — the agent, CDP, main itself', async () => {
    const { stack } = setup();
    const outcome = await stack.exec('demo.slow', { tag: 'a' }, 'agent');
    expect(outcome).toMatchObject({ ok: true, data: { before: undefined, after: undefined } });
  });

  it('reaches run and check as the caller gave it', async () => {
    const { stack, host } = setup();
    const outcome = await stack.exec('demo.slow', { tag: 'a' }, 'ui', 3);
    expect(outcome).toMatchObject({ ok: true, data: { before: 3, after: 3 } });

    await stack.check('demo.slow', { tag: 'a' }, 7);
    await stack.check('demo.slow', { tag: 'a' });
    expect(host.seen).toEqual([7, undefined]);
  });

  it('survives the DSL path too, which is what CDP and the palette use', async () => {
    const { stack } = setup();
    const outcome = await stack.execDsl("demo.slow(tag='a')", 'cdp', 2);
    expect(outcome).toMatchObject({ ok: true, data: { before: 2, after: 2 } });
  });

  it('does not leak between two overlapping executions', async () => {
    const { stack, host } = setup();
    let release = (): void => {};
    host.gate = new Promise<void>((ok) => (release = () => ok()));

    // Window 1's command parks inside `run`; window 2's goes through underneath it.
    const first = stack.exec('demo.slow', { tag: 'first' }, 'ui', 1);
    const second = stack.exec('demo.slow', { tag: 'second' }, 'ui', 2);
    release();

    expect(await first).toMatchObject({ data: { before: 1, after: 1 } });
    expect(await second).toMatchObject({ data: { before: 2, after: 2 } });
  });

  it('leaves the shared context untouched, so nothing else can read it by accident', async () => {
    const { stack, context } = setup();
    await stack.exec('demo.slow', { tag: 'a' }, 'ui', 5);
    expect(context.origin).toBeUndefined();
  });
});

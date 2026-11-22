import { promises as fs } from 'node:fs';
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import {
  type AgentMessage,
  type ApiFailure,
  type ApiRecovery,
  type Tool,
  type ToolContext,
} from '@vn/authoring';
import { openGit } from '@vn/git';
import { ProjectPaths } from '@vn/store';
import { nativeFile, readNative } from '../../notify/threads.js';
import { BUSY_AGENT } from '../../../shared/ipc.js';
import type { AskQuestion, Plan, PlanDecision } from '../../../shared/ipc.js';
import { WorkspaceSession } from '../../session.js';
import { deps, sessionFor } from './helpers.js';

/**
 * The agent's three permission doors. They were scaffolds — `ask` resolved to `''` and
 * `confirmAction` to `true` — so the desktop answered for the author, told the model it had an
 * answer, and auto-allowed every always-confirm tool. What is pinned here is that each door
 * reaches the renderer and returns what came back, nothing more clever.
 */
describe('WorkspaceSession — the agent asks the author', () => {
  const doors = (
    session: WorkspaceSession,
  ): {
    approvePlan: (plan: Plan) => Promise<PlanDecision>;
    confirmAction: (tool: string, args: unknown) => Promise<boolean>;
    ask: (form: AskQuestion[]) => Promise<string[]>;
  } => (session as unknown as { permission: () => never }).permission();

  it('routes a question to the renderer and hands back what was typed', async () => {
    const asked: string[] = [];
    const session = new WorkspaceSession('.', true, {
      ...deps,
      requestAnswer: (questions) => {
        asked.push(...questions.map((q) => q.question));
        return Promise.resolve(questions.map(() => 'Call her Aiko.'));
      },
    });
    expect(await doors(session).ask([{ question: 'What name?' }])).toEqual(['Call her Aiko.']);
    expect(asked).toEqual(['What name?']);
  });

  it('asks before an always-confirm tool, in a sentence, and a denial is a denial', async () => {
    const seen: string[] = [];
    const session = new WorkspaceSession('.', true, {
      ...deps,
      requestConfirm: (tool, detail) => {
        seen.push(`${tool}: ${detail}`);
        return Promise.resolve(false);
      },
    });
    expect(await doors(session).confirmAction('generate_image', { sentence: 'a rooftop' })).toBe(
      false,
    );
    // The card reads English, not the argument list — `toolconfirm.ts` owns the wording.
    expect(seen[0]).toContain('generate_image: Draw a concept sketch: “a rooftop”');
  });

  /**
   * The recovery card is the one place the author is already being interrupted about a failed
   * call, so the offer to diagnose it lives there rather than in a second dialog of its own.
   */
  it('offers to diagnose a rejected body, and pushes it rather than answering it', async () => {
    const offered: { thread?: string; message: string }[] = [];
    let choices: string[] = [];
    const session = new WorkspaceSession('.', true, {
      ...deps,
      requestAnswer: (questions) => {
        choices = [...(questions[0]?.choices ?? [])];
        return Promise.resolve(['Stop, and look into what went wrong']);
      },
      offerDiagnosis: (fault) => offered.push(fault),
    });
    const recover = (
      session as unknown as { recoverApi: (f: ApiFailure) => Promise<ApiRecovery> }
    ).recoverApi.bind(session);

    const stopped = await recover({
      message  : '400 messages.1.content.0: unexpected `tool_use_id`',
      transient: false,
      kind     : 'request',
      attempt  : 1,
      waitMs   : 0,
    });
    expect(choices).toContain('Stop, and look into what went wrong');
    // The turn ends because a diagnosis reads the request that failed, and a retry would put a
    // second request in front of it.
    expect(stopped).toEqual({ do: 'stop' });
    expect(offered).toEqual([{ message: '400 messages.1.content.0: unexpected `tool_use_id`' }]);
  });

  it('does not offer it for a rate limit or a rejected key', async () => {
    let choices: string[] = [];
    const session = new WorkspaceSession('.', true, {
      ...deps,
      requestAnswer: (questions) => {
        choices = [...(questions[0]?.choices ?? [])];
        return Promise.resolve(['Stop this turn']);
      },
    });
    const recover = (
      session as unknown as { recoverApi: (f: ApiFailure) => Promise<ApiRecovery> }
    ).recoverApi.bind(session);

    for (const kind of ['transient', 'auth', 'unknown'] as const) {
      await recover({
        message  : 'nope',
        transient: kind === 'transient',
        kind,
        attempt: 1,
        waitMs : 0,
      });
      expect(choices).not.toContain('Stop, and look into what went wrong');
    }
  });
});

/**
 * A conversation is written down as it happens. The mock backend answers every turn with one
 * sentence, which is all these cases need. What they assert is that the turn, the answer and
 * nothing else end up in a file under `vngen/state/threads/`.
 */
describe('WorkspaceSession — conversation threads', () => {
  let p: TestProject;

  beforeEach(async () => {
    p = await makeProject({ title: 'Threads', script: SCRIPTS.linear });
  });

  afterEach(async () => {
    await p.cleanup();
  });

  it('writes nothing until somebody says something', async () => {
    const session = sessionFor(p);
    await session.setMode('plan');
    expect(await session.threads()).toEqual({ threads: [] });
  });

  it('records the turn and the answer, and names the thread after the turn', async () => {
    const session = sessionFor(p);
    await session.runAgent('give Aiko a jacket');

    const { threads, active } = await session.threads();
    expect(threads).toHaveLength(1);
    expect(threads[0]!.title).toBe('give Aiko a jacket');
    expect(active).toBe(threads[0]!.id);

    const record = await session.openThreadForReading(threads[0]!.id);
    expect(record.items.map((i) => i.role)).toEqual(['user', 'agent']);
    expect(record.items[0]!.text).toBe('give Aiko a jacket');
    expect(record.items[1]!.text).toContain('[mock]');
  });

  it('keeps a cleared conversation, and puts the next turn in a new thread', async () => {
    const session = sessionFor(p);
    await session.runAgent('first');
    await session.clearAgent();
    expect((await session.threads()).active).toBeUndefined();

    await session.runAgent('second');
    const { threads } = await session.threads();
    expect(threads.map((t) => t.title)).toEqual(['second', 'first']);
  });

  // A turn parked on a question stands in for the real one, whose card closing the conversation
  // removed, leaving the session busy until restart
  it('refuses to close the conversation while a turn is running', async () => {
    const session = sessionFor(p);
    let finish = (): void => {};
    const turn = session.while(
      BUSY_AGENT,
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    expect(session.clearRefusal()).toMatch(/still in a turn/);
    await expect(session.clearAgent()).rejects.toThrow(/still in a turn/);

    finish();
    await turn;
    expect(session.clearRefusal()).toBeUndefined();
    await expect(session.clearAgent()).resolves.toBeUndefined();
  });

  // This case builds its own project, because every other test here works without a repo and
  // `git: true` costs an init and a commit per case.
  it('commits the conversation it closes, and writes down which commit holds it', async () => {
    const repo = await makeProject({ title: 'Threads', script: SCRIPTS.linear, git: true });
    try {
      const session = sessionFor(repo);
      await session.runAgent('first');
      const [live] = (await session.threads()).threads;
      await session.clearAgent();

      const [closed] = (await session.threads()).threads;
      const sha = closed!.archived?.[0]?.commit;
      expect(sha).toMatch(/^[0-9a-f]{40}$/);

      // The commit holds the transcript, so a thread edited away afterwards is still readable
      // out of history.
      const git = openGit(repo.dir);
      expect(await git.show(`${sha}:vngen/state/threads/${live!.id}.jsonl`)).toContain('first');
      // The commit is findable without the pointer, by `git log --grep` on the trailer
      expect(await git.show(sha!)).toContain(`Vn-Thread: ${live!.id}`);
    } finally {
      await repo.cleanup();
    }
  });

  it('starting a new conversation is not blocked by a project git cannot commit', async () => {
    // With no repo the commit is a courtesy, so it fails silently and the thread is still closed
    const session = sessionFor(p);
    await session.runAgent('first');
    await session.clearAgent();

    const [closed] = (await session.threads()).threads;
    expect(closed!.archived).toBeUndefined();
    expect((await session.threads()).active).toBeUndefined();
  });

  it('reopening a thread ends the live one, so the next turn is not written into it', async () => {
    const session = sessionFor(p);
    await session.runAgent('first');
    const [first] = (await session.threads()).threads;

    await session.openThreadForReading(first!.id);
    await session.runAgent('second');

    const reread = await session.openThreadForReading(first!.id);
    expect(reread.items.map((i) => i.text)).toEqual(expect.not.arrayContaining(['second']));
    expect((await session.threads()).threads).toHaveLength(2);
  });

  it('renames the open conversation when no id is given, and refuses an empty name', async () => {
    const session = sessionFor(p);
    await session.runAgent('first');

    expect((await session.renameThread('', 'the jacket argument')).title).toBe(
      'the jacket argument',
    );
    expect((await session.threads()).threads[0]!.title).toBe('the jacket argument');
    await expect(session.renameThread('', '  ')).rejects.toThrow(/needs a name/);
    await expect(session.renameThread('nosuchthread', 'x')).rejects.toThrow(/no such conversation/);
  });

  it('refuses to rename when there is nothing open', async () => {
    await expect(sessionFor(p).renameThread('', 'x')).rejects.toThrow(/no conversation is open/);
  });

  it('continues a saved conversation, and writes the next turn into it', async () => {
    const session = sessionFor(p);
    await session.runAgent('give Aiko a jacket');
    const [first] = (await session.threads()).threads;
    await session.clearAgent();

    await session.resumeThread(first!.id);
    const held = (session as unknown as { agent?: { transcript: readonly AgentMessage[] } }).agent!
      .transcript;
    expect(held.some((m) => m.role === 'user' && m.content === 'give Aiko a jacket')).toBe(true);
    // The gap note is filed last, so it is the newest thing the model reads before the new turn.
    expect(held[held.length - 1]!.role).toBe('context');
    expect(String(held[held.length - 1]!.content)).toContain('read a file again');

    await session.runAgent('and boots');
    expect((await session.threads()).threads).toHaveLength(1);
    const record = await session.openThreadForReading(first!.id);
    expect(record.items.map((i) => i.text)).toEqual(expect.arrayContaining(['and boots']));
  });

  it('numbers a continued turn past the messages already in the log', async () => {
    const session = sessionFor(p);
    await session.runAgent('first');
    const [thread] = (await session.threads()).threads;
    await session.clearAgent();
    const before = (await readNative(new ProjectPaths(p.dir), thread!.id))!.messages;

    await session.resumeThread(thread!.id);
    await session.runAgent('second');
    const after = (await readNative(new ProjectPaths(p.dir), thread!.id))!.messages;

    expect(after.length).toBeGreaterThan(before.length);
    expect(after.map((m) => m.n)).toEqual(after.map((_m, i) => i));
    // One header, written when the conversation was opened, and not written again by the resume.
    expect(after.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      'first',
      'second',
    ]);
  });

  it('refuses a conversation recorded before there was a history to continue from', async () => {
    const session = sessionFor(p);
    await session.runAgent('first');
    const [thread] = (await session.threads()).threads;
    await session.clearAgent();
    await fs.rm(nativeFile(new ProjectPaths(p.dir), thread!.id));

    expect(await session.resumeRefusalFor(thread!.id)).toContain(
      'recorded before conversations could be continued',
    );
    await expect(session.resumeThread(thread!.id)).rejects.toThrow(/only its transcript/);
  });

  it('refuses the conversation that is already open', async () => {
    const session = sessionFor(p);
    await session.runAgent('first');
    const [thread] = (await session.threads()).threads;
    expect(await session.resumeRefusalFor(thread!.id)).toContain('already the open conversation');
  });

  it('compacting replaces what the agent carries and leaves the transcript alone', async () => {
    const session = sessionFor(p);
    await session.runAgent('give Aiko a jacket');
    const [thread] = (await session.threads()).threads;

    const mark = await session.compactThread();
    expect(mark.covers).toBeGreaterThan(0);

    const held = (session as unknown as { agent?: { transcript: readonly AgentMessage[] } }).agent!
      .transcript;
    expect(held).toHaveLength(1);
    expect(held[0]!.role).toBe('context');
    expect(String(held[0]!.content)).toContain('[mock]');
    expect(String(held[0]!.content)).toContain('read a file again');
    expect(held.some((m) => m.content === 'give Aiko a jacket')).toBe(false);

    // Nothing is rewritten: the turns the summary covers are still in the display log, with the
    // rule filed alongside them.
    const record = await session.openThreadForReading(thread!.id);
    expect(record.items.map((i) => i.text)).toEqual(expect.arrayContaining(['give Aiko a jacket']));
    expect(record.compactions).toHaveLength(1);
    expect(record.compactions[0]!.text).toContain('[mock]');
  });

  it('a turn after a compaction is sent the summary rather than the turns it covers', async () => {
    const session = sessionFor(p);
    await session.runAgent('give Aiko a jacket');
    await session.compactThread();
    await session.runAgent('and boots');

    const held = (session as unknown as { agent?: { transcript: readonly AgentMessage[] } }).agent!
      .transcript;
    expect(held[0]!.role).toBe('context');
    expect(held.some((m) => m.content === 'and boots')).toBe(true);
    expect(held.some((m) => m.content === 'give Aiko a jacket')).toBe(false);
  });

  it('continues a compacted conversation from the summary and what followed it', async () => {
    const session = sessionFor(p);
    await session.runAgent('give Aiko a jacket');
    await session.compactThread();
    await session.runAgent('and boots');
    const [thread] = (await session.threads()).threads;
    await session.clearAgent();

    await session.resumeThread(thread!.id);
    const held = (session as unknown as { agent?: { transcript: readonly AgentMessage[] } }).agent!
      .transcript;
    expect(String(held[0]!.content)).toContain('[mock]');
    expect(held.some((m) => m.content === 'and boots')).toBe(true);
    expect(held.some((m) => m.content === 'give Aiko a jacket')).toBe(false);
  });

  it('a compacted turn is still findable, and readable in full, by the agent’s own tools', async () => {
    const session = sessionFor(p);
    await session.runAgent('give Aiko a jacket');
    await session.compactThread();

    const registry = (session as unknown as { agent?: { registry: Map<string, Tool> } }).agent!
      .registry;
    const ctx = {} as ToolContext;

    const found = await registry.get('search_history')!.run({ query: 'a jacket' }, ctx);
    expect(found.ok).toBe(true);
    expect(found.output).toContain('#0 user');

    const read = await registry.get('read_history')!.run({ n: 0 }, ctx);
    expect(read.output).toContain('give Aiko a jacket');
  });

  it('refuses to compact nothing, and to compact twice with nothing said between', async () => {
    const session = sessionFor(p);
    expect(await session.compactRefusalFor()).toContain('Nothing has been said');
    await expect(session.compactThread()).rejects.toThrow(/Nothing has been said/);

    await session.runAgent('first');
    expect(await session.compactRefusalFor()).toBeUndefined();
    await session.compactThread();
    expect(await session.compactRefusalFor()).toContain('compacted already');

    await session.runAgent('second');
    expect(await session.compactRefusalFor()).toBeUndefined();
  });
});

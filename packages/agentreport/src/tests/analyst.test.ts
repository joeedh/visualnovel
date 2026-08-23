import { z } from 'zod';
import type { ChatBackend, ChatConvoReply, ChatConvoRequest, ToolSchema } from '@vn/providers';
import type { AgentEvent, AskQuestion, Tool, ToolContext } from '@vn/authoring';
import { createAnalyst, type Analyst, type AnalystHost } from '../analyze.js';
import { buildRedactor } from '../redact.js';
import type { Evidence } from '../transcript.js';

/** One scripted reply: a tool call, or the text that ends the turn. */
type Reply = { tool: string; args: unknown } | { text: string };

/**
 * A conversation backend that answers from a script and counts both seams. `direct` counting is the
 * point of the fake as much as the script is: the single-call path is what a stopped turn must not
 * reach, and one spurious fallback is exactly one call.
 */
class Convo implements ChatBackend {
  readonly modelId = 'claude-sonnet-5';
  readonly requests: ChatConvoRequest[] = [];
  readonly catalogs: ToolSchema[][] = [];
  calls = 0;
  direct = 0;
  /** Runs before each reply, so a test can act on the analyst mid-turn. */
  before?: () => void;
  constructor(private readonly script: Reply[]) {}

  async message(): Promise<string> {
    this.direct++;
    return JSON.stringify(findings);
  }

  async chatConversation(req: ChatConvoRequest, tools: ToolSchema[]): Promise<ChatConvoReply> {
    this.calls++;
    this.requests.push(req);
    this.catalogs.push(tools);
    this.before?.();
    const next = this.script.shift() ?? { text: 'nothing left to say' };
    if ('text' in next) {
      return { raw: [{ type: 'text', text: next.text }], toolCalls: [], text: next.text };
    }
    const id = `call_${this.calls}`;
    return {
      raw: [{ type: 'tool_use', id, name: next.tool, input: next.args }],
      toolCalls: [{ id, name: next.tool, args: next.args }],
    };
  }
}

const findings = {
  summary: 'The agent rewrote Titus Vale instead of reading about him',
  whatHappened: 'It edited C:\\dev\\proj\\scenes\\s1.md without being asked.',
  whatWentWrong: ['It wrote in plan mode'],
  rootCause: 'A question read as an instruction.',
  recommendations: [{ behaviour: 'Ask first', rationale: 'Cheaper than an undo' }],
  confidence: 'medium',
  evidence: ['Titus Vale was renamed'],
};

const evidence: Evidence = {
  thread: {
    id: 't1',
    title: 'About Titus Vale',
    startedAt: '2026-01-01T14:00:00.000Z',
    items: [
      {
        id: 1,
        role: 'user',
        text: 'what happens to Titus Vale in scenes/s1.md?',
        at: '2026-01-01T14:00:00.000Z',
      },
    ],
  },
  acts: [],
  thin: false,
  context: {},
};

const redactor = () =>
  buildRedactor({
    entities: [{ id: 'titus', name: 'Titus Vale', kind: 'character' }],
    projectRoot: 'C:\\dev\\proj',
  });

const grep: Tool = {
  name: 'grep',
  description: 'search the source',
  mutating: false,
  args: z.object({ pattern: z.string() }),
  async run() {
    return { ok: true, output: 'loop.ts:240 mutating tool blocked in plan mode' };
  },
} as Tool;

const list: Tool = {
  name: 'list_requests',
  description: 'list what was sent',
  mutating: false,
  args: z.object({}),
  async run() {
    return { ok: true, output: '#1  convo  900 B' };
  },
} as Tool;

/** A host that records what it was asked and what it was shown. */
function watcher(answers: string[] = []): AnalystHost & {
  forms: (readonly AskQuestion[])[];
  events: AgentEvent[];
} {
  const forms: (readonly AskQuestion[])[] = [];
  const events: AgentEvent[] = [];
  return {
    forms,
    events,
    async ask(form) {
      forms.push(form);
      return form.map((_, i) => answers[i] ?? 'no answer');
    },
    onEvent(event) {
      events.push(event);
    },
  };
}

function analystOn(
  backend: Convo,
  host: AnalystHost | undefined,
  extra: { detail?: Map<string, Tool> } = {},
): Analyst {
  return createAnalyst({
    evidence,
    backend,
    redactor: redactor(),
    detail: extra.detail ?? new Map<string, Tool>([['list_requests', list]]),
    ctx: {} as ToolContext,
    ...(host ? { host } : {}),
  });
}

/** An analyst its own backend can reach, so a test can act on it part way through a turn. */
function reacting(backend: Convo, act: (analyst: Analyst) => void): Analyst {
  const analyst = analystOn(backend, watcher());
  backend.before = () => act(analyst);
  return analyst;
}

/** The same, acting on the first reply of the first turn and no other. */
function reactingOnce(backend: Convo, act: (analyst: Analyst) => void): Analyst {
  return reacting(backend, (analyst) => {
    backend.before = undefined;
    act(analyst);
  });
}

describe('a conversation with the analyst', () => {
  it('keeps what was said across two turns', async () => {
    const backend = new Convo([
      { text: 'it edited in plan mode' },
      { text: 'because it was asked' },
    ]);
    const analyst = analystOn(backend, watcher());

    await analyst.ask('what went wrong?');
    await analyst.ask('why did that happen?');

    const second = JSON.stringify(backend.requests[1]!.turns);
    expect(second).toContain('what went wrong?');
    expect(second).toContain('it edited in plan mode');
    expect(second).toContain('why did that happen?');
  });

  it('files a report, and replaces it when a later turn revises it', async () => {
    const revised = { ...findings, rootCause: 'The plan was approved by accident.' };
    const backend = new Convo([
      { tool: 'submit_report', args: findings },
      { text: 'filed' },
      { tool: 'submit_report', args: revised },
      { text: 'filed again' },
    ]);
    const analyst = analystOn(backend, watcher());

    const first = await analyst.ask('what went wrong?');
    expect(first.report?.analysis.rootCause).toBe('A question read as an instruction.');

    const second = await analyst.ask('you missed the approval');
    expect(second.report?.analysis.rootCause).toBe('The plan was approved by accident.');
    expect(analyst.filed?.analysis.rootCause).toBe('The plan was approved by accident.');
  });

  it('reports a turn that filed nothing as a turn that filed nothing', async () => {
    const backend = new Convo([{ text: 'I still cannot tell' }]);
    const analyst = analystOn(backend, watcher());

    const turn = await analyst.ask('what went wrong?');
    expect(turn.report).toBeUndefined();
    expect(turn.final).toBe('I still cannot tell');
    expect(backend.direct).toBe(0);
  });

  it('ends a stopped turn without reaching the single-call path', async () => {
    const backend = new Convo([
      { tool: 'list_requests', args: {} },
      { text: 'this reply is never asked for' },
    ]);
    const analyst = reacting(backend, (a) => a.stop());

    const turn = await analyst.ask('what went wrong?');
    expect(turn.stopped).toBe(true);
    expect(turn.report).toBeUndefined();
    expect(backend.calls).toBe(1);
    expect(backend.direct).toBe(0);
  });

  it('clears the stop, so the next turn runs', async () => {
    const backend = new Convo([{ tool: 'list_requests', args: {} }, { text: 'carried on' }]);
    const analyst = reactingOnce(backend, (a) => a.stop());

    expect((await analyst.ask('what went wrong?')).stopped).toBe(true);
    const second = await analyst.ask('carry on');
    expect(second.stopped).toBe(false);
    expect(second.final).toBe('carried on');
  });

  it('treats a turn that concluded while a stop was in flight as finished', async () => {
    const backend = new Convo([{ text: 'it edited in plan mode' }]);
    const analyst = reacting(backend, (a) => a.stop());

    const turn = await analyst.ask('what went wrong?');
    expect(turn.stopped).toBe(false);
    expect(turn.final).toBe('it edited in plan mode');
  });

  it('redacts every event before the host sees it', async () => {
    const backend = new Convo([{ text: 'Titus Vale was renamed in C:\\dev\\proj\\scenes\\s1.md' }]);
    const host = watcher();
    await analystOn(backend, host).ask('what went wrong?');

    const seen = JSON.stringify(host.events);
    expect(seen).toContain('Character A');
    expect(seen).not.toMatch(/Titus|C:\\\\dev/);
    expect(host.events.some((e) => e.type === 'final')).toBe(true);
  });

  it('leaves an event’s own fields alone while redacting what the model wrote', async () => {
    const backend = new Convo([{ tool: 'list_requests', args: {} }, { text: 'done' }]);
    const host = watcher();
    await analystOn(backend, host).ask('what went wrong?');

    const tool = host.events.find((e) => e.type === 'tool');
    expect(tool).toMatchObject({ type: 'tool', tool: 'list_requests' });
  });
});

describe('granting the analyst more to read', () => {
  it('advertises a granted tool from the next turn, not the one in flight', async () => {
    const backend = new Convo([{ text: 'nothing to read yet' }, { text: 'now I can look' }]);
    const analyst = reactingOnce(backend, (a) =>
      a.grant({ kind: 'source', tools: new Map<string, Tool>([['grep', grep]]) }),
    );

    await analyst.ask('what went wrong?');
    expect(backend.catalogs[0]!.map((t) => t.name)).not.toContain('grep');

    await analyst.ask('look at the source');
    expect(backend.catalogs[1]!.map((t) => t.name)).toContain('grep');
  });

  it('announces the grant in the transcript, leaving the cached prompt alone', async () => {
    const backend = new Convo([{ text: 'nothing to read yet' }, { text: 'now I can look' }]);
    const analyst = reactingOnce(backend, (a) =>
      a.grant({ kind: 'source', tools: new Map<string, Tool>([['grep', grep]]) }),
    );

    await analyst.ask('what went wrong?');
    expect(backend.requests[0]!.system).not.toContain("You can read the tool's own source code");

    await analyst.ask('look at the source');
    // The prompt is the front of the cached prefix, so a grant arrives as a message behind it
    expect(backend.requests[1]!.system).toBe(backend.requests[0]!.system);
    expect(JSON.stringify(backend.requests[1]!.turns)).toContain(
      "You can read the tool's own source code",
    );
  });

  it('records that the source was read once a granted tool has run', async () => {
    const backend = new Convo([
      { text: 'nothing to read yet' },
      { tool: 'grep', args: { pattern: 'plan mode' } },
      { tool: 'submit_report', args: findings },
      { text: 'filed' },
    ]);
    const analyst = reactingOnce(backend, (a) =>
      a.grant({ kind: 'source', tools: new Map<string, Tool>([['grep', grep]]) }),
    );

    await analyst.ask('what went wrong?');
    const turn = await analyst.ask('look at the source');
    expect(turn.report?.readSource).toBe(true);
    expect(turn.report?.analysis.confidence).toBe('medium');
  });
});

describe('the author sitting in front of it', () => {
  it('puts a question to the host and feeds the answer back to the model', async () => {
    const backend = new Convo([
      { tool: 'ask_user', args: { question: 'which scene were you editing?' } },
      { text: 'thanks' },
    ]);
    const host = watcher(['the one Character A dies in']);
    await analystOn(backend, host).ask('what went wrong?');

    expect(host.forms[0]![0]!.question).toBe('which scene were you editing?');
    expect(JSON.stringify(backend.requests[1]!.turns)).toContain('the one Character A dies in');
  });

  it('answers for nobody when there is no host', async () => {
    const backend = new Convo([
      { tool: 'ask_user', args: { question: 'which scene were you editing?' } },
      { text: 'thanks' },
    ]);
    await analystOn(backend, undefined).ask('what went wrong?');

    expect(JSON.stringify(backend.requests[1]!.turns)).toContain('Nobody is here to answer');
  });

  it('tells an attended analyst it may file more than one report', async () => {
    const backend = new Convo([{ text: 'ok' }]);
    await analystOn(backend, watcher()).ask('what went wrong?');
    expect(backend.requests[0]!.system).toContain('You are talking to the author');

    const headless = new Convo([{ text: 'ok' }]);
    await analystOn(headless, undefined).ask('what went wrong?');
    expect(headless.requests[0]!.system).toContain('call submit_report exactly once');
  });
});

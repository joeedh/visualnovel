import { z } from 'zod';
import type {
  ChatBackend,
  ChatConvoReply,
  ChatConvoRequest,
  ChatRequest,
  ToolSchema,
} from '@vn/providers';
import type { Tool, ToolContext } from '@vn/authoring';
import { analystBackend, analyze } from '../analyze.js';
import { buildRedactor } from '../redact.js';
import type { Evidence } from '../transcript.js';

/**
 * A backend that answers from a script and remembers what it was asked. `whenDirect` answers the
 * one-call path whatever the queue holds, so a test about the loop is not also a test about how
 * many replies the fallback consumed.
 */
class Scripted implements ChatBackend {
  readonly modelId = 'claude-sonnet-5';
  readonly prompts: string[] = [];
  constructor(
    private readonly replies: string[],
    private readonly whenDirect?: string,
  ) {}
  async message(req: ChatRequest): Promise<string> {
    this.prompts.push(req.prompt);
    if (this.whenDirect && req.prompt.includes('Reply with a single JSON object')) {
      return this.whenDirect;
    }
    return this.replies.shift() ?? '{"final":"nothing left to say"}';
  }
}

/**
 * A backend that implements the conversation seam, so the analyst's probe selects the native path.
 * It answers with one `submit_report` call and then plain text, and keeps every request it was
 * handed. `message` throws, because taking the structured path is the failure this fake catches.
 */
class Native implements ChatBackend {
  readonly modelId = 'claude-sonnet-5';
  readonly requests: ChatConvoRequest[] = [];
  readonly catalogs: ToolSchema[][] = [];
  private turn = 0;
  constructor(private readonly report: unknown) {}
  async message(): Promise<string> {
    throw new Error('the structured path was taken');
  }
  async chatConversation(req: ChatConvoRequest, tools: ToolSchema[]): Promise<ChatConvoReply> {
    this.requests.push(req);
    this.catalogs.push(tools);
    if (this.turn++ > 0)
      return { raw: [{ type: 'text', text: 'filed' }], toolCalls: [], text: 'filed' };
    return {
      raw: [{ type: 'tool_use', id: 'call_1', name: 'submit_report', input: this.report }],
      toolCalls: [{ id: 'call_1', name: 'submit_report', args: this.report }],
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

describe('without the source', () => {
  it('makes one call and returns the findings', async () => {
    const backend = new Scripted([JSON.stringify(findings)]);
    const report = await analyze({ evidence, backend, redactor: redactor() });
    expect(report.readSource).toBe(false);
    expect(report.model).toBe('claude-sonnet-5');
    expect(report.analysis.rootCause).toBe('A question read as an instruction.');
    expect(backend.prompts).toHaveLength(1);
  });

  it('shows the analyst a transcript with the names already gone', async () => {
    const backend = new Scripted([JSON.stringify(findings)]);
    await analyze({ evidence, backend, redactor: redactor() });
    expect(backend.prompts[0]).toContain('Character A');
    expect(backend.prompts[0]).not.toContain('Titus Vale');
  });

  it('redacts what the analyst wrote as well as what it read', async () => {
    const backend = new Scripted([JSON.stringify(findings)]);
    const report = await analyze({ evidence, backend, redactor: redactor() });
    expect(report.analysis.summary).toContain('Character A');
    expect(report.analysis.whatHappened).toContain('<project>');
    expect(JSON.stringify(report)).not.toMatch(/Titus|C:\\\\dev/);
  });

  it('passes the author’s own account through the redactor too', async () => {
    const backend = new Scripted([JSON.stringify(findings)]);
    await analyze({
      evidence,
      backend,
      redactor: redactor(),
      wanted: 'I only wanted a summary of Titus Vale',
    });
    expect(backend.prompts[0]).toContain('What the author says they wanted');
    expect(backend.prompts[0]).not.toContain('Titus Vale');
  });

  it('says the author did not say, rather than leaving the model to wonder', async () => {
    const backend = new Scripted([JSON.stringify(findings)]);
    await analyze({ evidence, backend, redactor: redactor() });
    expect(backend.prompts[0]).toContain('They did not say');
  });
});

describe('with the source', () => {
  const grepped: string[] = [];
  const grep: Tool<{ pattern: string }> = {
    name: 'grep',
    description: 'search the source',
    mutating: false,
    args: z.object({ pattern: z.string() }),
    async run(a) {
      grepped.push(a.pattern);
      return { ok: true, output: 'loop.ts:240 mutating tool blocked in plan mode' };
    },
  };
  const source = () => ({
    registry: new Map<string, Tool>([['grep', grep as Tool]]),
    ctx: {} as ToolContext,
  });

  beforeEach(() => {
    grepped.length = 0;
  });

  it('reads the source, then files the report as a tool call', async () => {
    const backend = new Scripted([
      JSON.stringify({ tool: 'grep', args: { pattern: 'plan mode' } }),
      JSON.stringify({ tool: 'submit_report', args: findings }),
      JSON.stringify({ final: 'filed' }),
    ]);
    const report = await analyze({ evidence, backend, redactor: redactor(), source: source() });
    expect(grepped).toEqual(['plan mode']);
    expect(report.readSource).toBe(true);
    expect(report.fellBack).toBeUndefined();
    expect(report.analysis.summary).toContain('Character A');
  });

  it('advertises the submit tool without letting the analyst edit anything', async () => {
    const backend = new Scripted([JSON.stringify({ tool: 'submit_report', args: findings })]);
    await analyze({ evidence, backend, redactor: redactor(), source: source() });
    expect(backend.prompts[0]).toContain('submit_report');
    expect(backend.prompts[0]).toContain('- grep');
    expect(backend.prompts[0]).not.toContain('write_file');
  });

  it('answers a question nobody is there to answer, rather than parking', async () => {
    const backend = new Scripted([
      JSON.stringify({ tool: 'ask_user', args: { question: 'what did you want?' } }),
      JSON.stringify({ tool: 'submit_report', args: findings }),
    ]);
    const report = await analyze({ evidence, backend, redactor: redactor(), source: source() });
    expect(report.readSource).toBe(true);
  });

  it('falls back to one call, and says it did, when no report is filed', async () => {
    const backend = new Scripted(
      [JSON.stringify({ final: 'I could not work it out' })],
      JSON.stringify(findings),
    );
    const report = await analyze({ evidence, backend, redactor: redactor(), source: source() });
    expect(report.readSource).toBe(false);
    expect(report.fellBack).toContain('I could not work it out');
    expect(report.analysis.rootCause).toBe('A question read as an instruction.');
  });

  it('stops at the step cap instead of looping forever', async () => {
    const backend = new Scripted(
      Array.from({ length: 8 }, () => JSON.stringify({ tool: 'grep', args: { pattern: 'x' } })),
      JSON.stringify(findings),
    );
    const report = await analyze({
      evidence,
      backend,
      redactor: redactor(),
      source: source(),
      maxIterations: 3,
    });
    expect(grepped).toHaveLength(3);
    expect(report.fellBack).toContain('3 steps without finishing');
  });
});

/**
 * The author may let the analyst read what was sent without handing it the repository, so the tool
 * loop has to be reachable from the captured requests alone as well as from the source alone.
 */
describe('with the requests but not the source', () => {
  const listed: number[] = [];
  const list: Tool<Record<string, never>> = {
    name: 'list_requests',
    description: 'list what was sent',
    mutating: false,
    args: z.object({}),
    async run() {
      listed.push(1);
      return { ok: true, output: '#1  convo  900 B  FAILED: messages.1.content.0' };
    },
  };
  const detail = () => new Map<string, Tool>([['list_requests', list as Tool]]);

  it('runs the loop, and says it did not read the source', async () => {
    listed.length = 0;
    const backend = new Scripted([
      JSON.stringify({ tool: 'list_requests', args: {} }),
      JSON.stringify({ tool: 'submit_report', args: findings }),
    ]);
    const report = await analyze({
      evidence,
      backend,
      redactor: redactor(),
      detail: detail(),
      ctx: {} as ToolContext,
    });
    expect(listed).toHaveLength(1);
    expect(report.readSource).toBe(false);
    expect(report.fellBack).toBeUndefined();
    expect(backend.prompts[0]).toContain('list_requests');
  });

  it('tells the analyst the capture is private, and only when it has one', async () => {
    // The paragraph rides on the system prompt, which is what the provider caches — so it is
    // spliced in per analysis rather than restated in every step.
    const systems: (string | undefined)[] = [];
    class Watched extends Scripted {
      override async message(req: ChatRequest): Promise<string> {
        systems.push(req.system);
        return super.message(req);
      }
    }

    await analyze({
      evidence,
      backend: new Watched([JSON.stringify({ tool: 'submit_report', args: findings })]),
      redactor: redactor(),
      detail: detail(),
      ctx: {} as ToolContext,
    });
    expect(systems[0]).toContain('Never quote its content');

    systems.length = 0;
    await analyze({
      evidence,
      backend: new Watched([JSON.stringify(findings)]),
      redactor: redactor(),
    });
    expect(systems[0]).not.toContain('Never quote its content');
  });
});

/**
 * The cached path. The analyst re-reads the transcript on every iteration, so the thing worth
 * asserting is that it goes over the conversation seam with breakpoints on it, and with a catalog
 * the model can call without searching first.
 */
describe('on a backend that supports conversations', () => {
  const source = (): { registry: Map<string, Tool>; ctx: ToolContext } => ({
    registry: new Map<string, Tool>([
      [
        'grep',
        {
          name: 'grep',
          description: 'search the source',
          mutating: false,
          args: z.object({ pattern: z.string() }),
          async run() {
            return { ok: true, output: 'nothing' };
          },
        } as Tool,
      ],
    ]),
    ctx: {} as ToolContext,
  });

  it('takes the native path and files the report through it', async () => {
    const backend = new Native(findings);
    const report = await analyze({ evidence, backend, redactor: redactor(), source: source() });
    expect(backend.requests.length).toBeGreaterThan(0);
    expect(report.readSource).toBe(true);
    expect(report.fellBack).toBeUndefined();
    expect(report.analysis.summary).toContain('Character A');
    expect(JSON.stringify(report)).not.toMatch(/Titus/);
  });

  it('marks the tail of every request, so the transcript is read from cache', async () => {
    const backend = new Native(findings);
    await analyze({ evidence, backend, redactor: redactor(), source: source() });
    for (const req of backend.requests) {
      expect(req.turns[req.turns.length - 1]?.cache).toBe(true);
    }
  });

  it('defers no tool, so submit_report is callable without a search', async () => {
    const backend = new Native(findings);
    await analyze({ evidence, backend, redactor: redactor(), source: source() });
    const names = backend.catalogs[0]!.map((t) => t.name);
    expect(names).toContain('submit_report');
    expect(names).toContain('grep');
    expect(backend.catalogs[0]!.filter((t) => t.defer)).toEqual([]);
  });

  it('probes on a detail-only run too', async () => {
    const backend = new Native(findings);
    const report = await analyze({
      evidence,
      backend,
      redactor: redactor(),
      detail: new Map<string, Tool>([
        [
          'list_requests',
          {
            name: 'list_requests',
            description: 'list what was sent',
            mutating: false,
            args: z.object({}),
            async run() {
              return { ok: true, output: '#1' };
            },
          } as Tool,
        ],
      ]),
      ctx: {} as ToolContext,
    });
    expect(backend.requests.length).toBeGreaterThan(0);
    expect(report.readSource).toBe(false);
    expect(report.fellBack).toBeUndefined();
  });
});

describe('the key the analysis model needs', () => {
  const config = { keys: { gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' } } as never;

  it('refuses by naming the source, never the value', () => {
    expect(() => analystBackend('claude-sonnet-5', config, { gemini: 'g', anthropic: '' })).toThrow(
      /\$ANTHROPIC_API_KEY.*claude\.txt/s,
    );
  });

  it('asks for the vendor the model actually needs', () => {
    expect(() =>
      analystBackend('gemini-2.5-flash', config, { gemini: '', anthropic: 'a' }),
    ).toThrow(/gemini\.txt/);
  });

  it('builds a backend when the key is there', () => {
    const backend = analystBackend('claude-sonnet-5', config, { gemini: '', anthropic: 'sk-test' });
    expect(backend.modelId).toBe('claude-sonnet-5');
  });
});

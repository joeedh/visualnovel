/**
 * The OpenRouter chat backend against a fake endpoint: the exact body each call sends, how each
 * shape of answer is read, and which failures the retry policy sees. A cache hit cannot be
 * observed without a key; what is checked here is where the markers land.
 */
import type { Route } from '@vn/types';
import { ProviderError, RetryableProviderError } from '@vn/util';
import type { ChatTurn, ToolSchema } from '../../backend.js';
import { capturedRequest, capturedRequests, clearCaptures } from '../capture.js';
import { createOpenRouterChat, OPENROUTER_CHAT_URL } from '../openrouter-chat.js';

const CLAUDE: Route = {
  modelId  : 'claude-opus-4-8',
  native   : 'anthropic',
  transport: 'openrouter',
  wireId   : 'anthropic/claude-opus-4.8',
};
const GEMINI: Route = {
  modelId  : 'gemini-2.5-flash',
  native   : 'gemini',
  transport: 'openrouter',
  wireId   : 'google/gemini-2.5-flash',
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

const TOOLS: ToolSchema[] = [
  { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
  { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' }, defer: true },
];

type Part = { type: string; text?: string; cache_control?: unknown; image_url?: { url: string } };
interface Message {
  role: string;
  content: string | Part[] | null;
  tool_call_id?: string;
  tool_calls?: unknown[];
  reasoning_details?: unknown;
}
interface SentBody {
  model: string;
  messages: Message[];
  tools?: { type: string; function: { name: string } }[];
  max_tokens?: number;
  reasoning?: Record<string, unknown>;
  provider?: { data_collection?: string };
}
interface Sent {
  url: string;
  headers: Record<string, string>;
  body: SentBody;
}

/** A reply carrying `message` as its one choice, and `usage` where given. */
function said(message: Record<string, unknown>, usage?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ choices: [{ message }], ...(usage ? { usage } : {}) }), {
    status: 200,
  });
}

const text = (content: string, usage?: Record<string, unknown>) =>
  said({ role: 'assistant', content }, usage);

/** A fake endpoint replaying `answers` in order, the last one repeating, and keeping what it was sent. */
function endpoint(answers: (() => Response)[]): { fetchImpl: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body   : JSON.parse(String(init.body)) as SentBody,
    });
    const answer = answers[Math.min(sent.length - 1, answers.length - 1)]!;
    return Promise.resolve(answer());
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function backend(
  answers: (() => Response)[],
  route: Route = CLAUDE,
  opts: { effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'; record?: boolean } = {},
) {
  const fake = endpoint(answers);
  return {
    ...fake,
    chat: createOpenRouterChat('a-key', route, { ...opts, fetchImpl: fake.fetchImpl }),
  };
}

beforeEach(() => clearCaptures());

describe('a plain message', () => {
  it('posts the wire id, the system and user messages, a deny on data collection and the key', async () => {
    const { chat, sent } = backend([() => text('hello')]);

    const reply = await chat.message({ system: 'be brief', prompt: 'hi' });

    expect(reply).toBe('hello');
    expect(chat.modelId).toBe('claude-opus-4-8');
    expect(sent[0]?.url).toBe(OPENROUTER_CHAT_URL);
    expect(sent[0]?.headers['authorization']).toBe('Bearer a-key');
    expect(sent[0]?.body).toEqual({
      model     : 'anthropic/claude-opus-4.8',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
      max_tokens: 16_000,
      reasoning : { effort: 'low' },
      provider  : { data_collection: 'deny' },
    });
  });

  it('carries an image as a data-URL part ahead of the prompt', async () => {
    const { chat, sent } = backend([() => text('a cat')]);

    await chat.message({ prompt: 'what is this', images: [{ bytes: PNG, ext: 'png' }] });

    const user = sent[0]!.body.messages[0]!;
    expect(user.role).toBe('user');
    const parts = user.content as Part[];
    expect(parts[0]?.type).toBe('image_url');
    expect(parts[0]?.image_url?.url).toMatch(/^data:image\/png;base64,/);
    expect(parts[1]).toEqual({ type: 'text', text: 'what is this' });
  });

  it('reports usage with the cache split carved out of the input', async () => {
    const usage = {
      prompt_tokens        : 1200,
      completion_tokens    : 30,
      prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 100 },
    };
    const { chat } = backend([() => text('hello', usage)]);

    const reply = await chat.messageWithUsage!({ prompt: 'hi' });

    expect(reply.usage).toEqual({ input: 1200, output: 30, cacheRead: 1000, cacheWrite: 100 });
    expect(chat.cacheReporting).toBe('billed');
    expect(chat.cacheTtlMs).toBe(5 * 60 * 1000);
  });

  it('answers no usage when the reply carries none, and marks Gemini figures as estimated', async () => {
    const { chat } = backend([() => text('hello')]);
    expect((await chat.messageWithUsage!({ prompt: 'hi' })).usage).toBeUndefined();

    const gemini = backend(
      [() => text('hello', { prompt_tokens: 5, completion_tokens: 1 })],
      GEMINI,
    );
    const reply = await gemini.chat.messageWithUsage!({ prompt: 'hi' });
    expect(reply.usage).toEqual({ input: 5, output: 1, cacheEstimated: true });
    expect(gemini.chat.cacheReporting).toBe('estimated');
    expect(gemini.chat.cacheTtlMs).toBeUndefined();
  });
});

describe('effort', () => {
  it('sends each level the native model honours, and disables reasoning for none', async () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const { chat, sent } = backend([() => text('ok')], CLAUDE, { effort });
      await chat.message({ prompt: 'hi' });
      expect(sent[0]?.body.reasoning).toEqual({ effort });
      expect(sent[0]?.body.max_tokens).toBe(16_000);
    }
    const off = backend([() => text('ok')], CLAUDE, { effort: 'none' });
    await off.chat.message({ prompt: 'hi' });
    expect(off.sent[0]?.body.reasoning).toEqual({ enabled: false });
    expect(off.sent[0]?.body.max_tokens).toBe(10_000);
  });

  it('steps a level down to what the native spelling offers, and sends none for a model with no knob', async () => {
    const sonnet: Route = {
      ...CLAUDE,
      modelId: 'claude-sonnet-4-6',
      wireId : 'anthropic/claude-sonnet-4.6',
    };
    const stepped = backend([() => text('ok')], sonnet, { effort: 'xhigh' });
    await stepped.chat.message({ prompt: 'hi' });
    expect(stepped.sent[0]?.body.reasoning).toEqual({ effort: 'high' });

    const gemini = backend([() => text('ok')], GEMINI, { effort: 'max' });
    await gemini.chat.message({ prompt: 'hi' });
    expect('reasoning' in gemini.sent[0]!.body).toBe(false);
    expect(gemini.sent[0]?.body.max_tokens).toBe(10_000);
  });

  it('resends once with reasoning merely enabled when the level is refused, and remembers', async () => {
    const refused = () =>
      new Response('{"error":{"message":"reasoning.effort is not supported"}}', { status: 400 });
    const { chat, sent } = backend([refused, () => text('ok'), () => text('again')], CLAUDE, {
      effort: 'high',
    });

    expect(await chat.message({ prompt: 'hi' })).toBe('ok');
    expect(await chat.message({ prompt: 'hi' })).toBe('again');

    expect(sent.map((s) => s.body.reasoning)).toEqual([
      { effort: 'high' },
      { enabled: true },
      { enabled: true },
    ]);
    const labels = capturedRequests().filter((h) => h.label === 'openrouter-chat');
    expect(labels).toHaveLength(3);
    expect(labels[0]?.error).toContain('400 OpenRouter');
  });

  it('does not resend a 400 that names something other than reasoning', async () => {
    const { chat, sent } = backend([() => new Response('bad tool schema', { status: 400 })]);
    await expect(chat.message({ prompt: 'hi' })).rejects.toThrow('400 OpenRouter: bad tool schema');
    expect(sent).toHaveLength(1);
  });
});

describe('chatWithTools', () => {
  it('sends the whole catalog as functions, ignoring defer, and parses the arguments', async () => {
    const { chat, sent } = backend([
      () =>
        said({
          role      : 'assistant',
          content   : null,
          tool_calls: [
            {
              id      : 'call_1',
              type    : 'function',
              function: { name: 'read_file', arguments: '{"path":"a.md"}' },
            },
          ],
        }),
    ]);

    const reply = await chat.chatWithTools!({ system: 's', prompt: 'read it' }, TOOLS);

    expect(sent[0]?.body.tools).toEqual([
      {
        type    : 'function',
        function: {
          name       : 'read_file',
          description: 'Read a file.',
          parameters : { type: 'object' },
        },
      },
      {
        type    : 'function',
        function: {
          name       : 'write_file',
          description: 'Write a file.',
          parameters : { type: 'object' },
        },
      },
    ]);
    expect(reply.text).toBeUndefined();
    expect(reply.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', args: { path: 'a.md' } }]);
  });

  it('refuses arguments that are not JSON, naming the tool', async () => {
    const { chat } = backend([
      () =>
        said({
          role      : 'assistant',
          content   : '',
          tool_calls: [
            { id: 'c', type: 'function', function: { name: 'read_file', arguments: '{oops' } },
          ],
        }),
    ]);
    const err = await chat.chatWithTools!({ prompt: 'x' }, TOOLS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toContain('arguments for read_file that are not JSON');
  });
});

describe('chatConversation', () => {
  const assistant = {
    role             : 'assistant',
    content          : null,
    reasoning_details: [{ type: 'reasoning.text', text: 'hmm' }],
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
    ],
  };

  it('translates the three turn shapes, echoes the assistant message whole, and places the breakpoints', async () => {
    const { chat, sent } = backend([() => text('done')]);
    const turns: ChatTurn[] = [
      { role: 'user', content: 'read the file' },
      { role: 'assistant', content: [assistant] },
      {
        role   : 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file text' }],
        cache  : true,
      },
      { role: 'assistant', content: 'I read it.' },
      { role: 'system', content: 'MODE: plan' },
      { role: 'user', content: 'now summarize', cache: true },
    ];

    const reply = await chat.chatConversation!({ system: 'sys', turns }, TOOLS);

    expect(reply.text).toBe('done');
    expect(reply.raw).toEqual([{ role: 'assistant', content: 'done' }]);
    expect(sent[0]?.body.messages).toEqual([
      {
        role   : 'system',
        content: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      },
      { role: 'user', content: 'read the file' },
      assistant,
      {
        role        : 'tool',
        tool_call_id: 'call_1',
        content     : [{ type: 'text', text: 'file text', cache_control: { type: 'ephemeral' } }],
      },
      { role: 'assistant', content: 'I read it.' },
      { role: 'user', content: 'MODE: plan' },
      {
        role   : 'user',
        content: [{ type: 'text', text: 'now summarize', cache_control: { type: 'ephemeral' } }],
      },
    ]);
    expect(sent[0]?.body.tools?.map((t) => t.function.name)).toEqual(['read_file', 'write_file']);
  });

  it('keeps only the newest two requested breakpoints', async () => {
    const { chat, sent } = backend([() => text('ok')]);
    const turns: ChatTurn[] = [
      { role: 'user', content: 'a', cache: true },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c', cache: true },
      { role: 'assistant', content: 'd' },
      { role: 'user', content: 'e', cache: true },
    ];
    await chat.chatConversation!({ system: '', turns }, []);
    const markedOn = sent[0]!.body.messages.filter(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.cache_control !== undefined),
    );
    expect(markedOn.map((m) => (m.content as Part[])[0]?.text)).toEqual(['c', 'e']);
    expect(sent[0]!.body.messages[0]).toEqual({ role: 'user', content: 'a' });
  });

  it('refuses an assistant turn recorded natively by naming the block', async () => {
    const { chat, sent } = backend([() => text('ok')]);
    const turns: ChatTurn[] = [
      { role: 'user', content: 'a' },
      {
        role   : 'assistant',
        content: [
          { type: 'thinking', thinking: '...' },
          { type: 'text', text: 'b' },
        ],
      },
    ];
    await expect(chat.chatConversation!({ system: 's', turns }, [])).rejects.toThrow(
      'an assistant turn holds a thinking block',
    );
    expect(sent).toEqual([]);
  });
});

describe('the captured request and the refusals', () => {
  it('keeps the body under openrouter-chat with image bytes replaced by their size', async () => {
    const { chat } = backend([() => text('ok')]);
    await chat.message({ prompt: 'look', images: [{ bytes: PNG, ext: 'png' }] });

    const header = capturedRequests().find((h) => h.label === 'openrouter-chat');
    const body = capturedRequest(header!.seq) ?? '';
    expect(body).not.toContain('base64,');
    expect(body).not.toContain('a-key');
    expect(body).toMatch(/\d+ bytes/);
  });

  it('records nothing with record: false', async () => {
    const { chat } = backend([() => text('ok')], CLAUDE, { record: false });
    await chat.message({ prompt: 'hi' });
    expect(capturedRequests()).toEqual([]);
  });

  it('retries a 429 honouring retry-after, and says it was transient when it gives up', async () => {
    const limited = () =>
      new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
    const { chat, sent } = backend([limited, () => text('ok')]);
    expect(await chat.message({ prompt: 'hi' })).toBe('ok');
    expect(sent).toHaveLength(2);

    const down = backend([limited]);
    const err = await down.chat.message({ prompt: 'hi' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryableProviderError);
    expect((err as Error).message).toContain('429 OpenRouter: slow down');
    expect(down.sent).toHaveLength(3);
  });

  it('refuses a reply with no message', async () => {
    const { chat } = backend([() => new Response('{"choices":[]}', { status: 200 })]);
    await expect(chat.message({ prompt: 'hi' })).rejects.toThrow(
      'OpenRouter returned no message (anthropic/claude-opus-4.8)',
    );
  });
});

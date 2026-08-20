import type {
  ChatBackend,
  ChatConvoReply,
  ChatConvoRequest,
  ChatTurn,
  ToolSchema,
} from '@vn/providers';
import { ProviderError } from '@vn/util';
import {
  NativeAgentBackend,
  StructuredAgentBackend,
  type AgentMessage,
  type ToolSpec,
} from '../backend.js';

const TOOLS: ToolSpec[] = [
  { name: 'read_file', description: 'Read a file.', mutating: false },
  { name: 'write_file', description: 'Write a file.', mutating: true, defer: true },
];

const MESSAGES: AgentMessage[] = [{ role: 'user', content: 'Show me the script.' }];

type Recorded = { req: ChatConvoRequest; tools: ToolSchema[] };

/** A ChatBackend whose conversation path replays a scripted reply and records its inputs. */
function convoChat(
  reply: Omit<ChatConvoReply, 'raw'> & { raw?: unknown[] },
): ChatBackend & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    modelId: 'mock-native',
    calls,
    message: () => Promise.reject(new Error('message() should not be called on the native path')),
    chatConversation: (req, tools) => {
      calls.push({ req, tools });
      return Promise.resolve({ raw: [], ...reply });
    },
  };
}

describe('NativeAgentBackend', () => {
  it('throws if the chat backend cannot hold a conversation', () => {
    // `chatWithTools` alone is not enough: it is single-shot, so it caches nothing.
    const plain: ChatBackend = {
      modelId: 'plain',
      message: () => Promise.resolve(''),
      chatWithTools: () => Promise.resolve({ toolCalls: [] }),
    };
    expect(() => new NativeAgentBackend(plain)).toThrow(/native tool-calling/);
  });

  it('returns every tool call the model asked for, and advertises deferral', async () => {
    const chat = convoChat({
      text: 'reading',
      toolCalls: [
        { id: 't1', name: 'read_file', args: { path: 'a' } },
        { id: 't2', name: 'read_file', args: { path: 'b' } },
      ],
    });
    const turn = await new NativeAgentBackend(chat).next('sys', MESSAGES, TOOLS);

    expect(turn.actions).toEqual([
      { tool: 'read_file', args: { path: 'a' }, id: 't1' },
      { tool: 'read_file', args: { path: 'b' }, id: 't2' },
    ]);
    expect(turn.message).toBe('reading');
    expect(turn.final).toBeUndefined();
    // Every tool is advertised with a permissive object schema (the loop re-validates args),
    // and `defer` rides through untouched for the provider's own tool search.
    const { tools } = chat.calls[0]!;
    expect(tools.map((t) => t.name)).toEqual(['read_file', 'write_file']);
    expect(tools[0]!.defer).toBeUndefined();
    expect(tools[1]!.defer).toBe(true);
    expect(tools[1]!.parameters).toEqual({ type: 'object', additionalProperties: true });
  });

  it('treats a text-only reply as a final message and keeps the blocks it came in', async () => {
    const raw = [{ type: 'thinking', thinking: '…', signature: 'sig' }, { type: 'text' }];
    const chat = convoChat({ text: 'all done', toolCalls: [], raw });
    const turn = await new NativeAgentBackend(chat).next('sys', MESSAGES, TOOLS);
    expect(turn.final).toBe('all done');
    expect(turn.actions).toBeUndefined();
    expect(turn.raw).toBe(raw);
  });

  it('answers a call by quoting its id, and a host note as prose', async () => {
    const chat = convoChat({ text: 'ok', toolCalls: [] });
    const messages: AgentMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'context', content: 'scene s1 is open' },
      { role: 'system', content: 'MODE: plan' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1' }] },
      { role: 'observation', content: 'file contents', toolUseId: 't1' },
      { role: 'observation', content: 'the author cancelled' },
    ];
    await new NativeAgentBackend(chat).next('sys', messages, TOOLS);

    const turns = chat.calls[0]!.req.turns;
    expect(chat.calls[0]!.req.system).toBe('sys');
    expect(turns.map((t) => t.role)).toEqual([
      'user',
      'user',
      'system',
      'assistant',
      'user',
      'user',
    ]);
    expect(turns[1]!.content).toBe('CONTEXT: scene s1 is open');
    expect(turns[4]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'file contents' },
    ]);
    expect(turns[5]!.content).toBe('OBSERVATION: the author cancelled');
  });

  it('rolls two breakpoints: the tail writes, the previous tail reads', async () => {
    const chat = convoChat({ text: 'ok', toolCalls: [] });
    const backend = new NativeAgentBackend(chat);
    const marked = (call: Recorded): number[] =>
      call.req.turns.flatMap((t: ChatTurn, i: number) => (t.cache ? [i] : []));

    const first: AgentMessage[] = [{ role: 'user', content: 'one' }];
    await backend.next('sys', first, TOOLS);
    expect(marked(chat.calls[0]!)).toEqual([0]);

    const second: AgentMessage[] = [
      ...first,
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'two' },
    ];
    await backend.next('sys', second, TOOLS);
    expect(marked(chat.calls[1]!)).toEqual([0, 2]);

    // The conversation was cleared: there is no prefix left to read from, only one to write.
    await backend.next('sys', first, TOOLS);
    expect(marked(chat.calls[2]!)).toEqual([0]);
  });
});

describe('StructuredAgentBackend', () => {
  it('parses a JSON tool action from the text seam', async () => {
    const chat: ChatBackend = {
      modelId: 'mock-text',
      message: () => Promise.resolve('{"thought":"look","tool":"read_file","args":{"path":"a"}}'),
    };
    const turn = await new StructuredAgentBackend(chat).next('sys', MESSAGES, TOOLS);
    expect(turn.actions).toEqual([{ tool: 'read_file', args: { path: 'a' } }]);
    expect(turn.message).toBe('look');
  });

  it('renders every tool, deferred or not — there is nothing here to search', async () => {
    let seen = '';
    const chat: ChatBackend = {
      modelId: 'mock-text',
      message: (req) => {
        seen = req.prompt;
        return Promise.resolve('{"final":"done"}');
      },
    };
    await new StructuredAgentBackend(chat).next('sys', MESSAGES, TOOLS);
    expect(seen).toContain('read_file');
    expect(seen).toContain('write_file');
  });

  it('degrades to a final message when the model never emits valid JSON', async () => {
    const chat: ChatBackend = { modelId: 'mock-text', message: () => Promise.resolve('not json') };
    const turn = await new StructuredAgentBackend(chat, { attempts: 1 }).next(
      'sys',
      MESSAGES,
      TOOLS,
    );
    expect(turn.final).toBeDefined();
    expect(turn.actions).toBeUndefined();
  });

  it('keeps a prose answer rather than throwing it away for the envelope', async () => {
    const answered = 'Ember takes the west road because the bridge is out.';
    const chat: ChatBackend = { modelId: 'mock-text', message: () => Promise.resolve(answered) };
    const turn = await new StructuredAgentBackend(chat, { attempts: 1 }).next(
      'sys',
      MESSAGES,
      TOOLS,
    );
    expect(turn.final).toBe(answered);
  });

  it('still says so when the unparseable output was reaching for a tool', async () => {
    const chat: ChatBackend = {
      modelId: 'mock-text',
      message: () => Promise.resolve('{"tool": "read_file", "args": {'),
    };
    const turn = await new StructuredAgentBackend(chat, { attempts: 1 }).next(
      'sys',
      MESSAGES,
      TOOLS,
    );
    expect(turn.final).toContain("couldn't produce a valid action");
  });

  it('rethrows an API refusal rather than folding it into an answer', async () => {
    // Three attempts at an unchanged body buy three identical refusals, and a `final` here would
    // hand the author an API fault with `ok: true` on it and no card to diagnose from.
    let calls = 0;
    const chat: ChatBackend = {
      modelId: 'mock-text',
      message: () => {
        calls++;
        return Promise.reject(new ProviderError('Claude request failed: messages.1: bad'));
      },
    };
    await expect(new StructuredAgentBackend(chat).next('sys', MESSAGES, TOOLS)).rejects.toThrow(
      /messages\.1/,
    );
    expect(calls).toBe(1);
  });

  it('tells the second attempt what was wrong with the first', async () => {
    const prompts: string[] = [];
    const chat: ChatBackend = {
      modelId: 'mock-text',
      message: (req) => {
        prompts.push(req.prompt);
        return Promise.resolve(prompts.length === 1 ? 'not json' : '{"final":"ok"}');
      },
    };
    const turn = await new StructuredAgentBackend(chat).next('sys', MESSAGES, TOOLS);
    expect(turn.final).toBe('ok');
    expect(prompts[0]).not.toContain('was not a single JSON object');
    expect(prompts[1]).toContain('was not a single JSON object');
  });
});

/**
 * What a step cost. The number is shown to the author as a running total, and it counts API calls
 * rather than turns: a step the model fumbled twice was paid for three times, and a total that
 * left the fumbles out would understate the bill.
 */
describe('the receipt', () => {
  /** A text backend that reports usage, replaying one answer per call. */
  function usageChat(answers: string[]): ChatBackend {
    let i = 0;
    return {
      modelId: 'mock-usage',
      message: () => Promise.reject(new Error('the usage path should be preferred')),
      messageWithUsage: () => {
        const text = answers[Math.min(i++, answers.length - 1)]!;
        return Promise.resolve({ text, usage: { input: 10, output: 3 } });
      },
    };
  }

  it('is absent when the backend does not keep one', async () => {
    const chat: ChatBackend = {
      modelId: 'mock-text',
      message: () => Promise.resolve('{"final":"done"}'),
    };
    const turn = await new StructuredAgentBackend(chat).next('sys', MESSAGES, TOOLS);
    expect(turn.usage).toBeUndefined();
  });

  it('rides out on the turn that finally parsed, summed over every attempt', async () => {
    const good = '{"thought":"look","tool":"read_file","args":{}}';
    const turn = await new StructuredAgentBackend(usageChat(['nope', 'still nope', good])).next(
      'sys',
      MESSAGES,
      TOOLS,
    );
    expect(turn.actions).toBeDefined();
    expect(turn.usage).toEqual({ input: 30, output: 9 });
  });

  it('is still reported by the turn that gave up', async () => {
    const turn = await new StructuredAgentBackend(usageChat(['not json']), { attempts: 2 }).next(
      'sys',
      MESSAGES,
      TOOLS,
    );
    expect(turn.final).toBeDefined();
    expect(turn.usage).toEqual({ input: 20, output: 6 });
  });

  it('carries the cache split through the native path', async () => {
    const chat = convoChat({
      text: 'all done',
      toolCalls: [],
      usage: { input: 120, output: 40, cacheRead: 100, cacheWrite: 0 },
    });
    const turn = await new NativeAgentBackend(chat).next('sys', MESSAGES, TOOLS);
    expect(turn.usage).toEqual({ input: 120, output: 40, cacheRead: 100, cacheWrite: 0 });
  });
});

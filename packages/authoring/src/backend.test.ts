import type { ChatBackend, ChatToolReply, ToolSchema } from '@vn/providers';
import {
  NativeAgentBackend,
  StructuredAgentBackend,
  type AgentMessage,
  type ToolSpec,
} from './backend.js';

const TOOLS: ToolSpec[] = [
  { name: 'read_file', description: 'Read a file.', mutating: false },
  { name: 'write_file', description: 'Write a file.', mutating: true },
];

const MESSAGES: AgentMessage[] = [{ role: 'user', content: 'Show me the script.' }];

/** A ChatBackend whose native tool path replays a scripted reply and records its inputs. */
function toolChat(reply: ChatToolReply): ChatBackend & { calls: { tools: ToolSchema[] }[] } {
  const calls: { tools: ToolSchema[] }[] = [];
  return {
    modelId: 'mock-native',
    calls,
    message: () => Promise.reject(new Error('message() should not be called on the native path')),
    chatWithTools: (_req, tools) => {
      calls.push({ tools });
      return Promise.resolve(reply);
    },
  };
}

describe('NativeAgentBackend', () => {
  it('throws if the chat backend lacks native tool-calling', () => {
    const plain: ChatBackend = { modelId: 'plain', message: () => Promise.resolve('') };
    expect(() => new NativeAgentBackend(plain)).toThrow(/native tool-calling/);
  });

  it('maps the first tool call to an action and advertises permissive params', async () => {
    const chat = toolChat({
      text: 'reading',
      toolCalls: [{ name: 'read_file', args: { path: 'a' } }],
    });
    const backend = new NativeAgentBackend(chat);
    const turn = await backend.next('sys', MESSAGES, TOOLS, 'plan');

    expect(turn.action).toEqual({ tool: 'read_file', args: { path: 'a' } });
    expect(turn.message).toBe('reading');
    expect(turn.final).toBeUndefined();
    // Every tool is advertised with a permissive object schema (the loop re-validates args).
    expect(chat.calls[0]!.tools.map((t) => t.name)).toEqual(['read_file', 'write_file']);
    expect(chat.calls[0]!.tools[1]!.parameters).toEqual({
      type: 'object',
      additionalProperties: true,
    });
  });

  it('treats a text-only reply as a final message', async () => {
    const chat = toolChat({ text: 'all done', toolCalls: [] });
    const backend = new NativeAgentBackend(chat);
    const turn = await backend.next('sys', MESSAGES, TOOLS, 'execute');
    expect(turn.final).toBe('all done');
    expect(turn.action).toBeUndefined();
  });
});

describe('StructuredAgentBackend', () => {
  it('parses a JSON tool action from the text seam', async () => {
    const chat: ChatBackend = {
      modelId: 'mock-text',
      message: () => Promise.resolve('{"thought":"look","tool":"read_file","args":{"path":"a"}}'),
    };
    const turn = await new StructuredAgentBackend(chat).next('sys', MESSAGES, TOOLS, 'plan');
    expect(turn.action).toEqual({ tool: 'read_file', args: { path: 'a' } });
    expect(turn.message).toBe('look');
  });

  it('degrades to a final message when the model never emits valid JSON', async () => {
    const chat: ChatBackend = { modelId: 'mock-text', message: () => Promise.resolve('not json') };
    const turn = await new StructuredAgentBackend(chat, { attempts: 1 }).next(
      'sys',
      MESSAGES,
      TOOLS,
      'plan',
    );
    expect(turn.final).toBeDefined();
    expect(turn.action).toBeUndefined();
  });
});

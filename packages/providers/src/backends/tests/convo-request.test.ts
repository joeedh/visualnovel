/**
 * What this file checks is *where the breakpoints land*, and nothing else — a cache hit cannot be
 * observed without a key and a bill, so `scripts/verify-prompt-cache.mjs` is where that is proved.
 * Here the claim is narrower and testable: the request body says what
 * `docs/plans/prompt-caching-and-deferred-tool-loading.md` says it says.
 */
import type { ChatTurn, ToolSchema } from '../../backend.js';
import { buildConvoRequest } from '../convo-request.js';

/** A model with the `system` role, and one without — the two branches every test picks between. */
const WITH_SYSTEM = 'claude-opus-5';
const WITHOUT_SYSTEM = 'claude-sonnet-5';

const TOOLS: ToolSchema[] = [
  { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
  { name: 'search', description: 'Search.', parameters: { type: 'object' } },
  { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' }, defer: true },
];

type Block = { type?: string; cache_control?: unknown; [k: string]: unknown };
type Message = { role: string; content: Block[] };

const messages = (body: Record<string, unknown>): Message[] => body.messages as Message[];
const tools = (body: Record<string, unknown>): Block[] => (body.tools ?? []) as Block[];

/** Which message indices carry a breakpoint, and on which block of each. */
function breakpoints(body: Record<string, unknown>): [number, number][] {
  const out: [number, number][] = [];
  messages(body).forEach((m, i) =>
    m.content.forEach((b, j) => {
      if (b.cache_control) out.push([i, j]);
    }),
  );
  return out;
}

describe('the cached prefix', () => {
  it('breaks at the end of the tool catalog and the end of the system prompt', () => {
    const body = buildConvoRequest(WITH_SYSTEM, { system: 'rules', turns: [] }, TOOLS);
    expect(body.system).toEqual([
      { type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } },
    ]);
    // The last *non-deferred* tool, which is `search` — the deferred one after it may not carry one.
    const marked = tools(body).filter((t) => t.cache_control);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.name).toBe('search');
  });

  it('omits both when there is nothing to cache', () => {
    const body = buildConvoRequest(WITH_SYSTEM, { system: '', turns: [] }, []);
    expect(body.system).toBeUndefined();
    expect(body.tools).toBeUndefined();
  });

  it('never puts a breakpoint on a thinking block', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'thinking', thinking: '…', signature: 'sig' },
        ],
        cache: true,
      },
    ];
    const body = buildConvoRequest(WITH_SYSTEM, { system: 's', turns }, []);
    // It walks back past the thinking block to the text one rather than skipping the turn.
    expect(breakpoints(body)).toEqual([[1, 0]]);
  });

  it('leaves the caller’s own blocks unmarked, so the next step echoes the same bytes', () => {
    const blocks = [{ type: 'text', text: 'ok' }];
    const turns: ChatTurn[] = [{ role: 'assistant', content: blocks, cache: true }];
    buildConvoRequest(WITH_SYSTEM, { system: 's', turns }, []);
    expect(blocks).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('keeps only the newest two message breakpoints, so four is never exceeded', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'one', cache: true },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'two', cache: true },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'three', cache: true },
    ];
    const body = buildConvoRequest(WITH_SYSTEM, { system: 's', turns }, TOOLS);
    expect(breakpoints(body)).toEqual([
      [2, 0],
      [4, 0],
    ]);
    const total =
      breakpoints(body).length +
      tools(body).filter((t) => t.cache_control).length +
      (body.system ? 1 : 0);
    expect(total).toBeLessThanOrEqual(4);
  });
});

describe('deferred tools', () => {
  it('sends every definition, flags the deferred ones and prepends the search tool', () => {
    const body = buildConvoRequest(WITH_SYSTEM, { system: 's', turns: [] }, TOOLS);
    expect(tools(body).map((t) => t.name)).toEqual([
      'tool_search_tool_bm25',
      'read_file',
      'search',
      'write_file',
    ]);
    expect(tools(body)[0]!.type).toBe('tool_search_tool_bm25_20251119');
    expect(tools(body)[3]!.defer_loading).toBe(true);
    expect(tools(body)[3]!.cache_control).toBeUndefined();
    expect(tools(body)[1]!.defer_loading).toBeUndefined();
  });

  it('leaves the search tool out when nothing defers', () => {
    const loaded = TOOLS.filter((t) => !t.defer);
    const body = buildConvoRequest(WITH_SYSTEM, { system: 's', turns: [] }, loaded);
    expect(tools(body).map((t) => t.name)).toEqual(['read_file', 'search']);
    expect(tools(body)[1]!.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('the transcript', () => {
  it('echoes an assistant turn’s blocks back byte-identically', () => {
    const blocks = [
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
      { type: 'text', text: 'reading' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } },
    ];
    const turns: ChatTurn[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: blocks },
    ];
    const body = buildConvoRequest(WITH_SYSTEM, { system: 's', turns }, []);
    expect(messages(body)[1]!.content).toEqual(blocks);
  });

  it('keeps a system turn where the model has the role', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'go' },
      { role: 'system', content: 'MODE: execute' },
    ];
    const body = buildConvoRequest(WITH_SYSTEM, { system: 's', turns }, []);
    expect(messages(body).map((m) => m.role)).toEqual(['user', 'system']);
  });

  it('down-renders it to a user turn for a model without the role', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'go' },
      { role: 'system', content: 'MODE: execute' },
    ];
    const body = buildConvoRequest(WITHOUT_SYSTEM, { system: 's', turns }, []);
    // Down-rendered and then merged into the user turn it follows: one message, both blocks.
    expect(messages(body)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'go' },
          { type: 'text', text: 'MODE: execute' },
        ],
      },
    ]);
  });
});

/**
 * This file checks where the breakpoints land and nothing else. A cache hit cannot be observed
 * without a key and a bill, so `scripts/verify-prompt-cache.mjs` is where that is proved.
 * The claim here is narrower and testable: the request body says what
 * `docs/plans/archive/INDEX.md#prompt-caching-and-deferred-tool-loading` says it says.
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

/** The id the API gives a server-side tool call. The pairing rule keys off its prefix. */
const SRV = 'srvtoolu_01BQ5mmxtZsuMrBwkBkZ7k3W';

/**
 * One assistant reply that reached for a deferred tool: the blocks Anthropic returns, in the order
 * it returns them. Echoed back on the next step, which is the round trip these tests are about.
 */
const SEARCHED: Block[] = [
  { type: 'thinking', thinking: 'which tool approves art?', signature: 'sig' },
  { type: 'server_tool_use', id: SRV, name: 'tool_search_tool_bm25', input: { query: 'approve' } },
  {
    type: 'tool_search_tool_result',
    tool_use_id: SRV,
    content: [{ type: 'tool_reference', name: 'approve_assets' }],
  },
  { type: 'tool_use', id: 'toolu_1', name: 'approve_assets', input: {} },
];

/**
 * The rule the API states as an error rather than as prose: every `tool_search_tool_result` pairs
 * with a `server_tool_use` of the same id earlier in the same message, and no `tool_result` is
 * ever returned for a `srvtoolu_` id
 * (`docs/plans/archive/INDEX.md#prompt-caching-and-deferred-tool-loading:386`).
 *
 * Checked over the whole body rather than over the turn under test, because a pair is broken by
 * something beside it: a turn that merged into it, or a marker that landed between the two blocks.
 */
function expectPairedServerTools(body: Record<string, unknown>): void {
  for (const message of messages(body)) {
    const opened: string[] = [];
    for (const block of message.content) {
      if (block.type === 'server_tool_use') opened.push(String(block.id));
      if (block.type === 'tool_search_tool_result') {
        expect(opened).toContain(String(block.tool_use_id));
      }
      if (block.type === 'tool_result') {
        expect(String(block.tool_use_id)).not.toMatch(/^srvtoolu_/);
      }
    }
  }
}

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
    // The last non-deferred tool is `search`; the deferred one after it may not carry a breakpoint
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

/**
 * A deferred tool costs a round trip: the model searches, the API answers inline, and the whole
 * exchange has to come back on the next step intact. The API validates it positionally, so a
 * broken pair is a 400 naming a message and a block index, and the transcript is re-sent every
 * step, so one break repeats forever.
 */
describe('a tool search echoed back', () => {
  /** The step after the search: the reply, then the answer to the one call it actually made. */
  const roundTrip = (): ChatTurn[] => [
    { role: 'user', content: 'approve the art' },
    { role: 'assistant', content: SEARCHED },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] },
  ];

  it('keeps the result paired with the call that made it, and answers only the real call', () => {
    const body = buildConvoRequest(WITH_SYSTEM, { system: 's', turns: roundTrip() }, TOOLS);
    expectPairedServerTools(body);
    // Pairing is not enough; the blocks have to come back identical. Re-rendering one changes
    // its bytes, and the search result is the one block nothing on our side can reconstruct
    expect(messages(body)[1]!.content).toEqual(SEARCHED);
    expect(messages(body).map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('leaves the caller’s blocks unmarked, so the next step echoes the same pair', () => {
    const blocks = SEARCHED.map((b) => ({ ...b }));
    const turns: ChatTurn[] = [
      { role: 'user', content: 'approve the art' },
      { role: 'assistant', content: blocks, cache: true },
    ];
    const body = buildConvoRequest(WITH_SYSTEM, { system: 's', turns }, TOOLS);
    // The marker goes on the last block, which is past the pair, and the pair still reads.
    expect(breakpoints(body)).toEqual([[1, 3]]);
    expectPairedServerTools(body);
    // And the array the loop holds is the array it will send again next step.
    expect(blocks).toEqual(SEARCHED);
  });

  it('survives the assistant turn it is in being merged with the next one', () => {
    // Two assistant turns in a row is not hypothetical: a turn that runs out of budget files its
    // own sentence as an assistant message straight after the reply that spent the last of it.
    const turns: ChatTurn[] = [
      { role: 'user', content: 'approve the art' },
      { role: 'assistant', content: SEARCHED },
      { role: 'assistant', content: 'Out of budget for this turn.' },
    ];
    const body = buildConvoRequest(WITH_SYSTEM, { system: 's', turns }, TOOLS);
    expect(messages(body)).toHaveLength(2);
    expect(messages(body)[1]!.content).toEqual([
      ...SEARCHED,
      { type: 'text', text: 'Out of budget for this turn.' },
    ]);
    expectPairedServerTools(body);
  });

  it('survives a system turn beside it, whichever way the model takes one', () => {
    const withSystem: ChatTurn[] = [...roundTrip(), { role: 'system', content: 'BUDGET: 9,000' }];
    for (const model of [WITH_SYSTEM, WITHOUT_SYSTEM]) {
      const body = buildConvoRequest(model, { system: 's', turns: withSystem }, TOOLS);
      // Down-rendered and merged for one model, a message of its own for the other. In both
      // cases it stays outside the assistant turn holding the pair.
      expect(messages(body)[1]!.content).toEqual(SEARCHED);
      expectPairedServerTools(body);
    }
  });
});

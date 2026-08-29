/**
 * The cached, conversation-shaped Anthropic request body
 * (`docs/plans/archive/INDEX.md#prompt-caching-and-deferred-tool-loading`, workstreams B and E).
 *
 * Pure, and separate from the backend, because what the plan claims about caching is a claim about
 * where the breakpoints land, which is what a test can check without a key. Caching is a prefix
 * match over `tools` → `system` → `messages`, so a single changed byte invalidates everything
 * after it.
 */
import { supportsSystemRole } from '@vn/types';
import type { ChatConvoRequest, ChatTurn, ToolSchema } from '../backend.js';

/** The vendor's cache marker. Default TTL (5 minutes): an agent's steps are seconds apart. */
const EPHEMERAL = { type: 'ephemeral' } as const;

/**
 * How long an {@link EPHEMERAL} marker lasts, in milliseconds. The one place to change if the
 * marker's TTL is ever set explicitly; the Anthropic backend declares it as its `cacheTtlMs`.
 */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** The server-side BM25 tool search, which is what makes `defer_loading` safe for the cache. */
const SEARCH_TOOL = {
  type: 'tool_search_tool_bm25_20251119',
  name: 'tool_search_tool_bm25',
} as const;

/** At most four breakpoints per request, and `tools` + `system` have already taken two. */
const MESSAGE_BREAKPOINTS = 2;

/** Blocks a `cache_control` marker may not sit on: thinking can only be echoed, never altered. */
const UNMARKABLE = new Set(['thinking', 'redacted_thinking']);

/** A message as the Messages API wants it. Untyped content — the blocks are the vendor's. */
interface WireMessage {
  role: 'user' | 'assistant' | 'system';
  content: unknown[];
}

/** A turn's content as blocks, without touching what the caller handed over. */
function blocksOf(turn: ChatTurn): unknown[] {
  if (typeof turn.content === 'string') return [{ type: 'text', text: turn.content }];
  return [...turn.content];
}

/**
 * Put the breakpoint on the last block that may carry one. Clones rather than mutates: the
 * caller's blocks are the transcript it will echo again next step, and a marker left behind
 * would be a changed byte in a prefix that is supposed to be identical.
 */
function markLast(blocks: unknown[]): unknown[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i] as { type?: string } | null;
    if (!block || typeof block !== 'object' || UNMARKABLE.has(block.type ?? '')) continue;
    const marked = [...blocks];
    marked[i] = { ...block, cache_control: EPHEMERAL };
    return marked;
  }
  return blocks;
}

/**
 * Fold the turns into wire messages: down-render a `system` turn the model would refuse, merge
 * consecutive same-role turns (the API wants alternating roles, and a `context` turn ahead of the
 * user's is two in a row), and place at most the last two requested breakpoints.
 */
function messagesOf(turns: ChatTurn[], modelId: string): WireMessage[] {
  const system = supportsSystemRole(modelId);
  // Keep only the newest two marks, so tools + system + these stay inside the cap of four.
  const marked = new Set(
    turns
      .map((t, i) => (t.cache ? i : -1))
      .filter((i) => i >= 0)
      .slice(-MESSAGE_BREAKPOINTS),
  );

  const out: WireMessage[] = [];
  turns.forEach((turn, i) => {
    const role = turn.role === 'system' && !system ? 'user' : turn.role;
    let blocks = blocksOf(turn);
    if (marked.has(i)) blocks = markLast(blocks);
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  });
  return out;
}

/**
 * The tools block. Every definition is sent whatever its `defer` flag says — the API needs them
 * server-side to run the search — and the breakpoint goes on the last tool that is not deferred,
 * because a deferred tool carrying `cache_control` gets a 400.
 */
function toolsOf(tools: ToolSchema[]): unknown[] {
  const anyDeferred = tools.some((t) => t.defer);
  let lastLoaded = -1;
  tools.forEach((t, i) => {
    if (!t.defer) lastLoaded = i;
  });
  const body = tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
    ...(t.defer ? { defer_loading: true } : {}),
    ...(i === lastLoaded ? { cache_control: EPHEMERAL } : {}),
  }));
  return anyDeferred ? [SEARCH_TOOL, ...body] : body;
}

/**
 * Build the request body for one conversation step.
 *
 * Four breakpoints, which is the maximum: the end of the tool catalog, the end of the system
 * prompt, and the rolling pair the caller marked in `turns`. The separate `tools` breakpoint makes
 * an `AICONTEXT.md` edit a partial cache hit rather than a total miss.
 */
export function buildConvoRequest(
  modelId: string,
  req: ChatConvoRequest,
  tools: ToolSchema[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: modelId,
    messages: messagesOf(req.turns, modelId),
    ...extra,
  };
  if (req.system) {
    body.system = [{ type: 'text', text: req.system, cache_control: EPHEMERAL }];
  }
  if (tools.length) body.tools = toolsOf(tools);
  return body;
}

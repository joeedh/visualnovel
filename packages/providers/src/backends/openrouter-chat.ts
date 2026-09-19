/**
 * OpenRouter's Chat Completions endpoint as a `ChatBackend`, carrying a model whose own key is
 * absent (`docs/plans/openrouter-as-a-fallback-transport.md`). The model keeps its native
 * spelling above this seam: every model-level table is asked about `nativeIdFor(wireId)`, and
 * only the request body carries the OpenRouter id.
 *
 * Plain `fetch`, as the image backend, so no vendor SDK is loaded for it.
 */
import {
  DEFAULT_EFFORT,
  nativeIdFor,
  resolveEffort,
  type EffortChoice,
  type Route,
} from '@vn/types';
import { ProviderError } from '@vn/util';
import type {
  ChatBackend,
  ChatConvoReply,
  ChatConvoRequest,
  ChatReply,
  ChatRequest,
  ChatToolReply,
  ChatTurn,
  TokenUsage,
  ToolCall,
  ToolSchema,
} from '../backend.js';
import { captureRequest, type Capture } from './capture.js';
import { CACHE_TTL_MS } from './convo-request.js';
import { OpenRouterError, postOpenRouter, reference, type FetchImpl } from './openrouter-common.js';
import { callWithRetry } from './transient.js';

export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Room for the answer. Reasoning gets more because OpenRouter requires `max_tokens` above the
// budget it derives from the effort
const MAX_TOKENS = 10_000;
const MAX_TOKENS_THINKING = 16_000;

/** The cache marker, forwarded to Anthropic as is and honoured on its last placement by Gemini. */
const EPHEMERAL = { type: 'ephemeral' } as const;

/** At most four breakpoints per request, and `system` has taken one. */
const MESSAGE_BREAKPOINTS = 2;

/**
 * Whether `usage.prompt_tokens` already counts the tokens written to the cache. Stage 7 of the
 * plan settles it against a live turn; `usageOf` reads this so the answer is a one-line change.
 */
const PROMPT_INCLUDES_WRITE = true;

export interface OpenRouterChatOptions {
  effort?: EffortChoice;
  record?: boolean;
  fetchImpl?: FetchImpl;
}

type Part =
  { type: 'text'; text: string; cache_control?: typeof EPHEMERAL } | ReturnType<typeof reference>;

/** A message as Chat Completions wants it. Loosely typed on purpose: an assistant message is echoed. */
interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Part[] | null;
  tool_call_id?: string;
  [extra: string]: unknown;
}

/** The parts of a single-turn request: the images, then the prompt. */
function partsOf(req: ChatRequest): Part[] {
  return [...(req.images ?? []).map(reference), { type: 'text', text: req.prompt }];
}

/** The tool catalog. `defer` is ignored: OpenRouter has no server-side tool search. */
function toolsOf(tools: ToolSchema[]): unknown[] {
  return tools.map((t) => ({
    type    : 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * Put the breakpoint on the message. A string becomes one text part carrying the marker; a part
 * list is marked on its last text part. Clones rather than mutates, because the caller's blocks
 * are the transcript it echoes again next step. An assistant message with no text (a tool-call
 * turn) has nowhere to put one and is returned as is.
 */
function marked(message: WireMessage): WireMessage {
  if (typeof message.content === 'string') {
    return {
      ...message,
      content: [{ type: 'text', text: message.content, cache_control: EPHEMERAL }],
    };
  }
  if (!Array.isArray(message.content)) return message;
  for (let i = message.content.length - 1; i >= 0; i--) {
    const part = message.content[i]!;
    if (part.type !== 'text') continue;
    const content = [...message.content];
    content[i] = { ...part, cache_control: EPHEMERAL };
    return { ...message, content };
  }
  return message;
}

/**
 * One conversation turn as wire messages. Three shapes are read: a string, a user turn whose
 * content is Anthropic `tool_result` blocks (each becomes one `tool` message), and an assistant
 * turn that is this backend's own `raw` (one assistant message, echoed whole). A `system` turn
 * is sent with `role: user`, the same rendering the Anthropic path uses for a model without the
 * role. Anything else was recorded by another transport and is refused by name.
 */
function messagesOfTurn(turn: ChatTurn): WireMessage[] {
  if (typeof turn.content === 'string') {
    const role = turn.role === 'system' ? 'user' : turn.role;
    return [{ role, content: turn.content }];
  }
  if (turn.role === 'assistant') {
    const [message] = turn.content;
    const echo = message as WireMessage | undefined;
    if (turn.content.length === 1 && echo?.role === 'assistant') return [{ ...echo }];
    const type = (turn.content[0] as { type?: unknown } | undefined)?.type;
    throw new ProviderError(
      `an assistant turn holds a ${String(type ?? 'unknown')} block, which is not a Chat Completions message; this conversation was recorded through another transport`,
    );
  }
  const out: WireMessage[] = [];
  for (const block of turn.content) {
    const b = block as { type?: unknown; tool_use_id?: unknown; content?: unknown; text?: unknown };
    if (b.type === 'tool_result') {
      out.push({
        role        : 'tool',
        tool_call_id: String(b.tool_use_id),
        content     : typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
      });
    } else if (b.type === 'text') {
      out.push({ role: 'user', content: [{ type: 'text', text: String(b.text) }] });
    } else {
      throw new ProviderError(
        `a user turn holds a ${String(b.type ?? 'unknown')} block, which Chat Completions cannot carry; this conversation was recorded through another transport`,
      );
    }
  }
  return out;
}

/**
 * The messages of one conversation step: the system prompt with its marker, then the turns,
 * with at most the newest two requested breakpoints placed on the last message of their turn.
 */
function messagesOf(req: ChatConvoRequest): WireMessage[] {
  const keep = new Set(
    req.turns
      .map((t, i) => (t.cache ? i : -1))
      .filter((i) => i >= 0)
      .slice(-MESSAGE_BREAKPOINTS),
  );
  const out: WireMessage[] = [];
  if (req.system) {
    out.push({
      role   : 'system',
      content: [{ type: 'text', text: req.system, cache_control: EPHEMERAL }],
    });
  }
  req.turns.forEach((turn, i) => {
    const messages = messagesOfTurn(turn);
    if (keep.has(i) && messages.length > 0) {
      messages[messages.length - 1] = marked(messages[messages.length - 1]!);
    }
    out.push(...messages);
  });
  return out;
}

/** The body as the ring keeps it: image parts replaced by their size, so a page cannot evict a conversation. */
function redacted(body: Record<string, unknown>): Record<string, unknown> {
  const messages = (body.messages as WireMessage[]).map((m) => {
    if (!Array.isArray(m.content)) return m;
    return {
      ...m,
      content: m.content.map((part) =>
        part.type === 'image_url'
          ? { type: 'image_url', image_url: { url: `${part.image_url.url.length} bytes` } }
          : part,
      ),
    };
  });
  return { ...body, messages };
}

/**
 * What the response says it cost. `cached_tokens` and `cache_write_tokens` are reported inside
 * `prompt_tokens_details`; whether `prompt_tokens` already counts the write is
 * {@link PROMPT_INCLUDES_WRITE}, and the total is corrected when it does not, so `input` stays
 * everything billed as input. A missing `usage` reads as `undefined` rather than zero.
 */
function usageOf(res: unknown, estimated: boolean): TokenUsage | undefined {
  const u = (res as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u) return undefined;
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const cacheRead = typeof details.cached_tokens === 'number' ? details.cached_tokens : undefined;
  const cacheWrite =
    typeof details.cache_write_tokens === 'number' ? details.cache_write_tokens : undefined;
  const prompt = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0;
  const input = PROMPT_INCLUDES_WRITE ? prompt : prompt + (cacheWrite ?? 0);
  return {
    input,
    output: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(estimated ? { cacheEstimated: true } : {}),
  };
}

/** The assistant message of a reply, and its two projections. `arguments` arrives as a JSON string. */
function readReply(
  res: unknown,
  wireId: string,
): { text: string; toolCalls: ToolCall[]; message: WireMessage } {
  const choice = (res as { choices?: unknown[] } | null)?.choices?.[0] as
    { message?: WireMessage } | undefined;
  const message = choice?.message;
  if (!message || typeof message !== 'object') {
    throw new ProviderError(`OpenRouter returned no message (${wireId})`);
  }
  const text = typeof message.content === 'string' ? message.content : '';
  const calls = (message.tool_calls ?? []) as {
    id?: unknown;
    function?: { name?: unknown; arguments?: unknown };
  }[];
  const toolCalls = calls.map((call) => {
    const name = String(call.function?.name ?? '');
    const raw = call.function?.arguments;
    let args: unknown = {};
    if (typeof raw === 'string' && raw.trim() !== '') {
      try {
        args = JSON.parse(raw);
      } catch {
        throw new ProviderError(
          `OpenRouter returned arguments for ${name} that are not JSON: ${raw.slice(0, 200)}`,
        );
      }
    } else if (raw !== undefined && typeof raw !== 'string') {
      args = raw;
    }
    return { ...(typeof call.id === 'string' ? { id: call.id } : {}), name, args };
  });
  return { text, toolCalls, message };
}

/** Whether a refusal was OpenRouter rejecting the `reasoning.effort` the request carried. */
function refusedEffort(err: unknown, body: Record<string, unknown>): boolean {
  const reasoning = body.reasoning as { effort?: unknown } | undefined;
  return (
    err instanceof OpenRouterError &&
    err.status === 400 &&
    reasoning?.effort !== undefined &&
    /reasoning|effort|budget/i.test(err.message)
  );
}

/**
 * OpenRouter chat backend for a {@link Route} whose transport is `openrouter`. `modelId` is the
 * author's spelling; the wire id is the request's business. Every request sends
 * `provider.data_collection: 'deny'`; none asks OpenRouter to fall over to another model.
 *
 * `opts.effort` sets `reasoning.effort` for the level {@link resolveEffort} says the native model
 * honours, and `reasoning.enabled: false` for `none`. If OpenRouter refuses the level with a 400
 * naming reasoning, the request is resent once with reasoning merely enabled, and that answer is
 * kept for the life of the backend so later turns do not pay the round trip.
 */
export function createOpenRouterChat(
  apiKey: string,
  route: Route,
  opts: OpenRouterChatOptions = {},
): ChatBackend {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { wireId } = route;
  const nativeId = nativeIdFor(wireId);
  const what = `OpenRouter (${route.native ?? 'unknown vendor'}) request failed (${wireId})`;
  const estimated = route.native === 'gemini';
  let effortRefused = false;

  const tuning = (): Record<string, unknown> => {
    const choice = resolveEffort(nativeId, opts.effort ?? DEFAULT_EFFORT);
    if (!choice) return { max_tokens: MAX_TOKENS };
    if (choice === 'none') return { max_tokens: MAX_TOKENS, reasoning: { enabled: false } };
    if (effortRefused) return { max_tokens: MAX_TOKENS_THINKING, reasoning: { enabled: true } };
    return { max_tokens: MAX_TOKENS_THINKING, reasoning: { effort: choice } };
  };

  const bodyOf = (messages: WireMessage[], tools: ToolSchema[]): Record<string, unknown> => ({
    model: wireId,
    messages,
    ...(tools.length === 0 ? {} : { tools: toolsOf(tools) }),
    ...tuning(),
    provider: { data_collection: 'deny' },
  });

  // `build` is called per attempt because the tuning can change between the first send and the
  // resend that follows a refused effort; both bodies reach the ring
  const send = async (build: () => Record<string, unknown>): Promise<unknown> => {
    for (;;) {
      const body = build();
      const capture: Capture = await captureRequest('openrouter-chat', redacted(body), {
        record: opts.record,
      });
      try {
        return await callWithRetry(what, () =>
          postOpenRouter(fetchImpl, OPENROUTER_CHAT_URL, apiKey, body),
        );
      } catch (err) {
        await capture.failed(err);
        if (!effortRefused && refusedEffort(err, body)) {
          effortRefused = true;
          continue;
        }
        throw err;
      }
    }
  };

  const single = (req: ChatRequest, tools: ToolSchema[]): (() => Record<string, unknown>) => {
    return () =>
      bodyOf(
        [
          ...(req.system ? [{ role: 'system', content: req.system } satisfies WireMessage] : []),
          { role: 'user', content: partsOf(req) },
        ],
        tools,
      );
  };

  const messageWithUsage = async (req: ChatRequest): Promise<ChatReply> => {
    const res = await send(single(req, []));
    const { text } = readReply(res, wireId);
    const usage = usageOf(res, estimated);
    return usage ? { text, usage } : { text };
  };

  return {
    modelId: route.modelId,
    ...(route.native === 'anthropic'
      ? { cacheReporting: 'billed' as const, cacheTtlMs: CACHE_TTL_MS }
      : route.native === 'gemini'
        ? { cacheReporting: 'estimated' as const }
        : {}),
    message: async (req) => (await messageWithUsage(req)).text,
    messageWithUsage,
    async chatWithTools(req: ChatRequest, tools: ToolSchema[]): Promise<ChatToolReply> {
      const res = await send(single(req, tools));
      const { text, toolCalls } = readReply(res, wireId);
      return { text: text || undefined, toolCalls, usage: usageOf(res, estimated) };
    },
    async chatConversation(req: ChatConvoRequest, tools: ToolSchema[]): Promise<ChatConvoReply> {
      const messages = messagesOf(req);
      const res = await send(() => bodyOf(messages, tools));
      const { text, toolCalls, message } = readReply(res, wireId);
      // The whole message is echoed next step: `reasoning_details` must go back unmodified for
      // the model to continue reasoning across a tool call
      return { text: text || undefined, toolCalls, usage: usageOf(res, estimated), raw: [message] };
    },
  };
}

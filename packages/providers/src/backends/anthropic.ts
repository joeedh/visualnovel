import { Buffer } from 'node:buffer';
import { DEFAULT_EFFORT, resolveEffort, type EffortChoice } from '@vn/types';
import type {
  ChatBackend,
  ChatConvoReply,
  ChatConvoRequest,
  ChatReply,
  ChatRequest,
  ChatToolReply,
  TokenUsage,
  ToolSchema,
} from '../backend.js';
import { captureRequest } from './capture.js';
import { buildConvoRequest } from './convo-request.js';
import { callWithRetry } from './transient.js';

// Room for the answer. Thinking gets more because `max_tokens` caps thinking + text together.
const MAX_TOKENS = 10_000;
const MAX_TOKENS_THINKING = 16_000;

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * What the response says it cost. Cache reads and cache writes are billed input, so they are
 * input here too — and reported *beside* it as well, because a total is right for the bill and
 * useless for telling whether the cache is working. `undefined` when the field is missing rather
 * than zero, so a backend that stopped reporting shows no total instead of a plausible one that
 * never moves.
 */
function usageOf(res: any): TokenUsage | undefined {
  const u = res?.usage;
  if (!u) return undefined;
  const cacheRead = u.cache_read_input_tokens ?? undefined;
  const cacheWrite = u.cache_creation_input_tokens ?? undefined;
  const input = (u.input_tokens ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  return {
    input,
    output: u.output_tokens ?? 0,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

/** The two projections every caller wants out of an assistant reply, plus the blocks themselves. */
function readBlocks(res: any): {
  text: string;
  toolCalls: { id: string; name: string; args: unknown }[];
  blocks: any[];
} {
  const blocks = res.content ?? [];
  const text = blocks
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n');
  const toolCalls = blocks
    .filter((b: any) => b.type === 'tool_use')
    .map((b: any) => ({ id: b.id, name: b.name, args: b.input }));
  return { text, toolCalls, blocks };
}

/**
 * Claude vision/text backend (report §8). The SDK is imported lazily so the package is
 * usable (and testable) without the dependency loaded. Untyped at the SDK boundary on
 * purpose — the vendor surface changes faster than our contract.
 *
 * `opts.effort` sets the reasoning: a level adds `output_config.effort` + adaptive thinking,
 * `none` switches thinking off, and an omitted one is {@link DEFAULT_EFFORT} rather than the
 * vendor's — omitting the field runs Opus 4.7/4.8 and Sonnet 4.6 with no thinking at all.
 */
export function createAnthropicChat(
  apiKey: string,
  modelId: string,
  opts: { effort?: EffortChoice; record?: boolean } = {},
): ChatBackend {
  // Extra request fields for reasoning. `budget_tokens` is removed on current Claude models
  // (400) — the supported path is output_config.effort + adaptive thinking.
  const tuning = (): Record<string, unknown> => {
    const choice = resolveEffort(modelId, opts.effort ?? DEFAULT_EFFORT);
    if (!choice) return { max_tokens: MAX_TOKENS };
    // No `output_config` alongside: Opus 5 refuses disabled thinking above `high`, and the
    // API's own effort default is `high`, so saying nothing is the one safe pairing.
    if (choice === 'none') return { max_tokens: MAX_TOKENS, thinking: { type: 'disabled' } };
    return {
      max_tokens: MAX_TOKENS_THINKING,
      output_config: { effort: choice },
      thinking: { type: 'adaptive' },
    };
  };
  let clientPromise: Promise<any> | undefined;
  const client = async (): Promise<any> => {
    if (!clientPromise) {
      clientPromise = import('@anthropic-ai/sdk').then((mod) => {
        const Anthropic = (mod as any).default ?? mod;
        return new Anthropic({ apiKey });
      });
    }
    return clientPromise;
  };

  const messageWithUsage = async (req: ChatRequest): Promise<ChatReply> => {
    const anthropic = await client();
    const content: any[] = [];
    for (const img of req.images ?? []) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: MIME[img.ext.toLowerCase()] ?? 'image/png',
          data: Buffer.from(img.bytes).toString('base64'),
        },
      });
    }
    content.push({ type: 'text', text: req.prompt });
    const body = {
      model: modelId,
      system: req.system,
      messages: [{ role: 'user', content }],
      ...tuning(),
    };
    const capture = await captureRequest('claude', body, { record: opts.record });
    try {
      return await callWithRetry(`Claude request failed (${modelId})`, async () => {
        const res = await anthropic.messages.create(body);
        const text = (res.content ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n') as string;
        const usage = usageOf(res);
        return usage ? { text, usage } : { text };
      });
    } catch (err) {
      await capture.failed(err);
      throw err;
    }
  };

  return {
    modelId,
    // The text path is the usage path with the receipt dropped, so there is one request builder
    // and one retry policy rather than two that drift.
    message: async (req: ChatRequest) => (await messageWithUsage(req)).text,
    messageWithUsage,
    async chatWithTools(req: ChatRequest, tools: ToolSchema[]): Promise<ChatToolReply> {
      const anthropic = await client();
      const content: any[] = [];
      for (const img of req.images ?? []) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: MIME[img.ext.toLowerCase()] ?? 'image/png',
            data: Buffer.from(img.bytes).toString('base64'),
          },
        });
      }
      content.push({ type: 'text', text: req.prompt });
      const body = {
        model: modelId,
        system: req.system,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
        messages: [{ role: 'user', content }],
        ...tuning(),
      };
      const capture = await captureRequest('claude-tools', body, { record: opts.record });
      try {
        return await callWithRetry(`Claude tool request failed (${modelId})`, async () => {
          const res = await anthropic.messages.create(body);
          const { text, toolCalls } = readBlocks(res);
          return { text: text || undefined, toolCalls, usage: usageOf(res) } as ChatToolReply;
        });
      } catch (err) {
        await capture.failed(err);
        throw err;
      }
    },
    /**
     * The cached, multi-turn path. Everything about it that matters is in
     * {@link buildConvoRequest}; here it is the round trip, and `raw` — the assistant's blocks
     * exactly as received, because thinking blocks must come back complete and unmodified and
     * rebuilding one from `text` + `toolCalls` is a 400.
     */
    async chatConversation(req: ChatConvoRequest, tools: ToolSchema[]): Promise<ChatConvoReply> {
      const anthropic = await client();
      const body = buildConvoRequest(modelId, req, tools, tuning());
      // The one that matters most: its body is assembled rather than written out at the call
      // site, so a positional 400 against it cannot be read anywhere but here.
      const capture = await captureRequest('convo', body, { record: opts.record });
      try {
        return await callWithRetry(`Claude conversation failed (${modelId})`, async () => {
          const res = await anthropic.messages.create(body);
          const { text, toolCalls, blocks } = readBlocks(res);
          return { text: text || undefined, toolCalls, usage: usageOf(res), raw: blocks };
        });
      } catch (err) {
        await capture.failed(err);
        throw err;
      }
    },
  };
}

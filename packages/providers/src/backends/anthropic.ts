import { Buffer } from 'node:buffer';
import { DEFAULT_EFFORT, resolveEffort, type EffortChoice } from '@vn/types';
import type { ChatBackend, ChatRequest, ChatToolReply, ToolSchema } from '../backend.js';
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
  opts: { effort?: EffortChoice } = {},
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

  return {
    modelId,
    async message(req: ChatRequest): Promise<string> {
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
      return callWithRetry(`Claude request failed (${modelId})`, async () => {
        const res = await anthropic.messages.create({
          model: modelId,
          system: req.system,
          messages: [{ role: 'user', content }],
          ...tuning(),
        });
        return (res.content ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n') as string;
      });
    },
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
      return callWithRetry(`Claude tool request failed (${modelId})`, async () => {
        const res = await anthropic.messages.create({
          model: modelId,
          system: req.system,
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
          })),
          messages: [{ role: 'user', content }],
          ...tuning(),
        });
        const blocks = res.content ?? [];
        const text = blocks
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
        const toolCalls = blocks
          .filter((b: any) => b.type === 'tool_use')
          .map((b: any) => ({ id: b.id, name: b.name, args: b.input }));
        return { text: text || undefined, toolCalls } as ChatToolReply;
      });
    },
  };
}

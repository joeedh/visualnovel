import { Buffer } from 'node:buffer';
import { ProviderError } from '@vn/util';
import type { ChatBackend, ChatRequest, ChatToolReply, Effort, ToolSchema } from '../backend.js';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * Whether a Claude model accepts `output_config.effort`. Supported on Opus 4.5+, Sonnet 4.6,
 * and Fable/Mythos 5; it 400s on Sonnet 4.5 / Haiku 4.5 and earlier, so we omit it there.
 */
export function supportsEffort(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return /opus-4-[5-9]/.test(id) || id.includes('sonnet-4-6') || /(fable|mythos)-5/.test(id);
}

/**
 * Claude vision/text backend (report §8). The SDK is imported lazily so the package is
 * usable (and testable) without the dependency loaded. Untyped at the SDK boundary on
 * purpose — the vendor surface changes faster than our contract.
 *
 * `opts.effort` sets the reasoning effort: when the model supports it, the request adds
 * `output_config.effort` + adaptive thinking and a larger `max_tokens` so thinking has room.
 */
export function createAnthropicChat(
  apiKey: string,
  modelId: string,
  opts: { effort?: Effort } = {},
): ChatBackend {
  // Extra request fields for reasoning effort. `budget_tokens` is removed on current Claude
  // models (400) — the supported path is output_config.effort + adaptive thinking.
  const tuning = (): Record<string, unknown> => {
    if (!opts.effort || !supportsEffort(modelId)) return { max_tokens: 2048 };
    return {
      max_tokens: 16000,
      output_config: { effort: opts.effort },
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
      try {
        const res = await anthropic.messages.create({
          model: modelId,
          system: req.system,
          messages: [{ role: 'user', content }],
          ...tuning(),
        });
        return (res.content ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
      } catch (err) {
        throw new ProviderError(`Claude request failed (${modelId})`, { cause: err });
      }
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
      try {
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
        return { text: text || undefined, toolCalls };
      } catch (err) {
        throw new ProviderError(`Claude tool request failed (${modelId})`, { cause: err });
      }
    },
  };
}

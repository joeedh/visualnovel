import { Buffer } from 'node:buffer';
import { ProviderError } from '@vn/util';
import type { ChatBackend, ChatRequest } from '../backend.js';

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
 */
export function createAnthropicChat(apiKey: string, modelId: string): ChatBackend {
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
          max_tokens: 2048,
          system: req.system,
          messages: [{ role: 'user', content }],
        });
        return (res.content ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
      } catch (err) {
        throw new ProviderError(`Claude request failed (${modelId})`, { cause: err });
      }
    },
  };
}

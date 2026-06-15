import type { TextLLM } from '@vn/types';
import { retry } from '@vn/util';
import type { ChatBackend } from './backend.js';

/**
 * A `TextLLM` over any `ChatBackend` (report §8). Used for location mining, scene/shot
 * decomposition, and prompt refinement. `structured` enforces well-formed output by
 * running the caller's parser (which throws on malformed/invalid output) and retrying.
 */
export class ChatTextLLM implements TextLLM {
  constructor(private readonly backend: ChatBackend) {}

  complete(prompt: string, system?: string): Promise<string> {
    return this.backend.message({ prompt, system });
  }

  structured<T>(prompt: string, parse: (raw: string) => T, system?: string): Promise<T> {
    return retry(
      async () => {
        const raw = await this.backend.message({ prompt, system });
        return parse(raw);
      },
      { attempts: 3, baseMs: 50 },
    );
  }
}

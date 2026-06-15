import type { Providers } from '@vn/types';
import type { ProjectConfig, ResolvedKeys } from '@vn/config';
import type { ChatBackend, RefLoader } from './backend.js';
import { createAnthropicChat } from './backends/anthropic.js';
import { createGeminiChat, createGeminiImage } from './backends/gemini.js';
import { ChatTextLLM } from './text.js';
import { ChatVisionReviewer } from './review.js';
import { BackendImageProvider } from './image.js';

/** Pick the vendor for a model id and a stable reviewer label. */
function chatBackendFor(
  modelId: string,
  keys: ResolvedKeys,
): { backend: ChatBackend; label: string } {
  const id = modelId.toLowerCase();
  if (id.startsWith('claude') || id.startsWith('anthropic')) {
    return { backend: createAnthropicChat(keys.anthropic, modelId), label: 'claude' };
  }
  return { backend: createGeminiChat(keys.gemini, modelId), label: 'gemini' };
}

/**
 * Build the concrete provider bundle from project config + resolved keys (report §8).
 * Providers are swapped purely by changing model ids in `project.yaml`; nothing else in
 * the pipeline needs to know which vendor is behind an interface.
 */
export function createProviders(opts: {
  config: ProjectConfig;
  keys: ResolvedKeys;
  loadRef: RefLoader;
}): Providers {
  const { config, keys, loadRef } = opts;

  const image = new BackendImageProvider(
    createGeminiImage(keys.gemini, config.models.image),
    loadRef,
  );

  const reviewers = config.models.vision.map((modelId) => {
    const { backend, label } = chatBackendFor(modelId, keys);
    return new ChatVisionReviewer(label, backend, loadRef);
  });

  const text = new ChatTextLLM(chatBackendFor(config.models.text, keys).backend);

  return { image, reviewers, text };
}

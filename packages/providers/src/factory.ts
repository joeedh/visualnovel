import type { EffortChoice, Providers } from '@vn/types';
import type { ProjectConfig, ResolvedKeys } from '@vn/config';
import type { ChatBackend, RefLoader } from './backend.js';
import { createAnthropicChat } from './backends/anthropic.js';
import { createGeminiChat, createGeminiImage } from './backends/gemini.js';
import { ChatTextLLM } from './text.js';
import { ChatVisionReviewer } from './review.js';
import { BackendImageProvider } from './image.js';

/** Which key a chat model id needs. The one place that rule is written down. */
export function chatVendorFor(modelId: string): keyof ResolvedKeys {
  const id = modelId.toLowerCase();
  return id.startsWith('claude') || id.startsWith('anthropic') ? 'anthropic' : 'gemini';
}

/**
 * Pick the vendor for a model id and a stable reviewer label. Exported because a plain chat call
 * is not always a `Providers` bundle — `describeAsset` asks one vision model one question, and
 * building the reviewers and the image provider to get at it would be theatre.
 *
 * `effort` is per-call rather than per-project: the desktop app binds it to the conversation and
 * a difficult-agent report borrows a different one for a single analysis. Gemini has no such knob
 * and ignores it.
 */
export function chatBackendFor(
  modelId: string,
  keys: ResolvedKeys,
  effort?: EffortChoice,
): { backend: ChatBackend; label: string } {
  return chatVendorFor(modelId) === 'anthropic'
    ? { backend: createAnthropicChat(keys.anthropic, modelId, { effort }), label: 'claude' }
    : { backend: createGeminiChat(keys.gemini, modelId), label: 'gemini' };
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

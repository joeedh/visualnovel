import type { ImageParams, ImageResult, Providers } from '@vn/types';
import { sha256 } from '@vn/util';
import type { ChatBackend, ChatRequest, ImageBackend, ImageInput, RefLoader } from './backend.js';
import { ChatTextLLM } from './text.js';
import { ChatVisionReviewer } from './review.js';
import { BackendImageProvider } from './image.js';

/**
 * A scripted chat backend for tests and recorded fixtures. Each call returns the next
 * response; a function lets a fixture decide based on the request. Used to exercise the
 * structured-output retry path (e.g. malformed → valid).
 */
export class RecordedChatBackend implements ChatBackend {
  private i = 0;
  constructor(
    readonly modelId: string,
    private readonly responses: string[] | ((req: ChatRequest, call: number) => string),
  ) {}

  message(req: ChatRequest): Promise<string> {
    if (typeof this.responses === 'function') return Promise.resolve(this.responses(req, this.i++));
    const out = this.responses[Math.min(this.i, this.responses.length - 1)] ?? '';
    this.i++;
    return Promise.resolve(out);
  }
}

/** A deterministic image backend: bytes derive from the prompt so outputs are stable. */
export class StubImageBackend implements ImageBackend {
  constructor(readonly modelId = 'mock-image') {}

  private make(prompt: string, refs: ImageInput[]): ImageResult {
    const seedText = prompt + refs.map((r) => sha256(r.bytes)).join(',');
    return {
      bytes: new TextEncoder().encode(`IMG:${sha256(seedText).slice(0, 16)}`),
      ext: 'png',
      modelId: this.modelId,
    };
  }
  generate(prompt: string, refs: ImageInput[], _params: ImageParams): Promise<ImageResult> {
    return Promise.resolve(this.make(prompt, refs));
  }
  edit(
    base: ImageInput,
    prompt: string,
    refs: ImageInput[],
    _params: ImageParams,
  ): Promise<ImageResult> {
    return Promise.resolve(this.make(prompt, [base, ...refs]));
  }
}

/** A RefLoader backed by a hash→bytes map; defaults to empty bytes for unknown refs. */
export function mapRefLoader(map: Map<string, ImageInput> = new Map()): RefLoader {
  return (ref) => Promise.resolve(map.get(ref.hash) ?? { bytes: new Uint8Array(), ext: ref.ext });
}

/**
 * A complete set of mock providers for pipeline/scheduler tests: a deterministic image
 * provider, two clean reviewers (no defects), and a passthrough text LLM.
 */
export function createMockProviders(
  opts: { reviewResponses?: string[]; refLoader?: RefLoader } = {},
): Providers {
  const loadRef = opts.refLoader ?? mapRefLoader();
  const clean = '{"reviewer":"mock","defects":[]}';
  const reviewerResponses = opts.reviewResponses ?? [clean];
  return {
    image: new BackendImageProvider(new StubImageBackend(), loadRef),
    reviewers: [
      new ChatVisionReviewer(
        'gemini',
        new RecordedChatBackend('mock-gemini', reviewerResponses),
        loadRef,
      ),
      new ChatVisionReviewer(
        'claude',
        new RecordedChatBackend('mock-claude', reviewerResponses),
        loadRef,
      ),
    ],
    text: new ChatTextLLM(new RecordedChatBackend('mock-text', (req) => req.prompt)),
  };
}

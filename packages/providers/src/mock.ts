import type { ImageParams, ImageResult, Providers } from '@vn/types';
import { sha256 } from '@vn/util';
import type { ChatBackend, ChatRequest, ImageBackend, ImageInput, RefLoader } from './backend.js';
import { ChatTextLLM } from './text.js';
import { ChatVisionReviewer } from './review.js';
import { BackendImageProvider } from './image.js';
import { placeholderPng } from './placeholder.js';

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

/**
 * A deterministic image backend: bytes derive from the prompt so outputs are stable. The bytes
 * are a real (marked) placeholder PNG, so a mock run is viewable in the desktop app — see
 * `placeholder.ts` for why that does not weaken the mock-assets-in-a-real-run guard.
 */
export class StubImageBackend implements ImageBackend {
  constructor(readonly modelId = 'mock-image') {}

  private make(prompt: string, refs: ImageInput[]): ImageResult {
    const seedText = prompt + refs.map((r) => sha256(r.bytes)).join(',');
    return {
      bytes  : placeholderPng(sha256(seedText).slice(0, 16)),
      ext    : 'png',
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
  opts: {
    reviewResponses?: string[];
    /**
     * Scripted text-LLM replies, e.g. a canned shot decomposition. The default echoes the
     * prompt, which no structured schema accepts — so a pipeline test gets the deterministic
     * fallback unless it says otherwise.
     */
    textResponses?: string[];
    refLoader?: RefLoader;
    /** Replaces the stub image backend — e.g. a `CachedImageBackend` wrapping it. */
    imageBackend?: ImageBackend;
  } = {},
): Providers {
  const loadRef = opts.refLoader ?? mapRefLoader();
  const clean = '{"reviewer":"mock","defects":[]}';
  const reviewerResponses = opts.reviewResponses ?? [clean];
  return {
    image    : new BackendImageProvider(opts.imageBackend ?? new StubImageBackend(), loadRef),
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
    text: new ChatTextLLM(
      new RecordedChatBackend('mock-text', opts.textResponses ?? ((req) => req.prompt)),
    ),
  };
}

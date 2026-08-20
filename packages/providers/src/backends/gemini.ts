import { Buffer } from 'node:buffer';
import type { ImageParams, ImageResult } from '@vn/types';
import { ProviderError } from '@vn/util';
import type {
  ChatBackend,
  ChatReply,
  ChatRequest,
  ChatToolReply,
  ImageBackend,
  ImageInput,
  TokenUsage,
  ToolSchema,
} from '../backend.js';
import { isPlaceholderImage } from '../placeholder.js';
import { captureRequest } from './capture.js';
import { callWithRetry } from './transient.js';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * A lazily-constructed `@google/genai` client. Injectable because the real one arrives through
 * a dynamic `import()`, which jest's CJS runtime refuses outright — so this is the only seam a
 * test of the retry behaviour can stand a fake SDK up at.
 */
export type GeminiClient = () => Promise<any>;

function lazyClient(apiKey: string): GeminiClient {
  let clientPromise: Promise<any> | undefined;
  return () => {
    if (!clientPromise) {
      clientPromise = import('@google/genai').then((mod) => {
        const GoogleGenAI = (mod as any).GoogleGenAI ?? (mod as any).default;
        return new GoogleGenAI({ apiKey });
      });
    }
    return clientPromise;
  };
}

/** Leading magic bytes of the image formats the pipeline produces/consumes. */
const IMAGE_MAGIC: number[][] = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x52, 0x49, 0x46, 0x46], // RIFF (WebP)
];

function looksLikeImage(bytes: Uint8Array): boolean {
  return IMAGE_MAGIC.some((sig) => sig.every((b, i) => bytes[i] === b));
}

function imagePart(img: ImageInput): any {
  // A --mock asset decodes fine, so only its marker distinguishes it from generated art.
  // Reusing one as a reference would silently condition a paid run on a coloured rectangle.
  if (isPlaceholderImage(img.bytes)) {
    throw new ProviderError(
      'reference image is a --mock placeholder, not generated art. ' +
        'Regenerate the references without --mock.',
    );
  }
  // Catch other non-image bytes before the network round-trip — Gemini otherwise rejects
  // them with an opaque "Unable to process input image" 400.
  if (!looksLikeImage(img.bytes)) {
    const head = JSON.stringify(Buffer.from(img.bytes.slice(0, 8)).toString('latin1'));
    throw new ProviderError(
      `reference image is not a valid PNG/JPEG/WebP (starts with ${head}). ` +
        'Assets generated with --mock are placeholders — regenerate the references without --mock.',
    );
  }
  return {
    inlineData: {
      mimeType: MIME[img.ext.toLowerCase()] ?? 'image/png',
      data: Buffer.from(img.bytes).toString('base64'),
    },
  };
}

/** Extract the first inline image from a Gemini response into an ImageResult. */
function extractImage(res: any, modelId: string): ImageResult {
  const parts = res?.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const data = part?.inlineData?.data;
    if (data) {
      const mime: string = part.inlineData.mimeType ?? 'image/png';
      const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
      return { bytes: new Uint8Array(Buffer.from(data, 'base64')), ext, modelId };
    }
  }
  throw new ProviderError(`Gemini returned no image (${modelId})`);
}

/**
 * What the response says it cost. Thinking is billed as output, so it is counted there;
 * `undefined` when the metadata is missing rather than zero, so a total that stopped arriving
 * reads as "not said" instead of "free".
 *
 * `cachedContentTokenCount` is already part of `promptTokenCount`, so reporting it as `cacheRead`
 * carves the split out of `input` the way the Anthropic backend does rather than double-counting
 * it. It is flagged `cacheEstimated` because the implicit cache reports a match rather than a
 * billed line, and there is no cache-write counterpart to report at all.
 */
function usageOf(res: any): TokenUsage | undefined {
  const u = res?.usageMetadata;
  if (!u) return undefined;
  const cacheRead = u.cachedContentTokenCount ?? undefined;
  return {
    input: u.promptTokenCount ?? 0,
    output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    ...(cacheRead === undefined ? {} : { cacheRead, cacheEstimated: true }),
  };
}

/** Gemini text/vision backend (report §8). */
export function createGeminiChat(
  apiKey: string,
  modelId: string,
  client: GeminiClient = lazyClient(apiKey),
  opts: { record?: boolean } = {},
): ChatBackend {
  const record = opts.record;
  const messageWithUsage = async (req: ChatRequest): Promise<ChatReply> => {
    const ai = await client();
    const parts: any[] = [...(req.images ?? []).map(imagePart), { text: req.prompt }];
    // The captured body is this one rather than the request's own strings: a positional error
    // indexes into what went over the wire, and `parts` is where the images and prompt end up
    const body = {
      model: modelId,
      contents: [{ role: 'user', parts }],
      config: req.system ? { systemInstruction: req.system } : undefined,
    };
    const capture = await captureRequest('gemini', body, { record });
    try {
      return await callWithRetry(`Gemini request failed (${modelId})`, async () => {
        const res = await ai.models.generateContent(body);
        const text = (res.text ?? '') as string;
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
    // The text path drops the usage `messageWithUsage` returns, so there is one request builder
    // and one retry policy
    message: async (req: ChatRequest) => (await messageWithUsage(req)).text,
    messageWithUsage,
    async chatWithTools(req: ChatRequest, tools: ToolSchema[]): Promise<ChatToolReply> {
      const ai = await client();
      const parts: any[] = [...(req.images ?? []).map(imagePart), { text: req.prompt }];
      const body = {
        model: modelId,
        contents: [{ role: 'user', parts }],
        config: {
          ...(req.system ? { systemInstruction: req.system } : {}),
          tools: [
            {
              functionDeclarations: tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              })),
            },
          ],
        },
      };
      const capture = await captureRequest('gemini-tools', body, { record });
      try {
        return await callWithRetry(`Gemini tool request failed (${modelId})`, async () => {
          const res = await ai.models.generateContent(body);
          const replyParts = res?.candidates?.[0]?.content?.parts ?? [];
          const text = replyParts
            .filter((p: any) => typeof p.text === 'string')
            .map((p: any) => p.text)
            .join('');
          const toolCalls = replyParts
            .filter((p: any) => p.functionCall)
            .map((p: any) => ({ name: p.functionCall.name, args: p.functionCall.args ?? {} }));
          return { text: text || undefined, toolCalls, usage: usageOf(res) } as ChatToolReply;
        });
      } catch (err) {
        await capture.failed(err);
        throw err;
      }
    },
  };
}

/** Gemini image generation/editing backend — "nano banana" (report §8). */
export function createGeminiImage(
  apiKey: string,
  modelId: string,
  client: GeminiClient = lazyClient(apiKey),
): ImageBackend {
  // Builds the request parts inside the async body so input-validation failures (see
  // `imagePart`) surface as a rejected promise rather than a synchronous throw.
  const run = async (
    images: ImageInput[],
    prompt: string,
    params: ImageParams,
  ): Promise<ImageResult> => {
    const parts = [...images.map(imagePart), { text: prompt }];
    const ai = await client();
    return callWithRetry(`Gemini image request failed (${modelId})`, async () => {
      const res = await ai.models.generateContent({
        model: modelId,
        contents: [{ role: 'user', parts }],
        config: {
          responseModalities: ['IMAGE'],
          ...(params.seed != null ? { seed: params.seed } : {}),
        },
      });
      return extractImage(res, modelId);
    });
  };
  return {
    modelId,
    generate: (prompt, refs, params) => run(refs, prompt, params),
    edit: (base, prompt, refs, params) => run([base, ...refs], prompt, params),
  };
}

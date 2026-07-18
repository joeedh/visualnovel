import { Buffer } from 'node:buffer';
import type { ImageParams, ImageResult } from '@vn/types';
import { ProviderError } from '@vn/util';
import type {
  ChatBackend,
  ChatRequest,
  ChatToolReply,
  ImageBackend,
  ImageInput,
  ToolSchema,
} from '../backend.js';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** Best-effort one-line description of an SDK/HTTP error for the wrapped message. */
function causeMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function lazyClient(apiKey: string): () => Promise<any> {
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
  // Catch placeholder/mock bytes before the network round-trip — Gemini otherwise rejects
  // them with an opaque "Unable to process input image" 400. The usual cause is a reference
  // asset generated with `--mock` (deterministic non-image bytes) reused in a real run.
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

/** Gemini text/vision backend (report §8). */
export function createGeminiChat(apiKey: string, modelId: string): ChatBackend {
  const client = lazyClient(apiKey);
  return {
    modelId,
    async message(req: ChatRequest): Promise<string> {
      const ai = await client();
      const parts: any[] = [...(req.images ?? []).map(imagePart), { text: req.prompt }];
      try {
        const res = await ai.models.generateContent({
          model: modelId,
          contents: [{ role: 'user', parts }],
          config: req.system ? { systemInstruction: req.system } : undefined,
        });
        return res.text ?? '';
      } catch (err) {
        throw new ProviderError(`Gemini request failed (${modelId}): ${causeMessage(err)}`, {
          cause: err,
        });
      }
    },
    async chatWithTools(req: ChatRequest, tools: ToolSchema[]): Promise<ChatToolReply> {
      const ai = await client();
      const parts: any[] = [...(req.images ?? []).map(imagePart), { text: req.prompt }];
      try {
        const res = await ai.models.generateContent({
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
        });
        const replyParts = res?.candidates?.[0]?.content?.parts ?? [];
        const text = replyParts
          .filter((p: any) => typeof p.text === 'string')
          .map((p: any) => p.text)
          .join('');
        const toolCalls = replyParts
          .filter((p: any) => p.functionCall)
          .map((p: any) => ({ name: p.functionCall.name, args: p.functionCall.args ?? {} }));
        return { text: text || undefined, toolCalls };
      } catch (err) {
        throw new ProviderError(`Gemini tool request failed (${modelId}): ${causeMessage(err)}`, {
          cause: err,
        });
      }
    },
  };
}

/** Gemini image generation/editing backend — "nano banana" (report §8). */
export function createGeminiImage(apiKey: string, modelId: string): ImageBackend {
  const client = lazyClient(apiKey);
  // Builds the request parts inside the async body so input-validation failures (see
  // `imagePart`) surface as a rejected promise rather than a synchronous throw.
  const run = async (
    images: ImageInput[],
    prompt: string,
    params: ImageParams,
  ): Promise<ImageResult> => {
    const parts = [...images.map(imagePart), { text: prompt }];
    const ai = await client();
    try {
      const res = await ai.models.generateContent({
        model: modelId,
        contents: [{ role: 'user', parts }],
        config: {
          responseModalities: ['IMAGE'],
          ...(params.seed != null ? { seed: params.seed } : {}),
        },
      });
      return extractImage(res, modelId);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(`Gemini image request failed (${modelId}): ${causeMessage(err)}`, {
        cause: err,
      });
    }
  };
  return {
    modelId,
    generate: (prompt, refs, params) => run(refs, prompt, params),
    edit: (base, prompt, refs, params) => run([base, ...refs], prompt, params),
  };
}

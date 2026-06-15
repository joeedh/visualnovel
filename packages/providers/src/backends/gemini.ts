import { Buffer } from 'node:buffer';
import type { ImageParams, ImageResult } from '@vn/types';
import { ProviderError } from '@vn/util';
import type { ChatBackend, ChatRequest, ImageBackend, ImageInput } from '../backend.js';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

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

function imagePart(img: ImageInput): any {
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
        throw new ProviderError(`Gemini request failed (${modelId})`, { cause: err });
      }
    },
  };
}

/** Gemini image generation/editing backend — "nano banana" (report §8). */
export function createGeminiImage(apiKey: string, modelId: string): ImageBackend {
  const client = lazyClient(apiKey);
  const run = async (parts: any[], params: ImageParams): Promise<ImageResult> => {
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
      throw new ProviderError(`Gemini image request failed (${modelId})`, { cause: err });
    }
  };
  return {
    modelId,
    generate: (prompt, refs, params) => run([...refs.map(imagePart), { text: prompt }], params),
    edit: (base, prompt, refs, params) =>
      run([imagePart(base), ...refs.map(imagePart), { text: prompt }], params),
  };
}

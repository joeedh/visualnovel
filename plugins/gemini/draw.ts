/**
 * The call this plugin makes and the byte handling either side of it. It reaches Gemini over
 * the host's recorded transport rather than through the host's image backend, which is what
 * lets a plugin add a vendor the application was not built with.
 */
import type { GenImageInput, GenImageRef, GenServices } from '@vn/gengraph/plugin';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** Leading bytes of the formats a reference picture may be in. */
const IMAGE_MAGIC: number[][] = [
  [0x89, 0x50, 0x4e, 0x47],
  [0xff, 0xd8, 0xff],
  [0x47, 0x49, 0x46, 0x38],
  [0x52, 0x49, 0x46, 0x46],
];

/** How much of a refused response is quoted back, so an error stays readable. */
const ERROR_CHARS = 400;

function looksLikeImage(bytes: Uint8Array): boolean {
  return IMAGE_MAGIC.some((magic) => magic.every((b, i) => bytes[i] === b));
}

/** The bytes behind a picture, read from whichever of the two stores holds it. */
export async function readImage(services: GenServices, ref: GenImageRef): Promise<GenImageInput> {
  const bytes =
    ref.store === 'asset'
      ? await services.assets.read({ hash: ref.hash, ext: ref.ext })
      : await services.blobs.read(ref.hash);

  if (bytes === undefined) {
    throw new Error(`the ${ref.store} store holds no bytes for '${ref.hash}'`);
  }
  return { bytes, ext: ref.ext };
}

/**
 * One reference picture as the request carries it. Bytes that are not an image are caught
 * here, because Gemini refuses them with a 400 that names neither the picture nor the reason.
 */
function imagePart(img: GenImageInput): unknown {
  if (!looksLikeImage(img.bytes)) {
    throw new Error(
      'a reference picture is not a PNG, JPEG, GIF or WebP. A picture drawn with --mock is a ' +
        'placeholder, so regenerate the references without it.',
    );
  }
  return {
    inlineData: {
      mimeType: MIME[img.ext.toLowerCase()] ?? 'image/png',
      data: Buffer.from(img.bytes).toString('base64'),
    },
  };
}

/** The first inline picture in a reply, or nothing where the reply carries none. */
function inlineImage(reply: unknown): { bytes: Uint8Array; ext: string } | undefined {
  const candidates = (reply as { candidates?: unknown[] } | null)?.candidates;
  const parts = (candidates?.[0] as { content?: { parts?: unknown[] } } | undefined)?.content
    ?.parts;

  for (const part of parts ?? []) {
    const inline = (part as { inlineData?: { data?: unknown; mimeType?: unknown } }).inlineData;
    if (typeof inline?.data !== 'string') continue;
    const mime = typeof inline.mimeType === 'string' ? inline.mimeType : 'image/png';
    const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
    return { bytes: new Uint8Array(Buffer.from(inline.data, 'base64')), ext };
  }
  return undefined;
}

export interface GeminiDraw {
  model: string;
  prompt: string;
  /** The base picture first where there is one, then the references, as Gemini expects them. */
  images: GenImageInput[];
  /** An aspect ratio such as `16:9`. Left out, the model picks one from the prompt. */
  aspect?: string;
  seed?: number;
}

/**
 * Draws one picture. The refusal quotes the vendor's own answer, which is what a 400 naming a
 * byte position has to be read against, and the key is never part of what is quoted.
 */
export async function drawWithGemini(
  services: GenServices,
  draw: GeminiDraw,
): Promise<{ bytes: Uint8Array; ext: string }> {
  const key = await services.key('gemini');
  if (key === undefined) {
    throw new Error('no gemini key is set, so this node has nothing to draw with');
  }

  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [...draw.images.map(imagePart), { text: draw.prompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      ...(draw.seed === undefined ? {} : { seed: draw.seed }),
      ...(draw.aspect === undefined ? {} : { imageConfig: { aspectRatio: draw.aspect } }),
    },
  });

  const answer = await services.fetch(`${ENDPOINT}/${draw.model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body,
  });

  const said = new TextDecoder().decode(answer.bytes);
  if (answer.status !== 200) {
    throw new Error(`Gemini answered ${answer.status}: ${said.slice(0, ERROR_CHARS)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(said);
  } catch {
    throw new Error(
      `Gemini answered with something that is not JSON: ${said.slice(0, ERROR_CHARS)}`,
    );
  }

  const picture = inlineImage(parsed);
  if (picture === undefined) {
    throw new Error(`Gemini returned no picture (${draw.model})`);
  }
  return picture;
}

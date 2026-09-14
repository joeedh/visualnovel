/**
 * The call this plugin makes and the byte handling either side of it. It reaches OpenRouter's
 * image endpoint over the host's recorded transport, which is what lets a plugin add a vendor
 * the application was not built with.
 */
import type { GenImageInput, GenImageRef, GenServices } from '@vn/gengraph/plugin';

const ENDPOINT = 'https://openrouter.ai/api/v1/images';

const MIME: Record<string, string> = {
  png : 'image/png',
  jpg : 'image/jpeg',
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
 * One reference picture as the request carries it: a data URL, which OpenRouter accepts in
 * place of a hosted one. Bytes that are not an image are caught here, because a provider
 * refuses them with an error that names neither the picture nor the reason.
 */
function reference(img: GenImageInput): unknown {
  if (!looksLikeImage(img.bytes)) {
    throw new Error(
      'a reference picture is not a PNG, JPEG, GIF or WebP. A picture drawn with --mock is a ' +
        'placeholder, so regenerate the references without it.',
    );
  }
  const mime = MIME[img.ext.toLowerCase()] ?? 'image/png';
  const data = Buffer.from(img.bytes).toString('base64');
  return { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } };
}

/** The first picture in a reply, or nothing where the reply carries none. */
function firstImage(reply: unknown): { bytes: Uint8Array; ext: string } | undefined {
  const data = (reply as { data?: unknown[] } | null)?.data;

  for (const item of data ?? []) {
    const entry = item as { b64_json?: unknown; media_type?: unknown };
    if (typeof entry.b64_json !== 'string') continue;
    const mime = typeof entry.media_type === 'string' ? entry.media_type : 'image/png';
    const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
    return { bytes: new Uint8Array(Buffer.from(entry.b64_json, 'base64')), ext };
  }
  return undefined;
}

/** What the call cost in dollars, where OpenRouter's reply says. */
function costOf(reply: unknown): number | undefined {
  const cost = (reply as { usage?: { cost?: unknown } } | null)?.usage?.cost;
  return typeof cost === 'number' ? cost : undefined;
}

export interface OpenRouterDraw {
  /** An OpenRouter model id, `<vendor>/<model>`. */
  model: string;
  prompt: string;
  images: GenImageInput[];
  /** An aspect ratio such as `16:9`. Left out, the provider picks one. */
  aspect?: string;
  seed?: number;
}

export interface Drawn {
  bytes: Uint8Array;
  ext: string;
  /** Dollars, as OpenRouter reported them. Absent where the reply carried no usage. */
  cost?: number;
}

/**
 * Draws one picture. The refusal quotes OpenRouter's own answer, which is where a provider's
 * reason for refusing a ratio or a reference arrives, and the key is never part of what is
 * quoted.
 */
export async function drawWithOpenRouter(
  services: GenServices,
  draw: OpenRouterDraw,
): Promise<Drawn> {
  const key = await services.key('openrouter');
  if (key === undefined) {
    throw new Error('no openrouter key is set, so this node has nothing to draw with');
  }

  const body = JSON.stringify({
    model : draw.model,
    prompt: draw.prompt,
    ...(draw.aspect === undefined ? {} : { aspect_ratio: draw.aspect }),
    ...(draw.seed === undefined ? {} : { seed: draw.seed }),
    ...(draw.images.length === 0 ? {} : { input_references: draw.images.map(reference) }),
    // Keeps the prompt and the picture out of any provider that trains on or logs its traffic
    provider: { data_collection: 'deny' },
  });

  const answer = await services.fetch(ENDPOINT, {
    method : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body,
  });

  const said = new TextDecoder().decode(answer.bytes);
  if (answer.status !== 200) {
    throw new Error(`OpenRouter answered ${answer.status}: ${said.slice(0, ERROR_CHARS)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(said);
  } catch {
    throw new Error(
      `OpenRouter answered with something that is not JSON: ${said.slice(0, ERROR_CHARS)}`,
    );
  }

  const picture = firstImage(parsed);
  if (picture === undefined) {
    throw new Error(`OpenRouter returned no picture (${draw.model})`);
  }
  const cost = costOf(parsed);
  return cost === undefined ? picture : { ...picture, cost };
}

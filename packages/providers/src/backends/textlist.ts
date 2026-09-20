/**
 * The text-model listings, read into the catalog the text-model pickers draw. Anthropic and
 * Gemini list their models only to a key, so each is asked only when one resolved; OpenRouter's
 * listing is public. None of the three bills anything.
 */
import {
  anthropicModelListing,
  geminiModelListing,
  openRouterModelListing,
  type TextModelEntry,
} from '@vn/types';
import { ProviderError } from '@vn/util';
import { ERROR_CHARS, type FetchImpl } from './openrouter-common.js';

export const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
export const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
export const OPENROUTER_TEXT_MODELS_URL = 'https://openrouter.ai/api/v1/models';

/** The API version header every Anthropic request carries. */
const ANTHROPIC_VERSION = '2023-06-01';

/** Gemini ids answering `generateContent` that are not chat models. */
const GEMINI_NOT_TEXT = /image|imagen|veo|embed|tts|audio|aqa/i;

export interface TextListingKeys {
  anthropic?: string;
  gemini?: string;
}

export interface TextListing {
  models: TextModelEntry[];
  /** The vendors whose listing failed, each with the reason, so one down vendor loses one list. */
  failed: { vendor: TextModelEntry['vendor']; reason: string }[];
  /** The vendors that were not asked, because no key resolved for them. */
  skipped: TextModelEntry['vendor'][];
}

async function readJson(
  fetchImpl: FetchImpl,
  url: string,
  headers: Record<string, string>,
  who: string,
): Promise<unknown> {
  const response = await fetchImpl(url, { headers: { accept: 'application/json', ...headers } });
  const said = await response.text();
  if (response.status !== 200) {
    throw new ProviderError(`${response.status} ${who}: ${said.slice(0, ERROR_CHARS)}`);
  }
  try {
    return JSON.parse(said);
  } catch {
    throw new ProviderError(
      `${who} answered with something that is not JSON: ${said.slice(0, ERROR_CHARS)}`,
    );
  }
}

/** Every page of Anthropic's listing. The key rides in the header and never in an error. */
export async function listAnthropicTextModels(
  apiKey: string,
  fetchImpl: FetchImpl = fetch,
): Promise<TextModelEntry[]> {
  const models: TextModelEntry[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = `${ANTHROPIC_MODELS_URL}?limit=1000${after ? `&after_id=${after}` : ''}`;
    const parsed = anthropicModelListing.safeParse(
      await readJson(
        fetchImpl,
        url,
        { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        'Anthropic',
      ),
    );
    if (!parsed.success) {
      throw new ProviderError(`Anthropic's model listing did not read: ${parsed.error.message}`);
    }
    for (const model of parsed.data.data) {
      models.push({ id: model.id, name: model.display_name ?? model.id, vendor: 'anthropic' });
    }
    if (!parsed.data.has_more || !parsed.data.last_id) break;
    after = parsed.data.last_id;
  }
  return models;
}

/**
 * Every page of Gemini's listing, kept to the models that answer `generateContent` and are not
 * image, video, audio or embedding models. The `models/` prefix is stripped, since that is the
 * spelling a project names.
 */
export async function listGeminiTextModels(
  apiKey: string,
  fetchImpl: FetchImpl = fetch,
): Promise<TextModelEntry[]> {
  const models: TextModelEntry[] = [];
  let token: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = `${GEMINI_MODELS_URL}?pageSize=1000${token ? `&pageToken=${token}` : ''}`;
    const parsed = geminiModelListing.safeParse(
      await readJson(fetchImpl, url, { 'x-goog-api-key': apiKey }, 'Gemini'),
    );
    if (!parsed.success) {
      throw new ProviderError(`Gemini's model listing did not read: ${parsed.error.message}`);
    }
    for (const model of parsed.data.models) {
      const id = model.name.replace(/^models\//, '');
      if (!(model.supportedGenerationMethods ?? []).includes('generateContent')) continue;
      if (GEMINI_NOT_TEXT.test(id)) continue;
      models.push({ id, name: model.displayName ?? id, vendor: 'gemini' });
    }
    if (!parsed.data.nextPageToken) break;
    token = parsed.data.nextPageToken;
  }
  return models;
}

/** OpenRouter's listing, kept to the models that take text and answer with text alone. */
export async function listOpenRouterTextModels(
  fetchImpl: FetchImpl = fetch,
): Promise<TextModelEntry[]> {
  const parsed = openRouterModelListing.safeParse(
    await readJson(fetchImpl, OPENROUTER_TEXT_MODELS_URL, {}, 'OpenRouter'),
  );
  if (!parsed.success) {
    throw new ProviderError(`OpenRouter's model listing did not read: ${parsed.error.message}`);
  }
  const models: TextModelEntry[] = [];
  for (const model of parsed.data.data) {
    const input = model.architecture?.input_modalities ?? ['text'];
    const output = model.architecture?.output_modalities ?? ['text'];
    if (!input.includes('text') || !output.includes('text') || output.includes('image')) continue;
    models.push({ id: model.id, name: model.name ?? model.id, vendor: 'openrouter' });
  }
  return models;
}

/**
 * The three listings together. A vendor with no key is skipped, one whose call fails is named in
 * `failed` with the reason, and the models of the rest are returned in vendor order; nothing here
 * throws, so a refresh still lands the image listing when a text vendor is down.
 */
export async function listTextModels(
  keys: TextListingKeys,
  fetchImpl: FetchImpl = fetch,
): Promise<TextListing> {
  const out: TextListing = { models: [], failed: [], skipped: [] };
  const ask = async (
    vendor: TextModelEntry['vendor'],
    list: (() => Promise<TextModelEntry[]>) | undefined,
  ): Promise<void> => {
    if (list === undefined) {
      out.skipped.push(vendor);
      return;
    }
    try {
      out.models.push(...(await list()));
    } catch (err) {
      out.failed.push({ vendor, reason: (err as Error).message });
    }
  };
  await ask(
    'anthropic',
    keys.anthropic ? () => listAnthropicTextModels(keys.anthropic!, fetchImpl) : undefined,
  );
  await ask(
    'gemini',
    keys.gemini ? () => listGeminiTextModels(keys.gemini!, fetchImpl) : undefined,
  );
  await ask('openrouter', () => listOpenRouterTextModels(fetchImpl));
  return out;
}

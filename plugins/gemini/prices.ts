/**
 * What this plugin answers a price refresh with. The figures come from the vendor's own
 * pricing page, read through the host's recorded transport and turned into a table by the
 * project's text model, because there is no search seam a plugin could reach instead.
 */
import type { GenPriceModels, GenServices } from '@vn/gengraph/plugin';

const PRICING_PAGE = 'https://ai.google.dev/gemini-api/docs/pricing';

/** The model id the reading is quoted against. The host runs it on its configured text model. */
const READER_MODEL = 'gemini-2.5-flash';

/** How much of the page reaches the model, which is well past where the table ends. */
const PAGE_CHARS = 60_000;

const SYSTEM =
  'You read a vendor pricing page and answer with JSON and nothing else. Answer with an ' +
  'object keyed by model id, each value an object that may hold "image" (dollars per ' +
  'generated image), "mtok-in" (dollars per million input tokens) and "mtok-out" (dollars ' +
  'per million output tokens). Price only the paid tier, omit a model whose price the page ' +
  'does not state, and never guess a figure.';

/** The model's answer as JSON, with a code fence removed where it wrapped one around it. */
function jsonOf(raw: string): GenPriceModels {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  return JSON.parse(fenced?.[1] ?? raw) as GenPriceModels;
}

/** The page as prose. Scripts and styles go first, because their contents are not text. */
function readable(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reads what Gemini charges. It refuses rather than falling back on what the model already
 * believes, because a price nobody published is worse than no price at all.
 */
export async function geminiPrices(services: GenServices): Promise<GenPriceModels> {
  const answer = await services.fetch(PRICING_PAGE);
  if (answer.status !== 200) {
    throw new Error(`the Gemini pricing page answered ${answer.status}`);
  }

  const page = readable(new TextDecoder().decode(answer.bytes)).slice(0, PAGE_CHARS);
  if (page.length === 0) {
    throw new Error('the Gemini pricing page carried no text');
  }

  return services.text.structured<GenPriceModels>(
    READER_MODEL,
    `Price every Gemini model this page states a price for.\n\n${page}`,
    jsonOf,
    SYSTEM,
  );
}

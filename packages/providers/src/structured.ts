import type { ZodType } from 'zod';
import { ProviderError, retry, StructuredOutputError } from '@vn/util';

/** What one candidate string yielded: a value, or why it did not hold one. */
type Scan =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'none' | 'unterminated' | 'invalid'; cause?: unknown };

/** Walk one candidate from its first bracket to the matching close, ignoring trailing prose. */
function scanJson(candidate: string): Scan {
  const start = candidate.search(/[[{]/);
  if (start < 0) return { ok: false, reason: 'none' };
  const text = candidate.slice(start);
  const open = text[0];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return { ok: true, value: JSON.parse(text.slice(0, i + 1)) };
        } catch (err) {
          return { ok: false, reason: 'invalid', cause: err };
        }
      }
    }
  }
  return { ok: false, reason: 'unterminated' };
}

/** A short, single-line quote of what the model said, so a failure names its own evidence. */
function preview(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (flat === '') return 'the model returned nothing';
  return `got: ${flat.length > 200 ? `${flat.slice(0, 200)}…` : flat}`;
}

/**
 * Extract a JSON object/array from a model's raw text response. Tolerates ```json
 * code fences and leading/trailing prose, since models often wrap structured output.
 *
 * The raw text is tried before the fences: a reply that is already JSON routinely quotes a
 * fenced example inside one of its own strings (a Fountain snippet, a shell line), and reaching
 * for the first fence there discards the object and finds only the example's prose.
 */
export function extractJson(raw: string): unknown {
  const fences = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1] ?? '');
  let failure: Scan & { ok: false } = { ok: false, reason: 'none' };
  for (const candidate of [raw, ...fences]) {
    const scan = scanJson(candidate);
    if (scan.ok) return scan.value;
    // A bracket that failed to parse says more than a candidate holding none at all.
    if (failure.reason === 'none') failure = scan;
  }
  if (failure.reason === 'invalid') {
    throw new StructuredOutputError(`model output was not valid JSON — ${preview(raw)}`, {
      cause: failure.cause,
    });
  }
  const what = failure.reason === 'unterminated' ? 'unterminated JSON in' : 'no JSON found in';
  throw new StructuredOutputError(`${what} model output — ${preview(raw)}`);
}

/** Parse + zod-validate a model response, throwing StructuredOutputError on mismatch. */
export function parseStructured<T>(raw: string, schema: ZodType<T>): T {
  const json = extractJson(raw);
  const result = schema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new StructuredOutputError(`model output failed schema validation: ${issues}`);
  }
  return result.data;
}

/**
 * Enforce structured output (report §8, §12): call the model, parse + validate, and
 * retry on malformed output up to `attempts` times before rejecting. The retry prompt
 * is unchanged — providers may append a corrective hint via `repair`.
 *
 * A `ProviderError` stops the loop rather than multiplying with the backend's own retry: the
 * backend has already retried what was transient, and what it did not retry is terminal.
 */
export async function withStructuredRetry<T>(
  schema: ZodType<T>,
  call: (attempt: number) => Promise<string>,
  opts: { attempts?: number } = {},
): Promise<T> {
  return retry((attempt) => call(attempt).then((raw) => parseStructured(raw, schema)), {
    attempts: opts.attempts ?? 3,
    baseMs: 50,
    shouldRetry: (err) => !(err instanceof ProviderError),
  });
}

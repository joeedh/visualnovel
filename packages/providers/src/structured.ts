import type { ZodType } from 'zod';
import { retry, StructuredOutputError } from '@vn/util';

/**
 * Extract a JSON object/array from a model's raw text response. Tolerates ```json
 * code fences and leading/trailing prose, since models often wrap structured output.
 */
export function extractJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? (fenced[1] ?? '') : raw;
  const start = candidate.search(/[[{]/);
  if (start < 0) throw new StructuredOutputError('no JSON found in model output');
  // Walk to the matching closing bracket so trailing prose is ignored.
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
          return JSON.parse(text.slice(0, i + 1));
        } catch (err) {
          throw new StructuredOutputError('model output was not valid JSON', { cause: err });
        }
      }
    }
  }
  throw new StructuredOutputError('unterminated JSON in model output');
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
 */
export async function withStructuredRetry<T>(
  schema: ZodType<T>,
  call: (attempt: number) => Promise<string>,
  opts: { attempts?: number } = {},
): Promise<T> {
  return retry((attempt) => call(attempt).then((raw) => parseStructured(raw, schema)), {
    attempts: opts.attempts ?? 3,
    baseMs: 50,
  });
}

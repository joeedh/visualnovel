/**
 * How a bulk property is recorded. A prop declared `digest` (see `props.ts`) carries a whole
 * document; the history keeps a `sha256` of it plus its byte length, never the text.
 *
 * `CommandRecord.props` is appended verbatim to `commands.jsonl`, and `invocation` is
 * `formatCommand`, which quotes and `\n`-escapes every string, so a 50 KB note would cost that
 * much again on every save and would stop `invocation` reading as the one-line repro it is sold
 * as. The bytes are already in the file and in the undo snapshot, so nothing is lost. A digested
 * invocation is not re-executable; the recovery path for a whole-file overwrite is undo, and never
 * was replaying it from a log line.
 *
 * A `secret` prop is redacted through the same seam, but to the bare word `<secret>`, because a
 * digest of a live credential would record a value that identifies it plus its exact length.
 *
 * This is a projection at record time only. The command's `run` receives the real value.
 *
 * Hashing uses Web Crypto rather than `@vn/util`'s `sha256` because `@vn/util` reaches
 * `node:crypto` and this package is in the renderer's bundle (the shared interaction rules import
 * it), so a node import anywhere in the barrel fails `vite build`. `crypto.subtle` is the same
 * algorithm in both processes, and being async is why this returns a promise.
 */
import type { PropSpecMap, PropValue } from './props.js';

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** One bulk value as it is recorded: enough to identify it, not enough to reconstruct it. */
export async function digestOf(value: PropValue): Promise<string> {
  const text = Array.isArray(value) ? value.join('\n') : String(value);
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return `<sha256:${hex(new Uint8Array(hash)).slice(0, 12)}+${bytes.length}>`;
}

/**
 * What {@link digestOf} records for a value with no bytes in it — an empty string, an empty list.
 * Named so a reader of a record can recognise one by comparison rather than by parsing the
 * sentinel; `stack.test.ts` pins it against what `digestOf` actually produces.
 */
export const EMPTY_DIGEST = '<sha256:e3b0c44298fc+0>';

/** What a `secret` prop is recorded as, whatever it held. */
export const REDACTED = '<secret>';

/**
 * Every `digest` prop replaced by {@link digestOf} and every `secret` prop by {@link REDACTED};
 * every other prop is passed through unchanged.
 */
export async function digestProps(
  specs: PropSpecMap,
  props: Record<string, PropValue>,
): Promise<Record<string, PropValue>> {
  let out: Record<string, PropValue> | undefined;
  for (const [name, spec] of Object.entries(specs)) {
    if (props[name] === undefined) continue;
    if (spec.kind === 'secret') {
      out ??= { ...props };
      out[name] = REDACTED;
    } else if (spec.digest) {
      out ??= { ...props };
      out[name] = await digestOf(props[name]!);
    }
  }
  return out ?? props;
}

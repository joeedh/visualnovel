/**
 * How a bulk property is *recorded*. A prop declared `digest` (see `props.ts`) carries a whole
 * document; the history keeps `sha256` + byte length of it and never the text.
 *
 * The reason is that `CommandRecord.props` is appended verbatim to `commands.jsonl` and
 * `invocation` is `formatCommand`, which quotes and `\n`-escapes every string — a 50 KB note
 * would cost that much again on every save, and would stop `invocation` reading as the one-line
 * repro it is sold as. The bytes are already in the file and in the undo snapshot, so nothing is
 * lost. A digested invocation is not re-executable, which is honest: replaying a whole-file
 * overwrite from a log line was never the recovery path — undo is.
 *
 * This is a projection at record time only. The command's `run` receives the real value.
 *
 * Hashing is Web Crypto rather than `@vn/util`'s `sha256`, which is the one thing here worth
 * explaining: `@vn/util` reaches `node:crypto`, and this package is in the renderer's bundle —
 * the shared interaction rules import it — so a node import anywhere in the barrel fails
 * `vite build`. `crypto.subtle` is the same algorithm in both processes, and being async is why
 * this is a promise.
 */
import type { PropSpecMap, PropValue } from './props.js';

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** One bulk value as it is recorded: enough to identify it, far too little to reconstruct it. */
export async function digestOf(value: PropValue): Promise<string> {
  const text = Array.isArray(value) ? value.join('\n') : String(value);
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return `<sha256:${hex(new Uint8Array(hash)).slice(0, 12)}+${bytes.length}>`;
}

/** Every `digest` prop replaced by {@link digestOf}; everything else is itself. */
export async function digestProps(
  specs: PropSpecMap,
  props: Record<string, PropValue>,
): Promise<Record<string, PropValue>> {
  let out: Record<string, PropValue> | undefined;
  for (const [name, spec] of Object.entries(specs)) {
    if (!spec.digest || props[name] === undefined) continue;
    out ??= { ...props };
    out[name] = await digestOf(props[name]!);
  }
  return out ?? props;
}

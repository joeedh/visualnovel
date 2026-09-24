/**
 * Rewrites the relative links in one markdown document after files have moved, so a link that
 * named a moved file names it at its new place. Pure: `FilesPart` reads and writes the bytes.
 *
 * It rewrites inline links and images (`[t](href "title")`, `![a](href)`), angle-bracket hrefs
 * (`[t](<a b.md>)`) and reference definitions (`[id]: href`). It leaves fenced code, inline code,
 * urls with a scheme, and hrefs starting with `/` or `#` as they are. Only the href itself is
 * replaced, so a title, a fragment and a query survive byte for byte.
 */
import { remapPath, type FileMove } from '../../shared/fileops.js';
import { relativePath, resolvePath } from '../../shared/docpath.js';

/** A document after {@link relink}: its text, and how many hrefs changed. */
export interface Relinked {
  text: string;
  count: number;
}

/** An opening fence: up to three spaces, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Link text, allowing one level of nested brackets and backslash escapes. */
const LABEL = String.raw`\[(?:[^\[\]\\]|\\.|\[(?:[^\[\]\\]|\\.)*\])*\]`;

/** A bare href, allowing balanced parentheses one level deep. */
const BARE = String.raw`[^\s()<>]+(?:\([^\s()]*\)[^\s()<>]*)*`;

/** An inline link or image: the text, `(`, optional spaces, the href. What follows is kept as it is. */
const INLINE = new RegExp(String.raw`(?<!\\)!?${LABEL}\(([ \t]*)(<[^<>\n]*>|${BARE})`, 'g');

/** A reference definition at the start of a line: `[id]: href`. */
const DEFINITION = new RegExp(String.raw`^( {0,3}${LABEL}:[ \t]*)(<[^<>\n]*>|\S+)`, 'gm');

/**
 * `text`, a markdown document that was at `oldPath` and is now at `newPath`, with every relative
 * href rewritten for `moves`. An href is resolved from `oldPath`, mapped through `moves`, and
 * written relative to `newPath`; one that still names the same file from where the document now
 * is stays exactly as written. An href that does not resolve inside the workspace is left alone.
 */
export function relink(
  oldPath: string,
  newPath: string,
  text: string,
  moves: readonly FileMove[],
): Relinked {
  let count = 0;
  const rewrite = (href: string): string => {
    const next = rewriteHref(oldPath, newPath, href, moves);
    if (next === href) return href;
    count++;
    return next;
  };
  const out = splitFences(text)
    .map((chunk) => (chunk.code ? chunk.text : rewriteChunk(chunk.text, rewrite)))
    .join('');
  return { text: out, count };
}

/** `text` cut into runs of fenced code and runs of everything else, in order. */
function splitFences(text: string): { text: string; code: boolean }[] {
  const lines = text.split(/(?<=\n)/);
  const out: { text: string; code: boolean }[] = [];
  let fence: string | undefined;
  let run = '';
  const flush = (code: boolean): void => {
    if (run !== '') out.push({ text: run, code });
    run = '';
  };
  for (const line of lines) {
    if (fence === undefined) {
      const open = FENCE.exec(line);
      if (open) {
        flush(false);
        fence = open[1]!;
      }
      run += line;
      continue;
    }
    run += line;
    // A closing fence is the same character, at least as long, with nothing after it
    const close = FENCE.exec(line)?.[1] ?? '';
    if (close[0] === fence[0] && close.length >= fence.length && line.trim() === close) {
      fence = undefined;
      flush(true);
    }
  }
  flush(fence !== undefined);
  return out;
}

/**
 * `text` with its inline code spans blanked to the same length, so a link inside one cannot match
 * and every other offset stays where it was. A run of backticks with no closing run of the same
 * length is literal text.
 */
function maskCode(text: string): string {
  const runs = [...text.matchAll(/`+/g)];
  let masked = text;
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i]!;
    const close = runs.findIndex((r, j) => j > i && r[0].length === open[0].length);
    if (close < 0) continue;
    const from = open.index;
    const to = runs[close]!.index + runs[close]![0].length;
    masked = masked.slice(0, from) + '\u0001'.repeat(to - from) + masked.slice(to);
    i = close;
  }
  return masked;
}

/** One chunk outside fenced code, with every link's href passed through `rewrite`. */
function rewriteChunk(text: string, rewrite: (href: string) => string): string {
  const masked = maskCode(text);
  // Keyed by offset, because an image's href is found again from the `[` after its `!`
  const hrefs = new Map<number, string>();
  // Restarting one character after each match start finds an image nested in a link's text
  const inline = new RegExp(INLINE.source, 'g');
  for (let match = inline.exec(masked); match; match = inline.exec(masked)) {
    const at = match.index + match[0].length - match[2]!.length;
    hrefs.set(at, text.slice(at, at + match[2]!.length));
    inline.lastIndex = match.index + 1;
  }
  for (const match of masked.matchAll(DEFINITION)) {
    const at = match.index + match[1]!.length;
    hrefs.set(at, text.slice(at, at + match[2]!.length));
  }
  let out = text;
  for (const at of [...hrefs.keys()].sort((a, b) => b - a)) {
    const href = hrefs.get(at)!;
    out = out.slice(0, at) + rewrite(href) + out.slice(at + href.length);
  }
  return out;
}

/** One href as it should read in the document at `newPath`, or `href` itself when it stays. */
function rewriteHref(
  oldPath: string,
  newPath: string,
  href: string,
  moves: readonly FileMove[],
): string {
  const angle = href.startsWith('<') && href.endsWith('>');
  const raw = angle ? href.slice(1, -1) : href;
  if (raw === '' || raw.startsWith('#') || raw.startsWith('/')) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return href;
  const cut = raw.search(/[?#]/);
  const pathPart = cut < 0 ? raw : raw.slice(0, cut);
  const suffix = cut < 0 ? '' : raw.slice(cut);
  if (pathPart === '') return href;
  const decoded = angle ? pathPart : decode(pathPart);
  const target = resolvePath(oldPath, decoded);
  if (target === undefined || target === '') return href;
  const moved = remapPath(target, moves);
  if (resolvePath(newPath, decoded) === moved) return href;
  const rel = relativePath(newPath, moved);
  return angle ? `<${rel}${suffix}>` : `${encode(rel)}${suffix}`;
}

/** A bare href's path with its percent escapes decoded, or as written when they are malformed. */
function decode(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** A path escaped just enough to be a bare href: the characters that would end or split one. */
function encode(path: string): string {
  return path.replace(
    /[%\s()<>]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

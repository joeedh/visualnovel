/**
 * The Markdown splitter, whose case list comes from a pass over `docs/**` rather than from
 * generic Markdown.
 *
 * Blocks tile the document: every line belongs to exactly one block, blank runs included. Joining
 * the blocks back reproduces the file byte for byte whatever the grouping, so a grouping mistake
 * costs revision quality and never content.
 */

export type BlockKind =
  | 'prose'
  | 'gap'
  | 'fence'
  | 'toc'
  | 'comment'
  | 'heading'
  | 'table'
  | 'checkbox'
  | 'link';

export interface Block {
  kind: BlockKind;
  text: string;
  start: number;
  end: number;
}

/** Whether a block's text is offered to the reviser. */
export function isProse(block: Block): boolean {
  return block.kind === 'prose';
}

/**
 * Whether this line ends the block above it and starts one of its own. `rewrap` consults it so a
 * re-wrapped revision cannot open a line with a marker and split its own block in two.
 */
export function opensBlock(line: string): boolean {
  return (
    FENCE_OPEN.test(line) ||
    HEADING.test(line) ||
    TABLE_ROW.test(line) ||
    LIST_ITEM.test(line) ||
    COMMENT_START.test(line)
  );
}

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}(\s|$)/;
const TABLE_ROW = /^ {0,3}\|/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+/;
const CHECKBOX = /^\s*([-*+]|\d+[.)])\s+\[[ xX]\]\s/;
const BLOCKQUOTE = /^ {0,3}>/;
const TOC_START = /<!--\s*toc\s*-->/i;
const TOC_STOP = /<!--\s*tocstop\s*-->/i;
const COMMENT_START = /^\s*<!--/;
const COMMENT_END = /-->/;
/** A whole line that is only a link reference definition or only a Markdown link. */
const LINK_ONLY = /^\s*(\[[^\]]+\]:\s*\S+|\[[^\]]+\]\([^)]+\)|<https?:\/\/[^>]+>)\s*$/;

/** Splits into lines that keep their terminators, so CRLF survives a round trip. */
function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

const isBlank = (line: string) => /^\s*$/.test(line);

export function splitBlocks(markdown: string): Block[] {
  const all = lines(markdown);
  const blocks: Block[] = [];
  let at = 0;
  let i = 0;

  const push = (kind: BlockKind, from: number, to: number) => {
    const text = all.slice(from, to).join('');
    blocks.push({ kind, text, start: at, end: at + text.length });
    at += text.length;
  };

  while (i < all.length) {
    const line = all[i] as string;
    const from = i;

    if (isBlank(line)) {
      while (i < all.length && isBlank(all[i] as string)) i++;
      push('gap', from, i);
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const marker = (fence[2] as string)[0];
      i++;
      while (i < all.length) {
        const close = FENCE_OPEN.exec(all[i] as string);
        i++;
        if (close && (close[2] as string)[0] === marker) break;
      }
      push('fence', from, i);
      continue;
    }

    if (TOC_START.test(line)) {
      i++;
      while (i < all.length && !TOC_STOP.test(all[i] as string)) i++;
      if (i < all.length) i++;
      push('toc', from, i);
      continue;
    }

    if (COMMENT_START.test(line)) {
      while (i < all.length && !COMMENT_END.test(all[i] as string)) i++;
      if (i < all.length) i++;
      push('comment', from, i);
      continue;
    }

    if (HEADING.test(line)) {
      push('heading', from, ++i);
      continue;
    }

    if (TABLE_ROW.test(line)) {
      while (i < all.length && TABLE_ROW.test(all[i] as string)) i++;
      push('table', from, i);
      continue;
    }

    if (LINK_ONLY.test(line)) {
      push('link', from, ++i);
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const kind: BlockKind = CHECKBOX.test(line) ? 'checkbox' : 'prose';
      i++;
      // Continuations are the wrapped lines under the marker. Any further item opens its own
      // block whatever its indent, because a nested bullet states its own rule and is revised
      // on its own; a fence or a table under an item is likewise its own block.
      while (i < all.length) {
        const next = all[i] as string;
        if (isBlank(next) || opensBlock(next)) break;
        i++;
      }
      push(kind, from, i);
      continue;
    }

    if (BLOCKQUOTE.test(line)) {
      while (i < all.length && BLOCKQUOTE.test(all[i] as string)) i++;
      push('prose', from, i);
      continue;
    }

    while (i < all.length) {
      const next = all[i] as string;
      if (isBlank(next) || opensBlock(next)) break;
      i++;
    }
    push('prose', from, i);
  }

  return blocks;
}

/**
 * Rebuilds the document, replacing the blocks named in `revisions` by index. A revision for a
 * block that is not prose is ignored, so a caller cannot rewrite a table by miscounting.
 */
export function reassemble(blocks: Block[], revisions: Map<number, string>): string {
  return blocks
    .map((block, at) => {
      const revised = revisions.get(at);
      if (revised === undefined || !isProse(block)) return block.text;
      return revised;
    })
    .join('');
}

export interface Structure {
  blocks: number;
  prose: number;
  headings: number;
  fences: number;
  tables: number;
  tableRows: number;
  checkboxes: number;
  bullets: number;
  length: number;
}

/**
 * The counts the guard compares before and after a run. They cover what this repository's
 * documentation is made of, rather than only the constructs the splitter passes through.
 */
export function structure(markdown: string): Structure {
  const blocks = splitBlocks(markdown);
  const count = (kind: BlockKind) => blocks.filter((b) => b.kind === kind).length;
  return {
    blocks: blocks.length,
    prose: blocks.filter(isProse).length,
    headings: count('heading'),
    fences: count('fence'),
    tables: count('table'),
    tableRows: blocks
      .filter((b) => b.kind === 'table')
      .reduce((n, b) => n + lines(b.text).length, 0),
    checkboxes: count('checkbox'),
    bullets: blocks.filter((b) => isProse(b) && LIST_ITEM.test(b.text)).length,
    length: markdown.length,
  };
}

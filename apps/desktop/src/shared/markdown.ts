/**
 * A deliberately small markdown reader: enough to draw a documentation page inside a pane, and
 * no more.
 *
 * It exists because one page — `docs/guides/api-keys.md` — is both a docs page and the Setup pane's
 * only source of words. Rendering it means understanding it, and the alternative to a subset is
 * a markdown library in the browser bundle for two screens of prose.
 *
 * It understands paragraphs, headings, ordered and unordered lists, pipe tables, fenced code,
 * and inline `code`, `**strong**` and `[links](href)`. It does not understand emphasis, images,
 * block quotes, nested lists, HTML or reference links. Anything unrecognised survives as text
 * rather than disappearing, so a page this cannot fully draw is still a page a reader can follow.
 *
 * It is here rather than in the renderer because main is what reads the file: the blocks travel
 * over IPC already parsed, so the renderer draws and does not interpret.
 */

/** A run of text inside a block. */
export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'link'; text: string; href: string };

/** One drawable block. */
export type Block =
  | { kind: 'heading'; level: number; spans: Inline[] }
  | { kind: 'para'; spans: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { kind: 'code'; lang: string; text: string };

/** `` `code` ``, `**strong**` and `[text](href)`, in one pass, longest-prefix-wins. */
const INLINE_RE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

/**
 * Split a line into spans. Unmatched text — including a stray backtick or bracket — comes back
 * as text, so a malformed line renders as what was written instead of vanishing.
 */
export function parseInline(line: string): Inline[] {
  const spans: Inline[] = [];
  let last = 0;

  INLINE_RE.lastIndex = 0;
  for (let m = INLINE_RE.exec(line); m; m = INLINE_RE.exec(line)) {
    if (m.index > last) spans.push({ kind: 'text', text: line.slice(last, m.index) });
    if (m[1] !== undefined) spans.push({ kind: 'code', text: m[1] });
    else if (m[2] !== undefined) spans.push({ kind: 'strong', text: m[2] });
    else spans.push({ kind: 'link', text: m[3]!, href: m[4]! });
    last = m.index + m[0].length;
  }
  if (last < line.length) spans.push({ kind: 'text', text: line.slice(last) });
  return spans.length > 0 ? spans : [{ kind: 'text', text: '' }];
}

/** The cells of a pipe-table row, with the outer pipes dropped and each cell trimmed. */
function tableCells(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

const TABLE_RE = /^\s*\|/;
const DELIMITER_RE = /^[\s|:-]+$/;
const ORDERED_RE = /^(\s*)\d+[.)]\s+(.*)$/;
const BULLET_RE = /^(\s*)[-*]\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^\s*```(.*)$/;

/**
 * Read a markdown document into blocks.
 *
 * A continuation line — indented, under a list item — joins that item rather than starting a
 * paragraph, because the source is wrapped at 100 columns and a step that wrapped would
 * otherwise become two.
 */
export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;

  const flushPara = () => {
    if (para.length > 0) blocks.push({ kind: 'para', spans: parseInline(para.join(' ')) });
    para = [];
  };
  const flushList = () => {
    if (list) {
      blocks.push({
        kind   : 'list',
        ordered: list.ordered,
        items  : list.items.map((item) => parseInline(item)),
      });
    }
    list = undefined;
  };
  const flush = () => {
    flushPara();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = FENCE_RE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !FENCE_RE.test(lines[i]!); i++) body.push(lines[i]!);
      blocks.push({ kind: 'code', lang: fence[1]!.trim(), text: body.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      flush();
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind : 'heading',
        level: heading[1]!.length,
        spans: parseInline(heading[2]!.trim()),
      });
      continue;
    }

    if (TABLE_RE.test(line)) {
      flush();
      const rows: string[][] = [];
      for (; i < lines.length && TABLE_RE.test(lines[i]!); i++) {
        if (!DELIMITER_RE.test(lines[i]!.replace(/^\s*\|/, ''))) rows.push(tableCells(lines[i]!));
      }
      i--;
      const [head, ...body] = rows;
      blocks.push({
        kind: 'table',
        head: (head ?? []).map((cell) => parseInline(cell)),
        rows: body.map((row) => row.map((cell) => parseInline(cell))),
      });
      continue;
    }

    const item = ORDERED_RE.exec(line) ?? BULLET_RE.exec(line);
    if (item) {
      flushPara();
      const ordered = ORDERED_RE.test(line);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(item[2]!);
      continue;
    }

    // An indented line under a list item is that item's next line, not a new block.
    if (list && list.items.length > 0 && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }

    flushList();
    para.push(line.trim());
  }

  flush();
  return blocks;
}

/** A block's words, with the markup gone — what a tooltip or a test wants. */
export function blockText(block: Block): string {
  switch (block.kind) {
    case 'code':
      return block.text;
    case 'list':
      return block.items.map((item) => spansText(item)).join('\n');
    case 'table':
      return [block.head, ...block.rows]
        .map((row) => row.map((cell) => spansText(cell)).join(' | '))
        .join('\n');
    default:
      return spansText(block.spans);
  }
}

/** The words of a run of spans. */
export function spansText(spans: readonly Inline[]): string {
  return spans.map((span) => span.text).join('');
}

/**
 * The wrap rule for files the agent writes, and the one place its exemptions are written down.
 *
 * A generated markdown file is read in a narrow pane and reviewed as a line diff, so a paragraph
 * on one 900-column line is a single unreadable hunk every time a word inside it changes. The
 * system prompt asks for 100 columns; this is how `write_file` tells the agent when it did not
 * manage it. The result is a warning and never a refusal, because three constructs are longer
 * than the limit by nature.
 */

/** The column the agent is asked to wrap at. One number, quoted by the system prompt. */
export const WRAP_COLUMNS = 100;

/** True for a line whose longest word already passes the limit — breaking it would not help. */
function unbreakable(line: string, limit: number): boolean {
  return line.split(/\s+/).some((word) => word.length > limit);
}

/**
 * The 1-based line numbers of lines the agent could have wrapped and did not.
 *
 * Three kinds of line are exempt. A line inside a fenced code block, because a break changes what
 * the code says. A table row, because markdown tables are one row per line by definition. A line
 * held long by a single word (a URL or a path) because there is nowhere to break it.
 */
export function overlongLines(text: string, limit = WRAP_COLUMNS): number[] {
  const over: number[] = [];
  let fence = '';
  text.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    const opener = /^(```+|~~~+)/.exec(trimmed);
    if (fence) {
      if (opener && trimmed.startsWith(fence)) fence = '';
      return;
    }
    if (opener) {
      fence = opener[1]!;
      return;
    }
    if (line.length <= limit || trimmed.startsWith('|')) return;
    if (unbreakable(line, limit)) return;
    over.push(i + 1);
  });
  return over;
}

/**
 * The sentence appended to a write's receipt, or `''` when the file is within the limit. Names
 * the lines rather than counting them, because a count sends the agent looking for them.
 */
export function wrapWarning(text: string, limit = WRAP_COLUMNS): string {
  const over = overlongLines(text, limit);
  if (over.length === 0) return '';
  const shown = over.slice(0, 8).join(', ');
  const rest = over.length > 8 ? `, and ${over.length - 8} more` : '';
  return (
    ` Warning: ${over.length} line(s) run past ${limit} columns (line ${shown}${rest}). ` +
    'Wrap them on the next edit; the file was written as given.'
  );
}

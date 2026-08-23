import {
  HISTORY_HITS,
  HISTORY_MESSAGE,
  HISTORY_WINDOW,
  historyTools,
  type HistoryMessage,
  type HistoryReader,
} from '../history.js';
import type { Tool, ToolContext, ToolResult } from '../tools.js';

const readerOf = (messages: HistoryMessage[]): HistoryReader => ({
  messages: () => Promise.resolve(messages),
});

const said = (n: number, content: string, role = 'user'): HistoryMessage => ({ n, role, content });

/** The tool context is never reached: neither tool touches the workspace. */
const ctx = {} as ToolContext;

function tool(reader: HistoryReader, name: string): Tool {
  const found = historyTools(reader).find((t) => t.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
}

const run = (reader: HistoryReader, name: string, args: unknown): Promise<ToolResult> =>
  tool(reader, name).run(args, ctx);

describe('search_history', () => {
  it('centres a hit on the match and marks where the message was cut', async () => {
    const filler = 'x'.repeat(500);
    const reader = readerOf([said(4, `${filler} the hollow court ${filler}`)]);

    const result = await run(reader, 'search_history', { query: 'hollow court' });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('#4 user');
    expect(result.output).toContain('the hollow court');
    expect(result.output.startsWith('#4')).toBe(true);
    // Cut at both ends, and no longer than the match plus its two windows and the header
    expect(result.output).toContain('…');
    expect(result.output.length).toBeLessThan(HISTORY_WINDOW * 2 + 100);
  });

  it('is one line per hit, and folds a message’s own line breaks into it', async () => {
    const reader = readerOf([
      said(0, 'a jacket for Aiko'),
      said(1, 'Added a\njacket.', 'assistant'),
      said(2, 'nothing to see'),
    ]);

    const { output } = await run(reader, 'search_history', { query: 'jacket' });
    expect(output.split('\n')).toHaveLength(2);
    expect(output).toContain('#1 assistant');
    expect(output).toContain('Added a jacket.');
  });

  it('caps the hits and says it did', async () => {
    const many = Array.from({ length: HISTORY_HITS + 5 }, (_n, i) => said(i, 'a jacket'));

    const { output } = await run(readerOf(many), 'search_history', { query: 'jacket' });
    expect(output.split('\n')).toHaveLength(HISTORY_HITS + 1);
    expect(output).toContain('narrow the query');
  });

  it('honours a smaller limit but not a larger one', async () => {
    const many = Array.from({ length: HISTORY_HITS + 5 }, (_n, i) => said(i, 'a jacket'));

    const small = await run(readerOf(many), 'search_history', { query: 'jacket', limit: 2 });
    expect(small.output.split('\n')).toHaveLength(3);

    const large = await run(readerOf(many), 'search_history', { query: 'jacket', limit: 500 });
    expect(large.output.split('\n')).toHaveLength(HISTORY_HITS + 1);
  });

  it('names its own scope when nothing matched, rather than answering nothing', async () => {
    const { ok, output } = await run(readerOf([said(0, 'a jacket')]), 'search_history', {
      query: 'a scarf',
    });
    expect(ok).toBe(true);
    expect(output).toContain('No matches for "a scarf"');
    expect(output).toContain('1 message(s)');
    expect(output).toContain('compacted turns included');
    expect(output).toContain('No other conversation is searched');
  });

  it('takes the query literally unless asked for a regex', async () => {
    const reader = readerOf([said(0, 'the price is $3.50'), said(1, 'the price is $3x50')]);

    const literal = await run(reader, 'search_history', { query: '$3.50' });
    expect(literal.output.split('\n')).toHaveLength(1);
    expect(literal.output).toContain('#0');

    const pattern = await run(reader, 'search_history', { query: '\\$3.50', regex: true });
    expect(pattern.output.split('\n')).toHaveLength(2);
  });

  it('refuses a regex that does not compile, rather than throwing', async () => {
    const result = await run(readerOf([said(0, 'x')]), 'search_history', {
      query: '(unclosed',
      regex: true,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('invalid regex');
  });

  it('does not hang on a pattern that can match nothing', async () => {
    const result = await run(readerOf([said(0, 'abc')]), 'search_history', {
      query: 'x*',
      regex: true,
    });
    expect(result.ok).toBe(true);
  });

  it('reads a message stored as blocks, not only one stored as text', async () => {
    const reader = readerOf([
      { n: 7, role: 'assistant', content: [{ type: 'text', text: 'a jacket for Aiko' }] },
    ]);

    const { output } = await run(reader, 'search_history', { query: 'jacket' });
    expect(output).toContain('#7 assistant');
  });

  it('refuses an empty query at the boundary', () => {
    const args = tool(readerOf([]), 'search_history').args;
    expect(args.safeParse({ query: '' }).success).toBe(false);
    expect(args.safeParse({ query: 'a' }).success).toBe(true);
    expect(args.safeParse({ query: 'a', limit: 0 }).success).toBe(false);
  });
});

describe('read_history', () => {
  it('returns one message verbatim, by the number a search reported', async () => {
    const reader = readerOf([said(0, 'first'), said(1, 'second', 'assistant')]);

    const { ok, output } = await run(reader, 'read_history', { n: 1 });
    expect(ok).toBe(true);
    expect(output).toBe('#1 assistant\nsecond');
  });

  it('says so when it clamped a long one', async () => {
    const reader = readerOf([said(0, 'y'.repeat(HISTORY_MESSAGE + 500))]);

    const { output } = await run(reader, 'read_history', { n: 0 });
    expect(output).toContain(`first ${HISTORY_MESSAGE} shown`);
    expect(output.length).toBeLessThan(HISTORY_MESSAGE + 200);
  });

  it('refuses an unknown number, naming the range there is', async () => {
    const reader = readerOf([said(3, 'a'), said(4, 'b')]);

    const missing = await run(reader, 'read_history', { n: 99 });
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain('no message #99');
    expect(missing.output).toContain('run 3 to 4');

    const empty = await run(readerOf([]), 'read_history', { n: 0 });
    expect(empty.ok).toBe(false);
    expect(empty.output).toContain('no kept history');
  });
});

import type { CommandRecord } from '@vn/commands';
import type { Redactor } from '../redact.js';
import {
  assemble,
  redactEvidence,
  toMarkdown,
  type FeedItem,
  type ThreadRecord,
  type ThreadUsage,
} from '../transcript.js';

const at = (minute: number) => `2026-08-15T14:${String(minute).padStart(2, '0')}:00.000Z`;

const line = (id: number, role: FeedItem['role'], text: string, minute: number): FeedItem => ({
  id,
  role,
  text,
  at: at(minute),
});

const thread = (items: FeedItem[], over: Partial<ThreadRecord> = {}): ThreadRecord => ({
  id       : '20260815-140000',
  title    : 'give aiko a track outfit',
  startedAt: at(0),
  model    : 'claude-opus-5',
  commit   : 'a1b2c3d',
  items,
  ...over,
});

const act = (seq: number, minute: number, over: Partial<CommandRecord> = {}): CommandRecord => ({
  seq,
  id        : 'story.editScene',
  props     : {},
  invocation: `story.editScene(id='s1')`,
  source    : 'agent',
  mutating  : true,
  gitHead   : 'a1b2c3d',
  gitDirty  : false,
  startedAt : at(minute),
  finishedAt: at(minute),
  status    : 'ok',
  message   : 'Rewrote 3 lines.',
  ...over,
});

describe('assemble', () => {
  const items = [line(1, 'user', 'give aiko a track outfit', 1), line(2, 'agent', 'Done.', 5)];

  it('takes the commands that ran while the conversation was open', () => {
    // `act(1)` runs at 14:00, exactly when the thread opened; `act(3)` at 14:09, after its last line.
    const records = [act(1, 0), act(2, 3), act(3, 9)];
    const { acts } = assemble(thread(items), records);
    expect(acts.map((record) => record.seq)).toEqual([1, 2]);
  });

  it('orders by seq, whatever order the log was handed in', () => {
    const { acts } = assemble(thread(items), [act(4, 4), act(2, 2), act(3, 3)]);
    expect(acts.map((record) => record.seq)).toEqual([2, 3, 4]);
  });

  it('counts a command that started before the thread and finished inside it', () => {
    const straddling = act(1, 1, { startedAt: at(0), finishedAt: at(2) });
    expect(assemble(thread(items), [straddling]).acts).toHaveLength(1);
  });

  it('joins nothing when no line is stamped, rather than guessing a window', () => {
    const unstamped = items.map(({ at: _at, ...rest }) => rest);
    expect(assemble(thread(unstamped), [act(1, 3)]).acts).toEqual([]);
  });

  it('carries the context the thread file does not record', () => {
    const evidence = assemble(thread(items), [], { effort: 'high', appVersion: '0.4.1' });
    expect(evidence.context).toEqual({ effort: 'high', appVersion: '0.4.1' });
  });
});

describe('thin', () => {
  it('is true when a tool line records only a name', () => {
    const items = [line(1, 'user', 'go', 1), line(2, 'tool', 'read_file', 2)];
    expect(assemble(thread(items), []).thin).toBe(true);
  });

  it('is false the moment one tool line carries what it was called with', () => {
    const items = [
      line(1, 'tool', 'read_file', 1),
      { ...line(2, 'tool', 'write_file', 2), detail: { args: '{"path":"a.md"}', ok: true } },
    ];
    expect(assemble(thread(items), []).thin).toBe(false);
  });

  it('is false when nothing called a tool but something was kept in full', () => {
    const items = [{ ...line(1, 'agent', 'cut…', 1), full: 'cut nothing, actually' }];
    expect(assemble(thread(items), []).thin).toBe(false);
  });
});

describe('toMarkdown', () => {
  it('leads with what a maintainer needs to know to read the rest', () => {
    const md = toMarkdown(
      assemble(thread([line(1, 'user', 'go', 1)]), [], { effort: 'high', appVersion: '0.4.1' }),
    );
    expect(md).toContain('# Conversation: give aiko a track outfit');
    expect(md).toContain('- Model: claude-opus-5');
    expect(md).toContain('- Effort: high');
    expect(md).toContain('- Commit: a1b2c3d');
    expect(md).toContain('- App version: 0.4.1');
  });

  it('omits a fact it was not given rather than printing an empty one', () => {
    const md = toMarkdown(assemble(thread([], { model: undefined, commit: undefined }), []));
    expect(md).not.toContain('- Model:');
    expect(md).not.toContain('- Effort:');
  });

  it('says when the transcript predates the detailed format', () => {
    const thin = toMarkdown(assemble(thread([line(1, 'tool', 'read_file', 1)]), []));
    expect(thin).toMatch(/recorded before transcripts kept/);

    const rich = toMarkdown(
      assemble(thread([{ ...line(1, 'tool', 'read_file', 1), detail: { ok: true } }]), []),
    );
    expect(rich).not.toMatch(/recorded before transcripts kept/);
  });

  it('shows a tool call with its arguments, its verdict and what came back', () => {
    const item: FeedItem = {
      ...line(1, 'tool', 'read_file', 1),
      detail: { args: '{"path":"characters/aiko.md"}', ok: false, output: 'no such file' },
    };
    const md = toMarkdown(assemble(thread([item]), []));
    expect(md).toContain('### 1 · tool');
    expect(md).toContain('{"path":"characters/aiko.md"}');
    expect(md).toContain('**It failed.**');
    expect(md).toContain('no such file');
  });

  it('prefers the kept text to the clamped one — the cut is where the failure is', () => {
    const item = { ...line(1, 'agent', 'I will rew…', 1), full: 'I will rewrite the whole scene' };
    expect(toMarkdown(assemble(thread([item]), []))).toContain('I will rewrite the whole scene');
  });

  it('fences output that contains a fence, rather than ending its own block', () => {
    const item: FeedItem = {
      ...line(1, 'tool', 'read_file', 1),
      detail: { output: '```ts\nconst a = 1;\n```' },
    };
    const md = toMarkdown(assemble(thread([item]), []));
    expect(md).toContain('````\n```ts\nconst a = 1;\n```\n````');
  });

  it('lists the acts with their outcome, and names the error when there was one', () => {
    const records = [
      act(1, 2),
      act(2, 3, { status: 'error', message: 'failed', error: 'no such scene: s9' }),
      act(3, 4, { written: ['scenes/s1.fountain'] }),
    ];
    const said = [line(1, 'user', 'go', 1), line(2, 'agent', 'Done.', 5)];
    const md = toMarkdown(assemble(thread(said), records));
    expect(md).toContain("- `#1` story.editScene(id='s1') — **ok**");
    expect(md).toContain('no such scene: s9');
    expect(md).toContain('wrote: scenes/s1.fountain');
  });

  it('says so plainly when nothing happened, rather than leaving an empty heading', () => {
    const md = toMarkdown(assemble(thread([]), []));
    expect(md).toContain('Nothing was said in it.');
    expect(md).toContain('No commands were executed in this window.');
  });
});

describe('redactEvidence', () => {
  // Replaces one authored name and nothing else, so a field that came through unscrubbed is
  // visible in the result rather than having to be inferred
  const redactor: Redactor = {
    apply: (text) => text.replaceAll('aiko', '<char1>'),
    leaks: () => [],
  };

  it('keeps every field of a record that has them all', () => {
    const usage = [{ step: 1, input: 10, output: 2, verdict: 'miss' as const, at: at(1) }];
    const evidence = assemble(thread([line(1, 'user', 'go', 1)], { usage }), []);
    const { thread: scrubbed } = redactEvidence(evidence, redactor);

    expect(scrubbed).toEqual({ ...evidence.thread, title: 'give <char1> a track outfit' });
  });

  it('leaves out what the record left out', () => {
    const bare = thread([], { model: undefined, commit: undefined });
    const { thread: scrubbed } = redactEvidence(assemble(bare, []), redactor);

    expect(Object.keys(scrubbed).sort()).toEqual(['id', 'items', 'startedAt', 'title']);
  });
});

describe('the cache section', () => {
  const receipt = (step: number, over: Partial<ThreadUsage> = {}): ThreadUsage => ({
    step,
    input : 1000,
    output: 20,
    at    : at(step),
    ...over,
  });

  it('counts the verdicts and names every call the prefix broke on', () => {
    const usage = [
      receipt(1, { verdict: 'cold', cacheWrite: 900 }),
      receipt(2, { verdict: 'hit', cacheRead: 900 }),
      receipt(3, { verdict: 'miss', cacheWrite: 980 }),
    ];
    const md = toMarkdown(assemble(thread([], { usage }), []));
    expect(md).toContain('## What the prompt cache did');
    expect(md).toContain('- hit: 1');
    expect(md).toContain('- miss: 1');
    expect(md).toContain('- call 3 re-sent 980 tokens');
  });

  it('names no call where the prefix held', () => {
    const usage = [receipt(1, { verdict: 'cold' }), receipt(2, { verdict: 'hit' })];
    const md = toMarkdown(assemble(thread([], { usage }), []));
    expect(md).toContain('- hit: 1');
    expect(md).not.toContain('re-sent');
  });

  it('is left out where no call carried a verdict, rather than reading as a cache that held', () => {
    const md = toMarkdown(assemble(thread([], { usage: [receipt(1), receipt(2)] }), []));
    expect(md).not.toContain('What the prompt cache did');
  });

  it('is left out on a thread that recorded no receipts at all', () => {
    expect(toMarkdown(assemble(thread([]), []))).not.toContain('What the prompt cache did');
  });
});

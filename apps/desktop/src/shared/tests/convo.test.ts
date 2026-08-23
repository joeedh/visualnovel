import {
  COMPACT_HINT_TOKENS,
  answered,
  answeredQuestion,
  asked,
  cleared,
  compacted,
  confirmAsked,
  confirmDecided,
  contextDetail,
  decided,
  emptyConvo,
  offered,
  proposed,
  queried,
  received,
  replayed,
  tokensDetail,
  toolSummary,
  uncachedTokens,
  type FeedItem,
} from '../convo.js';
import type { AgentEvent, AskRequest, ConfirmRequest, PlanRequest } from '../ipc.js';

const opening = 'Workspace loaded.';

const ranTool = (tool: string): AgentEvent => ({
  type: 'tool',
  tool,
  args: {},
  result: { ok: true, output: 'done' },
});

const plan: PlanRequest = {
  id: 3,
  plan: { summary: 'Give Aiko a jacket', steps: ['edit characters/aiko'], files: [] },
};

describe('what an event does to the conversation', () => {
  test('a tool call is transcript, not dialogue', () => {
    const convo = received(emptyConvo(opening), ranTool('read_file'));
    expect(convo.feed[0]).toMatchObject({ id: 1, role: 'tool', text: 'read_file' });
    expect(convo.line).toBe(opening);
  });

  test('a tool line says what it acted on, not just which tool it was', () => {
    const convo = received(emptyConvo(opening), {
      type: 'tool',
      tool: 'read_file',
      args: { path: 'wiki/hollow-court.md' },
      result: { ok: true, output: '…' },
    });
    expect(convo.feed[0]!.text).toBe('read_file wiki/hollow-court.md');
  });

  test('a tool line keeps what it was called with and what came back', () => {
    const convo = received(emptyConvo(opening), {
      type: 'tool',
      tool: 'read_file',
      args: { path: 'characters/aiko.md' },
      result: { ok: false, output: 'no such file' },
    });
    expect(convo.feed[0]!.detail).toEqual({
      args: '{"path":"characters/aiko.md"}',
      ok: false,
      output: 'no such file',
    });
  });

  test('a tool called with nothing says nothing, rather than saying “undefined”', () => {
    const convo = received(emptyConvo(opening), {
      type: 'tool',
      tool: 'list_files',
      args: undefined,
      result: { ok: true, output: '3 files' },
    });
    expect(convo.feed[0]!.detail?.args).toBe('');
  });

  test('what the agent says is both the dialogue box and a transcript line', () => {
    const convo = received(emptyConvo(opening), { type: 'final', text: 'Done — one file.' });
    expect(convo.line).toBe('Done — one file.');
    expect(convo.feed).toEqual([{ id: 1, role: 'agent', text: 'Done — one file.' }]);
  });

  test('a blocked tool reads as one sentence, with the reason', () => {
    const convo = received(emptyConvo(opening), {
      type: 'blocked',
      tool: 'write_file',
      reason: 'plan mode is read-only',
    });
    expect(convo.feed[0]).toEqual({
      id: 1,
      role: 'blocked',
      text: 'write_file blocked — plan mode is read-only',
    });
  });

  test('a blocked tool names its target too, where it had one', () => {
    const convo = received(emptyConvo(opening), {
      type: 'blocked',
      tool: 'write_file',
      args: { path: 'wiki/notes.md', content: 'x' },
      reason: 'plan mode is read-only',
    });
    expect(convo.feed[0]!.text).toBe('write_file wiki/notes.md blocked — plan mode is read-only');
  });

  test('the mode is the shell’s, so the conversation is untouched by it', () => {
    const before = emptyConvo(opening);
    expect(received(before, { type: 'mode', mode: 'execute' })).toBe(before);
  });
});

/**
 * The running total. A usage event changes the conversation without adding a line to the
 * transcript, so a thread reopened months later does not read as though the agent announced its
 * own cost three times.
 */
describe('what a step cost', () => {
  const spent = (input: number, output: number): AgentEvent => ({ type: 'usage', input, output });

  test('adds up across the steps of a turn', () => {
    let convo = received(emptyConvo(opening), spent(1200, 300));
    convo = received(convo, spent(1500, 90));
    expect(convo.tokens).toEqual({ input: 2700, output: 390 });
  });

  test('is not a transcript line', () => {
    const convo = received(emptyConvo(opening), spent(10, 2));
    expect(convo.feed).toEqual([]);
    expect(convo.line).toBe(opening);
    expect(convo.seq).toBe(0);
  });

  test('starts again with the conversation, and a replayed one has none of its own', () => {
    const convo = received(emptyConvo(opening), spent(10, 2));
    expect(cleared(convo, 'Cleared.').tokens).toEqual({ input: 0, output: 0 });
    expect(replayed(convo, [], 'Reopened.').tokens).toEqual({ input: 0, output: 0 });
  });
});

/**
 * The cache half of the receipt. Absent and zero are different answers: a provider that says
 * nothing about caching has not reported a miss.
 */
describe('what the cache did', () => {
  type Usage = Extract<AgentEvent, { type: 'usage' }>;
  const cached = (usage: Partial<Usage>): AgentEvent => ({
    type: 'usage',
    input: 1000,
    output: 100,
    ...usage,
  });

  test('stays absent while no step has mentioned it', () => {
    const convo = received(emptyConvo(opening), cached({}));
    expect(convo.tokens).toEqual({ input: 1000, output: 100 });
  });

  test('adds up from the first step that does, counting the silent ones as nothing', () => {
    let convo = received(emptyConvo(opening), cached({}));
    convo = received(convo, cached({ cacheRead: 800, cacheEstimated: true }));
    convo = received(convo, cached({ cacheRead: 800, cacheEstimated: true }));
    expect(convo.tokens).toEqual({
      input: 3000,
      output: 300,
      cacheRead: 1600,
      cacheEstimated: true,
    });
  });

  // One estimated step makes the whole total an estimate
  test('is an estimate ever after, once one step was one', () => {
    let convo = received(emptyConvo(opening), cached({ cacheRead: 900, cacheWrite: 100 }));
    expect(convo.tokens.cacheEstimated).toBeUndefined();
    convo = received(convo, cached({ cacheRead: 800, cacheEstimated: true }));
    expect(convo.tokens.cacheEstimated).toBe(true);
  });
});

describe('the tokens tooltip', () => {
  test('offers no figures before anything has been counted', () => {
    const said = tokensDetail({ input: 0, output: 0 });
    expect(said).toContain('Tokens are how a model measures text');
    expect(said).toContain('Nothing used in this conversation yet.');
  });

  test('says nothing about a cache no provider mentioned', () => {
    const said = tokensDetail({ input: 1200, output: 300 });
    expect(said).toContain('It has sent 1,200 and got 300 back.');
    expect(said).not.toMatch(/cache/i);
  });

  test('reports a billed split as fact, both halves of it', () => {
    const said = tokensDetail({ input: 1200, output: 300, cacheRead: 900, cacheWrite: 100 });
    expect(said).toContain('The counter shows 600');
    expect(said).toContain('900 of what it sent (75%)');
    expect(said).toContain('100 was put there for next time');
    expect(said).not.toMatch(/roughly/i);
  });

  // The share is of what was sent alone, because a prefix cache does not move what comes back
  test('hedges a matched split, and does not invent a write it was never told about', () => {
    const said = tokensDetail({
      input: 1200,
      output: 300,
      cacheRead: 900,
      cacheEstimated: true,
    });
    expect(said).toContain('Roughly 900 of what it sent (75%)');
    expect(said).toContain('Roughly, because');
    expect(said).not.toContain('put there for next time');
  });

  // The author is being told what their conversation cost, not what a response body said
  test('uses none of the API’s words for these numbers', () => {
    const said = tokensDetail({ input: 1200, output: 300, cacheRead: 900, cacheWrite: 100 });
    expect(said).not.toMatch(/\b(input|output|cache read|cache write|prefix|billed)\b/i);
  });
});

/**
 * What the turn in flight has spent against its budget. This is a different number from the
 * conversation total: the total counts every token, while the meter counts only what is billed
 * fresh, so a long cached turn moves the total fast and the meter barely at all.
 */
describe('what the turn in flight has spent', () => {
  test('excludes what the cache served, unlike the conversation total', () => {
    const convo = received(emptyConvo(opening), {
      type: 'usage',
      input: 100_000,
      output: 1_000,
      cacheRead: 99_000,
    });
    expect(convo.tokens.input).toBe(100_000);
    expect(convo.turnSpend).toBe(2_000);
  });

  test('starts again when a turn is sent, not when one comes back', () => {
    let convo = received(asked(emptyConvo(opening), 'one'), {
      type: 'usage',
      input: 500,
      output: 100,
    });
    expect(convo.turnSpend).toBe(600);
    // The label still says what the last turn cost while the composer is open again.
    convo = answered(convo, 'done');
    expect(convo.turnSpend).toBe(600);
    expect(asked(convo, 'two').turnSpend).toBe(0);
  });
});

describe('a turn', () => {
  test('shows the author’s own words before the agent has read them', () => {
    const convo = asked(emptyConvo(opening), 'give Aiko a jacket');
    expect(convo.feed).toEqual([{ id: 1, role: 'user', text: 'give Aiko a jacket' }]);
    expect(convo.busy).toBe(true);
  });

  test('coming back opens the composer and speaks', () => {
    const convo = answered(asked(emptyConvo(opening), 'hi'), 'Aiko now owns a jacket.');
    expect(convo.busy).toBe(false);
    expect(convo.line).toBe('Aiko now owns a jacket.');
  });

  test('a turn that says nothing leaves the last thing said standing', () => {
    const convo = answered(asked(emptyConvo(opening), 'hi'), null);
    expect(convo.busy).toBe(false);
    expect(convo.line).toBe(opening);
  });
});

describe('the plan card', () => {
  test('arrives as a request and leaves on a decision', () => {
    const asking = proposed(emptyConvo(opening), plan);
    expect(asking.plan).toBe(plan);
    expect(decided(asking).plan).toBeNull();
  });

  // The card is transient. A thread that kept only what happened next read as a decision about
  // nothing, and the plan is the turn a report on a bad conversation most needs to see.
  test('the plan goes into the transcript, steps and files and all', () => {
    const [item] = proposed(emptyConvo(opening), plan).feed;
    expect(item?.role).toBe('agent');
    expect(item?.text).toContain(plan.plan.summary);
    for (const step of plan.plan.steps) expect(item?.text).toContain(step);
    for (const file of plan.plan.files) expect(item?.text).toContain(file);
  });

  test('the verdict is filed as the author’s turn, with what they said about it', () => {
    const approved = decided(proposed(emptyConvo(opening), plan), { approved: true });
    expect(approved.feed[1]).toMatchObject({ role: 'user', text: 'Approved the plan.' });

    const declined = decided(proposed(emptyConvo(opening), plan), {
      approved: false,
      feedback: 'Too many files.',
    });
    expect(declined.feed[1]?.text).toBe('Declined the plan. Too many files.');
  });

  // The renderer clears the card in one place and main records the verdict in another; only one
  // of them knows the decision, so a bare call must stay a bare clear.
  test('clearing the card without a decision writes nothing down', () => {
    expect(decided(proposed(emptyConvo(opening), plan)).feed).toHaveLength(1);
  });
});

describe('a question the agent asked', () => {
  const asking = 'Which café — Mori or the station one?';
  const question: AskRequest = { id: 7, questions: [{ question: asking }] };

  test('arrives as a card', () => {
    expect(queried(emptyConvo(opening), question).question).toBe(question);
  });

  test('answering files the answer as the author’s own turn', () => {
    const convo = answeredQuestion(queried(emptyConvo(opening), question), ['Mori']);
    expect(convo.question).toBeNull();
    expect(convo.feed).toEqual([
      { id: 1, role: 'agent', text: asking },
      { id: 2, role: 'user', text: 'Mori' },
    ]);
  });

  test('an empty answer is still an answer, and says so', () => {
    const convo = answeredQuestion(queried(emptyConvo(opening), question), ['   ']);
    expect(convo.feed[1]).toEqual({ id: 2, role: 'user', text: '(no answer)' });
  });

  // "The second one" is unreadable without the list it picked from.
  test('the options go down with the question', () => {
    const withChoices: AskRequest = {
      id: 7,
      questions: [{ question: asking, choices: ['Mori', 'the station'], multi: true }],
    };
    const [item] = queried(emptyConvo(opening), withChoices).feed;
    expect(item?.text).toContain('- Mori');
    expect(item?.text).toContain('- the station');
    expect(item?.text).toContain('more than one');
  });

  // A form is one turn each way: the questions sit together, and so do the answers, so the reply
  // is directly beneath the thing it answers rather than three lines below it.
  test('a form of several is one line of questions and one of numbered answers', () => {
    const form: AskRequest = {
      id: 8,
      questions: [{ question: 'Which café?' }, { question: 'What time?' }],
    };
    const convo = answeredQuestion(queried(emptyConvo(opening), form), ['Mori', '']);
    expect(convo.feed).toEqual([
      { id: 1, role: 'agent', text: 'Which café?\n\nWhat time?' },
      { id: 2, role: 'user', text: '1. Mori\n2. (no answer)' },
    ]);
  });
});

describe('an always-confirm tool', () => {
  const confirm: ConfirmRequest = {
    id: 2,
    tool: 'generate_image',
    detail: 'Draw a concept sketch: “an aerial shot”. Costs one image generation.',
  };

  test('arrives as a card and leaves on an allow, saying nothing', () => {
    const asking = confirmAsked(emptyConvo(opening), confirm);
    expect(asking.confirm).toBe(confirm);
    const after = confirmDecided(asking, true);
    expect(after.confirm).toBeNull();
    expect(after.feed).toEqual([]);
  });

  test('a denial is recorded, because the agent may never mention it', () => {
    const after = confirmDecided(confirmAsked(emptyConvo(opening), confirm), false);
    expect(after.confirm).toBeNull();
    expect(after.feed).toEqual([
      { id: 1, role: 'blocked', text: 'generate_image denied — you said no' },
    ]);
  });
});

describe('clearing', () => {
  test('empties the transcript but keeps issuing fresh ids', () => {
    const convo = received(received(emptyConvo(opening), ranTool('a')), ranTool('b'));
    const after = received(cleared(convo, 'Conversation cleared.'), ranTool('c'));
    expect(after.line).toBe('Conversation cleared.');
    expect(after.feed).toHaveLength(1);
    expect(after.feed[0]).toMatchObject({ id: 3, role: 'tool', text: 'c' });
  });
});

describe('a conversation something else opened', () => {
  const openers = ['Summarize these and file them under `wiki/`.', 'Turn these into characters.'];

  test('clears what came before and holds the openers as chips', () => {
    const convo = received(emptyConvo(opening), ranTool('a'));
    const after = offered(convo, 'Archived 2 files.', openers);
    expect(after.feed).toEqual([]);
    expect(after.line).toBe('Archived 2 files.');
    expect(after.suggestions).toEqual(openers);
    expect(after.seq).toBe(convo.seq);
  });

  test('the chips go once a turn is sent — they offer to start what is already under way', () => {
    const after = asked(offered(emptyConvo(opening), 'Archived 2 files.', openers), 'do the first');
    expect(after.suggestions).toEqual([]);
    expect(after.busy).toBe(true);
  });
});

describe('replaying a saved thread', () => {
  const banner = 'Reopened for reading.';
  const saved: FeedItem[] = [
    { id: 1, role: 'user', text: 'give Aiko a jacket' },
    { id: 2, role: 'agent', text: 'Done.' },
  ];

  test('shows the stored turns, and says in the dialogue box that it is a reading', () => {
    const convo = replayed(emptyConvo(opening), saved, banner);
    expect(convo.feed).toEqual(saved);
    expect(convo.line).toBe(banner);
    expect(convo.busy).toBe(false);
  });

  test('a turn typed afterwards cannot reuse a replayed id', () => {
    const after = asked(replayed(emptyConvo(opening), saved, banner), 'and a scarf');
    expect(after.feed[2]).toEqual({ id: 3, role: 'user', text: 'and a scarf' });
  });

  test('brings back the rules a compaction drew, and shows none where there were none', () => {
    const marks = [{ afterId: 1, covers: 6, text: 'the summary' }];
    expect(replayed(emptyConvo(opening), saved, banner, marks).compactions).toEqual(marks);
    expect(replayed(emptyConvo(opening), saved, banner).compactions).toEqual([]);
  });
});

describe('compacting', () => {
  const mark = { afterId: 2, covers: 8, text: 'the summary' };

  test('adds a rule without touching the transcript above it', () => {
    const convo = compacted(
      replayed(emptyConvo(opening), [{ id: 2, role: 'user', text: 'go' }], ''),
      mark,
    );
    expect(convo.compactions).toEqual([mark]);
    expect(convo.feed).toHaveLength(1);
  });

  test('keeps every rule, oldest first', () => {
    const second = { afterId: 5, covers: 3, text: 'a later summary' };
    expect(compacted(compacted(emptyConvo(opening), mark), second).compactions).toEqual([
      mark,
      second,
    ]);
  });

  test('drops the context figure, because what the next request carries is not known yet', () => {
    const carrying = received(emptyConvo(opening), { type: 'usage', input: 90_000, output: 400 });
    expect(carrying.context).toBe(90_000);
    expect(compacted(carrying, mark).context).toBeUndefined();
  });
});

describe('what the Compact button says it would do', () => {
  test('says the size is not known until a turn has run', () => {
    const detail = contextDetail(emptyConvo(opening));
    expect(detail).toContain('not known until a turn has run');
    expect(detail).toContain('Nothing is deleted');
  });

  test('names the size once a turn has reported one', () => {
    const convo = received(emptyConvo(opening), { type: 'usage', input: 41_208, output: 900 });
    expect(contextDetail(convo)).toContain('41,208 tokens');
    expect(contextDetail(convo)).not.toContain('worth compacting');
  });

  test('says a large conversation is worth compacting', () => {
    const convo = received(emptyConvo(opening), {
      type: 'usage',
      input: COMPACT_HINT_TOKENS,
      output: 900,
    });
    expect(contextDetail(convo)).toContain('worth compacting');
  });
});

/**
 * What a transcript line says a tool did. The whole call is in `detail.args` either way, so the
 * headline shows one field, chosen the same way every time.
 */
describe('a tool line’s headline argument', () => {
  test('prefers the path, whatever order the fields arrived in', () => {
    expect(toolSummary('edit_file', { edits: [], path: 'wiki/a.md' })).toBe('edit_file wiki/a.md');
  });

  test('falls back to the rung, the id, or the query — in that order', () => {
    expect(toolSummary('set_art_notes', { notes: 'colder', target: 'location:cafe/night' })).toBe(
      'set_art_notes location:cafe/night',
    );
    expect(toolSummary('search_bible', { query: 'the hollow court' })).toBe(
      'search_bible the hollow court',
    );
  });

  test('takes a lone unrecognised field, and refuses to guess between several', () => {
    expect(toolSummary('run_skill', { skill: 'outline' })).toBe('run_skill outline');
    expect(toolSummary('mystery', { alpha: 'a', beta: 'b' })).toBe('mystery');
  });

  test('says the tool alone when there was nothing to say', () => {
    expect(toolSummary('list_workspace', {})).toBe('list_workspace');
    expect(toolSummary('git_status', undefined)).toBe('git_status');
  });

  test('clamps a field long enough to be a document', () => {
    const summary = toolSummary('write_file', { text: 'x'.repeat(400) });
    expect(summary.length).toBeLessThan(80);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('the number the counter shows', () => {
  test('is fresh input plus output — never the cached prefix re-sent every step', () => {
    expect(uncachedTokens({ input: 40_000, output: 500, cacheRead: 39_000 })).toBe(1500);
  });

  test('is the whole input where the provider reported no split', () => {
    expect(uncachedTokens({ input: 1200, output: 300 })).toBe(1500);
  });
});

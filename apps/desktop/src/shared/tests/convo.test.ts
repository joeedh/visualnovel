import {
  answered,
  answeredQuestion,
  asked,
  cleared,
  confirmAsked,
  confirmDecided,
  decided,
  emptyConvo,
  offered,
  proposed,
  queried,
  received,
  replayed,
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

  test('the mode is the shell’s, so the conversation is untouched by it', () => {
    const before = emptyConvo(opening);
    expect(received(before, { type: 'mode', mode: 'execute' })).toBe(before);
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
});

describe('a question the agent asked', () => {
  const question: AskRequest = { id: 7, question: 'Which café — Mori or the station one?' };

  test('arrives as a card', () => {
    expect(queried(emptyConvo(opening), question).question).toBe(question);
  });

  test('answering files the answer as the author’s own turn', () => {
    const convo = answeredQuestion(queried(emptyConvo(opening), question), 'Mori');
    expect(convo.question).toBeNull();
    expect(convo.feed).toEqual([{ id: 1, role: 'user', text: 'Mori' }]);
  });

  test('an empty answer is still an answer, and says so', () => {
    const convo = answeredQuestion(queried(emptyConvo(opening), question), '   ');
    expect(convo.feed).toEqual([{ id: 1, role: 'user', text: '(no answer)' }]);
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
});

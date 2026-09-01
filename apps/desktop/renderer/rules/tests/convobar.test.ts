import { compactAction, newThreadAction, resumeAction, stopTurnAction } from '../convobar.js';
import type { Convo, ResumeHeader } from '../../../src/shared/convo.js';
import { NATIVE_VERSION, type OpenedThread } from '../../../src/shared/threads.js';

const state = (over: Partial<Convo> = {}): Convo =>
  ({
    feed: [],
    line: '',
    plan: null,
    question: null,
    confirm: null,
    busy: false,
    suggestions: [],
    compactions: [],
    ...over,
  }) as Convo;

const said = (id: number): Convo['feed'][number] => ({ id, role: 'user', text: 'hello' });

const header: ResumeHeader = {
  v: NATIVE_VERSION,
  thread: 't1',
  at: '2026-08-22T14:00:28.041Z',
  backend: 'native',
  vendor: 'anthropic',
  model: 'claude-opus-5',
  sections: [],
};

const thread = (over: Partial<OpenedThread> = {}): OpenedThread =>
  ({ id: 't1', title: 'Casting', resume: { header }, ...over }) as OpenedThread;

describe('compactAction', () => {
  it('folds a conversation that has something new in it', () => {
    expect(compactAction(state({ feed: [said(1)] }), false)).toMatchObject({
      ok: true,
      id: 'agent.compact',
    });
  });

  it('refuses mid-turn, while reading, when empty, and when nothing is new', () => {
    const reasons = [
      compactAction(state({ busy: true, feed: [said(1)] }), false),
      compactAction(state({ feed: [said(1)] }), true),
      compactAction(state(), false),
      compactAction(
        state({ feed: [said(1)], compactions: [{ afterId: 1, covers: 2, text: 'earlier' }] }),
        false,
      ),
    ];
    for (const offer of reasons) expect(offer).toMatchObject({ ok: false, id: 'agent.compact' });
    expect(new Set(reasons.map((offer) => (offer.ok ? '' : offer.reason))).size).toBe(4);
  });
});

describe('resumeAction', () => {
  it('continues a thread the bound model recorded', () => {
    expect(resumeAction(thread(), 'claude-opus-5')).toMatchObject({
      ok: true,
      id: 'agent.resumeThread',
      props: { id: 't1' },
    });
  });

  it('passes on the shared refusal rather than writing one of its own', () => {
    const offer = resumeAction(thread({ resume: { damaged: true } }), 'claude-opus-5');
    expect(offer.ok).toBe(false);
    if (!offer.ok) expect(offer.reason).toContain('no longer intact');
  });

  it('refuses when nothing is open for reading', () => {
    expect(resumeAction(undefined, 'claude-opus-5')).toMatchObject({ ok: false });
  });
});

describe('the buttons that need no state', () => {
  it('stops only a turn that is running', () => {
    expect(stopTurnAction(true)).toMatchObject({ ok: true, id: 'agent.stop' });
    expect(stopTurnAction(false)).toMatchObject({ ok: false, id: 'agent.stop' });
  });

  it('always offers a fresh conversation', () => {
    expect(newThreadAction()).toMatchObject({ ok: true, id: 'agent.newThread' });
  });
});

import {
  allowAction,
  budgetAction,
  compact,
  compactAction,
  controls,
  decideAction,
  effortAction,
  newThreadAction,
  resumeAction,
  stopTurnAction,
  threadsAction,
  threadsMenu,
  type ConvoBarState,
} from '../convobar.js';
import { modeAction, modelAction } from '../headerbar.js';
import { duplicateKeys, keyOf } from '../anchors.js';
import {
  contextDetail,
  type Convo,
  type ResumeHeader,
  type ThreadHeader,
} from '../../../src/shared/convo.js';
import { NATIVE_VERSION, type OpenedThread } from '../../../src/shared/threads.js';

const state = (over: Partial<Convo> = {}): Convo =>
  ({
    feed       : [],
    line       : '',
    plan       : null,
    question   : null,
    confirm    : null,
    busy       : false,
    suggestions: [],
    compactions: [],
    ...over,
  }) as Convo;

const said = (id: number): Convo['feed'][number] => ({ id, role: 'user', text: 'hello' });

const header: ResumeHeader = {
  v       : NATIVE_VERSION,
  thread  : 't1',
  at      : '2026-08-22T14:00:28.041Z',
  backend : 'native',
  vendor  : 'anthropic',
  model   : 'claude-opus-5',
  sections: [],
};

const thread = (over: Partial<OpenedThread> = {}): OpenedThread =>
  ({ id: 't1', title: 'Casting', resume: { header }, ...over }) as OpenedThread;

describe('compactAction', () => {
  it('folds a conversation that has something new in it, saying how much there is', () => {
    const convo = state({ feed: [said(1)], context: 41_208 });
    expect(compactAction(convo, false)).toEqual({
      ok     : true,
      id     : 'agent.compact',
      props  : {},
      label  : 'Compact',
      tooltip: contextDetail(convo),
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
    expect(new Set(reasons.map((offer) => (offer.ok ? '' : offer.refusal.reason))).size).toBe(4);
  });
});

describe('resumeAction', () => {
  it('continues a thread the bound model recorded', () => {
    expect(resumeAction(thread(), 'claude-opus-5')).toEqual({
      ok     : true,
      id     : 'agent.resumeThread',
      props  : { id: 't1' },
      label  : 'Continue',
      tooltip: 'Continue this conversation — the agent is shown everything above.',
    });
  });

  it('passes on the shared refusal rather than writing one of its own', () => {
    const offer = resumeAction(thread({ resume: { damaged: true } }), 'claude-opus-5');
    expect(offer.ok).toBe(false);
    if (!offer.ok) expect(offer.refusal.reason).toContain('no longer intact');
  });

  it('refuses when nothing is open for reading', () => {
    expect(resumeAction(undefined, 'claude-opus-5')).toMatchObject({ ok: false });
  });
});

describe('the buttons that need no state', () => {
  it('stops only a turn that is running', () => {
    expect(stopTurnAction(true)).toMatchObject({ ok: true, id: 'agent.stop', label: 'Stop' });
    expect(stopTurnAction(false)).toMatchObject({ ok: false, id: 'agent.stop' });
  });

  it('always offers a fresh conversation', () => {
    expect(newThreadAction()).toMatchObject({ ok: true, id: 'agent.newThread', label: 'New' });
  });
});

describe('controls', () => {
  const fixtures: ConvoBarState[] = [
    {
      convo    : state({ feed: [said(1)] }),
      opened   : undefined,
      model    : 'claude-opus-5',
      agentMode: 'plan',
      effort   : 'low',
      budget   : '200k',
      spent    : 0,
    },
    {
      convo    : state({ busy: true }),
      opened   : thread(),
      model    : 'claude-opus-5',
      agentMode: 'execute',
      effort   : 'high',
      budget   : 'unlimited',
      spent    : 12,
    },
  ];

  it('adds the plan card’s and the confirm card’s buttons while each is waiting', () => {
    const plan = { id: 1, plan: { summary: 'Recast Aiko.', steps: [], files: [] } };
    const confirm = { id: 2, tool: 'run_pipeline', detail: 'Run it.' };
    const bare = fixtures[0]!;
    expect(
      controls({ ...bare, convo: state({ plan }) })
        .map(keyOf)
        .slice(-2),
    ).toEqual(['fx:agent.answer#plan/reject', 'fx:agent.answer#plan/approve']);
    expect(
      controls({ ...bare, convo: state({ confirm }) })
        .map(keyOf)
        .slice(-2),
    ).toEqual(['fx:agent.answer#confirm/deny', 'fx:agent.answer#confirm/allow']);
    expect(decideAction(true)).toEqual({
      ok     : true,
      id     : 'agent.answer',
      props  : { to: 'plan', answer: 'approve' },
      on     : 'plan/approve',
      label  : 'Approve →',
      tooltip: 'Let the agent carry the plan out and commit it.',
    });
    expect(decideAction(false)).toMatchObject({ props: { answer: 'reject' }, label: 'Reject' });
    expect(allowAction('run_pipeline', false)).toMatchObject({
      props  : { to: 'confirm', answer: 'deny' },
      tooltip: 'Refuse run_pipeline. The agent is told and carries on.',
    });
    expect(allowAction('run_pipeline', true).tooltip).toBe('Let run_pipeline go ahead, this once.');
  });

  it('lists every control the functions produce, each key once', () => {
    for (const fixture of fixtures) {
      const listed = controls(fixture);
      const each = [
        modeAction(fixture.agentMode),
        modelAction(fixture.model),
        effortAction(fixture.model, fixture.effort),
        budgetAction(fixture.budget, fixture.spent),
        threadsAction(),
        newThreadAction(),
        compactAction(fixture.convo, fixture.opened !== undefined),
        resumeAction(fixture.opened, fixture.model),
        stopTurnAction(fixture.convo.busy),
      ];
      expect(new Set(listed.map(keyOf))).toEqual(new Set(each.map(keyOf)));
      expect(duplicateKeys(listed)).toEqual([]);
    }
  });
});

describe('compact', () => {
  it('rounds a count to what fits on a button', () => {
    expect(compact(842)).toBe('842');
    expect(compact(12_345)).toBe('12.3k');
    expect(compact(1_400_000)).toBe('1.40M');
  });
});

describe('threadsAction', () => {
  it('opens the saved conversations, with the menu supplying the id', () => {
    expect(threadsAction()).toMatchObject({
      ok      : true,
      id      : 'agent.openThread',
      props   : {},
      label   : 'Threads',
      supplies: ['id'],
    });
  });
});

describe('effortAction', () => {
  it('names the level in use, for a model that takes one', () => {
    expect(effortAction('claude-opus-5', 'high')).toEqual({
      ok      : true,
      id      : 'agent.setEffort',
      props   : {},
      label   : 'effort: high',
      tooltip : 'How hard the model thinks before answering. Higher costs more.',
      supplies: ['effort'],
    });
  });

  // The setting is kept across a model switch, so the menu is greyed rather than hidden
  it('greys the menu for a model with no thinking knob, keeping the level picked', () => {
    expect(effortAction('', 'low')).toMatchObject({
      ok     : false,
      id     : 'agent.setEffort',
      label  : 'effort: low',
      refusal: { reason: 'this model has no reasoning-effort setting.' },
    });
  });
});

describe('budgetAction', () => {
  it('names the ceiling alone before anything is spent', () => {
    expect(budgetAction('200k', 0)).toEqual({
      ok      : true,
      id      : 'agent.setBudget',
      props   : {},
      label   : 'budget 200k',
      tooltip:
        'What one turn may spend, counting fresh input and output but not what the cache served. ' +
        'This turn stops once it has spent 200k. Nothing spent on the last turn yet. The setting ' +
        'is remembered between sessions.',
      supplies: ['budget'],
    });
  });

  it('shows the spend against the ceiling once a turn is under way', () => {
    expect(budgetAction('200k', 12)).toMatchObject({
      label  : 'budget 12/200k',
      tooltip: expect.stringContaining('12 spent on this turn so far.'),
    });
  });

  it('never shows a spend against no ceiling', () => {
    expect(budgetAction('unlimited', 12)).toMatchObject({
      label  : 'budget unlimited',
      tooltip: expect.stringContaining('runs until it finishes'),
    });
  });
});

describe('threadsMenu', () => {
  const thread = (id: string, title: string) =>
    ({ id, title, startedAt: 'earlier', model: 'claude-opus-5' }) as ThreadHeader;

  it('lists one row per saved conversation, the open one marked, then a fresh start', () => {
    const rows = threadsMenu({
      threads: [thread('t1', 'Casting'), thread('t2', 'Wardrobe')],
      active : 't2',
    });
    expect(rows.map((row) => [row.id, row.label, row.on])).toEqual([
      ['agent.openThread', 'Casting', 't1'],
      ['agent.openThread', '• Wardrobe', 't2'],
      ['-', '-', undefined],
      ['agent.newThread', 'New conversation', undefined],
    ]);
    expect(rows[0]).toMatchObject({ props: { id: 't1' }, tooltip: 'earlier · claude-opus-5' });
  });

  it('says why with nothing saved, in one refused row', () => {
    expect(threadsMenu({ threads: [] })[0]).toEqual({
      label  : '(nothing saved yet)',
      id     : 'agent.openThread',
      refused: 'A conversation is saved once you have said something in it.',
    });
  });
});

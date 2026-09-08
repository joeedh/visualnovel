/**
 * Reducing the debug conversation. Two things are pinned: a filed report lands where it happened
 * rather than at the end, and rebuilding from `report.state` gives a pane that mounted late the
 * same conversation a pane that was there all along has.
 */
import {
  GRANT_LABELS,
  REPORT_OPENING,
  controls,
  emptyReport,
  fromState,
  grantAction,
  grantBox,
  reduceRow,
  startAction,
  stopAction,
  STOP_TIP,
  type GrantBox,
  type ReportConvo,
} from '../reportconvo.js';
import { duplicateKeys, keyOf } from '../anchors.js';
import type { Report } from '@vn/agentreport';
import type { CommandCheck, ReportRow, ReportStateView } from '../../../src/shared/ipc.js';

/** Only the fields the reducers read; the rest of a report never leaves main. */
const REPORT = {} as Report;

function filed(title: string, file?: string): ReportRow {
  return { kind: 'filed', report: REPORT, title, body: `# ${title}`, ...(file ? { file } : {}) };
}

function state(rows: ReportRow[], over: Partial<ReportStateView> = {}): ReportStateView {
  return { busy: false, granted: { source: false, detail: false }, rows, ...over };
}

describe('one row at a time', () => {
  it('opens on the sentence that says what to do first', () => {
    expect(emptyReport().convo.line).toBe(REPORT_OPENING);
    expect(emptyReport().convo.feed).toEqual([]);
  });

  it('shows the author’s turn before it has been answered', () => {
    const after = reduceRow(emptyReport(), { kind: 'said', text: 'it lost my scene' });
    expect(after.convo.feed.map((item) => [item.role, item.text])).toEqual([
      ['user', 'it lost my scene'],
    ]);
    expect(after.convo.busy).toBe(true);
  });

  it('keeps a filed report beside the feed, at the turn it followed', () => {
    let convo: ReportConvo = emptyReport();
    convo = reduceRow(convo, { kind: 'said', text: 'what happened?' });
    convo = reduceRow(convo, { kind: 'event', event: { type: 'message', text: 'here it is' } });
    convo = reduceRow(convo, filed('edit_scene dropped a line', 'C:/reports/one.md'));
    convo = reduceRow(convo, { kind: 'said', text: 'anything else?' });

    expect(convo.convo.feed.length).toBe(3);
    expect(convo.reports).toEqual([
      {
        after: 2,
        title: 'edit_scene dropped a line',
        body : '# edit_scene dropped a line',
        file : 'C:/reports/one.md',
      },
    ]);
  });

  it('leaves the file out when nowhere kept a copy', () => {
    const convo = reduceRow(emptyReport(), filed('no copy'));
    expect(convo.reports[0]).not.toHaveProperty('file');
  });
});

describe('rebuilding from what main holds', () => {
  it('gives a late pane the conversation a pane that was open already has', () => {
    const rows: ReportRow[] = [
      { kind: 'said', text: 'what happened?' },
      { kind: 'event', event: { type: 'message', text: 'here it is' } },
      filed('a report'),
    ];
    const live = rows.reduce(reduceRow, emptyReport());
    const late = fromState(emptyReport(), state(rows));
    expect(late.convo.feed).toEqual(live.convo.feed);
    expect(late.reports).toEqual(live.reports);
  });

  /** `asked` raises `busy`, and the last row is usually the turn main has since answered. */
  it('takes busy from main rather than from the last row', () => {
    const rows: ReportRow[] = [{ kind: 'said', text: 'what happened?' }];
    expect(fromState(emptyReport(), state(rows)).convo.busy).toBe(false);
    expect(fromState(emptyReport(), state(rows, { busy: true })).convo.busy).toBe(true);
  });

  it('keeps the setup card, the thread list and the note, which main knows nothing about', () => {
    const base: ReportConvo = {
      ...emptyReport(),
      note   : 'The model API refused this turn.',
      threads: [{ id: 't1', title: 'a bad turn', startedAt: '2026-08-21T10:00:00.000Z' }],
      setup  : { thread: 't1', model: 'opus', effort: 'high', source: true, detail: true },
    };
    const next = fromState(base, state([], { thread: { id: 't1', title: 'a bad turn' } }));
    expect(next.note).toBe(base.note);
    expect(next.threads).toEqual(base.threads);
    expect(next.setup).toEqual(base.setup);
    expect(next.thread).toEqual({ id: 't1', title: 'a bad turn' });
  });

  it('drops the conversation when main is holding none', () => {
    const base = fromState(emptyReport(), state([], { thread: { id: 't1', title: 'gone' } }));
    expect(fromState(base, state([])).thread).toBeUndefined();
  });

  it('never doubles a report a redraw replays', () => {
    const rows: ReportRow[] = [{ kind: 'said', text: 'go on' }, filed('a report')];
    const once = fromState(emptyReport(), state(rows));
    expect(fromState(once, state(rows)).reports).toEqual(once.reports);
  });

  it('reads the grants from main, because granting is one-way there', () => {
    const granted = fromState(
      emptyReport(),
      state([], { granted: { source: true, detail: false } }),
    );
    expect(granted.granted).toEqual({ source: true, detail: false });
  });
});

/**
 * The two boxes on the opened card. A mock workspace refuses to open a conversation at all, so
 * these are what says the boxes are right; the setup card's own two are verified over CDP.
 */
describe('a grant box', () => {
  const OFFER = 'The debug agent reads this app’s own code and design docs.';

  it('offers an access while the command still accepts it', () => {
    const accept = { state: 'accept' as const, message: 'The debug agent gets the source.' };
    expect(grantBox(false, accept, OFFER)).toEqual({
      checked : false,
      disabled: false,
      tooltip : 'The debug agent gets the source.',
    });
  });

  it('reads the offer until a verdict lands', () => {
    expect(grantBox(false, undefined, OFFER)).toEqual({
      checked : false,
      disabled: false,
      tooltip : OFFER,
    });
  });

  it('sticks on a grant already made, and says the command refused to repeat it', () => {
    const refuse = {
      state  : 'refuse' as const,
      message: 'The debug agent has already been shown the source.',
    };
    expect(grantBox(true, refuse, OFFER)).toEqual({
      checked : true,
      disabled: true,
      tooltip : OFFER,
      refusal : { reason: 'The debug agent has already been shown the source.' },
    });
  });

  it('greys an access there is nothing to hand over, unticked, with the reason', () => {
    const refuse = { state: 'refuse' as const, message: 'Nothing was sent to the model API.' };
    expect(grantBox(false, refuse, OFFER)).toEqual({
      checked : false,
      disabled: true,
      tooltip : OFFER,
      refusal : { reason: 'Nothing was sent to the model API.' },
    });
  });

  /** A verdict lags a grant by one round trip, and the tick is what already happened. */
  it('stays ticked while the stale verdict still says yes, and says why it is greyed', () => {
    const accept = { state: 'accept' as const, message: 'The debug agent gets the source.' };
    const box = grantBox(true, accept, OFFER);
    expect(box.disabled).toBe(true);
    expect(box.refusal?.reason).toContain('already been granted');
  });

  it('is offered as the command it runs, told apart by the access it grants', () => {
    const open = grantBox(false, undefined, OFFER);
    expect(grantAction('detail', open)).toEqual({
      ok     : true,
      id     : 'report.grant',
      props  : { access: 'detail' },
      label  : GRANT_LABELS.detail,
      tooltip: OFFER,
      on     : 'detail',
    });
    const spent = grantBox(true, undefined, OFFER);
    expect(grantAction('source', spent)).toMatchObject({
      ok     : false,
      on     : 'source',
      refusal: spent.refusal,
    });
  });
});

describe('stopAction', () => {
  it('stops the debug agent after the step it is on', () => {
    expect(stopAction()).toEqual({
      ok     : true,
      id     : 'report.stop',
      props  : {},
      label  : 'Stop',
      tooltip: STOP_TIP,
    });
  });
});

describe('startAction', () => {
  const ACCEPT: CommandCheck = { state: 'accept', message: 'Reads 40 turns.' };
  const REFUSE: CommandCheck = { state: 'refuse', message: 'No key resolves for that model.' };
  const ready = (over: Partial<ReportConvo> = {}): ReportConvo => ({
    ...emptyReport(),
    setup: { thread: 't1', model: 'claude-opus-5', effort: 'low', source: false, detail: true },
    ...over,
  });

  it('starts the read on the setup as it stands, before any verdict is in', () => {
    expect(startAction(ready(), false)).toEqual({
      ok     : true,
      id     : 'report.open',
      props: {
        thread: 't1',
        model : 'claude-opus-5',
        effort: 'low',
        source: false,
        detail: true,
        note  : '',
      },
      label  : 'Start →',
      tooltip: 'Have the debug agent read this conversation and say what went wrong.',
    });
  });

  it('reads as switching conversations while one is already open', () => {
    expect(startAction(ready(), true).label).toBe('Read This One →');
  });

  it('takes an accepted verdict’s sentence as its tooltip', () => {
    expect(startAction(ready(), false, ACCEPT)).toMatchObject({
      ok     : true,
      tooltip: ACCEPT.message,
    });
  });

  it('refuses with the command’s own sentence, then while the analyst is busy', () => {
    const busy = ready({ convo: { ...emptyReport().convo, busy: true } });
    expect(startAction(busy, false, REFUSE)).toMatchObject({
      ok     : false,
      id     : 'report.open',
      refusal: { reason: REFUSE.message },
    });
    expect(startAction(busy, false, ACCEPT)).toMatchObject({
      ok     : false,
      refusal: { reason: 'The debug agent is still on the last turn.' },
    });
  });
});

describe('controls', () => {
  it('lists Start, Stop and both boxes, each key once', () => {
    const boxes: Record<'source' | 'detail', GrantBox> = {
      source: grantBox(true, undefined, 'source'),
      detail: grantBox(false, undefined, 'detail'),
    };
    for (const changing of [false, true]) {
      const listed = controls({ state: emptyReport(), changing, boxes });
      const each = [
        startAction(emptyReport(), changing),
        stopAction(),
        grantAction('source', boxes.source),
        grantAction('detail', boxes.detail),
      ];
      expect(new Set(listed.map(keyOf))).toEqual(new Set(each.map(keyOf)));
      expect(duplicateKeys(listed)).toEqual([]);
    }
  });
});

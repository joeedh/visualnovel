/**
 * Reducing the debug conversation. Two things are pinned: a filed report lands where it happened
 * rather than at the end, and rebuilding from `report.state` gives a pane that mounted late the
 * same conversation a pane that was there all along has.
 */
import {
  REPORT_OPENING,
  emptyReport,
  fromState,
  grantBox,
  reduceRow,
  type ReportConvo,
} from '../reportconvo.js';
import type { Report } from '@vn/agentreport';
import type { ReportRow, ReportStateView } from '../../../src/shared/ipc.js';

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
        body: '# edit_scene dropped a line',
        file: 'C:/reports/one.md',
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
      note: 'The model API refused this turn.',
      threads: [{ id: 't1', title: 'a bad turn', startedAt: '2026-08-21T10:00:00.000Z' }],
      setup: { thread: 't1', model: 'opus', effort: 'high', source: true, detail: true },
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
      checked: false,
      disabled: false,
      tooltip: 'The debug agent gets the source.',
    });
  });

  it('reads the offer until a verdict lands', () => {
    expect(grantBox(false, undefined, OFFER)).toEqual({
      checked: false,
      disabled: false,
      tooltip: OFFER,
    });
  });

  it('sticks on a grant already made, and says the command refused to repeat it', () => {
    const refuse = {
      state: 'refuse' as const,
      message: 'The debug agent has already been shown the source.',
    };
    expect(grantBox(true, refuse, OFFER)).toEqual({
      checked: true,
      disabled: true,
      tooltip: 'The debug agent has already been shown the source.',
    });
  });

  it('greys an access there is nothing to hand over, unticked, with the reason', () => {
    const refuse = { state: 'refuse' as const, message: 'Nothing was sent to the model API.' };
    expect(grantBox(false, refuse, OFFER)).toEqual({
      checked: false,
      disabled: true,
      tooltip: 'Nothing was sent to the model API.',
    });
  });

  /** A verdict lags a grant by one round trip, and the tick is what already happened. */
  it('stays ticked while the stale verdict still says yes', () => {
    const accept = { state: 'accept' as const, message: 'The debug agent gets the source.' };
    expect(grantBox(true, accept, OFFER).disabled).toBe(true);
  });
});

/**
 * The debug conversation, as a value.
 *
 * A live `report:event` and a row returned by `report.state` are reduced by the same functions, so
 * a pane that mounts part way through shows what a pane that was there all along shows. The rules
 * are here rather than beside the store because the store reaches `api.ts`, which touches `window`
 * at module scope and cannot be loaded by the node-only jest project.
 */
import {
  asked,
  emptyConvo,
  received,
  type Convo,
  type ThreadHeader,
} from '../../src/shared/convo.js';
import type { CommandCheck, ReportRow, ReportStateView } from '../../src/shared/ipc.js';
import type { Refusal } from 'pathux';
import { refuse, type Offer } from './anchors.js';

/** What the dialogue box says before the analyst has been asked anything. */
export const REPORT_OPENING = 'Pick the conversation that went wrong, then press Start.';

/** One report the analyst filed, and where it sits in the transcript. */
export interface FiledReport {
  /** The feed position it was filed after, so its card is drawn where it happened. */
  after: number;
  title: string;
  body: string;
  /** Where a copy was kept, when there was somewhere to keep one. */
  file?: string;
}

/** What the setup card holds: the five things `report.open` is started with. */
export interface ReportSetup {
  thread: string;
  model: string;
  effort: string;
  source: boolean;
  detail: boolean;
}

export interface ReportConvo {
  /** The conversation under analysis. Absent until the analyst has been started. */
  thread?: { id: string; title: string };
  convo: Convo;
  /** Which access the analyst has been given. Granting is one-way, so neither goes back. */
  granted: { source: boolean; detail: boolean };
  reports: readonly FiledReport[];
  setup: ReportSetup;
  /** The conversations this project holds, for the setup card's menu. */
  threads: readonly ThreadHeader[];
  /** One sentence saying why the pane opened by itself. Empty when the author asked for it. */
  note: string;
}

export function emptyReport(): ReportConvo {
  return {
    convo  : emptyConvo(REPORT_OPENING),
    granted: { source: false, detail: false },
    reports: [],
    setup  : { thread: '', model: '', effort: '', source: false, detail: false },
    threads: [],
    note   : '',
  };
}

/** The two accesses a debug conversation can be given. */
export type GrantKind = keyof ReportConvo['granted'];

/** What each grant box says beside its tick, on the setup card and the opened card alike. */
export const GRANT_LABELS: Record<GrantKind, string> = {
  source: 'Read the source code',
  detail: 'Read the requests this app sent',
};

/** How one of the two grant boxes draws. */
export interface GrantBox {
  checked: boolean;
  disabled: boolean;
  /** What the access buys, or the command's own acceptance once it has said so. */
  tooltip: string;
  /** Why the box is greyed, composed above the tooltip. */
  refusal?: Refusal;
}

/**
 * One grant box, from what has been granted and what `report.grant` said about granting it. A grant
 * does not come back off, so a ticked box is disabled and carries the command's refusal to repeat
 * it. `offer` stands in until a verdict arrives.
 */
export function grantBox(
  granted: boolean,
  verdict: CommandCheck | undefined,
  offer: string,
): GrantBox {
  const refusal =
    verdict?.state === 'refuse'
      ? { reason: verdict.message }
      : granted
        ? { reason: 'This access has already been granted, and a grant does not come back off.' }
        : undefined;
  return {
    checked : granted,
    disabled: refusal !== undefined,
    tooltip : verdict?.state === 'accept' ? verdict.message : offer,
    ...(refusal ? { refusal } : {}),
  };
}

/** Grant the open conversation one access, as the box `grantBox` just described would run it. */
export function grantAction(kind: GrantKind, box: GrantBox): Offer {
  const control = { id: 'report.grant', label: GRANT_LABELS[kind], tooltip: box.tooltip, on: kind };
  if (box.refusal) return { ...refuse(box.refusal.reason), ...control };
  return { ok: true, props: { access: kind }, ...control };
}

/** Every offer the report pane draws from this module: the two grant boxes, as they stand. */
export function controls(state: { boxes: Record<GrantKind, GrantBox> }): readonly Offer[] {
  return [grantAction('source', state.boxes.source), grantAction('detail', state.boxes.detail)];
}

/**
 * One row of the conversation. A filed report is held beside the feed rather than in it: the card
 * carries buttons and a body of its own, and `FeedItem` is a line of text.
 */
export function reduceRow(state: ReportConvo, row: ReportRow): ReportConvo {
  switch (row.kind) {
    case 'said':
      return { ...state, convo: asked(state.convo, row.text) };
    case 'event':
      return { ...state, convo: received(state.convo, row.event) };
    case 'filed':
      return {
        ...state,
        reports: [
          ...state.reports,
          {
            after: state.convo.seq,
            title: row.title,
            body : row.body,
            ...(row.file === undefined ? {} : { file: row.file }),
          },
        ],
      };
  }
}

/**
 * Rebuild the conversation from what main holds. The setup card, the thread list and the advice
 * note belong to this side and survive; everything main answers for is replaced.
 *
 * `busy` is applied after the fold because `asked` raises it and the last row is often the
 * author's own turn, which main has since answered.
 */
export function fromState(base: ReportConvo, view: ReportStateView): ReportConvo {
  const folded = view.rows.reduce(reduceRow, {
    ...base,
    convo  : emptyConvo(REPORT_OPENING),
    reports: [],
  });
  const next: ReportConvo = {
    convo  : { ...folded.convo, busy: view.busy },
    granted: { ...view.granted },
    reports: folded.reports,
    setup  : folded.setup,
    threads: folded.threads,
    note   : folded.note,
  };
  return view.thread ? { ...next, thread: view.thread } : next;
}

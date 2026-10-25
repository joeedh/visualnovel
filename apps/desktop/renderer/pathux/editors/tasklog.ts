/**
 * The drawer under a task card in the Tasks pane: the task's diagnostic log, or its reviewer
 * transcripts, as `pipeline:taskLog` returns them. Built as raw DOM inside the pane's surface and
 * styled by `styles/tasklist.css`.
 */
import type { DefectReport } from '@vn/types';
import { logModeAction, type CardFold, type LogMode } from '../../rules/tasklist.js';
import type { AnchorPass } from '../tour/anchors.js';
import type { Task, TaskLogView } from '../../../src/shared/ipc.js';

type Review = TaskLogView['reviews'][number];

/** What the drawer is drawn from, as the pane holds it. */
export interface FoldState {
  mode: LogMode;
  view?: TaskLogView;
  failure?: string;
}

/** What the drawer asks of the pane that owns it. */
export interface FoldHost {
  anchors: AnchorPass;
  /** Keys of the `<details>` blocks the author has opened, kept across redraws. */
  openDetails: Set<string>;
  setMode(mode: LogMode): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** `14:02:11` in local time, or a dash for a line recovered from a record with no time. */
function clock(at: string): string {
  const date = new Date(at);
  if (at === '' || Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], { hour12: false });
}

/** The counts the drawer's switch shows, for the pane and its anchors. */
export function foldCounts(state: FoldState): CardFold {
  const lines = state.view?.lines.length ?? 0;
  const reviews = state.view?.reviews.length ?? 0;
  return { mode: reviews === 0 ? 'log' : state.mode, lines, reviews };
}

/** Builds the drawer for one task. */
export function foldPanel(task: Task, state: FoldState, host: FoldHost): HTMLElement {
  const fold = foldCounts(state);
  const panel = el('div', 'tl-fold');

  const head = el('div', 'tl-fold-head');
  const seg = el('div', 'tl-seg');
  for (const mode of ['log', 'review'] as const) {
    const offer = logModeAction(task.hash, mode, fold);
    const button = el('button', `tl-seg-btn${fold.mode === mode ? ' on' : ''}`, offer.label);
    host.anchors.act(button, offer, () => host.setMode(mode));
    seg.appendChild(button);
  }
  head.appendChild(seg);
  head.appendChild(el('span', 'tl-local', 'kept on this machine · not committed'));
  panel.appendChild(head);

  if (state.failure !== undefined) {
    panel.appendChild(el('div', 'tl-empty bad', `Could not read the log: ${state.failure}`));
  } else if (!state.view) {
    panel.appendChild(el('div', 'tl-empty', 'Reading the log…'));
  } else if (fold.mode === 'review') {
    panel.appendChild(reviewList(task, state.view.reviews, host));
  } else {
    panel.appendChild(logLines(state.view));
  }
  return panel;
}

function logLines(view: TaskLogView): HTMLElement {
  if (view.lines.length === 0) {
    return el(
      'div',
      'tl-empty',
      'Nothing was logged. A task that ran without a retry or an error logs nothing, and one ' +
        'that ran before logs were kept shows only the failures its record holds.',
    );
  }
  const grid = el('div', 'tl-lines');
  for (const line of view.lines) {
    grid.appendChild(el('span', 'tl-time', clock(line.at)));
    grid.appendChild(el('span', `tl-tag ${line.level}`, line.level));
    const source = line.attempt === undefined ? line.source : `${line.source} #${line.attempt}`;
    grid.appendChild(el('span', 'tl-source', source));
    grid.appendChild(el('span', 'tl-text', line.text));
  }
  return grid;
}

/** Reviews grouped by run, newest first, then by attempt within a run. */
function reviewList(task: Task, reviews: readonly Review[], host: FoldHost): HTMLElement {
  const box = el('div', 'tl-reviews');
  const runs = new Map<string, Review[]>();
  for (const review of reviews) {
    const run = runs.get(review.execution) ?? [];
    run.push(review);
    runs.set(review.execution, run);
  }
  for (const run of [...runs.values()].reverse()) {
    const first = run[0]!;
    box.appendChild(el('div', 'tl-exec', `run · ${new Date(first.at).toLocaleString()}`));
    let attempt: number | undefined = -1;
    for (const review of [...run].sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0))) {
      if (review.attempt !== attempt) {
        attempt = review.attempt;
        if (attempt !== undefined) box.appendChild(el('div', 'tl-attempt', `Attempt ${attempt}`));
      }
      box.appendChild(reviewCard(task, review, host));
    }
  }
  return box;
}

/** The verdict this reviewer gave on the attempt, read from the task record. */
function verdictOf(task: Task, review: Review): DefectReport | undefined {
  if (review.attempt === undefined) return undefined;
  return task.attempts[review.attempt - 1]?.reviews.find((r) => r.reviewer === review.reviewer);
}

function verdictChip(review: Review, report: DefectReport | undefined): HTMLElement {
  if (review.error !== undefined) return el('span', 'tl-verdict failed', 'failed');
  if (!report) return el('span', 'tl-verdict none', 'no verdict');
  const blocking = report.defects.filter((d) => d.severity === 'blocking').length;
  if (blocking > 0) return el('span', 'tl-verdict blocking', `${blocking} blocking`);
  if (report.defects.length > 0) {
    return el('span', 'tl-verdict minor', `${report.defects.length} not blocking`);
  }
  return el('span', 'tl-verdict clean', 'clean');
}

function reviewCard(task: Task, review: Review, host: FoldHost): HTMLElement {
  const card = el('div', 'tl-review');
  const report = verdictOf(task, review);

  const head = el('div', 'tl-review-head');
  head.appendChild(el('span', 'tl-who', review.reviewer));
  if (review.model) head.appendChild(el('span', 'tl-model', review.model));
  head.appendChild(el('span', 'tl-ms', `${(review.ms / 1000).toFixed(1)}s`));
  head.appendChild(verdictChip(review, report));
  card.appendChild(head);

  const key = `${review.execution}/${review.at}/${review.reviewer}`;
  card.appendChild(folded(`${key}/system`, 'System prompt', review.systemText, host));
  card.appendChild(folded(`${key}/prompt`, 'Prompt', review.prompt, host));

  review.responses.forEach((reply, i) => {
    const bad = i < review.responses.length - 1 || review.error !== undefined;
    const label = `reply ${i + 1}${bad ? ' · did not parse' : ''}`;
    card.appendChild(el('div', 'tl-reply-label', label));
    card.appendChild(el('pre', `tl-pre reply${bad ? ' bad' : ''}`, reply));
  });

  if (review.error !== undefined) card.appendChild(el('div', 'tl-error', review.error));

  if (report && report.defects.length > 0) {
    const list = el('ul', 'tl-defects');
    for (const defect of report.defects) {
      const item = el('li', 'tl-defect');
      item.appendChild(el('span', `tl-sev ${defect.severity}`, defect.severity));
      const fix = defect.suggestedFix ? ` — fix: ${defect.suggestedFix}` : '';
      item.appendChild(el('span', '', `${defect.category}: ${defect.description}${fix}`));
      list.appendChild(item);
    }
    card.appendChild(list);
  }

  const chips = el('div', 'tl-chips');
  review.images.forEach((image, i) => {
    const what = i === 0 ? 'drawn' : 'ref';
    const chip = el(
      'span',
      'tl-chip',
      `${what} ${image.inline ? 'inline ' : ''}${image.hash.slice(0, 8)}`,
    );
    chip.title =
      i === 0
        ? `The picture under review, ${image.hash}`
        : image.inline
          ? `A reference drawn for this review and never stored; its bytes hash to ${image.hash}`
          : `A reference image the reviewer was shown, ${image.hash}`;
    chips.appendChild(chip);
  });
  card.appendChild(chips);
  return card;
}

/** A closed-by-default block whose open state survives a redraw. */
function folded(key: string, title: string, text: string, host: FoldHost): HTMLElement {
  const details = el('details');
  details.open = host.openDetails.has(key);
  const summary = el('summary', '', title);
  summary.title = `Show or hide the ${title.toLowerCase()} this reviewer was sent`;
  details.appendChild(summary);
  details.appendChild(el('pre', 'tl-pre', text));
  details.addEventListener('toggle', () => {
    if (details.open) host.openDetails.add(key);
    else host.openDetails.delete(key);
  });
  return details;
}

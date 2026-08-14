import type { Container } from 'pathux';
import { api } from '../../api.js';
import {
  attemptOutcome,
  correctionDelta,
  mergeAttemptReviews,
  promptRepeated,
  triageOf,
  type AttemptOutcome,
  type MergedDefect,
  type TriageSummary,
} from '../../rules/attempts.js';
import { subjectOf } from '../../rules/taskGraph.js';
import { card, centered, dot, mono, note, row, stamp, statusColour } from '../dom.js';
import { VnEditor, registerEditor } from '../editor.js';
import { TOKENS, alpha } from '../tokens.js';
import type { PipelineStatus, Task, TaskAttempt } from '../../../src/shared/ipc.js';

const VERDICT: Record<AttemptOutcome, string> = {
  accepted: '✓ accepted',
  rejected: '✕ rejected',
  failed: '⚠ failed',
  pending: '· in flight',
};

const OUTCOME_COLOUR: Record<AttemptOutcome, string> = {
  accepted: TOKENS.jade,
  rejected: TOKENS.mistDim,
  failed: TOKENS.vermilion,
  pending: TOKENS.signal,
};

const SEVERITY_COLOUR: Record<string, string> = {
  blocking: TOKENS.vermilion,
  major: TOKENS.sodium,
  minor: TOKENS.mistDim,
};

/**
 * Per-task detail: identity, why it stopped if it stopped badly, and P7's generate → critique →
 * refine loop as a vertical spine. The rules are `rules/attempts.ts` untouched — the merge,
 * the `Corrections:` delta, the outcome and the triage all still have their own tests — so this
 * is the React `Inspector` + `AttemptLoop` markup and nothing else.
 *
 * Its subject is `ui.taskHash`, which every task surface publishes, so the inspector follows the
 * list and the graph without either of them knowing it is open.
 */
export class InspectorEditor extends VnEditor {
  private bar!: Container;
  private body!: HTMLDivElement;

  private status: PipelineStatus | undefined;
  private failure = '';
  private drawn = '';
  /** The hash the cached status was fetched for, so a task that is not in it is re-fetched once. */
  private fetchedFor = '';

  static override define() {
    return {
      tagname: 'vn-inspector-editor-x',
      areaname: 'inspector',
      uiname: 'Inspector',
      icon: -1,
    };
  }

  override init() {
    super.init();

    this.bar = (this.header as Container).row();

    this.body = document.createElement('div');
    Object.assign(this.body.style, {
      position: 'relative',
      overflowY: 'auto',
      background: TOKENS.inkSunken,
      padding: '10px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    });
    this.appendSurface(this.body);

    void this.load();
  }

  override update() {
    super.update();

    // A hash the cached status has never heard of is a task planned since the last read, not a
    // missing one — so the miss is what triggers the re-fetch, and it triggers it once.
    const hash = this.ui.taskHash;
    if (hash !== '' && hash !== this.fetchedFor && !this.task()) {
      this.fetchedFor = hash;
      void this.load();
      return;
    }
    if (this.stateKey() !== this.drawn) this.rebuild();
  }

  private async load(): Promise<void> {
    try {
      this.status = await api.invoke('pipeline:status');
      this.failure = '';
    } catch (err) {
      this.failure = err instanceof Error ? err.message : String(err);
    }
    this.rebuild();
  }

  private task(): Task | undefined {
    return this.status?.tasks.find((t) => t.hash === this.ui.taskHash);
  }

  private stateKey(): string {
    const task = this.task();
    return [this.failure, this.ui.taskHash, task?.status ?? '', task?.attempts.length ?? -1].join(
      '|',
    );
  }

  private rebuild(): void {
    this.drawn = this.stateKey();
    this.rebuildBar();
    this.rebuildBody();
  }

  private rebuildBar(): void {
    const task = this.task();

    this.bar.clear();
    this.bar.label('INSPECTOR').style['padding'] = '0px 8px';
    this.bar.label(task ? subjectOf(task) : '—').style['padding'] = '0px 8px';
    this.bar.button('Refresh', () => void this.load());
    this.bar.flushUpdate();
  }

  private rebuildBody(): void {
    this.body.textContent = '';

    if (this.failure) return void this.body.appendChild(note(this.failure, TOKENS.vermilion));

    const task = this.task();
    if (!task) {
      return void this.body.appendChild(
        centered(
          this.ui.taskHash
            ? 'That task is not in the current plan — it may have been re-keyed by an edit.'
            : 'Select a task to inspect its attempts.',
        ),
      );
    }

    this.body.appendChild(this.identity(task));

    const triage = triageOf(task);
    if (triage) this.body.appendChild(this.triage(triage));

    this.body.appendChild(stamp('ATTEMPTS · generate → critique → refine', TOKENS.mist, 9.5));

    if (task.attempts.length === 0) {
      this.body.appendChild(
        note(
          task.kind === 'shot_image'
            ? 'No attempts recorded yet.'
            : 'This kind runs in a single pass — it records no per-attempt critique.',
        ),
      );
      return;
    }

    for (const [i, attempt] of task.attempts.entries()) {
      const prev = i > 0 ? task.attempts[i - 1] : undefined;
      if (i > 0) this.body.appendChild(this.correction(prev, attempt));
      this.body.appendChild(this.attemptCard(task, attempt, i));
    }
  }

  private identity(task: Task): HTMLElement {
    const colour = statusColour(task.status);
    const box = card();
    box.style.flex = 'none';
    box.style.borderLeft = `2px solid ${colour}`;

    const head = row();
    head.appendChild(dot(colour));
    head.appendChild(mono(task.kind, TOKENS.paper, 12));
    const st = mono(task.status, colour, 11);
    st.style.marginLeft = 'auto';
    head.appendChild(st);
    box.appendChild(head);

    // The full hash, not the short one: this is the pane you copy an identity out of.
    const hash = mono(task.hash, TOKENS.mistDim, 10);
    hash.style.wordBreak = 'break-all';
    box.appendChild(hash);

    const counts = row();
    counts.appendChild(mono(`deps ${task.deps.length}`, TOKENS.mist, 10.5));
    counts.appendChild(mono(`attempts ${task.attempts.length}`, TOKENS.mist, 10.5));
    box.appendChild(counts);
    return box;
  }

  /** Why the loop gave up, named — not just that it did. */
  private triage(triage: TriageSummary): HTMLElement {
    const box = card();
    Object.assign(box.style, {
      flex: 'none',
      border: `1px solid ${alpha(TOKENS.vermilion, 0.45)}`,
      background: alpha(TOKENS.vermilion, 0.06),
    });
    box.appendChild(mono(triage.headline, TOKENS.paper, 11.5));

    if (triage.reason !== null) {
      box.appendChild(mono(triage.reason, TOKENS.mist, 11));
      return box;
    }
    for (const defect of triage.defects) box.appendChild(this.defect(defect, true));
    return box;
  }

  /** The causal step between two attempts: the `Corrections:` clause the critique produced. */
  private correction(prev: TaskAttempt | undefined, next: TaskAttempt): HTMLElement {
    const delta = correctionDelta(prev, next);
    const line = document.createElement('div');
    Object.assign(line.style, {
      flex: 'none',
      margin: '0px 0px 0px 14px',
      padding: '4px 0px 4px 12px',
      borderLeft: `1px dashed ${delta ? alpha(TOKENS.sodium, 0.5) : TOKENS.inkLine}`,
      color: delta ? TOKENS.paper : TOKENS.mistDim,
      fontFamily: TOKENS.prose,
      fontSize: '13px',
      fontStyle: delta ? 'normal' : 'italic',
      lineHeight: '1.45',
    });
    line.textContent = delta
      ? `✎ ${delta}`
      : promptRepeated(prev, next)
        ? 'same critique — the prompt did not change'
        : 'no correction recorded';
    return line;
  }

  private attemptCard(task: Task, attempt: TaskAttempt, index: number): HTMLElement {
    const outcome = attemptOutcome(task, attempt, index);
    const { defects } = mergeAttemptReviews(attempt.reviews);
    const reviewers = new Set(task.attempts.flatMap((a) => a.reviews.map((r) => r.reviewer)));

    const box = card();
    box.style.flex = 'none';
    box.style.borderLeft = `2px solid ${OUTCOME_COLOUR[outcome]}`;

    const head = row();
    head.appendChild(
      stamp(`ATTEMPT ${String(attempt.attempt ?? index + 1).padStart(2, '0')}`, TOKENS.mist, 9.5),
    );
    head.appendChild(mono(VERDICT[outcome], OUTCOME_COLOUR[outcome], 10.5));
    const hash = mono(attempt.output ? attempt.output.slice(0, 8) : '—', TOKENS.mistDim, 10);
    hash.style.marginLeft = 'auto';
    head.appendChild(hash);
    box.appendChild(head);

    // Every attempt's bytes are in the store — only the clean one was `accept`ed, not the only
    // one generated, so a rejected frame is still here to look at.
    const url =
      attempt.output && attempt.outputExt
        ? `vnasset://${attempt.output}.${attempt.outputExt}`
        : undefined;
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = `attempt ${attempt.attempt ?? index + 1} output`;
      img.draggable = false;
      Object.assign(img.style, {
        width: '100%',
        borderRadius: `${TOKENS.radiusChrome}px`,
        border: `1px solid ${TOKENS.inkLine}`,
      });
      box.appendChild(img);
    }

    if (attempt.error) box.appendChild(mono(attempt.error, TOKENS.vermilion, 11));

    if (attempt.reviews.length === 0) box.appendChild(mono('no critique recorded', TOKENS.mistDim));
    else if (defects.length === 0) box.appendChild(mono('no defects reported', TOKENS.jade));
    else for (const defect of defects) box.appendChild(this.defect(defect, reviewers.size > 1));

    return box;
  }

  private defect(defect: MergedDefect, showReviewer: boolean): HTMLElement {
    const colour = SEVERITY_COLOUR[defect.severity] ?? TOKENS.mistDim;
    const box = document.createElement('div');
    Object.assign(box.style, { display: 'flex', flexDirection: 'column', gap: '2px' });

    const head = row();
    head.appendChild(dot(colour, 6));
    head.appendChild(mono(defect.severity, colour, 10));
    head.appendChild(mono(defect.category, TOKENS.mist, 10));
    if (showReviewer) {
      const who = mono(defect.reviewers.join(' + '), TOKENS.mistDim, 9.5);
      who.style.marginLeft = 'auto';
      head.appendChild(who);
    }
    box.appendChild(head);

    const desc = document.createElement('p');
    desc.textContent = defect.description;
    Object.assign(desc.style, {
      margin: '0px',
      color: TOKENS.mist,
      fontFamily: TOKENS.prose,
      fontSize: '12.5px',
      lineHeight: '1.4',
    });
    box.appendChild(desc);
    return box;
  }
}

registerEditor(InspectorEditor, 'vn.InspectorEditor');

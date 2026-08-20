/**
 * The finished report, before it goes anywhere.
 *
 * A bespoke surface rather than a `CommandForm`, because of a conflict in one prop: the body must
 * be editable here, and must not be written verbatim into `commands.jsonl`. `digest: true`, which
 * is what keeps it out of the log, replaces the editor with a size label, so the command declares
 * `digest` for the record's sake and this dialog does the editing.
 *
 * The leak scan is `report.openIssue`'s own `check`, re-asked on every keystroke exactly as a
 * command form does it. The button stays refused, in the command's own words, until the name the
 * author is looking at is gone. Nothing is rewritten behind the author's back.
 */
import { UIBase, type Container } from 'pathux';
import { api } from '../api.js';
import type { CommandCheck } from '../../src/shared/ipc.js';
import { exec, report, shell } from './bridge.js';
import { paragraph } from './paragraph.js';
import { INSET, onPopupClosed, popupLeft, stylePopup } from './popup.js';
import { writingBox } from './writingbox.js';

/** What `Screen.popup` hands back: a container that also knows how to dismiss itself. */
type Popup = Container & { end(): void };

const WIDTH = 720;
/** What prose may fill, leaving the popup's own inset either side. */
const PROSE = WIDTH - INSET;

/** The part of `report.agent`'s answer this dialog opens on. */
export interface ReportDraft {
  title: string;
  body: string;
  /** Where a copy was kept, when there was somewhere to keep one. */
  file?: string;
}

const PRIVACY =
  'Names from your story are already replaced and the substitution table was never saved. ' +
  'Anything still recognisable, take out here — this text becomes a public issue.';

let open: Preview | undefined;

class Preview {
  private readonly popup: Popup;
  private readonly verdictCol: Container;
  private readonly buttonCol: Container;
  private body: string;
  private check: CommandCheck | undefined;
  /** A late check must not redraw a dismissed dialog. */
  private live = true;
  /** One browser window per press. The command is quick, but a double click is two tabs. */
  private filing = false;
  /** Whether the browser has been handed this report at least once. */
  private filed = false;

  constructor(private readonly draft: ReportDraft) {
    const screen = shell().screen;
    if (!screen) throw new Error('no screen to hang a dialog on');
    this.body = draft.body;

    const x = popupLeft(screen, WIDTH);
    const y = Math.max(48, Math.round(screen.size[1] * 0.12));
    this.popup = screen.popup(screen as unknown as UIBase, x, y, false) as Popup;
    // The same chrome the palette and the command dialog wear. Without it path.ux hands back a
    // box with the theme's own border (which is `border-color` and no width, so nothing is drawn)
    // and this is the one dialog in the shell that carries a public document.
    stylePopup(this.popup, screen, WIDTH, y);

    // `remove`, not `end`. Escape and the click-outside watcher hold their own closure over the
    // real `end`, so an override here is never told they fired: the box goes and `open` stays
    // set, and the preview cannot be opened again for the rest of the session.
    onPopupClosed(this.popup, () => {
      open = undefined;
      this.live = false;
    });

    const col = this.popup.col();
    paragraph(col, draft.title, PROSE);
    paragraph(col, PRIVACY, PROSE);
    if (draft.file) paragraph(col, `A copy is kept at ${draft.file}.`, PROSE);

    writingBox(col.row(), {
      value: draft.body,
      title: 'The report, as it will be filed. Edit anything you would rather not publish.',
      label: 'the report',
      rows: 20,
      minHeight: '340px',
      onInput: (text) => {
        this.body = text;
        void this.recheck();
      },
    });

    this.verdictCol = col.col();
    this.buttonCol = col.col();
    this.renderVerdict();
    this.renderButtons();
    this.popup.flushUpdate();

    void this.recheck();
  }

  close(): void {
    this.popup.end();
  }

  private async recheck(): Promise<void> {
    const check = await api.invoke('command:check', {
      id: 'report.openIssue',
      props: { title: this.draft.title, body: this.body },
    });
    if (!this.live) return;
    this.check = check;
    this.renderVerdict();
    this.renderButtons();
  }

  /** The verdict on its own strip, so a redraw does not tear out the box being typed into. */
  private renderVerdict(): void {
    this.verdictCol.clear();
    if (this.check && this.check.state !== 'undeclared') {
      const mark = this.check.state === 'accept' ? '✓' : '✕';
      paragraph(this.verdictCol, `${mark} ${this.check.message}`, PROSE);
    }
    this.verdictCol.flushUpdate();
  }

  private renderButtons(): void {
    this.buttonCol.clear();
    const row = this.buttonCol.row();

    // The only way out. Opening the browser deliberately leaves this dialog up: the issue form is a
    // draft in another window, the author may want to come back and edit, and the copy on screen is
    // the only one they have. The label says what closing means now rather than in general
    const discard = row.button(this.filed ? 'Close' : 'Discard', () => this.close());
    discard.description = this.filed
      ? 'Close this dialog. The issue form in your browser is untouched — it is still a draft ' +
        'until you press Create there.'
      : this.draft.file
        ? 'Close without filing anything. The saved copy stays where it is.'
        : 'Close without filing anything.';

    const refused = this.check?.state === 'refuse';
    const label = this.filing
      ? 'Opening…'
      : this.filed
        ? 'Open GitHub Issue Again…'
        : 'Open GitHub Issue…';
    const file = row.button(label, () => void this.file());
    file.disabled = refused || this.filing;
    // A greyed control that will not say why is the same bug as a hidden one.
    file.description = refused
      ? (this.check?.message ?? '')
      : (this.filed
          ? 'Edited the report since? Open a fresh issue form on what is on screen now. '
          : 'Copy the report to your clipboard and open a filled-in issue in your browser. ') +
        'Nothing is posted until you press Create there.';

    this.buttonCol.flushUpdate();
  }

  private async file(): Promise<void> {
    if (this.filing) return;
    this.filing = true;
    this.renderButtons();

    let outcome;
    try {
      outcome = await exec('report.openIssue', { title: this.draft.title, body: this.body });
    } finally {
      this.filing = false;
    }

    report(outcome);
    if (!this.live) return;
    // Stay open either way. Nothing has been posted yet (the browser holds a form), so closing on
    // success would take away the only copy of the text while the author is still reading it over.
    // The author closes the dialog with the Close button instead
    if (outcome.ok) this.filed = true;
    this.renderButtons();
  }
}

/**
 * Show a finished report. Idempotent like every other dialog here; the analysis takes a minute, so
 * a second report arriving while the first is still on screen is unlikely.
 */
export function openReportPreview(draft: ReportDraft): void {
  if (open) return;
  open = new Preview(draft);
}

export function closeReportPreview(): void {
  open?.close();
  open = undefined;
}

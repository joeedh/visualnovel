/**
 * The finished report, before it goes anywhere.
 *
 * A bespoke surface rather than a `CommandForm`, because of a genuine conflict in one prop: the
 * body must be **editable** here, and must **not** be written verbatim into `commands.jsonl` — and
 * `digest: true`, which is what keeps it out of the log, replaces the editor with a size label.
 * So the command declares `digest` for the record's sake and this dialog does the editing.
 *
 * The leak scan is `report.openIssue`'s own `check`, re-asked on every keystroke exactly as a
 * command form does it: the button stays refused, in the command's own words, until the name the
 * author is looking at is gone. Nothing is silently rewritten under them.
 */
import { UIBase, type Container } from 'pathux';
import { api } from '../api.js';
import type { CommandCheck } from '../../src/shared/ipc.js';
import { exec, report, shell } from './bridge.js';
import { writingBox } from './writingbox.js';

/** What `Screen.popup` hands back: a container that also knows how to dismiss itself. */
type Popup = Container & { end(): void };

const WIDTH = 720;

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

  constructor(private readonly draft: ReportDraft) {
    const screen = shell().screen;
    if (!screen) throw new Error('no screen to hang a dialog on');
    this.body = draft.body;

    const x = Math.max(8, Math.round(screen.size[0] / 2 - WIDTH / 2));
    const y = Math.max(48, Math.round(screen.size[1] * 0.12));
    this.popup = screen.popup(screen as unknown as UIBase, x, y, false) as Popup;
    this.popup.style['width'] = `${WIDTH}px`;

    const end = this.popup.end.bind(this.popup);
    this.popup.end = () => {
      open = undefined;
      this.live = false;
      end();
    };

    const col = this.popup.col();
    col.label(draft.title);
    col.label(PRIVACY);
    if (draft.file) col.label(`A copy is kept at ${draft.file}.`);

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

  /** The verdict on its own strip, so a redraw never tears out the text being typed into. */
  private renderVerdict(): void {
    this.verdictCol.clear();
    if (this.check && this.check.state !== 'undeclared') {
      this.verdictCol.label(`${this.check.state === 'accept' ? '✓' : '✕'} ${this.check.message}`);
    }
    this.verdictCol.flushUpdate();
  }

  private renderButtons(): void {
    this.buttonCol.clear();
    const row = this.buttonCol.row();

    const discard = row.button('Discard', () => this.close());
    discard.description = this.draft.file
      ? 'Close without filing anything. The saved copy stays where it is.'
      : 'Close without filing anything.';

    const refused = this.check?.state === 'refuse';
    const file = row.button(
      this.filing ? 'Opening…' : 'Open GitHub Issue…',
      () => void this.file(),
    );
    file.disabled = refused || this.filing;
    // A greyed control that will not say why is the same bug as a hidden one.
    file.description = refused
      ? (this.check?.message ?? '')
      : 'Copy the report to your clipboard and open a filled-in issue in your browser. ' +
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
    // The browser has the report; keeping the dialog up would only invite a second tab. A refusal
    // leaves it open, because the thing to fix is in the box.
    if (outcome.ok) this.close();
    else this.renderButtons();
  }
}

/**
 * Show a finished report. Idempotent like every other dialog here — and the analysis takes a
 * minute, so a second one arriving while the first is still on screen is not a thing that happens.
 */
export function openReportPreview(draft: ReportDraft): void {
  if (open) return;
  open = new Preview(draft);
}

export function closeReportPreview(): void {
  open?.close();
  open = undefined;
}

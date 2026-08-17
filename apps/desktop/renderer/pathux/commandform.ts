/**
 * One command as a form: its declared props as widgets, the live verdict above the button, and the
 * button that runs it.
 *
 * It is its own thing because two surfaces host it — the palette's detail column and the command
 * dialog — and a second copy of these rules would be two places to disagree about how a
 * `directory` draws, when `confirm` needs a second click, or whether an `undeclared` check is a
 * yes. `coerceProps` in main stays the authority on the values themselves.
 */
import type { Container, MenuTemplateCustom, MenuTemplateEntry, TextBox } from 'pathux';
import { api } from '../api.js';
import { blankProps, bulkSize, fieldText, fieldValue } from '../rules/catalog.js';
import type { CatalogEntry, CatalogProp, CommandCheck, PropValue } from '../../src/shared/ipc.js';
import { exec, report } from './bridge.js';
import { writingBox } from './writingbox.js';

/** One option a host offers for a `string` prop this time it is opened. */
export interface ChoiceRow {
  value: string;
  label: string;
  tooltip?: string;
}

/**
 * Per-open option lists, keyed by prop name — a *function of the current values*, because one
 * field's list can depend on another's (the effort a model offers depends on the model). An enum's
 * `values` are baked into the catalog at module load and stay that way: a list of this project's
 * conversations is not part of a command's vocabulary.
 */
export type Choices = (values: Record<string, PropValue>) => Record<string, ChoiceRow[]>;

export interface FormOptions {
  /** Called once the command ran and the surface hosting the form should go away. */
  onRan: () => void;
  /** What the button says. Defaults to `run` — a dialog names the command instead. */
  runLabel?: string;
  /** Drawn at the head of the button row, so a dialog can put Cancel beside the action. */
  buttons?: (row: Container) => void;
  choices?: Choices;
}

export class CommandForm {
  readonly values: Record<string, PropValue>;

  private check: CommandCheck | undefined;
  /** A `confirm: true` command needs a second click, and the button says so between them. */
  private confirming = false;
  /**
   * The verdict's own strip. A recheck redraws this and nothing else: rebuilding the form would
   * tear out the very input being typed into, and the check is re-asked on every keystroke.
   */
  private verdictCol: Container | undefined;
  /** The form's first text field, so a surface opened on a command lands in it. */
  private firstField: TextBox | undefined;
  /** A detached form's check may still be in flight; its answer must not redraw a dead column. */
  private live = true;
  /**
   * A command is in flight. Some of them take a minute — an analysis, a pipeline wave — and a form
   * that looks idle while one runs invites a second click, which is a second minute and a second
   * bill. The button says so and declines until the first one answers.
   */
  private running = false;

  constructor(
    private readonly col: Container,
    private readonly entry: CatalogEntry,
    private readonly opts: FormOptions,
    overrides?: Record<string, PropValue>,
  ) {
    this.values = { ...blankProps(entry), ...overrides };
  }

  render(): void {
    this.col.clear();
    this.firstField = undefined;
    for (const prop of this.entry.props) {
      const box = this.field(prop);
      this.firstField ??= box;
    }

    this.verdictCol = this.col.col();
    this.renderVerdict();

    const row = this.col.row();
    this.opts.buttons?.(row);

    const label = this.opts.runLabel ?? 'run';
    const run = row.button(this.buttonText(label), () => void this.run());
    run.disabled = this.running;
    run.description = this.running
      ? 'Running. This can take a while; closing the form does not stop it.'
      : this.entry.confirm
        ? 'this command asks before it writes'
        : this.entry.title;

    this.col.flushUpdate();
  }

  /** What the action button says: the command, unless it is mid-flight or awaiting a confirm. */
  private buttonText(label: string): string {
    if (this.running) return `${label} — working…`;
    return this.confirming ? `confirm — ${label}` : label;
  }

  focusFirst(): void {
    this.firstField?.focus();
  }

  /** Stop answering. A surface that has gone away must not be redrawn by a late check. */
  detach(): void {
    this.live = false;
  }

  async recheck(): Promise<void> {
    if (!this.entry.checkable) return;
    const check = await api.invoke('command:check', { id: this.entry.id, props: this.values });
    if (!this.live) return;
    this.check = check;
    this.renderVerdict();
  }

  /**
   * The verdict, on its own. `undeclared` renders as nothing at all: a command that states no
   * precondition has not said yes, and a tick here would invent an assurance.
   */
  private renderVerdict(): void {
    const col = this.verdictCol;
    if (!col) return;
    col.clear();
    if (this.check && this.check.state !== 'undeclared') {
      col.label(`${this.check.state === 'accept' ? '✓' : '✕'} ${this.check.message}`);
    }
    col.flushUpdate();
  }

  /**
   * One declared prop as an editable widget, returning it when it is a text field — those are
   * what a form opened on a command wants the focus in.
   */
  private field(prop: CatalogProp): TextBox | undefined {
    const row = this.col.row();
    row.label(`${prop.name}${prop.required ? ' *' : ''}`);
    const value = this.values[prop.name];

    // Bulk content the caller composed — a serialized mesh, a whole document. A text field over
    // it is unreadable and one keystroke from corrupting it, so the form says what it holds.
    if (prop.digest && value !== undefined && value !== '') {
      row.label(`${bulkSize(value)} — ${prop.description}`);
      return undefined;
    }

    if (prop.kind === 'boolean') {
      // Nothing is rebuilt on a toggle: the widget carries its own state, so redrawing the form
      // around it would only cost it the focus it just took.
      const box = row.check(undefined, prop.description);
      box.checked = Boolean(value);
      // The description is the label here, so the hover sentence has to come from somewhere else.
      box.description = prop.hint ?? prop.description;
      box.on_change = (next: unknown) => {
        this.values[prop.name] = Boolean(next);
        void this.recheck();
      };
      return undefined;
    }

    const rows = this.opts.choices?.(this.values)[prop.name];
    if (rows && rows.length > 0) {
      this.chooser(row, prop, rows, String(value ?? ''));
      return undefined;
    }

    if (prop.multiline) {
      this.multiline(row, prop, fieldText(value ?? ''));
      return undefined;
    }

    if (prop.kind === 'enum') {
      const menu = row.menu(
        String(value ?? ''),
        (prop.values ?? []).map(
          (option): MenuTemplateCustom => [
            option,
            () => {
              this.values[prop.name] = option;
              this.render();
              void this.recheck();
            },
          ],
        ),
      );
      menu.description = prop.hint ?? prop.description;
      return undefined;
    }

    const box = row.textbox(undefined, fieldText(value ?? ''), (text: unknown) => {
      this.values[prop.name] = fieldValue(prop, String(text));
      void this.recheck();
    });
    box.description = prop.hint ?? prop.description;

    // A directory is the one string the OS can say for itself. The field stays typeable — the
    // chooser fills it in, it does not own it.
    if (prop.kind === 'directory') {
      const browse = row.button('Browse…', () => void this.browse(prop.name, box));
      browse.description = 'Choose this folder in a file dialog';
    }

    return box;
  }

  /**
   * A prop the host offered a list for. The button shows the chosen row's *label* — an id is what
   * the command takes, not what an author recognises — and each row carries its own tooltip, so
   * the advice about a choice is readable before it is made rather than only after.
   */
  private chooser(row: Container, prop: CatalogProp, rows: ChoiceRow[], value: string): void {
    const chosen = rows.find((option) => option.value === value);
    const menu = row.menu(
      chosen?.label ?? value,
      rows.map(
        (option): MenuTemplateEntry => ({
          name: option.label,
          callback: () => {
            this.values[prop.name] = option.value;
            // A dependent list is recomputed by drawing again; this is the whole mechanism.
            this.render();
            void this.recheck();
          },
          tooltip: option.tooltip,
        }),
      ),
    );
    menu.description = prop.hint ?? prop.description;
  }

  /** Free text of more than a line, in the shared writing surface. */
  private multiline(row: Container, prop: CatalogProp, value: string): void {
    writingBox(row, {
      value,
      title: prop.hint ?? prop.description,
      label: prop.description,
      onInput: (text) => {
        this.values[prop.name] = text;
        void this.recheck();
      },
    });
  }

  /** Run the chooser and put what it answered in the field, leaving a cancel alone. */
  private async browse(name: string, box: TextBox): Promise<void> {
    const outcome = await exec('workspace.chooseDirectory');
    if (!outcome.ok) return;
    const picked = (outcome.data as { path?: string } | undefined)?.path;
    if (!picked) return;

    this.values[name] = picked;
    box.text = picked;
    void this.recheck();
  }

  private async run(): Promise<void> {
    if (this.running) return;
    if (this.entry.confirm && !this.confirming) {
      this.confirming = true;
      this.render();
      return;
    }
    this.confirming = false;

    this.running = true;
    this.render();
    let outcome;
    try {
      outcome = await exec(this.entry.id, this.values);
    } finally {
      this.running = false;
    }

    report(outcome);
    // A form whose surface went away mid-run still ran; it just has nothing left to redraw.
    if (!this.live) return;
    if (outcome.ok) {
      this.opts.onRan();
    } else {
      // The refusal already went to the note frame; the form stays up so it can be edited.
      this.render();
      void this.recheck();
    }
  }
}

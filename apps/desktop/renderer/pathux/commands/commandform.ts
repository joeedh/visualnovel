/**
 * One command as a form: its declared props as widgets, the live verdict above the button, and the
 * button that runs it.
 *
 * It is its own thing because two surfaces host it — the palette's detail column and the command
 * dialog — and a second copy of these rules would be two places to disagree about how a
 * `directory` draws, when `confirm` needs a second click, or whether an `undeclared` check is a
 * yes. `coerceProps` in main stays the authority on the values themselves.
 */
import { EnumProperty, ThumbnailCache, pickAssetPopup } from 'pathux';
import type { Button, Container, DropBox, TextBox } from 'pathux';
import { api } from '../../api.js';
import {
  blankProps,
  bulkSize,
  fieldText,
  fieldValue,
  type ChoiceRow,
} from '../../rules/catalog.js';
import { picksAnAsset } from '../../rules/vocabulary.js';
import { galleryItem } from '../assets/assetthumb.js';
import type {
  AssetListing,
  CatalogEntry,
  CatalogProp,
  CommandCheck,
  PropValue,
} from '../../../src/shared/ipc.js';
import { exec, report, say } from '../app/bridge.js';
import { paragraph } from '../widgets/paragraph.js';
import { writingBox } from '../widgets/writingbox.js';

/** Beyond this many rows a dropdown is faster to type at than to scroll. */
const SEARCHABLE_AT = 12;

/**
 * Per-open option lists, keyed by prop name. They are a function of the current values, because one
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
  /** How wide the host is, so a verdict wraps inside it rather than off the window. */
  width: number;
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
  /** The button that runs it, kept so a fresh verdict can arm or disarm it without a redraw. */
  private runButton: Button | undefined;
  /** A detached form's check may still be in flight; its answer must not redraw a dead column. */
  private live = true;
  /**
   * A command is in flight. Some of them take a minute — an analysis, a pipeline wave — and a form
   * that looks idle while one runs invites a second click, which is a second minute and a second
   * bill. The button says so and declines until the first one answers.
   */
  private running = false;
  /**
   * Decoded thumbnails for the asset gallery, the form's own so reopening it in the same form
   * redraws from what it already decoded and closing the form releases the bitmaps with it.
   */
  private readonly thumbs = new ThumbnailCache();

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
    this.runButton = row.button(this.buttonText(label), () => void this.run());
    this.armRun();

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
    this.thumbs.clear();
  }

  async recheck(): Promise<void> {
    if (!this.entry.checkable) return;
    const check = await api.invoke('command:check', { id: this.entry.id, props: this.values });
    if (!this.live) return;
    this.check = check;
    this.renderVerdict();
    this.armRun();
  }

  /**
   * Follow the verdict with the button. A command that has declared it will refuse is not worth a
   * click, and the greyed button says exactly why — the refusal, verbatim. `undeclared` arms it,
   * because the absence of a check is not a refusal.
   */
  private armRun(): void {
    const run = this.runButton;
    if (!run) return;
    const refused = this.check?.state === 'refuse';
    run.disabled = this.running || refused;
    run.description = this.running
      ? 'Running. This can take a while; closing the form does not stop it.'
      : refused
        ? this.check!.message
        : this.entry.confirm
          ? 'this command asks before it writes'
          : this.entry.title;
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
      // One paragraph per line, because a check that answers in several sentences intends those
      // line breaks, and a single label draws them as one unreadable strip.
      const mark = this.check.state === 'accept' ? '✓' : '✕';
      const lines = this.check.message.split('\n');
      lines.forEach((line, i) => {
        const text = i === 0 ? `${mark} ${line}` : `   ${line}`;
        const label = paragraph(col, text, this.opts.width);
        label.description =
          this.check?.state === 'accept'
            ? 'What this command would do if you ran it now'
            : 'Why this command will not run';
      });
    }
    col.flushUpdate();
  }

  /**
   * One declared prop as an editable widget, returning it when it is a text field — those are
   * what a form opened on a command wants the focus in.
   */
  private field(prop: CatalogProp): TextBox | undefined {
    // A host that offered a list and came back empty means this prop has no choice to make here,
    // such as the effort of a model without a reasoning setting. Falling through to a text field
    // would invite typing a value that model does not have, so the row is not drawn at all.
    const rows = this.opts.choices?.(this.values)[prop.name];
    if (rows && rows.length === 0) return undefined;

    const row = this.col.row();
    const name = row.label(`${prop.name}${prop.required ? ' *' : ''}`);
    name.description = prop.required ? `${prop.description} (required)` : prop.description;
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

    if (rows) {
      this.chooser(row, prop, rows, String(value ?? ''));
      return undefined;
    }

    if (prop.multiline) {
      this.multiline(row, prop, fieldText(value ?? ''));
      return undefined;
    }

    if (prop.kind === 'enum') {
      const options = (prop.values ?? []).map((option): ChoiceRow => ({
        value  : option,
        label  : option === '' ? 'leave empty' : option,
        tooltip: `Set ${prop.name} to ${option}`,
      }));
      this.chooser(row, prop, options, String(value ?? ''));
      return undefined;
    }

    const box = row.textbox(undefined, fieldText(value ?? ''), (text: unknown) => {
      this.values[prop.name] = fieldValue(prop, String(text));
      void this.recheck();
    });
    box.description = prop.hint ?? prop.description;

    // A directory is the one string the OS can supply through a file dialog. The field stays
    // typeable; the chooser fills it in rather than owning it.
    if (prop.kind === 'directory') {
      const browse = row.button('Browse…', () => void this.browse(prop.name, box));
      browse.description = 'Choose this folder in a file dialog';
    }

    // Same shape for an asset: a hash is not something anyone types from memory, but `ref` also
    // takes a slot address and a hash can be pasted, so the gallery fills the field rather than
    // replacing it.
    if (picksAnAsset(prop)) {
      const pick = row.button('Pick…', () => void this.pickAsset(prop.name, box));
      pick.description = 'Choose the picture from every asset in this project';
    }

    return box;
  }

  /**
   * A prop with a list behind it, drawn as a dropdown. The button shows the chosen row's label,
   * because an id is what the command takes rather than what an author recognises, and each row
   * carries its own tooltip, so the advice about a choice is readable before the choice is made.
   *
   * A value that is not in the list gets a row of its own saying so. Dropping it would show the
   * first option instead, which is a value the author never chose, and `EnumProperty` refuses a
   * value it has no key for. An unfilled required field is that same case and reads as the
   * invitation it is.
   */
  private chooser(row: Container, prop: CatalogProp, rows: ChoiceRow[], value: string): void {
    const options = rows.some((option) => option.value === value)
      ? rows
      : [...rows, unlisted(value, prop)];

    const keys: Record<string, string> = {};
    const labels: Record<string, string> = {};
    const tooltips: Record<string, string> = {};
    for (const option of options) {
      keys[option.value] = option.value;
      labels[option.value] = option.label;
      tooltips[option.value] = option.tooltip ?? option.label;
    }

    const menu: DropBox = row.listenum(undefined, {
      enumDef   : new EnumProperty(value, keys).addUINames(labels).addDescriptions(tooltips),
      defaultval: value,
      callback: (picked) => {
        this.values[prop.name] = String(picked);
        // A dependent list is recomputed by drawing the form again.
        this.render();
        void this.recheck();
      },
    });
    // A list long enough to scroll is quicker to type at, and the menu's own search box is the
    // only part of it a keyboard reaches.
    menu.searchMenuMode = options.length > SEARCHABLE_AT;
    menu.description = prop.hint ?? prop.description;
  }

  /**
   * Fill an asset prop from the gallery. The manifest is read when the popup opens rather than
   * followed, since the choice is over what is there at that moment.
   *
   * The popup is a second popup over the one the form is drawn in. It owns the press that
   * dismisses it and answers Escape itself, so neither gesture takes the form down with it.
   */
  private async pickAsset(name: string, box: TextBox): Promise<void> {
    const outcome = await exec('asset.list', {});
    if (!outcome.ok) return report(outcome);

    const assets = outcome.data as AssetListing[] | undefined;
    if (!assets?.length) return say('This project has no assets yet.', true);

    const rect = box.getClientRects()[0];
    const picked = await pickAssetPopup(this.col, {
      items: assets.map(galleryItem),
      cache: this.thumbs,
      ...(rect ? { at: { x: rect.left, y: rect.bottom } } : {}),
    });
    if (!picked || !this.live) return;

    this.values[name] = picked.id;
    box.text = picked.id;
    void this.recheck();
  }

  /** Free text of more than a line, in the shared writing surface. */
  private multiline(row: Container, prop: CatalogProp, value: string): void {
    writingBox(row, {
      value,
      title  : prop.hint ?? prop.description,
      label  : prop.description,
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

/** The row a chooser adds for a value none of its options carry. */
function unlisted(value: string, prop: CatalogProp): ChoiceRow {
  if (value === '') return { value, label: 'choose…', tooltip: prop.hint ?? prop.description };
  return { value, label: `${value} — this project has no such thing`, tooltip: prop.description };
}

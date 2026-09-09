/**
 * What one of this app's controls runs, as a path.ux tool tag.
 *
 * `PathToolMeta` carries a tool path and nothing else, and this app's controls run `@vn/commands`
 * ids with props, an `on` discriminator, `supplies`, `form` and a `then` list. The class is the
 * measured tier's half of the record the derived tier writes, so both sides hash the same
 * `identity()` and land on the same `widgetPath`.
 *
 * Imported through `pathux-meta`, the alias for `ui_meta_tags.ts`, which imports nothing at
 * runtime but nstructjs — so this module builds a tag in the renderer and in a node test alike.
 */
import * as nstructjs from 'nstructjs';
import { UXToolMeta } from 'pathux-meta';
import type { PropValue } from '../../src/shared/ipc.js';
import type { Action } from './anchors.js';

/** What {@link VnToolMeta} is constructed from: the parts of an `Offer` that say what it runs. */
export interface ToolFacts {
  id: string;
  on?: string;
  supplies?: readonly string[];
  form?: boolean;
  props?: Record<string, PropValue>;
  then?: readonly Action[];
}

export class VnToolMeta extends UXToolMeta<'vn'> {
  static override STRUCT = nstructjs.inlineRegister(
    this,
    `
    vn.VnToolMeta {
      on       : string;
      supplies : array(string);
      form     : bool;
      props    : string;
      then     : string;
    }`,
  );

  readonly type = 'vn' as const;

  /** What tells this control apart from another running the same command on the same home. */
  on = '';

  /** Prop names the click reads from the widget at commit time. */
  supplies: string[] = [];

  /** The click opens the command's own form rather than running it. */
  form = false;

  /**
   * The props the click is given, as JSON. nstructjs has `ITERKEYS` for a homogeneous map and
   * nothing for a `string | number | boolean | string[]` union, so the record is carried as text
   * and read back through {@link propValues}.
   */
  props = '{}';

  /** What the click does after the first action, as JSON, for the reason {@link props} is. */
  then = '[]';

  constructor(facts?: ToolFacts) {
    super();
    // `toolPath` holds the `@vn/commands` id rather than a path.ux tool path: it is what this
    // control runs, and it is what `widgetSegment` slugs into the stem a person reads in a diff
    this.toolPath = facts?.id ?? '';
    this.on = facts?.on ?? '';
    this.supplies = [...(facts?.supplies ?? [])];
    this.form = facts?.form ?? false;
    this.propValues = facts?.props ?? {};
    this.thenActions = facts?.then ?? [];
  }

  get propValues(): Record<string, PropValue> {
    return JSON.parse(this.props) as Record<string, PropValue>;
  }
  set propValues(props: Record<string, PropValue>) {
    this.props = JSON.stringify(props);
  }

  get thenActions(): Action[] {
    return JSON.parse(this.then) as Action[];
  }
  set thenActions(then: readonly Action[]) {
    this.then = JSON.stringify(then);
  }

  /**
   * What tells this tool apart from another on a different control, and so what `widgetSegment`
   * hashes. `props` stays out: a control that supplies one leaves it blank until the click, and
   * the derived tier's fixture and the live pane differ on the subject on screen. The tooltip
   * stays out because it is presentation.
   */
  override identity(): string {
    return [
      super.identity(),
      this.on,
      this.form ? 'form' : '',
      [...this.supplies].sort().join(','),
    ].join('\0');
  }

  override copyTo(b: this): this {
    super.copyTo(b);
    b.on = this.on;
    b.supplies = [...this.supplies];
    b.form = this.form;
    b.props = this.props;
    b.then = this.then;
    return b;
  }

  copy(): this {
    return this.copyTo(new VnToolMeta() as this);
  }
}

/**
 * One pane's front-matter forms: `docforms.ts`'s schemas and labels, with the controls this pane
 * draws in place of a text box, and the form instance path.ux mounted so a closed form's answers
 * can be played back into it.
 *
 * Built once per pane rather than once per module, because a control closes over the pane — its
 * thumbnails, its anchors, its tree — and `nativeFormBinding` compares the form `select` answers
 * with the one it was built for by identity. A pane's `select` answers the pane's own forms for
 * the life of the pane, so the identity holds.
 */
import {
  formView,
  type FormControl,
  type NativeFormParts,
  type RecoveredForm,
} from 'pathux-richtext-forms';
import type { DocumentSession, JsonValue, MdDoc, WidgetView } from 'pathux-richtext-headless';
import type { FieldMeta } from 'pathux-richtext-schema';
import type { EntityTag } from '@vn/types';
import type { AnchorPass } from '../tour/anchors.js';
import { FORMS, formKind, type DocForm } from './docforms.js';
import { paletteControl } from './palettecontrol.js';

/** The controls a pane supplies for a sheet, by field name; a field not named keeps its box. */
export type SheetControls = Partial<Record<EntityTag, Readonly<Record<string, FieldMeta>>>>;

/** What a control closes over from the pane that draws it. */
export interface SheetHost {
  /** The open document's path, which every offer a control records names. */
  path(): string;
  /**
   * A fresh anchor pass for one control's part of the form. A control that rebuilds its rows
   * opens one, because a pass refuses a node whose offer changes inside it, and the previous pass
   * of that part is dropped with the rows it recorded.
   */
  anchors(part: string): AnchorPass;
}

/** The controls every pane draws over a sheet, each bound to the pane through `host`. */
export function sheetControls(host: SheetHost): SheetControls {
  const palette: FieldMeta = {
    ...FORMS.character.presentation.fields!.palette,
    control: (field) => paletteControl(field, host),
  };
  return { character: { palette }, location: { palette } };
}

export class SheetForms {
  private readonly forms: Record<EntityTag, DocForm>;

  /** The form path.ux most recently mounted through `view` and has not disposed. */
  private mounted: FormControl | undefined;

  constructor(controls: SheetControls = {}) {
    const merged = (kind: EntityTag): DocForm => ({
      schema      : FORMS[kind].schema,
      presentation: {
        ...FORMS[kind].presentation,
        fields: { ...FORMS[kind].presentation.fields, ...controls[kind] },
      },
    });
    this.forms = { character: merged('character'), location: merged('location') };
  }

  /** The `select` of `nativeFormWidgets`: this pane's form for the document's kind. */
  select(implied: EntityTag | undefined, values: JsonValue): DocForm | undefined {
    const kind = formKind(implied, values);
    return kind === undefined ? undefined : this.forms[kind];
  }

  /** The `view` of `nativeFormWidgets`: the default form, remembered until path.ux disposes it. */
  view(parts: NativeFormParts): WidgetView {
    const form = formView(parts);
    this.mounted = form;
    return {
      element: form.element,
      update : (state) => form.update(state),
      focus  : (last) => form.focus(last),
      dispose: () => {
        form.dispose();
        if (this.mounted === form) this.mounted = undefined;
      },
    };
  }

  /**
   * Play a closed form's answers into the mounted one. Answers `true` when a detached
   * front-matter draft was taken back and dropped from the session; `false` leaves every draft
   * where it was, for the footer to report and Discard to drop.
   */
  recover(session: DocumentSession<MdDoc>): boolean {
    const form = this.mounted;
    if (!form) return false;
    for (const draft of session.pendingDrafts) {
      if (!draft.detached || !draft.key.startsWith('frontmatter:')) continue;
      const recovered = session.recoverDraft(draft.id) as RecoveredForm | undefined;
      if (recovered && form.restore(recovered)) {
        session.discardDraft(draft.id);
        return true;
      }
    }
    return false;
  }
}

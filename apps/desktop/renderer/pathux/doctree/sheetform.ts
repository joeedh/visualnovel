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
import type { ContextLike } from 'pathux';
import type { EntityTag } from '@vn/types';
import type { EditorId } from '../../../src/shared/editors.js';
import type { EntityLinks } from '../../../src/shared/ipc.js';
import type { AnchorPass } from '../tour/anchors.js';
import { FORMS, formKind, type DocForm } from './docforms.js';
import { paletteControl } from './palettecontrol.js';
import { promptControl } from './promptcontrol.js';
import { variantsControl } from './variantscontrol.js';
import { wardrobeControl } from './wardrobecontrol.js';

/** The controls a pane supplies for a sheet, by field name; a field not named keeps its box. */
export type SheetControls = Partial<Record<EntityTag, Readonly<Record<string, FieldMeta>>>>;

/** What a control closes over from the pane that draws it. */
export interface SheetHost {
  /** The open document's path, which every offer a control records names. */
  path(): string;
  /** The pane's context, which a path.ux widget drawn among the raw rows is built with. */
  ctx(): ContextLike;
  /**
   * A fresh anchor pass for one control's part of the form. A control that rebuilds its rows
   * opens one, because a pass refuses a node whose offer changes inside it, and the previous pass
   * of that part is dropped with the rows it recorded.
   */
  anchors(part: string): AnchorPass;
  /** What the open document is the subject of: its art and what the storyboards plan for it. */
  links(): EntityLinks | undefined;
  /** Called when `links` has a new answer; returns what stops the calls. */
  onLinks(listener: () => void): () => void;
  /** The editors on screen, which route a thumbnail's click. */
  visible(): readonly EditorId[];
  openAsset(hash: string): void;
  /** Whether the document has edits not yet on disk. */
  dirty(): boolean;
  /** Called when the pane repaints for the buffer, which is when `dirty` may have changed. */
  onPaint(listener: () => void): () => void;
}

/** The controls every pane draws over a sheet, each bound to the pane through `host`. */
export function sheetControls(host: SheetHost): SheetControls {
  const fields = FORMS.character.presentation.fields!;
  const palette: FieldMeta = { ...fields.palette, control: (field) => paletteControl(field, host) };
  const outfits: FieldMeta = {
    label  : 'Wardrobe',
    help: 'The outfits scenes can dress this character in; the marked one is worn when a scene names none',
    control: (field) => wardrobeControl(field, host),
  };
  const variants: FieldMeta = {
    label  : 'Variants',
    help: 'The variants plates are drawn for, in the order written; a bare id, or an entry with its own art direction',
    control: (field) => variantsControl(field, host),
  };
  // A location's override lives on its variant entries, so only a character sheet has the field
  const prompt_override: FieldMeta = {
    ...fields.prompt_override,
    control: (field) => promptControl(field, host),
  };
  return {
    character: {
      palette,
      outfits,
      default_outfit: { ...fields.default_outfit, control: 'none' },
      prompt_override,
    },
    location : { palette, variants },
  };
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

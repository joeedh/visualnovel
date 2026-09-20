/**
 * The prompt override: a sentence saying what the sheet's prompt is, the button to the Asset
 * editor where its clauses are edited, and then the JSON box stage 1 drew. The box is the field;
 * the sentence and the button read it, so the form's draft, Apply and Discard see one text field.
 */
import { UIBase, type TextBox } from 'pathux';
import type { FieldControl, FieldHost } from 'pathux-richtext-schema';
import { promptOverrideFrom, promptOverrideIsEmpty, promptOverrideSchema } from '@vn/types';
import { promptEdit } from '../../rules/sheetform.js';
import type { SheetHost } from './sheetform.js';

/** The slot prefix of the pictures a character's own prompt draws. */
const PORTRAIT = 'portrait:';

/** What the override does to the prompt, in one line, from the field's encoded text. */
export function promptSentence(text: string | undefined): string {
  if (text === undefined || text === '') return 'Prompt: derived';
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'Prompt: override is not JSON';
  }
  const parsed = promptOverrideSchema.safeParse(raw);
  if (!parsed.success) return 'Prompt: override the schema cannot read';
  const override = promptOverrideFrom(parsed.data);
  if (promptOverrideIsEmpty(override)) return 'Prompt: derived';
  if (override.mode === 'custom') return 'Prompt: custom text';
  if (override.mode === 'agent') return 'Prompt: written by the agent';
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  const replaced = Object.keys(override.replace ?? {}).length;
  const appended = Object.keys(override.append ?? {}).length;
  const refs = Object.values(override.refs ?? {}).reduce((sum, list) => sum + list.length, 0);
  if (replaced) parts.push(`${count(replaced, 'clause')} replaced`);
  if (appended) parts.push(`${count(appended, 'clause')} appended`);
  if (override.mute?.length) parts.push(`${override.mute.length} muted`);
  if (override.order?.length) parts.push('reordered');
  if (refs) parts.push(count(refs, 'reference'));
  return `Prompt: ${parts.join(', ')}`;
}

export function promptControl(field: FieldHost, host: SheetHost): FieldControl {
  const element = document.createElement('div');
  element.className = 'sf-prompt';
  const sentence = document.createElement('span');
  sentence.className = 'sf-prompt-sentence';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'sf-prompt-edit';
  const box = UIBase.constructElement<TextBox>('textbox-x', field.context);
  box.useDataPathUndo = false;
  // The widget copies its own width onto the inner input, so the row's width reaches it this way
  box.width = '100%';
  box.dom.style.minWidth = '0';
  box.overrideDefault('border-width', 1);
  box.setCSS();
  box.setAttribute('modal', 'false');
  box.dom.setAttribute('aria-label', field.meta.label ?? field.name);
  box.dom.title = field.meta.help ?? field.node.description ?? '';
  element.append(sentence, edit, box);

  let readOnly = false;

  const control: FieldControl = {
    element,
    read       : () => box.text,
    write: (_key, text) => {
      const next = text ?? '';
      if (box.text !== next) box.text = next;
      present();
    },
    setReadOnly: (on) => {
      readOnly = on;
      box.dom.readOnly = on;
    },
    focus      : () => box.dom.focus(),
    dispose: () => {
      element.remove();
      offLinks();
      offPaint();
      host.anchors('prompt');
    },
  };

  box.dom.addEventListener('input', () => {
    control.oninput?.(field.name, box.text);
    sentence.textContent = promptSentence(box.text);
  });

  /** The picture the button opens: the accepted one, else the last drawn. */
  const pictureHash = (): string | undefined => {
    const drawn = (host.links()?.assets ?? []).filter((a) => a.slot?.startsWith(PORTRAIT));
    return (drawn.find((a) => a.accepted) ?? drawn.at(-1))?.hash;
  };

  const present = () => {
    sentence.textContent = promptSentence(box.text);
    const hash = pictureHash();
    const offer = promptEdit(
      { path: host.path(), readOnly },
      { hash, dirty: host.dirty(), visible: host.visible() },
    );
    edit.textContent = offer.label;
    host.anchors('prompt').act(edit, offer, () => {
      if (hash !== undefined) host.openAsset(hash);
    });
  };

  const offLinks = host.onLinks(present);
  const offPaint = host.onPaint(present);
  present();
  return control;
}

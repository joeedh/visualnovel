/**
 * The image-model control: the menu every other surface draws for a model, over a sheet's
 * `image_model` key in place of the id's text box. It speaks the field's encoded text (the bare
 * id, empty for none), so the form's draft, Omit, Apply and Discard treat it as one more text
 * field. The inherit row names the project's model, which is what an empty key draws with.
 */
import type { FieldControl, FieldHost } from 'pathux-richtext-schema';
import { modelOffer } from '../../rules/sheetform.js';
import { imageModelMenu } from '../widgets/modelmenu.js';
import type { SheetHost } from './sheetform.js';

export function imageModelControl(field: FieldHost, host: SheetHost): FieldControl {
  const element = document.createElement('div');
  element.className = 'sf-model';

  let shown: string | undefined;
  let readOnly = false;

  const control: FieldControl = {
    element,
    read       : () => shown,
    write: (_key, text) => {
      if (text === shown) return;
      shown = text;
      render();
    },
    setReadOnly: (on) => {
      readOnly = on;
      render();
    },
    focus      : () => element.querySelector<HTMLElement>('[tabindex], button')?.focus(),
    dispose: () => {
      element.remove();
      // An empty pass, so the sweep stops seeing a menu that is no longer drawn
      host.anchors('model');
    },
  };

  // The menu's title is fixed when it is built, so a new value means a new menu
  const render = () => {
    const anchors = host.anchors('model');
    const { frame, menu } = imageModelMenu(host.ctx(), shown ?? '', host.projectModel(), (id) => {
      if (id === (shown ?? '')) return;
      shown = id === '' ? undefined : id;
      control.oninput?.(field.name, shown);
      render();
    });
    menu.disabled = readOnly;
    anchors.record(menu, modelOffer({ path: host.path(), readOnly, model: true }));
    element.replaceChildren(frame);
  };

  render();
  return control;
}

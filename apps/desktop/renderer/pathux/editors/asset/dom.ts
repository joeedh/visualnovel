export function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

export function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A real `<button>`, because half of these are disabled and carry their refusal as the tooltip. */
export function button(className: string, text: string): HTMLButtonElement {
  const node = document.createElement('button');
  node.className = className;
  node.textContent = text;
  return node;
}

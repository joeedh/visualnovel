/**
 * The three socket types a generation graph carries. path.ux ships float and vec3, which
 * describe geometry, so text, pictures and ordered reference lists are declared here.
 */
import { NodeSocketBase, registerSocketType } from 'pathux-graph';
import type { SocketDir, SocketTypeDef } from 'pathux-graph';
import { PropFlags, StringProperty } from 'pathux-toolprop';
import type { ToolProperty } from 'pathux-toolprop';

import type { GenBlobRef } from '../services.js';

/** A picture on a socket, tagged with the store that holds its bytes. */
export interface GenImageRef extends GenBlobRef {
  store: 'asset' | 'blob';
}

/** Prose on its way to a model. An unwired input carries the empty string. */
export class TextSocket extends NodeSocketBase<'text', string> {
  static override socketDef(): SocketTypeDef {
    return { typeName: 'TextSocket', type: 'text', uiName: 'Text', color: '#9c8f6a' };
  }

  /**
   * Takes the name and description its row is drawn with, because an unconnected input is
   * edited on that row and every control this application draws carries a tooltip.
   */
  constructor(dir: SocketDir = 'in', uiname?: string, description?: string) {
    super(dir);

    // `NO_UNDO` for the same reason the node props carry it: the write is an application
    // command, so path.ux's own toolstack must not also record it. An output's default is
    // read-only: it exists only because copyTo/serialization now require one on every
    // socket, but the value is derived at run time, not authored, so it draws no row.
    const flag = dir === 'out' ? PropFlags.NO_UNDO | PropFlags.READ_ONLY : PropFlags.NO_UNDO;
    this.defaultProp = new StringProperty('', undefined, uiname, description, flag);
  }
}
registerSocketType(TextSocket);

/**
 * One picture. Declares no usable default, because an unwired picture is missing rather
 * than empty, and the runtime that needs one refuses by name.
 */
export class ImageSocket extends NodeSocketBase<'image', GenImageRef> {
  static override socketDef(): SocketTypeDef {
    return { typeName: 'ImageSocket', type: 'image', uiName: 'Image', color: '#7f9cc0' };
  }

  override useDefaultValue = false;

  // Never read: `useDefaultValue = false` means getValue() never falls back to it. Just a
  // placeholder so copyTo/serialization, which now require every socket to carry one, have
  // something to copy.
  constructor(dir: SocketDir = 'in') {
    super(dir);
    this.defaultProp = new StringProperty('') as unknown as ToolProperty<GenImageRef>;
  }
}
registerSocketType(ImageSocket);

/** Reference pictures in the order they are sent, because that order is part of a request. */
export class RefsSocket extends NodeSocketBase<'refs', GenImageRef[]> {
  static override socketDef(): SocketTypeDef {
    return { typeName: 'RefsSocket', type: 'refs', uiName: 'References', color: '#7fc0a8' };
  }

  override useDefaultValue = false;

  // Never read, same as ImageSocket above.
  constructor(dir: SocketDir = 'in') {
    super(dir);
    this.defaultProp = new StringProperty('') as unknown as ToolProperty<GenImageRef[]>;
  }

  // Reading one picture as a one-item list is destination knowledge, so an image output
  // feeds a reference list with no node in between.
  protected override canCoerceFrom(type: string): boolean {
    return type === 'image' || super.canCoerceFrom(type);
  }

  protected override convertFrom(b: NodeSocketBase): GenImageRef[] | undefined {
    if (b.type === 'image') {
      const one = b.getValue() as GenImageRef | undefined;
      return one === undefined ? undefined : [one];
    }
    return super.convertFrom(b);
  }
}
registerSocketType(RefsSocket);

import { Screen, UIBase, nstructjs } from 'pathux';

/** The shell's screen mesh. One per window; the areas inside it are the ported rooms. */
export class VnScreen extends Screen {
  /**
   * Fired whenever the mesh changes shape. Every split, join, border drag and window
   * resize passes through `regenBorders`, so this is the one seam persistence needs — it is
   * not part of `STRUCT` and does not survive a reload, so the shell re-attaches it.
   */
  onLayoutChange: (() => void) | undefined;

  static override define() {
    return { tagname: 'vn-screen-x' };
  }

  override regenBorders() {
    super.regenBorders();
    this.onLayoutChange?.();
  }
}

VnScreen.STRUCT = nstructjs.STRUCT.inherit(VnScreen, Screen, 'vn.VnScreen') + '\n}';
nstructjs.register(VnScreen);
UIBase.register(VnScreen);

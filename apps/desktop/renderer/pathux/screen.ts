import { Screen, UIBase, nstructjs } from 'pathux';

/** The shell's screen mesh. One per window, and each area inside it shows one editor. */
export class VnScreen extends Screen {
  /**
   * Fired whenever the mesh changes shape. Every split, join, border drag and window
   * resize passes through `regenBorders`, so this is the one seam persistence needs — it is
   * not part of `STRUCT` and does not survive a reload, so the shell re-attaches it.
   *
   * A pane that changed something it remembers rather than its shape (an editor's pin) calls this
   * directly, because persistence treats the two as the same event: the blob is saved whole either
   * way.
   */
  onLayoutChange?: () => void;

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

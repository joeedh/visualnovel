import {
  Context,
  ContextFlags,
  ContextOverlay,
  getLastToolStruct,
  type ContextLike,
  type DataAPI,
  type ToolStack,
} from 'pathux';
import type { LayoutFile } from '../../../src/shared/layouts.js';
import type { VnScreen } from './screen.js';
import type { ShellState } from './state.js';

/** What every tool and widget in the shell can reach. Grows one member per port. */
export interface VnContext extends ContextLike<ShellApp, ToolStack> {
  ui: ShellState;
}

/**
 * The app object the overlays forward from; `AppState` in path.ux's own example. `screen` and
 * `screenClass` are there for `simple.saveFile`/`loadFile`, which take an app-shaped thing and
 * swap its screen for the one they read.
 */
export interface ShellApp {
  toolstack: ToolStack;
  api: DataAPI;
  ui: ShellState;
  ctx: ShellContext;
  screen: VnScreen | undefined;
  screenClass: typeof VnScreen;
  /**
   * Throw the current mesh away and build the default one. A member of the app rather than a
   * function `view.ts` imports: the shell owns what "default" is, and reaching back into it for
   * that would make the effect path import the boot path.
   */
  rebuild(): void;
  /**
   * Rearrange the window to a layout template, answering whether it took. Here for the same
   * reason `rebuild` is: only the shell knows how to stand a screen up, and a refusal has to be
   * reportable rather than a half-built mesh.
   */
  applyLayout(file: LayoutFile): boolean;
}

class VnOverlay extends ContextOverlay {
  static override contextDefine() {
    return { name: 'view', flag: ContextFlags.IS_VIEW };
  }

  get toolstack() {
    return (this.state as ShellApp).toolstack;
  }

  get api() {
    return (this.state as ShellApp).api;
  }

  get ui() {
    return (this.state as ShellApp).ui;
  }

  get screen() {
    return (this.state as ShellApp).screen!;
  }

  // path.ux's last-tool widget resolves through this; `api.ts` declares the matching struct.
  get last_tool() {
    return getLastToolStruct(this as unknown as ContextLike);
  }
}

Context.register(VnOverlay);

/** The context handed to the screen. `VnOverlay` supplies its members at runtime. */
export class ShellContext extends Context<VnOverlay> {
  constructor(app: ShellApp) {
    super(app);
    this.pushOverlay(new VnOverlay(app));
  }
}

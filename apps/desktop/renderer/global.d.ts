import type { DesktopApi } from '../src/shared/ipc';
import type { AnchorRecord } from './rules/anchors';
import type { ScopeReport, SweptAnchor } from './pathux/tour/anchors';
import type { Debugger2D } from '@vn/debug2d';

declare global {
  interface Window {
    /** Injected by the preload bridge. Absent when the renderer runs in a plain browser. */
    api?: DesktopApi;
    /** The 2D debug surface, installed by debug/install.ts. Dev builds only. */
    __vnDebug?: Debugger2D;
    /**
     * Every anchor drawn right now. Ships in production, unlike `__vnDebug`: the sweep reads it
     * over CDP and the tour overlay reads it at runtime.
     */
    __vnAnchors?: {
      generation: () => number;
      dump: () => SweptAnchor[];
      /** The half of the map derived from the menu table, which no pane draws and no sweep can see. */
      menus: () => AnchorRecord[];
      /** Anchors whose ring would not land on the thing they name. A healthy screen lists none. */
      strays: () => string[];
      /** Click the control an anchor key names, which is how the sweep opens each toolbar popup. */
      press: (key: string) => boolean;
      /** Each live keymap against the shortcut table, which the sweep prints. */
      shortcuts: () => ScopeReport[];
    };
    /** Which tour is running, which step it is on, and what the overlay is ringing. Read over CDP. */
    __vnTour?: () => { tour: string; at: number; step: string; ring?: string } | null;
  }
}

export {};

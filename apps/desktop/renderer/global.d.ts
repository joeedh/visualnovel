import type { DesktopApi } from '../src/shared/ipc';
import type { AnchorDump } from './pathux/anchors';
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
    __vnAnchors?: { generation: () => number; dump: () => AnchorDump[] };
  }
}

export {};

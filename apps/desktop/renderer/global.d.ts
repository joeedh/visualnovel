import type { DesktopApi } from '../src/shared/ipc';
import type { Debugger2D } from '@vn/debug2d';

declare global {
  interface Window {
    /** Injected by the preload bridge. Absent when the renderer runs in a plain browser. */
    api?: DesktopApi;
    /** The 2D debug surface, installed by debug/install.ts. Dev builds only. */
    __vnDebug?: Debugger2D;
  }
}

export {};

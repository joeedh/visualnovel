import type { DesktopApi } from '../src/shared/ipc';

declare global {
  interface Window {
    /** Injected by the preload bridge. Absent when the renderer runs in a plain browser. */
    api?: DesktopApi;
  }
}

export {};

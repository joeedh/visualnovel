/**
 * Preload bridge. Runs with context isolation, so the renderer never touches Node or the
 * raw `ipcRenderer` — it only sees the typed `window.api` surface declared by `DesktopApi`.
 * Bundled as CommonJS (see `scripts/esbuild.desktop.mjs`).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DesktopApi } from '../shared/ipc.js';

const api: DesktopApi = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void =>
      listener(payload as never);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);

/**
 * Preload bridge. Runs with context isolation, so the renderer never touches Node or the
 * raw `ipcRenderer` — it only sees the typed `window.api` surface declared by `DesktopApi`.
 * Bundled as CommonJS (see `scripts/esbuild.desktop.mjs`).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { CommandBridge, DesktopApi } from '../shared/ipc.js';

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

/**
 * The scripting surface: `window.vn`. Lives in the preload rather than React so it exists
 * before the app mounts, which is what makes it usable from the DevTools console on load and
 * from CDP `Runtime.evaluate` (see `scripts/vn-cdp.mjs`).
 */
const vn: CommandBridge = {
  exec: (dslOrId, props) =>
    ipcRenderer.invoke(
      'command:exec',
      props === undefined ? { dsl: dslOrId, source: 'cdp' } : { id: dslOrId, props, source: 'cdp' },
    ),
  catalog: () => ipcRenderer.invoke('command:catalog'),
  history: (limit) => ipcRenderer.invoke('command:history', limit),
  undo: () => ipcRenderer.invoke('command:undo'),
  redo: () => ipcRenderer.invoke('command:redo'),
};

contextBridge.exposeInMainWorld('vn', vn);

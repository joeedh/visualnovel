import { useCallback, useEffect, useState } from 'react';
import { api, isLive } from '../api';
import { Palette } from './Palette';
import { Topbar } from './Topbar';
import { useAgent } from './useAgent';
import { Floor } from '../rooms/floor/Floor';
import { Runner } from '../rooms/play/Runner';
import { Studio } from '../rooms/studio/Studio';
import type { PipelineStatus, UndoState, WorkspaceIndex } from '../../src/shared/ipc';
import type { FloorMode, Room, StudioMode } from '../rooms/rooms';

const NO_UNDO: UndoState = {
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
};

/**
 * The retired shell, kept behind `--react` for one release: which room is up, the palette, and
 * the workspace-level data the rooms read. Each room owns its own layout under `rooms/`; the
 * conversation lives in `useAgent`. Navigation is its own tab nav and nothing else — the `view.*`
 * commands address **editors** now, which is a vocabulary this shell has no panes for.
 */
export function App(): JSX.Element {
  const [room, setRoom] = useState<Room>('studio');
  const [studioMode, setStudioMode] = useState<StudioMode>('convo');
  const [floorMode, setFloorMode] = useState<FloorMode>('list');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [index, setIndex] = useState<WorkspaceIndex | null>(null);
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [undo, setUndo] = useState<UndoState>(NO_UNDO);
  // Bumped by an undo/redo or a palette-run mutating command, and used to remount the room:
  // those are the writes a room did not make itself, so its own refresh never fires for them.
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const agent = useAgent();
  const { setBusy, toggleMode, clearConvo } = agent;

  const loadStatus = useCallback(() => {
    void api.invoke('pipeline:status').then(setStatus);
  }, []);

  // A command run from the palette can have written anything the shell displays — the index's
  // diagnostics most of all — so re-read the workspace and remount the room, as undo does.
  const reload = useCallback(() => {
    void api.invoke('workspace:index').then(setIndex);
    loadStatus();
    setRevision((n) => n + 1);
  }, [loadStatus]);

  // The rail's diagnostics are a way into a scene now, so they have to be current after an edit
  // the room made itself. Deliberately not `reload`: bumping the revision remounts the room, which
  // would throw away the editor's own state mid-gesture.
  const refreshIndex = useCallback(() => {
    void api.invoke('workspace:index').then(setIndex);
  }, []);

  // Load workspace index + pipeline status once.
  useEffect(() => {
    void api.invoke('workspace:index').then(setIndex);
    loadStatus();
  }, [loadStatus]);

  // Apply the UI effects this shell still has a place for. `view` effects name a pane and an
  // editor, which is the path.ux mesh's vocabulary — a room shell can only ignore them.
  useEffect(() => {
    return api.on('command:ui', (effect) => {
      if (effect.type === 'palette') setPaletteOpen(effect.open);
      else if (effect.type === 'undo') {
        setUndo(effect.state);
        setRevision(effect.revision);
      } else if (effect.type === 'workspace') {
        // A different project: everything on screen was read out of the old one, and the
        // conversation belonged to it too.
        setNotice(`Opened ${effect.title}`);
        clearConvo();
        reload();
      }
    });
  }, [clearConvo, reload]);

  // A refusal is the interesting outcome here — undo declines rather than guessing when the
  // workspace moved under it, and the author needs to be told why.
  const move = useCallback(async (direction: 'undo' | 'redo') => {
    const result = await api.invoke(direction === 'undo' ? 'command:undo' : 'command:redo');
    setNotice(result.ok ? (result.record?.message ?? null) : result.error);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const runPipeline = useCallback(async () => {
    setBusy(true);
    try {
      await api.invoke('pipeline:run', { mock: !isLive });
      setStatus(await api.invoke('pipeline:status'));
    } finally {
      setBusy(false);
    }
  }, [setBusy]);

  // Shift-Tab toggles mode (the REPL's gesture); "/" opens the palette; Escape closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? '';
      const accel = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // Not while typing: in a composer or a label editor these belong to the text field.
      if (accel && (key === 'z' || key === 'y') && !/^(input|textarea)$/i.test(tag)) {
        e.preventDefault();
        void move(key === 'y' || e.shiftKey ? 'redo' : 'undo');
      } else if (e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        void toggleMode();
      } else if (e.key === '/' && !/^(input|textarea)$/i.test(tag)) {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === 'Escape') {
        setPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleMode, move]);

  return (
    <div className="app">
      <Topbar
        room={room}
        setRoom={setRoom}
        mode={agent.mode}
        toggleMode={agent.toggleMode}
        title={index?.title}
        model={agent.model}
        diagnostics={index?.diagnostics ?? []}
        undo={undo}
        onUndo={() => void move('undo')}
        onRedo={() => void move('redo')}
      />
      {/* `key` is the undo revision: a restore rewrote files the room is displaying, and a
          remount is how it re-reads them without every surface growing its own subscription. */}
      {room === 'studio' ? (
        <Studio
          key={revision}
          index={index}
          agent={agent}
          mode={studioMode}
          setMode={setStudioMode}
          openPalette={() => setPaletteOpen(true)}
          setRoom={setRoom}
          onEdit={refreshIndex}
        />
      ) : room === 'floor' ? (
        <Floor
          key={revision}
          status={status}
          mode={floorMode}
          setMode={setFloorMode}
          runPipeline={runPipeline}
          refresh={loadStatus}
          busy={agent.busy}
        />
      ) : (
        <Runner key={revision} />
      )}
      {notice && <div className="shell-notice mono">{notice}</div>}
      {paletteOpen && (
        <Palette
          currentModel={agent.model}
          mode={agent.mode}
          onModel={agent.setModel}
          onToggleMode={agent.toggleMode}
          onClear={agent.clearConvo}
          onClose={() => setPaletteOpen(false)}
          onRan={reload}
        />
      )}
    </div>
  );
}

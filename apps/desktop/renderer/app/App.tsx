import { useCallback, useEffect, useState } from 'react';
import { api, isLive } from '../api';
import { Palette } from './Palette';
import { Topbar } from './Topbar';
import { useAgent } from './useAgent';
import { Floor } from '../rooms/floor/Floor';
import { Runner } from '../rooms/play/Runner';
import { Studio } from '../rooms/studio/Studio';
import type {
  FloorMode,
  PipelineStatus,
  Room,
  StudioMode,
  WorkspaceIndex,
} from '../../src/shared/ipc';

/**
 * The shell, and only the shell: which room is up, the palette, and the workspace-level
 * data the rooms read. Each room owns its own layout under `rooms/`; the conversation
 * lives in `useAgent`.
 */
export function App(): JSX.Element {
  const [room, setRoom] = useState<Room>('studio');
  const [studioMode, setStudioMode] = useState<StudioMode>('convo');
  const [floorMode, setFloorMode] = useState<FloorMode>('list');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [index, setIndex] = useState<WorkspaceIndex | null>(null);
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const agent = useAgent();
  const { setBusy, toggleMode } = agent;

  const loadStatus = useCallback(() => {
    void api.invoke('pipeline:status').then(setStatus);
  }, []);

  // Load workspace index + pipeline status once.
  useEffect(() => {
    void api.invoke('workspace:index').then(setIndex);
    loadStatus();
  }, [loadStatus]);

  // Apply UI effects pushed by `view.*` commands, so the palette, the menu bar and CDP all
  // drive the shell through the one registry rather than a second renderer-side one.
  useEffect(() => {
    return api.on('command:ui', (effect) => {
      if (effect.type === 'room') setRoom(effect.name);
      else if (effect.type === 'palette') setPaletteOpen(effect.open);
      else if (effect.room === 'studio') setStudioMode(effect.mode);
      else setFloorMode(effect.mode);
    });
  }, []);

  const runPipeline = useCallback(async () => {
    setBusy(true);
    try {
      await api.invoke('pipeline:run', { mock: !isLive || true });
      setStatus(await api.invoke('pipeline:status'));
    } finally {
      setBusy(false);
    }
  }, [setBusy]);

  // Shift-Tab toggles mode (the REPL's gesture); "/" opens the palette; Escape closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? '';
      if (e.shiftKey && e.key === 'Tab') {
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
  }, [toggleMode]);

  return (
    <div className="app">
      <Topbar
        room={room}
        setRoom={setRoom}
        mode={agent.mode}
        toggleMode={agent.toggleMode}
        title={index?.title}
        model={agent.model}
      />
      {room === 'studio' ? (
        <Studio
          index={index}
          agent={agent}
          mode={studioMode}
          setMode={setStudioMode}
          openPalette={() => setPaletteOpen(true)}
          setRoom={setRoom}
        />
      ) : room === 'floor' ? (
        <Floor
          status={status}
          mode={floorMode}
          setMode={setFloorMode}
          runPipeline={runPipeline}
          refresh={loadStatus}
          busy={agent.busy}
        />
      ) : (
        <Runner />
      )}
      {paletteOpen && (
        <Palette
          currentModel={agent.model}
          mode={agent.mode}
          onModel={agent.setModel}
          onToggleMode={agent.toggleMode}
          onClear={agent.clearConvo}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  );
}

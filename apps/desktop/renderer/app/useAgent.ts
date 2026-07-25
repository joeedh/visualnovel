/**
 * The vnauthor conversation, lifted out of the shell: the `agent:event` and
 * `permission:plan` subscriptions plus the state STUDIO renders from them.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api, isLive, onAgentEvent } from '../api';
import type { AgentMode, PlanRequest } from '../../src/shared/ipc';

/** A rendered line in the conversation feed. */
export interface FeedItem {
  id: number;
  role: 'user' | 'agent' | 'tool' | 'blocked';
  text: string;
}

export interface Agent {
  mode: AgentMode;
  model: string;
  feed: FeedItem[];
  dboxLine: string;
  planReq: PlanRequest | null;
  busy: boolean;
  /** The composer is uncontrolled; `send` and `seed` both reach it through this ref. */
  inputRef: RefObject<HTMLInputElement>;
  send: () => void;
  toggleMode: () => Promise<void>;
  setModel: (id: string) => Promise<void>;
  clearConvo: () => Promise<void>;
  decidePlan: (approved: boolean) => void;
  /**
   * `busy` is shell-wide rather than agent-only — FLOOR's run button raises it too, so a
   * pipeline run disables the composer. The shell needs the setter to keep that true.
   */
  setBusy: (busy: boolean) => void;
}

let feedSeq = 0;

export function useAgent(): Agent {
  const [mode, setMode] = useState<AgentMode>('plan');
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [dboxLine, setDboxLine] = useState(
    isLive
      ? 'Workspace loaded. Tell me what to change — I plan first, you approve, then I edit and commit.'
      : 'Design preview (no Electron bridge). Live data appears when launched as the desktop app.',
  );
  const [planReq, setPlanReq] = useState<PlanRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [model, setModelState] = useState('claude-opus-4-8');
  const inputRef = useRef<HTMLInputElement>(null);

  const pushFeed = useCallback((role: FeedItem['role'], text: string) => {
    setFeed((f) => [...f, { id: ++feedSeq, role, text }]);
  }, []);

  // Subscribe to the agent event stream.
  useEffect(() => {
    return onAgentEvent((event) => {
      switch (event.type) {
        case 'tool':
          pushFeed('tool', event.tool);
          break;
        case 'message':
          setDboxLine(event.text);
          break;
        case 'final':
          setDboxLine(event.text);
          break;
        case 'mode':
          setMode(event.mode);
          break;
        case 'blocked':
          pushFeed('blocked', `${event.tool} blocked — ${event.reason}`);
          break;
      }
    });
  }, [pushFeed]);

  // Subscribe to plan-approval requests.
  useEffect(() => {
    return api.on('permission:plan', (req) => setPlanReq(req));
  }, []);

  const send = useCallback(async () => {
    const text = inputRef.current?.value.trim();
    if (!text || busy) return;
    inputRef.current!.value = '';
    pushFeed('user', text);
    setBusy(true);
    try {
      const result = await api.invoke('agent:run', text);
      if (result) setDboxLine(result.final);
    } finally {
      setBusy(false);
    }
  }, [busy, pushFeed]);

  const toggleMode = useCallback(async () => {
    const next: AgentMode = mode === 'plan' ? 'execute' : 'plan';
    const applied = await api.invoke('agent:setMode', next);
    setMode(applied ?? next);
  }, [mode]);

  const setModel = useCallback(async (id: string) => {
    const applied = await api.invoke('agent:setModel', id);
    setModelState(applied ?? id);
  }, []);

  const clearConvo = useCallback(async () => {
    await api.invoke('agent:clear');
    setFeed([]);
    setMode('plan');
    setDboxLine('Conversation cleared. Back to plan mode.');
  }, []);

  const decidePlan = useCallback(
    (approved: boolean) => {
      if (!planReq) return;
      void api.invoke('plan:decision', { id: planReq.id, decision: { approved } });
      if (approved) setMode('execute');
      setPlanReq(null);
    },
    [planReq],
  );

  return {
    mode,
    model,
    feed,
    dboxLine,
    planReq,
    busy,
    inputRef,
    send,
    toggleMode,
    setModel,
    clearConvo,
    decidePlan,
    setBusy,
  };
}

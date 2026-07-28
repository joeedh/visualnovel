/**
 * The editor's state: the branch graph, the animation between two layouts of it, and the one
 * path by which a gesture becomes a change.
 *
 * Every mutation goes out over `command:exec`, so the editor, the palette and CDP all leave
 * the same kind of `CommandRecord` — and the rebuilt graph comes back on the outcome, so the
 * view never has to re-read what it just wrote.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../api';
import { DURATION, tweenLayout } from './tween.js';
import type { Intent } from '../../../../src/shared/interactions.js';
import type { GraphLayout } from '../../../graph/layout.js';
import type { StoryGraph } from '../../../../src/shared/ipc';

/** A one-line report of the last thing that happened, or of what a drop would do. */
export interface Notice {
  tone: 'ok' | 'refused' | 'preview';
  text: string;
}

export interface Branch {
  story: StoryGraph | null;
  notice: Notice | null;
  setNotice: (notice: Notice | null) => void;
  /** Execute an intent; false means the command refused, with the reason in `notice`. */
  run: (intent: Intent) => Promise<boolean>;
}

export function useBranch(): Branch {
  const [story, setStory] = useState<StoryGraph | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    void api.invoke('story:graph').then(setStory);
  }, []);

  const run = useCallback(async (intent: Intent): Promise<boolean> => {
    const outcome = await api.invoke('command:exec', {
      id: intent.id,
      props: intent.props,
      source: 'ui',
    });
    if (!outcome.ok) {
      setNotice({ tone: 'refused', text: outcome.error });
      return false;
    }
    // `story.*` commands answer with the rebuilt graph, so reachability is never a beat behind.
    if (outcome.data) setStory(outcome.data as StoryGraph);
    setNotice({ tone: 'ok', text: outcome.record.message ?? intent.note });
    return true;
  }, []);

  return { story, notice, setNotice, run };
}

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The layout as it should be drawn *this frame*. A new target starts a tween from wherever the
 * previous one had got to, so a second rewire mid-animation continues from the visible
 * positions rather than snapping back to the ones it started from.
 */
export function useAnimatedLayout(target: GraphLayout): GraphLayout {
  const [current, setCurrent] = useState(target);
  const shown = useRef(target);

  useEffect(() => {
    if (reducedMotion()) {
      shown.current = target;
      setCurrent(target);
      return;
    }
    const base = shown.current;
    const start = performance.now();
    let raf = requestAnimationFrame(function step(now: number) {
      const next = tweenLayout(base, target, (now - start) / DURATION);
      shown.current = next;
      setCurrent(next);
      if (next !== target) raf = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(raf);
  }, [target]);

  return current;
}

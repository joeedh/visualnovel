/**
 * Renderer-side access to the persisted desktop state the main process keeps in
 * `.vndesktop/session.json`. The initial read is synchronous (see `DesktopApi.session`), so a
 * component that uses this paints at its saved value rather than jumping to it.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { SessionValue } from '../src/shared/ipc';

/**
 * A piece of persisted UI state, like `useState` but durable. Writes go to the store;
 * changes made elsewhere (a `view.*` command, say) arrive over `session:changed`.
 */
export function useSessionValue<T extends SessionValue>(
  key: string,
  fallback: T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = api.session.initial()[key];
    return stored === undefined ? fallback : (stored as T);
  });

  useEffect(() => {
    return api.on('session:changed', (change) => {
      if (change.key === key) setValue(change.value as T);
    });
  }, [key]);

  const persist = useCallback(
    (next: T) => {
      setValue(next);
      api.session.set(key, next);
    },
    [key],
  );

  return [value, persist];
}

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';

/**
 * The retired room shell, kept behind `--react` for one release of caution. It lives in its own
 * module so the default shell never imports React — deleting this file and its `rooms/` tree is
 * what finishes the rewrite.
 */
export function startReactShell(): void {
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

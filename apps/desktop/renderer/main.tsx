import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Statically false in `vite build`, so the entire @vn/debug2d package is dropped from
// the production bundle — strippability enforced by the bundler, not by discipline.
if (import.meta.env.DEV) {
  void import('./debug/install').then((m) => m.installDebug());
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

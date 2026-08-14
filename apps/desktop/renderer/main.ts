import './styles/index.css';

// Statically false in `vite build`, so the entire @vn/debug2d package is dropped from
// the production bundle — strippability enforced by the bundler, not by discipline.
if (import.meta.env.DEV) {
  void import('./debug/install').then((m) => m.installDebug());
}

// `styles/index.css` is loaded at document level rather than adopted by the shell: custom
// properties are the one thing that crosses a shadow boundary, so `tokens.css` is what the
// editors' `var(--…)` reads resolve against.
void import('./pathux/shell').then((m) => m.startShell());

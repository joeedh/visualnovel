import './styles/index.css';

// Statically false in `vite build`, so the bundler drops the entire @vn/debug2d package
// from the production bundle.
if (import.meta.env.DEV) {
  void import('./debug/install').then((m) => m.installDebug());
}

// `styles/index.css` is loaded at document level rather than adopted by the shell: custom
// properties are the one thing that crosses a shadow boundary, so `tokens.css` is what the
// editors' `var(--…)` reads resolve against.
void import('./pathux/app/shell').then((m) => m.startShell());

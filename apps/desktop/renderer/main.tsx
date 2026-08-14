import './styles/index.css';

// Statically false in `vite build`, so the entire @vn/debug2d package is dropped from
// the production bundle — strippability enforced by the bundler, not by discipline.
if (import.meta.env.DEV) {
  void import('./debug/install').then((m) => m.installDebug());
}

// The shell is path.ux; `--react` in main becomes this flag and boots the retired room shell.
// The two are mutually exclusive and both are imported lazily, so the default shell does not
// pay for React's bundle while the old one is still here. `styles/index.css` stays at document
// level for both: custom properties are the one thing that crosses a shadow boundary, so
// `tokens.css` is what the path.ux editors' `var(--…)` reads resolve against.
if (new URLSearchParams(location.search).has('react')) {
  void import('./react-shell').then((m) => m.startReactShell());
} else {
  document.getElementById('root')?.remove();
  void import('./pathux/shell').then((m) => m.startShell());
}

# Publishing a VN as a web page

The desktop app can install a GitHub Actions workflow that publishes a project as a static
light-novel site on GitHub Pages. The format itself is described in
[`../reference/playable-format.md`](../reference/playable-format.md#the-web-export); this guide is
what an author does.

<!-- toc -->

- [Installing it](#installing-it)
- [Turning it on](#turning-it-on)
- [Things worth knowing](#things-worth-knowing)
- [Rendering the site without the app](#rendering-the-site-without-the-app)

<!-- tocstop -->

## Installing it

**VN STUDIO ▸ Install GitHub Page Builder…** The entry reads **Update GitHub Page Builder…** once
a project already carries it.

The command refuses, in this order, if the project is not a git repository, has no branch checked
out yet, or has no `origin` remote. It needs all three: what it installs is a workflow that only
runs once the project is pushed to GitHub.

On accept it exports the playable and writes three files:

| File | What it is |
| --- | --- |
| `.github/workflows/vn-pages.yml` | the workflow, triggered on pushes to the branch that was checked out at install time |
| `.vnstudio/pages/vn-site.mjs` | the site renderer, bundled with no dependencies |
| `.gitattributes` | gains one `-merge` line for the bundle |

Commit-on-save commits all of it. The app never pushes.

## Turning it on

Two steps remain, and the notification the command files says so:

1. **Push the branch to `origin`.** The workflow runs on that push.
2. **Settings ▸ Pages ▸ Deploy from a branch**, and pick **`gh-pages`** at the root.

The workflow renders the site and force-pushes it to `gh-pages` as a single-commit orphan branch,
so the published branch is a rendering you can open and read rather than a history. It refuses to
touch a `gh-pages` that it did not write: every site it publishes carries a `.vn-pages` marker at
the root, and a branch without one fails the run with a message rather than being overwritten.

## Things worth knowing

- **The renderer is a committed build artifact.** It goes out of date when the app updates, and
  nothing prompts you. Reopening the menu is the check: the entry reads Update, and the status the
  app reads compares the installed bytes against the running build's.
- **Removing it is a manual `git rm`.** The command is not undoable — it writes outside the
  document tree the undo snapshot covers — and there is no uninstall command. Delete
  `.github/workflows/vn-pages.yml` and `.vnstudio/pages/vn-site.mjs`.
- **The trigger branch is frozen at install time.** Renaming the default branch afterwards stops
  the workflow firing, silently. Reinstall to repoint it.
- **Pages on a private repository needs a paid plan.** Without one the Action succeeds and the
  published URL still 404s.
- **The published branch holds a full copy of every image.** A project with hundreds of generated
  frames makes a large branch; GitHub's soft limit is 1 GB per repository.
- **A frame with no accepted asset renders as no picture at all**, rather than a broken image. A
  half-generated project publishes fine.

## Rendering the site without the app

The bundled renderer is an ordinary node program:

```bash
node apps/desktop/dist/main/vn-site.mjs --project <dir> --out <dir>/vngen/build/site
```

It needs `vngen/build/story.play.json`, which `vngen export <dir>` writes. There is no `vngen site`
subcommand — the renderer's home is the desktop app's `dist/`, because installing it into a project
is the only thing that reads it.

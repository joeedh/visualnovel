# Publishing a VN as a web page

The desktop app can install a GitHub Actions workflow that publishes a project as a static
light-novel site on GitHub Pages. The format itself is described in
[`../reference/playable-format.md`](../reference/playable-format.md#the-web-export); this guide
covers the steps an author takes.

<!-- toc -->

- [Installing it](#installing-it)
- [Turning it on](#turning-it-on)
- [Things worth knowing](#things-worth-knowing)
- [Rendering the site without the app](#rendering-the-site-without-the-app)

<!-- tocstop -->

## Installing it

The entry is **VN STUDIO ▸ Install GitHub Page Builder…**. It reads **Update GitHub Page Builder…**
once a project already carries it.

The command checks in this order and refuses if the project is not a git repository, has no branch
checked out yet, or has no `origin` remote. All three are required because the workflow it installs
runs only once the project is pushed to GitHub.

Accepting exports the playable and writes three files:

| File | What it is |
| --- | --- |
| `.github/workflows/vn-pages.yml` | the workflow, triggered on pushes to the branch that was checked out at install time |
| `.vnstudio/pages/vn-site.mjs` | the site renderer, bundled with no dependencies |
| `.gitattributes` | gains one `-merge` line for the bundle |

Commit-on-save commits all of it. The app never pushes.

## Turning it on

Two steps remain on GitHub, and both are manual:

1. 1. **Push the branch to `origin`.** The workflow runs on a push to `origin`.
2. 2. **On github.com, open the repository's Settings ▸ Pages**, set Source to Deploy from a
   branch, pick `gh-pages` with the folder / (root), and Save.

A skipped step 2 produces no error: the workflow goes green and the published address still 404s.
The app can neither perform step 2 nor check it, because the app never contacts GitHub and can
report only what is installed, not what is served. Three places carry the warning instead: the
confirmation the command asks for before installing, the durable notification the command files
afterwards, and `project.pagesStatus`. The authoring agent can also tell an author about step 2;
the steps are in its built-in prompt (`packages/authoring/src/context.ts`), because an author who
is already talking to it will ask it rather than reopening a menu.

The workflow renders the site and force-pushes it to `gh-pages` as a single-commit orphan branch,
so the published branch holds a rendering you can open and read rather than a history. The workflow
refuses to touch a `gh-pages` branch it did not write. Every site it publishes carries a
`.vn-pages` marker at the root, and the run fails with a message instead of overwriting a branch
that lacks one.

## Things worth knowing

- **The renderer is a committed build artifact.** It goes out of date when the app updates, and
  nothing prompts you. Reopening the menu checks it: the entry reads Update, and the status the app
  reads compares the installed bytes against the running build's.
- **Remove it by hand with `git rm`.** The command cannot be undone — it writes outside the
  document tree the undo snapshot covers — and there is no uninstall command. Delete
  `.github/workflows/vn-pages.yml` and `.vnstudio/pages/vn-site.mjs`.
- **The trigger branch is fixed at install time.** Renaming the default branch afterwards stops
  the workflow firing, and nothing reports the failure. Reinstall to repoint it.
- **Pages on a private repository needs a paid plan.** Without a paid plan the Action succeeds
  and the published URL still returns 404.
- **The published branch holds a full copy of every image.** A project with hundreds of generated
  frames makes the branch large, and GitHub's soft limit is 1 GB per repository.
- A frame with no accepted asset renders as no picture at all, rather than a broken image. A
  half-generated project publishes fine.

## Rendering the site without the app

The bundled renderer is an ordinary node program:

```bash
node apps/desktop/dist/main/vn-site.mjs --project <dir> --out <dir>/vngen/build/site
```

It needs `vngen/build/story.play.json`, which `vngen export <dir>` writes. There is no `vngen site`
subcommand. The desktop app's `dist/` holds the renderer, because installing the renderer into a
project is the only operation that reads it.

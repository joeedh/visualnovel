import { EDITOR_IDS, type EditorId } from './editors.js';

/**
 * Layout templates: named screen arrangements the project owns.
 *
 * A template lives in the project repo at `.vnstudio/layouts/<slug>.json` so it commits,
 * travels to a collaborator, and is undoable. The mesh currently on screen is a different
 * thing and stays per install, in `.vndesktop/session.json` under `pathux.layout` — the
 * template is the saved arrangement, not the live one. `pathux.template` is the pointer
 * between them.
 *
 * A template carries its arrangement in one of two forms, and the form says where it came from.
 * A recipe is a declarative tree of splits and panes. The shipped layouts use it, because main
 * writes those with no renderer in the loop (scaffolding a new project, ensuring an old one,
 * resetting) and only a live screen can produce the other form. A screen is path.ux's own
 * `simple.saveFile` blob. `Save Current Layout As…` writes that, because an author drags borders
 * into arrangements no split grammar describes, and per-pane state (the Documents editor's mode)
 * has no recipe representation at all.
 *
 * This file is in the browser bundle, so it must stay node-free, and `layoutSlug` is a local copy
 * of `@vn/model`'s rather than an import. Only `vite build` catches a violation here; neither
 * `tsgo` pass does.
 */

/** Where templates live, workspace-relative. Also what `.gitattributes` names. */
export const LAYOUT_DIR = '.vnstudio/layouts';

/** The envelope version — this file's shape, not the path.ux schema inside `screen`. */
export const LAYOUT_FORMAT = 'layout/1';

/** One pane: an editor stack in a single area. The editor listed last is the one showing. */
export interface LayoutPane {
  pane: EditorId[];
}

/** A division. `at` is a fraction of the area being divided, not of the window. */
export interface LayoutSplit {
  split: 'columns' | 'rows';
  at: number;
  first: LayoutRecipe;
  second: LayoutRecipe;
}

export type LayoutRecipe = LayoutPane | LayoutSplit;

export function isPane(node: LayoutRecipe): node is LayoutPane {
  return 'pane' in node;
}

/** A template as it is stored. Exactly one of `recipe` and `screen` is present. */
export interface LayoutFile {
  vnstudio: typeof LAYOUT_FORMAT;
  slug: string;
  title: string;
  description: string;
  /**
   * Every editor the arrangement holds, derived at write time. Read as a summary and checked
   * before the template is applied.
   */
  editors: EditorId[];
  source: 'shipped' | 'saved';
  recipe?: LayoutRecipe;
  screen?: unknown;
}

/** Carries enough about a template to draw a row in a list, never the arrangement itself. */
export interface LayoutSummary {
  slug: string;
  title: string;
  description: string;
  source: 'shipped' | 'saved';
  /** Changes when the file does. A window compares it to notice the file changed on disk. */
  fingerprint: string;
  /** Set when the file is there but unusable. The row says so and applying it is refused. */
  problem?: string;
}

/**
 * A slug that is safe as a filename and survives a round trip through a menu. Deliberately the
 * same rule as `@vn/model`'s `slug`, copied rather than imported to keep this node-free.
 */
export function layoutSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/** The editors a recipe holds, in the order they are built. */
export function recipeEditors(node: LayoutRecipe): EditorId[] {
  return isPane(node)
    ? [...node.pane]
    : [...recipeEditors(node.first), ...recipeEditors(node.second)];
}

/** Why a recipe cannot be built, or `undefined` if it can. */
export function recipeProblem(
  node: unknown,
  known: readonly string[] = EDITOR_IDS,
): string | undefined {
  if (!node || typeof node !== 'object') return 'a layout recipe must be an object';

  if ('pane' in node) {
    const { pane } = node as LayoutPane;
    if (!Array.isArray(pane) || pane.length === 0) return 'a pane must name at least one editor';
    const unknownId = pane.find((id) => !known.includes(id));
    if (unknownId !== undefined) return `there is no ${String(unknownId)} editor in this build`;
    return undefined;
  }

  const split = node as LayoutSplit;
  if (split.split !== 'columns' && split.split !== 'rows') {
    return `a split is into columns or rows, not ${String(split.split)}`;
  }
  if (typeof split.at !== 'number' || !(split.at > 0 && split.at < 1)) {
    return `a split has to fall inside the area it divides, and ${String(split.at)} does not`;
  }
  return recipeProblem(split.first, known) ?? recipeProblem(split.second, known);
}

/**
 * Read a template file. Every failure is a sentence naming what is wrong — the menu draws it
 * and a command refuses with it, so nothing here throws.
 */
export function parseLayoutFile(
  text: string,
  known: readonly string[] = EDITOR_IDS,
): { ok: true; file: LayoutFile } | { ok: false; problem: string } {
  if (isConflicted(text)) {
    return {
      ok     : false,
      problem:
        'a merge left both versions in it — pick a side with `git checkout --ours` or `--theirs`',
    };
  }

  let parsed: unknown;
  try {
    // A template is a file an author may open in an editor, and on Windows that means Notepad and
    // PowerShell, both of which write a BOM. `JSON.parse` rejects one, so refusing over it would
    // be refusing a layout that is otherwise perfectly good.
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    return { ok: false, problem: `it is not valid JSON (${(err as Error).message})` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, problem: 'it is not a layout template' };
  }

  const file = parsed as Partial<LayoutFile>;
  if (file.vnstudio !== LAYOUT_FORMAT) {
    return {
      ok     : false,
      problem: `it is in the ${String(file.vnstudio)} format, not ${LAYOUT_FORMAT}`,
    };
  }
  if (file.recipe !== undefined && file.screen !== undefined) {
    return {
      ok     : false,
      problem: 'it holds both a recipe and a saved screen, and only one can be right',
    };
  }
  if (file.recipe !== undefined) {
    const problem = recipeProblem(file.recipe, known);
    if (problem) return { ok: false, problem };
  } else if (!file.screen || typeof file.screen !== 'object') {
    return { ok: false, problem: 'it holds neither a recipe nor a saved screen' };
  }

  const missing = (file.editors ?? []).filter((id) => !known.includes(id));
  if (missing.length > 0) {
    return {
      ok     : false,
      problem: `it uses the ${missing.join(', ')} editor(s), which this build has not got`,
    };
  }

  return {
    ok  : true,
    file: {
      vnstudio   : LAYOUT_FORMAT,
      slug       : typeof file.slug === 'string' ? file.slug : '',
      title: typeof file.title === 'string' && file.title ? file.title : (file.slug ?? 'Untitled'),
      description: typeof file.description === 'string' ? file.description : '',
      editors    : file.editors ?? [],
      source     : file.source === 'shipped' ? 'shipped' : 'saved',
      ...(file.recipe !== undefined ? { recipe: file.recipe } : {}),
      ...(file.screen !== undefined ? { screen: file.screen } : {}),
    },
  };
}

/**
 * Whether a merge left both sides in the file. Templates are declared unmergeable, so this is
 * the expected state after a conflicting pull, and such a template is refused rather than
 * half-applied.
 */
export function isConflicted(text: string): boolean {
  return /^<{7}( |$)/m.test(text) && /^>{7}( |$)/m.test(text);
}

/**
 * Pretty-prints with a trailing newline, so the file stays readable text even when the
 * arrangement it holds is an opaque blob.
 */
export function serializeLayoutFile(file: LayoutFile): string {
  return JSON.stringify(file, null, 2) + '\n';
}

const WRITING: LayoutRecipe = {
  split : 'columns',
  at    : 0.6,
  first: {
    split : 'columns',
    at    : 0.3,
    first : { pane: ['documents'] },
    second: { pane: ['script', 'branches'] },
  },
  second: { pane: ['convo'] },
};

const ART: LayoutRecipe = {
  split : 'columns',
  at    : 0.7,
  first: {
    split : 'columns',
    at    : 0.3,
    first : { pane: ['documents'] },
    second: { pane: ['asset'] },
  },
  second: { pane: ['tasklist', 'taskgraph'] },
};

/**
 * The arrangements every project has whether or not it has a file for one. `Writing` is the
 * shell's own default screen — `buildDefaultScreen` builds this recipe rather than a second
 * copy of it, so the two can never drift.
 */
export const SHIPPED_LAYOUTS: readonly {
  slug: string;
  title: string;
  description: string;
  recipe: LayoutRecipe;
}[] = [
  {
    slug       : 'writing',
    title      : 'Writing',
    description: 'The documents tree, the script with the branch cards behind it, and the agent.',
    recipe     : WRITING,
  },
  {
    slug       : 'art',
    title      : 'Art',
    description: 'The documents tree, one asset with its art notes, and the pipeline queue.',
    recipe     : ART,
  },
];

/** What the shell builds when there is nothing remembered and no template to apply. */
export const DEFAULT_RECIPE = WRITING;

export const DEFAULT_LAYOUT = 'writing';

/** One shipped layout as the file that stores it. The single authority for those bytes. */
export function shippedLayoutFile(slug: string): LayoutFile | undefined {
  const shipped = SHIPPED_LAYOUTS.find((entry) => entry.slug === slug);
  if (!shipped) return undefined;
  return {
    vnstudio   : LAYOUT_FORMAT,
    slug       : shipped.slug,
    title      : shipped.title,
    description: shipped.description,
    editors    : recipeEditors(shipped.recipe),
    source     : 'shipped',
    recipe     : shipped.recipe,
  };
}

/** Every shipped layout as `{path, text}`, for whoever is scaffolding a project. */
export function shippedLayoutFiles(): { path: string; text: string }[] {
  return SHIPPED_LAYOUTS.map((entry) => ({
    path: `${LAYOUT_DIR}/${entry.slug}.json`,
    text: serializeLayoutFile(shippedLayoutFile(entry.slug)!),
  }));
}

/** The `.gitattributes` rule that tells git not to merge a layout. */
export const LAYOUT_ATTRIBUTE = `${LAYOUT_DIR}/*.json text eol=lf -merge`;

export const LAYOUT_ATTRIBUTES_BLOCK =
  '# A view layout is one blob: which panes exist, how big they are, what each holds. Two\n' +
  "# authors' versions merged line by line make an arrangement neither of them built, so git is\n" +
  '# told not to try. Pick one:\n' +
  `#   git checkout --ours   ${LAYOUT_DIR}/<name>.json    # keep mine\n` +
  `#   git checkout --theirs ${LAYOUT_DIR}/<name>.json    # take theirs\n` +
  `#   git add               ${LAYOUT_DIR}/<name>.json\n` +
  `${LAYOUT_ATTRIBUTE}\n`;

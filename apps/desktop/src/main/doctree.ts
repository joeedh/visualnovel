/**
 * The sidebar's two shapes, as pure projections: a logical document tree and per-entity
 * backlinks. Every edge here already exists somewhere — the model's cast lists, `ShotSubject`,
 * `Asset.satisfies`, the tag index — so this module reads no file and writes none. Plan:
 * `docs/plans/document-tree-and-backlinks.md`.
 */
import { relative } from 'node:path';
import type { LoadedInputs } from '@vn/parse';
import { bindsTo, type Asset, type AssetKind, type ProjectModel, type Shot } from '@vn/types';
import { isBaseKind } from '@vn/store';
import type { BibleFile } from '@vn/bible';
import type { DocNode, DocTree, EntityLinks } from '../shared/ipc.js';

/** Most children a branch prints before it says how many it dropped. */
export const DEFAULT_CAP = 50;

/** Everything the tree is built from — all of it already loaded by the caller. */
export interface DocTreeInput {
  root: string;
  model: ProjectModel;
  inputs: LoadedInputs;
  manifest: readonly Asset[];
  /**
   * Persisted shots by scene id. A scene absent from the map has no decomposition; one mapped to
   * `null` has a file that could not be read, which the tree says rather than hides.
   */
  shots: Map<string, Shot[] | null>;
  bible: BibleFile[];
  /** The bible root, workspace-relative — `wiki` normally, and the prefix its nodes carry. */
  wikiDir: string;
  cap?: number;
}

/** Workspace-relative, `/`-separated: these are shown to a human and shipped over IPC. */
export function relPath(root: string, file: string): string {
  return relative(root, file).split('\\').join('/');
}

const node = (
  id: string,
  kind: DocNode['kind'],
  label: string,
  over: Partial<DocNode> = {},
): DocNode => ({ id, kind, label, ...over });

/**
 * Apply the cap, appending one counted node when it bit. The count is in the shape rather than
 * left to the renderer, so a truncated branch cannot be drawn as a complete one.
 */
function capped(id: string, children: DocNode[], cap: number): DocNode[] {
  if (children.length <= cap) return children;
  const dropped = children.length - cap;
  return [...children.slice(0, cap), node(`more:${id}`, 'more', `… and ${dropped} more`)];
}

const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  portrait: 'Portraits',
  model_sheet: 'Model sheets',
  outfit_sheet: 'Outfit sheets',
  location_ref: 'Location plates',
  shot_image: 'Shot frames',
};

function storyBranch(input: DocTreeInput, cap: number): DocNode {
  const files = new Map(input.inputs.sceneDocs.map((d) => [d.id, relPath(input.root, d.file)]));
  const scenes = [...input.model.scenes.values()].map((scene) => {
    const shots = input.shots.get(scene.id);
    const children =
      shots == null
        ? undefined
        : capped(
            `scene:${scene.id}`,
            shots.map((s) => node(`shot:${scene.id}/${s.id}`, 'shot', s.id, { badge: s.framing })),
            cap,
          );
    // Unreadable outranks unreachable: one is a fact about the story, the other about the disk,
    // and the disk is the one somebody has to go fix.
    const badge =
      shots === null
        ? 'unreadable'
        : input.model.reachable.has(scene.id)
          ? undefined
          : 'unreachable';
    return node(`scene:${scene.id}`, 'scene', scene.id, {
      ...(files.has(scene.id) ? { path: files.get(scene.id)! } : {}),
      ...(badge ? { badge } : {}),
      ...(children ? { children } : {}),
    });
  });
  return node('branch:story', 'branch', 'Story', { children: scenes });
}

function entityBranch(input: DocTreeInput, kind: 'character' | 'location'): DocNode {
  if (kind === 'character') {
    const files = new Map(
      input.inputs.characterDocs.map((d) => [d.id, relPath(input.root, d.file)]),
    );
    const children = [...input.model.characters.values()].map((c) =>
      node(`character:${c.id}`, 'character', c.name, {
        ...(files.has(c.id) ? { path: files.get(c.id)! } : {}),
        badge: c.status,
      }),
    );
    return node('branch:characters', 'branch', 'Characters', { children });
  }
  const files = new Map(input.inputs.locationDocs.map((d) => [d.id, relPath(input.root, d.file)]));
  const children = [...input.model.locations.values()].map((l) =>
    node(`location:${l.id}`, 'location', l.name, {
      ...(files.has(l.id) ? { path: files.get(l.id)! } : {}),
      ...(l.mined ? { badge: 'mined' } : {}),
    }),
  );
  return node('branch:locations', 'branch', 'Locations', { children });
}

/**
 * The wiki tree, from `Bible.files()` — path, title, nothing else. A table of contents is not an
 * excerpt, which is why this may read the bible index at all; see `docs/story-bible.md`.
 */
function wikiBranch(input: DocTreeInput): DocNode {
  const roots: DocNode[] = [];
  const dirs = new Map<string, DocNode>();

  const dirFor = (segments: string[]): DocNode[] => {
    let parent = roots;
    let prefix = '';
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let dir = dirs.get(prefix);
      if (!dir) {
        dir = node(`wikidir:${prefix}`, 'wikidir', segment, {
          path: `${input.wikiDir}/${prefix}`,
          children: [],
        });
        dirs.set(prefix, dir);
        parent.push(dir);
      }
      parent = dir.children!;
    }
    return parent;
  };

  for (const file of input.bible) {
    const segments = file.file.split('/');
    const name = segments.pop()!;
    dirFor(segments).push(
      node(`wiki:${file.file}`, 'wiki', file.title, {
        path: `${input.wikiDir}/${[...segments, name].join('/')}`,
      }),
    );
  }
  return node('branch:wiki', 'branch', 'Wiki', { children: roots });
}

function assetBranch(input: DocTreeInput, cap: number): DocNode {
  const byKind = new Map<AssetKind, Asset[]>();
  for (const asset of input.manifest) {
    const list = byKind.get(asset.kind);
    if (list) list.push(asset);
    else byKind.set(asset.kind, [asset]);
  }
  const groups = [...byKind.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, assets]) =>
      node(`assetkind:${kind}`, 'assetkind', `${ASSET_KIND_LABELS[kind]} (${assets.length})`, {
        badge: isBaseKind(kind) ? 'base' : 'project',
        children: capped(
          `assetkind:${kind}`,
          assets.map((a) =>
            node(`asset:${a.hash}`, 'asset', `${a.hash.slice(0, 8)}.${a.ext}`, {
              ...(a.accepted ? { badge: 'accepted' } : {}),
            }),
          ),
          cap,
        ),
      }),
    );
  return node('branch:assets', 'branch', 'Assets', { children: groups });
}

/**
 * What one entity is attached to. The shot half comes from the same storyboards the story branch
 * walked, which is why the tree and the panel are one call and not two.
 */
function linksFor(
  input: DocTreeInput,
  binding: { characterId: string } | { locationId: string },
  sheet: string | undefined,
): EntityLinks {
  const id = 'characterId' in binding ? binding.characterId : binding.locationId;
  const scenes: string[] = [];
  const shots: { scene: string; shot: string }[] = [];
  for (const scene of input.model.scenes.values()) {
    const inScene =
      'characterId' in binding ? scene.characters.includes(id) : scene.location === id;
    if (inScene) scenes.push(scene.id);
    for (const shot of input.shots.get(scene.id) ?? []) {
      const framed =
        'characterId' in binding
          ? shot.subjects.some((s) => s.characterId === id)
          : scene.location === id;
      if (framed) shots.push({ scene: scene.id, shot: shot.id });
    }
  }
  const assets = input.manifest
    .filter((a) => bindsTo(a, binding))
    .map((a) => ({
      hash: a.hash,
      ext: a.ext,
      kind: a.kind,
      accepted: a.accepted,
      base: isBaseKind(a.kind),
    }));
  // The bible link is the sheet's own path when the sheet lives under wiki/. Which *other* notes
  // mention it is `bible.search` — ranked and budgeted — not a precomputed index.
  const wiki = sheet?.startsWith(`${input.wikiDir}/`) ? sheet : undefined;
  return {
    ...(sheet !== undefined ? { sheet } : {}),
    ...(wiki !== undefined ? { wiki } : {}),
    assets,
    scenes,
    shots,
  };
}

export function buildDocTree(input: DocTreeInput): DocTree {
  const cap = input.cap ?? DEFAULT_CAP;
  const roots = [
    storyBranch(input, cap),
    entityBranch(input, 'character'),
    entityBranch(input, 'location'),
    wikiBranch(input),
    assetBranch(input, cap),
  ];

  const backlinks: Record<string, EntityLinks> = {};
  const characterFiles = new Map(
    input.inputs.characterDocs.map((d) => [d.id, relPath(input.root, d.file)]),
  );
  const locationFiles = new Map(
    input.inputs.locationDocs.map((d) => [d.id, relPath(input.root, d.file)]),
  );
  for (const c of input.model.characters.values()) {
    backlinks[`character:${c.id}`] = linksFor(
      input,
      { characterId: c.id },
      characterFiles.get(c.id),
    );
  }
  for (const l of input.model.locations.values()) {
    backlinks[`location:${l.id}`] = linksFor(input, { locationId: l.id }, locationFiles.get(l.id));
  }
  return { roots, backlinks };
}

/**
 * The full file tree, from a flat list of workspace-relative paths. Separate from the document
 * tree on purpose: it answers "what is on disk", shares nothing with it but the node type, and is
 * walked only when the sidebar asks for that mode.
 */
export function fileTree(paths: readonly string[], cap: number = DEFAULT_CAP): DocNode[] {
  const roots: DocNode[] = [];
  const dirs = new Map<string, DocNode>();

  for (const path of [...paths].sort()) {
    const segments = path.split('/');
    const name = segments.pop()!;
    let parent = roots;
    let prefix = '';
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let dir = dirs.get(prefix);
      if (!dir) {
        dir = node(`dir:${prefix}`, 'dir', segment, { path: prefix, children: [] });
        dirs.set(prefix, dir);
        parent.push(dir);
      }
      parent = dir.children!;
    }
    parent.push(node(`file:${path}`, 'file', name, { path }));
  }

  // Directories before files at every level, which is what a file tree looks like; the paths
  // themselves arrive sorted, so within each group insertion order is already alphabetical.
  const trim = (nodes: DocNode[], id: string): DocNode[] => {
    for (const child of nodes) {
      if (child.children) child.children = trim(child.children, child.id);
    }
    const dirs = nodes.filter((n) => n.kind === 'dir');
    return capped(id, [...dirs, ...nodes.filter((n) => n.kind !== 'dir')], cap);
  };
  return trim(roots, 'root');
}

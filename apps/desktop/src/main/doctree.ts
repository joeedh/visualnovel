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
import { assetApproved, type SlotGraph } from '@vn/artgen';
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
  /**
   * Display names by asset hash, from `labelAssets`. Passed in rather than derived here because
   * a model-sheet's angle lives in the task graph, which this projection does not read; an asset
   * missing from the map falls back to `hash8.ext`.
   */
  assetLabels?: ReadonlyMap<string, string>;
  /**
   * Every picture the project implies, from `buildSlotGraph`. **Optional**: without it the tree is
   * exactly what it was, and the Unapproved root is simply absent rather than empty — a caller that
   * has not built the graph must not be made to claim nothing is waiting.
   */
  slots?: SlotGraph;
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
  concept: 'Concepts',
  reference: 'References',
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

/** What to call one asset: its display name when the caller supplied one, else `hash8.ext`. */
function assetLabelOf(input: DocTreeInput, asset: Asset): string {
  return input.assetLabels?.get(asset.hash) ?? `${asset.hash.slice(0, 8)}.${asset.ext}`;
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
          // No `path`: an asset is addressed by hash, and a path here would send a click down the
          // document-opening route, which reads a file as text.
          assets.map((a) =>
            node(`asset:${a.hash}`, 'asset', assetLabelOf(input, a), {
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
 * Everything still standing between this project and a finished set of pictures, in two groups the
 * slot graph makes disjoint by construction.
 *
 * A second index into nodes that already exist rather than a new kind of thing: an *Awaiting
 * approval* row reuses the `asset:<hash>` id the Assets branch uses, so selection, routing and the
 * right-click menu all work here with no renderer change. Only *Not yet rendered* is new, because
 * a slot with nothing in it is the one row in the tree that has no bytes behind it.
 *
 * Both groups walk `SlotGraph.order` — upstream before downstream — so the top of each list is what
 * can be worked on now, which is the same order approval has to happen in.
 */
function unapprovedBranch(input: DocTreeInput, cap: number): DocNode | undefined {
  const slots = input.slots;
  if (!slots) return undefined;

  const byHash = new Map(input.manifest.map((a) => [a.hash, a]));
  const waiting: DocNode[] = [];
  const unrendered: DocNode[] = [];
  const seen = new Set<string>();

  for (const key of slots.order) {
    const slot = slots.nodes.get(key);
    if (!slot) continue;
    // Zero candidates, deliberately — not `hash === undefined`. `pick` declines whenever the answer
    // is not certain, so a slot holding three drafts resolves to nothing and would read as
    // unrendered; those three drafts are what the other group is listing.
    if (slot.candidates.length === 0) {
      unrendered.push(
        node(`slot:${key}`, 'slot', slot.label, {
          ...(slot.status ? { badge: slot.status } : {}),
          note:
            slot.blocked ??
            'Nothing has been drawn for this slot yet — run the pipeline to make it.',
        }),
      );
      continue;
    }
    for (const hash of slot.candidates) {
      const asset = byHash.get(hash);
      // One row per picture: a sheet bound to two outfits is still one thing to approve.
      if (!asset || seen.has(hash) || assetApproved(asset, input.model)) continue;
      seen.add(hash);
      waiting.push(
        node(`asset:${hash}`, 'asset', assetLabelOf(input, asset), {
          badge: slot.binding.kind,
          note: `Waiting on approval for ${slot.label}.`,
        }),
      );
    }
  }

  if (waiting.length === 0 && unrendered.length === 0) return undefined;
  const group = (id: string, label: string, children: DocNode[]): DocNode[] =>
    children.length === 0
      ? []
      : [
          node(id, 'branch', `${label} (${children.length})`, {
            children: capped(id, children, cap),
          }),
        ];
  return node('branch:unapproved', 'branch', 'Unapproved assets', {
    children: [
      ...group('unapproved:waiting', 'Awaiting approval', waiting),
      ...group('unapproved:unrendered', 'Not yet rendered', unrendered),
    ],
  });
}

/** What a backlink entry is *about*. One of the three things a document in this project can be. */
type Subject = { characterId: string } | { locationId: string } | { sceneId: string };

/** Whether a scene names this subject at all — its cast, its setting, or its own id. */
function inScene(
  scene: { id: string; characters: string[]; location?: string },
  s: Subject,
): boolean {
  if ('characterId' in s) return scene.characters.includes(s.characterId);
  if ('locationId' in s) return scene.location === s.locationId;
  return scene.id === s.sceneId;
}

/**
 * What one subject is attached to. The shot half comes from the same storyboards the story branch
 * walked, which is why the tree and the panel are one call and not two.
 */
function linksFor(input: DocTreeInput, binding: Subject, sheet: string | undefined): EntityLinks {
  const scenes: string[] = [];
  const shots: { scene: string; shot: string }[] = [];
  for (const scene of input.model.scenes.values()) {
    const named = inScene(scene, binding);
    if (named) scenes.push(scene.id);
    for (const shot of input.shots.get(scene.id) ?? []) {
      // A character is framed shot by shot; a location or a scene is framed by the whole scene
      // being the one it names, so every shot in it counts.
      const framed =
        'characterId' in binding
          ? shot.subjects.some((s) => s.characterId === binding.characterId)
          : named;
      if (framed) shots.push({ scene: scene.id, shot: shot.id });
    }
  }
  const assets = input.manifest
    .filter((a) => bindsTo(a, binding))
    .map((a) => {
      // Only a scene asks which shot: for a character the same frame can satisfy several, and the
      // strip that groups by shot is the scene's.
      const shotId =
        'sceneId' in binding
          ? a.satisfies.find((b) => b.sceneId === binding.sceneId)?.shotId
          : undefined;
      return {
        hash: a.hash,
        ext: a.ext,
        kind: a.kind,
        label: assetLabelOf(input, a),
        accepted: a.accepted,
        base: isBaseKind(a.kind),
        ...(shotId !== undefined ? { shotId } : {}),
      };
    });
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
  // Immediately before Assets: it is a lens on the same nodes, so it sits next to them, and the
  // four roots that were here keep the order the sidebar has always drawn them in.
  const unapproved = unapprovedBranch(input, cap);
  const roots = [
    storyBranch(input, cap),
    entityBranch(input, 'character'),
    entityBranch(input, 'location'),
    wikiBranch(input),
    ...(unapproved ? [unapproved] : []),
    assetBranch(input, cap),
  ];

  const backlinks: Record<string, EntityLinks> = {};
  const pathIndex: Record<string, string> = {};
  // A path is claimed by the first subject discovered in it. Two `type:` tags in one file is a
  // conflict the model already reports as a diagnostic; the index must not silently pick a winner.
  const claim = (path: string | undefined, key: string): void => {
    if (path !== undefined && pathIndex[path] === undefined) pathIndex[path] = key;
  };

  const characterFiles = new Map(
    input.inputs.characterDocs.map((d) => [d.id, relPath(input.root, d.file)]),
  );
  const locationFiles = new Map(
    input.inputs.locationDocs.map((d) => [d.id, relPath(input.root, d.file)]),
  );
  const sceneFiles = new Map(
    input.inputs.sceneDocs.map((d) => [d.id, relPath(input.root, d.file)]),
  );

  for (const c of input.model.characters.values()) {
    const sheet = characterFiles.get(c.id);
    backlinks[`character:${c.id}`] = linksFor(input, { characterId: c.id }, sheet);
    claim(sheet, `character:${c.id}`);
  }
  for (const l of input.model.locations.values()) {
    const sheet = locationFiles.get(l.id);
    backlinks[`location:${l.id}`] = linksFor(input, { locationId: l.id }, sheet);
    claim(sheet, `location:${l.id}`);
  }
  // A scene is a subject too: what illustrates it is the same question asked of a different key,
  // and it is the one that lets a pane showing prose show the frames drawn from it.
  for (const s of input.model.scenes.values()) {
    const sheet = sceneFiles.get(s.id);
    backlinks[`scene:${s.id}`] = linksFor(input, { sceneId: s.id }, sheet);
    claim(sheet, `scene:${s.id}`);
  }
  return { roots, backlinks, pathIndex };
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

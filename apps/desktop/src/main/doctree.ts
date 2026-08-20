/**
 * The sidebar's two shapes, as pure projections: a logical document tree and per-entity
 * backlinks. Every edge here already exists somewhere — the model's cast lists, `ShotSubject`,
 * `Asset.satisfies`, the tag index — so this module reads no file and writes none. Plan:
 * `docs/plans/archive/document-tree-and-backlinks.md`.
 */
import { relative } from 'node:path';
import type { LoadedInputs } from '@vn/parse';
import { bindsTo, type Asset, type AssetKind, type ProjectModel, type Shot } from '@vn/types';
import { isBaseKind } from '@vn/store';
import { assetApproved, type SlotGraph } from '@vn/artgen';
import { driftOf } from '@vn/pipeline';
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
  /**
   * The project's skills, if the caller looked for them. **Optional, and `[]` is not the same as
   * absent**: undefined leaves the branch out entirely (which is what every caller that knows
   * nothing about skills wants), while an empty array draws an empty heading on purpose — see
   * {@link skillsBranch}.
   */
  skills?: readonly SkillEntry[];
  cap?: number;
}

/**
 * One skill, as the tree needs it. Deliberately **not** `@vn/authoring`'s `Skill`, which carries
 * the whole instruction body and absolute paths on disk — neither belongs on the wire, and a tree
 * that shipped the body would put every playbook in the renderer on every read.
 */
export interface SkillEntry {
  /** The skill directory's name, which is its id everywhere else. */
  id: string;
  name: string;
  description: string;
  /** Its `SKILL.md`, workspace-relative with `/` separators. */
  file: string;
  /** Whether a person has given it a script to run. */
  script: boolean;
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
 *
 * The remainder rides *under* that node rather than being dropped: the cap is about what a tree
 * draws at rest, not about what it is allowed to know, and an author who wants the other three
 * hundred scenes has nowhere else to ask. The renderer expands it in place — a `more` node is a
 * continuation of the list it ends, not a container — so paying for it is one click, and the
 * shape stays a shape a caller that never expands anything can ignore.
 */
function capped(id: string, children: DocNode[], cap: number): DocNode[] {
  if (children.length <= cap) return children;
  const rest = children.slice(cap);
  return [
    ...children.slice(0, cap),
    node(`more:${id}`, 'more', `… and ${rest.length} more`, { children: rest }),
  ];
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

/**
 * The skills, as leaves. **No file children**: the doc tree is identity, not content
 * (`docs/document-tree.md`), and a skill is one thing with an id, a name and a description — the
 * same granularity as a character. What is *inside* the directory is the Skills pane's own tree.
 *
 * **Drawn even when empty**, which no other branch is. A skill has to be findable before one
 * exists, and the heading's own right-click menu is the only always-reachable way to make the
 * first: `skeleton()` writes no `.aiagent/` at all, so every project created in the app starts
 * here, and an absent branch would hide the feature from exactly the authors who have not read
 * `docs/`. The caller still decides — `input.skills` undefined means it did not look.
 */
function skillsBranch(input: DocTreeInput, cap: number): DocNode | undefined {
  const skills = input.skills;
  if (!skills) return undefined;
  const children = skills.map((skill) =>
    node(`skill:${skill.id}`, 'skill', skill.name, {
      path: skill.file,
      ...(skill.script ? { badge: 'script' } : {}),
      // A skill with no description still hovers: the sentence says what the row *is*, which is
      // the one thing an author looking at an unfamiliar playbook needs before opening it.
      note: skill.description || 'A playbook the agent can follow. Open it in the Skills pane.',
    }),
  );
  return node('branch:skills', 'branch', 'Skills', {
    children: capped('branch:skills', children, cap),
  });
}

/** What to call one asset: its display name when the caller supplied one, else `hash8.ext`. */
function assetLabelOf(input: DocTreeInput, asset: Asset): string {
  return input.assetLabels?.get(asset.hash) ?? `${asset.hash.slice(0, 8)}.${asset.ext}`;
}

/**
 * The frames whose scene has moved on since they were drawn. Accepting a frame says "this is the
 * picture I want"; drift says the words it illustrates have changed underneath it — so a drifted
 * frame is still the accepted one and is no longer a true `accepted` badge. Re-derived here on
 * every read, like everywhere else drift is asked about; never a stored flag.
 */
function driftedImages(input: DocTreeInput): Set<string> {
  const stale = new Set<string>();
  for (const scene of input.model.scenes.values()) {
    for (const shot of input.shots.get(scene.id) ?? []) {
      if (shot.image !== undefined && driftOf(scene, shot) === 'drifted') stale.add(shot.image);
    }
  }
  return stale;
}

/**
 * The manifest, filed the way it was *made*: one row per **slot** — the address a picture has,
 * `aiko portrait`, `cafe — night plate` — showing what fills that slot now, with every earlier take
 * of the same slot folded underneath it. A slot rendered eight times is one row and not eight,
 * which is the difference between a list an author reads and a wall of near-identical thumbnails
 * told apart only by a hash.
 *
 * A picture no slot claims is listed on its own beneath the slots of its kind. The graph enumerates
 * slots, so its silence about a concept, an upload, a reference or a base-root asset is not a
 * verdict — pruning on silence would bury every sketch in the project. With no graph passed at all
 * this is exactly the flat list it always was.
 */
function assetBranch(input: DocTreeInput, cap: number): DocNode {
  const stale = driftedImages(input);
  const byHash = new Map(input.manifest.map((a) => [a.hash, a]));
  // Manifest order is the order the pictures were made in, so later means newer. Nothing else in
  // the shape knows when a render happened, and a slot's candidate list is a set, not a history.
  const madeAt = new Map(input.manifest.map((a, i) => [a.hash, i]));

  // No `path` on an asset row: it is addressed by hash, and a path here would send a click down the
  // document-opening route, which reads a file as text.
  const row = (a: Asset, over: Partial<DocNode> = {}): DocNode =>
    node(`asset:${a.hash}`, 'asset', assetLabelOf(input, a), {
      ...(stale.has(a.hash) ? { badge: 'stale' } : a.accepted ? { badge: 'accepted' } : {}),
      ...over,
    });

  const byKind = new Map<AssetKind, DocNode[]>();
  const add = (kind: AssetKind, n: DocNode): void => {
    const list = byKind.get(kind);
    if (list) list.push(n);
    else byKind.set(kind, [n]);
  };

  // Slots first, in `SlotGraph.order` — upstream before downstream, the same order the Unapproved
  // branch lists in and the order the work itself has to happen in.
  const claimed = new Set<string>();
  for (const key of input.slots?.order ?? []) {
    const slot = input.slots?.nodes.get(key);
    if (!slot) continue;
    // Only takes no earlier slot spoke for: one picture can satisfy two slots, and filing it twice
    // would make one render read as two.
    const takes = slot.candidates
      .filter((hash) => byHash.has(hash) && !claimed.has(hash))
      .sort((a, b) => madeAt.get(a)! - madeAt.get(b)!);
    if (takes.length === 0) continue;
    for (const hash of takes) claimed.add(hash);

    // What fills the slot: what it resolved to, else the newest take. `pick` declines whenever the
    // answer is not certain, and a row still has to open on something — which is not a verdict on
    // the drafts, because choosing between them happens in the Unapproved branch, where all of
    // them are still listed one per row.
    const current =
      slot.hash !== undefined && takes.includes(slot.hash) ? slot.hash : takes.at(-1)!;
    const past = takes.filter((hash) => hash !== current).reverse();
    add(
      byHash.get(current)!.kind,
      row(byHash.get(current)!, {
        note:
          past.length === 0
            ? `${slot.label}. Show the asset in the asset editor.`
            : `${slot.label}, and ${past.length} earlier take${past.length === 1 ? '' : 's'}. ` +
              'Show the asset in the asset editor; click again to see history.',
        ...(past.length === 0
          ? {}
          : {
              children: capped(
                `takes:${key}`,
                past.map((hash) =>
                  row(byHash.get(hash)!, {
                    note: `An earlier take of ${slot.label}. Show it in the asset editor.`,
                  }),
                ),
                cap,
              ),
            }),
      }),
    );
  }

  for (const asset of input.manifest) if (!claimed.has(asset.hash)) add(asset.kind, row(asset));

  const groups = [...byKind.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    // The heading counts rows rather than pictures, because rows are what it heads: a kind with
    // one slot rendered nine times is one thing to look at, and saying nine would be a count of
    // something the branch does not draw.
    .map(([kind, rows]) =>
      node(`assetkind:${kind}`, 'assetkind', `${ASSET_KIND_LABELS[kind]} (${rows.length})`, {
        badge: isBaseKind(kind) ? 'base' : 'project',
        children: capped(`assetkind:${kind}`, rows, cap),
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
  // Skills sit with the other authored input, after Wiki — and before Unapproved, because nothing
  // may come between the two lenses on the manifest.
  const skills = skillsBranch(input, cap);
  const roots = [
    storyBranch(input, cap),
    entityBranch(input, 'character'),
    entityBranch(input, 'location'),
    wikiBranch(input),
    ...(skills ? [skills] : []),
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
 *
 * `base` is prepended to every id and path while the **structure** still comes from the paths as
 * given. That is what lets a caller walk one subdirectory and still hand back rows a click can act
 * on: the ids come out `file:.aiagent/skills/<id>/SKILL.md`, which is the workspace-relative path
 * `doc.read` takes, so `selectionForNode` and `nodeIsSelected` work on them with no new rule.
 */
export function fileTree(
  paths: readonly string[],
  cap: number = DEFAULT_CAP,
  base = '',
): DocNode[] {
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
        dir = node(`dir:${base}${prefix}`, 'dir', segment, {
          path: `${base}${prefix}`,
          children: [],
        });
        dirs.set(prefix, dir);
        parent.push(dir);
      }
      parent = dir.children!;
    }
    parent.push(node(`file:${base}${path}`, 'file', name, { path: `${base}${path}` }));
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

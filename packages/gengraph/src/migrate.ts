/**
 * Rewrites the keys in a graph file whose node types have since renamed a socket or a property,
 * before the file is deserialized. A rename is declared beside the type it belongs to, as a
 * `NodeMigration` on its `GenNodeSpec`.
 */
import { contract } from '@vn/contracts';
import { Graph, GroupDef } from 'pathux-graph';
import { genNodeSpecs, type NodeMigration } from './registry.js';
import { migrateJSON } from 'nstructjs';

/**
 * Node types that no longer exist, each mapped to the built-in type it is loaded as. A retired
 * type's sockets and props carry the same names as its replacement at its replacement's current
 * `typeVersion`, which is what lets the file's own values and links stand as they are.
 * `OpenRouterImage` was the OpenRouter plugin's node; the built-in `GenImage` now draws with
 * any `<vendor>/<model>` id through the same endpoint.
 */
export const RETIRED_TYPES: Readonly<Record<string, string>> = { OpenRouterImage: 'GenImage' };

/**
 * A file rewritten on the way in, and what changed. `json` is a copy whenever the argument was
 * a record, because path.ux's own pass rewrites in place and the argument is left as it was.
 */
export interface GraphMigration {
  json: unknown;
  /** One sentence per node type rewritten, for a host that wants to say the file has moved on. */
  notes: string[];
}

export const graphsSocketRenameMigrates = contract({
  id      : 'graphs.socketRenameMigrates',
  rule: "Renaming a node type's socket or prop needs a migration in the same commit: bump the type's `typeVersion` and add a `NodeMigration` step that lands on it. `migrateGraphJSON` replays the renames over a file's JSON before `readGraphFile` deserializes it.",
  prevents:
    'A file written before the rename loading with the old key as an orphaned socket, its link reaching nothing visible and the renamed key at its default, so the wiring is lost silently and the changed hash redraws the slot.',
  subjects: [
    'module:packages/gengraph/src/migrate.ts',
    'function:packages/gengraph/src/migrate.ts#migrateGraphJSON',
    'function:packages/gengraph/src/migrate.ts#migrateGroupJSON',
    'function:packages/gengraph/src/registry.ts#registerGenNode',
  ],
  see     : ['docs/reference/gen-graphs.md#node-types'],
  detail:
    'path.ux reconciles a loaded node against its definition by key. The replay moves sockets, ' +
    "props, links, a group's forwarded rows, and the `{name}` tokens a template embeds, which puts " +
    'the node back on the hash a freshly created one would have. `registerGenNode` refuses a ' +
    'migration whose targets name nothing on the class or whose last step stops short of the ' +
    'declared `typeVersion`. A file keeps its old keys until something writes it back, so a ' +
    'migration stays in place rather than being deleted a release later.',
});

/** Migrates a graph file's JSON values. A file that is not a record is passed through. */
export function migrateGraphJSON(json: unknown): GraphMigration {
  const graph = rec(json);
  if (graph === undefined) return { json, notes: [] };

  const copy = structuredClone(graph);
  // TODO: move the rename replay below to this new system too; for now this handles path.ux's own
  migrateJSON(copy, Graph, { version: (copy.VERSION as number) ?? 0 });

  const rewrite = newRewrite();
  migrateGraph(copy, rewrite);
  return finish(copy, rewrite);
}

/**
 * Migrates a group definition's JSON values. The definition's own boundary sockets belong to the
 * group rather than to any node type and are left alone; its forwarded rows are not, because each
 * one names a prop on a node inside the subgraph.
 */
export function migrateGroupJSON(json: unknown): GraphMigration {
  const def = rec(json);
  if (def === undefined) return { json, notes: [] };

  const copy = structuredClone(def);
  // GroupDef's own STRUCT declares the subgraph, so the walk reaches its nodes from here
  migrateJSON(copy, GroupDef, { version: (copy.VERSION as number) ?? 0 });

  const rewrite = newRewrite();
  const subgraph = rec(copy.subgraph);
  if (subgraph !== undefined) migrateGraph(subgraph, rewrite);

  for (const entry of arr(copy.exposed)) {
    const row = rec(entry);
    if (row === undefined || row.kind !== 'prop') continue;
    const renamed = rewrite.props.get(String(row.nodeId))?.[String(row.propKey)];
    if (renamed !== undefined) row.propKey = renamed;
  }

  return finish(copy, rewrite);
}

/** What one walk collected, so the notes read per type and a group can follow its own rows. */
interface Rewrite {
  /** Nodes migrated, counted by type name. */
  tally: Map<string, { to: number; count: number }>;
  /** Nodes of a retired type, counted by the retired name. */
  retired: Map<string, number>;
  /** The prop renames applied to each node, by the id the file gives it. */
  props: Map<string, Record<string, string>>;
}

function newRewrite(): Rewrite {
  return { tally: new Map(), retired: new Map(), props: new Map() };
}

function finish(copy: unknown, rewrite: Rewrite): GraphMigration {
  const plural = (count: number): string => (count === 1 ? '' : 's');
  const notes = [
    ...[...rewrite.retired].map(
      ([type, count]) =>
        `${count} ${type} node${plural(count)} now load${count === 1 ? 's' : ''} as ${RETIRED_TYPES[type]}`,
    ),
    ...[...rewrite.tally].map(
      ([type, { to, count }]) => `${count} ${type} node${plural(count)} updated to v${to}`,
    ),
  ];
  return { json: copy, notes };
}

function migrateGraph(graph: Record<string, unknown>, rewrite: Rewrite): void {
  const links = arr(graph.links);
  for (const entry of arr(graph.nodes)) {
    const node = rec(entry);
    if (node !== undefined) migrateNode(node, links, rewrite);
  }
}

function migrateNode(node: Record<string, unknown>, links: unknown[], rewrite: Rewrite): void {
  // A group instance carries the copy of its definition it last synced to, whose nodes are
  // reconciled by key the same way and are stamped with type versions of their own.
  const nested = rec(node.subgraph);
  if (nested !== undefined) migrateGraph(nested, rewrite);

  // A retired type is renamed first, so its replacement's own renames then apply to it
  const type = retire(node, rewrite);
  const was = typeof node.typeVersion === 'number' ? node.typeVersion : 0;
  const due = (genNodeSpecs().get(type ?? '')?.migrations ?? [])
    .filter((step) => step.to > was)
    .sort((a, b) => a.to - b.to);
  if (type === undefined || due.length === 0) return;

  const props = arr(node.props);
  const applied: Record<string, string> = {};
  for (const step of due) {
    renameSockets(arr(node.inputs), step.inputs);
    renameSockets(arr(node.outputs), step.outputs);
    relink(links, node.id, 'dstNode', 'dstKey', step.inputs);
    relink(links, node.id, 'srcNode', 'srcKey', step.outputs);
    // Placeholders name inputs but are found by the prop's own key, so they are refilled while
    // that key is still the one the file holds.
    refillPlaceholders(props, step);
    renameProps(props, step.props);
    Object.assign(applied, step.props ?? {});
  }

  const to = (due[due.length - 1] as NodeMigration).to;
  node.typeVersion = to;
  rewrite.tally.set(type, { to, count: (rewrite.tally.get(type)?.count ?? 0) + 1 });
  if (Object.keys(applied).length > 0) rewrite.props.set(String(node.id), applied);
}

type Renames = Readonly<Record<string, string>>;

function renameSockets(sockets: unknown[], renames: Renames | undefined): void {
  if (renames === undefined) return;

  for (const entry of sockets) {
    const socket = rec(entry);
    const to = socket === undefined ? undefined : renames[String(socket.name)];
    if (socket !== undefined && to !== undefined) socket.name = to;
  }
}

function renameProps(props: unknown[], renames: Renames | undefined): void {
  if (renames === undefined) return;

  for (const entry of props) {
    const prop = rec(entry);
    const to = prop === undefined ? undefined : renames[String(prop.apiname)];
    if (prop !== undefined && to !== undefined) prop.apiname = to;
  }
}

/** Moves the links touching one node's renamed sockets, which the file keys by name. */
function relink(
  links: unknown[],
  id: unknown,
  end: 'srcNode' | 'dstNode',
  key: 'srcKey' | 'dstKey',
  renames: Renames | undefined,
): void {
  if (renames === undefined || typeof id !== 'string') return;

  for (const entry of links) {
    const link = rec(entry);
    if (link === undefined || link[end] !== id) continue;

    const to = renames[String(link[key])];
    if (to !== undefined) link[key] = to;
  }
}

/** Rewrites the `{name}` tokens a text prop embeds, following the same renames its inputs took. */
function refillPlaceholders(props: unknown[], step: NodeMigration): void {
  const renames = step.inputs;
  if (step.placeholders === undefined || renames === undefined) return;

  for (const entry of props) {
    const prop = rec(entry);
    if (prop === undefined || typeof prop.data !== 'string') continue;
    if (!step.placeholders.includes(String(prop.apiname))) continue;

    prop.data = prop.data.replace(/\{([^{}]*)\}/g, (token, name: string) =>
      renames[name] === undefined ? token : `{${renames[name]}}`,
    );
  }
}

/**
 * Rewrites a retired type's struct name to its replacement's and answers the type name the
 * node now declares. The file's `typeVersion` is kept, because a retired type is aliased only
 * at the version whose keys it shares.
 */
function retire(node: Record<string, unknown>, rewrite: Rewrite): string | undefined {
  const type = typeNameOf(node);
  const to = type === undefined ? undefined : RETIRED_TYPES[type];
  if (type === undefined || to === undefined) return type;

  node._structName = `graph.${to}`;
  rewrite.retired.set(type, (rewrite.retired.get(type) ?? 0) + 1);
  return to;
}

/** The type name a node entry declares, which nstructjs writes under the `graph.` namespace. */
function typeNameOf(node: Record<string, unknown>): string | undefined {
  const name = node._structName;
  if (typeof name !== 'string') return undefined;
  return name.startsWith('graph.') ? name.slice('graph.'.length) : name;
}

function rec(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

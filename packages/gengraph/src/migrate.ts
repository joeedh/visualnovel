/**
 * Rewrites the keys in a graph file whose node types have since renamed a socket or a property.
 * path.ux reconciles a loaded node against its definition by key, so a file written before a
 * rename loads with the old key kept as an orphaned socket, the link into it pointing at nothing
 * an author can see, and the renamed key sitting at its default. Rewriting the keys before the
 * file is deserialized is what keeps the wiring and the values that were authored against the
 * old names, and it puts the node back on the hash a freshly created one would have.
 *
 * A rename is declared beside the type it belongs to, as a `NodeMigration` on its `GenNodeSpec`,
 * and `registerGenNode` checks the declaration against the class. Renaming a socket or a prop is
 * therefore two edits: bump the type's `typeVersion`, and add the step that lands on it.
 */
import { genNodeSpecs, type NodeMigration } from './registry.js';

/** A file rewritten on the way in, and what changed. `json` is the argument where nothing did. */
export interface GraphMigration {
  json: unknown;
  /** One sentence per node type rewritten, for a host that wants to say the file has moved on. */
  notes: string[];
}

/** Migrates a graph file's JSON values. */
export function migrateGraphJSON(json: unknown): GraphMigration {
  const graph = rec(json);
  if (graph === undefined) return { json, notes: [] };

  const copy = structuredClone(graph);
  const rewrite = newRewrite();
  migrateGraph(copy, rewrite);
  return finish(json, copy, rewrite);
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
  const rewrite = newRewrite();
  const subgraph = rec(copy.subgraph);
  if (subgraph !== undefined) migrateGraph(subgraph, rewrite);

  for (const entry of arr(copy.exposed)) {
    const row = rec(entry);
    if (row === undefined || row.kind !== 'prop') continue;
    const renamed = rewrite.props.get(String(row.nodeId))?.[String(row.propKey)];
    if (renamed !== undefined) row.propKey = renamed;
  }

  return finish(json, copy, rewrite);
}

/** What one walk collected, so the notes read per type and a group can follow its own rows. */
interface Rewrite {
  /** Nodes migrated, counted by type name. */
  tally: Map<string, { to: number; count: number }>;
  /** The prop renames applied to each node, by the id the file gives it. */
  props: Map<string, Record<string, string>>;
}

function newRewrite(): Rewrite {
  return { tally: new Map(), props: new Map() };
}

function finish(original: unknown, copy: unknown, rewrite: Rewrite): GraphMigration {
  const notes = [...rewrite.tally].map(
    ([type, { to, count }]) => `${count} ${type} node${count === 1 ? '' : 's'} updated to v${to}`,
  );
  return notes.length === 0 ? { json: original, notes } : { json: copy, notes };
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

  const type = typeNameOf(node);
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

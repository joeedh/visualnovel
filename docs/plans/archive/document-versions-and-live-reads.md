# Document versions, and reads served from main

## Context

Move a Gen Graph node twice in quick succession and it snaps back to where the first drag left
it, then jumps forward again. The same shape of bug is latent in every pane that reloads on a
write.

The mechanism, end to end:

1. `NodeGraphView._commitMove` (`vendor/path.ux/scripts/editors/nodeeditor/nodegraphview.ts:483`)
   dispatches **one** `moveNodes` edit per finished drag. Per-pointer-move work is `_previewMove`
   (:474), which only calls `delegate.check` and never dispatches. So this is not a per-frame
   write problem.
2. `GenGraphEditor.dispatch` (`apps/desktop/renderer/pathux/editors/nodes.ts:375-382`) applies the
   move to the live in-renderer `Graph` immediately and then sends `gengraph.moveNodes`
   fire-and-forget. The local apply is deliberate: the view resyncs frames from `node.pos` the
   moment `dispatch` returns.
3. The command's echo reaches `onWrote` (`nodes.ts:201`). `moveNodes` is not covered by the
   `skipReload` guard, which tests `id !== 'gengraph.setProp'` (:188), so the echo falls through
   to `void this.load(this.slug)`.
4. `load()` (:242) re-reads the file and **replaces `this.graph` with a fresh parse**, and every
   frame re-reads its position from that parse.

With two drags outstanding, drag #1's echo can be answered by a read issued before drag #2's write
landed. That read returns position 1, which is what disk genuinely held at that moment, and the
pane adopts it over the position it already has on screen. The node snaps back until drag #2's own
echo arrives and reloads again.

`load()`'s `token` guard does not help. It drops superseded *reads* and keeps the newest one, but
the newest read is not the newest state: it was issued before the later write landed.

### The scoped path never matched, so every reload came from the coarse signal

Found while implementing, and it is why the symptom is as loud as it is. `touchesGraph` matched
`work/graphs/<slug>.json`, but `ProjectPaths.work` is already under `vngen/`
(`packages/store/src/paths.ts:78-80`), so `writeGraphDoc` reports `vngen/work/graphs/<slug>.json`
and `touchesGraph` matched nothing the app had ever written. Its own test used the same wrong
prefix, so it passed while the shipping path failed. Every other reference in the repo has it
right — `graphs.test.ts:58`, `doctree.test.ts:403`, and the guarded directory map at
`packages/store/src/docfile.ts:47`.

The consequence is that step 3 above never reached the scoped branch at all. `skipReload` was set
by the `onExec` watcher and then never read, and every reload of the pane came from the coarse
`onInvalidate`, which fires on **every** mutating command anywhere in the app. The prefix is
fixed here, and the constant it is built from is now shared with the main-side cache so the two
cannot drift apart again.

The writes themselves are not racing. `CommandStack.exec` serializes mutating commands
(`packages/commands/src/stack.ts:158`) and reaches `serialize()` with no `await` ahead of it, so
the chain order is the IPC delivery order. This is a read-your-own-writes ordering failure on the
echo path, and nothing on the write side needs a lock.

Two independent changes, in this order:

1. **Document versions** — main stamps a monotonic version on every document it writes, the
   version travels on both the command outcome and a broadcast, and a pane reloads only when the
   version it is told about is newer than anything it produced and it has no writes outstanding.
   This is what fixes the snap-back.
2. **Reads served from main** — `gengraph:doc` answers from a held parse rather than re-reading
   and re-deserializing the file, validated by a stat so an outside writer is still noticed. This
   is a latency change, not a correctness one, and it is what makes the reloads that do still
   happen cheap.

### Why the version alone is not enough

The obvious rule — reload when the incoming version is newer than the newest version my own writes
produced — fails on exactly the case that produces the bug. At the moment drag #1's echo arrives,
the pane has sent drag #2 but has not been told what version it produced, so its idea of "mine" is
still 1 and it reloads.

The rule therefore needs the count of writes the pane has sent and not yet had answered. While
that count is above zero the pane's own state is ahead of anything main can report, so every echo
is ignored; when it falls to zero the pane compares versions once and reloads only if somebody
else moved the document meanwhile. That covers overlapping local writes, a foreign write arriving
during local writes, the agent, and a second window, under one rule.

## Fix 1 — document versions

### `apps/desktop/src/main/livedocs.ts` (new)

```ts
/** Version numbers by workspace-relative document path, and what they were last stamped for. */
export type DocVersions = Record<string, number>;

export class LiveDocs {
  private readonly versions = new Map<string, number>();

  /** The version `path` carries now. Zero for a document nothing has written this session. */
  version(path: string): number {
    return this.versions.get(path) ?? 0;
  }

  /** Stamp each path as freshly written, and answer the versions they now carry. */
  wrote(paths: readonly string[]): DocVersions {
    const stamped: DocVersions = {};
    for (const path of paths) {
      const next = this.version(path) + 1;
      this.versions.set(path, next);
      stamped[path] = next;
    }
    return stamped;
  }

  /** Forget every version, which is what opening a different project asks for. */
  clear(): void {
    this.versions.clear();
  }
}
```

Per-path counters rather than one shared clock, because the comparison a pane makes is per
document and "version 3 of this file" is the reading that needs no explanation. Zero for an
unwritten document is what lets a pane start at zero and reload nothing until a write happens.

### `apps/desktop/src/main/index.ts`

Hold one `LiveDocs` beside the file cache, and clear it where `forgetFiles()` is called on a
workspace switch — the versions are keyed by workspace-relative path, so they mean something
different under a different root.

Add the one function that stamps and tells the windows:

```ts
/**
 * Stamp what a write touched and broadcast the new versions. Every write path in the app funnels
 * through here, so a pane's version arithmetic sees agent writes and other windows' writes on the
 * same terms as its own.
 */
function noteWrites(paths: readonly string[]): DocVersions {
  if (paths.length === 0) return {};
  const versions = liveDocs.wrote(paths);
  broadcast('documents:wrote', { paths: [...paths], versions });
  return versions;
}
```

Two callers:

- `onRecord` in `getStack()`, for `record.written`. This runs inside `stack.record()` and is
  awaited before `exec` returns, so the stamp is in place by the time the `command:exec` handler
  has its outcome. It covers every command source at once — `ui`, `cdp`, `agent`, and main.
- The `agent:event` path in `deps.emitEvent`, for a `tool` event whose `result.written` is
  non-empty. An agent tool call is not a command and never reaches the stack.

`command:exec` then reads the versions back off the record and returns them beside the outcome:

```ts
handle('command:exec', async (origin, request) => {
  const outcome = await /* unchanged dispatch */;
  return withVersions(outcome);
});
```

where `withVersions` maps each path in `outcome.record?.written` to `liveDocs.version(path)`. It
reads rather than stamps, because `onRecord` has already stamped and stamping twice would tell
the sender a version nobody was broadcast.

**Undo and redo are deliberately left out.** A restore writes files no command declared, so
`record.written` is empty for `stack.undo`/`stack.redo` and there is nothing to stamp. Those keep
reaching panes through the existing coarse `onInvalidate` signal, and the pane's rule for a
version-less signal is stated below.

### `apps/desktop/src/shared/ipc.ts`

- Export `DocVersions`.
- `'command:exec'` returns `ExecOutcome` rather than `CommandOutcome`:

  ```ts
  /**
   * A command's outcome plus the version each document it wrote now carries. The versions are a
   * desktop concern — `@vn/commands` is shared with `vnauthor` and the CLI, neither of which has
   * a window to keep in step — so they ride here rather than on `CommandRecord`.
   */
  export type ExecOutcome = CommandOutcome & { versions?: DocVersions };
  ```

  `CommandOutcome` is a union, and an intersection over a union distributes, so narrowing on `ok`
  is unaffected.

- New push channel: `'documents:wrote': (payload: { paths: string[]; versions: DocVersions })`.

`'command:undo'` and `'command:redo'` keep returning `CommandOutcome`: they carry no `written`,
so they would always carry an empty map.

### `apps/desktop/renderer/pathux/bridge.ts`

- `WroteWatcher` gains a second parameter:

  ```ts
  type WroteWatcher = (paths: readonly string[], versions: DocVersions) => void;
  ```

  A callback declaring fewer parameters stays assignable, so the three existing consumers
  (`script.ts:184`, `skills.ts:96`, `wiki.ts:126`) need no change.

- The broadcast becomes the only source of `wrote`. Subscribe in `installBridge`:

  ```ts
  api.on('documents:wrote', (payload) => wrote(payload.paths, payload.versions));
  ```

  and drop the two places that derive it locally — `wrote(outcome.record.written ?? [])` in
  `exec()` (:186) and `wrote(written)` in the `agent:event` handler (:361). Main now tells every
  window, which also closes an existing gap: a `ui`-sourced write in window A never reached
  window B at all, because `undoRevision` only advances for `record.stack` or a non-`ui` mutating
  record (`index.ts:719`).

- `invalidate()` stays exactly where it is. Moving both signals at once would widen this change
  for no gain, and the pane rule below covers the version-less signal.

### `apps/desktop/renderer/rules/gengraph.ts`

Put the rule in a pure function beside the other gengraph rules, so it is unit-testable in the
node-only jest project rather than only reachable through a DOM editor:

```ts
/** What a pane knows about one document's versions. */
export interface DocSync {
  /** Writes this pane has sent and not yet had answered. */
  inflight: number;
  /** The highest version this pane's own writes produced. */
  mine: number;
  /** The highest version anyone has reported for this document. */
  latest: number;
}

/**
 * Whether an echo naming `incoming` should make the pane re-read the document. `undefined` is a
 * signal that named no version — an undo or a redo — which is reloaded whenever nothing local is
 * outstanding, since there is no version to compare it against.
 */
export function shouldReload(sync: DocSync, incoming: number | undefined): boolean {
  if (sync.inflight > 0) return false;
  if (incoming === undefined) return true;
  return incoming > sync.mine;
}
```

### `apps/desktop/renderer/pathux/editors/nodes.ts`

Replace `skipReload`/`sent` with the three counters, reset whenever the pane points at a different
graph.

```ts
private sync: DocSync = { inflight: 0, mine: 0, latest: 0 };
```

`send()` becomes the place the counters move:

```ts
private send(edit: GenEdit): void {
  if (this.slug === '') return;
  const command = commandFor(this.slug, edit);
  this.sync.inflight++;
  void exec(command.id, command.props).then((outcome) => {
    this.sync.inflight--;
    const version = outcome.ok ? outcome.versions?.[this.docPath()] : undefined;
    if (version !== undefined) this.sync.mine = Math.max(this.sync.mine, version);
    // A write that landed while this pane's own were outstanding was ignored at the time, so the
    // catch-up comparison happens here rather than being lost.
    if (shouldReload(this.sync, this.sync.latest)) void this.load(this.slug);
  });
}
```

`onWrote` becomes:

```ts
onWrote((paths, versions) => {
  if (!touchesGraph(paths, this.slug)) return;
  const version = versions[this.docPath()];
  if (version !== undefined) this.sync.latest = Math.max(this.sync.latest, version);
  if (shouldReload(this.sync, version)) void this.load(this.slug);
  else this.paintState();
})
```

and `onInvalidate` passes no version, so it reloads unless something local is outstanding:

```ts
onInvalidate(() => {
  if (shouldReload(this.sync, undefined)) void this.load(this.slug);
})
```

That last one matters more than it looks. `bridge.exec()` invalidates after **every** mutating
command anywhere in the app (:187), so today this pane reloads on all of them; gating it on
`inflight` stops a drag being interrupted by an unrelated edit as well.

`load()` resets the counters when the slug actually changes, since versions are per document:

```ts
if (!sameGraph) this.sync = { inflight: 0, mine: 0, latest: 0 };
```

### Every edit is applied to the graph on screen, not just a drag

Suppressing the echo makes this mandatory, and it was the second thing implementation turned up.

`dispatch` applied the decision locally for `moveNodes` alone, because a frame that did not move
snaps back the moment `_commitMove` resyncs. Every other gesture — add, remove, link, unlink,
choose the active output — left the local graph untouched and relied on the echo's reload to show
what it had done. A bound property write was already the exception in the other direction:
`onPropWrite` runs after the widget has written the value, so the local graph already holds it
(`nodes.ts:443-447`).

So `dispatch` now applies every accepted edit and repaints for everything but a drag, which needs
no repaint because the view resyncs from `node.pos` on its own. What is applied locally is what
main writes, on two grounds worth stating because the design rests on them:

- Both sides decide the edit with `decideGenEdit` against the same file, which is already the rule
  the mid-gesture refusal depends on
  ([`desktop-app-editors-pipeline.md`](../../reference/desktop-app-editors-pipeline.md#gen-graph)).
- A new node's id comes from `Graph.add`, which allocates from an `idgen` counter the graph's own
  nstructjs struct carries (`vendor/path.ux/scripts/graph/graph.ts:88, 141-150`). Two parses of
  one file therefore hand out the same next id, so the node this creates is the node main writes.

An edit path.ux can dispatch but this app has no command for is refused in `weigh` before any of
this, so nothing is applied for an edit that was never going to be sent.

**A refusal now has to be undone.** Applying before sending means a write main refuses leaves the
pane showing an edit the file never took. `DocSync` carries a `stale` flag for that one case, set
when an outcome comes back not-ok and cleared by the read that answers it. It does not outrank
outstanding writes — a read issued while later writes are in flight would show a state older than
they are — so it is held until the last of them settles and acted on there, alongside the
foreign-write comparison.

### Where the key comes from

The key is `graphDocPath(slug)`, added beside `touchesGraph` in
`apps/desktop/src/shared/writes.ts` and built from a `GRAPH_DOCS_DIR` constant the matcher, the
key and the main-side cache all share — the prefix bug above is exactly what one definition per
caller costs.

`setPropKey` in `renderer/rules/gengraph.ts` and its import here are removed, along with the
`onExec` watcher that fed it: the version rule subsumes what it was keying, and it was exported
for that one caller.

## Fix 2 — reads served from main

`session.graphDoc()` (`apps/desktop/src/main/session.ts:5308`) currently does, per call: an
`exists`, a `readText`, a `JSON.parse`, an nstructjs deserialize, `bindGroupLibrary` plus
`resolveGroups` (which reads the group library off disk), `validateGenGraph`, and then
`writeGraphFile` to serialize the graph *back* to the file layout for the wire. Every reload pays
all of it.

Hold the answer instead:

```ts
/** One graph's last answer, and what the file looked like when it was built. */
interface HeldGraphDoc {
  read: GraphDocRead;
  mtimeMs: number;
  size: number;
}
```

- Serve the held answer when a `stat` of the graph file still matches `(mtimeMs, size)`. The stat
  is what keeps an outside writer — the CLI, a `git checkout`, the author's own editor — from
  being served a stale parse, and it is the same rule `ContentStore.cached`
  (`packages/commands/src/content.ts:218`) already uses for documents.
- Drop every held entry whenever `noteWrites` names any path under `GRAPH_DOCS_DIR`. A stat of the
  graph file cannot notice a change to a group definition the graph resolves, and the group
  library lives in that directory, so the whole set goes rather than one entry.
- Clear on workspace switch, beside `forgetFiles()`.

This is deliberately a cache with a stat rather than an authoritative in-memory document. Main is
not the only writer of these files, and a cache that cannot be corrected by looking at the disk
would be wrong in exactly the cases that are hardest to debug. The invariant in
`apps/desktop/src/main/filecache.ts:9-10` — nothing is durable only in memory — is left standing.

## Out of scope

- **Deferring the writes themselves.** The disk write is not on the critical path this plan is
  about, and coalescing it is a separate change with a separate risk (a document durable only in
  memory for a window).
- **The re-derivation storm.** Every command triggers `workspace:index` in every window, which
  reloads and revalidates the whole project and walks `wiki/` twice
  (`packages/authoring/src/workspace.ts:192-201`), plus a debounced `recomputeApprovals`. That is
  the larger latency problem and it is not this plan. Taken up in
  [`precise-write-signals.md`](precise-write-signals.md), which measured it at ~400 ms per window
  per command on a 181-file project.
- **Commit policy.** Untouched here.
- **The other three `onWrote` consumers.** `script.ts`, `wiki.ts` and `skills.ts` keep working on
  paths alone. `DocBuffer` already refuses a save by content hash
  (`apps/desktop/renderer/pathux/docbuffer.ts:199`), so it has a weaker form of this protection
  already; adopting versions there is a follow-up.

## Verification

- New unit tests for `LiveDocs` (stamping, per-path counters, reporting without stamping, `clear`)
  in `apps/desktop/src/main/tests/livedocs.test.ts`.
- New unit tests for `shouldReload` covering the cases the rule exists for: outstanding local
  writes suppress an echo; a version at or below `mine` is ignored; a newer version reloads; the
  catch-up comparison when the last outstanding write settles behind a foreign one; a version-less
  signal reloads only when nothing is outstanding.
- `apps/desktop/src/shared/tests/writes.test.ts` pins `graphDocPath` against the shape a write
  actually reports, which is the assertion whose absence let the prefix bug ship.
- `pnpm check && pnpm test && pnpm lint` green. Done: 3442 tests pass.
- Manual, in `pnpm vndesktop`: drag a node, release, and drag it again immediately, three or four
  times in a row. The node must never snap back. Then edit the same graph from the palette and
  confirm the pane still picks the change up. Then open the graph in two windows and move a node
  in one; the other must follow, which it does not today.

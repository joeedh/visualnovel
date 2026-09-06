# A zod-backed ModelInterface with a proxy toolstack

This document is research. Nothing here is planned work. It follows on from
[`ux-behaviour-model.md`](ux-behaviour-model.md), which proposes a machine-readable model
of the desktop app's UX, and from the path.ux meta-tag sketch at
[`vendor/path.ux/scripts/core/base/ui_meta_tags.ts`](../../vendor/path.ux/scripts/core/base/ui_meta_tags.ts).

Could the renderer bind editors to the project's documents through path.ux's data-path
system, with one `ModelInterface` implementation per zod schema, instead of hand-drawing
each editor from an IPC view type? The question splits into a read side, which is cheap
and mechanical, and a write side, which collides with the command system's invariants
unless the renderer's toolstack is replaced by a proxy to main.

The report recommends both halves, in a fixed order. The read side alone gets standard
widgets, path watching, the data-path catalog and lint over document paths, and the meta
tag's `valuePath` filled by the builder. The write side is coherent only with a proxy
toolstack that translates a data-path set into the command that owns the field, and that
ownership is declared once per field on the mapped property, not on widgets and not
inferred from the command catalog.

<!-- toc -->

- [What exists today](#what-exists-today)
    - [In the app](#in-the-app)
    - [In path.ux](#in-pathux)
- [The proposal](#the-proposal)
    - [The read side](#the-read-side)
    - [The write side](#the-write-side)
    - [Field ownership](#field-ownership)
    - [Metadata](#metadata)
- [What it buys the behaviour model](#what-it-buys-the-behaviour-model)
- [Costs](#costs)
- [Decisions a plan would settle](#decisions-a-plan-would-settle)
- [See also](#see-also)

<!-- tocstop -->

## What exists today

### In the app

- **The renderer's only `DataAPI` covers `ShellState`.** `defineShellApi()` in
  `renderer/pathux/app/api.ts` maps the `ui.*` selection fields and the header facts. The
  `buildToolSysAPI` call exists so the gen-graph gestures can run. No document data is
  reachable by data path.
- **Editors hand-draw from IPC view types.** Each editor reads a view (`PromptView`,
  `AssetInfo`, `Convo`, `ReportStateView`) and builds its widgets with `button`, `label`
  and custom surfaces. `container.prop` is not used for document fields, so the path
  watcher, the generated catalog and the `valid-datapath` lint cover `ui.*` and nothing
  else.
- **Commands are the only write path.** Every change to the project runs as a registered
  command with typed props, a refusal declared ahead of the run through `stack.check`,
  provenance in `vngen/state/commands.jsonl`, and undo over a content-addressed snapshot
  in main. A command sent once per frame declares `defersCommit`, and a run of them
  commits once. [`../reference/command-system.md`](../reference/command-system.md).
- **`view.*` answers optimistically and corrects.** Main pushes a `command:ui` effect, the
  mesh applies it, and a correction follows if the mesh disagreed. That pattern already
  exists for one class of write.
- **The zod schemas carry structure and no UX text.** `packages/types/src` has no
  `.describe()` calls. A schema states types, enums, optionality and ranges. Where
  `.describe()` is added it documents the field for developers and does not drive
  tooltips.

### In path.ux

- **`ModelInterface` is the abstract seam.** `DataAPI` extends it. The contract is
  `resolvePath`, `getValue`, `setValue`, `createTool`, `execTool`, `getToolDef`,
  `parseToolPath` and `massSetProp`, in
  `scripts/path-controller/controller/controller_abstract.ts`. `setValue` honours
  `PropFlags.READ_ONLY` and routes a `USE_CUSTOM_GETSET` property through the property's
  own setter, then calls `notifyPathChange`.
- **A widget write is a `DataPathSetOp`.** `ui_base_datapath.ts` builds one from the path
  and value and hands it to `ctx.toolstack.foldOrExec`, which folds a repeated set on the
  same path into the head op. That is how a slider dragged per frame leaves one undo
  entry.
- **The toolstack is an interface with a small surface.** Widgets and the controller call
  `execTool`, `execOrRedo`, `foldOrExec`, `undo`, `redo` and `reset`. The last-tool panel
  reads `head`, `cur`, `length` and `rerun`. Nothing else in `scripts/` touches it, and
  `Context` stores it as `unknown`, so the app may supply its own class. It need not be an
  array, and it need not store `ToolOp` instances.
- **The catalog and lint are generated from `defineAPI()`.** `pnpm run gen:paths` walks
  the API headlessly and writes `API_PATHS.md`, `api-paths.json` and `datapaths.ts`, and
  the `pathux/valid-datapath` ESLint rule checks literal paths against it.
  `withDataPrefix` scopes a container to a prefix, so one API can hold many files.
- **Meta tags attach a serializable record to a widget.** `StdUXMeta` carries
  `description`, `valuePath` and a list of `UXToolMeta` entries with `toolPath` and
  `requirements`, serialized with nstructjs for IPC. `valuePath` proxies the widget's
  `datapath` attribute.
  [`ux-behaviour-model.md#meta-tags-as-the-carrier`](ux-behaviour-model.md#meta-tags-as-the-carrier).

## The proposal

Three pieces, each useful on its own and dependent in this order.

1.  A `ModelInterface` implementation whose structs are generated from zod schemas, one
    prefix per file, read-only by default.
2.  A toolstack class that implements path.ux's interface against main: `execTool`
    translates a data-path set into a command, `undo` and `redo` forward to main.
3.  A declaration on each writable property naming the command that owns the field, read
    by the toolstack to translate and by the behaviour model to derive `affects`.

### The read side

- **Zod to `DataStruct` is mechanical.** An object becomes a struct, an enum an
  `EnumProperty`, a number a `FloatProperty` or `IntProperty`, a string a
  `StringProperty`, an array a list. Optionality and ranges transfer. The mapping runs
  once per schema at API definition time, so `gen:paths` sees the result with no change to
  the generator.
- **One prefix per file, not one context per file.** path.ux's `Context` is per screen,
  and every widget reads `ctx.api`. A context per file would fight all of them. A prefix
  such as `files["work/shots/x.json"].shots[3].prompt` under one API is what
  `withDataPrefix` already supports, and the lint checks prefix plus path exactly.
- **The backing object is the file's last IPC view.** Widgets read synchronously, so the
  renderer holds each file's most recent view and `resolvePath` walks it. A new view from
  main replaces the object and `api.notifyChange(prefix)` wakes the watchers under it. The
  async work you would expect in `ModelInterface` lands on the write and notification
  side, not on reads.
- **Every field is `READ_ONLY` until declared otherwise.** A widget bound to an undeclared
  field renders disabled, which is the correct state for a field no command writes.

### The write side

The renderer's toolstack becomes a proxy to main. Nothing about the command system in main
changes.

- **`execTool` is the translation point.** A `DataPathSetOp` arrives with a path and a
  value. The stack resolves the path, reads the owning command off the property, builds
  the invocation, runs `stack.check`, and either sends it through `exec` or surfaces the
  refusal. `setValue` and the widgets never see IPC, and there is no generic
  `doc.set(path, value)` command, so a scene rename through a bound text field still runs
  `doc.rename` and its rules.
- **`foldOrExec` is the write policy.** path.ux already folds a repeated set on one path
  into the head op. In the proxy, a fold extends an open batch and a non-folding op
  flushes it, which maps onto `defersCommit` in main. A slider dragged per frame sends one
  deferring command per frame and commits once. The compaction into distinct file updates
  is a behaviour the interface already has a hook for.
- **`undo` and `redo` forward to main.** Main holds the snapshot undo, so the renderer
  keeps no second stack and nothing can drift. `head`, `cur` and `length` answer from
  main's last command records for the last-tool panel, or the panel is not registered.
- **A refusal reaches the widget.** `execTool` returns a promise, so a refused set rejects
  with the `stack.check` sentence, and the watcher's next delivery restores the widget
  from main's corrected view. That is the optimistic answer plus correction that `view.*`
  uses today.
- **Modal ops stay local.** A gesture op with `NO_UNDO` runs in the renderer as it does
  now and commits on release by executing a command through the same stack.
  `gesture_ops.ts` and `PanZoomPanOp` do not change.
- **Provenance and commits stay in main.** The renderer stack never writes a file, so
  `commands.jsonl` and commit-on-save are untouched.

### Field ownership

The table from data path to owning command is the one hand-authored input, and where it
lives decides whether the design holds.

- **On the mapped property.** When the zod struct is built, a writable field gets its
  owning command and the mapping from path to that command's props, either as a field on
  the `ToolProperty` or as a `USE_CUSTOM_GETSET` setter that builds the invocation. The
  stack gets `prop` back from `resolvePath` for free, so the lookup costs nothing at write
  time. A field with no declaration stays `READ_ONLY`.
- **Not on meta tags.** A tag is on a widget, so a table built from tags covers only the
  fields with a drawn control in the current screen state. That is the coverage gap the
  behaviour model records for the sweep, 49 of 170 commands. Two widgets bound to one path
  could disagree about the owner, and tags are rebuilt on every redraw, so the table would
  churn with the DOM. Tags are the right source for the reverse check: a live screen's
  `valuePath` and `toolPath` pairs are measured rows of the table.
- **Not inverted from `affects`.** A command's `affects` lists what it may touch, and a
  rename touches several paths, so inverting the catalog gives candidates rather than an
  owner. It does give a lint: every writable field's owning command must list that field
  in `affects`.

### Metadata

- **What transfers from zod.** Types, enums, optionality, ranges. This is the part that
  makes `prop()` render the right widget with the right constraints, and it is the part
  that stays in step with the schema by construction.
- **What is authored.** `uiname`, the tooltip, unit, step and icon. These go on the
  mapping side, next to the ownership declaration, once per field. `.describe()` on the
  schema stays developer documentation.
- **Ownership is authored once and used twice.** The stack reads it to translate a write.
  The behaviour model reads it to derive `affects` for the command, in the same data-path
  vocabulary the lint already checks.

## What it buys the behaviour model

- **One path vocabulary.** `ui.publish` effects and a command's `affects` become data
  paths that `gen:paths` catalogues and `valid-datapath` checks, instead of a second
  vocabulary of `ui.*` names and document subtrees.
- **`valuePath` is filled by the builder.** A `prop()` widget's meta tag reads the
  `datapath` attribute the builder set, so the measured tier records what the widget is
  bound to without a hand-written `publishes`.
- **The measured tier verifies the table.** The sweep serializes tags off a live screen,
  and each tag's `valuePath` and `toolPath` pair is checked against the ownership
  declaration. A drawn control that writes through a command other than the field's owner
  is a finding.
- **Editors shrink.** A field drawn with `prop()` needs no anchor call, no offer logic and
  no tooltip at the call site, because the property carries all three. The extraction the
  companion report [`formalizing-the-rules-modules.md`](formalizing-the-rules-modules.md)
  describes gets smaller for every field that moves.

## Costs

- **The `ModelInterface` refactor in path.ux.** Notification from an async source, a
  toolstack whose `execTool` may reject after the fact, and a `resolvePath` over a
  replaceable backing object. This is submodule work, committed separately.
- **The zod-to-struct mapper**, plus the per-field ownership and UX text for every field
  an editor binds. The mapper is written once. The declarations are written per field and
  are the same work the behaviour model's `affects` would have needed.
- **The proxy toolstack** and its batching, including the fold-to-`defersCommit` bridge
  and the last-tool panel's reads.
- **Migration is per field and per editor.** Nothing forces an editor to move. An editor
  that keeps hand-drawing its widgets keeps working, so the cost is paid where the benefit
  is wanted.
- **A refused optimistic write shows briefly.** A widget applies its value before main
  answers and reverts on refusal. The window is one IPC round trip. `view.*` already
  accepts the same window.

## Decisions a plan would settle

- Whether ownership is a field on `ToolProperty` or a `USE_CUSTOM_GETSET` setter, and
  where the path-to-props mapping for a command with several props is written.
- The prefix scheme for files, and whether a file's prefix is its repo path or a stable id
  that survives `doc.rename`.
- Whether the proxy stack registers a last-tool panel at all, and if so what `head`
  answers from.
- Which editor moves first. A form-shaped editor with scalar fields (project settings, a
  prompt clause) is the cheapest proof, and the gen-graph pane is the most expensive.
- Whether the zod-to-struct mapper runs in the renderer at startup or generates a
  checked-in module, which decides whether `gen:paths` can see it in CI.

## See also

- [`ux-behaviour-model.md`](ux-behaviour-model.md) proposes the model this design feeds,
  and describes the meta tags as its carrier.
- [`formalizing-the-rules-modules.md`](formalizing-the-rules-modules.md) covers the rule
  module extraction that shrinks as fields move to `prop()`.
- [`../reference/command-system.md`](../reference/command-system.md) states the write
  path, `stack.check` and `defersCommit` the proxy stack maps onto.
- [`vendor/path.ux/documentation/container.md`](../../vendor/path.ux/documentation/container.md)
  documents `prop()`, the property-to-widget mapping and path prefixes.
- [`vendor/path.ux/documentation/controller.md`](../../vendor/path.ux/documentation/controller.md)
  is the data-path controller overview `ModelInterface` sits under.

# Archived plans index

Plans older than the recent-plans window with no outstanding outside reference, zipped
into `docs/plans/archive.zip` to keep this directory small. Each entry's summary is copied
from `docs/plans/index.md` at the time of archiving, so the two never disagree.
Regenerated/extended by `.claude/skills/archive-plans`.

<!-- toc -->

<!-- tocstop -->

### clustering-the-global-task-graph

The task graph editor's overview stops handing `layoutGraph` the raw per-task graph, where
one shared portrait fans out to every shot that refs it and blows a rank out to the shot
count: `clusteredGraphOf` groups tasks/slots by scene, character and location first, so
the layered layout only ever sees a handful of clusters; a searchable slot list opens
`subgraphFor`'s ancestor closure of one slot, and clicking a cluster opens
`clusterMembers` — both small task-level graphs that keep the existing layout unchanged

Archived 2026-08-22, in `archive.zip`.

### the-debug-agent-as-a-conversation

The difficult-agent report stopped being a dialog that blocks and became an agent the
author talks to: a Debug Agent pane opened as a popup from the Help menu and listed in
neither of the two menus an author browses, its own store fed by a `report:event` channel
that must never be `agent:event` (which would append the analyst's turns to the very
conversation being analysed), the six form props redrawn as the first card in the
transcript with `note` becoming turn one, `createAnalyst` holding the loop
`analyzeWithTools` threw away so a reply continues it, source and request access granted
part way through by growing a registry the next turn's catalog reads and announcing it in
a superseding system message, live prose redacted before it is shown so the chat and the
report use the same names, a cooperative stop plus the fallback bug it exposes, and ten
redacted transcripts kept at `<userConfigDir>/debug-transcripts/` with the oldest pruned

Archived 2026-08-21, in `archive.zip`.

### publishing-a-vn-to-github-pages

A generated VN publishes to the web as a light novel: `renderSite` projects the playable
into one static HTML page per scene with `choices` and `next` as links and no prose
rewriting, VN STUDIO ▸ Install/Update GitHub Page Builder… commits a dependency-free
bundle of that renderer into the author's project beside a workflow that runs it with
plain `node` (every package here is `private: true`, so CI cannot install one), and the
workflow force-pushes an orphan `gh-pages` branch rather than deploying to Pages directly
— refusing any existing branch that carries no `.vn-pages` marker. The app commits and
never pushes

Archived 2026-08-20, in `archive.zip`.

### prompt-caching-for-the-report-analyst

The report analyst joins the cached path: `analyzeWithTools` probes `chatConversation` the
way `session.ts` and `vnauthor` already do, taking `NativeAgentBackend` (rolling
breakpoints, `record: false` preserved through the convo capture) on Anthropic models and
falling back to the structured path everywhere else, plus a `deferTools: false` agent
option because on the native path the default deferral would hide `submit_report` itself
behind tool search — the direct single-call path deliberately stays uncached

Archived 2026-08-20, in `archive.zip`.

### watching-and-stopping-an-agent-report

Superseded by
[`the-debug-agent-as-a-conversation`](INDEX.md#the-debug-agent-as-a-conversation), which
carries its busy-state work and its fallback fix and answers the rest with a transcript
and a composer rather than a progress popup. The longest thing the app does on the
author's key stops being silent: the report's step count fed into the busy push that
already broadcasts to every window, the header's spinner and stop button generalised off
the one busy kind they are hardcoded to, a cooperative `report.stop` on its own
`AbortController` (and the refusal that says a single-call analysis has no step to stop
after), a progress popup showing tool names and spend but never unscrubbed model prose,
and the fallback bug a stop exposes — `analyze()` treats a stopped loop as one that
wandered off, so pressing Stop would spend another model call and hand back a report
nobody asked for

Archived 2026-08-20, in `archive.zip`.

### what-the-agent-knows-about-the-story-format

The authoring agent's knowledge of the story format, routed to the three places it can
live: `SYSTEM_PROMPT` gains all six `BranchMarker` kinds with `[[line:]]`/`[[nextline:]]`
marked machine-managed, a closed-world sentence saying branching is scene-granular and
nothing finer, and a preamble that stops denying `approve_assets`; `planSceneEdit` starts
refusing a write that would drop a note the model cannot hold, because today the first
unrelated edit to a scene silently deletes the author's `[[TODO:]]`; the validator then
reports the same notes, split by consequence rather than by confidence
(`unparsed_branch_marker` error where an edge or a shot anchor is lost, `unknown_marker`
warning where `branch.ts` documents a plain-note fallback), joining `droppedWarnings` as
the fourth thing the model does not keep; one new skill, `branching`; plus `deleteLines`
and a `writeFileAtomic` temp name that is random and cleans itself up. Decides the
budget's units (characters, asserted in a test that refuses rather than truncates), and
records three things already true that the reports said were not — `git_commit` has gated
on error severity since `883d4a25`, a chunk holding two scenes is caught by `entities.ts`,
and only `vngen run` refuses on an error while `export` proceeds.

Archived 2026-08-19, in `archive.zip`.

### diagnosing-an-api-error-from-the-request-that-caused-it

A 400 that names a position is unreadable once the body is gone, so the body stops being
gone: an always-on in-memory ring in `@vn/providers` bounded by bytes _and_ count (64 MB /
64 entries), every Anthropic and Gemini call site capturing its vendor body before the
call rather than after it, `faultKind` unwrapping `cause` so a fault in the request is
told apart from a dead connection and a bad key, the recovery card offering to look into
the first kind only, a `UiEffect` that opens the difficult-agent dialog by itself with
both reading boxes ticked and a sentence saying why, `list_requests` / `read_request`
giving the analyst structure and capped redacted values by JSON Pointer rather than a
pasted body, `analyze.ts` split so the requests are a door the source is not — and the
rule that none of the capture ever reaches the report, so the detailed tier's privacy area
is exactly the author's own model provider; verified against a loopback fake API through
the real SDK, with the analyst told apart from the agent by its own `submit_report` tool

Archived 2026-08-19, in `archive.zip`.

### skills-editor-and-agent-authored-skills

Skills made visible and writable: a Skills branch in the document tree that is drawn even
when empty, because a created project has no `.aiagent/` at all and an absent branch
teaches nobody; a thirteenth editor over every file under `.aiagent/skills` with a hint
and a button that hands the author to the agent; `create_skill`/`edit_skill` with a
`write_file` gate that makes the agent's skills **prose only**, since a confirm card
cannot tell a script a human vetted last year from one the agent wrote ninety seconds ago;
and two extractions the second host forces — the tree renderer with its counted
double-click, and the document buffer with its draft map and content-hash refusal.
Pressure-tested:
[`../../research/pressure-test-skills-editor-plan.md`](../../research/pressure-test-skills-editor-plan.md)

Archived 2026-08-18, in `archive.zip`.

### shipping-the-app-tasklist

The five plans between "it runs from a checkout" and "a stranger has it installed and
updating", their running order, and the three real edges between them

Archived 2026-08-18, in `archive.zip`.

### release-ci-workflow

The two workflows this repo has never had: per-push check/test/lint with
`submodules: recursive`, and a tag-triggered release that gates once, builds a matrix,
asserts the tag against the version rather than writing it, and leaves a **draft** for a
person to publish

Archived 2026-08-18, in `archive.zip`.

### packaging-the-desktop-app

electron-builder into an NSIS installer: what ships (only `dist/` plus the two SDKs
`EXTERNAL` leaves unbundled, and never `pathux-types`), the hoisted install that keeps
pnpm's symlinks out of the app image, `git` declared a runtime dependency with a startup
doctor rather than a bundled copy, and `apps/desktop/package.json` named the one version a
tag must match

Archived 2026-08-18, in `archive.zip`.

### onboarding-editor-and-user-level-keys

API keys above the project — a platform-native user config dir with `$VNAUTHOR_HOME` and a
`~/.vnauthor` fallback read, appended as a fourth rung so a project's own key still wins;
`project.setKey` gaining a scope and `project.keyStatus` naming the source without the
value; a thirteenth `offered: false` editor walking an author through both vendors'
consoles with a Test key button; and the path.ux addition that makes it possible —
`setAreaMenuFilter`, because `AreaFlags.HIDDEN` is static per class and which editors an
app offers is the app's policy

Archived 2026-08-18, in `archive.zip`.

### in-app-update-checks

`app.checkForUpdates` as a registered command reading the releases feed and comparing
semver — check-only first because `electron-updater` on macOS needs signing and fails
silently without it; the notification rather than a modal, the browser hand-off, quiet
failure, and a periodic check off by default

Archived 2026-08-18, in `archive.zip`.

### improving-the-authoring-agent

What the adversarial read of `examples/test4` found, built: a per-turn **token budget**
replacing the step count (checked between steps, warning the agent at 80%, naming the
spend and the uncommitted files when it runs out), an **`edit_file`** that replaces exact
strings against a per-conversation read ledger so a long document is changed in part
rather than restated, a bulk `insertLines`, create tools that take the edit tools' whole
field set, tool descriptions and observations that tell the truth about their own scope,
six system-prompt edits, and the host plumbing that puts plans, verdicts, shortlists and
refused arguments into the durable thread `report.agent` reads

Archived 2026-08-18, in `archive.zip`.

### auditing-the-api-key-instructions

Keeping `docs/api-keys.md` true: a per-vendor yaml block so the facts are
machine-readable, a deterministic blocking link check because a moved console is the
failure that actually happens, and a weekly **advisory** semantic audit that opens an
issue and never edits the file a confused new user is reading

Archived 2026-08-18, in `archive.zip`.

### gemini-estimated-cache-hit-rate

Gemini's implicit cache reported in the tokens tooltip: `cachedContentTokenCount` carved
out of `input` as `cacheRead`, a `cacheEstimated` flag riding the same wire so a
matched-prefix count is never shown as a bill, the tooltip prose moved out of the editor
into a tested `tokensDetail`, and a five-call live ritual — because the implicit cache is
slow to start and then intermittent, so a two-call proof fails a working implementation

Archived 2026-08-18, in `archive.zip`.

### prompt-caching-and-deferred-tool-loading

Why a small project bills ~376k input tokens for one conversation, and the five
workstreams that fix it: cache reads and writes split out of `TokenUsage` so the rest can
be believed, a conversation-shaped `chatConversation` request with four `cache_control`
breakpoints (tools, system, and two rolling ones in `messages`) replacing the one
re-rendered string, tool arguments in the transcript so the agent stops reading back what
it just wrote, `MODE` moved out of the prompt prefix into a `{"role":"system"}` message,
the desktop switched off `StructuredAgentBackend`, and the native tool search tool +
`defer_loading` instead of a hand-rolled `load_tool` — because appending a schema to
`tools[]` invalidates the whole prefix and the server-side version does not

Archived 2026-08-18, in `archive.zip`.

### superseded-assets-in-the-document-tree

The Assets branch asks the slot graph which take is current and files the rest under a
collapsed `Superseded` child — undecided candidates all count as live, and an asset no
slot mentions stays put

Archived 2026-08-18, in `archive.zip`.

### drawing-a-character-before-a-scene-casts-them

P2/P3 enumerate every authored location and character rather than only what a reachable
scene names, so a cast sheet gets its portrait before a scene exists to put it in; P4
stays tied to `usedOutfits`, and `gateStatus` keeps its own walk so an uncast portrait
blocks nothing

Archived 2026-08-18, in `archive.zip`.

### the-todos-sweep

The author's running list worked through in one pass: the run-pipeline dialog and its busy
icon, the recent-projects menu, popup borders and word wrap, a key-provider dropdown, the
agent's running token total, the character template, tooltips on every menu entry, and the
several tree and script-editor bugs the list named

Archived 2026-08-17, in `archive.zip`.

### reporting-a-difficult-agent

Help ▸ Report a Difficult Agent…: the finding that a thread is a display log rather than
an execution one (tool args and results dropped, every text clamped at 400) so the format
is enriched first and old threads are joined against `commands.jsonl` by time instead; a
debug agent on the author's own key and their own machine, given the app's own source
through a declared manifest and an allow-listed `fetch_api_docs` rather than an arbitrary
fetch, because an agent that has just read a private manuscript is otherwise an
exfiltration channel; de-personalisation as a boundary every byte crosses rather than a
prompt instruction, with the same matcher run back over the finished report as a live
refusal; the analysis borrowing the bound model and effort without rebinding them,
advising rather than refusing because the verdict strip is binary and `agent.setEffort`
already accepts every choice; and a GitHub issue the author reviews and submits
themselves, the URL asserted before it reaches the shell

Archived 2026-08-17, in `archive.zip`.

### the-full-slot-graph-and-approving-upstream-first

Every picture the project implies, not just the wave the planner could hash: a slot graph
over `refsOfSlot` with the planner's enumerators lifted into `@vn/model` so the two cannot
drift (and a test that plans a project to exhaustion to prove it), prerequisites walked
over `Asset.refs` so a listed row is clickable, an Approve greyed by its own refusal with
the same sentence `asset.accept` gives, a DRAWN FROM strip that retargets the pane in
place, an Unapproved branch in two groups the slot graph makes disjoint,
`story.decomposeAll` / `vngen decompose` that storyboard every reachable scene and never
persist a fallback, and the death of the graph pane's estimated ghost clusters

Archived 2026-08-17, in `archive.zip`.

### deliberate-reasoning-effort-defaults

`default` removed from the effort menu, because on Opus 4.7/4.8 and Sonnet 4.6 "the knob
left off" runs the model with no thinking at all: a per-model table in `@vn/types` says
what each one's ladder is and whether `no thinking` is even offerable (Fable 400s on it),
`low` becomes the stated default everywhere including the pipeline's own calls,
`resolveEffort` steps a stored choice down when the model switches under it, and the
no-thinking `max_tokens` goes 2048 → 10000

Archived 2026-08-17, in `archive.zip`.

### layout-templates-and-the-view-menu

The View menu's editor list folded into an Editors submenu to make room for Layout: named
arrangements the project owns at `.vnstudio/layouts/`, carrying either a declarative
recipe (so main can ship, scaffold and reset them with no renderer in the loop) or a
serialized mesh (so an arbitrary dragged layout round-trips), a `-merge` attribute that
makes git conflict one rather than invent a third, an undo that restores the file _and_
the screen by noticing the fingerprint moved, and `digest` props finally rendering as a
summary instead of a 21 KB textbox

Archived 2026-08-16, in `archive.zip`.

### notifications

One durable, linkable notification log in the project repo —
`vngen/state/notifications.jsonl`, per-line versioned, union-merged, with read/hidden as
single ASCII digits patched in place at a byte offset — filed for every command outcome
from one `onRecord` hook, narrowed to a single note frame in the menu bar, and read
through a bell, a scrollable list with in-place archive/undo, and a category filter

Archived 2026-08-16, in `archive.zip`.

### new-project-as-its-own-dialog-and-its-own-repo

Two faults the author found in the one above: the form extracted into a `CommandForm` with
two hosts, so the palette stays the finder and a named command gets its own dialog with
Cancel and no search box; and `initRepoAt`, `ensureRepo`'s opposite, so creating a project
inside a repo nests one of its own instead of silently getting none

Archived 2026-08-16, in `archive.zip`.

### new-project-dialog-with-folder-browse

`prop.directory` and the palette's Browse… button, `workspace.chooseDirectory`, and a
`newFolder` checkbox that makes `workspace.create`'s form a real New Project dialog

Archived 2026-08-16, in `archive.zip`.

### model-keys-tree-menus-and-inline-rename

Seven todos taken together: a `secret` prop kind so `project.setKey` can write a
credential the history records as `<secret>`, a `.gitignore` written before a new repo's
first commit so `keys` is ignored by the time anything can be committed, branch headings
offering what their subtree is made of, a capture-phase pointer-down latch so the click
that dismisses a menu cannot collapse the tree underneath it, and double-click-to-rename
over a `doc.rename` that writes wherever the name was read from and never moves the file.

Archived 2026-08-16, in `archive.zip`.

### upload-and-archive

`/upload`: an author's documents archived verbatim under `archive/`, invisible to `search`
and to entity discovery because both walk allow-lists and readable by name, with
content-blind suggestion chips, a seeded thread in plan mode, and one `archiveUpload`
behind both the desktop command and the REPL

Archived 2026-08-15, in `archive.zip`.

### new-and-open-project

`workspace.create` beside `open`/`pick`/`recent`: a three-file skeleton so a new project
loads a model with zero error diagnostics, a refusal on a non-empty directory, a warning
when the target sits inside an existing repo, and the New/Open/Recents menu set

Archived 2026-08-15, in `archive.zip`.

### editor-routing-by-relevance

Clicking a document tree item shows the editor that can best answer for it: claims
declared beside the names in `editors.ts` as predicates over the node, a pure `routeFor()`
sorting on `(visible, tier, EDITORS order)`, selection published before the open, and
`where: 'elsewhere'` as the fallback that already exists

Archived 2026-08-15, in `archive.zip`.

### document-tree-context-menus

The first context menus in the app, built from the catalog: entries are invocations
resolved through `check` then `exec`, a refused entry shown with the command's own
sentence rather than hidden, `undeclared` explicitly not permission, and one table per
node kind including the kinds that offer nothing

Archived 2026-08-15, in `archive.zip`.

### conversation-threads

Conversations saved as append-only JSONL under `vngen/state/threads/` — outside the undo
snapshot by design — with the reducer moved to `src/shared/` so main and the renderer
agree, a searchable dropdown, and reopening that replays read-only rather than pretending
the model remembers

Archived 2026-08-15, in `archive.zip`.

### asset-cross-references

A page showing the art that references it: `scene:<id>` backlink keys and a path index on
`DocTree`, and the asset strip extracted into a generic widget with two consumers — the
wiki editor and the script editor — plus the honest finding that no asset binds to a plain
lore note today

Archived 2026-08-15, in `archive.zip`.

### agent-art-revision

The agent reaching planned art: the art-notes rungs moved to `@vn/artgen` so one parser
serves both hosts, regeneration as an injected `pipeline?` capability rather than an
argument with the boundaries rule, a general `describeAsset` over the `ChatBackend` seam
instead of a widened `VisionReviewer`, and five tools that propose notes rather than
silently iterating

Archived 2026-08-15, in `archive.zip`.

### adopting-an-uploaded-asset

Uploaded artwork becoming a slot's actual output rather than a reference: `adoptSlot`
generalized out of `promoteConcept`, addressed by the existing `plate:`/`sheet:`/`shot:`
slot vocabulary, with the planner's input builders extracted so hashes cannot drift, a
portrait refused because the P3 gate owns it, superseding a real render as a declared act,
and an asset-editor Replace strip that reads the slot off the picture on screen rather
than asking for one

Archived 2026-08-15, in `archive.zip`.

### chunked-prompts

The prompt as an addressable list of clauses rather than a flat string: `PromptChunk[]`
behind every builder (collapsing byte-identically, so no task hash moves), per-chunk
replace/append/mute/reorder, a verbatim user prompt and an agent-condensed one that is
_held_ rather than re-rendered when its chunks move, a `prompt.*` namespace and a rebuilt
asset pane — plus Part II, where a chunk carries reference images: a linked asset pinned
by hash and remembering the slot it came from, derived viral suspension when that slot
moves, an acyclic reference graph enforced over bindings at write time, custom uploads as
a new `reference` kind, and the retirement of the never-read `Character.referenceImages`

Archived 2026-08-15, in `archive.zip`.

### on-demand-concept-images

A picture the pipeline never asked for: `@vn/artgen` (prompt composition moved out of
`@vn/pipeline` so the agent can reach it), a `concept` asset kind that is bound but never
consumed, `generate_image` + `/makeimage` in `vnauthor` and `art.generate` in the desktop,
and `art.promote` — which writes the variant onto the location sheet and records the
planner's own task as `done`, so the next run adopts the sketch instead of rendering over
it

Archived 2026-08-15, in `archive.zip`.

### desktop-agent-permissions

The desktop answering the agent's other two permission doors: `ask_user` and every
always-confirm tool were scaffolded to `''` and `true`, so the app answered for the author
— a question card and a confirm card in the convo pane, over the plan card's own
request/reply shape, with an English sentence built in main rather than the raw arguments,
and teardown resolving every parked door instead of hanging the turn

Archived 2026-08-15, in `archive.zip`.

### asset-names-and-the-asset-editor

Generation from an authored surface: assets named rather than hashed in the document tree,
`artNotes` as an authored field at five rungs (character, location, outfit, variant, shot)
appended to the derived prompt so an edit re-keys the task and re-renders exactly what it
reaches, the `asset.*`/`art.*` commands, and the eleventh editor — which previews one
asset, approves it, and regenerates it from where the tree names it

Archived 2026-08-15, in `archive.zip`.

### authoring-surface-tasklist

The running order and checkbox list for the eight plans below, with the only two hard
dependency edges named.

Archived 2026-08-15, in `archive.zip`.

### desktop-shell-fit-and-finish

Eight gaps collected while using the path.ux shell for real: a window that would not close
(`will-prevent-unload`), the stock menu deleted with Ctrl+Q and F12 re-homed, a bounded
dialogue box, the agent's mode and a working indicator on the convo pane's own bar,
model + effort pickers (`agent.setEffort`, `TEXT_MODELS`/`EFFORT_LEVELS` moved to
`@vn/types`), and an `onWrote` bus so an open document follows the agent's writes — plus a
`⟳` on both editors

Archived 2026-08-14, in `archive.zip`.

### wiki-and-document-tree-editors

The panes for the story bible and the document tree: a `documents` sidebar (logical tree +
file-tree mode + backlink panel + a New… row), a `wiki` markdown editor, and the
`doc.read`/`doc.write`/`doc.create` commands they need — the UI items 3 and 9 each
deferred to the other. Eleven decisions, five of them found by auditing the draft against
the code

Archived 2026-08-13, in `archive.zip`.

### story-bible-and-retrieval

The `wiki/` tree read as prose and reached by retrieval: a new `@vn/bible` between store
and authoring, `query(text) → ranked excerpts` under a hard budget, `search_bible` and
`bible.search` — grep now, embeddings behind the same seam

Archived 2026-08-13, in `archive.zip`.

### shot-ordering-in-scenes

Reordering shots inside a scene as what it actually is — moving the shot's covered lines —
with the refusal that makes it definable (a shot with interleaved coverage has no single
position), `moveShot` in `@vn/scriptedit`, `story.moveShot`, the `timeline.reorder`
gesture that previews it, and `edit_scene`'s tenth op

Archived 2026-08-13, in `archive.zip`.

### repo-map-and-commit-on-save

Which repo owns a path (`RepoResolver`, discovered not declared), every act committing to
each repo it touched, undo restoring as a _new_ commit rather than a reset, and the
`git init` + commit-existing half of project bootstrap

Archived 2026-08-13, in `archive.zip`.

### project-bootstrap-and-workspace-picker

The other half of project bootstrap: a picked directory becomes a project (`openWorkspace`
writes a one-line `project.yaml`, then `ensureRepo`), `workspace.open`/`pick`/`recent`, an
in-place switch that tears the session and undo stack down with the old root, and a
startup precedence that remembers the last project

Archived 2026-08-13, in `archive.zip`.

### outfits-at-scene-and-shot-level

An authorable wardrobe (`outfits:` on the character sheet) and an inheritance chain — shot
override → `[[outfit: aiko=uniform]]` scene marker → character default — resolved by one
`outfitFor`, with a non-default outfit rendered against its own model sheet and P4's
fan-out narrowed to the outfits a reachable scene actually asks for

Archived 2026-08-13, in `archive.zip`.

### document-tree-and-backlinks

The sidebar's two shapes, joined from edges that already exist: a document tree (story →
scenes → shots, characters, locations, the wiki tree, assets by kind) plus per-entity
backlinks (sheet, base art, scenes, shots), on their own channel so the hot workspace
index stays cheap

Archived 2026-08-13, in `archive.zip`.

### base-and-project-asset-stores

Base art (portraits, model sheets, location refs) split into its own content-addressed
root at `assets/` — own subtree, own manifest, optionally its own repo — with reads
unioned across both roots, an `unavailable` base that refuses to plan rather than
regenerating, and `Asset.satisfies` grown to a list of bindings

Archived 2026-08-13, in `archive.zip`.

### agent-context-regeneration

One generated `AICONTEXT.generated.md` — the cast, the locations, the story graph and the
bible's _table of contents_ — written by `workspace.reindex` off the two walks that
already exist, read one rung below the author's own `AICONTEXT.md`, budgeted, and refusing
to overwrite a file it did not write

Archived 2026-08-13, in `archive.zip`.

### pathux-desktop-rewrite

The renderer rebuilt on path.ux (submodule): subdividing screen, seven editors ported
cheapest-first, one selection, per-area keymaps, `view.*` addressing editors instead of
rooms, and the docs reorganized by editor. The React shell, the `--react` flag and
`react`/`react-dom` are deleted; the pure rule modules moved to `renderer/rules/`

Archived 2026-08-06, in `archive.zip`.

### entity-discovery-by-meta-tag

Characters/locations found by front-matter `type:` tag across `characters/`, `locations/`
and `wiki/**`; `EntityDoc` carries the source path so no writer re-derives one;
id/filename agreement and duplicate diagnostics

Archived 2026-08-06, in `archive.zip`.

### portrait-overlay-opt-in

The shot is the whole picture: `portrait_overlay` (default off) → `story.play.json`'s
`portraitOverlay`, so PLAY stops staging a second copy of the speaker over a frame that
already contains them

Archived 2026-08-06, in `archive.zip`.

### task-failure-visibility-and-retry

`Task.error` so a failed task records why, a bounded retry on the next run, a run report
derived from the live plan instead of claiming success over a failure, and in-place
backend retry for transient provider errors

Archived 2026-07-30, in `archive.zip`.

### scene-edit-package

The scene-edit rules and write path now live in `@vn/scriptedit` (pure barrel;
`@vn/scriptedit/write` for the filesystem half), where `vnauthor` can reach them

Archived 2026-07-29, in `archive.zip`.

### script-composition-in-studio

STUDIO's `script` mode — a column that writes, inserts, deletes, reorders and attributes
lines, the confirmed acts that change which scenes exist, clickable diagnostics, and the
end-to-end pass: a scene written in the app, generated, watched in PLAY

Archived 2026-07-28, in `archive.zip`.

### line-editing-in-floor

Retyping a line in the coverage timeline, and `Shot.proseHash` → the drift mark on the
shot it produced

Archived 2026-07-28, in `archive.zip`.

### scene-editing-commands

Nine `story.*` prose commands over `@vn/scriptedit`, `session.editScene`, the storyboard
fallout, `script.moveLine`, and `vnauthor`'s `edit_scene` — one write path for prose, no
UI

Archived 2026-07-28, in `archive.zip`.

### fountain-import-export

`vngen import` / `vngen screenplay`, the desktop pair, and the retirement of `screenplay/`
as an input

Archived 2026-07-28, in `archive.zip`.

### scene-chunk-files

`scenes/<id>.md` replaces the one contended screenplay; `start:` names the entry,
front-matter is identity only, both prose patchers retargeted (`screenplay/` still loaded
when it shipped; plan 4 retired it)

Archived 2026-07-28, in `archive.zip`.

### lossless-scene-serialization

`parse(write(scene)) ≡ scene`; `Scene.body` retired, headings and three line kinds
retained

Archived 2026-07-28, in `archive.zip`.

### allocated-line-ids

Line ids that survive an edit, the diagnostics surface, the catalog-driven palette

Archived 2026-07-28, in `archive.zip`.

### preconditions-and-timeline-interaction

`Command.check`, `stack.check`'s three states, the `timeline.cover` interaction

Archived 2026-07-28, in `archive.zip`.

### interaction-model

`Interaction`/`targets` and the `interaction.*` commands; five gestures declared. Its two
"Next" items shipped in
[`preconditions-and-timeline-interaction`](INDEX.md#preconditions-and-timeline-interaction)

Archived 2026-07-28, in `archive.zip`.

### command-undo-redo

Opt-in undo via shadow snapshots under `refs/vn/undo/<seq>`

Archived 2026-07-27, in `archive.zip`.

### sample-workspace-and-asset-cache

`examples/mySampleRepo` seeding and the recorded asset corpus

Archived 2026-07-26, in `archive.zip`.

### test-fixtures

`@vn/testkit` — real projects on disk run through the real scheduler

Archived 2026-07-25, in `archive.zip`.

### task-dag-view

FLOOR's `graph` mode: barrier nodes, ref edges, ghosts

Archived 2026-07-25, in `archive.zip`.

### story-branch-editor

STUDIO's `branches` mode, `renderer/graph/`, the semantic drag gestures

Archived 2026-07-25, in `archive.zip`.

### shot-timeline-editor

FLOOR's `timeline` mode and `story.setCoverage`

Archived 2026-07-25, in `archive.zip`.

### refine-loop-inspector

The FLOOR inspector's rendering of the P7 generate→critique→refine loop

Archived 2026-07-25, in `archive.zip`.

### desktop-renderer-restructure

One directory per room, pure `.ts` cores with `tests/` siblings, the stylesheet split

Archived 2026-07-25, in `archive.zip`.

### command-system

`@vn/commands`, the DSL, the catalog, provenance, CDP

Archived 2026-07-25, in `archive.zip`.

### 2d-graphics-debug-api

`@vn/debug2d` — fragment IR, DOM adapter, query engine, `explainPick`

Archived 2026-07-25, in `archive.zip`.

### desktop-storage-and-draggable-rail

`.vndesktop/session.json`, `usePanelWidth`, `view.panelSize`.

Archived 2026-07-25, in `archive.zip`.

### runner

`story.play.json`, `@vn/export`, the desktop app and its PLAY room

Archived 2026-07-17, in `archive.zip`.

### authoring-agent-implementation

`vnauthor`: workspace index, tool registry, plan/execute modes, skills, the REPL

Archived 2026-06-15, in `archive.zip`.

### initial-implementation

The monorepo, package layering, phases P1–P7, task graph, store, scheduler, `vngen` CLI

Archived 2026-06-15, in `archive.zip`.

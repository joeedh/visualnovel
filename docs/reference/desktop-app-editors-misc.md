# The desktop app: document and settings editors

<!-- toc -->

- [Wiki](#wiki)
- [Skills](#skills)
- [Documents](#documents)
- [Project](#project)
- [System Prompt](#system-prompt)
- [Setup](#setup)
- [Debug Agent](#debug-agent)

<!-- tocstop -->

Part of [`desktop-app.md`](desktop-app.md) — the remaining editors: Wiki, Skills, Documents (the
sidebar), Project, System Prompt, Setup, and Debug Agent.

## Wiki

`editors/wiki.ts` — one markdown document as text: a story-bible note, a character sheet, a
location sheet, whatever `ui.docPath` names. Read through `doc.read`, saved through `doc.write`,
which is what makes "the author saves it, and saving commits to git" true with no machinery of its
own ([`command-system.md`](command-system.md#the-doc-namespace)).

- **It is not a form over `Character`.** The requirement is that the author edits the markdown, so
  the front-matter sits in the box with the prose and the model's opinion of it arrives afterwards
  on the footer line. A sheet whose fields are half-typed **saves** and says so; only a save that
  would destroy identity — unparseable front-matter, or a dropped `type:` tag — is refused. All
  three rules live in the command, and the editor re-decides none of them.
- **Ctrl+S, never a timer.** Every `doc.write` is undoable, so it snapshots pre and post trees in
  every owned repo and the `Committer` then commits; save-on-blur would spend that on a focus
  change. A dirty badge shows the unsaved state, and the editor stops its own keydown — the screen
  keymap is a bubble-phase window listener, so otherwise Ctrl+Z undoes a command mid-sentence.
- **The buffer is not authoritative.** `doc.read` returns the content hash it read at; `doc.write`
  carries it back as `seenHash` and a file something else rewrote underneath — `gate.approve`, the
  agent, an undo — is refused by **content** with a sentence, never overwritten. A file rewritten
  *identically* is not a conflict, which is why this is not an mtime check.
- **Unsaved text outlives the pane.** Drafts are held per path in a module-level map, so a pane
  that switched editors and came back keeps the edit; `on_remove` cannot veto its own removal, so
  the one remaining way to lose one — quitting — is caught by a `beforeunload` prompt. That guard
  needs main's `will-prevent-unload` listener to be worth anything: a `webContents` with none
  **cancels** the close silently, which is why the window once could not be closed at all.
- **A file rewritten underneath follows, unless it is being typed into.** `bridge.onWrote` reports
  every path a command or an agent tool wrote; a clean buffer re-reads, a dirty one does not, and
  its next save earns the changed-underneath refusal above. `⟳` in the bar is the manual half — it
  re-reads whatever the state, **discarding** an unsaved draft and saying so in the footer, because
  refusing would leave the author with no way back to what is on disk.
- **It does not read through `@vn/bible`.** That interface has no whole-file call and the absence
  *is* the guarantee ([`story-bible.md`](story-bible.md)); a human reading their own note on screen
  is not the agent's context window.
- **Under the text: what was drawn *from* this document.** The same `renderAssetStrip` the Documents
  panel uses, over `backlinks[pathIndex[docPath]]` — so the pane needs no convention of its own for
  turning the one thing it knows into a key. It follows `bridge.onInvalidate` rather than `onWrote`,
  because generating a portrait while a character sheet is open should make the portrait appear and
  generating is not a write to *this* file. It is bounded and never flexible: the document is what
  the pane is for. A page that is nothing's subject — a lore note, a `README.md` — gets the sentence
  saying so, which is the feature; **which** notes merely *mention* the subject is `bible.search`,
  ranked and budgeted, and is deliberately a different question.

## Skills

`editors/skills.ts` — the playbooks under `.aiagent/skills`, as the files inside them beside the one
being edited. It is the pane that shows what is **in** a skill: the document tree carries identity,
one row per skill ([`document-tree.md`](document-tree.md)), and the content is here.

- **The text half is `DocBuffer`, the same module Wiki's is** (`pathux/docbuffer.ts`). Every rule in
  the Wiki bullets above — the `seenHash` refusal, the draft that outlives the pane, the
  `beforeunload` guard, `⟳` discarding and saying so, a clean buffer following a write it did not
  make — is that module's and holds here unchanged. What this pane owns is the tree beside it, its
  expansion, and the hint. A skill file is tracked (`.aiagent` is not in `DEFAULT_IGNORES`), so
  Ctrl+S commits like any other document.
- **The hint is the feature, not decoration.** A skill is the one thing in the app the **agent** can
  author, and nothing else on screen says so. The sentence and its button therefore sit above the
  tree and are drawn whether or not any skill exists — an empty pane is exactly when they are
  needed, and every project created in the app starts with no `.aiagent/` at all.
- **The button opens the agent *form*, not a turn.** `openCommandDialog('agent.run', { input })`
  with a first sentence that ends mid-clause (`… It should: `), so the author finishes it before
  anything runs. `agent.run` is mutating and plan-first, so what comes back first is a proposed
  plan they still approve — which is why the tooltip promises the form rather than a file.
- **Its own channel, not a filter over the file tree.** `workspace:skilltree` walks
  `.aiagent/skills` alone: the file tree is capped across the whole project, so on a large one the
  skills could be truncated away and this pane would draw nothing with no way to say why. No skills
  directory at all is `[]`, and the tree says "No skills yet." over the hint that fixes it.
- **Two watchers, both disposed on remove.** `onWrote` for the file in the box — `create_skill` and
  `edit_skill` from Convo, `doc.create kind='skill'` from the tree, an undo — and `onInvalidate` for
  the tree beside it, because a *new* skill changes the tree without touching the open file at all.
  The agent's writes are not commands, so `onInvalidate` is what covers them; it is why `edit_skill`
  returns its written paths.
- **It follows `ui.docPath` only under `.aiagent/skills/`.** One selection serves every pane, so a
  wiki note picked elsewhere must not blank this one. Its own tree clicks publish `ui.docPath` like
  any other pane, which is also how a skill clicked in the document tree lands here.
- **No asset strip, deliberately.** Every binding in the manifest names a character, a location, a
  scene or a shot — nothing binds to a skill file and nothing ever will — so `renderAssetStrip` here
  would be permanently empty, which is worse than absent.
- **It remembers no fields.** Its subject is the shared selection and its expansion is a view of a
  tree the next workspace may not have, so `registerEditor(SkillsEditor, 'vn.SkillsEditor')` takes
  no field list.

## Documents

`editors/documents.ts` — the sidebar, as a pane rather than as fixed chrome, so it can be torn out,
put on either side, or opened twice. The shape it draws is built in main
([`document-tree.md`](document-tree.md)); the rules on top of it — flatten to rows, toggle, which
selection field a node names, which entity the panel is about — are pure in `pathux/doctree.ts`
with tests beside them.

- **Two trees, one flattener.** Document mode draws `workspace:doctree` — Story → scenes → shots,
  Characters, Locations, Wiki, Assets by kind; file mode draws `workspace:filetree`, every file on
  disk. A file tree is a different **source**, not a different kind of tree, so the header toggle
  buys a second fetch and no second renderer. The mode is a per-pane field declared through
  `registerEditor(cls, name, fields)`, so two sidebars can differ and each remembers its own.
- **It owns no selection.** A click publishes `ui.sceneId` / `ui.shotId` / `ui.characterId` /
  `ui.docPath` / `ui.assetHash`, which every other editor already observes — so the tree steers the app without
  knowing what is open, and a scene picked in Branches lights here without either editor knowing
  the other exists. A node that names nothing (a grouping, a truncated `more`) returns the very
  same selection, so opening a branch never costs the author their place.
- **Backlinks under the tree**, from `DocTree.backlinks[nodeId]`: the sheet (said as "in the story
  bible" when it lives under `wiki/`), the art as a `renderAssetStrip` grouped by kind with the
  gate's accepted mark, and the scenes and shots the entity is in. Every row navigates — a scene row
  publishes the selection, the sheet row opens Wiki on it, a thumbnail routes to Asset through the
  same rule a tree click uses. It is here rather than in the Inspector because the Inspector's
  subject is `ui.taskHash`, machine identity on a different axis.
- **Clicking a node shows the editor that answers for it**, and which one is a table lookup rather
  than a score. Each entry in `src/shared/editors.ts` declares a `claims` predicate over the node —
  `primary` or `secondary` or nothing — and `pathux/route.ts` ranks the claimants by **visibility
  first, tier second**, breaking a tie on `EDITORS` order. The consequence is deliberate: a visible
  *secondary* beats a hidden *primary*, so clicking a scene with Shot Coverage open and Script
  closed lands in Shot Coverage, which is where the author is already looking.

  | node | primary | secondary |
  | --- | --- | --- |
  | `scene` | Script | Branches, Shot Coverage |
  | `shot` | Shot Coverage | — |
  | `character`, `location` | Wiki — *only if the entity has a sheet* | — |
  | `wiki` | Wiki | — |
  | `skill` | Skills | — |
  | `file` | Skills under `.aiagent/skills/`, else Wiki when the path reads as text | — |
  | `asset` | Asset | — |
  | `branch`, `assetkind`, `wikidir`, `dir`, `more` | — | — |

  The `file` row is the one place two editors claim the same node as `primary`: a `SKILL.md` is
  text, so Wiki claims it too. The tie breaks on `EDITORS` order, and the `skills` entry is listed
  **before** `wiki` for it — a skill opened in a plain text box would let an author edit the
  front-matter the Skills pane answers for. Visibility still outranks that, and correctly so: with
  Wiki up and Skills closed the click lands in Wiki, where the author is looking.

  A claim is a predicate over the **node**, not a map from its kind, for two reasons the table
  shows: an entity with no sheet has nothing for Wiki to open, and in file mode a `.png` is a
  `file` like any other — pointing Wiki at one would have it `doc.read` a binary. The Inspector
  claims nothing on purpose: its subject is `ui.taskHash`, and no tree node names a task.
  A winner already up is asked for `here` (a focus); one that is not gets `elsewhere`, which is
  what keeps the sidebar from replacing itself with the thing it named. Selection is published
  **before** the open, always — a shot needs two fields to name it and `view.open` carries one
  string, so an editor whose subject cannot travel opens on the selection it already sees.
  A node that claims nothing keeps today's behaviour: the click selects, and a grouping expands.
- **New… scaffolds a document and opens it.** Kind plus a name — character, location, page or
  skill — straight into `doc.create`, which shares `newCharacterTemplate`/`newLocationDoc`/
  `newSkillTemplate` with the agent's create tools — one authorial act, one answer. A character's is a **full sheet of placeholders**, because the shape is best learned by
  editing it; its `palette` is empty under a YAML comment saying what a palette is and to ask the
  agent for one, since a colour name will not parse and so cannot be exampled. That comment is why
  the template is text rather than a `FrontMatterDoc`, and why it does not survive the first edit.
  The tree refetches on any successful mutating command (`onExec`) and on undo, so the new
  file is there without a remount. That refetch is deliberately coarse: a tree is one cached
  `loadProject` away, and a stale tree is worse than a redundant fetch.

## Project

`editors/project.ts` — `project.yaml` as the run reads it, and the twelfth editor. It is a
**singleton pane**: a workspace has one config, so it has no subject, is absent from `SUBJECT_OF`,
and `view.open(editor=project)` carries nothing. It is where an asset's style clause leads: the
`⇱` on that chunk in the Asset pane opens this editor `elsewhere` and scrolls to the field.

- **One field is editable and the rest are shown.** The art style is the sentence every image prompt
  opens with, so it is the setting an author reaches for repeatedly; the model ids and the image
  params are read-only here because changing one is a deliberate, file-level act and a pane that
  made it a two-click affair would invite it.
- **Applying is `project.setArtStyle`**, which confirms — it re-keys **every** image task — and says
  how many before it writes. `withArtStyle` splices the line into `project.yaml` rather than
  re-serializing it, and it is not quite `withStartScene`: prose may already be a block scalar, so
  the entry it replaces is the header line plus the indented lines under it, and a trailing blank
  line belongs to the entry only when indented text follows it. Comments, key order and the author's
  own quoting survive, and undo restores the file byte-for-byte.
- **It reads through `project.info`, not a bespoke channel.** Every other editor reads through a
  non-mutating command; a twelfth IPC channel for the twelfth editor would have been the first
  surface in the app reaching around the registry. `project.info` deliberately omits the `keys`
  block: those are env-var *names* and safe to print, but a settings pane listing them is one
  screenshot away from looking like it lists their values.

## System Prompt

`editors/systemprompt.ts` — the system message the agent's next turn will carry, in its sections.
The pane an author opens when a turn misbehaves and the question is "what did it actually read?".

- **Named but not listed** (`offered: false`,
  [`desktop-app-shell.md#the-shell`](desktop-app-shell.md#the-shell)). It is somewhere to look, not
  somewhere to work, so it is reached by name: `view.open(editor='systemprompt')` from the command
  palette. A saved layout that holds it still restores it.
- **It asks main for the prompt rather than reassembling it.** `agent:system` answers with
  `systemSections(await loadContext(dir))`, the section list, the context files that fed it and the
  bound model id. That is the whole point of the pane: `runAgent` calls
  `refreshSystem(systemSections(await loadContext(...)))` before every turn, so what is on screen
  is the assembly that ships. A second implementation in the renderer could disagree with the one
  that runs, and would be wrong in exactly the case being investigated. It answers before an agent
  exists, too — the prompt is a property of the workspace, not of a conversation.
- **The sections are the sections.** Built-in, then the generated `PROJECT MAP`, then the author's
  `PROJECT CONTEXT (AICONTEXT.md)` — drawn one card each, in order, with the authored one warm,
  because it is the one part a reader can go and change. `Copy` puts the **join** on the clipboard,
  not the card under the cursor: what the model receives is one string.
- **The separator is written twice, and a test keeps the two equal.** `renderer/rules/
  systemprompt.ts` is in the browser bundle and `@vn/authoring` is node-side, so `joined` restates
  `joinSections`'s `

`; its test asserts the two against each other. The scale line
  (`N sections · N lines · N chars · ~N tokens · model`) counts the join rather than the sum of the
  parts, which would be short by one separator per section, and the token figure says `~` because
  it is characters over four.
- **It follows invalidation like every other pane.** Two of the three sections are files in the
  workspace and `update_context` rewrites one of them mid-conversation, so the pane re-reads rather
  than showing whatever was true when it was opened; `⟳` is there for a file that moved underneath.
  A slow read that lands after a newer one is dropped by a rising token.

## Setup

`editors/onboarding.ts` — the answer to "I installed this, now what".
It is the one pane an author is expected to visit once: how to get a key from each provider, which
of theirs are set, and a box to paste one into. It is a **singleton** like Project, and it is
`offered: false` ([`desktop-app-shell.md#the-shell`](desktop-app-shell.md#the-shell)), so it is
named but not browsable and it claims no document-tree node — no node names an API key, and a click
that opened this pane would have landed on a subject it knows nothing about.

- **The walkthrough is [`../guides/api-keys.md`](../guides/api-keys.md), rendered — not retyped.**
  `app.keyGuide` reads that one file through `main/resources.ts`, which tries `$VN_RESOURCES`,
  then Electron's `process.resourcesPath` (where `extraResources` puts it in a packaged build),
  then the repo root — so
  the same command answers from a checkout and from an installed app, and the pane cannot drift
  from the doc because there is nothing to drift from. `shared/markdown.ts` parses the subset the
  file uses (headings, paragraphs, lists, tables, fenced code, and inline `code`/**strong**/links)
  and `shared/apikeys.ts` projects it into a `KeyGuide`: an intro, one section per vendor keyed by
  its heading slug, and the remaining sections as notes. `keyGuideProblems` names what a section is
  missing rather than throwing, so a doc edited badly degrades to a pane that says so.
- **A vendor's metadata is a yaml fence in its own section** — the env var name, whether there is a
  free tier, and the console/docs/billing URLs. That is what makes the file both readable prose and
  the pane's data source; there is no second table to keep in step with it.
- **The renderer never hands the OS a URL.** `app.openKeyLink(provider, link)` names a *field* —
  `GUIDE_URL_FIELDS` is `console | docs | billing`, the entire set of pages this app will ever
  open — and main looks the address up in the guide it shipped with. So the pane cannot be talked
  into opening an address it was handed, and inline prose links render as a non-navigating
  `span.ob-link` with the address in the tooltip, because there is no navigation inside a shadow
  root either way. A field the guide leaves empty greys its button with that as the reason.
- **Status is `project.keyStatus`, which never says the key.** Per vendor: whether one resolved and
  **which of the four rungs answered**, by name — an environment variable, this project's `keys/`,
  the enclosing repo's, or the user-level one. A set environment variable shadowing a file that was
  just written gets its own warning line, because "I pasted it and nothing changed" is otherwise
  unanswerable.
- **The paste box is `project.setKey` with a scope**, defaulting to **every project** — the answer
  that is right the second time. The input is `type="password"`, stops its own keydown so `/` does
  not open the palette, and is cleared whatever the answer; the value reaches one file and nowhere
  else, and the command history records `<secret>`. A line under the box names the file it will be
  written to before it is written.
- **Test key is `project.testKey`**, one small real call, because a key can resolve and still be
  revoked, mistyped, or on an account with no credit — and without it the first news of that is a
  run failing much later. It is a non-mutator that declares a `check` anyway, so the greyed button
  shows its own refusal verbatim: mock mode makes no calls, or no key resolves yet.
- **Every control carries a tooltip and every disabled one carries its command's refusal.** Both
  buttons and the Save button read `check(...)` rather than deciding for themselves, so the pane
  cannot invent a sentence the command would not have said.
- **It is reached from File ▸ Set Up API Keys…**, which opens the pane `elsewhere` rather than
  `project.setKey`'s bare form: a box asking for a credential is no use to someone who does not
  have one yet, and the pane is that box with the steps above it. The form is still in the palette
  for anyone who only wants it. On a **first run** with a key missing, `noticeMissingKeys` posts one
  durable notification linking here — skipped under `--mock`, which calls no provider, and posted
  at most once per project, guarded by scanning the log for an existing notification pointing at
  this editor, since the notification log dedupes by id rather than by message.

## Debug Agent

`editors/report.ts` — a conversation with the agent that reads a conversation that went wrong. It
is a **popup** pane (`view.open(editor='report' where='popup')`) and `offered: false`
([`desktop-app-shell.md#the-shell`](desktop-app-shell.md#the-shell)), so it is named but not
browsable and claims no document-tree node: its subject is a thread rather than a document. What
the analyst may read, what it redacts and where the report is archived are in
[`agent-report.md`](agent-report.md); what follows is the pane.

- **Help ▸ Report a Difficult Agent… opens the pane; the pane starts the analysis.** The menu entry
  calls `seedReport`, which fills the setup card in and raises the popup. The card is the form the
  command dialog used to collect — thread, model, effort, and the two reading boxes — with a Start
  button that invokes `report.open`. The API-fault card (`bridge.ts`) calls the same helper with
  both boxes ticked and its note, so both entry points land on the same card. Once started, the card
  collapses to a line saying what was chosen.
- **A turn is bounded and the conversation is not.** Each message runs under the same per-turn token
  ceiling and step cap a headless analysis uses. There is deliberately no conversation-wide ceiling:
  the author is at the keyboard, Stop is the bound, and the spend is on their own key.
- **Stop is cooperative and the button says so** — *"The turn ends after the step it is on."* No
  backend streams, so a stop lands after the request in flight returns. `report.stop` is the one
  command accepted mid-turn; `report.say` refuses with "The analyst is still answering", which the
  send button shows as its refusal.
- **`submit_report` is a card in the transcript, not the end of anything.** The conversation stays
  open, so "you did not mention that it ignored the outfit marker" produces a revised report and a
  second card; the earlier card stays, showing what it said. The card carries the review-and-file
  buttons and the warning that the issue body has to be pasted.
- **Both accesses can be granted part way through**, through `report.grant`. `run` builds its tool
  catalog once per turn, so a grant made during one lands on the next, and the box's tooltip says
  so. Granting is one-way: tools already used cannot be un-remembered from the transcript, so a
  ticked box is disabled with that as its reason. Each box is refused by name when there is nothing
  to grant — no source shipped with the build, or nothing was sent to a model API this session. The
  decision is `grantBox` in `renderer/rules/`, tested by jest, because a mock workspace refuses to
  open a conversation at all.
- **Turn events ride `report:event`, not `agent:event`.** Putting the analyst on the authoring
  agent's channel would write the debug agent's turns into the thread being analysed, corrupting the
  evidence for the next report of the same thread. A pane that mounts mid-conversation catches up by
  asking `report.state` and reducing the rows it returns through the same reducer
  (`renderer/pathux/agent/reportconvo.ts`) that reduces live events.
- **A report turn is busy work; an idle conversation is not.** Each turn is wrapped in
  `while('an agent report', …)` rather than the conversation, so the in-flight set is empty between
  turns and an authoring turn started while the pane sits open is still stoppable. The header's
  spinner and Stop come from `busyControls` (`renderer/rules/busy.ts`), a table keyed by busy kind;
  an authoring turn is deliberately absent from it, because the Convo editor owns that button.
- **The conversation is written down, ten deep**, at `<userConfigDir>/debug-transcripts/` — user-level
  state, outside every repository. A new conversation prunes the oldest as it starts rather than as
  it ends, so a crashed run cannot leave an eleventh, and names are ISO stamps so name order is time
  order. One JSON object per line, each carrying its own version, so an unknown line is skipped
  rather than failing the read. A line comes from the same reducer the pane draws with, and
  `FeedItem.detail` is dropped there and nowhere else: that is where a tool's result lives, and the
  request captures in particular are the author's own traffic.

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

This page is part of [`desktop-app.md`](desktop-app.md) and covers the remaining editors: Wiki, Skills, Documents (the sidebar), Project, System Prompt, Setup, and Debug
Agent.

## Wiki

`editors/wiki.ts` edits one markdown document as text (a story-bible note, a character sheet, a location sheet, whatever `ui.docPath` names). It reads through `doc.read`
and saves through `doc.write`, so the author saves it and saving commits to git, with no machinery of its own ([`command-system.md`](command-system.md#the-doc-namespace)).

- **It is not a form over `Character`.** The requirement is that the author edits the markdown, so the front-matter sits in the same box as the prose and the model's
  assessment of it appears afterwards on the footer line. The editor saves a sheet whose fields are half-typed and says so. It refuses only a save that would destroy
  identity (unparseable front-matter, or a dropped `type:` tag). All three rules live in the command, and the editor does not re-decide them.
- **Ctrl+S, never a timer.** Every `doc.write` is undoable, so each write snapshots pre and post trees in every owned repo and the `Committer` then commits; save-on-blur
  would repeat that work on every focus change. A dirty badge shows the unsaved state, and the editor stops propagation of its own keydown events, because the screen
  keymap is a bubble-phase window listener and would otherwise let Ctrl+Z undo a command mid-sentence.
- **The buffer is not authoritative.** `doc.read` returns the content hash it read at, and `doc.write` carries that hash back as `seenHash`. If something else rewrote
  the file underneath (`gate.approve`, the agent, an undo), the write is refused with a sentence rather than overwriting the file. The refusal compares content, so a file
  rewritten to identical content is not a conflict, which is why this is not an mtime check.
- **Unsaved text is kept when a pane changes editors.** Drafts are held per path in a module-level map, so a pane that switched editors and came back keeps the edit.
  `on_remove` cannot veto its own removal, so quitting is the one remaining way to lose a draft, and a `beforeunload` prompt catches it. That prompt works only if main
  listens for `will-prevent-unload`: a `webContents` with no such listener cancels the close silently, which is why the window once could not be closed at all.
- **A file rewritten on disk is re-read, unless the buffer has unsaved edits.** `bridge.onWrote` reports every path a command or an agent tool wrote. A clean buffer
  re-reads the file; a dirty buffer does not, and its next save gets the changed-underneath refusal above. `⟳` in the bar re-reads the file whatever the buffer's state. It
  discards an unsaved draft and says so in the footer, because refusing would leave the author with no way back to what is on disk.
- **It does not read through `@vn/bible`.** That interface has no whole-file call, and the guarantee follows from that absence ([`story-bible.md`](story-bible.md)). A
  human reading their own note on screen does not put it into the agent's context window.
- **Assets generated from this document, shown under the text.** The pane calls the same `renderAssetStrip` the Documents panel uses, over
  `backlinks[pathIndex[docPath]]`, so it needs no convention of its own for turning the document path it holds into a key. It follows `bridge.onInvalidate` rather than
  `onWrote`, because generating a portrait while a character sheet is open should make the portrait appear, and generating is not a write to this file. The strip is
  bounded and never flexible, because the pane exists to show one document. A page that is the subject of nothing (a lore note, a `README.md`) gets a sentence saying so,
  and that is the feature. `bible.search` answers which notes merely mention the subject, ranked and budgeted, and that is deliberately a different question.

## Skills

`editors/skills.ts` — edits the playbooks under `.aiagent/skills`, showing the files inside a skill beside the one being edited. This pane shows what a skill contains. The
document tree identifies skills, one row per skill ([`document-tree.md`](document-tree.md)), and the content is here.

- The text half uses `DocBuffer` (`pathux/docbuffer.ts`), the same module Wiki uses. Every rule in the Wiki bullets above belongs to that module and holds here
  unchanged: the `seenHash` refusal, the draft that outlives the pane, the `beforeunload` guard, `⟳` discarding and saying so, and a clean buffer after a write the buffer
  did not make. This pane owns the tree beside it, its expansion, and the hint. A skill file is tracked (`.aiagent` is not in `DEFAULT_IGNORES`), so Ctrl+S commits like
  any other document.
- **Keep the hint; it is not decoration.** A skill is the one thing in the app the agent can author, and nothing else on screen says so. The sentence and its button
  therefore sit above the tree and are drawn whether or not any skill exists. They are needed when the pane is empty, and every project created in the app starts with no
  `.aiagent/` at all.
- **The button opens the agent form and does not start a turn.** It calls `openCommandDialog('agent.run', { input })` with a first sentence that ends mid-clause (`… It
  should: `), so the author finishes that sentence before anything runs. `agent.run` is mutating and plan-first, so it returns a proposed plan the author still approves.
  The tooltip therefore describes the form rather than a file.
- **Has its own channel rather than filtering the file tree.** `workspace:skilltree` walks `.aiagent/skills` on its own. The file tree is capped across the whole
  project, so on a large project the skills could be truncated away and this pane would draw nothing without reporting why. If there is no skills directory at all, the
  channel returns `[]`, and the tree displays "No skills yet." above the hint that fixes it.
- **Two watchers, both disposed on remove.** `onWrote` covers the file in the box, which is written by `create_skill` and `edit_skill` from Convo, by `doc.create
  kind='skill'` from the tree, and by an undo. `onInvalidate` covers the tree beside it, because creating a skill changes the tree without touching the open file. The
  agent's writes are not commands, so `onInvalidate` is what covers them, and covering them is why `edit_skill` returns its written paths.
- **It follows `ui.docPath` only under `.aiagent/skills/`.** One selection serves every pane, so a wiki note picked in another pane must not clear the skill shown here.
  Clicks in its own tree publish `ui.docPath` like any other pane, and a skill clicked in the document tree opens in this pane by the same route.
- **The asset strip is omitted deliberately.** Every binding in the manifest names a character, a location, a scene or a shot, nothing binds to a skill file, and nothing
  ever will, so `renderAssetStrip` here would be permanently empty. An empty strip is worse than an absent one.
- **Stores no fields.** The subject is the shared selection, and the expansion is a view of a tree that the next workspace may not have, so `registerEditor(SkillsEditor,
  'vn.SkillsEditor')` takes no field list.

## Documents

`editors/documents.ts` draws the sidebar as a pane rather than as fixed chrome, so it can be torn out, put on either side, or opened twice. Main builds the shape it draws
([`document-tree.md`](document-tree.md)). `pathux/doctree.ts` holds the "pure" (side-effect-free) rules on top of that shape, with tests beside them: flattening to rows,
toggling, which selection field a node names, and which entity the panel is about.

- **Both trees use one flattener.** Document mode draws `workspace:doctree` — Story → scenes → shots, Characters, Locations, Wiki, and Assets by kind. File mode draws
  `workspace:filetree`, every file on disk. A file tree is a different source, not a different kind of tree, so the header toggle adds a second fetch and no second
  renderer. The mode is a per-pane field declared through `registerEditor(cls, name, fields)`, so two sidebars can differ and each keeps its own mode.
- **The tree owns no selection.** A click publishes `ui.sceneId` / `ui.shotId` / `ui.characterId` / `ui.docPath` / `ui.assetHash`, which every other editor already
  observes, so the tree steers the app without tracking what is open, and a scene picked in Branches is highlighted here without either editor referencing the other. A
  node that names nothing (a grouping, a truncated `more`) returns the same selection, so opening a branch leaves the author's current selection unchanged.
- **Backlinks under the tree** come from `DocTree.backlinks[nodeId]`. They cover the sheet, said as "in the story bible" when it lives under `wiki/`; the art, which
  `renderAssetStrip` renders grouped by kind with the gate's accepted mark; and the scenes and shots the entity is in. Every row navigates: a scene row publishes the
  selection, the sheet row opens Wiki on it, and a thumbnail routes to Asset through the same rule a tree click uses. The backlinks sit here rather than in the Inspector
  because the Inspector's subject is `ui.taskHash`, which is a machine identity on a different axis.
- **Clicking a node opens the editor that answers for it.** A table lookup picks that editor rather than a score. Each entry in `src/shared/editors.ts` declares a
  `claims` predicate over the node that returns `primary`, `secondary`, or nothing, and `pathux/route.ts` ranks the claimants by visibility first and tier second, breaking
  a tie on `EDITORS` order. This ordering is deliberate: a visible secondary editor beats a hidden primary one, so clicking a scene with Shot Coverage open and Script
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

  The `file` row is the one place where two editors claim the same node as `primary`. A `SKILL.md` is text, so Wiki claims it too. The tie breaks on `EDITORS` order, which
  lists the `skills` entry before `wiki` for the `file` row, because a skill opened in a plain text box would let an author edit the front-matter the Skills pane answers
  for. Visibility still outranks that order, and that is the right outcome. With Wiki up and Skills closed, the click lands in Wiki, where the author is looking.

  A claim is a predicate over the node rather than a map from the node's kind, for two reasons the table shows. An entity with no sheet gives Wiki nothing to open, and in
  file mode a `.png` is a `file` like any other, so pointing Wiki at one would make it `doc.read` a binary. The Inspector claims nothing on purpose: its subject is
  `ui.taskHash`, and no tree node names a task. A winner that is already up is asked for `here` (a focus). A winner that is not already up is asked for `elsewhere`, which
  keeps the sidebar from replacing itself with the thing it named. Selection is always published before the open. A shot needs two fields to name it and `view.open`
  carries one string, so an editor whose subject cannot travel opens on the selection it already sees. A node that claims nothing keeps today's behaviour: the click
  selects, and a grouping expands.
- **New… scaffolds a document and opens it.** The command takes a kind — character, location, page or skill — and a name, and passes both to `doc.create`, which shares
  `newCharacterTemplate`/`newLocationDoc`/`newSkillTemplate` with the agent's create tools. The character template is a full sheet of placeholders, because the shape is
  best learned by editing it. Its `palette` is empty under a YAML comment that says what a palette is and asks the agent for one, since a colour name will not parse and so
  cannot be shown as an example. That comment is why the template is text rather than a `FrontMatterDoc`, and why it does not survive the first edit. The tree refetches on
  any successful mutating command (`onExec`) and on undo, so the new file is there without a remount. That refetch is deliberately coarse: a tree is one cached
  `loadProject` away, and a stale tree is worse than a redundant fetch.

## Project

`editors/project.ts` — The twelfth editor, over `project.yaml` as the run reads it. It is a singleton pane: a workspace has one config, so the pane has no subject, is
absent from `SUBJECT_OF`, and `view.open(editor=project)` carries nothing. The `⇱` on an asset's style clause in the Asset pane opens this editor `elsewhere` and scrolls
to the field.

- **One field is editable and the rest are shown.** Every image prompt opens with the art style sentence, so an author changes that setting often. The model ids and the
  image params are read-only here because changing one is a deliberate, file-level act, and making that change a two-click operation in this pane would encourage it.
- **Applying.** `project.setArtStyle` confirms before it writes, and the confirmation says how many image tasks it will re-key, since it re-keys all of them.
  `withArtStyle` splices the line into `project.yaml` rather than re-serializing it, and it differs from `withStartScene`: prose may already be a block scalar, so the
  entry it replaces is the header line plus the indented lines under it, and a trailing blank line belongs to the entry only when indented text follows it. Comments, key
  order and the author's own quoting are preserved, and undo restores the file byte-for-byte.
- **Reads through `project.info`, not a bespoke channel.** Every other editor reads through a non-mutating command, and a twelfth IPC channel for the twelfth editor
  would have been the first surface in the app to reach around the registry. `project.info` deliberately omits the `keys` block. Those entries are the names of env vars
  rather than their values, so they are safe to print, but a screenshot of a settings pane listing them would look like it lists the values.

## System Prompt

`editors/systemprompt.ts` displays the system message the agent's next turn will carry, broken into its sections. An author opens this pane when a turn misbehaves and
needs to see what that turn actually read.

- **Named but not listed** (`offered: false`, [`desktop-app-shell.md#the-shell`](desktop-app-shell.md#the-shell)). It is for reading rather than for working in, so a
  user opens it by name with `view.open(editor='systemprompt')` from the command palette. A saved layout that holds this editor still restores it.
- **The pane asks main for the prompt rather than reassembling it.** `agent:system` answers with `systemSections(await loadContext(dir))`, the section list, the context
  files that fed it and the bound model id. The pane exists to show that assembly. `runAgent` calls `refreshSystem(systemSections(await loadContext(...)))` before every
  turn, so the pane shows the assembly that ships. A second implementation in the renderer could disagree with the one that runs, and would be wrong in exactly the case
  being investigated. `agent:system` also answers before an agent exists, because the prompt is a property of the workspace rather than of a conversation.
- **Section order.** The built-in section comes first, then the generated `PROJECT MAP`, then the author's `PROJECT CONTEXT (AICONTEXT.md)`. Each is drawn as one card,
  in that order, and the authored card is warm because it is the one part a reader can change. `Copy` puts the joined text on the clipboard, not the card under the cursor.
  The model receives one string.
- **The separator is written twice, and a test asserts that the two match.** `renderer/rules/ systemprompt.ts` is in the browser bundle and `@vn/authoring` is node-side,
  so `joined` restates `joinSections`'s `

`; its test asserts the two against each other. The scale line (`N sections · N lines · N chars · ~N tokens · model`) counts the join rather than the sum of the parts,
  which would be short by one separator per section. The token figure is marked `~` because it is characters divided by four.
- **The pane follows invalidation like every other pane.** Two of the three sections are files in the workspace, and `update_context` rewrites one of them
  mid-conversation, so the pane re-reads the files rather than showing what was true when it was opened. `⟳` is provided for a file that moved underneath. A rising token
  drops a slow read that lands after a newer one.

## Setup

`editors/onboarding.ts` tells an author what to do after installing. It is the one pane an author is expected to visit once. It shows how to get a key from each provider,
which of the author's keys are set, and a box to paste one into. It is a singleton like Project, and it is `offered: false`
([`desktop-app-shell.md#the-shell`](desktop-app-shell.md#the-shell)), so it is named but not browsable and it claims no document-tree node. No node names an API key, and a
click that opened this pane would have landed on a subject the pane does not cover.

- **The pane renders [`../guides/api-keys.md`](../guides/api-keys.md) rather than restating it.** `app.keyGuide` reads that one file through `main/resources.ts`, which
  tries `$VN_RESOURCES`, then Electron's `process.resourcesPath` (where `extraResources` puts it in a packaged build), then the repo root. The same command therefore
  answers from a checkout and from an installed app, and the pane displays the doc itself, so the two cannot diverge. `shared/markdown.ts` parses the subset the file uses
  (headings, paragraphs, lists, tables, fenced code, and inline `code`/**strong**/links), and `shared/apikeys.ts` converts the result into a `KeyGuide` holding an intro,
  one section per vendor keyed by its heading slug, and the remaining sections as notes. `keyGuideProblems` names what a section is missing rather than throwing, so a
  badly edited doc produces a pane that reports the problem.
- **Each vendor's section carries a yaml fence** holding the env var name, whether there is a free tier, and the console/docs/billing URLs. The fence makes the file both
  readable prose and the pane's data source, so there is no second table to keep in step with it.
- **The renderer never hands the OS a URL.** `app.openKeyLink(provider, link)` names a field, and `GUIDE_URL_FIELDS` is `console | docs | billing`, the entire set of
  pages this app will ever open. Main looks the address up in the guide it shipped with. The pane therefore cannot open an address it was handed, and inline prose links
  render as a non-navigating `span.ob-link` with the address in the tooltip, because nothing inside a shadow root navigates either way. A field the guide leaves empty
  greys its button and states that as the reason.
- **Status is `project.keyStatus`, which never reports the key.** For each vendor it reports whether a key resolved and which of the four rungs answered, by name: an
  environment variable, this project's `keys/`, the enclosing repo's `keys/`, or the user-level one. An environment variable that is set and shadows a file just written
  gets its own warning line, so that a user who pasted a key and saw no change can tell why.
- The paste box calls `project.setKey` with a scope, which defaults to every project. The input is `type="password"` and stops its own keydown so that `/` does not open
  the palette, and it is cleared whatever the answer. The value is written to one file and nowhere else, and the command history records `<secret>`. A line under the box
  names the file it will be written to before it is written.
- **Test key is `project.testKey`.** It makes one small real call, because a key can resolve and still be revoked, mistyped, or on an account with no credit, and without
  that call the first report of the bad key comes from a run that fails much later. It is a non-mutator that declares a `check` anyway, so the greyed button shows its own
  refusal verbatim. The refusal states that mock mode makes no calls, or that no key resolves yet.
- **Every control has a tooltip, and a disabled control shows its command's refusal text.** Both buttons and the Save button call `check(...)` instead of computing a
  reason themselves, so the pane shows only the text the command returned.
- File ▸ Set Up API Keys… opens the pane `elsewhere` rather than `project.setKey`'s bare form. A form asking for a credential is no use to someone who does not have one
  yet, and the pane puts the steps for getting one above that form. The bare form is still in the palette for anyone who only wants it. On a first run with a key missing,
  `noticeMissingKeys` posts one durable notification linking here. It is skipped under `--mock`, which calls no provider, and posted at most once per project, guarded by
  scanning the log for an existing notification pointing at this editor, since the notification log dedupes by id rather than by message.

## Debug Agent

`editors/report.ts` holds a conversation with the agent that reads a conversation that went wrong. The pane opens as a popup (`view.open(editor='report' where='popup')`)
with `offered: false` ([`desktop-app-shell.md#the-shell`](desktop-app-shell.md#the-shell)), so it is named but not browsable and claims no document-tree node, because its
subject is a thread rather than a document. What the analyst may read, what it redacts and where the report is archived are in [`agent-report.md`](agent-report.md). This
page covers the pane.

- **Help ▸ Report a Difficult Agent… opens the pane, and the pane starts the analysis.** The menu entry calls `seedReport`, which fills in the setup card and raises the
  popup. The card collects the same fields the command dialog collected (thread, model, effort, and the two reading boxes) and carries a Start button that invokes
  `report.open`. The API-fault card (`bridge.ts`) calls the same helper with both boxes ticked and its note, so both entry points land on the same card. Once started, the
  card collapses to a line showing what was chosen.
- **A turn is bounded and the conversation is not.** Each message runs under the same per-turn token ceiling and step cap a headless analysis uses. There is deliberately
  no conversation-wide ceiling, because the author is at the keyboard, ends the run by pressing Stop, and covers the spend on their own key.
- **Stopping is cooperative** — the button is labelled "The turn ends after the step it is on." No backend streams, so a stop takes effect after the request in flight
  returns. `report.stop` is the one command accepted mid-turn. `report.say` refuses with "The analyst is still answering", and the send button shows that refusal.
- **`submit_report` renders a card in the transcript and does not close the conversation.** A follow-up such as "you did not mention that it ignored the outfit marker"
  produces a revised report and a second card, and the first card remains with its original text. A `submit_report` card carries the review-and-file buttons and the
  warning that the issue body has to be pasted.
- Both accesses can be granted part way through, through `report.grant`. `run` builds its tool catalog once per turn, so a grant made during one turn takes effect on the
  next turn, and the box's tooltip states this. Granting is one-way, because tools already used cannot be removed from the transcript, so a ticked box is disabled and
  gives that as the reason. Each box is refused by name when there is nothing to grant, either because no source shipped with the build or because nothing was sent to a
  model API this session. `grantBox` in `renderer/rules/` makes the decision, and jest tests it, because a mock workspace refuses to open a conversation at all.
- **Turn events are published on `report:event`, not `agent:event`.** Putting the analyst on the authoring agent's channel would write the debug agent's turns into the
  thread being analysed, corrupting the evidence for the next report of the same thread. A pane that mounts mid-conversation catches up by requesting `report.state` and
  reducing the rows it returns through the same reducer (`renderer/pathux/agent/reportconvo.ts`) that reduces live events.
- **A report turn counts as busy work; an idle conversation does not.** Each turn is wrapped in `while('an agent report', …)` rather than the conversation, so the
  in-flight set is empty between turns and an authoring turn started while the pane sits open can still be stopped. The header's spinner and Stop come from `busyControls`
  (`renderer/rules/busy.ts`), a table keyed by busy kind. An authoring turn is deliberately absent from that table, because the Convo editor owns that button.
- The last ten conversations are stored at `<userConfigDir>/debug-transcripts/`, which is user-level state outside every repository. A new conversation prunes the oldest
  as it starts rather than as it ends, so a crashed run cannot leave an eleventh, and names are ISO stamps, so name order is time order. Each line holds one JSON object
  carrying its own version, so a reader skips an unknown line rather than failing the read. A line comes from the same reducer the pane draws with, and `FeedItem.detail`
  is dropped there and nowhere else, because that field holds a tool's result and the request captures in it are the author's own traffic.

# Conversation threads, saved in the project

Status: **shipped**

## Context

`todos.md`:

> create the concept of conversation threads if it doesn't exist already. there should be a
> searchable dropdown menu of all past threads. we will be saving the thread transcripts (minus
> tool calls? your call) in project repo in an appropriate place (propose one).

It does not exist. What exists is one conversation, in renderer memory, wiped on `agent.clear`
and lost on quit. `docs/desktopAppState.md` says so twice, in the plainest terms available:

> | Conversation history | Renderer memory (`pathux/agent.ts`) | ✗ Lost on restart |

> The **conversation history is not recovered** because it lives only in the renderer.

That is the whole gap. The transcript itself is already in good shape: `Convo` in
`renderer/pathux/convo.ts` is a value, `received(convo, event)` is a pure reducer over the
`AgentEvent` stream, and a `FeedItem` is already the one-line-per-thing shape a log wants
(`{id, role: 'user'|'agent'|'tool'|'blocked', text}`). Nothing needs to be invented; something
needs to be written down.

This plan is a prerequisite for
[`upload-and-archive.md`](upload-and-archive.md) — "activate or create a conversation editor **in
a new thread**" cannot be built before threads exist.

## Decisions this plan settles

- **A thread is a JSONL log at `vngen/state/threads/<id>.jsonl`.** Three reasons, each of which
  would be enough on its own: `vngen/state/` is where this project already keeps append-only logs
  (`tasks.jsonl`, `commands.jsonl`) and `@vn/util` already has the append/read pair; `vngen/` is
  **committed** in a user's project, so a transcript travels with the work it produced; and undo's
  shadow snapshots **exclude `vngen/state`**, so undoing the edit a conversation made never
  deletes the conversation that explains it. A transcript that could be undone away would be the
  worst possible version of this feature.
- **The reducer moves to `src/shared/convo.ts` and both processes run it.** Main owns the
  filesystem and sees every `AgentEvent` and every `runAgent(input)`; the renderer owns the
  display. If main built its own idea of a transcript, the file and the screen would drift within
  a week. `convo.ts` imports only types, so it is browser-safe by the `src/shared/` rule, and
  moving it is a pure relocation with the existing tests following it.
- **Tool calls are kept.** The author left the call open; the answer is that a `FeedItem` for a
  tool is *already* a one-line digest (that is what the `tool` role is for), and a transcript that
  says "the agent decided to rewrite the café sheet" without saying it wrote it is a record of an
  opinion rather than of what happened. Long tool text is truncated at a fixed cap with an
  ellipsis, the same treatment `prop.digest` gives a command's big string arguments.
- **The log is append-only, including the title.** The header line is written when the thread is
  created with a provisional title; a later `{type:'title'}` record supersedes it, and the reader
  takes the last one. Rewriting the first line of a JSONL file to rename a thread is how an append
  log stops being an append log.
- **A thread file is created by the first turn, never by opening the app.** Launching the desktop
  and never talking to the agent must leave no trace; otherwise every launch litters the repo with
  an empty thread and the dropdown fills with nothing.
- **Reopening a thread replays it on screen; the agent does not read it.** `Agent.messages` is
  backend-shaped — tool-use and tool-result ids that only mean something to the backend that
  issued them — so replaying a stored transcript into a different model, or into a rebuilt
  backend, is not defined. v1 reopens read-only, with a banner feed line saying exactly that
  ("Reopened for reading — the agent has not been shown this conversation"), and the composer
  starts a **new** thread. Silently pretending the model remembers is far worse than saying it
  does not. The follow-up is named in Stage 5 rather than pretended away.
- **One active thread per session, not per pane.** `pathux/agent.ts` is a module-level singleton
  and every convo pane shows the same conversation today. Threads do not change that; two panes
  are two views of one conversation. Per-pane threads would need a second agent per pane, which is
  a different feature with a different price.
- **A thread records the commit it opened at.** One line in the header (`git rev-parse HEAD` via
  `@vn/git`), which is what turns "what did we decide that day" into "and here is the tree it was
  decided against".

## The record shapes

```jsonc
// line 0
{"v":1,"type":"thread","id":"20260815-142233","title":"New conversation","startedAt":"…","commit":"a1b2c3d","model":"claude-…"}
// then, one per feed item
{"type":"item","id":1,"role":"user","text":"give aiko a track outfit","at":"…"}
{"type":"item","id":2,"role":"tool","text":"edit_character(aiko) — added outfit `track`","at":"…"}
{"type":"item","id":3,"role":"agent","text":"Added a track outfit…","at":"…"}
// and, once the first user turn names it
{"type":"title","title":"give aiko a track outfit","at":"…"}
```

`id` is `YYYYMMDD-HHMMSS` in local time with a `-2`, `-3`… suffix on collision, so the directory
sorts chronologically by filename and nothing needs an index file. The provisional title is
replaced by the first user turn, trimmed to 60 characters at a word boundary.

## Stage 1 — the store

New `packages/store/src/threads.ts` **or** `apps/desktop/src/main/threads.ts` — and it is the
latter. The conversation is a desktop concern; `@vn/store` is the reader of a *project's* files
and has no business knowing what an agent transcript is. (`vnauthor`'s REPL keeping its own
threads is a later question; when it comes up, the module moves down to `@vn/authoring` and both
hosts use it. Nothing in the file format assumes the desktop.)

```ts
export interface ThreadHeader { id: string; title: string; startedAt: string; commit?: string; model?: string }
export interface ThreadRecord extends ThreadHeader { items: FeedItem[] }

export function threadsDir(paths: ProjectPaths): string;
export async function listThreads(paths): Promise<ThreadHeader[]>;   // headers only, newest first
export async function readThread(paths, id): Promise<ThreadRecord>;
export async function openThread(paths, header): Promise<string>;    // writes line 0, returns id
export async function appendItem(paths, id, item: FeedItem): Promise<void>;
export async function retitleThread(paths, id, title): Promise<void>;
```

`listThreads` reads only the first and any `title` lines of each file — cheap enough to run on
every dropdown open, so there is no cache to invalidate.

Tests: `apps/desktop/src/main/tests/threads.test.ts` — round-trip, retitle-supersedes, a
truncated/corrupt last line ignored rather than throwing (a log written during a crash must still
list), and ordering.

## Stage 2 — main writes as it emits

`session.ts`:

- `runAgent(input)` opens a thread lazily if none is active, appends the `user` item, and appends
  every item the shared reducer derives from the events it emits.
- `clearAgent()` closes the active thread (no file write — the next turn opens a new one) in
  addition to what it does now.
- New session methods `threads()`, `newThread()`, `openThreadForReading(id)`, plus the active
  thread id on whatever status shape the header already reads.
- Teardown on workspace switch drops the active thread with everything else — a thread belongs to
  a project root, and `workspace.open` already rebuilds the session against the new one.

## Stage 3 — commands

`apps/desktop/src/main/commands/agent.ts`:

| command | mutating | what |
| --- | --- | --- |
| `agent.threads` | no | Every saved thread, newest first: id, title, when, the commit it opened at |
| `agent.newThread` | no | End the current thread and start fresh; the same reset `agent.clear` does, named for what an author means by it |
| `agent.openThread(id)` | no | Replay a saved thread into the convo panes, read-only |
| `agent.renameThread(id='' title='…')` | yes | Retitle; empty id means the active thread |

`agent.clear` stays, with its description amended to say the conversation is saved rather than
discarded. None of these is `undoable`: `vngen/state` is outside the undo snapshot by design, and
a command whose journal entry could not restore it must not claim it can.

## Stage 4 — the dropdown

`editors/convo.ts`, on the pane's own bar beside the mode and model pickers: a **Threads** button
that opens `startMenu(menu, x, y, true)` — path.ux's fancy menu is a **searchable** menu, which is
exactly what the todo asks for and is one boolean rather than a bespoke widget. Entries are
`agent.threads` rows, labelled `title · when`, each invoking `agent.openThread(id=…)`; a
separator; **New thread**.

A reopened thread renders the stored feed plus the read-only banner, and the composer's first send
starts a new thread — so the author can always type, and never types into a conversation the model
cannot see.

## Stage 5 — the follow-up this plan does not do

Continuing a saved thread means restoring `Agent.messages`, which requires the loop to expose a
`restore(messages)` and the messages to be persisted in their backend-native shape beside the
feed. The risks are concrete — a transcript recorded against one backend replayed into another,
tool-result ids referring to calls the new backend never made, a model swap mid-thread — and each
needs an answer before a byte is written. Recorded here so the next plan starts from the
constraint rather than rediscovering it.

## Stage 6 — documentation

- `docs/desktopAppState.md`: the two "lost on restart" rows become "saved to
  `vngen/state/threads/`, replayed read-only", and the persistence table gains the file.
- `docs/desktop-app.md`, Convo section: threads, the dropdown, the read-only rule.
- `docs/vnauthor.md`: a line noting that the desktop saves transcripts and the REPL does not yet.
- `CLAUDE.md`: one bullet — a conversation is a thread, it is saved under `vngen/state/threads/`
  beside the other append-only logs, and reopening one replays it without showing it to the model.

## Acceptance

- `pnpm check`, `pnpm test`, `pnpm lint` green.
- A turn, then quit, then relaunch: the thread is in the dropdown and replays with the same feed
  lines that were on screen.
- `agent.clear` starts a new thread; the old one is still listed.
- Launching the app and quitting without talking to the agent creates no thread file.
- A thread file with a half-written last line still lists and still replays everything before it.
- Undoing a `story.*` edit made during a conversation leaves the transcript intact.

## Shipped deviations

- **`ThreadHeader` and `ThreadRecord` live in `src/shared/convo.ts`**, not in `main/threads.ts`.
  The renderer names both — the menu labels headers, and the replay reads `record.items` off a
  `CommandOutcome.data` — and `src/shared/` is the only place a type can sit that both processes
  may import without dragging node into the browser bundle.
- **`openThread` returns the whole record, not the id.** The renderer needs the items to replay,
  and a second round trip to fetch what the command just read would be a second chance to read a
  different file.
- **The first turn's title goes straight into the header line**, rather than being appended as a
  superseding `title` record. The thread does not exist until someone speaks, so there is no
  earlier title for the first one to supersede — the record shape is still what renames use.
- **The reducer records the agent's speech in the feed as well as the dialogue box.** It had only
  ever set `line`, because the box was the only place a live pane showed it. A transcript that
  keeps the questions and drops every answer is not a transcript, and both processes reduce the
  same function, so this was the one change that made the log worth reading.
- **No `session.newThread()` alias.** `agent.newThread` closes the open thread and the next turn
  opens the next one lazily, which is exactly what `clearAgent` already did — a second method
  would have been a second way to be half-open.
- **Main does not re-record a denied confirm.** The agent loop already emits a `blocked` event and
  the reducer folds it in, so recording the denial again in the confirm handler wrote it twice.
- **Every menu row carries an explicit id in slot 5.** `createMenu`'s array branch reads
  `item.length > 4 ? item[5] : id++`, so a row with a tooltip and no id registers its callback
  under `undefined` while the `li` is keyed by its own DOM node — the click lands, the menu
  closes, and nothing runs. Passing the thread id (and `new` / `none` for the two fixed rows) is
  a one-word fix on this side of the seam rather than a patch to the vendored submodule.
- **Undo was already safe, for a second reason.** `vngen/state` is outside the shadow snapshot as
  the plan says, and the stack also refuses to undo past a non-undoable command — so an
  `agent.run` between an edit and an undo stops the undo rather than rolling the transcript back.
  Verified live: four transcripts intact across an undone `project.setArtStyle`.

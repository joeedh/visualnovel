# Git-Backed History, Undo, Recovery, and Collaboration

## Purpose

This note proposes a history architecture for the Visual Novel creator that uses Git as
the durable storage and collaboration substrate without exposing Git's implementation
model directly to authors.

The repository already treats authored projects as durable, user-owned data rather than
SaaS-owned state. Git is a strong fit because it provides content-addressed storage,
immutable snapshots, a history DAG, distributed remotes, and a mature ecosystem of trusted
hosting. The application should preserve those advantages while presenting a domain model
appropriate to visual-novel authors.

The central recommendation is:

> Use Git commits and refs as implementation primitives for several distinct kinds of
> history, but do not make every Git commit a user-visible "version" and do not make Git
> terminology the user's mental model.

## Separate the kinds of history

A single Git repository can support several histories that have different UX and retention
requirements.

### 1. Interaction history: undo/redo

This is the immediate editor history behind Ctrl-Z/Ctrl-Y.

Examples:

- move a sprite;
- edit a line of dialogue;
- change a character property;
- reconnect a scene transition;
- replace an asset reference.

This should remain an application-level semantic undo stack. A one-second edit should not
require moving Git HEAD or creating a user-visible commit. Undo should reverse semantic
operations quickly and predictably.

Where possible, undo records should describe application operations rather than file
patches. That makes them useful to the UI, diagnostics, and future agents.

### 2. Recovery history: durable hidden checkpoints

The application should periodically materialize project state as Git trees/commits so
crashes, process loss, or an accidentally discarded undo stack do not destroy recent work.

These commits should normally be invisible to the author.

Rather than relying on genuinely unreachable commits, retain checkpoints with
application-private refs, for example:

```
refs/vn/recovery/<workspace-id>/<checkpoint-id>
refs/vn/session/<session-id>/<checkpoint-id>
```

Exact naming is an implementation decision.

Private refs are preferable to deliberately unreachable objects because Git garbage
collection should not determine the product's recovery retention policy. The application
can expire refs according to its own policy and allow Git GC to reclaim objects later.

A recovery checkpoint may still be generated from a queue of edits rather than after every
operation. Checkpoint frequency can depend on elapsed time, amount of changed data,
expensive operations, application shutdown, and other risk boundaries.

### 3. Project history: meaningful versions

This is history authors should understand.

Examples:

- "Before chapter 3 rewrite"
- "Reworked Sarah confrontation"
- "Added alternate bad ending"
- "Version sent to Maya for review"

These can map naturally to ordinary Git commits or a selected subset of commits, but the
UI should present them as **versions/checkpoints/changes**, not as Git internals.

An agent can generate semantic summaries from the application's model:

> Reworked the Chapter 6 confrontation: changed 14 dialogue passages, added two Sarah
> expressions, and changed the final choice so either response can lead to reconciliation.

The application should supply structured change information where possible; the LLM should
not have to infer everything from textual file diffs.

### 4. Collaboration history

Collaboration should be modeled as proposed changes and review rather than continuous
mutation of one canonical state.

The durable workflow is approximately:

```
work independently
    -> publish proposed changes
    -> review semantic differences
    -> reconcile conflicts
    -> accept
```

Git branches, commits, fetch/push, and merge machinery can implement this without being
exposed directly to ordinary users.

Synchronous features can exist separately for review:

- presence;
- cursors/selections;
- shared viewport;
- comments/annotations;
- "look at this" navigation;
- voice/video integration if ever desired.

These are ephemeral collaboration facilities. They do not require every participant to
continuously mutate the same authoritative project state.

## Do not teach users Git

The application should expose a simpler semantic model over Git in the same spirit that a
DCC property system exposes a comprehensible technical model over a more complicated
implementation.

Potential user concepts:

| User concept                 | Possible Git implementation                |
| ---------------------------- | ------------------------------------------ |
| Saved version                | commit                                     |
| Try an alternative           | branch                                     |
| Changes from another author  | fetched branch / commit range              |
| Review changes               | semantic diff                              |
| Combine work                 | merge                                      |
| Restore an old piece of work | tree/object extraction or semantic restore |
| Recent recoverable work      | private checkpoint refs                    |

The mapping does not need to be exact. In particular, the UI should not inherit Git
concepts merely because they are convenient internally.

Avoid requiring ordinary authors to understand the index, detached HEAD, refspecs,
rebasing, remote-tracking branches, or three-way merge terminology.

An agent can translate long-tail requests such as:

- "Make a safe copy before trying this."
- "What did I change yesterday?"
- "Go back to when Sarah was still the villain, but keep the new character art."
- "Show me Maya's dialogue changes without taking her image changes."

The agent should propose/execute constrained version operations while the repository
remains authoritative.

## Semantic merge is the major opportunity

Git provides an excellent merge _model_, but line-oriented merge is not sufficient for
structured creative data.

The application should eventually define semantic identities and diffs for important
domain objects such as:

- scenes;
- dialogue nodes/lines;
- choices and transitions;
- characters;
- character states/expressions;
- assets and asset references;
- generated-art provenance;
- project metadata.

A conflict should be presented as:

> You and Maya changed the same conversation.

not:

> CONFLICT in project/chapter6/scene17.json

For structured properties, the UI can show base / yours / theirs at the property or object
level. For graph changes it can visualize competing topology. For assets it can show both
versions.

### Role of the agent

The LLM should **not** be the source of truth for merge detection or repository state.

Prefer this division:

1. Git establishes ancestry and candidate changed states.
2. Deterministic application code parses those states into the semantic model.
3. Semantic diff/merge code identifies compatible changes and real conflicts.
4. The agent explains conflicts, reconstructs likely intent from available history,
   proposes resolutions, and walks the user through ambiguous cases.
5. Deterministic application operations apply the chosen resolution.
6. Validation runs before the result is accepted.
7. Git records the resulting state.

This gives the agent leverage without making a probabilistic model responsible for
repository integrity.

## Preserve intent where practical

Traditional Git records resulting state plus a human commit message. The Visual Novel
application can know considerably more.

Where useful, history can retain semantic operation information such as:

```
EditDialogue(sceneId, lineId, ...)
MoveSceneNode(sceneId, ...)
ReplaceCharacterExpression(characterId, ...)
ChangeChoiceTarget(choiceId, ...)
```

This need not replace snapshots. Snapshots remain authoritative.

Semantic operation metadata can help:

- generate useful version descriptions;
- explain changes;
- perform domain-aware diffs;
- identify conflicts;
- help an agent reconstruct why a change occurred;
- restore individual objects without reverting an entire project.

If user intent is captured through an agent interaction, a concise user-approved intent
summary may be useful metadata. Avoid automatically persisting private conversation
transcripts merely to improve future merge quality.

## Recovery of individual objects

Private Git checkpoints enable a particularly useful agent workflow.

A user might ask:

> I deleted a conversation with Sarah yesterday. Can you get it back without undoing
> everything else?

The agent can search recovery/project history, locate the semantic object's earlier state,
show the user what it found, and restore only that object into the current working state.

This is much better UX than asking the user to identify a commit, check it out, copy
files, and return to the current branch.

The underlying implementation may use Git tree/blob access, but the exposed operation is
"restore this conversation."

## Suggested internal layers

A possible architecture is:

```
Visual Novel semantic model
        |
        +-- semantic commands / undo records
        |
        +-- semantic diff / merge / validation
        |
History service
        |
        +-- live undo/redo stack
        +-- recovery checkpoint policy
        +-- named project versions
        +-- collaboration/review operations
        |
Git adapter
        |
        +-- objects / trees / commits
        +-- private refs
        +-- branches
        +-- remotes
        +-- merge ancestry
```

The Git adapter should expose the primitives needed by the history service without leaking
Git vocabulary throughout the rest of the UI.

## Checkpoint policy

A practical recovery implementation can queue edits and create checkpoints at boundaries
such as:

- after N seconds of meaningful activity;
- after a threshold of semantic changes;
- before/after a large agent operation;
- before a destructive transformation;
- before accepting a merge;
- on clean application shutdown;
- when the user explicitly asks for a safe point.

Coalescing is desirable. There is little value in durable Git snapshots for every
keystroke when the in-memory undo system already has that granularity.

Retention might combine:

- dense checkpoints for the recent past;
- progressively sparser checkpoints as they age;
- named versions retained indefinitely;
- checkpoints around risky/important operations retained longer.

The private-ref scheme makes retention an application policy rather than an accident of
Git reflog/GC behavior.

## Agent operations should be transactional

Agent-driven edits may touch many semantic objects. Treat an agent plan as a
transaction-like operation:

1. create/ensure a pre-operation recovery checkpoint;
2. execute semantic commands;
3. validate project invariants;
4. present the resulting semantic diff when appropriate;
5. accept and checkpoint, or roll back.

This provides a much safer interaction than allowing an agent to make arbitrary filesystem
edits and hoping Git can reconstruct intent afterward.

For very large operations, intermediate recoverable states may still be useful, but they
need not appear in project history.

## Remote hosting and user ownership

The repository/remotes remain the user's data store. GitHub, GitLab, a private Git
service, a local NAS, or another compatible host can fill the remote role.

The Visual Novel application should ideally not require project content to transit an
application-vendor server.

This also aligns with the existing debug-agent privacy model: sensitive source material
can remain within the user's chosen model/storage trust relationships, while sanitized
reports can be explicitly reviewed and submitted by the user.

## Implementation questions for a code-reading agent

Before changing the current implementation, inspect the repository and answer:

1. Where are undo records represented today?
2. Which operations currently trigger Git commits?
3. How are commits queued/coalesced?
4. Are undo snapshots currently left unreachable, retained by reflog behavior, or
   explicitly referenced?
5. What code invokes Git: shell commands, a JS library, native bindings, or multiple
   paths?
6. How are project files mapped to semantic VN objects?
7. Are stable IDs available for scenes, dialogue, choices, characters, and assets?
8. Is there already a distinction between autosave/recovery and user-visible save/version
   operations?
9. Which generated artifacts should be excluded from semantic history?
10. What validation can run after a merge or agent edit?
11. Are Git operations currently serialized against editor writes?
12. What assumptions does remote sync make about branches and HEAD?

The first implementation plan should be based on these answers rather than replacing the
existing history code wholesale.

## Recommended first migration

A conservative sequence:

1. Document the existing undo/Git lifecycle.
2. Introduce a single history/Git service boundary if one does not already exist.
3. Replace intentionally unreachable long-lived recovery commits with private refs.
4. Keep the existing in-memory undo semantics.
5. Make recovery checkpoint creation explicitly policy-driven and coalesced.
6. Distinguish recovery checkpoints from user-visible versions in the data/API even if
   both use Git commits.
7. Add semantic change summaries for a small number of important VN object types.
8. Add object-level restore from a historical tree/checkpoint.
9. Build semantic conflict presentation before attempting aggressive automatic semantic
   merging.
10. Add agent-assisted conflict explanation/resolution only after deterministic diff/merge
    primitives exist.

This preserves the working system while establishing boundaries needed for richer
collaboration later.

## Design principle

Git should be treated as an unusually capable storage engine for history and distributed
collaboration, not as the product's UX model.

The author should think in terms of:

**work, versions, alternatives, review, recovery, and combining changes.**

The implementation can think in terms of:

**objects, trees, commits, refs, branches, remotes, and merge bases.**

Keeping those models separate gives the application the full power of Git without
requiring visual-novel authors to become Git users.

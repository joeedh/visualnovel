# An Introduction to Fountain

<!-- toc -->

- [Why Fountain?](#why-fountain)
- [The mental model](#the-mental-model)
- [Title page (optional)](#title-page-optional)
- [Core elements](#core-elements)
  * [Scene headings (sluglines)](#scene-headings-sluglines)
  * [Action (description)](#action-description)
  * [Character cue](#character-cue)
  * [Dialogue](#dialogue)
  * [Parentheticals](#parentheticals)
  * [Dual dialogue](#dual-dialogue)
  * [Transitions](#transitions)
- [Formatting & emphasis](#formatting--emphasis)
- [Structural & special elements](#structural--special-elements)
  * [Centered text](#centered-text)
  * [Lyrics](#lyrics)
  * [Sections and synopses (outlining)](#sections-and-synopses-outlining)
  * [Notes](#notes)
  * [Boneyard (block comments)](#boneyard-block-comments)
  * [Page breaks](#page-breaks)
- [Forced-element quick reference](#forced-element-quick-reference)
- [A small complete example](#a-small-complete-example)
- [A note on branching (project-specific)](#a-note-on-branching-project-specific)
- [Where the Fountain lives (project-specific)](#where-the-fountain-lives-project-specific)
- [One Fountain file, in and out (project-specific)](#one-fountain-file-in-and-out-project-specific)
- [What the model retains (project-specific)](#what-the-model-retains-project-specific)
- [Further reading](#further-reading)

<!-- tocstop -->

**Fountain** is a plain-text markup format for writing screenplays. It is to
screenplays roughly what Markdown is to prose: you write in an ordinary text editor
using a few simple, unobtrusive conventions, and a parser infers the structure
(scene headings, dialogue, action, transitions, …) from the way the text is laid out.

Because Fountain files are just UTF-8 text, they are diff-friendly, version-control
friendly, and trivially machine-parseable — which is exactly why this project uses it
as the input format for scene prose (see `vn-generator-report.md`). This project writes
**one scene per file**, so the Fountain lives in the body of a `scenes/<id>.md` — see
[Where the Fountain lives](#where-the-fountain-lives-project-specific).

---

## Why Fountain?

- **Human-readable.** A `.fountain` file reads like a screenplay even before it's
  rendered.
- **Tool-agnostic.** Any text editor works; no proprietary binary format.
- **Structure for free.** Scene headings, character cues, and dialogue are recognized
  by layout convention, so a parser can reliably extract the elements we need
  (locations, scenes, who-speaks-what) without NLP guesswork.
- **Forgiving but overridable.** Most elements are auto-detected; every element also
  has an explicit "forced" form for the rare ambiguous case.

---

## The mental model

Fountain decides what each block of text *is* primarily from:

1. **Blank lines** — most elements must be preceded (and often followed) by a blank
   line.
2. **Capitalization** — e.g. an all-caps line surrounded by blanks is a Character cue.
3. **Leading symbols** — a small set of prefixes (`.`, `@`, `!`, `>`, `~`, `#`, `=`)
   force or mark an element.

If auto-detection would guess wrong, you "force" the element with its prefix symbol.

---

## Title page (optional)

If present, it comes first, as `Key: Value` pairs, and is ended by a blank line.

```fountain
Title: The Long Afternoon
Credit: Written by
Author: Jane Doe
Source: Based on a short story
Draft date: 2026-06-15
Contact: jane@example.com
```

Recognized keys include `Title`, `Credit`, `Author` (or `Authors`), `Source`,
`Draft date`, and `Contact`. A page break is implied after the title page.

---

## Core elements

### Scene headings (sluglines)

A line that **starts with** `INT`, `EXT`, `EST`, `INT./EXT`, `INT/EXT`, or `I/E`
(case-insensitive in practice, conventionally uppercase) and is surrounded by blank
lines.

```fountain
INT. CLASSROOM - AFTERNOON

EXT. ROOFTOP - SUNSET
```

- **Force** a heading that doesn't start with a known prefix by beginning the line
  with a period: `.FLASHBACK` (the period is not shown in output).
- **Scene numbers** can be appended in hashes: `INT. CLASSROOM - DAY #12#`.

> For this project, scene headings are the primary source for **mining locations** and
> for **splitting the script into scenes**.

### Action (description)

The default element — any text that isn't recognized as something else. It preserves
your indentation/spacing.

```fountain
Aiko stares at the empty desk by the window. Outside, cicadas.
```

- **Force** action that would otherwise be misread (e.g. an all-caps line) by prefixing
  with `!`.

### Character cue

An **all-uppercase** line, preceded by a blank line, naming who speaks next.

```fountain
AIKO

REN (O.S.)
```

- Parenthetical **extensions** like `(O.S.)`, `(V.O.)`, or `(on the radio)` are allowed
  after the name.
- **Force** a mixed-case character name with `@`: `@McAVOY`.

### Dialogue

The line(s) immediately **following** a Character cue (or a Parenthetical).

```fountain
AIKO
I didn't think you'd actually come.
```

### Parentheticals

Wrapped in parentheses, sitting between the Character cue and the dialogue (or between
dialogue lines).

```fountain
AIKO
(quietly)
You're late.
```

### Dual dialogue

Two characters speaking simultaneously, side by side. Append a caret `^` to the
**second** character's cue.

```fountain
AIKO
We need to talk.

REN ^
We need to talk.
```

### Transitions

Right-aligned cues. Auto-detected when an uppercase line **ends with** `TO:`
(e.g. `CUT TO:`), surrounded by blanks.

```fountain
CUT TO:
```

- **Force** a transition with a leading `>`: `> Burn to White.`

---

## Formatting & emphasis

Inline styling uses Markdown-like markers (they do not carry across line breaks):

| Style | Syntax | Result |
|---|---|---|
| Italic | `*word*` | *word* |
| Bold | `**word**` | **word** |
| Bold italic | `***word***` | ***word*** |
| Underline | `_word_` | underlined |

Escape a literal marker with a backslash: `\*not italic\*`.

---

## Structural & special elements

### Centered text

Wrap a line in angle brackets:

```fountain
>THE END<
```

### Lyrics

Prefix each lyric line with a tilde `~`:

```fountain
~Somewhere beyond the sea
~Somewhere waiting for me
```

### Sections and synopses (outlining)

These are **author-only** aids that do **not** appear in the rendered screenplay —
useful for structuring a draft.

- **Sections:** Markdown-style headers with `#`. More `#`s = deeper nesting.

  ```fountain
  # Act One
  ## The Meeting
  ```

- **Synopses:** a line beginning with `=`.

  ```fountain
  = Aiko and Ren finally speak after the festival.
  ```

> Sections are a handy hook for **organizing branches/acts**, and synopses give the
> generator a concise per-scene summary to work from.

### Notes

Inline annotations in double brackets — ignored by the screenplay output, visible to
collaborators/tools:

```fountain
Aiko hesitates. [[is this too on-the-nose?]]
```

### Boneyard (block comments)

Text between `/*` and `*/` is omitted entirely (can span multiple lines):

```fountain
/* cut this whole beat for now
AIKO
...
*/
```

### Page breaks

Three or more `=` on their own line:

```fountain
===
```

---

## Forced-element quick reference

| Prefix | Forces / marks |
|---|---|
| `.` | Scene heading |
| `!` | Action |
| `@` | Character cue |
| `>` … | Transition |
| `>` … `<` | Centered text |
| `~` | Lyrics |
| `#` | Section (outline only) |
| `=` | Synopsis (outline only) |
| `[[ ]]` | Note (ignored in output) |
| `/* */` | Boneyard (ignored in output) |
| `===` | Page break |

---

## A small complete example

```fountain
Title: The Long Afternoon
Author: Jane Doe

# Act One

= Aiko waits for someone who may not come.

INT. CLASSROOM - AFTERNOON

Empty desks. Late light through tall windows. AIKO sits alone.

AIKO
(to herself)
Five more minutes.

The door slides open.

REN
Sorry. The train was late.

AIKO ^
You're late.

CUT TO:

EXT. ROOFTOP - SUNSET

The city spreads out below.

===
```

---

## A note on branching (project-specific)

Standard Fountain describes a **linear** screenplay. Visual novels branch, so this
project layers a lightweight convention on top — branch markers that point a scene at
its possible successors (see `vn-generator-report.md`, §6). Fountain's **Sections**
and **Notes** are convenient anchors for this, and because they're ignored by ordinary
Fountain renderers, a file with our branch markers still parses as valid Fountain.

Every project marker is a **note**, so all of them are invisible to other tooling:

| Marker | Means |
|---|---|
| `[[scene: id]]` | Names the scene this heading starts |
| `[[choice: label -> id]]` | One branch out of the scene |
| `[[next: id]]` | Followed when the scene offers no choices |
| `[[outfit: aiko=track]]` | What a character wears for this whole scene — see below |
| `[[line: L4]]` | The id of the element it leads — see below |
| `[[nextline: 12]]` | The scene's line-id allocator; sits under the heading |

`[[outfit:]]` is **one pair per marker**, repeated for a second character, and both halves are
ids — an outfit id off the character's sheet, not a description. A value with whitespace in it
or a missing half (`[[outfit: aiko=club tracksuit]]`, `[[outfit: aiko]]`) is left as a plain
note rather than half-read. Position within the scene is not meaningful; the marker dresses the
whole scene, and one frame is overridden on the shot instead. What it sits inside is the
inheritance chain — shot override, then this, then the character's `default_outfit`.

`[[line:]]` and `[[nextline:]]` exist because `Shot.coversLines` binds art to line ids.
An id derived from position silently re-points every shot below an inserted line, so ids
are **allocated and written down** instead: a `[[line: L4]]` note on its own line
immediately above an element names that element, and `[[nextline:]]` records the next
free number for the scene. Reading a screenplay never writes to it — unmarked elements
get ids in memory, and persisting them is the separate `story.assignLineIds` command.

An unforced `CUT TO:` is the one element whose mark goes **on** its own line
(`[[line: L2]]CUT TO:`) rather than above it: the parser recognizes it by the blank line
above, and a marker line is not blank.

## Where the Fountain lives (project-specific)

An authored scene is one file, `scenes/<id>.md` at the project root beside `characters/`
and `locations/`. It is a markdown file with YAML front-matter, and the front-matter is
**identity and nothing else**:

```markdown
---
scene: rooftop
---

EXT. ROOFTOP - EVENING

Aiko pushes through the heavy door.

AIKO
Oh — sorry. I didn't think anyone came up here.

[[next: ending]]
```

The rules that make that body predictable:

- **The body is a complete one-scene Fountain screenplay**, its own heading included. Not a
  fragment, not prose with the heading hoisted into front-matter — everything on this page
  applies to it unchanged, and the same parser reads it.
- **Exactly one scene heading.** A body with none, or with two, is refused: there is no single
  id it could belong to.
- **No `[[scene:]]` marker.** The id is the filename and the `scene:` key, which must agree; a
  body that could rename its own file is the one thing the front-matter exists to prevent.
- **Every other field stays in the body**, as a Fountain element or a `[[…]]` marker —
  `location` and the time-of-day variant in the heading, `synopsis` as `=`, `choices`/`next` and
  the line ids as markers. Front-matter is a **closed** schema, so putting one of them up there
  is an error rather than a second source of truth.
- **No title page.** `Title:` and friends belong to a screenplay, not a scene; the project title
  is `title:` in `project.yaml`.
- Line-id marks are optional. A hand-authored scene usually has none — reading allocates them in
  memory, and `story.assignLineIds` is what writes them down.

A directory has no document order, so the entry scene is named by `start:` in `project.yaml`.

The older form — one `screenplay/*.fountain` holding every scene, separated by `[[scene: id]]`
markers, entry inferred from document order — is **no longer read**. A project holding one and no
`scenes/` reports an error naming `vngen import`; one left beside chunks is a warning telling you
to delete it or rename it `<name>.fountain.imported`, which the reader does not look at. A single
Fountain file is now an export target rather than an input — see below.

## One Fountain file, in and out (project-specific)

Two commands, two directions, and only one of them is a migration:

```sh
vngen import     [dir]                       # screenplay/*.fountain → scenes/<id>.md, once
vngen screenplay [dir] [-o <file>|-] [--clean]   # scenes → one Fountain file, any time
```

**`vngen import` runs once.** It refuses over an existing `scenes/`, converts every scene, writes
`start:` into `project.yaml`, and moves the original to `<name>.fountain.imported` **last** — while
it is still a `.fountain` the project reports it on every load, so the rename is what finishes the
job. Scene ids are carried through unchanged (generated art binds to them), the whole conversion is
round-trip-checked in memory before any file is written, and anything the model cannot keep —
sections, page breaks, dual dialogue, the title page — is a warning naming what will be absent
rather than a silent drop. Every line gets a `[[line:]]` mark under a `[[nextline:]]` allocator, so
the file you first open is the file the app will keep.

**`vngen screenplay` is a projection**, in the same sense `vngen export` is — no claim that
re-importing its output reproduces the project, and no relation to `story.play.json`, which is what
`export` writes. What comes out:

```fountain
INT. CLASSROOM - DAY

[[scene: arrival]]
[[next: rooftop]]
[[nextline: 3]]

[[line: L1]]
Aiko sets her bag down by the window.

AIKO
[[line: L2]]
It's quieter than I expected.

EXT. ROOFTOP - EVENING

[[scene: rooftop]]
[[nextline: 2]]

[[line: L1]]
The city hums somewhere below.
```

- **Order is the graph's, not the directory's**: breadth-first from `start:`, `next` before
  `choices`. Anything the entry cannot reach is appended under a `# Unreachable` section rather
  than dropped.
- **Markers are kept by default**, which is what makes the output a valid input to `vngen import`.
  `--clean` drops all of them for a human or a screenwriting tool, and that output is explicitly
  one-way: the branch structure went with the markers.
- **It writes where it is told** — `<dir>/screenplay.fountain` by default, `-o` to override, `-`
  for stdout — and it refuses an `-o` inside `screenplay/`, where the project would report the
  file on every load from now on.

`templates/basic` is the shipped worked example: it was converted by running `vngen import` on it,
and a test proves it is a fixed point — export it, import that, and the committed files come back
byte for byte.

## What the model retains (project-specific)

`splitScenes` turns a screenplay into scenes whose prose is a list of **lines**, and
`sceneToFountain` writes them back — `parse(write(scene)) ≡ scene`, pinned by a property
test. Which elements survive that trip is therefore a decision, not an accident:

| Element | Kept as | Notes |
|---|---|---|
| Action | `narration` | The catch-all; written back forced with `!` when it would re-parse as something else |
| Dialogue | `dialogue` | Carries its speaker (the cue name) |
| Parenthetical | `parenthetical` | Carries its speaker |
| Transition | `transition` | Coverable by a shot, but produces no beat in the playable — it is a cut, not a line the reader is shown |
| Lyric | `lyric` | |
| Centered text | `centered` | |
| Scene heading | the scene itself | Prefix and time-of-day variant are kept — the variant is what the location plate is generated from |
| Synopsis | `Scene.synopsis` | Handed to the LLM |
| Notes | branch markers | Everything else in `[[ … ]]` is ignored |
| Section (`#`) | **dropped** | Deliberate: it means nothing to the pipeline, and a line kind no shot could cover is worse than losing it |
| Page break | **dropped** | Same |
| `character.dual` (`^`) | **dropped** | Simultaneous dialogue has no representation downstream |

---

## Further reading

- Official syntax reference: <https://fountain.io/syntax/>
- Format home page: <https://fountain.io/>

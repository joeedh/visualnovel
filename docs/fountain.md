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
- [Further reading](#further-reading)

<!-- tocstop -->

**Fountain** is a plain-text markup format for writing screenplays. It is to
screenplays roughly what Markdown is to prose: you write in an ordinary text editor
using a few simple, unobtrusive conventions, and a parser infers the structure
(scene headings, dialogue, action, transitions, …) from the way the text is laid out.

Because Fountain files are just UTF-8 text, they are diff-friendly, version-control
friendly, and trivially machine-parseable — which is exactly why this project uses it
as the screenplay input format (see `vn-generator-report.md`).

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

---

## Further reading

- Official syntax reference: <https://fountain.io/syntax/>
- Format home page: <https://fountain.io/>

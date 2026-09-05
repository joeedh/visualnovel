# An Introduction to Fountain

<!-- toc -->

- [Why Fountain?](#why-fountain)
- [The mental model](#the-mental-model)
- [Title page (optional)](#title-page-optional)
- [Core elements](#core-elements)
    - [Scene headings (sluglines)](#scene-headings-sluglines)
    - [Action (description)](#action-description)
    - [Character cue](#character-cue)
    - [Dialogue](#dialogue)
    - [Parentheticals](#parentheticals)
    - [Dual dialogue](#dual-dialogue)
    - [Transitions](#transitions)
- [Formatting & emphasis](#formatting--emphasis)
- [Structural & special elements](#structural--special-elements)
    - [Centered text](#centered-text)
    - [Lyrics](#lyrics)
    - [Sections and synopses (outlining)](#sections-and-synopses-outlining)
    - [Notes](#notes)
    - [Boneyard (block comments)](#boneyard-block-comments)
    - [Page breaks](#page-breaks)
- [Forced-element quick reference](#forced-element-quick-reference)
- [A small complete example](#a-small-complete-example)
- [A note on branching (project-specific)](#a-note-on-branching-project-specific)
- [Where the Fountain lives (project-specific)](#where-the-fountain-lives-project-specific)
- [One Fountain file, in and out (project-specific)](#one-fountain-file-in-and-out-project-specific)
- [What the model retains (project-specific)](#what-the-model-retains-project-specific)
- [Further reading](#further-reading)

<!-- tocstop -->

**Fountain** is a plain-text markup format for writing screenplays. It uses roughly the
same approach for screenplays that Markdown uses for prose: you write in an ordinary text
editor using a few simple, unobtrusive conventions, and a parser infers the structure
(scene headings, dialogue, action, transitions, and so on) from the way the text is laid
out.

Fountain files are UTF-8 text, so they diff cleanly, work well under version control, and
are easy to parse by machine. This project uses Fountain as the input format for scene
prose for those reasons (see vn-generator-report.md). This project writes one scene per
file, and the Fountain occupies the body of a `scenes/<id>.md` file — see
[Where the Fountain lives](#where-the-fountain-lives-project-specific).

---

## Why Fountain?

- **Human-readable.** A `.fountain` file reads like a screenplay even before it's
  rendered.
- **Tool-agnostic.** Any text editor works, and the format is not a proprietary binary.
-   - **Layout conventions carry the structure.** Scene headings, character cues, and
      dialogue follow those conventions, so a parser can reliably extract the elements we
      need (locations, scenes, who speaks what) without NLP guesswork.
- **Auto-detected but overridable.** Most elements are auto-detected. Every element also
  has an explicit "forced" form for the rare ambiguous case.

---

## The mental model

Fountain relies primarily on the following to decide what each block of text is:

1. **Blank lines** — most elements must be preceded (and often followed) by a blank line.
2.  2. **Capitalization** — e.g. an all-caps line surrounded by blanks marks a Character
       cue.
3.  3. **Leading symbols** — a small set of prefixes (`.`, `@`, `!`, `>`, `~`, `#`, `=`)
       forces or marks an element.

Prefix the element with its symbol to select it explicitly when auto-detection would
otherwise select the wrong one.

---

## Title page (optional)

If a block of `Key: Value` pairs is present, it comes first. A blank line ends the block.

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

Starts with `INT`, `EXT`, `EST`, `INT./EXT`, `INT/EXT`, or `I/E` and is surrounded by
blank lines. The prefixes are conventionally uppercase, and the match ignores case.

```fountain
INT. CLASSROOM - AFTERNOON

EXT. ROOFTOP - SUNSET
```

- Force a heading that does not start with a known prefix by beginning the line with a
  period: `.FLASHBACK` (the output omits the period).
- **Scene numbers** can be appended in hashes: `INT. CLASSROOM - DAY #12#`.

For this project, scene headings are the primary source for extracting locations and for
splitting the script into scenes.

### Action (description)

The default element holds text that is not recognized as another element. The default
element preserves your indentation and spacing.

```fountain
Aiko stares at the empty desk by the window. Outside, cicadas.
```

- Prefix with `!` to force an action that would otherwise be misread (e.g. an all-caps
  line).

### Character cue

An all-uppercase line preceded by a blank line names the next speaker.

```fountain
AIKO

REN (O.S.)
```

- Parenthetical extensions such as `(O.S.)`, `(V.O.)`, or `(on the radio)` may follow the
  name.
- Force a mixed-case character name with `@`, as in `@McAVOY`.

### Dialogue

Holds the line or lines that immediately follow a Character cue (or a Parenthetical).

```fountain
AIKO
I didn't think you'd actually come.
```

### Parentheticals

Appears in parentheses between the Character cue and the dialogue (or between dialogue
lines).

```fountain
AIKO
(quietly)
You're late.
```

### Dual dialogue

Shows two characters speaking simultaneously, side by side. Append a caret `^` to the
second character's cue.

```fountain
AIKO
We need to talk.

REN ^
We need to talk.
```

### Transitions

Cues are right-aligned. A line counts as a cue when it is uppercase, ends with `TO:` (e.g.
`CUT TO:`), and is surrounded by blanks.

```fountain
CUT TO:
```

- Force a transition with a leading `>`: `> Burn to White.`

---

## Formatting & emphasis

Inline styling uses Markdown-like markers (they do not carry across line breaks):

| Style       | Syntax       | Result     |
| ----------- | ------------ | ---------- |
| Italic      | `*word*`     | _word_     |
| Bold        | `**word**`   | **word**   |
| Bold italic | `***word***` | **_word_** |
| Underline   | `_word_`     | underlined |

Escape a literal marker with a backslash: `\*not italic\*`.

---

## Structural & special elements

### Centered text

<line>

```fountain
>THE END<
```

### Lyrics

~ Prefix each lyric line with a tilde `~`:

```fountain
~Somewhere beyond the sea
~Somewhere waiting for me
```

### Sections and synopses (outlining)

These aids are for the author only and do not appear in the rendered screenplay. These
aids are useful for structuring a draft.

- **Sections:** A section starts with a Markdown-style header written with `#`. Each
  additional `#` nests the section one level deeper.

    ```fountain
    # Act One
    ## The Meeting
    ```

- **Synopses:** A synopsis is a line that begins with `=`.

    ```fountain
    = Aiko and Ren finally speak after the festival.
    ```

Sections organize branches and acts. Each synopsis is a concise per-scene summary that the
generator works from.

### Notes

Double brackets mark an inline annotation. The annotation does not appear in the
screenplay output, but collaborators and tools can read it:

```fountain
Aiko hesitates. [[is this too on-the-nose?]]
```

### Boneyard (block comments)

Text between `/*` and `*/` (which can span multiple lines) is omitted entirely:

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

| Prefix    | Forces / marks               |
| --------- | ---------------------------- |
| `.`       | Scene heading                |
| `!`       | Action                       |
| `@`       | Character cue                |
| `>` …     | Transition                   |
| `>` … `<` | Centered text                |
| `~`       | Lyrics                       |
| `#`       | Section (outline only)       |
| `=`       | Synopsis (outline only)      |
| `[[ ]]`   | Note (ignored in output)     |
| `/* */`   | Boneyard (ignored in output) |
| `===`     | Page break                   |

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

Standard Fountain describes a linear screenplay. Visual novels branch, so this project
adds a lightweight convention of branch markers that name a scene's possible successors
(see vn-generator-report.md §6). Fountain's "Sections" and "Notes" carry these markers,
and ordinary Fountain renderers ignore both, so a file with our branch markers still
parses as valid Fountain.

Every project marker is stored as a note, so no other tooling sees it:

| Marker                    | Means                                                   |
| ------------------------- | ------------------------------------------------------- |
| `[[scene: id]]`           | Names the scene this heading starts                     |
| `[[choice: label -> id]]` | One branch out of the scene                             |
| `[[next: id]]`            | Followed when the scene offers no choices               |
| `[[outfit: aiko=track]]`  | What a character wears for this whole scene — see below |
| `[[line: L4]]`            | The id of the element it leads — see below              |
| `[[nextline: 12]]`        | The scene's line-id allocator; sits under the heading   |

`[[outfit:]]` takes one pair per marker, repeated for a second character. Both halves are
ids, and the outfit half is an outfit id from the character's sheet, not a description. A
value with whitespace in it or a missing half (`[[outfit: aiko=club tracksuit]]`,
`[[outfit: aiko]]`) is left as a plain note instead of being parsed in part. Position
within the scene is not meaningful. The marker applies to the whole scene, and overriding
a single frame is done on the shot instead. Resolution takes the shot override first, then
this marker, then the character's `default_outfit`.

`[[line:]]` and `[[nextline:]]` exist because `Shot.coversLines` binds art to line ids.
Deriving an id from position silently re-points every shot below an inserted line, so ids
are allocated and written down instead. A `[[line: L4]]` note on its own line immediately
above an element names that element, and `[[nextline:]]` records the next free number for
the scene. Reading a screenplay never writes to it. Unmarked elements get ids in memory,
and the separate `story.assignLineIds` command persists them.

An unforced `CUT TO:` is the only element whose mark goes on the element's own line. The
line reads `[[line: L2]]CUT TO:` rather than carrying the mark on the line above. The
parser recognizes the element by the blank line above it, and a marker line is not blank.

## Where the Fountain lives (project-specific)

An authored scene is one file `scenes/<id>.md` at the project root, beside `characters/`
and `locations/`. The file is Markdown with YAML front-matter, and the front-matter holds
identifying fields and nothing else:

```markdown
---
scene: rooftop
---

EXT. ROOFTOP - EVENING

Aiko pushes through the heavy door.

AIKO Oh — sorry. I didn't think anyone came up here.

[[next: ending]]
```

These rules make that body predictable:

- The body is a complete one-scene Fountain screenplay, including its own heading. It is
  not a fragment, and it is not prose with the heading hoisted into front-matter. Every
  rule on this page applies to the body unchanged, and the same parser reads it.
-   - **Exactly one scene heading.** Refuses a body with no heading, and refuses a body
      with two headings, because neither a missing heading nor a second heading names the
      single id the body belongs to.
-   - **No `[[scene:]]` marker.** The filename and the `scene:` key both state the id and
      must agree. The front-matter holds the id, so the body does not set it.
- **Every other field stays in the body**, in a Fountain element or a `[[…]]` marker. The
  heading carries `location` and the time-of-day variant, `=` carries `synopsis`, and
  markers carry `choices`/`next` and the line ids. Front-matter is a closed schema, so
  putting one of these fields in the front-matter is an error and does not create a second
  source of truth.
- **No title page.** `Title:` and similar keys belong to a screenplay rather than a scene.
  Set the project title with `title:` in `project.yaml`.
- Line-id marks are optional. A hand-authored scene usually has none. Reading a scene
  allocates the marks in memory, and `story.assignLineIds` writes them.

A directory has no document order, so `start:` in `project.yaml` names the entry scene.

The older form is no longer read. That form held every scene in one
`screenplay/*.fountain` file, separated by `[[scene: id]]` markers, and the entry scene
was inferred from document order. A project that holds such a file and no `scenes/`
directory produces an error that names `vngen import`. A file in the older form left
beside chunks raises a warning that asks you to delete it or rename it
`<name>.fountain.imported`. The reader skips a file with that suffix. A single Fountain
file is now an export target rather than an input (see below).

## One Fountain file, in and out (project-specific)

The two commands run in opposite directions, and only one of them is a migration:

```sh
vngen import     [dir]                       # screenplay/*.fountain → scenes/<id>.md, once
vngen screenplay [dir] [-o <file>|-] [--clean]   # scenes → one Fountain file, any time
```

`vngen import` runs once. It refuses to run when `scenes/` already exists, converts every
scene, writes `start:` into `project.yaml`, and moves the original to
`<name>.fountain.imported` last. The project reports the file on every load while it is
still a `.fountain`, so the rename stops those reports. Scene ids are carried through
unchanged (generated art binds to them), and the whole conversion is round-trip-checked in
memory before any file is written. Anything the model cannot keep (sections, page breaks,
dual dialogue, the title page) raises a warning that names what will be absent instead of
dropping it silently. Every line gets a `[[line:]]` mark under a `[[nextline:]]`
allocator, so the app preserves the file as it was first opened.

`vngen screenplay` produces a projection, in the same sense that `vngen export` does. The
command does not claim that re-importing its output reproduces the project, and its output
is unrelated to `story.play.json` (the file that `export` writes). The output contains:

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

-   - **Ordering follows the graph rather than the directory**: nodes are emitted
      breadth-first from `start:`, taking `next` before `choices`. Nodes that `start:`
      cannot reach are appended under a `# Unreachable` section rather than dropped.
- Markers are kept by default, so the output is valid input to `vngen import`. `--clean`
  drops every marker for a human reader or a screenwriting tool. Cleaned output cannot be
  imported again, because dropping the markers drops the branch structure.
- **Writes to the path it is given.** Writes `<dir>/screenplay.fountain` by default, `-o`
  sets a different path, and `-` writes to stdout. Refuses an `-o` path inside
  `screenplay/`, because the project would then report the file on every load.

`templates/basic` is the worked example, converted by running `vngen import` on it. A test
checks that `templates/basic` is a fixed point by exporting it, importing that export, and
comparing the result against the committed files. The result matches those files byte for
byte.

## What the model retains (project-specific)

`splitScenes` turns a screenplay into scenes, each holding its prose as a list of lines,
and `sceneToFountain` writes them back, so that `parse(write(scene)) ≡ scene`. A property
test checks that equivalence. Each element that survives the round trip is therefore
chosen deliberately:

| Element                | Kept as          | Notes                                                                                                     |
| ---------------------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| Action                 | `narration`      | The catch-all; written back forced with `!` when it would re-parse as something else                      |
| Dialogue               | `dialogue`       | Carries its speaker (the cue name)                                                                        |
| Parenthetical          | `parenthetical`  | Carries its speaker                                                                                       |
| Transition             | `transition`     | Coverable by a shot, but produces no beat in the playable — it is a cut, not a line the reader is shown   |
| Lyric                  | `lyric`          |                                                                                                           |
| Centered text          | `centered`       |                                                                                                           |
| Scene heading          | the scene itself | Prefix and time-of-day variant are kept — the variant is what the location plate is generated from        |
| Synopsis               | `Scene.synopsis` | Handed to the LLM                                                                                         |
| Notes                  | branch markers   | Everything else in `[[ … ]]` is ignored                                                                   |
| Section (`#`)          | **dropped**      | Deliberate: it means nothing to the pipeline, and a line kind no shot could cover is worse than losing it |
| Page break             | **dropped**      | Same                                                                                                      |
| `character.dual` (`^`) | **dropped**      | Simultaneous dialogue has no representation downstream                                                    |

---

## Further reading

- Official syntax reference: <https://fountain.io/syntax/>
- Format home page: <https://fountain.io/>

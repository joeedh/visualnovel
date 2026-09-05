# Prose Style

<!-- toc -->



<!-- tocstop -->

These rules govern every piece of prose in the repository. They apply to code comments, to
this file, and to everything under `docs/`.

`pnpm prose:style --file docs/<page>.md` proposes a revision of one page against the rules below.
It is advisory and applies nothing: a revised copy and a diff land in the gitignored
`.prosestyle/`, and a person decides what to take. It needs a model key, it revises one block at a
time so that no call ever holds the whole page, and it fact-checks every change it makes. It is
not a lint step and does not run in CI, which is where it differs from `pnpm lint:comments` —
`commentlint` flags a line against a fixed rule set, and this proposes a rewrite. Both the tool
and the reasoning behind its shape are in
[`../plans/enforcing-prose-style-without-context-poisoning.md`](../plans/enforcing-prose-style-without-context-poisoning.md).

- **Write plain declarative prose — no epigrams.** State the constraint or decision
  directly: "An empty answer is deliberate and is passed to the model as-is", not "Empty is an
  answer — silence, said out loud." If a sentence needs a second read to parse, rewrite it.
  Specific patterns to catch:
  - **Quote Ambiguous Jargon Words** Jargon words that mirror common words should be quoted, with 
    a subsequent parenthesized explanation of the meaning, e.g.
    '`renderer/rules/` holds the pure half of the renderer' should be:
    '`renderer/rules/` holds the "pure" (validation) half of the renderer'
  - Do not use substitutes for unambiguous standard engineering jargon, e.g. 
    'resolution of a wanted invocation against the drawn anchors' should be:
    'resolution of a requested invocation against the drawn anchors'; 'requested' 
    is identical to its common use in engineering and is thus unambiguous, while 
    'wanted' is personification.
  - **Inverted syntax and personification** — the sentence performs rather than informs: "Only
    then does the scheduler retry", "the cache remembers what it has seen". Put the subject
    first and give it a verb it can literally do: "The scheduler retries once the barrier
    clears", "The cache holds the last ten results".
  - **Metaphorical equations** — the connector word varies, so do not get hung up on "is"
    versus "as". Say what happens instead. "The leak scan is the refusal" becomes "Refuses if
    the leak scan finds a known name still in the body"; "what ships is identity" becomes "A
    signed build carries the publisher's name"; "the project as commands" becomes "Every change
    to the project is made by a command".
  - **Fragment openers that defer the subject — never use this pattern.** Naming a placeholder
    and then withholding the real content behind a colon or a dash is always wrong: "The
    redactor to scan a report with: the one that wrote it, else one built from the project as it
    stands." Lead with a complete sentence and name each case as you reach it. A doc comment is
    not an exception, and deleting the label is not the fix, because the apposition left behind
    is still headless. Supply a predicate instead. Write "Draws the links beneath the node
    frames in screen space." rather than "The link underlay: a screen-space canvas beneath the
    node frames." or the bare "Screen-space canvas beneath the node frames."
  - **Double negatives** — "the palette cannot be relied on not to". State the positive claim:
    "the palette may reorder its entries".
  - **Pronouns and ellipses that point outside the sentence** — "the second case", "asking
    twice is how…" — each sentence should carry its own referents. Name what the pronoun stands
    for and finish the clause: "A refused write leaves the pane stale", "A caller that asks
    twice learns the key was rejected".
  - **"Clause A, else B" constructions** — "Resolve a push's destination: the named window
    when it still exists, else the focused window falling back to the most recently focused
    one." Spell out the cases as ordinary sentences instead: "Pushes to the named window if it
    still exists. Otherwise pushes to the focused window, or the most recently focused window
    if none is focused."
  - **Adverbs hung off the end of a noun phrase** — "the next pointerdown anywhere", "the
    handler above". The adverb postmodifies the noun, but the reader cannot tell on first pass
    whether it attaches to the noun or to the clause's verb, and an event or API name coined
    from a verb ("pointerdown") re-parses as a clause when an adverb follows it. Attach the
    qualification to a verb, or state it as its own fact: "the listener is on `window`".
  - **Non-assertive words under a definite** — "any", "anywhere", "ever" range over
    alternatives, so they fight a definite description that names exactly one thing. "A press
    anywhere dismisses it" reads fine; "the next pointerdown anywhere" does not. Drop the
    non-assertive word and state the range as its own fact: "The listener is on `window`, so the
    next pointerdown dismisses the popup."
  - **Rhetorical emphasis** — bold and italics inside a sentence mark the clause the author
    found most interesting, not the one the reader needs first. Put the load-bearing claim in
    the first sentence and drop the markup. A bolded lead-in that labels a Markdown bullet is
    structure rather than emphasis, and is fine.
  - **A head noun that is not what the thing is** — a module of commands documented as "The
    prompt an asset is generated from, as commands" asserts that the module is a prompt, then
    retracts it through a preposition. Lead with the head noun that names the thing —
    "Commands for the prompt an asset is generated from" — and demote the rest to a
    complement. A trailing ", as X" or ", in the form of X" is the same metaphorical equation
    above smuggled in through an adjunct.
- **Reserve backticks for code symbols.** Backticks belong on identifiers, types, commands,
  and file globs the reader will type. A file path cited mid-sentence as a reference —
  docs/plans/archive/INDEX.md#chunked-prompts §5 — takes none, because marking it up gives it the
  same weight as the identifiers around it and dilutes them. Markdown link text is the one
  exception and keeps its backticks, where the marking separates a path from the prose around
  it rather than competing with nearby identifiers.
- **Bracket a subordinate alternative rather than fencing it with commas.** Parentheses mark the
  material as skippable, so the reader gets a complete sentence either way; paired commas leave
  it unclear whether the second comma closes an interpolation or opens a new clause. Write
  "Dropping onto itself (or onto a neighbor it would split against) is not a rip". Drop any comma
  that would follow the closing bracket — it separates the subject from its verb.

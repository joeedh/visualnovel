# gate.approve

**Approve portrait** — Approve a character's portrait by asset hash, clearing them from the gate.

Holds and accepts the portrait row; the store mirrors it onto `character.md` and `approved.png`.

Mutating · affects: `characters`, `wiki`, `vngen/work/characters`, `assets/manifest.json`, `vngen/build/manifest.json` · has a precondition (ask `ux_check`)

## Props

| Prop | Type | Required | Description |
| --- | --- | --- | --- |
| `characterId` | string | yes | the character to approve |
| `hash` | string | yes | the asset hash to approve |

## Drawn by

| Editor | Module | Situations | Label | Tooltip | Props known | Then |
| --- | --- | --- | --- | --- | --- | --- |
| asset | assetview | portrait-unapproved | Approve | Approve this look at the gate, which is what clears the character | characterId=aiko, hash=a1b2c3d4 |  |
| taskgraph | taskGraph | gate-unasked | aiko → | Approve a portrait for aiko | characterId=aiko |  |
| taskgraph | taskGraph | gate-with-candidates | aiko → | Name the portrait to approve. | characterId=aiko |  |
| tasklist | tasklist | gate-pending | RESOLVE → | Approve aiko's portrait, which is what the rest of the run is waiting on | characterId=aiko |  |

## Refused when

Sentences are a fixture's, verbatim: an id in one is the fixture's, not this project's.

| Editor | Module | Situation | Says | More |
| --- | --- | --- | --- | --- |
| taskgraph | taskGraph | gate-without-candidates | No candidate portraits are on file for aiko yet — run the pipeline first. |  |

## Reached after

Nothing runs it as a later step of a click.

## Reaching it

- Sweep: a control or menu entry ran it in the sweep of 2026-09-22 at acfd6c8.
- Palette-only rule: none.
- Shortcut: none.
- Menu: doctree (documents) on `shot:sample/shot1` — "Approve as a portrait…" with `hash=a1b2c3d4`
- Menu: doctree (documents) on `asset:sample` — "Approve as a portrait…" with `hash=sample`

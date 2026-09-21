# pane.pin

**Pin** — Holds the pane on its subject, or lets it follow the selection again.

`pane.pin` is an effect, not a command: a `show_me` step of kind `command` naming it is refused. A tour reaches it by pointing at the control, shortcut or menu entry under "Reaching it".

## Props

| Prop | Type | Required | Description |
| --- | --- | --- | --- |
| `pinned` | boolean | yes | whether the pane is held |

## Drawn by

| Editor | Module | Situations | Label | Tooltip | Props known | Then |
| --- | --- | --- | --- | --- | --- | --- |
| script | pin | following | pin scene | Keep this pane on this scene while the rest of the app moves on. | pinned=true |  |
| script | pin | pinned | pin scene | Pinned to this scene. Click to follow the selection again. | pinned=false |  |
| page | pin | following | pin shot | Keep this pane on this shot while the rest of the app moves on. | pinned=true |  |
| page | pin | pinned | pin shot | Pinned to this shot. Click to follow the selection again. | pinned=false |  |
| timeline | pin | following | pin scene | Keep this pane on this scene while the rest of the app moves on. | pinned=true |  |
| timeline | pin | pinned | pin scene | Pinned to this scene. Click to follow the selection again. | pinned=false |  |
| gengraph | pin | following | pin generation graph | Keep this pane on this generation graph while the rest of the app moves on. | pinned=true |  |
| gengraph | pin | pinned | pin generation graph | Pinned to this generation graph. Click to follow the selection again. | pinned=false |  |
| inspector | pin | following | pin task | Keep this pane on this task while the rest of the app moves on. | pinned=true |  |
| inspector | pin | pinned | pin task | Pinned to this task. Click to follow the selection again. | pinned=false |  |
| wiki | pin | following | pin document | Keep this pane on this document while the rest of the app moves on. | pinned=true |  |
| wiki | pin | pinned | pin document | Pinned to this document. Click to follow the selection again. | pinned=false |  |
| asset | pin | following | pin asset | Keep this pane on this asset while the rest of the app moves on. | pinned=true |  |
| asset | pin | pinned | pin asset | Pinned to this asset. Click to follow the selection again. | pinned=false |  |

## Refused when

Never, in any fixture.

## Reached after

Nothing runs it as a later step of a click.

## Reaching it

- Sweep: a control or menu entry ran it in the sweep of 2026-09-21 at e3e2451.
- Palette-only rule: none.
- Shortcut: none.
- Menu: none.

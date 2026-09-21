# approvals

What the pane draws, by rule module and then by situation.

## approvals

### empty

Nothing needs approval, so no row is drawn.

Draws nothing.

### waiting

Three pictures wait: a plate, a portrait blocked upstream, and a shot frame; each row opens its picture.

| Control | Runs | Label | Verdict |
| --- | --- | --- | --- |
| `fx:popup.close#a1b2c3d4` | `popup.close` | [plate] Café Mori — night — plate:cafe/night | ok |
| `fx:popup.close#b2c3d4e5` | `popup.close` | [portrait] Aiko — portrait — portrait:aiko | ok |
| `fx:popup.close#c3d4e5f6` | `popup.close` | [shot] arrival — s1 — shot:arrival/s1 | ok |

/**
 * Whether a shot's art still illustrates the words it sits against. The rule moved to `@vn/stills`
 * (`script.proseDriftReported`), where the shot kind reports it to the solver; it is re-exported by
 * name so the document tree, the desktop session and the Shot Coverage pane, which ask about one
 * shot rather than a solved slot, still find it here.
 */
export { driftOf, proseHash } from '@vn/stills';

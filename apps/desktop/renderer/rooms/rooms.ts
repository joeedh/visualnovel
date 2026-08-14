/**
 * The retired room vocabulary, now local to the shell that still speaks it. A pane shows an
 * **editor**, so `src/shared/ipc.ts` names editors and nothing else; these three unions survive
 * here only because `--react` still boots the room shell, and they go when it does.
 *
 * Nothing in the main process imports this: command-driven navigation is `view.*` now, and the
 * room shell drives itself from its own tab nav.
 */

/** The three rooms of the retired shell. */
export type Room = 'studio' | 'floor' | 'play';

/** STUDIO's editors, back when an editor was a mode within a room. */
export type StudioMode = 'convo' | 'branches' | 'script';

/** FLOOR's, likewise. */
export type FloorMode = 'list' | 'graph' | 'timeline';

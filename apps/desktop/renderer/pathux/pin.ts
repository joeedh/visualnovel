/**
 * What a pinned editor reads instead of the shell's selection.
 *
 * A pane that follows the selection is the right default and the wrong one the moment an author
 * wants two of them: two scenes side by side, a sheet held open beside the scene that cites it.
 * Blender's answer is a pin, and this is the same idea — the pinned pane keeps looking at what it
 * was looking at, and the rest of the app carries on.
 *
 * The mechanism is one field, not a copy of the state: {@link PinField} names *which thing* the
 * pane is about, and only that read is frozen. Everything else — the project title, the busy
 * flags, and the rest of the selection — is still live, so a pinned Coverage holds its scene and
 * still highlights the selected shot.
 *
 * Pure, and with no `pathux` import, so the node-only jest project can hold the proxy's two rules
 * to account: the pinned field reads the pin, and a write **through** the pinned pane moves both.
 */
import type { PinField } from '../../src/shared/editors.js';
import type { ShellState } from './state.js';

/** The pinned value, and the way back to wherever the editor is keeping it. */
export interface Pin {
  field: PinField;
  get(): string;
  set(value: string): void;
}

/**
 * The shell state as a pinned editor sees it: the pinned field answers the pin, everything else
 * answers the shell.
 *
 * A write to the pinned field moves the pin **and** the shell. That is what keeps a pinned pane's
 * own controls working — the scene picker in a pinned Script would otherwise do nothing at all —
 * and it is the honest reading of what the author did: they chose a scene *in this pane*, so this
 * pane goes there and, since a selection is one thing the whole app shares, so does everyone
 * else. Pinning says "do not follow the others", not "do not move".
 */
export function pinnedView(live: ShellState, pin: Pin): ShellState {
  return new Proxy(live, {
    get(target, key, receiver): unknown {
      if (key === pin.field) return pin.get();
      return Reflect.get(target, key, receiver) as unknown;
    },
    // Deliberately without the receiver: the shell state's fields are its own, so writing
    // straight to it is the whole act, and handing the proxy back as the receiver would define
    // the property on the proxy instead of setting it on the state behind it.
    set(target, key, value): boolean {
      if (key === pin.field && typeof value === 'string') pin.set(value);
      return Reflect.set(target, key, value);
    },
  });
}

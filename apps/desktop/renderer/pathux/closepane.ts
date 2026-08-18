/**
 * Close Pane, as a gesture: the pane under the cursor is outlined and crossed out, a click
 * collapses it, Escape cancels. path.ux's `splitTool` is the analogue for the opposite act, and the
 * menu reaches this the same way — a shell act, not a command, because a modal pick cannot be
 * driven by an id and a props object.
 *
 * It is written here rather than reached for in path.ux, which has a `removeAreaTool` of its own,
 * because that one collapses whatever `findScreenArea` answers. This app has two rules about that
 * — the header is not a pane, and the last pane is kept — and they live in `panes.ts`, so the pick
 * has to be made against them. A pane that may not go is still outlined, in mist and with the
 * reason written across it: a picker that ignores the pointer is indistinguishable from a broken
 * one.
 *
 * The overlay is a throwaway `document.body` sibling for the reason `flash.ts` gives — a pane is a
 * `ScreenArea` whose children paint over its own border and whose sheet is in a shadow root this
 * file does not own.
 */
import type { ScreenArea } from 'pathux';
import { NO_PANE, paneClosable } from './panes.js';
import type { VnScreen } from './screen.js';
import { collapsePane, panesOf } from './view.js';

/** What the outline says, per verdict. Shown on the pane, because a modal has nothing to hover. */
const GOES = 'Click to close this pane';
const STAYS_CHROME = 'The menu bar is not a pane';
const STAYS_LAST = 'The last pane is kept';

/**
 * Start the pick. Returns once the modal is up; the gesture ends on a click, on Escape, or on any
 * button but the left one. `report` is handed the sentence the act produced, so the caller decides
 * where a notice goes — the header has one door for that and this file should not know it.
 */
export function pickPaneToClose(screen: VnScreen, report: (text: string) => void): void {
  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position: 'fixed',
    display: 'none',
    pointerEvents: 'none',
    zIndex: '9100',
    boxSizing: 'border-box',
    borderRadius: '4px',
    alignItems: 'center',
    justifyContent: 'center',
    font: '600 13px var(--sans)',
    letterSpacing: '0.04em',
    textAlign: 'center',
    padding: '8px',
  });
  document.body.appendChild(overlay);

  let index = NO_PANE;
  let done = false;

  const end = (): void => {
    if (done) return;
    done = true;
    overlay.remove();
    screen.popModal();
  };

  const finish = (): void => {
    // The verdict shown is the verdict taken: the same `paneClosable` call decided the outline the
    // author was looking at when they clicked, so there is nothing left to re-check here.
    const target = index;
    end();
    if (target === NO_PANE) {
      report('Nothing was closed — no pane was under the cursor.');
      return;
    }
    collapsePane(screen, target);
    report('Closed the pane.');
  };

  screen.pushModal({
    on_pointermove(e: PointerEvent) {
      const sarea = screen.findScreenArea(e.x, e.y) as ScreenArea | undefined;
      const panes = panesOf(screen);
      const at = sarea ? (screen.sareas as ScreenArea[]).indexOf(sarea) : NO_PANE;
      if (at === NO_PANE) {
        index = NO_PANE;
        overlay.style.display = 'none';
        return;
      }

      const closable = paneClosable(panes, at);
      index = closable ? at : NO_PANE;
      draw(
        overlay,
        (sarea as unknown as HTMLElement).getBoundingClientRect(),
        closable,
        why(panes, at),
      );
    },

    on_pointerdown(e: PointerEvent) {
      e.stopPropagation();
      e.preventDefault();
      if (e.button !== 0) {
        end();
        report('Cancelled.');
        return;
      }
      finish();
    },

    on_keydown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      end();
      report('Cancelled.');
    },
  });
}

/** The sentence a refused pane carries, which is the rule of `panes.ts` it fell foul of. */
function why(panes: ReturnType<typeof panesOf>, at: number): string {
  if (paneClosable(panes, at)) return GOES;
  return panes[at]?.chrome ? STAYS_CHROME : STAYS_LAST;
}

/**
 * Move the outline onto a pane. Vermilion and crossed out when it can go, mist when it cannot —
 * one look per verdict, so the answer is legible before the label is read.
 */
function draw(overlay: HTMLDivElement, rect: DOMRect, closable: boolean, label: string): void {
  const hue = closable ? 'var(--vermilion)' : 'var(--mist-dim)';
  Object.assign(overlay.style, {
    display: 'flex',
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    border: `3px solid ${hue}`,
    background: closable ? 'rgba(229, 83, 75, 0.16)' : 'rgba(90, 98, 113, 0.16)',
    color: closable ? 'var(--paper)' : 'var(--mist)',
  });
  overlay.replaceChildren(cross(rect, hue, closable), caption(label, closable));
}

/**
 * The X, at whatever size the pane allows. Hidden over a pane that cannot go, where a cross would
 * say the opposite of the mist around it.
 */
function cross(rect: DOMRect, hue: string, closable: boolean): SVGSVGElement {
  const span = Math.max(24, Math.min(rect.width, rect.height) * 0.45);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  Object.assign(svg.style, {
    position: 'absolute',
    width: `${span}px`,
    height: `${span}px`,
    opacity: closable ? '0.85' : '0',
  });
  for (const d of ['M14 14 L86 86', 'M86 14 L14 86']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', hue);
    path.setAttribute('stroke-width', '12');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('fill', 'none');
    svg.appendChild(path);
  }
  return svg;
}

/** The label, kept off the X so both stay readable in a pane the size of a sidebar. */
function caption(label: string, closable: boolean): HTMLDivElement {
  const box = document.createElement('div');
  box.textContent = label;
  Object.assign(box.style, {
    position: 'relative',
    maxWidth: '100%',
    padding: '4px 10px',
    borderRadius: '999px',
    background: 'rgba(10, 13, 18, 0.82)',
    color: closable ? 'var(--paper)' : 'var(--mist)',
  });
  return box;
}

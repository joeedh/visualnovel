/**
 * The header's problem count, opened as a popup: one fetch, one row per diagnostic. The ordering
 * and the two sentences a row needs are in `src/shared/diagnostics.ts`, where the node-only jest
 * project can reach them, so what is left here is widgets.
 *
 * Nothing here writes. Validation re-derives the whole diagnostic list on every index, so there is
 * no dismiss, no acknowledge and no filter to persist: a diagnostic clears when what it is about is
 * fixed, and it is gone on the next read. What a row does is `rules/diagnostics.ts`; the rows are
 * drawn through `act()` under a pass of the `diagnostics` anchor home, which is open while the
 * list is up.
 */
import { UIBase, type Container } from 'pathux';
import type { Diagnostic } from '@vn/types';
import {
  diagnosticDetail,
  diagnosticSummary,
  orderDiagnostics,
} from '../../../src/shared/diagnostics.js';
import { popupClose } from '../../../src/shared/effects.js';
import { api } from '../../api.js';
import { diagnosticScene, rowAction, rowText } from '../../rules/diagnostics.js';
import { exec, shell } from '../app/bridge.js';
import { visibleEditors } from '../panes/route.js';
import { panesOf } from '../panes/view.js';
import type { VnScreen } from '../app/screen.js';
import { onPopupClosed } from './popup.js';
import { popupClosed, popupOpened, redrawing, type AnchorPass } from '../tour/anchors.js';

/** What `Screen.popup` hands back: a container that also knows how to dismiss itself. */
type Popup = Container & { end(): void };

const WIDTH = 520;

let list: DiagnosticList | undefined;

class DiagnosticList {
  private readonly popup: Popup;
  private readonly body: Container;
  private diagnostics: Diagnostic[] = [];
  /** Scene ids, so a row can tell whether its `where` names a scene the author can be taken to. */
  private scenes: string[] = [];
  private read = false;
  private pass: AnchorPass = redrawing('diagnostics', 'list');

  constructor() {
    const screen = shell().screen;
    if (!screen) throw new Error('no screen to hang the diagnostics on');
    popupOpened('diagnostics');

    const x = Math.max(8, Math.round((screen.size[0] - WIDTH) / 2));
    this.popup = screen.popup(screen as unknown as UIBase, x, 40, false) as Popup;
    this.popup.style['width'] = `${WIDTH}px`;

    // Escape and a click outside never reach `close`, so the singleton is cleared when the popup
    // is removed rather than when it is dismissed.
    onPopupClosed(this.popup, () => {
      list = undefined;
      popupClosed('diagnostics');
    });

    this.body = this.popup.col();
    this.render();
    void this.refresh();
  }

  close(): void {
    this.popup.end();
  }

  /**
   * Refetched on open rather than read off `ShellState`, which carries only the two counts. The
   * list is drawn once empty first, so the popup appears under the click instead of after a
   * round trip.
   */
  private async refresh(): Promise<void> {
    const index = await api.invoke('workspace:index');
    this.diagnostics = orderDiagnostics(index.diagnostics);
    this.scenes = index.scenes.map((scene) => scene.id);
    this.read = true;
    this.render();
  }

  private render(): void {
    this.body.clear();
    this.pass = redrawing('diagnostics', 'list');

    const head = this.body.row();
    head.label('PROBLEMS');
    const summary = diagnosticSummary(this.diagnostics);
    if (summary) head.label(summary).description = 'Errors first, then warnings.';

    const rows = this.body.col();
    rows.style['overflowY'] = 'auto';
    // Bounded by the window as well as by a fixed height, as the notification list is: a list that
    // runs off the bottom of a short screen has no scrollbar the author can reach
    rows.style['maxHeight'] = 'min(420px, 60vh)';

    if (this.diagnostics.length === 0) {
      rows.label(this.read ? 'Nothing is wrong with the project.' : 'Reading the project…');
    }
    for (const diagnostic of this.diagnostics) this.row(rows, diagnostic);

    this.body.flushUpdate();
  }

  /**
   * One diagnostic, and a way in where there is one. `where` is an entity id rather than a scene
   * id, and a scene diagnostic can name a scene that does not exist (`start:` pointing at nothing
   * is one), so `diagnosticScene` decides which rows become clickable. The rest are labels.
   */
  private row(rows: Container, diagnostic: Diagnostic): void {
    const row = rows.row();
    // A flex child shrinks before its parent scrolls, so a row without this is squeezed instead of
    // scrolled — the same fix the notification list needed
    row.style['flexShrink'] = '0';
    const text = rowText(diagnostic);

    const scene = diagnosticScene(diagnostic, this.scenes);
    if (scene === null) {
      row.label(text).description = diagnosticDetail(diagnostic);
      return;
    }

    const offer = rowAction(diagnostic, scene, this.visible());
    this.pass.act(
      row.button(text, () => {}),
      offer,
      () => this.goto(diagnostic, scene),
    );
  }

  /** The editors some pane is showing, which decides whether the scene opens here or elsewhere. */
  private visible(): ReturnType<typeof visibleEditors> {
    const screen = shell().screen as VnScreen | undefined;
    return visibleEditors(screen ? panesOf(screen) : []);
  }

  /**
   * Show the scene a row is about, then close the popup. The offer is read again here rather than
   * kept from the draw, because a pane opened since then changes where the scene goes.
   */
  private goto(diagnostic: Diagnostic, scene: string): void {
    const offer = rowAction(diagnostic, scene, this.visible());
    if (!offer.ok) return;
    const ui = shell().ui;
    ui.sceneId = String(offer.props['sceneId'] ?? '');
    ui.shotId = '';
    shell().api.notifyChange();
    for (const next of offer.then ?? []) {
      if (next.id === popupClose.id) this.close();
      else void exec(next.id, next.props);
    }
  }
}

/** Open the list, or close it when it is already open, so the badge never opens a second popup. */
export function openDiagnostics(): void {
  if (list) {
    list.close();
    return;
  }
  list = new DiagnosticList();
}

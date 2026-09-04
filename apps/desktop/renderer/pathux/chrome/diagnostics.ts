/**
 * The header's problem count, opened as a popup: one fetch, one row per diagnostic. The ordering
 * and the two sentences a row needs are in `src/shared/diagnostics.ts`, where the node-only jest
 * project can reach them, so what is left here is widgets.
 *
 * Nothing here writes. Validation re-derives the whole diagnostic list on every index, so there is
 * no dismiss, no acknowledge and no filter to persist: a diagnostic clears when what it is about is
 * fixed, and it is gone on the next read.
 */
import { UIBase, type Container } from 'pathux';
import type { Diagnostic } from '@vn/types';
import {
  diagnosticDetail,
  diagnosticSummary,
  orderDiagnostics,
} from '../../../src/shared/diagnostics.js';
import { api } from '../../api.js';
import { diagnosticScene } from '../../rules/diagnostics.js';
import { shell } from '../app/bridge.js';
import { openNode } from '../panes/open.js';
import type { VnScreen } from '../app/screen.js';

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

  constructor() {
    const screen = shell().screen;
    if (!screen) throw new Error('no screen to hang the diagnostics on');

    const x = Math.max(8, Math.round((screen.size[0] - WIDTH) / 2));
    this.popup = screen.popup(screen as unknown as UIBase, x, 40, false) as Popup;
    this.popup.style['width'] = `${WIDTH}px`;

    const end = this.popup.end.bind(this.popup);
    this.popup.end = () => {
      list = undefined;
      end();
    };

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
    const mark = diagnostic.severity === 'error' ? '●' : '○';
    const where = diagnostic.where ? ` (${diagnostic.where})` : '';
    const text = `${mark} ${diagnostic.message}${where}`;

    const scene = diagnosticScene(diagnostic, this.scenes);
    if (scene === null) {
      row.label(text).description = diagnosticDetail(diagnostic);
      return;
    }

    const open = row.button(text, () => {
      this.goto(scene);
    });
    open.description = `${diagnosticDetail(diagnostic)} · click to open ${scene}`;
  }

  /** Show the scene a row is about, then close the popup. */
  private goto(scene: string): void {
    const ui = shell().ui;
    ui.sceneId = scene;
    ui.shotId = '';
    shell().api.notifyChange();
    openNode(shell().screen as VnScreen | undefined, {
      id: `scene:${scene}`,
      kind: 'scene',
      label: scene,
    });
    this.close();
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

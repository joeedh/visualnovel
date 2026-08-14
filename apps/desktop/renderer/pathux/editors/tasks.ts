import type { Container } from 'pathux';
import { api } from '../../api.js';
import { subjectOf } from '../../rooms/floor/taskGraph.js';
import { card, dot, mono, note, row, stamp, statusColour, subject } from '../dom.js';
import { VnEditor, registerEditor } from '../editor.js';
import { openPalette } from '../palette.js';
import { selectionForTask, taskIsSelected, type Selection } from '../selection.js';
import { TOKENS, alpha } from '../tokens.js';
import type { PipelineStatus, Task } from '../../../src/shared/ipc.js';

/**
 * The task list: one card per node of the content-addressed graph, for scanning rather than for
 * structure. It is the React `TaskBoard` plus the gate bars that sat above it — the same
 * material the graph editor draws, in the shape you read down a column.
 *
 * It does not own a selection. Clicking a card publishes `ui.taskHash` and, through the shared
 * rule, whatever authored ids the task names — so the inspector, the graph and the runner all
 * follow one click, and a task picked in the graph is highlighted here without either editor
 * knowing the other exists.
 */
export class TaskListEditor extends VnEditor {
  private bar!: Container;
  private list!: HTMLDivElement;

  private status: PipelineStatus | undefined;
  private failure = '';
  private drawn = '';

  static override define() {
    return {
      tagname: 'vn-tasks-editor-x',
      areaname: 'tasklist',
      uiname: 'Tasks',
      icon: -1,
    };
  }

  override init() {
    super.init();

    this.bar = (this.header as Container).row();

    this.list = document.createElement('div');
    Object.assign(this.list.style, {
      position: 'relative',
      overflowY: 'auto',
      background: TOKENS.inkSunken,
      padding: '8px',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
    });
    this.appendSurface(this.list);

    void this.load();
  }

  override update() {
    super.update();

    if (this.stateKey() !== this.drawn) this.rebuild();
  }

  private async load(): Promise<void> {
    try {
      this.status = await api.invoke('pipeline:status');
      this.failure = '';
    } catch (err) {
      this.failure = err instanceof Error ? err.message : String(err);
    }
    this.rebuild();
  }

  private selection(): Selection {
    const ui = this.ui;
    return { sceneId: ui.sceneId, shotId: ui.shotId, characterId: ui.characterId };
  }

  private stateKey(): string {
    const ui = this.ui;
    return [
      this.failure,
      this.status?.tasks.length ?? -1,
      this.status?.gatePending.join(',') ?? '',
      ui.taskHash,
      ui.sceneId,
      ui.shotId,
      ui.characterId,
    ].join('|');
  }

  private rebuild(): void {
    this.drawn = this.stateKey();
    this.rebuildBar();
    this.rebuildList();
  }

  private rebuildBar(): void {
    const tasks = this.status?.tasks ?? [];
    const running = tasks.filter((t) => t.status === 'running').length;

    this.bar.clear();
    this.bar.label('TASKS').style['padding'] = '0px 8px';
    this.bar.label(
      this.failure
        ? this.failure
        : `${tasks.length} task${tasks.length === 1 ? '' : 's'} · ${running} running${
            this.status?.blockedOnGate ? ' · blocked on gate' : ''
          }`,
    ).style['padding'] = '0px 8px';

    // A run spends money and writes assets, so it goes through the palette's form and its
    // confirmation rather than off a bare button — `pipeline.run` is gated on the command.
    this.bar.button('▸ Run', () => openPalette('pipeline.run'));
    this.bar.button('Refresh', () => void this.load());
    this.bar.flushUpdate();
  }

  private rebuildList(): void {
    this.list.textContent = '';

    if (this.failure) return void this.list.appendChild(note(this.failure, TOKENS.vermilion));

    const tasks = this.status?.tasks ?? [];
    for (const character of this.status?.gatePending ?? []) {
      this.list.appendChild(this.gateBar(character));
    }
    if (tasks.length === 0) {
      this.list.appendChild(note('No tasks yet — run the pipeline.'));
      return;
    }

    const selection = this.selection();
    for (const task of tasks) this.list.appendChild(this.taskCard(task, selection));
  }

  /** The gate, as the one thing standing between the author and the rest of the run. */
  private gateBar(character: string): HTMLElement {
    const bar = card();
    Object.assign(bar.style, {
      flexDirection: 'row',
      alignItems: 'center',
      gap: '10px',
      border: `1px dashed ${alpha(TOKENS.sodium, 0.55)}`,
      background: TOKENS.ink,
      flex: 'none',
    });

    bar.appendChild(stamp('⟂ GATE', TOKENS.sodium));
    bar.appendChild(mono(`awaiting portrait approval for ${character}`, TOKENS.mist, 11));

    const cta = document.createElement('button');
    cta.textContent = 'RESOLVE →';
    Object.assign(cta.style, {
      marginLeft: 'auto',
      cursor: 'pointer',
      padding: '3px 9px',
      color: TOKENS.paper,
      background: TOKENS.inkRaised,
      border: `1px solid ${TOKENS.inkLine}`,
      borderRadius: `${TOKENS.radiusChrome}px`,
      fontFamily: TOKENS.mono,
      fontSize: '11px',
    });
    cta.addEventListener('click', () => {
      this.ui.characterId = character;
      this.announce();
      openPalette('gate.approve', { characterId: character });
    });
    bar.appendChild(cta);
    return bar;
  }

  private taskCard(task: Task, selection: Selection): HTMLElement {
    const colour = statusColour(task.status);
    const box = card();
    Object.assign(box.style, { flex: 'none', cursor: 'pointer' });
    box.style.borderLeft = `2px solid ${colour}`;
    // Two different questions, so two different marks: the ring is the task the inspector is
    // open on, the tint is everything else the shared selection is about.
    if (this.ui.taskHash === task.hash) {
      box.style.borderColor = TOKENS.signal;
      box.style.boxShadow = `0 0 0 1px ${TOKENS.signalDeep}`;
      box.style.borderLeftColor = colour;
    } else if (taskIsSelected(task, selection)) {
      box.style.background = alpha(TOKENS.signal, 0.06);
    }

    const head = row();
    head.appendChild(dot(colour));
    head.appendChild(mono(task.kind, TOKENS.mist, 11));
    const status = mono(task.status, colour, 10);
    status.style.marginLeft = 'auto';
    head.appendChild(status);
    head.appendChild(mono(task.hash.slice(0, 8), TOKENS.mistDim, 10));

    box.appendChild(head);
    box.appendChild(subject(subjectOf(task), TOKENS.paper));

    box.addEventListener('click', () => this.select(task));
    return box;
  }

  private select(task: Task): void {
    this.ui.taskHash = task.hash;

    const current = this.selection();
    const next = selectionForTask(task, current);
    if (next !== current) {
      this.ui.sceneId = next.sceneId;
      this.ui.shotId = next.shotId;
      this.ui.characterId = next.characterId;
    }
    this.announce();
  }
}

registerEditor(TaskListEditor, 'vn.TaskListEditor');

import type { Check, Container } from 'pathux';
import { api } from '../../api.js';
import { exec, onBusy, onInvalidate } from '../bridge.js';
import { subjectOf } from '../../rules/taskGraph.js';
import { emptyBecause, showing, type ListFilter } from '../../rules/tasklist.js';
import { card, dot, mono, note, row, stamp, statusColour, subject } from '../dom.js';
import { VnEditor, registerEditor } from '../editor.js';
import { openCommandDialog } from '../dialog.js';
import { layoutChanged } from '../persist.js';
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
  /** Rising with every fetch, so a slow answer that arrived out of order is dropped. */
  private token = 0;
  /** Remembered per pane: whether the list is narrowed to what has already finished. */
  onlyDone = false;
  /** Remembered per pane: whether the list is narrowed to what is moving right now. */
  onlyRunning = false;
  /**
   * Hashes the author cleared out of the *list*. Nothing is deleted: a `done` record is what
   * makes a run resumable, so pruning `tasks.jsonl` would re-render — and re-pay for — every
   * picture it named. A task that comes back to life is drawn again.
   */
  private cleared = new Set<string>();

  /** A task in a state nothing will move it out of without a new run. */
  private static finished(task: Task): boolean {
    return task.status === 'done' || task.status === 'failed' || task.status === 'needs_human';
  }

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

    // A column of two rows rather than one long row: the bar carries a sentence of counts and
    // five controls, and in one row the last of them falls off the end of a half-width pane.
    this.bar = (this.header as Container).col();

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

    // Two feeds, because they answer different questions. `onInvalidate` is every mutating
    // command and every undo — an approval, an adoption, a regenerate — and arrives once the work
    // is over. `onBusy` is the only thing that moves *during* a run, which is what makes a task
    // actually appear here as `running` rather than only after it has stopped being one.
    this.watch(
      () => onInvalidate(() => void this.load()),
      () => void this.load(),
    );
    this.watch(() => onBusy(() => void this.load()));

    void this.load();
  }

  override update() {
    super.update();

    if (this.stateKey() !== this.drawn) this.rebuild();
  }

  private async load(): Promise<void> {
    const mine = ++this.token;
    try {
      const status = await api.invoke('pipeline:status');
      if (mine !== this.token) return;
      this.status = status;
      this.failure = '';
    } catch (err) {
      if (mine !== this.token) return;
      this.failure = err instanceof Error ? err.message : String(err);
    }
    this.rebuild();
  }

  /** What the two controls in the bar are set to, as the pure rules want to be asked. */
  private filter(): ListFilter {
    return { cleared: this.cleared, onlyDone: this.onlyDone, onlyRunning: this.onlyRunning };
  }

  private showing(): Task[] {
    return showing(this.status?.tasks ?? [], this.filter());
  }

  private selection(): Selection {
    const ui = this.ui;
    return {
      sceneId: ui.sceneId,
      shotId: ui.shotId,
      characterId: ui.characterId,
      docPath: ui.docPath,
      assetHash: ui.assetHash,
    };
  }

  private stateKey(): string {
    const ui = this.ui;
    return [
      this.failure,
      // Statuses, not a count: a wave that moves five tasks from `pending` to `running` changes
      // nothing about the length, and a list that redrew only on the count would never show it.
      (this.status?.tasks ?? []).map((t) => `${t.hash.slice(0, 8)}:${t.status}`).join(','),
      this.status?.gatePending.join(',') ?? '',
      this.onlyDone ? 'done-only' : 'all',
      this.onlyRunning ? 'running-only' : 'all',
      this.cleared.size,
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
    const hidden = tasks.length - this.showing().length;

    this.bar.clear();
    // Row one is what the list *is*; row two is what to do about it.
    const top = this.bar.row();
    const low = this.bar.row();

    top.label('TASKS').style['padding'] = '0px 8px';
    top.label(
      this.failure
        ? this.failure
        : `${tasks.length} task${tasks.length === 1 ? '' : 's'} · ${running} running${
            hidden > 0 ? ` · ${hidden} not shown` : ''
          }${this.status?.blockedOnGate ? ' · blocked on gate' : ''}`,
    ).style['padding'] = '0px 8px';

    // A run spends money and writes assets, so it goes through the palette's form and its
    // confirmation rather than off a bare button — `pipeline.run` is gated on the command.
    low.button('▸ Run', () => openCommandDialog('pipeline.run')).description =
      'Open the run form, where the flags are spelled out before anything is spent';

    const only = low.check(undefined, 'only done') as Check;
    only.checked = this.onlyDone;
    only.description = 'Narrow the list to the tasks that finished successfully.';
    // `on_change`, not `onchange` — path.ux's own hook. A DOM-shaped name is never called.
    only.on_change = (next: unknown) => {
      this.onlyDone = next === true;
      layoutChanged();
      this.rebuild();
    };

    // Its own tick rather than a third state of `only done`: the two are disjoint, so what an
    // author wants while a wave is in flight is the *running* half, not a mode switch away from
    // the one they left on. Ticking both shows nothing, and `emptyBecause` says so by name.
    const moving = low.check(undefined, 'only running') as Check;
    moving.checked = this.onlyRunning;
    moving.description = 'Narrow the list to the tasks a wave is working on right now.';
    moving.on_change = (next: unknown) => {
      this.onlyRunning = next === true;
      layoutChanged();
      this.rebuild();
    };

    const clear = low.button('Clear finished', () => {
      for (const task of tasks) if (TaskListEditor.finished(task)) this.cleared.add(task.hash);
      this.rebuild();
    });
    // A greyed control that will not say why is the same bug as a hidden one, so the two
    // sentences are chosen together: what it would do, or why it cannot.
    clear.disabled = !tasks.some((t) => TaskListEditor.finished(t) && !this.cleared.has(t.hash));
    clear.description = clear.disabled
      ? 'Nothing finished is left in the list to take out of it.'
      : 'Take everything already finished out of this list. Nothing is deleted — those records ' +
        'are what make a run resumable — and Refresh brings them back.';

    const refresh = low.button('Refresh', () => {
      this.cleared.clear();
      void this.load();
    });
    refresh.description =
      'Re-read what has run, what is running and what is ready, and undo Clear finished';
    this.bar.flushUpdate();
  }

  private rebuildList(): void {
    this.list.textContent = '';

    if (this.failure) return void this.list.appendChild(note(this.failure, TOKENS.vermilion));

    const all = this.status?.tasks ?? [];
    const tasks = this.showing();
    for (const character of this.status?.gatePending ?? []) {
      this.list.appendChild(this.gateBar(character));
    }
    if (tasks.length === 0) {
      this.list.appendChild(note(emptyBecause(all, this.filter())));
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
    cta.title = `Approve ${character}'s portrait, which is what the rest of the run is waiting on`;
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
      openCommandDialog('gate.approve', { characterId: character });
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
    // A task that stopped records why, and this is the surface built for scanning — so the
    // reason belongs on the card rather than one click away in the inspector's attempt list,
    // which is not where an author looking for what went wrong starts.
    if (task.error) {
      const why = subject(task.error, TOKENS.vermilion);
      why.title = task.error;
      box.appendChild(why);
    }

    const drew = TaskListEditor.drewAsset(task);
    box.title = drew
      ? `Open what this ${task.kind} drew in the asset editor — every other pane follows the pick`
      : `Inspect this ${task.kind} — every other pane follows the pick`;
    box.addEventListener('click', () => this.select(task));
    return box;
  }

  /**
   * The asset hash a task left behind, or `undefined`. Only a `done` task has one worth opening:
   * `output` is written when the runner accepts a picture, and a task that failed after an
   * attempt produced bytes is one whose bytes nothing downstream is allowed to use.
   */
  private static drewAsset(task: Task): string | undefined {
    return task.status === 'done' && task.output ? task.output : undefined;
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

    // A finished task *is* its picture, and the list is where an author watches one arrive — so
    // the click that picks it also puts it on screen. Through `view.open` rather than by setting
    // `ui.assetHash` here: the command is what finds or raises a pane, and what records the act.
    // `elsewhere`, so the list the author is scanning is not the pane that gets replaced.
    const drew = TaskListEditor.drewAsset(task);
    if (drew) void exec('view.open', { editor: 'asset', where: 'elsewhere', subject: drew });
  }
}

registerEditor(TaskListEditor, 'vn.TaskListEditor', ['onlyDone : bool', 'onlyRunning : bool']);

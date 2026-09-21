import type { Container } from 'pathux';
import { exec, onInvalidate } from '../app/bridge.js';
import { VnEditor, registerEditor } from '../app/editor.js';
import { layoutChanged } from '../app/persist.js';
import { redrawing } from '../tour/anchors.js';
import {
  backAction,
  checkpointsAction,
  clearAction,
  emptySentence,
  groupByDay,
  MAKER_SAYS,
  moreAction,
  NO_FILTER,
  pathAction,
  reloadAction,
  repoAction,
  resolvePath,
  rowAction,
  searchBox,
  shown,
  statusSentence,
  stripSentence,
  timeOf,
  WHO_ROWS,
  whoAction,
  type HistoryFilter,
  type HistoryState,
} from '../../rules/history.js';
import {
  KIND_ORDER,
  kindOf,
  REPO_ROLES,
  type FileKind,
  type HistoryPage,
  type Maker,
  type RepoEntry,
  type RepoRole,
  type RepoStatus,
  type Save,
} from '../../../src/shared/history.js';
import HISTORY_CSS from '../../styles/history.css?inline';

/** Below this width the pane is one column; below `LARGE` the list column is the narrower one. */
const SMALL = 560;
const LARGE = 900;
/** How long a read may take before the pane says it is still reading. */
const SLOW_MS = 150;
/** How often the status is asked again while a deferred batch is still waiting to be saved. */
const PENDING_POLL_MS = 1500;

/** What the file list heads each kind with. */
const KIND_SAYS: Record<FileKind, string> = {
  picture   : 'Pictures',
  scene     : 'Scenes',
  sheet     : 'Characters and locations',
  wiki      : 'Wiki',
  storyboard: 'Storyboards and graphs',
  project   : 'Project files',
  other     : 'Other files',
  log       : 'Logs',
};

/**
 * Every save of the project, newest first, and what each one changed. It reads through the
 * `git.*` commands and writes nothing: the recovery controls arrive with their commands.
 *
 * The list follows `ui.docPath` the way the Wiki pane does, so clicking a document in the tree
 * narrows this pane to that document's saves, and a pinned History pane is one file's history.
 * The chip that names the file takes the filter off again without touching the selection, so
 * the wiki pane beside it stays where it is.
 */
export class HistoryEditor extends VnEditor {
  private surface!: HTMLDivElement;
  private strip!: HTMLDivElement;
  private filters!: HTMLDivElement;
  private search!: HTMLInputElement;
  private status!: HTMLDivElement;
  private rows!: HTMLDivElement;
  private more!: HTMLDivElement;
  private detail!: HTMLDivElement;
  private foot!: HTMLDivElement;

  /** Which repository the list shows, remembered with the pane. */
  private repo: RepoRole = 'project';
  private filter: HistoryFilter = { ...NO_FILTER };
  private repos: RepoEntry[] = [];
  private repoStatus: RepoStatus | undefined;
  private saves: Save[] = [];
  private next: string | null = null;
  private selected: string | undefined;
  private narrow = false;
  private showingDetail = false;

  /** What `ui.docPath` was the last time the pane looked, so only a change narrows the list. */
  private seenDocPath: string | undefined;
  /** Rising with every read, so a slow answer for a filter that has moved on is dropped. */
  private token = 0;
  private reading = false;
  private slowTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private failure = '';
  private drawn = '';

  static override define() {
    return {
      tagname : 'vn-history-editor-x',
      areaname: 'history',
      icon    : -1,
    };
  }

  override init() {
    super.init();

    const bar = (this.header as Container).row();
    bar.label('HISTORY').style['padding'] = '0px 8px';
    // Its own pass: the button is built once with the pane, so a record in a redrawn pass would
    // be dropped by that pass's next paint
    const reload = reloadAction();
    redrawing('history', 'reload').act(
      bar.button(reload.label, () => {}),
      reload,
      () => void this.load(),
    );
    this.pinToggle(bar);
    bar.flushUpdate();

    this.adoptStyle(HISTORY_CSS);
    this.surface = el('div', 'hs-surface') as HTMLDivElement;
    this.strip = el('div', 'hs-strip') as HTMLDivElement;
    this.filters = el('div', 'hs-filters') as HTMLDivElement;
    const body = el('div', 'hs-body');
    const list = el('div', 'hs-list');
    this.status = el('div', 'hs-status') as HTMLDivElement;
    this.rows = el('div', 'hs-rows') as HTMLDivElement;
    this.more = el('div', 'hs-more') as HTMLDivElement;
    list.append(this.status, this.rows, this.more);
    this.detail = el('div', 'hs-detail') as HTMLDivElement;
    body.append(list, this.detail);
    this.foot = el('div', 'hs-foot') as HTMLDivElement;
    this.surface.append(this.strip, this.filters, body, this.foot);
    this.appendSurface(this.surface);

    this.watch(() => {
      const observer = new ResizeObserver(([entry]) => {
        const width = entry?.contentRect.width;
        if (width !== undefined) this.resized(width);
      });
      observer.observe(this.surface);
      return () => observer.disconnect();
    });

    // Every mutating command commits before its outcome returns, so the list is stale the moment
    // one lands. A deferred batch commits later; the status poll below catches that one.
    this.watch(
      () => onInvalidate(() => void this.load()),
      () => void this.load(),
    );

    void this.load();
  }

  override update() {
    super.update();
    this.followDocPath();
    if (this.stateKey() !== this.drawn) this.rebuild();
  }

  override on_remove(): void {
    this.stopPolling();
    super.on_remove();
  }

  // -------------------------------------------------------------------------
  // Remembered with the pane
  // -------------------------------------------------------------------------

  /** The repository and the filters that are a standing choice; the search box is not one. */
  override saveData() {
    return {
      ...super.saveData(),
      repo           : this.repo,
      who            : this.filter.who,
      checkpointsOnly: this.filter.checkpointsOnly,
    };
  }

  override loadData(obj: Record<string, unknown>): this {
    super.loadData(obj);
    const repo = obj['repo'];
    if (typeof repo === 'string' && (REPO_ROLES as readonly string[]).includes(repo)) {
      this.repo = repo as RepoRole;
    }
    const who = obj['who'];
    if (typeof who === 'string' && WHO_ROWS.some((row) => row.id === who)) {
      this.filter = { ...this.filter, who: who as Maker | '' };
    }
    if (typeof obj['checkpointsOnly'] === 'boolean') {
      this.filter = { ...this.filter, checkpointsOnly: obj['checkpointsOnly'] };
    }
    void this.load();
    return this;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /**
   * Narrow the list to the selected document when the selection moves. The first sighting
   * counts: `view.open(editor='history' subject=…)` publishes the subject before the pane's
   * first frame, and a pane opened that way must open narrowed.
   */
  private followDocPath(): void {
    const docPath = this.ui.docPath;
    if (docPath === this.seenDocPath) return;
    this.seenDocPath = docPath;
    if (docPath === '' || docPath === this.filter.path) return;
    this.setFilter({ ...this.filter, path: docPath });
  }

  private state(): HistoryState {
    return {
      repos : this.repos,
      repo  : this.repo,
      filter: this.filter,
      ...(this.repoStatus === undefined ? {} : { status: this.repoStatus }),
      saves: shown(this.saves, this.filter),
      next : this.next,
      ...(this.selected === undefined ? {} : { selected: this.selected }),
      narrow       : this.narrow,
      showingDetail: this.showingDetail,
    };
  }

  /** Read everything the pane draws: the repositories, the status and the first page. */
  private async load(): Promise<void> {
    const mine = ++this.token;
    this.beginReading();
    try {
      const repos = await this.read<RepoEntry[]>('git.repos');
      if (mine !== this.token) return;
      this.repos = repos;
      if (!repos.some((entry) => entry.role === this.repo)) this.repo = 'project';
      // A file inside the story bible's own repository is listed from there
      const resolved = resolvePath(repos, this.filter.path);
      if (this.filter.path !== '' && resolved.repo !== this.repo) this.repo = resolved.repo;
      if (repos.length === 0) {
        this.repoStatus = undefined;
        this.saves = [];
        this.next = null;
        this.failure = '';
        return;
      }
      const [status, page] = await Promise.all([
        this.read<RepoStatus>('git.status', { repo: this.repo }),
        this.read<HistoryPage>('git.history', this.query()),
      ]);
      if (mine !== this.token) return;
      this.repoStatus = status;
      this.saves = page.saves;
      this.next = page.next;
      this.failure = '';
      if (this.selected !== undefined && !this.saves.some((s) => s.sha === this.selected)) {
        this.selected = undefined;
        this.showingDetail = false;
      }
      this.pollWhilePending();
    } catch (err) {
      if (mine !== this.token) return;
      this.failure = err instanceof Error ? err.message : String(err);
    } finally {
      if (mine === this.token) this.endReading();
    }
    this.rebuild();
  }

  /** Read the next page and add it under the last. */
  private async loadMore(): Promise<void> {
    if (this.next === null) return;
    const mine = ++this.token;
    this.beginReading();
    try {
      const page = await this.read<HistoryPage>('git.history', {
        ...this.query(),
        before: this.next,
      });
      if (mine !== this.token) return;
      this.saves = [...this.saves, ...page.saves];
      this.next = page.next;
      this.failure = '';
    } catch (err) {
      if (mine !== this.token) return;
      this.failure = err instanceof Error ? err.message : String(err);
    } finally {
      if (mine === this.token) this.endReading();
    }
    this.rebuild();
  }

  /**
   * Ask for the status again while a batch is waiting to be saved, and re-read the list once it
   * has been, since that commit lands after the outcome that raised the last invalidation.
   */
  private pollWhilePending(): void {
    this.stopPolling();
    if (this.repoStatus?.cause !== 'pending') return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.read<RepoStatus>('git.status', { repo: this.repo }).then(
        (status) => {
          if (status.cause === 'pending') {
            this.repoStatus = status;
            this.rebuild();
            this.pollWhilePending();
          } else {
            void this.load();
          }
        },
        () => {},
      );
    }, PENDING_POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private query(): Record<string, string> {
    return {
      repo: this.repo,
      who : this.filter.who,
      path: resolvePath(this.repos, this.filter.path).path,
      text: this.filter.text,
    };
  }

  private async read<T>(id: string, props: Record<string, string> = {}): Promise<T> {
    const outcome = await exec(id, props);
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.data as T;
  }

  /** Dim the pane and say so, but only once a read has taken longer than `SLOW_MS`. */
  private beginReading(): void {
    if (this.slowTimer !== undefined) clearTimeout(this.slowTimer);
    this.slowTimer = setTimeout(() => {
      this.slowTimer = undefined;
      this.reading = true;
      this.rebuildFoot();
      this.surface.classList.add('reading');
    }, SLOW_MS);
  }

  private endReading(): void {
    if (this.slowTimer !== undefined) clearTimeout(this.slowTimer);
    this.slowTimer = undefined;
    this.reading = false;
    this.surface.classList.remove('reading');
  }

  // -------------------------------------------------------------------------
  // Changing what is shown
  // -------------------------------------------------------------------------

  private setRepo(repo: RepoRole): void {
    if (repo === this.repo) return;
    this.repo = repo;
    // The file chip names a file in one repository, so it comes off when another is chosen
    if (resolvePath(this.repos, this.filter.path).repo !== repo) {
      this.filter = { ...this.filter, path: '' };
    }
    this.selected = undefined;
    this.showingDetail = false;
    layoutChanged();
    void this.load();
  }

  /** Change the filters and read again; the checkpoint tick alone is applied without a read. */
  private setFilter(filter: HistoryFilter): void {
    const before = this.filter;
    this.filter = filter;
    const remembered =
      before.who !== filter.who || before.checkpointsOnly !== filter.checkpointsOnly;
    if (remembered) layoutChanged();
    const rereads =
      before.who !== filter.who || before.path !== filter.path || before.text !== filter.text;
    if (rereads) void this.load();
    else this.rebuild();
  }

  private select(sha: string): void {
    this.selected = sha;
    this.showingDetail = true;
    this.rebuild();
  }

  private resized(width: number): void {
    const size = width < SMALL ? 'small' : width < LARGE ? 'mid' : 'large';
    if (this.surface.dataset['size'] !== size) this.surface.dataset['size'] = size;
    const narrow = size === 'small';
    if (narrow === this.narrow) return;
    this.narrow = narrow;
    this.rebuild();
  }

  private stateKey(): string {
    return [
      this.repo,
      this.filter.who,
      this.filter.path,
      this.filter.text,
      this.filter.checkpointsOnly,
      this.token,
      this.selected,
      this.narrow,
      this.showingDetail,
      this.failure,
    ].join('|');
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private rebuild(): void {
    this.drawn = this.stateKey();
    const state = this.state();
    this.surface.classList.toggle('detail', state.narrow && state.showingDetail);
    this.rebuildStrip(state);
    this.rebuildFilters(state);
    this.rebuildList(state);
    this.rebuildDetail(state);
    this.rebuildFoot();
  }

  private rebuildStrip(state: HistoryState): void {
    this.strip.textContent = '';
    const anchors = redrawing('history', 'strip');
    if (state.repos.length > 1) {
      const chooser = el('div', 'hs-repos');
      for (const entry of state.repos) {
        const offer = repoAction(entry, state.repo);
        const segment = el('button', 'hs-repo', offer.label) as HTMLButtonElement;
        segment.classList.toggle('current', entry.role === state.repo);
        chooser.appendChild(anchors.act(segment, offer, () => this.setRepo(entry.role)));
      }
      this.strip.appendChild(chooser);
    }
    const entry = state.repos.find((r) => r.role === state.repo);
    const line = el('div', 'hs-strip-line', stripSentence(entry, state.status, state.narrow));
    line.title = entry ? entry.root : '';
    this.strip.appendChild(line);
  }

  private rebuildFilters(state: HistoryState): void {
    const focused =
      this.filters.contains(this.surface.ownerDocument.activeElement) ||
      (this.search !== undefined && this.search.matches(':focus'));
    this.filters.textContent = '';
    const anchors = redrawing('history', 'filters');
    const { filter } = state;

    // A native select rather than a path.ux menu: the row is raw DOM, and a select's rows carry
    // their own tooltips. The offer is recorded because the change is the select's own.
    const who = document.createElement('select');
    who.className = 'hs-who';
    for (const row of WHO_ROWS) {
      const option = document.createElement('option');
      option.value = row.id;
      option.textContent = row.label;
      option.title = row.tooltip;
      option.selected = row.id === filter.who;
      who.appendChild(option);
    }
    who.addEventListener('change', () => {
      this.setFilter({ ...this.filter, who: who.value as Maker | '' });
    });
    this.filters.appendChild(anchors.record(who, whoAction(filter.who)));

    const path = pathAction(filter.path);
    const chip = el('button', 'hs-path') as HTMLButtonElement;
    chip.classList.toggle('off', filter.path === '');
    chip.appendChild(el('span', '', path.label));
    if (filter.path !== '') chip.appendChild(el('span', 'hs-path-x', '×'));
    this.filters.appendChild(
      anchors.act(chip, path, () => this.setFilter({ ...this.filter, path: '' })),
    );

    const tick = el('label', 'hs-check') as HTMLLabelElement;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = filter.checkpointsOnly;
    box.addEventListener('change', () => {
      this.setFilter({ ...this.filter, checkpointsOnly: box.checked });
    });
    const checkpoints = checkpointsAction(filter.checkpointsOnly);
    tick.append(box, el('span', '', checkpoints.label));
    this.filters.appendChild(anchors.record(tick, checkpoints));

    // Rebuilt with the row, so the caret is put back when the rebuild was the box's own doing
    const search = document.createElement('input');
    search.className = 'hs-search';
    search.placeholder = searchBox('').label;
    search.value = filter.text;
    search.addEventListener('change', () => {
      this.setFilter({ ...this.filter, text: search.value.trim() });
    });
    // The screen keymap is a bubble-phase window listener, so a box that does not stop its own
    // keys hands Ctrl+Z and the shell's other gestures away mid-edit.
    search.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') this.setFilter({ ...this.filter, text: search.value.trim() });
      if (event.key === 'Escape' && search.value !== '') {
        search.value = '';
        this.setFilter({ ...this.filter, text: '' });
      }
    });
    this.search = search;
    this.filters.appendChild(anchors.record(search, searchBox(filter.text)));

    const clear = clearAction(filter);
    this.filters.appendChild(
      anchors.act(el('button', 'hs-btn', clear.label) as HTMLButtonElement, clear, () =>
        this.setFilter({ ...NO_FILTER }),
      ),
    );
    if (focused) search.focus();
  }

  private rebuildList(state: HistoryState): void {
    this.rebuildStatus(state);
    this.rows.textContent = '';
    this.more.textContent = '';
    const anchors = redrawing('history', 'rows');

    if (state.saves.length === 0) {
      this.rows.appendChild(el('div', 'hs-empty', emptySentence(state)));
      return;
    }

    for (const group of groupByDay(state.saves)) {
      this.rows.appendChild(el('div', 'hs-day', group.heading));
      for (const save of group.saves) {
        const selected = save.sha === state.selected;
        const row = el('div', 'hs-row');
        row.dataset['maker'] = save.maker;
        row.classList.toggle('selected', selected);
        const subject = el('span', 'hs-subject');
        subject.appendChild(el('span', 'hs-subject-text', save.subject));
        if (save.maker === 'agent') subject.appendChild(el('span', 'hs-badge', 'agent'));
        if (save.maker === 'other') subject.appendChild(el('span', 'hs-badge other', save.author));
        const count = el('span', 'hs-count', String(save.files.length));
        if (save.sent === false) {
          const unsent = el('span', 'hs-unsent', '⇡');
          unsent.title = 'Not yet sent to the shared copy.';
          count.appendChild(unsent);
        }
        row.append(el('span', 'hs-time', timeOf(save.date)), subject, count);
        // A checkpoint is drawn under the save it names, never as a row of its own
        for (const name of save.checkpoints) row.appendChild(el('span', 'hs-flag', `⚑ ${name}`));
        this.rows.appendChild(
          anchors.act(row, rowAction(save, selected), () => this.select(save.sha)),
        );
      }
    }

    const more = moreAction(state.next);
    this.more.appendChild(
      anchors.act(
        el('button', 'hs-btn', more.label) as HTMLButtonElement,
        more,
        () => void this.loadMore(),
      ),
    );
  }

  /** The cause the worktree is not clean, with the paths where there are some. No control yet. */
  private rebuildStatus(state: HistoryState): void {
    this.status.textContent = '';
    const sentence = statusSentence(state.status);
    if (sentence === '') return;
    this.status.appendChild(el('div', '', sentence));
    const paths = state.status?.cause === 'outside' ? state.status.outside : [];
    if (paths.length > 0) {
      this.status.appendChild(el('div', 'hs-status-paths', paths.join('\n')));
    }
  }

  private rebuildDetail(state: HistoryState): void {
    this.detail.textContent = '';
    const anchors = redrawing('history', 'detail');
    if (state.narrow && state.showingDetail) {
      const back = backAction();
      const holder = el('div', 'hs-back');
      holder.appendChild(
        anchors.act(el('button', 'hs-btn', back.label) as HTMLButtonElement, back, () => {
          this.showingDetail = false;
          this.rebuild();
        }),
      );
      this.detail.appendChild(holder);
    }

    const save = state.saves.find((s) => s.sha === state.selected);
    if (!save) {
      if (state.saves.length > 0) {
        this.detail.appendChild(
          el('div', 'hs-detail-empty', 'Pick a save to see what it changed.'),
        );
      }
      return;
    }

    const head = el('div', 'hs-head');
    head.appendChild(el('div', 'hs-head-subject', save.subject));
    const line = el('div', 'hs-head-line');
    const files = save.files.length;
    // The hash is where an engineer would look for it, on the time, and nowhere in the prose
    const when = el('span', '', dayAndTime(save.date));
    when.title = save.sha;
    line.append(`${MAKER_SAYS[save.maker]} · `, when, ` · ${files} file${files === 1 ? '' : 's'}`);
    head.appendChild(line);
    if (save.body.trim() !== '') head.appendChild(el('div', 'hs-head-body', save.body.trim()));
    this.detail.appendChild(head);

    this.detail.appendChild(this.fileList(save));
  }

  /** The files a save touched, grouped by kind in the report's order. The diffs come next stage. */
  private fileList(save: Save): HTMLElement {
    const list = el('div', 'hs-files');
    const byKind = new Map<FileKind, Save['files']>();
    for (const file of save.files) {
      const kind = kindOf(file.path);
      const group = byKind.get(kind);
      if (group) group.push(file);
      else byKind.set(kind, [file]);
    }
    for (const kind of KIND_ORDER) {
      const group = byKind.get(kind);
      if (!group) continue;
      list.appendChild(el('div', 'hs-kind', KIND_SAYS[kind]));
      for (const file of group) {
        const row = el('div', 'hs-file');
        const path = el('span', 'hs-file-path', file.path);
        path.title = file.path;
        row.appendChild(path);
        // Uncoloured on purpose: jade and vermilion are for the words a diff adds and removes
        const counts =
          file.added === null || file.removed === null
            ? 'binary'
            : `+${file.added} −${file.removed}`;
        row.appendChild(el('span', 'hs-file-counts', counts));
        list.appendChild(row);
      }
    }
    return list;
  }

  private rebuildFoot(): void {
    this.foot.textContent = '';
    this.foot.classList.toggle('bad', this.failure !== '');
    const left = el('div', 'hs-foot-left');
    // Only the reading and failure sentences until the change view gives it a file to name
    if (this.failure !== '') left.textContent = this.failure;
    else if (this.reading) left.textContent = 'Reading history…';
    left.title = left.textContent;
    this.foot.appendChild(left);
  }
}

/** `Today 14:02`, or the date and time for an older save. */
function dayAndTime(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const today = new Date().toDateString() === date.toDateString();
  return `${today ? 'today' : day} ${timeOf(iso)}`;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

registerEditor(HistoryEditor, 'vn.HistoryEditor');

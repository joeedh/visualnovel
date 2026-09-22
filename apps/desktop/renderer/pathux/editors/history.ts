import type { Button, Container } from 'pathux';
import { check, exec, onInvalidate } from '../app/bridge.js';
import { VnEditor, registerEditor } from '../app/editor.js';
import { layoutChanged } from '../app/persist.js';
import { openCommandDialog } from '../chrome/dialog.js';
import { redrawing, type AnchorPass } from '../tour/anchors.js';
import type { Offer } from '../../rules/anchors.js';
import {
  abandonSyncAction,
  addRemoteAction,
  backAction,
  checkpointAction,
  checkpointsAction,
  clearAction,
  cancelEditAction,
  conflicting,
  decidedLabel,
  decidedSentence,
  editAction,
  EDITING_NOTE,
  continueSyncAction,
  conversationAction,
  dayAndTime,
  dropCheckpointAction,
  emptySentence,
  fetchAction,
  fileAction,
  filesBackAction,
  goBackAction,
  groupByDay,
  listedRemotes,
  logsAction,
  MAKER_SAYS,
  moreAction,
  NO_FILTER,
  NO_REMOTES,
  onlyLogs,
  pathAction,
  pullAction,
  pushAction,
  ranSentence,
  reloadAction,
  removeRemoteAction,
  remoteSentence,
  repoAction,
  replayingSentence,
  REPLAYING_NOTE,
  resolveAction,
  resolveBox,
  saveResolutionAction,
  undoResolutionAction,
  resolvePath,
  restoreFileAction,
  rowAction,
  searchBox,
  setRemoteUrlAction,
  shown,
  statusControls,
  statusSentence,
  stripSentence,
  syncSentence,
  syncViewAction,
  syncWithAction,
  takeBackAction,
  threadOf,
  timeOf,
  undoSentence,
  WHO_ROWS,
  whoAction,
  type HistoryFilter,
  type HistoryState,
  type PaneSize,
  type SyncVerb,
  type Verdict,
  type VerdictKey,
} from '../../rules/history.js';
import {
  KIND_ORDER,
  kindOf,
  REPO_ROLES,
  type Diff,
  type FileKind,
  type HistoryPage,
  type Maker,
  type RepoEntry,
  type RepoRole,
  type RepoStatus,
  type Save,
} from '../../../src/shared/history.js';
import { drawDiff } from './history/diffs/index.js';
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

/** The commands whose run leaves the undo history from before it no longer applying. */
const BLOCKS_UNDO = /^git\.(takeBack|goBack)\(/;

/**
 * Every save of the project, newest first, and what each one changed. It reads through the
 * `git.*` commands, and every write it offers is one of the `git.*` recovery commands: a
 * confirmed one opens the command's own form, where the check's verdict is read before Run.
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
  /** Built once with the bar and re-presented on every rebuild, since its offer moves. */
  private checkpointButton!: Button;

  /** Which repository the list shows, remembered with the pane. */
  private repo: RepoRole = 'project';
  private filter: HistoryFilter = { ...NO_FILTER };
  private repos: RepoEntry[] = [];
  private repoStatus: RepoStatus | undefined;
  private saves: Save[] = [];
  private next: string | null = null;
  private selected: string | undefined;
  /** The file of the selected save whose diff is open, and the diff once it has been read. */
  private file: string | undefined;
  private diff: Diff | undefined;
  private diffFailure = '';
  private logsOpen = false;
  private width: PaneSize = 'large';
  private showingDetail = false;
  /** What `check` answered for the recovery and sync commands; emptied when the tree moves. */
  private verdicts: Partial<Record<VerdictKey, Verdict>> = {};
  /** Whether the sync view has the detail column. */
  private syncOpen = false;
  /** The network verb running, when one is, and when it started, for the footer's clock. */
  private syncing: SyncVerb | undefined;
  private syncStarted = 0;
  private clockTimer: ReturnType<typeof setInterval> | undefined;
  /** The conflicted path open for editing, and its text as git left it, once read. */
  private editing: string | undefined;
  private draft: string | undefined;
  /**
   * The editor's field, made once and re-attached on every redraw, so what the author has typed
   * survives a status poll that rebuilds the view around it.
   */
  private readonly resolveField = el('textarea', 'hs-resolve-field') as HTMLTextAreaElement;

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
    const checkpoint = checkpointAction(this.state());
    this.checkpointButton = bar.button(checkpoint.label, () => {});
    this.presentCheckpoint(checkpoint);
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
    this.resolveField.spellcheck = false;
    this.resolveField.wrap = 'soft';

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
    this.stopClock();
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
      ...(this.file === undefined ? {} : { file: this.file }),
      logsOpen     : this.logsOpen,
      size         : this.width,
      showingDetail: this.showingDetail,
      verdicts     : this.verdicts,
      ...(BLOCKS_UNDO.test(this.ui.undoBlocked) ? { undoBlocked: this.ui.undoBlocked } : {}),
      syncOpen: this.syncOpen,
      ...(this.syncing === undefined ? {} : { syncing: this.syncing }),
      ...(this.editing === undefined ? {} : { editing: this.editing }),
    };
  }

  /**
   * Ask `check` about the recovery commands on the selected save and the open file, and draw
   * again once it has answered. The control is drawn accepted until then, since the command's
   * own check runs again on the click; a verdict for a selection that has moved on is dropped.
   */
  private async askVerdicts(keys: readonly VerdictKey[]): Promise<void> {
    const sha = this.selected;
    const file = this.file;
    const token = this.token;
    if (!this.repos.some((r) => r.role === this.repo && r.owned)) return;
    const asked = keys.filter((key) => {
      if (key === 'git.restoreFile') return sha !== undefined && file !== undefined;
      if (key === 'git.takeBack' || key === 'git.goBack') return sha !== undefined;
      return true;
    });
    if (asked.length === 0) return;
    const answers = await Promise.all(
      asked.map(async (key) => {
        const [id, on] = key.split(':') as [string, string | undefined];
        const props: Record<string, string> = { repo: this.repo };
        if (key === 'git.restoreFile') Object.assign(props, { sha: sha!, path: file! });
        else if (key === 'git.takeBack' || key === 'git.goBack') props['sha'] = sha!;
        else if (id === 'git.push') props['remote'] = on ?? '';
        return [key, await check(id, props)] as const;
      }),
    );
    if (this.selected !== sha || this.file !== file || this.token !== token) return;
    for (const [key, answer] of answers) {
      this.verdicts[key] = { ok: answer.state !== 'refuse', message: answer.message };
    }
    this.rebuild();
  }

  /** The keys the branch's own state is asked about: the pull, a push per copy, and continuing. */
  private syncKeys(): VerdictKey[] {
    const remotes = this.repoStatus?.remotes ?? [];
    return [
      'git.pull',
      'git.continueSync',
      ...remotes.map((r): VerdictKey => `git.push:${r.name}`),
    ];
  }

  /** Re-present the bar's checkpoint button on its own pass, since the bar is built once. */
  private presentCheckpoint(offer: Offer): void {
    redrawing('history', 'checkpoint').act(this.checkpointButton, offer, (action) =>
      openCommandDialog(action.id, action.props),
    );
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
      // The worktree may have moved with whatever invalidated the list, so the verdicts are stale
      this.verdicts = {};
      void this.askVerdicts(['git.takeBack', 'git.goBack', 'git.restoreFile', ...this.syncKeys()]);
      // Decided elsewhere, or the sync finished: the file the editor holds is no longer in question
      if (this.editing !== undefined && !status.marked.includes(this.editing)) this.closeEdit();
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
    if (sha !== this.selected) {
      this.file = undefined;
      this.diff = undefined;
      this.logsOpen = false;
      delete this.verdicts['git.takeBack'];
      delete this.verdicts['git.goBack'];
      delete this.verdicts['git.restoreFile'];
    }
    this.selected = sha;
    this.showingDetail = true;
    // A row asks for its changes, so the sync view gives the column back
    this.syncOpen = false;
    this.rebuild();
    void this.askVerdicts(['git.takeBack', 'git.goBack']);
  }

  private toggleSync(): void {
    this.syncOpen = !this.syncOpen;
    this.showingDetail = this.syncOpen || this.selected !== undefined;
    this.rebuild();
  }

  /** Bring the conflict view to the front, which in the one-column layout means the detail. */
  private showConflicts(): void {
    this.syncOpen = false;
    this.showingDetail = true;
    this.rebuild();
  }

  /**
   * Run a network verb and keep the footer's clock going while it does. The list is read again
   * afterwards whatever happened, since a fetch moves the counts even when nothing else moved.
   */
  private async runSync(verb: SyncVerb, id: string, props: Record<string, string>): Promise<void> {
    if (this.syncing !== undefined) return;
    this.syncing = verb;
    this.syncStarted = Date.now();
    this.failure = '';
    this.clockTimer = setInterval(() => this.rebuildFoot(), 1000);
    this.rebuild();
    try {
      const outcome = await exec(id, props);
      if (!outcome.ok) this.failure = outcome.error;
    } finally {
      this.stopClock();
      this.syncing = undefined;
    }
    await this.load();
  }

  private stopClock(): void {
    if (this.clockTimer !== undefined) clearInterval(this.clockTimer);
    this.clockTimer = undefined;
  }

  /** Open one file in question for editing, reading it as git left it in the worktree. */
  private openEdit(path: string): void {
    if (this.editing === path) return;
    this.editing = path;
    this.draft = undefined;
    this.resolveField.value = '';
    this.rebuild();
    void this.loadConflictText(path);
  }

  private closeEdit(): void {
    if (this.editing === undefined) return;
    this.editing = undefined;
    this.draft = undefined;
    this.resolveField.value = '';
    this.rebuild();
  }

  private async loadConflictText(path: string): Promise<void> {
    const outcome = await exec('git.conflictText', { repo: this.repo, path });
    if (this.editing !== path) return;
    if (!outcome.ok) {
      this.failure = outcome.error;
      this.closeEdit();
      return;
    }
    this.draft = (outcome.data as { text: string }).text;
    this.resolveField.value = this.draft;
    this.rebuild();
    this.scrollToMarker();
  }

  /**
   * Scroll the field to the first marker, which in a long scene is well below the fold. A
   * textarea only scrolls to its caret on typing, so the scroll height of the text above the
   * marker is measured by loading that much and reading it back.
   */
  private scrollToMarker(): void {
    const field = this.resolveField;
    const text = field.value;
    const at = text.search(/^<{7}( |$)/m);
    if (at <= 0) return;
    field.value = text.slice(0, at);
    field.scrollTop = field.scrollHeight;
    // The text above the marker, less one view: zero when the marker is already in view
    const above = field.scrollTop;
    field.value = text;
    if (above > 0) field.scrollTop = above + (field.clientHeight * 2) / 3;
  }

  /** Write the field over the file and mark it decided; a refusal stays in the footer. */
  private async saveResolution(path: string): Promise<void> {
    const outcome = await exec('git.writeResolution', {
      repo: this.repo,
      path,
      text: this.resolveField.value,
    });
    if (!outcome.ok) {
      this.failure = outcome.error;
      this.rebuildFoot();
      return;
    }
    this.closeEdit();
    await this.load();
  }

  /** Open one file's diff, reading it if this is the first look. The file list stays as it is. */
  private openFile(path: string): void {
    if (path === this.file) return;
    this.file = path;
    this.diff = undefined;
    this.diffFailure = '';
    delete this.verdicts['git.restoreFile'];
    this.rebuild();
    void this.loadDiff(path);
    void this.askVerdicts(['git.restoreFile']);
  }

  private closeFile(): void {
    this.file = undefined;
    this.diff = undefined;
    this.diffFailure = '';
    delete this.verdicts['git.restoreFile'];
    this.rebuild();
  }

  private async loadDiff(path: string): Promise<void> {
    const sha = this.selected;
    if (sha === undefined) return;
    try {
      const diff = await this.read<Diff>('git.diff', { repo: this.repo, sha, path });
      if (this.selected !== sha || this.file !== path) return;
      this.diff = diff;
    } catch (err) {
      if (this.selected !== sha || this.file !== path) return;
      this.diffFailure = err instanceof Error ? err.message : String(err);
    }
    this.rebuild();
  }

  private resized(width: number): void {
    const size: PaneSize = width < SMALL ? 'small' : width < LARGE ? 'mid' : 'large';
    if (this.surface.dataset['size'] !== size) this.surface.dataset['size'] = size;
    if (size === this.width) return;
    this.width = size;
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
      this.file,
      this.diff === undefined ? '' : this.diff.kind,
      this.diffFailure,
      this.logsOpen,
      this.width,
      this.showingDetail,
      this.failure,
      ...Object.entries(this.verdicts).map(([id, v]) => `${id}=${v?.ok}:${v?.message}`),
      this.ui.undoBlocked,
      this.syncOpen,
      this.syncing,
      this.editing,
      this.draft === undefined ? '' : 'draft',
    ].join('|');
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private rebuild(): void {
    this.drawn = this.stateKey();
    const state = this.state();
    this.surface.classList.toggle('detail', state.size === 'small' && state.showingDetail);
    // In the two narrower layouts the diff takes the file list's place
    this.surface.classList.toggle('diff', state.size !== 'large' && state.file !== undefined);
    this.presentCheckpoint(checkpointAction(state));
    this.rebuildStrip(state);
    this.rebuildFilters(state);
    this.rebuildList(state);
    this.rebuildDetail(state);
    this.rebuildFoot(state);
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
    const line = el(
      'div',
      'hs-strip-line',
      stripSentence(entry, state.status, state.size === 'small'),
    );
    line.title = entry ? entry.root : '';
    this.strip.appendChild(line);
    if (state.repos.length > 0) {
      const sync = syncViewAction(state);
      this.strip.appendChild(
        anchors.act(
          el('button', 'hs-btn hs-sync-toggle', sync.label) as HTMLButtonElement,
          sync,
          () => this.toggleSync(),
        ),
      );
    }
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

  /**
   * The cause the worktree is not clean, with the paths where there are some, and the one thing
   * to do about it: save edits made outside the app under a message, decide a stopped sync's
   * collisions, or give up a take-back a terminal left part way.
   */
  private rebuildStatus(state: HistoryState): void {
    this.status.textContent = '';
    const sentence = statusSentence(state.status);
    if (sentence === '') return;
    const anchors = redrawing('history', 'status');
    const line = el('div', 'hs-status-line');
    line.appendChild(el('span', '', sentence));
    for (const offer of statusControls(state)) {
      line.appendChild(
        anchors.act(el('button', 'hs-btn', offer.label) as HTMLButtonElement, offer, (action) => {
          if (offer.id === 'pane.view') this.showConflicts();
          else openCommandDialog(action.id, action.props);
        }),
      );
    }
    this.status.appendChild(line);
    const paths = state.status?.cause === 'outside' ? state.status.outside : [];
    if (paths.length > 0) {
      this.status.appendChild(el('div', 'hs-status-paths', paths.join('\n')));
    }
  }

  private rebuildDetail(state: HistoryState): void {
    this.detail.textContent = '';
    const anchors = redrawing('history', 'detail');
    if (state.size === 'small' && state.showingDetail) {
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

    if (conflicting(state)) {
      this.detail.appendChild(this.conflictView(state, anchors));
      return;
    }
    if (state.syncOpen) {
      this.detail.appendChild(this.syncView(state, anchors));
      return;
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

    this.detail.appendChild(this.detailHead(save, state, anchors));
    this.detail.appendChild(this.fileList(save, state, anchors));
    if (state.file !== undefined) {
      this.detail.appendChild(this.diffView(save, state.file, state, anchors));
    }
  }

  /**
   * The subject, who made it and when, what the app ran, the message body, the conversation, and
   * the recovery controls: take the save back, go back to it, and drop each checkpoint it carries.
   */
  private detailHead(save: Save, state: HistoryState, anchors: AnchorPass): HTMLElement {
    const head = el('div', 'hs-head');
    head.appendChild(el('div', 'hs-head-subject', save.subject));
    const line = el('div', 'hs-head-line');
    const files = save.files.length;
    // The hash is where an engineer would look for it, on the time, and nowhere in the prose
    const when = el('span', '', dayAndTime(save.date));
    when.title = save.sha;
    line.append(`${MAKER_SAYS[save.maker]} · `, when, ` · ${files} file${files === 1 ? '' : 's'}`);
    head.appendChild(line);
    const ran = ranSentence(save);
    if (ran !== '') {
      const row = el('div', 'hs-head-ran');
      row.append('Ran ', el('code', 'hs-ran', ran));
      head.appendChild(row);
    }
    if (save.body.trim() !== '') head.appendChild(el('div', 'hs-head-body', save.body.trim()));
    // Greyed with its reason on a save that is not an agent's, like every refused control here
    const convo = conversationAction(threadOf(save));
    const row = el('div', 'hs-head-acts');
    row.appendChild(
      anchors.act(el('button', 'hs-btn', convo.label) as HTMLButtonElement, convo, (action) => {
        void exec(action.id, action.props).then(() => {
          if (convo.ok) for (const next of convo.then ?? []) void exec(next.id, next.props);
        });
      }),
    );
    head.appendChild(row);

    // Both are confirmed, so the click opens the form, where the check's verdict is read first
    const recovery = el('div', 'hs-head-acts');
    for (const offer of [takeBackAction(state, save), goBackAction(state, save)]) {
      recovery.appendChild(
        anchors.act(el('button', 'hs-btn', offer.label) as HTMLButtonElement, offer, (action) =>
          openCommandDialog(action.id, action.props),
        ),
      );
    }
    for (const name of save.checkpoints) {
      const drop = dropCheckpointAction(state, name);
      recovery.appendChild(
        anchors.act(el('button', 'hs-btn', drop.label) as HTMLButtonElement, drop, (action) => {
          void exec(action.id, action.props);
        }),
      );
    }
    head.appendChild(recovery);
    return head;
  }

  /**
   * The files a save touched, grouped by kind in the report's order, the logs folded behind
   * their count. A save that touched only logs says so in the list's place, with the fold as the
   * one thing to do.
   */
  private fileList(save: Save, state: HistoryState, anchors: AnchorPass): HTMLElement {
    const list = el('div', 'hs-files');
    const logs = save.files.filter((f) => kindOf(f.path) === 'log');
    const logsFold = (alone: boolean) => {
      const offer = logsAction(state.logsOpen, logs.length, alone);
      const button = el('button', alone ? 'hs-btn' : 'hs-kind hs-kind-fold', offer.label);
      button.appendChild(el('span', 'hs-fold-mark', state.logsOpen ? '▾' : '▸'));
      return anchors.act(button as HTMLButtonElement, offer, () => {
        this.logsOpen = !this.logsOpen;
        this.rebuild();
      });
    };
    if (onlyLogs(save) && !state.logsOpen) {
      const empty = el('div', 'hs-detail-empty');
      empty.appendChild(
        el('div', '', 'This save changed nothing an author edits; it updated the task log.'),
      );
      empty.appendChild(logsFold(true));
      list.appendChild(empty);
      return list;
    }

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
      if (kind === 'log') {
        list.appendChild(logsFold(false));
        if (!state.logsOpen) continue;
      } else {
        list.appendChild(el('div', 'hs-kind', KIND_SAYS[kind]));
      }
      for (const file of group) {
        const open = file.path === state.file;
        const row = el('div', 'hs-file');
        row.classList.toggle('open', open);
        const path = el('span', 'hs-file-path', file.path);
        row.appendChild(path);
        // Uncoloured on purpose: jade and vermilion are for the words a diff adds and removes
        row.appendChild(el('span', 'hs-file-counts', countsOf(file)));
        list.appendChild(
          anchors.act(row, fileAction(file.path, open), () => this.openFile(file.path)),
        );
      }
    }
    return list;
  }

  /** One file's diff under its own heading, drawn for its kind once `git.diff` has answered. */
  private diffView(
    save: Save,
    path: string,
    state: HistoryState,
    anchors: AnchorPass,
  ): HTMLElement {
    const view = el('div', 'hs-diff');
    // Under the file list the lit row and the footer already name the file; the bar is for the
    // two layouts where the diff has taken the list's place
    if (state.size !== 'large') {
      const bar = el('div', 'hs-diff-bar');
      const back = filesBackAction();
      bar.appendChild(
        anchors.act(el('button', 'hs-btn', back.label) as HTMLButtonElement, back, () =>
          this.closeFile(),
        ),
      );
      const name = el('span', 'hs-diff-path', path);
      name.title = path;
      bar.appendChild(name);
      const file = save.files.find((f) => f.path === path);
      if (file) bar.appendChild(el('span', 'hs-file-counts', countsOf(file)));
      view.appendChild(bar);
    }

    // An ordinary document write, run outright: undo is what reverses it
    const restore = restoreFileAction(state, save, path);
    const acts = el('div', 'hs-diff-acts');
    acts.appendChild(
      anchors.act(el('button', 'hs-btn', restore.label) as HTMLButtonElement, restore, (action) => {
        void exec(action.id, action.props);
      }),
    );
    view.appendChild(acts);

    if (this.diffFailure !== '') {
      view.appendChild(el('div', 'hs-diff-note bad', this.diffFailure));
    } else if (this.diff === undefined) {
      view.appendChild(el('div', 'hs-diff-note', 'Reading the change…'));
    } else {
      view.appendChild(drawDiff(this.diff, kindOf(path)));
    }
    return view;
  }

  /**
   * The shared copies of the repository: get their saves from the one the branch syncs with, and
   * per copy its address, its counts and when it was last checked, with send, check, sync-with,
   * change-address and remove; then add another. With none, the one sentence and the way to
   * connect one.
   */
  private syncView(state: HistoryState, anchors: AnchorPass): HTMLElement {
    const view = el('div', 'hs-sync');
    const remotes = listedRemotes(state.status);
    const button = (
      offer: Offer,
      run: (action: { id: string; props: Record<string, string> }) => void,
    ) =>
      anchors.act(el('button', 'hs-btn', offer.label) as HTMLButtonElement, offer, (action) =>
        run({ id: action.id, props: action.props as Record<string, string> }),
      );
    const form = (offer: Offer) =>
      button(offer, (action) => openCommandDialog(action.id, action.props));

    if (remotes.length === 0) {
      const empty = el('div', 'hs-detail-empty');
      empty.appendChild(el('div', '', NO_REMOTES));
      empty.appendChild(form(addRemoteAction(state)));
      view.appendChild(empty);
      return view;
    }

    const head = el('div', 'hs-sync-head');
    head.appendChild(el('div', 'hs-head-subject', 'Shared copies'));
    const pull = pullAction(state);
    head.appendChild(button(pull, (action) => void this.runSync('pull', action.id, action.props)));
    view.appendChild(head);

    for (const remote of remotes) {
      const row = el('div', 'hs-remote');
      row.classList.toggle('syncs', remote.syncsWith);
      const name = el('div', 'hs-remote-name', remote.name);
      if (remote.syncsWith) name.appendChild(el('span', 'hs-badge', 'syncs with'));
      row.appendChild(name);
      name.appendChild(
        el('span', 'hs-remote-line', remoteSentence(remote, state.status?.lastFetch ?? null)),
      );
      const url = el('div', 'hs-remote-url', remote.url);
      url.title = remote.url;
      row.appendChild(url);
      const acts = el('div', 'hs-head-acts');
      acts.appendChild(
        button(
          pushAction(state, remote),
          (action) => void this.runSync('push', action.id, action.props),
        ),
      );
      acts.appendChild(
        button(
          fetchAction(state, remote),
          (action) => void this.runSync('fetch', action.id, action.props),
        ),
      );
      acts.appendChild(
        button(syncWithAction(state, remote), (action) => void exec(action.id, action.props)),
      );
      acts.appendChild(form(setRemoteUrlAction(state, remote)));
      acts.appendChild(form(removeRemoteAction(state, remote)));
      row.appendChild(acts);
      view.appendChild(row);
    }

    const foot = el('div', 'hs-head-acts');
    foot.appendChild(form(addRemoteAction(state)));
    view.appendChild(foot);
    return view;
  }

  /**
   * The files a stopped sync is waiting on, grouped by kind under the save being replayed. Each
   * gets Keep mine and Take theirs, and one git merged line by line gets Edit, which opens the
   * whole file beneath the list with Save and Cancel. The files already decided follow, greyed,
   * each with how it was decided and Undo decision. Continue and Give up close the view.
   */
  private conflictView(state: HistoryState, anchors: AnchorPass): HTMLElement {
    const view = el('div', 'hs-conflict');
    view.classList.toggle('editing', state.editing !== undefined);
    const button = (
      offer: Offer,
      run: (action: { id: string; props: Record<string, string> }) => void,
    ) =>
      anchors.act(el('button', 'hs-btn', offer.label) as HTMLButtonElement, offer, (action) =>
        run({ id: action.id, props: action.props as Record<string, string> }),
      );
    view.appendChild(el('div', 'hs-head-subject', replayingSentence(state.status)));
    const paths = state.status?.conflicted ?? [];
    view.appendChild(el('div', 'hs-head-line', decidedSentence(state.status)));

    const byKind = new Map<FileKind, string[]>();
    for (const path of paths) {
      const kind = kindOf(path);
      byKind.set(kind, [...(byKind.get(kind) ?? []), path]);
    }
    const list = el('div', 'hs-files');
    for (const kind of KIND_ORDER) {
      const group = byKind.get(kind);
      if (!group) continue;
      list.appendChild(el('div', 'hs-kind', KIND_SAYS[kind]));
      for (const path of group) {
        const row = el('div', 'hs-conflict-row');
        row.classList.toggle('open', path === state.editing);
        row.appendChild(el('span', 'hs-file-path', path));
        const acts = el('span', 'hs-conflict-acts');
        for (const side of ['mine', 'theirs'] as const) {
          acts.appendChild(
            button(
              resolveAction(state, path, side),
              (action) => void exec(action.id, action.props),
            ),
          );
        }
        const edit = editAction(state, path);
        acts.appendChild(
          anchors.act(el('button', 'hs-btn', edit.label) as HTMLButtonElement, edit, () =>
            this.openEdit(path),
          ),
        );
        row.appendChild(acts);
        list.appendChild(row);
      }
    }
    const decided = state.status?.decided ?? [];
    if (decided.length > 0) {
      list.appendChild(el('div', 'hs-kind', 'Decided'));
      for (const file of decided) {
        const row = el('div', 'hs-conflict-row decided');
        row.appendChild(el('span', 'hs-file-path', file.path));
        row.appendChild(el('span', 'hs-decided-how', decidedLabel(file)));
        const acts = el('span', 'hs-conflict-acts');
        acts.appendChild(
          button(
            undoResolutionAction(state, file),
            (action) => void exec(action.id, action.props).then(() => this.load()),
          ),
        );
        row.appendChild(acts);
        list.appendChild(row);
      }
    }
    view.appendChild(list);

    if (state.editing !== undefined) view.appendChild(this.editView(state, state.editing, anchors));

    const acts = el('div', 'hs-head-acts hs-conflict-foot');
    acts.appendChild(
      button(
        continueSyncAction(state),
        (action) => void this.runSync('pull', action.id, action.props),
      ),
    );
    acts.appendChild(
      button(abandonSyncAction(state), (action) => openCommandDialog(action.id, action.props)),
    );
    view.appendChild(acts);
    view.appendChild(el('div', 'hs-conflict-note', REPLAYING_NOTE));
    if (state.editing !== undefined) view.appendChild(el('div', 'hs-conflict-note', EDITING_NOTE));
    return view;
  }

  /**
   * One file in question, whole, in a field the author merges by hand, with Save and Cancel
   * beneath. Prose gets the prose face; a storyboard, a layout-like JSON or YAML the mono one.
   */
  private editView(state: HistoryState, path: string, anchors: AnchorPass): HTMLElement {
    const view = el('div', 'hs-resolve');
    view.appendChild(el('div', 'hs-kind', `Editing · ${path}`));
    const kind = kindOf(path);
    const field = this.resolveField;
    field.classList.toggle('prose', kind === 'scene' || kind === 'wiki' || kind === 'sheet');
    field.disabled = this.draft === undefined;
    anchors.record(field, resolveBox(path));
    view.appendChild(field);
    if (this.draft === undefined) view.appendChild(el('div', 'hs-diff-note', 'Reading…'));
    const acts = el('div', 'hs-conflict-acts hs-resolve-acts');
    const save = saveResolutionAction(state, path);
    acts.appendChild(
      anchors.act(
        el('button', 'hs-btn', save.label) as HTMLButtonElement,
        save,
        () => void this.saveResolution(path),
      ),
    );
    const cancel = cancelEditAction(path);
    acts.appendChild(
      anchors.act(el('button', 'hs-btn', cancel.label) as HTMLButtonElement, cancel, () =>
        this.closeEdit(),
      ),
    );
    view.appendChild(acts);
    return view;
  }

  private rebuildFoot(state: HistoryState = this.state()): void {
    this.foot.textContent = '';
    this.foot.classList.toggle('bad', this.failure !== '');
    const left = el('div', 'hs-foot-left');
    if (this.failure !== '') left.textContent = this.failure;
    else if (this.syncing !== undefined) {
      left.textContent = syncSentence(this.syncing, (Date.now() - this.syncStarted) / 1000);
    } else if (this.reading) left.textContent = 'Reading history…';
    else if (this.file !== undefined && this.selected !== undefined) {
      left.textContent = `${this.file} · ${this.selected.slice(0, 7)}`;
    }
    left.title = left.textContent;
    this.foot.appendChild(left);
    const undo = undoSentence(state);
    if (undo !== '') this.foot.appendChild(el('div', 'hs-foot-right', undo));
  }
}

/** `+3 −1`, or the word for a file git could not count. */
function countsOf(file: Save['files'][number]): string {
  return file.added === null || file.removed === null
    ? 'binary'
    : `+${file.added} −${file.removed}`;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

registerEditor(HistoryEditor, 'vn.HistoryEditor');

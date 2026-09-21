/**
 * The reads behind the `git.*` commands: the saves of one repository, what each changed, and the
 * diff of one file, over `@vn/git`. Per-commit answers are held for the session, since a commit's
 * contents never change; the list is not, since HEAD does.
 */
import { slotKey, slotLabel, slotsOf } from '@vn/artgen';
import { Workspace } from '@vn/authoring';
import {
  makerOf,
  openGit,
  statusCause,
  textDiff,
  type Change,
  type Diff,
  type Git,
  type HistoryEntry,
  type Maker,
  type Save,
  type SlotChange,
} from '@vn/git';
import type { Asset } from '@vn/types';
import type { DiffLine } from '@vn/util';
import {
  blobUrl,
  kindOf,
  type BlobRead,
  type HistoryPage,
  type RepoEntry,
  type RepoRole,
  type RepoStatus,
} from '../../shared/history.js';
import { SCAFFOLDING_SUBJECTS } from '../workspace/workspace.js';
import type { WorkspaceSession } from './core.js';

/** Rows per page of the history list. */
export const PAGE = 50;
/** Commits one `history` call will read through looking for `PAGE` matches of a `who` filter. */
export const SCAN_CAP = 1000;
/** Bytes past which a text file is answered as bytes rather than text. */
export const TEXT_CAP = 2 * 1024 * 1024;
/**
 * Lines per side past which a line diff comes from git's own hunks rather than `lineDiff`,
 * whose table is quadratic in the line count.
 */
export const LINE_DIFF_CAP = 3000;
/** The app's own logs, which a read appends to without a commit; dirt there is not the author's. */
const OWN_LOGS = ['vngen/state/'];

export interface HistoryFilter {
  /** Only saves by this maker; empty for all of them. */
  who?: Maker | '';
  /** Only saves that touched this workspace-relative path; empty for all of them. */
  path?: string;
  /** Only saves whose message contains this text; empty for all of them. */
  text?: string;
  /** The sha the page starts after, from the previous page's `next`. */
  before?: string;
}

/** Whether the bytes read as text: valid UTF-8 with no NUL, under the cap. */
function isText(bytes: Buffer): boolean {
  if (bytes.length > TEXT_CAP) return false;
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Git's unified hunks as diff lines, with each `@@` header kept as a context line. */
function hunkLines(unified: string): DiffLine[] {
  const out: DiffLine[] = [];
  let inHunk = false;
  for (const line of unified.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      out.push({ kind: 'same', text: line });
    } else if (!inHunk || line.startsWith('\\')) {
      continue;
    } else if (line.startsWith('+')) {
      out.push({ kind: 'added', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      out.push({ kind: 'removed', text: line.slice(1) });
    } else {
      out.push({ kind: 'same', text: line.slice(1) });
    }
  }
  return out;
}

const countLines = (text: string): number => (text === '' ? 0 : text.split('\n').length);

const MANIFEST = 'assets/manifest.json';

/**
 * The picture each slot holds in one manifest, by slot key: the row marked `current`, or the
 * accepted row in a manifest written before takes were held. A manifest that does not parse
 * holds nothing, so a save that corrupted it reads as emptying every slot rather than failing.
 */
export function heldTakes(manifest: Buffer | null): Map<string, { label: string; hash: string }> {
  const held = new Map<string, { label: string; hash: string }>();
  if (manifest === null) return held;
  let assets: Asset[];
  try {
    const parsed = JSON.parse(manifest.toString('utf8')) as { assets?: unknown };
    if (!Array.isArray(parsed.assets)) return held;
    assets = parsed.assets as Asset[];
  } catch {
    return held;
  }
  const holds = assets.some((a) => a.current === true);
  for (const asset of assets) {
    if (!(holds ? asset.current === true : asset.accepted === true)) continue;
    if (!Array.isArray(asset.satisfies)) continue;
    for (const binding of slotsOf(asset)) {
      held.set(slotKey(binding), { label: slotLabel(binding), hash: asset.hash });
    }
  }
  return held;
}

/** The slots that hold a different picture after the save than before it, in slot-key order. */
export function slotChanges(before: Buffer | null, after: Buffer | null): SlotChange[] {
  const was = heldTakes(before);
  const now = heldTakes(after);
  const out: SlotChange[] = [];
  for (const key of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const a = was.get(key);
    const b = now.get(key);
    if (a?.hash === b?.hash) continue;
    out.push({ slot: (a ?? b)!.label, before: a?.hash ?? null, after: b?.hash ?? null });
  }
  return out;
}

export class HistoryPart {
  constructor(private readonly session: WorkspaceSession) {}

  private readonly handles = new Map<string, Git>();
  private readonly identities = new Map<string, { name: string | null; email: string | null }>();
  private readonly changesMemo = new Map<string, Promise<Change[]>>();
  private readonly diffMemo = new Map<string, Promise<Diff | null>>();

  /** Every repository the project spans. */
  async repos(): Promise<RepoEntry[]> {
    const refs = await new Workspace(this.session.dir).repos();
    return refs.map((r) => ({ role: r.role, root: r.root, owned: r.owned }));
  }

  /** The handle for one role, or null when the project has no repository in that role. */
  private async repo(role: RepoRole): Promise<{ git: Git; root: string } | null> {
    const ref = (await this.repos()).find((r) => r.role === role);
    if (!ref) return null;
    let git = this.handles.get(ref.root);
    if (!git) {
      git = openGit(ref.root);
      this.handles.set(ref.root, git);
    }
    return { git, root: ref.root };
  }

  private async need(role: RepoRole): Promise<{ git: Git; root: string }> {
    const found = await this.repo(role);
    if (!found) throw new Error(`This project has no ${role} repository.`);
    return found;
  }

  /** The identity commit-on-save writes with in this repository, read once per session. */
  private async identity(git: Git, root: string) {
    let id = this.identities.get(root);
    if (!id) {
      id = { name: await git.configGet('user.name'), email: await git.configGet('user.email') };
      this.identities.set(root, id);
    }
    return id;
  }

  /**
   * One page of saves, newest first. A `who` filter is applied after the read, since git filters
   * on author only, so the read continues in pages until `PAGE` rows match, the history ends, or
   * `SCAN_CAP` commits have been read.
   */
  async history(role: RepoRole, filter: HistoryFilter = {}): Promise<HistoryPage> {
    const { git, root } = await this.need(role);
    const local = await this.identity(git, root);
    const ctx = { local, housekeeping: SCAFFOLDING_SUBJECTS };
    const [unsent, checkpoints] = await Promise.all([git.unsent(), git.checkpoints()]);
    const marks = new Map<string, string[]>();
    for (const c of checkpoints) marks.set(c.sha, [...(marks.get(c.sha) ?? []), c.slug]);

    const save = (e: HistoryEntry): Save => ({
      ...e,
      maker      : makerOf(e, ctx),
      checkpoints: marks.get(e.sha) ?? [],
      sent       : unsent === null ? null : !unsent.has(e.sha),
    });

    const saves: Save[] = [];
    let before = filter.before;
    let scanned = 0;
    // The last commit read, matched or not, so the next page rescans nothing
    let next: string | null = null;
    scan: while (scanned < SCAN_CAP) {
      const page = await git.history({
        limit: PAGE,
        ...(before ? { before } : {}),
        ...(filter.path ? { path: filter.path } : {}),
        ...(filter.text ? { grep: filter.text } : {}),
      });
      scanned += page.length;
      for (const e of page) {
        next = e.sha;
        const row = save(e);
        if (!filter.who || row.maker === filter.who) saves.push(row);
        if (saves.length === PAGE) break scan;
      }
      if (page.length < PAGE) {
        next = null;
        break;
      }
      before = page[page.length - 1]!.sha;
    }
    return { saves, next };
  }

  /** The paths one save changed, held for the session. */
  changes(role: RepoRole, sha: string): Promise<Change[]> {
    const key = `${role}:${sha}`;
    let held = this.changesMemo.get(key);
    if (!held) {
      held = this.need(role).then(({ git }) => git.changes(sha));
      held.catch(() => this.changesMemo.delete(key));
      this.changesMemo.set(key, held);
    }
    return held;
  }

  /** The diff of one path in one save, shaped for its kind; null when the save did not touch it. */
  diff(role: RepoRole, sha: string, path: string): Promise<Diff | null> {
    const key = `${role}:${sha}:${path}`;
    let held = this.diffMemo.get(key);
    if (!held) {
      held = this.buildDiff(role, sha, path);
      held.catch(() => this.diffMemo.delete(key));
      this.diffMemo.set(key, held);
    }
    return held;
  }

  private async buildDiff(role: RepoRole, sha: string, path: string): Promise<Diff | null> {
    const { git } = await this.need(role);
    const change = (await this.changes(role, sha)).find((c) => c.path === path);
    if (!change) return null;
    const kind = kindOf(path);
    if (kind === 'log') {
      const counts = { added: change.added ?? 0, removed: change.removed ?? 0 };
      if (path !== MANIFEST) return { kind: 'log', ...counts };
      const [before, after] = await Promise.all([
        change.oldBlob ? git.catBlob(change.oldBlob) : null,
        change.newBlob ? git.catBlob(change.newBlob) : null,
      ]);
      return { kind: 'log', ...counts, slots: slotChanges(before, after) };
    }
    if (kind === 'picture') {
      return {
        kind  : 'picture',
        before: change.oldBlob ? blobUrl(role, change.oldBlob, change.oldPath ?? path) : null,
        after : change.newBlob ? blobUrl(role, change.newBlob, path) : null,
      };
    }
    const [before, after] = await Promise.all([
      change.oldBlob ? git.catBlob(change.oldBlob) : null,
      change.newBlob ? git.catBlob(change.newBlob) : null,
    ]);
    if ((before && !isText(before)) || (after && !isText(after))) {
      return { kind: 'binary', before: before?.length ?? null, after: after?.length ?? null };
    }
    const a = before?.toString('utf8') ?? '';
    const b = after?.toString('utf8') ?? '';
    if (countLines(a) > LINE_DIFF_CAP || countLines(b) > LINE_DIFF_CAP) {
      const unified = await git.diffPath(sha, path);
      return { kind: 'lines', lines: hunkLines(unified.text) };
    }
    return textDiff(kind, a, b);
  }

  /** One path as it was at one save: its text, or where to load its bytes from. Null if absent. */
  async blob(role: RepoRole, sha: string, path: string): Promise<BlobRead | null> {
    const { git } = await this.need(role);
    const bytes = await git.blob(sha, path);
    if (bytes === null) return null;
    if (isText(bytes)) return { kind: 'text', text: bytes.toString('utf8') };
    const id = (await this.changes(role, sha)).find((c) => c.path === path)?.newBlob ?? null;
    // A path the save did not touch has no blob id in its change list; `<sha>:<path>` still names it
    const url = id ? blobUrl(role, id, path) : `vngit://${role}/${sha}/${path}`;
    return { kind: 'bytes', url, bytes: bytes.length };
  }

  /** The bytes `vngit://` serves: a blob by id, or a path at a commit. Null when neither exists. */
  async bytesAt(role: RepoRole, ref: string, path?: string): Promise<Buffer | null> {
    const found = await this.repo(role);
    if (!found) return null;
    return path === undefined ? found.git.catBlob(ref) : found.git.blob(ref, path);
  }

  /** The worktree, the branch and the remotes of one repository, with the cause of any dirt. */
  async status(role: RepoRole, pending: number): Promise<RepoStatus> {
    const { git } = await this.need(role);
    const [branch, inProgress, remotes, lastFetch] = await Promise.all([
      git.branchStatus(),
      git.inProgress(),
      git.remotes(),
      git.lastFetch(),
    ]);
    return {
      ...statusCause(branch.entries, pending, inProgress, OWN_LOGS),
      branch  : branch.head ?? inProgress.rebase?.branch ?? null,
      upstream: branch.upstream,
      ahead   : branch.ahead,
      behind  : branch.behind,
      remotes,
      lastFetch,
      inProgress,
    };
  }

  /** Forgets every held per-commit answer. Called when a rebase may have changed which shas exist. */
  dropMemo(): void {
    this.changesMemo.clear();
    this.diffMemo.clear();
  }
}

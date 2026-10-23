import { readFile, lstat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export interface Provenance {
  head: string | null;
  dirty: boolean;
}
export interface TrackerSample {
  prediction: Provenance | null;
  authoritative: Provenance | null;
  result: 'agree' | 'mismatch' | 'fallback' | 'used';
  reason: string;
  predictionMs: number;
  guardCacheHit: boolean;
  guardAuditMs: number;
  guardAuditShared: boolean;
  guardWaitMs: number;
}
interface GuardFlight {
  promise: Promise<string | null>;
  users: number;
}
export const operationMarkers = [
  'index.lock',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-merge',
  'rebase-apply',
  'sequencer',
  'info/sparse-checkout',
];
const environment = () =>
  JSON.stringify(
    Object.entries(process.env)
      .filter(([key]) => /^(GIT_|HOME$|USERPROFILE$|XDG_CONFIG_HOME$|PATH$)/i.test(key))
      .sort(),
  );
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const optional = async (path: string) => {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};

/** Conservative dirty witness. The caller controls rollout and Git fallback. */
export class RepositoryTracker {
  private baseline?: { head: string; hash: string };
  private generation = 0;
  private failed = false;
  private disabledReason = 'watcher unavailable';
  private watchers: FSWatcher[] = [];
  private samples: TrackerSample[] = [];
  private guardKey?: string;
  private guardFlights = new Map<string, GuardFlight>();
  private initialEnvironment = environment();
  constructor(
    private root: string,
    private gitdir: string,
    private common: string,
    private file: string,
    private audit: () => Promise<string | null>,
    private dependencies: string[],
  ) {
    if (!file || /[\\:]/.test(file) || file.split('/').some((p) => !p || p === '.' || p === '..'))
      throw new Error('invalid tracker file');
    for (const path of new Set([root, gitdir, common])) {
      try {
        const watcher = watch(path, { recursive: true }, (_event, name) => {
          if (!name) {
            this.failed = true;
            this.disabledReason = `watcher unnamed event: ${path} (${_event})`;
            return;
          }
          const changed = resolve(path, String(name)).replace(/\\/g, '/');
          const target = resolve(this.root, this.file).replace(/\\/g, '/');
          if (
            changed === target ||
            /\/(HEAD|index|index\.lock|packed-refs|config|config\.worktree|\.gitattributes|attributes|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD)$/.test(
              changed,
            ) ||
            /\/(refs|rebase-merge|rebase-apply|sequencer)\//.test(changed)
          )
            this.generation++;
        });
        watcher.on('error', (error: NodeJS.ErrnoException) => {
          this.failed = true;
          this.disabledReason = `watcher error: ${path} (${error.code ?? error.message})`;
        });
        watcher.unref();
        this.watchers.push(watcher);
      } catch (error) {
        this.failed = true;
        const detail = error as NodeJS.ErrnoException;
        this.disabledReason = `watcher setup failed: ${path} (${detail.code ?? detail.message})`;
      }
    }
  }
  setBaseline(head: string, bytes: Uint8Array): void {
    this.baseline = { head, hash: digest(bytes) };
  }
  baselineHead(): string | undefined {
    return this.baseline?.head;
  }
  invalidate(): void {
    this.baseline = undefined;
    this.guardKey = undefined;
    this.generation++;
  }
  close(): void {
    this.failed = true;
    this.disabledReason = 'tracker closed';
    for (const watcher of this.watchers) watcher.close();
  }
  read(): TrackerSample[] {
    return structuredClone(this.samples);
  }
  private async metadata() {
    const head = (await readFile(join(this.gitdir, 'HEAD'), 'utf8')).trim();
    const ref = head.startsWith('ref: ') ? head.slice(5) : null;
    const [loose, packed, index] = await Promise.all([
      ref ? optional(join(this.common, ref)) : null,
      optional(join(this.common, 'packed-refs')),
      readFile(join(this.gitdir, 'index')).then(digest),
    ]);
    const oid = ref
      ? (loose?.trim() ??
        packed
          ?.split('\n')
          .find((line) => line.endsWith(` ${ref}`))
          ?.split(' ')[0])
      : head;
    const [dependencies, operations] = await Promise.all([
      Promise.all(
        this.dependencies.map(async (path) => {
          try {
            if ((await lstat(path)).isSymbolicLink()) throw new Error('symbolic-link dependency');
            return digest(await readFile(path));
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw e;
          }
        }),
      ),
      Promise.all(
        operationMarkers.map(async (marker) => {
          try {
            await lstat(join(this.gitdir, marker));
            return marker;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw e;
          }
        }),
      ),
    ]);
    return { head, oid, packed, index, dependencies, operations, environment: environment() };
  }
  async predict(options?: { cachedGuardsOnly?: boolean }): Promise<{
    prediction: Provenance | null;
    reason: string;
    predictionMs: number;
    guardCacheHit: boolean;
    guardAuditMs: number;
    guardAuditShared: boolean;
    guardWaitMs: number;
  }> {
    const start = performance.now();
    let guardCacheHit = false;
    let guardAuditMs = 0;
    let guardAuditShared = false;
    let guardWaitMs = 0;
    let flight: GuardFlight | undefined;
    let flightKey = '';
    const result = (prediction: Provenance | null, reason: string) => ({
      prediction,
      reason,
      predictionMs: performance.now() - start,
      guardCacheHit,
      guardAuditMs,
      guardAuditShared,
      guardWaitMs,
    });
    if (this.failed) return result(null, this.disabledReason);
    if (!this.baseline) return result(null, 'no baseline');
    const baseline = this.baseline;
    try {
      const generation = this.generation;
      const before = await this.metadata();
      if (before.environment !== this.initialEnvironment)
        return result(null, 'environment changed');
      const key = JSON.stringify(before);
      guardCacheHit = this.guardKey === key;
      if (!guardCacheHit) {
        if (options?.cachedGuardsOnly) return result(null, 'guards need refresh');
        this.guardKey = undefined;
        // A notification during an audit starts a separate generation, even if the
        // dependency bytes later return to their earlier values.
        flightKey = JSON.stringify([generation, key]);
        flight = this.guardFlights.get(flightKey);
        guardAuditShared = !!flight;
        if (!flight) {
          flight = { promise: Promise.resolve().then(() => this.audit()), users: 0 };
          this.guardFlights.set(flightKey, flight);
        }
        flight.users++;
        const auditStart = performance.now();
        const unsupported = await flight.promise;
        if (guardAuditShared) guardWaitMs = performance.now() - auditStart;
        else guardAuditMs = performance.now() - auditStart;
        if (unsupported) return result(null, unsupported);
      }
      let path = this.root;
      for (const part of this.file.split('/')) {
        path = join(path, part);
        if ((await lstat(path)).isSymbolicLink()) return result(null, 'symbolic-link target');
      }
      const bytes = await readFile(join(this.root, this.file));
      const after = await this.metadata();
      if (this.failed) return result(null, this.disabledReason);
      if (this.baseline !== baseline) return result(null, 'baseline changed');
      if (generation !== this.generation || JSON.stringify(before) !== JSON.stringify(after))
        return result(null, 'changed during check');
      // Publish only an audit whose complete dependency set stayed stable. Recheck this
      // content fingerprint even on hits; filesystem notifications are supplementary.
      this.guardKey = key;
      if (after.oid !== baseline.head) return result(null, 'HEAD changed');
      if (digest(bytes) === baseline.hash) return result(null, 'no dirty witness');
      return result({ head: baseline.head, dirty: true }, 'dirty witness');
    } catch {
      return result(null, 'unreadable state');
    } finally {
      // Keep the flight available until its consumers finish validation and publish
      // the cache. Failed and unsupported audits must also be released for retry.
      if (flight && --flight.users === 0 && this.guardFlights.get(flightKey) === flight)
        this.guardFlights.delete(flightKey);
    }
  }
  record(
    candidate: Awaited<ReturnType<RepositoryTracker['predict']>>,
    authoritative: Provenance | null,
  ): void {
    const prediction = candidate.prediction;
    const result =
      !authoritative && prediction
        ? 'used'
        : !prediction
          ? 'fallback'
          : prediction.head === authoritative?.head && prediction.dirty === authoritative?.dirty
            ? 'agree'
            : 'mismatch';
    this.samples.push({ ...candidate, authoritative, result });
    if (this.samples.length > 200) this.samples.shift();
    if (result === 'mismatch') {
      this.invalidate();
      this.failed = true;
      this.disabledReason = 'disabled after mismatch';
    }
  }
}

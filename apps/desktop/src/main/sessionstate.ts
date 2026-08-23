/**
 * The two session files, behind one key/value surface.
 *
 * Remembered UI state is split by what it is about. The arrangement of a project's windows —
 * their meshes, selections, applied templates and bounds — belongs to the project and lives in
 * `<root>/.vnstudio/session.json`. Preferences about this machine (`agent.budget`, the
 * notification filter, the recents list) stay in the install-global file. `isProjectKey` is the
 * only thing that decides, and nothing outside this module may hold a `SessionStore` directly,
 * or a key would route one way through `ctx.host.state` and another way through a module-level
 * reference.
 *
 * A project whose store could not be opened keeps no arrangement: writes are dropped and reads
 * answer the fallback. Falling back to the install file instead would mean inventing scoped key
 * names again, and two unwritable projects would then overwrite each other.
 */
import { join } from 'node:path';
import { createLogger } from '@vn/util';
import { isProjectKey, scopedWindowKeys, workspaceScope } from '../shared/sessionkeys.js';
import { SessionStore, type SessionListener, type SessionValue } from './sessionstore.js';

const log = createLogger().child({ mod: 'sessionstate' });

/** Where a project keeps its own session file, beside its layout templates. */
export const PROJECT_STATE_DIR = '.vnstudio';

/** What a command reaches remembered UI state through — `ctx.host.state`. */
export interface SessionAccess {
  get<T extends SessionValue>(key: string, fallback: T): T;
  set(key: string, value: SessionValue): void;
}

export class SessionState implements SessionAccess {
  private project: SessionStore | undefined;
  private scope = '';

  constructor(
    private readonly install: SessionStore,
    private readonly onChange?: SessionListener,
  ) {}

  /**
   * Open `root`'s own store, replacing whatever project was open. The previous one is flushed
   * first, so the arrangement of the project being left is on disk before its windows reload.
   *
   * A store holding no project key is one this build has not written yet, and is seeded from the
   * install file's `pathux.<scope>.` keys. The install's copies are left in place, so a downgrade
   * still opens the project as it did.
   */
  async openProject(root: string): Promise<void> {
    await this.closeProject();
    this.scope = workspaceScope(root);
    try {
      const store = await SessionStore.open(join(root, PROJECT_STATE_DIR), this.onChange);
      const seed = scopedWindowKeys(this.install.snapshot(), this.scope);
      if (!Object.keys(store.snapshot()).some(isProjectKey)) {
        for (const [key, value] of Object.entries(seed)) store.set(key, value);
        await store.flush();
      }
      this.project = store;
    } catch (err) {
      log.warn('this project keeps no window arrangement', { root, error: String(err) });
    }
  }

  async closeProject(): Promise<void> {
    const store = this.project;
    this.project = undefined;
    this.scope = '';
    if (store) await store.close();
  }

  /** Both files as one map. The key sets are disjoint, so the merge order never decides. */
  snapshot(): Record<string, SessionValue> {
    return { ...this.install.snapshot(), ...(this.project?.snapshot() ?? {}) };
  }

  get<T extends SessionValue>(key: string, fallback: T): T {
    if (!isProjectKey(key)) return this.install.get(key, fallback);
    return this.project ? this.project.get(key, fallback) : fallback;
  }

  /**
   * Record a value. `scope` is a window's stamp: a project-key write naming a project other than
   * the open one is dropped rather than landing in the wrong file. A switch reloads every window,
   * but a renderer that has not been torn down yet still flushes on `beforeunload`, and those
   * bytes describe the project it was showing.
   */
  set(key: string, value: SessionValue, scope?: string): void {
    if (!isProjectKey(key)) {
      this.install.set(key, value);
      return;
    }
    if (scope !== undefined && scope !== '' && scope !== this.scope) return;
    this.project?.set(key, value);
  }

  async flush(): Promise<void> {
    await Promise.all([this.install.flush(), this.project?.flush()]);
  }

  async close(): Promise<void> {
    await this.closeProject();
    await this.install.close();
  }
}

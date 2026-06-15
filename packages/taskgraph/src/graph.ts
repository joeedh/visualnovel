import type { AnyTask, Task, TaskGraph as ITaskGraph, TaskKind, TaskStatus } from '@vn/types';
import { VnError } from '@vn/util';

/**
 * In-memory DAG of content-addressed tasks (report §7). Adding a task with an existing
 * hash returns the canonical node (dedupe). The scheduler drives execution off `ready()`
 * and `topoOrder()`; status transitions are recorded so re-runs skip `done` work.
 */
export class TaskGraph implements ITaskGraph {
  private readonly nodes = new Map<string, AnyTask>();

  add<K extends TaskKind>(task: Task<K>): Task<K> {
    const existing = this.nodes.get(task.hash);
    if (existing) {
      // Dedupe: union dependency edges in case a later producer adds more context.
      for (const dep of task.deps) if (!existing.deps.includes(dep)) existing.deps.push(dep);
      return existing as Task<K>;
    }
    this.nodes.set(task.hash, task as AnyTask);
    return task;
  }

  get(hash: string): AnyTask | undefined {
    return this.nodes.get(hash);
  }

  all(): readonly AnyTask[] {
    return [...this.nodes.values()];
  }

  /** Pending tasks whose every dependency exists and is `done`. */
  ready(): readonly AnyTask[] {
    return this.all().filter(
      (t) => t.status === 'pending' && t.deps.every((d) => this.nodes.get(d)?.status === 'done'),
    );
  }

  setStatus(hash: string, status: TaskStatus, patch?: Partial<AnyTask>): void {
    const node = this.nodes.get(hash);
    if (!node) throw new VnError('UNKNOWN_TASK', `no task with hash ${hash}`);
    node.status = status;
    if (patch) Object.assign(node, patch);
  }

  /** Kahn-style topological order over dependency edges; throws on a cycle. */
  topoOrder(): string[] {
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const node of this.nodes.values()) {
      indegree.set(node.hash, 0);
      dependents.set(node.hash, []);
    }
    for (const node of this.nodes.values()) {
      for (const dep of node.deps) {
        if (!this.nodes.has(dep)) continue;
        indegree.set(node.hash, (indegree.get(node.hash) ?? 0) + 1);
        dependents.get(dep)!.push(node.hash);
      }
    }
    const queue = [...indegree.entries()]
      .filter(([, d]) => d === 0)
      .map(([h]) => h)
      .sort();
    const order: string[] = [];
    while (queue.length) {
      const h = queue.shift() as string;
      order.push(h);
      for (const dep of dependents.get(h) ?? []) {
        const d = (indegree.get(dep) ?? 0) - 1;
        indegree.set(dep, d);
        if (d === 0) {
          queue.push(dep);
          queue.sort();
        }
      }
    }
    if (order.length !== this.nodes.size) {
      throw new VnError('CYCLE', 'task graph contains a cycle');
    }
    return order;
  }

  /**
   * Drop tasks whose hash is not in `keep` (report §7 staleness): after re-planning,
   * tasks for inputs that changed get new hashes, so the old subtree becomes orphaned
   * and is pruned, leaving untouched branches alone.
   */
  prune(keep: Set<string>): string[] {
    const removed: string[] = [];
    for (const hash of [...this.nodes.keys()]) {
      if (!keep.has(hash)) {
        this.nodes.delete(hash);
        removed.push(hash);
      }
    }
    return removed;
  }
}

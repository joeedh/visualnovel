import type { GraphId } from 'pathux-graph';

/**
 * Carried on every record, because git union-merges the journal across clones. Version 2
 * added `runKey`; parsing does not gate on the version, so a reader takes the fields it
 * knows from any numeric `v`.
 */
export const GRAPH_JOURNAL_VERSION = 2;

/**
 * Reports where a node's last run got to. A deliberate re-render writes `invalidated`,
 * because the node's hash has not moved and only a record retiring its last answer can
 * make it run again.
 */
export type GenNodeStatus = 'running' | 'done' | 'failed' | 'invalidated';

const STATUSES: ReadonlySet<GenNodeStatus> = new Set<GenNodeStatus>([
  'running',
  'done',
  'failed',
  'invalidated',
]);

/** What one node's run consumed, in the units a price table charges for. */
export interface GenUsage {
  /** The model the run billed against. */
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Pictures produced, which an image model bills per unit rather than per token. */
  images?: number;
}

/**
 * One node's state at one moment, written whole rather than as a delta. Replaying the
 * file rebuilds every node's last known state, which is what makes an interrupted run
 * resumable.
 */
export interface GraphJournalRecord {
  v: number;
  /**
   * The node's key: its id for a root node, and the `<instance>/<id>` chain for a node
   * inside a group, so two inner nodes sharing an id never share a record.
   */
  nodeId: GraphId;
  nodeHash: string;
  /**
   * The node's hash over the authored graph alone, which drift is measured against. Absent
   * on a record written before the field existed, and such a record reports no drift.
   */
  authoredHash?: string;
  /**
   * The hash of what fed the node when it ran: its type and version, its resolved props and
   * the values on its input sockets. Present on every record the executor writes and absent
   * on an `invalidated` record, which is written at rest where no key exists, and on any
   * record written before the field existed.
   */
  runKey?: string;
  status: GenNodeStatus;
  /** Socket name to value, as the run left it. Written on a `done` record. */
  output?: Record<string, unknown>;
  /**
   * Absent on a `done` record the executor writes for a cached answer, so anything summing
   * usage from the journal must skip a record without it rather than read it as free.
   */
  usage?: GenUsage;
  /** Why the run failed. Written on a `failed` record. */
  error?: string;
  /** ISO 8601, from the host's clock. */
  at: string;
}

export interface GraphJournal {
  /** Each node's most recent record, whatever status it carries. */
  latest: ReadonlyMap<GraphId, GraphJournalRecord>;
  /** Each node's most recent `done` record. */
  lastDone: ReadonlyMap<GraphId, GraphJournalRecord>;
  /**
   * Per node, the `done` records carrying a `runKey` that no later `invalidated` record has
   * retired, by that key, latest writer winning per key.
   */
  cached: ReadonlyMap<GraphId, ReadonlyMap<string, GraphJournalRecord>>;
  /**
   * Per node, the parsed `at` of the latest `invalidated` record. A `done` record stamped
   * earlier than it stays out of `cached` whatever order the file holds the two lines in.
   */
  invalidatedAt: ReadonlyMap<GraphId, number>;
  /** Lines that did not parse as a record. A crash mid-append leaves one behind. */
  skipped: number;
}

/** Stamps the current version onto a record the caller has otherwise filled in. */
export function journalRecord(fields: Omit<GraphJournalRecord, 'v'>): GraphJournalRecord {
  return { v: GRAPH_JOURNAL_VERSION, ...fields };
}

export function emptyJournal(): GraphJournal {
  return {
    latest       : new Map(),
    lastDone     : new Map(),
    cached       : new Map(),
    invalidatedAt: new Map(),
    skipped      : 0,
  };
}

/** A copy a caller can advance without moving the journal it was taken from. */
export function cloneJournal(journal: GraphJournal): GraphJournal {
  const cached = new Map<GraphId, Map<string, GraphJournalRecord>>();
  for (const [nodeId, byKey] of journal.cached) {
    cached.set(nodeId, new Map(byKey));
  }
  return {
    latest  : new Map(journal.latest),
    lastDone: new Map(journal.lastDone),
    cached,
    invalidatedAt: new Map(journal.invalidatedAt),
    skipped      : journal.skipped,
  };
}

/**
 * Advances the journal by one record, in place. This is the one place the update rule is
 * written: `latest` and `lastDone` take the record, a `done` record with a `runKey` enters
 * `cached` unless it is stamped earlier than the node's latest invalidation, and an
 * `invalidated` record retires every cached answer stamped at or before it. A `failed` or
 * `running` record leaves `cached` alone, because a failure is not an answer and does not
 * retire the answers whose keys say what they were fed. A stamp that does not parse counts
 * as older than everything.
 */
export function applyRecord(journal: GraphJournal, record: GraphJournalRecord): void {
  const latest = journal.latest as Map<GraphId, GraphJournalRecord>;
  const lastDone = journal.lastDone as Map<GraphId, GraphJournalRecord>;
  const cached = journal.cached as Map<GraphId, Map<string, GraphJournalRecord>>;
  const invalidatedAt = journal.invalidatedAt as Map<GraphId, number>;

  latest.set(record.nodeId, record);

  if (record.status === 'done') {
    lastDone.set(record.nodeId, record);

    const cutoff = invalidatedAt.get(record.nodeId);
    if (record.runKey !== undefined && (cutoff === undefined || stampOf(record.at) >= cutoff)) {
      let byKey = cached.get(record.nodeId);
      if (byKey === undefined) {
        byKey = new Map();
        cached.set(record.nodeId, byKey);
      }
      byKey.set(record.runKey, record);
    }
    return;
  }

  if (record.status === 'invalidated') {
    const at = stampOf(record.at);
    invalidatedAt.set(record.nodeId, Math.max(at, invalidatedAt.get(record.nodeId) ?? -Infinity));

    const byKey = cached.get(record.nodeId);
    if (byKey !== undefined) {
      for (const [key, answer] of byKey) {
        if (stampOf(answer.at) <= at) {
          byKey.delete(key);
        }
      }
      if (byKey.size === 0) {
        cached.delete(record.nodeId);
      }
    }
  }
}

/** A record's stamp as a number, with one that does not parse older than any that does. */
function stampOf(at: string): number {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? -Infinity : ms;
}

/**
 * Replays a journal's text, last writer winning per node the way `state/tasks.jsonl` is
 * replayed. A line that does not parse is counted and skipped rather than thrown on: an
 * interrupted append leaves a partial line at the end of the file, and every record
 * before it is still good.
 */
export function replayJournal(text: string): GraphJournal {
  const journal = emptyJournal();

  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }

    const record = parseRecord(line);
    if (record === undefined) {
      journal.skipped++;
      continue;
    }

    applyRecord(journal, record);
  }

  return journal;
}

function parseRecord(line: string): GraphJournalRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const record = value as Partial<GraphJournalRecord>;
  const id = record.nodeId;

  if (typeof id !== 'number' && typeof id !== 'string') {
    return undefined;
  }
  if (typeof record.v !== 'number' || typeof record.nodeHash !== 'string') {
    return undefined;
  }
  if (typeof record.at !== 'string') {
    return undefined;
  }
  if (!STATUSES.has(record.status as GenNodeStatus)) {
    return undefined;
  }

  return record as GraphJournalRecord;
}

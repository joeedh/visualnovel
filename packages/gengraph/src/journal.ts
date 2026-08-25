import type { GraphId } from 'pathux-graph';

/** Carried on every record, because git union-merges the journal across clones. */
export const GRAPH_JOURNAL_VERSION = 1;

export type GenNodeStatus = 'running' | 'done' | 'failed';

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
  nodeId: GraphId;
  nodeHash: string;
  status: GenNodeStatus;
  /** Socket name to value, as the run left it. Written on a `done` record. */
  output?: Record<string, unknown>;
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
  /** Lines that did not parse as a record. A crash mid-append leaves one behind. */
  skipped: number;
}

/** Stamps the current version onto a record the caller has otherwise filled in. */
export function journalRecord(fields: Omit<GraphJournalRecord, 'v'>): GraphJournalRecord {
  return { v: GRAPH_JOURNAL_VERSION, ...fields };
}

export function emptyJournal(): GraphJournal {
  return { latest: new Map(), lastDone: new Map(), skipped: 0 };
}

/**
 * Replays a journal's text, last writer winning per node the way `state/tasks.jsonl` is
 * replayed. A line that does not parse is counted and skipped rather than thrown on: an
 * interrupted append leaves a partial line at the end of the file, and every record
 * before it is still good.
 */
export function replayJournal(text: string): GraphJournal {
  const latest = new Map<GraphId, GraphJournalRecord>();
  const lastDone = new Map<GraphId, GraphJournalRecord>();
  let skipped = 0;

  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }

    const record = parseRecord(line);
    if (record === undefined) {
      skipped++;
      continue;
    }

    latest.set(record.nodeId, record);
    if (record.status === 'done') {
      lastDone.set(record.nodeId, record);
    }
  }

  return { latest, lastDone, skipped };
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
  if (record.status !== 'running' && record.status !== 'done' && record.status !== 'failed') {
    return undefined;
  }

  return record as GraphJournalRecord;
}

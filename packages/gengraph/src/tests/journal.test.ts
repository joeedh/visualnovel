import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectPaths } from '@vn/store';

import {
  GRAPH_JOURNAL_VERSION,
  applyRecord,
  cloneJournal,
  journalRecord,
  replayJournal,
} from '../index.js';
import type { GenNodeStatus, GraphJournalRecord } from '../index.js';
import { appendGraphJournal, readGraphJournal } from '../state.js';

function line(record: GraphJournalRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function record(nodeId: number, nodeHash: string, status: 'running' | 'done' | 'failed') {
  return journalRecord({ nodeId, nodeHash, status, at: '2026-08-25T10:00:00.000Z' });
}

/** A record with a run key, stamped `minutes` past ten o'clock. */
function keyed(
  nodeId: number,
  runKey: string,
  status: GenNodeStatus,
  minutes: number,
): GraphJournalRecord {
  return journalRecord({
    nodeId,
    nodeHash: 'aaa',
    runKey,
    status,
    output: { text: runKey },
    at    : `2026-08-25T10:${String(minutes).padStart(2, '0')}:00.000Z`,
  });
}

function retire(nodeId: number, minutes: number): GraphJournalRecord {
  return journalRecord({
    nodeId,
    nodeHash: 'aaa',
    status  : 'invalidated',
    at      : `2026-08-25T10:${String(minutes).padStart(2, '0')}:00.000Z`,
  });
}

function keysOf(journal: ReturnType<typeof replayJournal>, nodeId: number): string[] {
  return [...(journal.cached.get(nodeId)?.keys() ?? [])];
}

describe('the run journal', () => {
  it('stamps a version on every record', () => {
    expect(record(0, 'aaa', 'done').v).toBe(GRAPH_JOURNAL_VERSION);
  });

  it('replays last writer wins, per node', () => {
    const text =
      line(record(0, 'aaa', 'running')) +
      line(record(1, 'bbb', 'done')) +
      line(record(0, 'ccc', 'done'));

    const journal = replayJournal(text);

    expect(journal.latest.get(0)?.nodeHash).toBe('ccc');
    expect(journal.latest.get(1)?.nodeHash).toBe('bbb');
    expect(journal.skipped).toBe(0);
  });

  it('remembers the last completed run behind a later failure', () => {
    const text = line(record(0, 'aaa', 'done')) + line(record(0, 'bbb', 'failed'));
    const journal = replayJournal(text);

    expect(journal.latest.get(0)?.status).toBe('failed');
    expect(journal.lastDone.get(0)?.nodeHash).toBe('aaa');
  });

  it('keeps the records before a half-written line, and counts the line', () => {
    const text = line(record(0, 'aaa', 'done')) + '{"v":1,"nodeId":1,"nodeH';
    const journal = replayJournal(text);

    expect(journal.lastDone.get(0)?.nodeHash).toBe('aaa');
    expect(journal.skipped).toBe(1);
  });

  it('skips a line that parses but is not a record', () => {
    const journal = replayJournal('{"v":1,"nodeId":0}\n[]\n"nope"\n');

    expect(journal.latest.size).toBe(0);
    expect(journal.skipped).toBe(3);
  });

  it('reads an empty file as a graph that has never run', () => {
    const journal = replayJournal('');

    expect(journal.latest.size).toBe(0);
    expect(journal.skipped).toBe(0);
  });
});

describe('the answers a journal still holds', () => {
  it('files every keyed done record under its node and key, latest writer winning', () => {
    const text =
      line(keyed(0, 'k1', 'done', 1)) +
      line(keyed(0, 'k2', 'done', 2)) +
      line(keyed(1, 'k1', 'done', 3)) +
      line(keyed(0, 'k1', 'done', 4));

    const journal = replayJournal(text);

    expect(keysOf(journal, 0).sort()).toEqual(['k1', 'k2']);
    expect(journal.cached.get(0)?.get('k1')?.at).toBe('2026-08-25T10:04:00.000Z');
    expect(keysOf(journal, 1)).toEqual(['k1']);
  });

  it('keeps a done record without a key out, and a running or failed record too', () => {
    const text =
      line(record(0, 'aaa', 'done')) +
      line(keyed(0, 'k1', 'running', 1)) +
      line(keyed(0, 'k2', 'failed', 2));

    const journal = replayJournal(text);

    expect(journal.lastDone.get(0)).toBeDefined();
    expect(journal.cached.has(0)).toBe(false);
  });

  it('retires the answers stamped at or before an invalidation and leaves a later one', () => {
    const text =
      line(keyed(0, 'k1', 'done', 1)) +
      line(keyed(0, 'k2', 'done', 5)) +
      line(keyed(0, 'k3', 'done', 9)) +
      line(retire(0, 5));

    const journal = replayJournal(text);

    expect(keysOf(journal, 0)).toEqual(['k3']);
    expect(journal.latest.get(0)?.status).toBe('invalidated');
  });

  it('keeps out an older answer whose line lands after the invalidation', () => {
    const text = line(retire(0, 5)) + line(keyed(0, 'k1', 'done', 1));

    const journal = replayJournal(text);

    expect(journal.cached.has(0)).toBe(false);
    expect(journal.lastDone.get(0)?.runKey).toBe('k1');
  });

  it('retires an answer whose stamp does not parse, as if it were old', () => {
    const stale = { ...keyed(0, 'k1', 'done', 1), at: 'yesterday' };
    const text = line(stale) + line(retire(0, 5));

    expect(replayJournal(text).cached.has(0)).toBe(false);
  });

  it('leaves the answers of the other nodes alone', () => {
    const text = line(keyed(1, 'k1', 'done', 1)) + line(retire(0, 5));

    expect(keysOf(replayJournal(text), 1)).toEqual(['k1']);
  });

  it('does not retire anything on a failure', () => {
    const text = line(keyed(0, 'k1', 'done', 1)) + line(keyed(0, 'k2', 'failed', 2));

    expect(keysOf(replayJournal(text), 0)).toEqual(['k1']);
  });
});

describe('advancing a journal', () => {
  it('applies one record the way replay would', () => {
    const records = [keyed(0, 'k1', 'done', 1), retire(0, 2), keyed(0, 'k2', 'done', 3)];
    const journal = replayJournal('');

    for (const record of records) {
      applyRecord(journal, record);
    }

    expect(journal).toEqual(replayJournal(records.map((r) => line(r)).join('')));
  });

  it('leaves the source of a clone where it was', () => {
    const source = replayJournal(line(keyed(0, 'k1', 'done', 1)));
    const copy = cloneJournal(source);

    applyRecord(copy, keyed(0, 'k2', 'done', 2));
    applyRecord(copy, keyed(1, 'k1', 'done', 3));
    applyRecord(copy, retire(0, 9));

    expect(keysOf(source, 0)).toEqual(['k1']);
    expect(source.latest.get(0)?.status).toBe('done');
    expect(source.latest.has(1)).toBe(false);
    expect(keysOf(copy, 0)).toEqual([]);
    expect(keysOf(copy, 1)).toEqual(['k1']);
  });
});

describe('the journal on disk', () => {
  let root: string;
  let paths: ProjectPaths;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vn-gengraph-'));
    paths = new ProjectPaths(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads back what a run appended', async () => {
    await appendGraphJournal(paths, 'cafe', record(0, 'aaa', 'running'));
    await appendGraphJournal(paths, 'cafe', record(0, 'aaa', 'done'));

    const journal = await readGraphJournal(paths, 'cafe');

    expect(journal.lastDone.get(0)?.nodeHash).toBe('aaa');
    expect(journal.skipped).toBe(0);
  });

  it('reads a graph that has never run as an empty journal', async () => {
    const journal = await readGraphJournal(paths, 'cafe');

    expect(journal.latest.size).toBe(0);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectPaths } from '@vn/store';

import { GRAPH_JOURNAL_VERSION, journalRecord, replayJournal } from '../index.js';
import type { GraphJournalRecord } from '../index.js';
import { appendGraphJournal, readGraphJournal } from '../state.js';

function line(record: GraphJournalRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function record(nodeId: number, nodeHash: string, status: 'running' | 'done' | 'failed') {
  return journalRecord({ nodeId, nodeHash, status, at: '2026-08-25T10:00:00.000Z' });
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

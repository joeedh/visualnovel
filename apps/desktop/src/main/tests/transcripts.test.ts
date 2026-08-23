/**
 * What a debug conversation leaves on disk, and what it deliberately does not.
 *
 * Two things are pinned. The directory holds ten transcripts and drops the oldest, counted as a
 * conversation starts so a crashed run cannot leave an eleventh. And a tool's result never reaches
 * the file: the request captures are the author's own traffic, and a transcript is meant to be easy
 * to attach to an issue.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  TRANSCRIPTS_KEPT,
  TRANSCRIPT_VERSION,
  openTranscript,
  readTranscript,
  transcriptBody,
  transcriptsDir,
} from '../agentreport.js';
import type { Report } from '@vn/agentreport';
import type { ReportRow } from '../../shared/ipc.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'vn-transcripts-'));
  process.env.VNAUTHOR_HOME = home;
});

afterEach(async () => {
  delete process.env.VNAUTHOR_HOME;
  await rm(home, { recursive: true, force: true });
});

/** A transcript already sitting in the directory, named the way a real one is. */
async function existing(stamp: string): Promise<void> {
  const dir = transcriptsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, `${stamp}.jsonl`), '');
}

function names(): Promise<string[]> {
  return fs.readdir(transcriptsDir()).then((list) => list.sort());
}

describe('the directory', () => {
  it('keeps ten, counting the conversation that is starting', async () => {
    for (let day = 1; day <= 12; day++) {
      await existing(`2026-08-${String(day).padStart(2, '0')}T00-00-00-000Z`);
    }
    const opened = await openTranscript(new Date('2026-08-22T10:00:00.000Z'));
    opened.write({ kind: 'agent', text: 'here it is' });
    await opened.settled();

    const kept = await names();
    expect(kept).toHaveLength(TRANSCRIPTS_KEPT);
    expect(kept[kept.length - 1]).toBe('2026-08-22T10-00-00-000Z.jsonl');
    // The three oldest went, and the newest of what was there stayed
    expect(kept[0]).toBe('2026-08-04T00-00-00-000Z.jsonl');
  });

  it('leaves a directory that is not yet full alone', async () => {
    await existing('2026-08-01T00-00-00-000Z');
    await openTranscript(new Date('2026-08-22T10:00:00.000Z'));
    expect(await names()).toEqual(['2026-08-01T00-00-00-000Z.jsonl']);
  });

  it('lives outside every repository, under the user config directory', () => {
    expect(transcriptsDir()).toBe(join(home, 'debug-transcripts'));
  });
});

describe('what a row is written down as', () => {
  const result = { ok: true, output: 'ANTHROPIC_API_KEY=sk-the-authors-own-traffic' };

  it('writes a tool by name and by what it acted on, and never by what came back', () => {
    const row: ReportRow = {
      kind: 'event',
      event: { type: 'tool', tool: 'read_request', args: { id: 3 }, result },
    };
    expect(transcriptBody(row)).toEqual({ kind: 'tool', text: 'read_request 3' });
  });

  it('writes the author’s turn and the analyst’s prose', () => {
    expect(transcriptBody({ kind: 'said', text: 'it lost my scene' })).toEqual({
      kind: 'user',
      text: 'it lost my scene',
    });
    expect(
      transcriptBody({ kind: 'event', event: { type: 'message', text: 'reading it now' } }),
    ).toEqual({ kind: 'agent', text: 'reading it now' });
  });

  it('writes a refused call, which is a fact about the turn rather than a result', () => {
    const row: ReportRow = {
      kind: 'event',
      event: { type: 'blocked', tool: 'read_file', reason: 'outside the source root' },
    };
    expect(transcriptBody(row)).toEqual({
      kind: 'blocked',
      text: 'read_file blocked — outside the source root',
    });
  });

  it('writes nothing for a row about the machinery', () => {
    expect(
      transcriptBody({ kind: 'event', event: { type: 'usage', input: 900, output: 30 } }),
    ).toBeUndefined();
    expect(
      transcriptBody({
        kind: 'event',
        event: { type: 'api', phase: 'retrying', attempt: 2, of: 3, message: 'overloaded' },
      }),
    ).toBeUndefined();
  });

  it('writes a filed report without the path the archived copy went to', () => {
    const row: ReportRow = {
      kind: 'filed',
      report: {} as Report,
      title: 'edit_scene dropped a line',
      body: '# edit_scene dropped a line',
      file: 'C:/Users/someone/AppData/Roaming/vnstudio/reports/one.md',
    };
    expect(transcriptBody(row)).toEqual({
      kind: 'filed',
      title: 'edit_scene dropped a line',
      body: '# edit_scene dropped a line',
    });
  });

  it('keeps a tool’s output out of the file itself', async () => {
    const transcript = await openTranscript(new Date('2026-08-22T10:00:00.000Z'));
    transcript.row({
      kind: 'event',
      event: { type: 'tool', tool: 'read_request', args: { id: 3 }, result },
    });
    await transcript.settled();

    const text = await fs.readFile(transcript.file, 'utf8');
    expect(text).toContain('read_request');
    expect(text).not.toContain('sk-the-authors-own-traffic');
  });
});

describe('the line format', () => {
  it('stamps every line with its version and when it was written', async () => {
    const transcript = await openTranscript(new Date('2026-08-22T10:00:00.000Z'));
    transcript.write(
      { kind: 'opened', thread: 't1', model: 'claude-opus-5', source: true, detail: false },
      new Date('2026-08-22T10:00:01.000Z'),
    );
    transcript.write({ kind: 'granted', access: 'detail' }, new Date('2026-08-22T10:05:00.000Z'));
    await transcript.settled();

    expect(await readTranscript(transcript.file)).toEqual([
      {
        v: TRANSCRIPT_VERSION,
        at: '2026-08-22T10:00:01.000Z',
        kind: 'opened',
        thread: 't1',
        model: 'claude-opus-5',
        source: true,
        detail: false,
      },
      {
        v: TRANSCRIPT_VERSION,
        at: '2026-08-22T10:05:00.000Z',
        kind: 'granted',
        access: 'detail',
      },
    ]);
  });

  it('skips a line it cannot read and keeps the ones around it', async () => {
    const transcript = await openTranscript(new Date('2026-08-22T10:00:00.000Z'));
    transcript.write({ kind: 'user', text: 'first' });
    await transcript.settled();
    await fs.appendFile(
      transcript.file,
      `${JSON.stringify({ v: TRANSCRIPT_VERSION + 1, kind: 'whatever-comes-next' })}\n`,
    );
    transcript.write({ kind: 'user', text: 'last' });
    await transcript.settled();

    expect((await readTranscript(transcript.file)).map((line) => line.kind)).toEqual([
      'user',
      'user',
    ]);
  });
});

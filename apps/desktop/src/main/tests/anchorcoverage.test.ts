/**
 * The half of the anchor sweep that can run without an app: `apps/desktop/anchors.json` is
 * measured by `scripts/sweep-anchors.mjs` against a running desktop, and this reads what it wrote.
 *
 * CI has no window, no CDP port and no workspace, so nothing here opens a pane. What it can still
 * catch is a file that has gone stale — a command renamed out from under a record, a command added
 * since the last sweep — and a file that contradicts itself. Whether every command has a control
 * is `uxmodel.test.ts`'s question, asked of the derived model rather than of a count.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDesktopRegistry } from '../commands/index.js';

interface Sweep {
  sweptAt: string;
  gitSha: string;
  commands: string[];
  anchored: string[];
  records: { id: string; editor: string }[];
}

const sweep = JSON.parse(
  readFileSync(resolve(__dirname, '../../../anchors.json'), 'utf8'),
) as Sweep;

const live = createDesktopRegistry()
  .list()
  .map((command) => command.id)
  .sort();

describe('anchors.json', () => {
  it('points only at commands that still exist', () => {
    const unknown = [...new Set(sweep.records.map((record) => record.id))].filter(
      (id) => !live.includes(id),
    );
    expect(unknown).toEqual([]);
  });

  // Not a digest: the ids themselves, so a failure names the command that arrived rather than
  // reporting that two numbers differ.
  it('was measured against the commands that exist now', () => {
    expect(sweep.commands).toEqual(live);
  });

  it('agrees with itself about what it found', () => {
    expect(sweep.anchored).toEqual([...new Set(sweep.records.map((r) => r.id))].sort());
  });
});

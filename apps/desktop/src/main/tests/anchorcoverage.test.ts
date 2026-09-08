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
import { createDesktopEffects } from '../../shared/effects.js';

interface Sweep {
  sweptAt: string;
  gitSha: string;
  commands: string[];
  /** The distinct command ids the records name. Effects are listed apart, under `effects`. */
  anchored: string[];
  /** The distinct effect ids the records name; absent from a sweep made before effects existed. */
  effects?: string[];
  records: { id: string; editor: string }[];
}

const sweep = JSON.parse(
  readFileSync(resolve(__dirname, '../../../anchors.json'), 'utf8'),
) as Sweep;

const live = createDesktopRegistry()
  .list()
  .map((command) => command.id)
  .sort();

const effects = createDesktopEffects()
  .list()
  .map((effect) => effect.id)
  .sort();

const isEffect = (id: string): boolean => effects.includes(id);

describe('anchors.json', () => {
  it('points only at commands and effects that still exist', () => {
    const unknown = [...new Set(sweep.records.map((record) => record.id))].filter(
      (id) => !live.includes(id) && !isEffect(id),
    );
    expect(unknown).toEqual([]);
  });

  // Not a digest: the ids themselves, so a failure names the command that arrived rather than
  // reporting that two numbers differ.
  it('was measured against the commands that exist now', () => {
    expect(sweep.commands).toEqual(live);
  });

  it('agrees with itself about what it found', () => {
    const named = [...new Set(sweep.records.map((r) => r.id))].sort();
    expect(sweep.anchored).toEqual(named.filter((id) => !isEffect(id)));
    expect(sweep.effects ?? []).toEqual(named.filter(isEffect));
  });
});

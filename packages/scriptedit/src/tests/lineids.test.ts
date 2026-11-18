/**
 * The line-id contract: ids are allocated by the scene and stored as marks, never derived from a
 * line's position, and reading a project allocates in memory without writing anything back.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pins } from '@vn/contracts';
import { assignLineIds, splitScenes } from '@vn/model';
import { parseFountain } from '@vn/parse';
import { makeProject } from '@vn/testkit';
import type { Scene } from '@vn/types';
import { insertLine, scriptLineIdsAllocated } from '../lineops.js';

const UNMARKED = `INT. CLASSROOM - EVENING

[[scene: arrival]]

Aiko slips into the seat by the window.

AIKO
You're late.
`;

const scenesOf = (text: string): Map<string, Scene> =>
  new Map(splitScenes(parseFountain(text)).scenes.map((s) => [s.id, s]));

const ids = (scene: Scene | undefined): string[] => scene?.lines.map((l) => l.id) ?? [];

/** Every file under `dir`, with its bytes, so a read can be shown to have written nothing. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    out.set(file, await readFile(file, 'utf8'));
  }
  return out;
}

describe(pins(scriptLineIdsAllocated), () => {
  it('gives an inserted line the next allocated id and leaves every other id where it was', () => {
    const op = insertLine(
      { scenes: scenesOf(UNMARKED) },
      { scene: 'arrival', after: '', kind: 'narration', speaker: '', text: 'The bell rings.' },
    );
    if (!op.ok) throw new Error(op.error);
    expect(ids(op.writes[0])).toEqual(['arrival:L3', 'arrival:L1', 'arrival:L2']);
  });

  it('persists the allocated ids as marks, so a later read allocates the same ones', () => {
    const before = ids(scenesOf(UNMARKED).get('arrival'));
    const marked = assignLineIds(UNMARKED);
    expect(marked.diagnostics).toEqual([]);
    expect(marked.text).toContain('[[line: L1]]');
    expect(marked.text).toContain('[[nextline: 3]]');
    expect(ids(scenesOf(marked.text).get('arrival'))).toEqual(before);
    // A second pass finds every line already marked
    expect(assignLineIds(marked.text)).toMatchObject({ text: marked.text, assigned: 0 });
  });

  it('allocates on read without writing anything back to the project', async () => {
    const p = await makeProject();
    try {
      const scenes = join(p.dir, 'scenes');
      const before = await snapshot(scenes);
      const { model } = await p.reload();
      const lines = [...model.scenes.values()].flatMap((s) => s.lines);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((l) => /:L\d+$/.test(l.id))).toBe(true);
      expect(await snapshot(scenes)).toEqual(before);
    } finally {
      await p.cleanup();
    }
  });
});

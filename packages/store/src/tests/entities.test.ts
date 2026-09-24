import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrontMatter } from '@vn/parse';
import type { Diagnostic } from '@vn/types';
import { writeFileAtomic } from '@vn/util';
import {
  discoverCandidates,
  discoverEntities,
  entityIdentity,
  listMarkdownTree,
  loadInputs,
  ProjectPaths,
  workspacePath,
} from '../index.js';

async function tempRoot(): Promise<ProjectPaths> {
  return new ProjectPaths(await mkdtemp(join(tmpdir(), 'vn-entities-')));
}

/** A character sheet, tagged only when asked — a conventional file gets its tag from its dir. */
function sheet(id: string, opts: { tag?: string; name?: string } = {}): string {
  const tag = opts.tag ? `type: ${opts.tag}\n` : '';
  return `---\nid: ${id}\n${tag}name: ${opts.name ?? id}\n---\n\n${id}.\n`;
}

const codes = (diagnostics: Diagnostic[]): string[] => diagnostics.map((d) => d.code);

describe('entity discovery by tag', () => {
  it('finds a tagged character in the wiki and reports the file it lives in', async () => {
    const paths = await tempRoot();
    await writeFileAtomic(
      join(paths.wikiDir, 'cast', 'ada.md'),
      sheet('ada', { tag: 'character' }),
    );

    const inputs = await loadInputs(paths);
    expect(inputs.characterDocs).toHaveLength(1);
    expect(inputs.characterDocs[0]!.id).toBe('ada');
    expect(inputs.characterDocs[0]!.file).toBe(join(paths.wikiDir, 'cast', 'ada.md'));
    expect(inputs.diagnostics).toEqual([]);
  });

  it('finds a tagged location in the wiki, and sorts the wiki with the rest by id', async () => {
    const paths = await tempRoot();
    await writeFileAtomic(
      join(paths.wikiDir, 'sets', 'pier.md'),
      sheet('pier', { tag: 'location' }),
    );
    await writeFileAtomic(paths.locationFile('atrium'), sheet('atrium'));

    const inputs = await loadInputs(paths);
    expect(inputs.locationDocs.map((d) => d.id)).toEqual(['atrium', 'pier']);
    expect(inputs.characterDocs).toEqual([]);
  });

  // The bible is mostly prose. Only a tag makes a file an input; every other file belongs to the
  // story bible and must not become a half-parsed entity.
  it('ignores untagged wiki files and wiki files tagged something else', async () => {
    const paths = await tempRoot();
    await writeFileAtomic(
      join(paths.wikiDir, 'timeline.md'),
      '---\ntitle: Timeline\n---\n\nProse.\n',
    );
    await writeFileAtomic(join(paths.wikiDir, 'notes.md'), 'No front-matter at all.\n');
    await writeFileAtomic(join(paths.wikiDir, 'faction.md'), sheet('faction', { tag: 'faction' }));

    const inputs = await loadInputs(paths);
    expect(inputs.characterDocs).toEqual([]);
    expect(inputs.locationDocs).toEqual([]);
    expect(inputs.diagnostics).toEqual([]);
  });

  it('walks the wiki to any depth, in a deterministic order', async () => {
    const paths = await tempRoot();
    for (const [path, id] of [
      ['b.md', 'b'],
      ['deep/nested/a.md', 'a'],
      ['deep/c.md', 'c'],
    ] as const) {
      await writeFileAtomic(join(paths.wikiDir, path), sheet(id, { tag: 'character' }));
    }

    const inputs = await loadInputs(paths);
    expect(inputs.characterDocs.map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the conventional sheet when the wiki claims the same id, and names both', async () => {
    const paths = await tempRoot();
    await writeFileAtomic(paths.characterFile('ada'), sheet('ada', { name: 'Conventional' }));
    await writeFileAtomic(join(paths.wikiDir, 'ada.md'), sheet('ada', { tag: 'character' }));

    const inputs = await loadInputs(paths);
    expect(inputs.characterDocs).toHaveLength(1);
    expect(inputs.characterDocs[0]!.file).toBe(paths.characterFile('ada'));
    expect(codes(inputs.diagnostics)).toEqual(['duplicate_entity']);
    const [dup] = inputs.diagnostics;
    expect(dup!.severity).toBe('warning');
    expect(dup!.message).toContain(paths.characterFile('ada'));
    expect(dup!.message).toContain(join(paths.wikiDir, 'ada.md'));
  });

  it('breaks a wiki-only tie on the path, not on directory-read order', async () => {
    const paths = await tempRoot();
    await writeFileAtomic(join(paths.wikiDir, 'b', 'ada.md'), sheet('ada', { tag: 'character' }));
    await writeFileAtomic(join(paths.wikiDir, 'a', 'ada.md'), sheet('ada', { tag: 'character' }));

    const inputs = await loadInputs(paths);
    expect(inputs.characterDocs).toHaveLength(1);
    expect(inputs.characterDocs[0]!.file).toBe(join(paths.wikiDir, 'a', 'ada.md'));
    expect(codes(inputs.diagnostics)).toEqual(['duplicate_entity']);
  });

  // Moving the file is how a document changes kind. Honouring the tag here would leave a
  // character sitting in `locations/`, with every location path still naming it.
  it('refuses a conventional sheet that declares the other kind', async () => {
    const paths = await tempRoot();
    await writeFileAtomic(paths.locationFile('pier'), sheet('pier', { tag: 'character' }));

    const inputs = await loadInputs(paths);
    expect(inputs.locationDocs).toEqual([]);
    expect(inputs.characterDocs).toEqual([]);
    expect(codes(inputs.diagnostics)).toEqual(['entity_tag_conflict']);
    expect(inputs.diagnostics[0]!.severity).toBe('error');
  });

  it('accepts a conventional sheet that states its own kind', async () => {
    const paths = await tempRoot();
    await writeFileAtomic(paths.characterFile('ada'), sheet('ada', { tag: 'character' }));

    const inputs = await loadInputs(paths);
    expect(inputs.characterDocs.map((d) => d.id)).toEqual(['ada']);
    expect(inputs.diagnostics).toEqual([]);
  });

  // One hand-edited sheet must not fail the whole project's load.
  it('diagnoses unparseable front-matter instead of throwing', async () => {
    const paths = await tempRoot();
    await writeFileAtomic(paths.characterFile('ada'), '---\nid: [unclosed\n---\n\nAda.\n');
    await writeFileAtomic(paths.characterFile('bea'), sheet('bea'));

    const inputs = await loadInputs(paths);
    expect(inputs.characterDocs.map((d) => d.id)).toEqual(['bea']);
    expect(codes(inputs.diagnostics)).toEqual(['entity_file']);
    expect(inputs.diagnostics[0]!.severity).toBe('error');
    expect(inputs.diagnostics[0]!.message).toContain(paths.characterFile('ada'));
  });

  // In the wiki the same breakage is a warning: without readable front-matter there is no tag,
  // so the file was never known to be an entity in the first place.
  it('downgrades unparseable wiki front-matter to a warning', async () => {
    const paths = await tempRoot();
    await writeFileAtomic(join(paths.wikiDir, 'broken.md'), '---\nid: [unclosed\n---\n\nX.\n');

    const inputs = await loadInputs(paths);
    expect(inputs.characterDocs).toEqual([]);
    expect(codes(inputs.diagnostics)).toEqual(['entity_file']);
    expect(inputs.diagnostics[0]!.severity).toBe('warning');
  });

  it('reads nothing from a project with no entity directories at all', async () => {
    const inputs = await loadInputs(await tempRoot());
    expect(inputs.characterDocs).toEqual([]);
    expect(inputs.locationDocs).toEqual([]);
    expect(inputs.diagnostics).toEqual([]);
  });
});

/**
 * One of each case the identity rule has to mirror: a nested file under `locations/` that is not a
 * sheet, a conventional sheet whose tag names the other kind, and two files claiming one id.
 */
async function agreementFixture(): Promise<ProjectPaths> {
  const paths = await tempRoot();
  await writeFileAtomic(paths.characterFile('ada'), sheet('ada'));
  await writeFileAtomic(paths.characterFile('bea'), sheet('bea', { tag: 'location' }));
  await writeFileAtomic(join(paths.charactersDir, 'ada', 'notes.md'), 'Notes.\n');
  await writeFileAtomic(paths.locationFile('pier'), sheet('pier'));
  await writeFileAtomic(join(paths.locationsDir, 'sub', 'hall.md'), sheet('hall'));
  await writeFileAtomic(join(paths.wikiDir, 'cast', 'ada.md'), sheet('ada', { tag: 'character' }));
  await writeFileAtomic(join(paths.wikiDir, 'sets', 'dock.md'), sheet('dock', { tag: 'location' }));
  await writeFileAtomic(join(paths.wikiDir, 'lore.md'), '# Lore\n');
  return paths;
}

describe('entityIdentity', () => {
  it('agrees with discovery on every markdown file, the losing duplicate included', async () => {
    const paths = await agreementFixture();
    const candidates = await discoverCandidates(paths, []);
    const found = new Map(
      candidates.map((c) => [
        workspacePath(paths.root, c.doc.file),
        { kind: c.kind, id: c.doc.id },
      ]),
    );
    const files = await listMarkdownTree(paths.root);
    expect(files).toHaveLength(8);
    for (const file of files) {
      const rel = workspacePath(paths.root, file);
      const data = parseFrontMatter(await readFile(file, 'utf8')).data;
      expect([rel, entityIdentity(rel, data)]).toEqual([rel, found.get(rel)]);
    }
    expect(found.get('wiki/cast/ada.md')).toEqual({ kind: 'character', id: 'ada' });
  });

  it('leaves discoverEntities answering as it did, one sheet per id', async () => {
    const paths = await agreementFixture();
    const diagnostics: Diagnostic[] = [];
    const { characterDocs, locationDocs } = await discoverEntities(paths, diagnostics);
    expect(characterDocs.map((d) => d.file)).toEqual([paths.characterFile('ada')]);
    expect(locationDocs.map((d) => d.id)).toEqual(['dock', 'pier']);
    expect(codes(diagnostics).sort()).toEqual(['duplicate_entity', 'entity_tag_conflict']);
  });

  it('names nothing outside the three surfaces', () => {
    expect(entityIdentity('archive/ada.md', { type: 'character' })).toBeUndefined();
    expect(entityIdentity('wiki/notes.txt', { type: 'character' })).toBeUndefined();
    expect(entityIdentity('locations/pier.md', {})).toEqual({ kind: 'location', id: 'pier' });
  });
});

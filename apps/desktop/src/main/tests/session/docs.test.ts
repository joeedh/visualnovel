import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import { discoverSkills, newSkillTemplate, skillRoots } from '@vn/authoring';
import { WorkspaceSession } from '../../session.js';
import { sessionFor } from './helpers.js';

describe('WorkspaceSession — the story bible', () => {
  let p: TestProject;
  let session: WorkspaceSession;

  beforeAll(async () => {
    p = await makeProject({
      title : 'Bible',
      script: SCRIPTS.linear,
      files: {
        'wiki/history/canal.md': '# The canal\n\nThe school was raised over a filled canal.\n',
        'wiki/cast/notes.md'   : '# Notes\n\nAiko has never seen the canal drained.\n',
      },
    });
    session = sessionFor(p);
  });

  afterAll(async () => {
    await p.cleanup();
  });

  it('ranks passages by query, reporting the file each came from', async () => {
    const hits = await session.searchBible('canal');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.file)).toContain('history/canal.md');
    expect(hits[0]!.text).toContain('canal');
  });

  it('honours a limit and returns nothing for a query that matches nothing', async () => {
    expect(await session.searchBible('canal', 1)).toHaveLength(1);
    expect(await session.searchBible('submarine')).toEqual([]);
  });

  it('sees a file written after the session was built', async () => {
    await fs.writeFile(join(p.dir, 'wiki', 'later.md'), '# Later\n\nA submarine, improbably.\n');
    expect((await session.searchBible('submarine')).map((h) => h.file)).toEqual(['later.md']);
  });
});

/**
 * Tests the whole-document read and write behind `doc.*`. These refusals matter most: a save
 * that overwrites someone else's edit, a save that quietly deletes an entity, and prose written
 * by the one path that does not validate it.
 */
describe('WorkspaceSession — documents', () => {
  let p: TestProject;
  let session: WorkspaceSession;

  beforeEach(async () => {
    p = await makeProject({
      title : 'Docs',
      script: SCRIPTS.linear,
      files : { 'wiki/history.md': '# History\n\nThe canal was filled in 1911.\n' },
    });
    session = sessionFor(p);
  });

  afterEach(async () => {
    await p.cleanup();
  });

  /** The read, the edit, the save, and the hash the next save will carry. */
  async function roundTrip(path: string, text: string) {
    const read = await session.readDoc(path);
    if (!read.ok) throw new Error(read.reason);
    return session.saveDoc(path, text, read.file.hash);
  }

  it('reads a note and saves it back, reporting the new hash', async () => {
    const saved = await roundTrip('wiki/history.md', '# History\n\nRewritten.\n');
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.path).toBe('wiki/history.md');
    expect(await fs.readFile(join(p.dir, 'wiki', 'history.md'), 'utf8')).toBe(
      '# History\n\nRewritten.\n',
    );
    const reread = await session.readDoc('wiki/history.md');
    expect(reread.ok && reread.file.hash).toBe(saved.hash);
  });

  it('refuses a save over a file that changed underneath, naming both hashes', async () => {
    const read = await session.readDoc('wiki/history.md');
    if (!read.ok) throw new Error(read.reason);
    await fs.writeFile(join(p.dir, 'wiki', 'history.md'), '# History\n\nSomebody else.\n');
    const saved = await session.saveDoc('wiki/history.md', 'mine\n', read.file.hash);
    expect(saved.ok).toBe(false);
    expect(saved.ok ? '' : saved.reason).toMatch(/changed underneath this edit/);
  });

  it('refuses scenes/, outside the workspace, and unparseable front-matter', async () => {
    const scene = await session.saveDoc('scenes/arrival.md', 'INT. ANYWHERE - DAY\n', '');
    expect(scene.ok ? '' : scene.reason).toBe('scenes/arrival.md is written by story.*, not whole');
    const outside = await session.saveDoc('../escape.md', 'x', '');
    expect(outside.ok ? '' : outside.reason).toMatch(/outside the workspace/);
    const broken = await roundTrip('wiki/history.md', '---\nid: [unclosed\n---\n\nbody\n');
    expect(broken.ok ? '' : broken.reason).toMatch(/front-matter will not parse/);
  });

  it('saves a half-typed character sheet, with the schema failure beside it', async () => {
    const sheet = 'characters/aiko/character.md';
    const saved = await roundTrip(sheet, '---\nid: aiko\nname:\n---\n\nStill thinking.\n');
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.diagnostic).toBeTruthy();
    expect(await fs.readFile(join(p.dir, ...sheet.split('/')), 'utf8')).toContain('Still thinking');
  });

  it('saves a sheet whose tag contradicts its directory, with the conflict beside it', async () => {
    const sheet = 'characters/aiko/character.md';
    const saved = await roundTrip(sheet, '---\nid: aiko\nname: Aiko\ntype: location\n---\n');
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.diagnostic).toBe(
      `${sheet} is a character by its location but declares type: location; move the file or fix the tag`,
    );
  });

  it('refuses a save that drops a type: tag, because that deletes the entity', async () => {
    const path = 'wiki/cast/ada.md';
    await fs.mkdir(join(p.dir, 'wiki', 'cast'), { recursive: true });
    await fs.writeFile(
      join(p.dir, ...path.split('/')),
      '---\nid: ada\ntype: character\n---\n\nx\n',
    );
    const dropped = await roundTrip(path, '---\nid: ada\n---\n\nx\n');
    expect(dropped.ok ? '' : dropped.reason).toMatch(/drops it — that deletes the character/);
  });

  it('scaffolds each kind in its conventional home, deriving the id from the name', async () => {
    const character = await session.createDoc('character', 'Ada Lovelace');
    expect(character.ok && character).toMatchObject({
      id  : 'ada_lovelace',
      path: 'characters/ada_lovelace/character.md',
    });
    expect((await session.createDoc('location', 'The Roof')).ok && true).toBe(true);
    expect((await session.createDoc('note', 'Canal History')).ok).toBe(true);
    expect(await fs.readFile(join(p.dir, 'wiki', 'canal_history.md'), 'utf8')).toBe(
      '# Canal History\n',
    );
    // The new sheet is a real character, not a file nothing reads.
    expect((await session.index()).characters.map((c) => c.id)).toContain('ada_lovelace');
  });

  it('scaffolds a skill as a SKILL.md in a directory of its own', async () => {
    const made = await session.createDoc('skill', 'Continuity Pass');
    expect(made.ok && made).toMatchObject({
      id  : 'continuity-pass',
      path: '.aiagent/skills/continuity-pass/SKILL.md',
    });
    // The same bytes `create_skill` writes, so a reader cannot tell which path made the file
    const text = await fs.readFile(
      join(p.dir, '.aiagent', 'skills', 'continuity-pass', 'SKILL.md'),
      'utf8',
    );
    expect(text).toBe(newSkillTemplate('Continuity Pass'));
    // The scaffolded skill is one the agent can find, not a file nothing reads
    expect((await discoverSkills(await skillRoots(p.dir))).map((skill) => skill.id)).toContain(
      'continuity-pass',
    );
  });

  it('refuses a skill over a SKILL.md already there', async () => {
    expect((await session.previewCreate('skill', 'Twice Over')).ok).toBe(true);
    expect((await session.createDoc('skill', 'Twice Over')).ok).toBe(true);
    const again = await session.previewCreate('skill', 'Twice Over');
    expect(again.ok ? '' : again.reason).toBe('.aiagent/skills/twice-over/SKILL.md already exists');
  });

  // `writeSkill` refuses an existing directory; this path goes through `checkDocWrite` and refuses
  // an existing file. A directory a human put a vetted `run.mjs` in therefore takes the author's
  // scaffold and rejects the agent's.
  it('scaffolds into a directory that holds only a script a human put there', async () => {
    const dir = join(p.dir, '.aiagent', 'skills', 'lint-fountain');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'run.mjs'), 'process.stdout.write("ok");\n');

    expect((await session.previewCreate('skill', 'Lint Fountain')).ok).toBe(true);
    const made = await session.createDoc('skill', 'Lint Fountain');
    expect(made.ok && made.path).toBe('.aiagent/skills/lint-fountain/SKILL.md');
    // The script is still there — the scaffold wrote one file and touched nothing else.
    expect(await fs.readFile(join(dir, 'run.mjs'), 'utf8')).toContain('ok');
  });

  it('refuses to scaffold over a document already there', async () => {
    expect((await session.createDoc('character', 'Aiko')).ok).toBe(false);
    const again = await session.createDoc('character', 'Aiko');
    expect(again.ok ? '' : again.reason).toBe('characters/aiko/character.md already exists');
  });

  it('says what a save would do without doing it', async () => {
    const read = await session.readDoc('wiki/history.md');
    if (!read.ok) throw new Error(read.reason);
    const preview = await session.previewDoc('wiki/history.md', 'shorter\n', read.file.hash);
    expect(preview.ok && preview.note).toMatch(/^Overwrites wiki\/history\.md \(8 bytes\)\.$/);
    expect((await session.readDoc('wiki/history.md')).ok && true).toBe(true);
    expect(await fs.readFile(join(p.dir, 'wiki', 'history.md'), 'utf8')).toContain('1911');
  });
});

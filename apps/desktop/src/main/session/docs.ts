import { join } from 'node:path';
import { userSkillsDir } from '@vn/config';
import { docToMarkdown, newCharacterTemplate, newLocationDoc, slug } from '@vn/model';
import {
  ProjectPaths,
  checkDocWrite,
  readDocFile,
  writeDocFile,
  type DocFile,
  type DocResult,
  type DocWritePlan,
} from '@vn/store';
import { bindSlots, registerGenRuntimes, type Graph as GenGraph } from '@vn/gengraph';
import { exists } from '@vn/util';
import { fileCache } from '../workspace/filecache.js';
import { buildSlotGraph } from '@vn/artgen';
import {
  PROJECT_SKILLS_DIR,
  cloneSkill,
  discoverSkills,
  newSkillTemplate,
  skillId,
  skillRoots,
  type Skill,
  type SkillRoot,
} from '@vn/authoring';
import type { DocNode, DocSaveResult, DocTree } from '../../shared/ipc.js';
import {
  SKILL_TIER_DIRS,
  SKILL_TIER_LABELS,
  skillTierPath,
  type SkillTier,
} from '../../shared/editors.js';
import { builtinSkillsDir } from '../distribution/resources.js';
import { graphPath, graphSlugs, readGraph } from '../doctree/graphs.js';
import { labelAssets, labelContext } from '../assets/assetlabel.js';
import {
  DEFAULT_CAP,
  buildDocTree,
  fileTree,
  type GraphEntry,
  type SkillEntry,
} from '../doctree/doctree.js';
import { renameInText } from '../doctree/rename.js';
import type { WorkspaceSession, NewDocKind } from './core.js';
import {
  relPath,
  readAllShots,
  DOC_WRITERS,
  entityDiagnostic,
  walkFiles,
  loadProject,
} from './core.js';

export class DocsPart {
  constructor(private readonly session: WorkspaceSession) {}

  async docTree(): Promise<DocTree> {
    const project = await loadProject(this.session.dir);
    const bible = await this.session.workspace().bible();
    await bible.refresh();

    const shots = await readAllShots(project, { reportBroken: true });
    const manifest = project.store.manifest();
    const labels = labelContext(project.model, project.graph);
    const { graphs, bound } = await this.graphIndex();
    return buildDocTree({
      root  : this.session.dir,
      model : project.model,
      inputs: project.inputs,
      manifest,
      shots,
      bible      : bible.files(),
      wikiDir    : relPath(this.session.dir, project.paths.wikiDir),
      assetLabels: labelAssets(manifest, labels),
      // Always an array, never undefined: the branch is drawn even with nothing in it, and only a
      // caller outside the app (a test, the CLI) leaves it out.
      skills     : await this.session.skillEntries(),
      // The same walk the Task Graph pane reads, over the same load: the tree's two unapproved
      // groups are projections of it, so nothing here enumerates slots a second time.
      slots: buildSlotGraph({
        ...labels,
        assets: manifest,
        shots,
        config: project.config,
        graph : project.graph,
      }),
      boundGraphs: bound,
      graphs,
    });
  }

  /**
   * The project's graphs and which slot each one draws, for the tree's own branch and for the
   * rows the Gen Graph pane claims. One pass over the files and nothing else, so a tree read
   * costs no journal replay and no services. A graph that will not load still gets a row, with
   * the reason on it: the branch is where an author goes to find out why.
   */
  private async graphIndex(): Promise<{ graphs: GraphEntry[]; bound: Map<string, string> }> {
    registerGenRuntimes();

    const graphs: GraphEntry[] = [];
    const loaded: { slug: string; graph: GenGraph }[] = [];
    for (const slug of await graphSlugs(this.session.dir)) {
      const read = await readGraph(this.session.dir, slug);
      graphs.push({
        slug,
        file: graphPath(this.session.dir, slug),
        ...(read.ok ? {} : { problem: read.reason }),
      });
      if (read.ok) loaded.push({ slug, graph: read.graph });
    }

    const { bound } = bindSlots(loaded);
    return { graphs, bound: new Map([...bound].map(([slot, { entry }]) => [slot, entry.slug])) };
  }

  /**
   * The project's skills, as the tree and the composer's `/` completion need them — one
   * `discoverSkills` per read. Only identity fields ship; the instruction body is dropped here
   * rather than sent to the renderer and ignored there.
   */
  async skillEntries(): Promise<SkillEntry[]> {
    const skills = await discoverSkills(await this.skillRoots());
    return skills.map((skill) => ({
      id         : skill.id,
      name       : skill.name,
      description: skill.description,
      file       : this.skillDocPath(skill, 'SKILL.md'),
      script     : skill.script !== undefined,
      tier       : skill.tier,
      enabled    : skill.enabled,
    }));
  }

  /**
   * The roots every skill read in this session scans: the project, the user's folder, and the
   * catalog the app ships. The catalog's location is the one fact `@vn/authoring` cannot know,
   * so it is looked up here, per read — a build that lost it reads as two tiers.
   */
  private skillRoots(): Promise<SkillRoot[]> {
    return skillRoots(this.session.dir, { builtinDir: builtinSkillsDir() });
  }

  /**
   * A file of a skill as a document path: workspace-relative for a project skill, and under its
   * tier's prefix for a user or builtin one, whose directory is not in the workspace at all.
   */
  private skillDocPath(skill: Skill, file: string): string {
    return skill.tier === 'project'
      ? relPath(this.session.dir, join(skill.dir, file))
      : `${SKILL_TIER_DIRS[skill.tier]}/${skill.id}/${file}`;
  }

  /**
   * The skill and the file inside it that a tier-prefixed document path names, or undefined for
   * a path in no tier or naming no skill. Resolved through discovery rather than by joining the
   * tier's directory, because the user tier can be read from two directories and a disabled
   * builtin skill is still readable.
   */
  private async skillFileAt(path: string): Promise<{ skill: Skill; abs: string } | undefined> {
    const at = skillTierPath(path);
    if (!at || at.tier === 'project') return undefined;
    const slash = at.rest.indexOf('/');
    if (slash < 0) return undefined;
    const id = at.rest.slice(0, slash);
    const skills = await discoverSkills(await this.skillRoots(), { keepDisabled: true });
    const skill = skills.find((s) => s.id === id && s.tier === at.tier);
    return skill ? { skill, abs: join(skill.dir, at.rest.slice(slash + 1)) } : undefined;
  }

  /** The tree's other mode: what is actually on disk, `.git` and `node_modules` excluded. */
  async fileTree(): Promise<DocNode[]> {
    return fileTree(await walkFiles(this.session.dir));
  }

  /**
   * Every skill file the project can reach, as the Skills pane's own tree: one heading per tier,
   * a directory row per skill under it, and the files inside — the content the document tree
   * deliberately leaves out. A builtin skill the project has turned off is drawn too, badged
   * `off`, so the author can read and clone a skill they have switched off.
   *
   * Its own walk rather than a filter over `fileTree()`: that one is capped at `TREE_MAX_FILES`
   * across the whole project, so on a large one `.aiagent` could be truncated away and this pane
   * would draw an empty directory with nothing to say about why. It would also ship the entire
   * project's file list to paint a dozen rows.
   *
   * Every heading is drawn, empty or not: an empty Project heading is what tells a new project
   * where its first skill goes, and an empty User heading is the one place the folder shared
   * across projects is named.
   */
  async skillTree(): Promise<DocNode[]> {
    const skills = await discoverSkills(await this.skillRoots(), { keepDisabled: true });
    const headings: DocNode[] = [];
    for (const tier of ['project', 'user', 'builtin'] as const) {
      const children: DocNode[] = [];
      for (const skill of skills.filter((s) => s.tier === tier)) {
        const dir = this.skillDocPath(skill, '').replace(/\/$/, '');
        const badge = skill.enabled ? (skill.script ? 'script' : '') : 'off';
        children.push({
          id   : `dir:${dir}`,
          kind : 'dir',
          label: skill.id,
          path : dir,
          ...(badge ? { badge } : {}),
          ...(skill.description ? { note: skill.description } : {}),
          children: fileTree(await walkFiles(skill.dir), DEFAULT_CAP, `${dir}/`),
        });
      }
      headings.push({
        id   : `skilltier:${tier}`,
        kind : 'branch',
        label: SKILL_TIER_LABELS[tier],
        note : this.skillTierNote(tier),
        children,
      });
    }
    return headings;
  }

  /** What a tier's heading says on hover: what the tier is, and where its files live. */
  private skillTierNote(tier: SkillTier): string {
    switch (tier) {
      case 'project':
        return `This project's own skills, in ${PROJECT_SKILLS_DIR.replace(/\\/g, '/')}. Edited here, and committed with the project.`;
      case 'user':
        return `Your own skills, shared by every project on this machine: ${userSkillsDir()}. Cloned or edited there, not here.`;
      case 'builtin':
        return 'The skills that ship with the app. Read-only: clone one to edit a copy. Which are on for this project is set in the Project pane.';
    }
  }

  /**
   * One authored document as text, with the hash it was read at. Deliberately not through
   * `@vn/bible`: that interface has no whole-file API and that absence is what keeps the bible
   * out of an agent's context window — a human reading their own note on screen is a different
   * act, and it reads the workspace directly.
   *
   * A user or builtin skill file is read from its own directory and handed back under the
   * tier-prefixed path it was asked for, so the pane that opened it can open it again.
   */
  async readDoc(path: string): Promise<DocResult<{ file: DocFile }>> {
    const outside = await this.skillFileAt(path);
    if (!outside) return readDocFile(this.session.dir, path);
    const read = await readDocFile(outside.skill.dir, outside.abs);
    return read.ok ? { ok: true, file: { ...read.file, path } } : read;
  }

  /** What a save would do, decided without writing — what `doc.write`'s precondition reports. */
  async previewDoc(path: string, text: string, seenHash: string): Promise<DocResult<DocWritePlan>> {
    const refusal = this.skillWriteRefusal(path);
    if (refusal) return { ok: false, reason: refusal };
    return checkDocWrite(this.session.dir, path, text, seenHash, DOC_WRITERS);
  }

  /**
   * Why a whole-file save must refuse a user or builtin skill path, or null for a project path.
   * The words are the same ones `edit_skill` gives the agent, so a person and the agent are told
   * the same thing about the same file.
   */
  private skillWriteRefusal(path: string): string | null {
    const at = skillTierPath(path);
    if (!at || at.tier === 'project') return null;
    return at.tier === 'builtin'
      ? 'This is a builtin skill and is read-only; clone it into the project to edit a copy.'
      : `This is a user skill, shared across projects, and is edited in its own folder (${userSkillsDir()}); clone it into the project to edit a copy here.`;
  }

  /**
   * Copy a user or builtin skill into this project's `.aiagent/skills`, or a project or builtin
   * one into the user's folder, as a fresh skill of the same id. Refuses an id the target
   * already holds rather than overwriting it, and a target the skill already lives in.
   */
  async cloneSkill(
    id: string,
    into: 'project' | 'user',
  ): Promise<DocResult<{ path: string; written: string[] }>> {
    const skills = await discoverSkills(await this.skillRoots(), { keepDisabled: true });
    const skill = skills.find((s) => s.id === id);
    if (!skill) return { ok: false, reason: `no such skill: ${id}` };
    if (skill.tier === into) {
      return { ok: false, reason: `${id} is already a ${into} skill; there is nothing to clone.` };
    }
    const target =
      into === 'project' ? join(this.session.dir, PROJECT_SKILLS_DIR) : userSkillsDir();
    const res = await cloneSkill(skill, target);
    if (!res.ok) {
      return {
        ok    : false,
        reason: `${res.reason} in the ${into} skills; rename or remove that one first.`,
      };
    }
    const path =
      into === 'project'
        ? relPath(this.session.dir, res.file)
        : `${SKILL_TIER_DIRS.user}/${id}/SKILL.md`;
    // Only a project write is a workspace write: the user folder is in no repository, so nothing
    // there is staged or snapshotted.
    return { ok: true, path, written: into === 'project' ? [path] : [] };
  }

  /** What {@link cloneSkill} would do, without doing it. */
  async previewCloneSkill(
    id: string,
    into: 'project' | 'user',
  ): Promise<{ ok: true; note: string } | { ok: false; reason: string }> {
    const skills = await discoverSkills(await this.skillRoots(), { keepDisabled: true });
    const skill = skills.find((s) => s.id === id);
    if (!skill) return { ok: false, reason: `no such skill: ${id}` };
    if (skill.tier === into) {
      return { ok: false, reason: `${id} is already a ${into} skill; there is nothing to clone.` };
    }
    const target =
      into === 'project' ? join(this.session.dir, PROJECT_SKILLS_DIR) : userSkillsDir();
    if (await exists(join(target, id))) {
      return {
        ok    : false,
        reason: `The ${into} skills already hold ${id}; rename or remove that one first.`,
      };
    }
    const shown = into === 'project' ? PROJECT_SKILLS_DIR.replace(/\\/g, '/') : userSkillsDir();
    const script = skill.script ? ', and its script, which runs only after you confirm it' : '';
    return {
      ok  : true,
      note: `Copies ${skill.tier} skill ${id} into ${shown}/${id}${script}. The ${skill.tier} one is unchanged.`,
    };
  }

  /**
   * Save one document whole, and say what the model will make of it. The refusals are
   * `checkDocWrite`'s; the schema check is here because it needs `@vn/model`, which `@vn/store`
   * may not import — and because a failure there is a diagnostic beside a saved file rather than
   * a refusal, exactly the split `loadInputs` already draws.
   */
  async saveDoc(path: string, text: string, seenHash: string): Promise<DocResult<DocSaveResult>> {
    const refusal = this.skillWriteRefusal(path);
    if (refusal) return { ok: false, reason: refusal };
    const plan = await writeDocFile(this.session.dir, path, text, seenHash, DOC_WRITERS);
    if (!plan.ok) return plan;
    // `writeDocFile` is `@vn/store`'s, so the bytes are handed to the cache afterwards rather
    // than written through it: the undo snapshot that follows this save then needs no re-read.
    await fileCache.note(plan.file, text);
    const diagnostic = entityDiagnostic(plan.path, plan.doc);
    return {
      ok   : true,
      path : plan.path,
      hash : plan.hash,
      bytes: plan.bytes,
      ...(diagnostic ? { diagnostic } : {}),
    };
  }

  /**
   * Where a scaffolded document would land and what it would say. The templates are the same
   * `newCharacterTemplate` / `newLocationDoc` / `newSkillTemplate` the agent's `create_character`
   * and `create_skill` call, so one authorial act has one answer and the id is derived in exactly
   * one place — a reader cannot tell whether a human or the agent made a file by looking at it.
   * The path is conventional; a sheet filed elsewhere gets there by being moved afterwards, not
   * by a different scaffolder.
   */
  private newDoc(
    kind: NewDocKind,
    name: string,
  ): { id: string; path: string; text: string } | null {
    const paths = new ProjectPaths(this.session.dir);
    // A note is a heading and nothing else: `wiki/` is free-form, and an empty front-matter
    // block at the top of every new note would be a shape the author has to delete.
    if (kind === 'note') {
      const id = slug(name);
      return id
        ? {
            id,
            path: relPath(this.session.dir, join(paths.wikiDir, `${id}.md`)),
            text: `# ${name}\n`,
          }
        : null;
    }
    // A skill is a directory with a `SKILL.md` in it, and `writeFileAtomic` makes the directory.
    // The refusal differs from `writeSkill`'s deliberately: that one refuses an existing
    // directory, while this goes through `checkDocWrite` with an empty `seenHash` and refuses an
    // existing file. So a directory a human has already put a vetted `run.mjs` in accepts the
    // author's scaffold and rejects the agent's, and the human is the one who put the script there.
    if (kind === 'skill') {
      const id = skillId(name);
      if (!id) return null;
      return {
        id,
        path: relPath(this.session.dir, join(this.session.dir, PROJECT_SKILLS_DIR, id, 'SKILL.md')),
        text: newSkillTemplate(name),
      };
    }
    // A character gets the full template, which is text because its palette note is a YAML
    // comment; a location is still front-matter alone, so it goes through the doc scaffolder.
    if (kind === 'character') {
      const id = slug(name);
      if (!id) return null;
      const path = relPath(this.session.dir, paths.characterFile(id));
      return { id, path, text: newCharacterTemplate(name) };
    }
    const doc = newLocationDoc(name);
    const id = String(doc.data['id'] ?? '');
    if (!id) return null;
    return {
      id,
      path: relPath(this.session.dir, paths.locationFile(id)),
      text: docToMarkdown(doc),
    };
  }

  /** Whether the scaffold would land — mostly a check that the name is not already taken. */
  async previewCreate(kind: NewDocKind, name: string): Promise<DocResult<DocWritePlan>> {
    const scaffold = this.newDoc(kind, name);
    if (!scaffold) return { ok: false, reason: `"${name}" does not name a ${kind}` };
    return checkDocWrite(this.session.dir, scaffold.path, scaffold.text, '', DOC_WRITERS);
  }

  /**
   * Scaffold a character, a location, a wiki note or a skill from a name. The empty `seenHash` is
   * what makes this a creation: the write refuses over a file already there rather than
   * overwriting whatever the author had under that name.
   */
  async createDoc(
    kind: NewDocKind,
    name: string,
  ): Promise<DocResult<DocSaveResult & { id: string }>> {
    const scaffold = this.newDoc(kind, name);
    if (!scaffold) return { ok: false, reason: `"${name}" does not name a ${kind}` };
    const written = await writeDocFile(
      this.session.dir,
      scaffold.path,
      scaffold.text,
      '',
      DOC_WRITERS,
    );
    if (!written.ok) return written;
    await fileCache.note(written.file, scaffold.text);
    return {
      ok   : true,
      id   : scaffold.id,
      path : written.path,
      hash : written.hash,
      bytes: written.bytes,
    };
  }

  /**
   * Read a document and work out what renaming it to `name` would write. `renameInText` decides
   * where in the text the name lives; this is the half that touches the disk. Both the check and
   * the run go through it, so they ask the same question of the same bytes.
   */
  private async planRename(
    path: string,
    name: string,
  ): Promise<DocResult<{ text: string; what: string; seenHash: string }>> {
    const read = await this.session.readDoc(path);
    if (!read.ok) return read;
    const renamed = renameInText(path, read.file.text, name);
    if (!renamed.ok) return { ok: false, reason: renamed.reason };
    return { ok: true, text: renamed.text, what: renamed.what, seenHash: read.file.hash };
  }

  /** What `doc.rename` would do, decided without writing. */
  async previewRename(path: string, name: string): Promise<DocResult<{ note: string }>> {
    const plan = await this.planRename(path, name);
    if (!plan.ok) return plan;
    const write = await this.session.previewDoc(path, plan.text, plan.seenHash);
    if (!write.ok) return write;
    return { ok: true, note: `Rewrite ${plan.what} in ${path} as "${name.trim()}".` };
  }

  /**
   * Rename one document in place. The file never moves: an id is derived from a name once, at
   * creation, and afterwards it is what shots, cast lists and `[[goto:]]` markers point at.
   */
  async renameDoc(
    path: string,
    name: string,
  ): Promise<DocResult<DocSaveResult & { what: string }>> {
    const plan = await this.planRename(path, name);
    if (!plan.ok) return plan;
    const saved = await this.session.saveDoc(path, plan.text, plan.seenHash);
    if (!saved.ok) return saved;
    return { ...saved, what: plan.what };
  }

  /** Scenes + branch edges for the STUDIO branch editor, derived from the validated model. */
}

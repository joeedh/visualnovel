import { join } from 'node:path';
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
  discoverSkills,
  newSkillTemplate,
  skillId,
  skillRoots,
} from '@vn/authoring';
import type { DocNode, DocSaveResult, DocTree } from '../../shared/ipc.js';
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
    const skills = await discoverSkills(skillRoots(this.session.dir));
    return skills.map((skill) => ({
      id         : skill.id,
      name       : skill.name,
      description: skill.description,
      file       : relPath(this.session.dir, skill.file),
      script     : skill.script !== undefined,
    }));
  }

  /** The tree's other mode: what is actually on disk, `.git` and `node_modules` excluded. */
  async fileTree(): Promise<DocNode[]> {
    return fileTree(await walkFiles(this.session.dir));
  }

  /**
   * Every file under `.aiagent/skills`, as the Skills pane's own tree — the content the document
   * tree deliberately leaves out.
   *
   * Its own walk rather than a filter over `fileTree()`: that one is capped at `TREE_MAX_FILES`
   * across the whole project, so on a large one `.aiagent` could be truncated away and this pane
   * would draw an empty directory with nothing to say about why. It would also ship the entire
   * project's file list to paint a dozen rows.
   *
   * No skills directory at all is `[]`, not a failure: that is the state every new project starts
   * in, and it is the Skills branch being drawn empty that tells the author what to do about it.
   */
  async skillTree(): Promise<DocNode[]> {
    const root = join(this.session.dir, PROJECT_SKILLS_DIR);
    if (!(await exists(root))) return [];
    // The paths come back relative to the skills directory, so the prefix is what makes each id a
    // workspace-relative path `doc.read` would take.
    return fileTree(await walkFiles(root), DEFAULT_CAP, `${relPath(this.session.dir, root)}/`);
  }

  /**
   * One authored document as text, with the hash it was read at. Deliberately not through
   * `@vn/bible`: that interface has no whole-file API and that absence is what keeps the bible
   * out of an agent's context window — a human reading their own note on screen is a different
   * act, and it reads the workspace directly.
   */
  readDoc(path: string): Promise<DocResult<{ file: DocFile }>> {
    return readDocFile(this.session.dir, path);
  }

  /** What a save would do, decided without writing — what `doc.write`'s precondition reports. */
  previewDoc(path: string, text: string, seenHash: string): Promise<DocResult<DocWritePlan>> {
    return checkDocWrite(this.session.dir, path, text, seenHash, DOC_WRITERS);
  }

  /**
   * Save one document whole, and say what the model will make of it. The refusals are
   * `checkDocWrite`'s; the schema check is here because it needs `@vn/model`, which `@vn/store`
   * may not import — and because a failure there is a diagnostic beside a saved file rather than
   * a refusal, exactly the split `loadInputs` already draws.
   */
  async saveDoc(path: string, text: string, seenHash: string): Promise<DocResult<DocSaveResult>> {
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

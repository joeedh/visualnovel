import type { DocFile, DocResult, DocWritePlan } from '@vn/store';
import type { DocNode, DocSaveResult, DocTree } from '../../../shared/ipc.js';
import type { SkillEntry } from '../../doctree/doctree.js';
import type { DocsPart } from '../docs.js';
import type { FilesPart, TransferMode, TransferResult } from '../files.js';
import type { NewDocKind } from '../types/results.js';
import { ProjectSurface } from './project.js';
export abstract class DocsSurface extends ProjectSurface {
  abstract readonly docsPart: DocsPart;
  abstract readonly filesPart: FilesPart;

  /**
   * The sidebar's logical tree plus per-entity backlinks. One load, one manifest, one storyboard
   * read per scene — which is exactly why this is not folded into `workspace:index`, the shape
   * the agent refetches every turn.
   */
  async docTree(): Promise<DocTree> {
    return this.docsPart.docTree();
  }

  /**
   * The project's skills, as the tree and the composer's `/` completion need them — one
   * `discoverSkills` per read. Only identity fields ship; the instruction body is dropped here
   * rather than sent to the renderer and ignored there.
   */
  async skillEntries(): Promise<SkillEntry[]> {
    return this.docsPart.skillEntries();
  }

  async fileTree(): Promise<DocNode[]> {
    return this.docsPart.fileTree();
  }

  /**
   * Every skill file the project can reach, as the Skills pane's own tree: a heading per tier, a
   * row per skill, and the files inside — the content the document tree deliberately leaves out.
   * Its own walk rather than a filter over `fileTree()`, which is capped across the whole
   * project and could truncate `.aiagent` away.
   */
  async skillTree(): Promise<DocNode[]> {
    return this.docsPart.skillTree();
  }

  /** Copy a skill into this project's `.aiagent/skills` or into the user's folder. */
  cloneSkill(
    id: string,
    into: 'project' | 'user',
  ): Promise<DocResult<{ path: string; written: string[] }>> {
    return this.docsPart.cloneSkill(id, into);
  }

  previewCloneSkill(
    id: string,
    into: 'project' | 'user',
  ): Promise<{ ok: true; note: string } | { ok: false; reason: string }> {
    return this.docsPart.previewCloneSkill(id, into);
  }

  /**
   * One authored document as text, with the hash it was read at. Deliberately not through
   * `@vn/bible`: that interface has no whole-file API and that absence is what keeps the bible
   * out of an agent's context window — a human reading their own note on screen is a different
   * act, and it reads the workspace directly.
   */
  readDoc(path: string): Promise<DocResult<{ file: DocFile }>> {
    return this.docsPart.readDoc(path);
  }

  previewDoc(path: string, text: string, seenHash: string): Promise<DocResult<DocWritePlan>> {
    return this.docsPart.previewDoc(path, text, seenHash);
  }

  /**
   * Save one document whole, and say what the model will make of it. The refusals are
   * `checkDocWrite`'s; the schema check is here because it needs `@vn/model`, which `@vn/store`
   * may not import — and because a failure there is a diagnostic beside a saved file rather than
   * a refusal, exactly the split `loadInputs` already draws.
   */
  async saveDoc(path: string, text: string, seenHash: string): Promise<DocResult<DocSaveResult>> {
    return this.docsPart.saveDoc(path, text, seenHash);
  }

  async previewCreate(kind: NewDocKind, name: string, dir = ''): Promise<DocResult<DocWritePlan>> {
    return this.docsPart.previewCreate(kind, name, dir);
  }

  /**
   * Scaffold a character, a location, a wiki note or a skill from a name. The empty `seenHash` is
   * what makes this a creation: the write refuses over a file already there rather than
   * overwriting whatever the author had under that name.
   */
  async createDoc(
    kind: NewDocKind,
    name: string,
    dir = '',
  ): Promise<DocResult<DocSaveResult & { id: string }>> {
    return this.docsPart.createDoc(kind, name, dir);
  }

  previewMkdir(parent: string, name: string): Promise<DocResult<{ note: string }>> {
    return this.filesPart.previewMkdir(parent, name);
  }

  /** Create one empty folder under one of the four file roots. */
  mkdir(parent: string, name: string): Promise<DocResult<{ path: string }>> {
    return this.filesPart.mkdir(parent, name);
  }

  previewNewFile(parent: string, name: string): Promise<DocResult<{ note: string }>> {
    return this.filesPart.previewNewFile(parent, name);
  }

  /** Create one empty file under one of the four file roots. */
  newFile(parent: string, name: string): Promise<DocResult<DocSaveResult>> {
    return this.filesPart.newFile(parent, name);
  }

  previewTransfer(
    paths: readonly string[],
    into: string,
    mode: TransferMode,
    name = '',
  ): Promise<DocResult<{ note: string }>> {
    return this.filesPart.previewTransfer(paths, into, mode, name);
  }

  /** Move or copy files and folders under the four file roots, rewriting the links they break. */
  transfer(
    paths: readonly string[],
    into: string,
    mode: TransferMode,
    name = '',
  ): Promise<DocResult<TransferResult>> {
    return this.filesPart.transfer(paths, into, mode, name);
  }

  previewDelete(paths: readonly string[]): Promise<DocResult<{ note: string }>> {
    return this.filesPart.previewDelete(paths);
  }

  /** Delete files and folders under the four file roots, refusing an entity sheet by name. */
  deleteFiles(
    paths: readonly string[],
  ): Promise<DocResult<{ deleted: string[]; written: string[]; message: string }>> {
    return this.filesPart.deleteFiles(paths);
  }

  async previewRename(path: string, name: string): Promise<DocResult<{ note: string }>> {
    return this.docsPart.previewRename(path, name);
  }

  /**
   * Rename one document in place. The file never moves: an id is derived from a name once, at
   * creation, and afterwards it is what shots, cast lists and `[[goto:]]` markers point at.
   */
  async renameDoc(
    path: string,
    name: string,
  ): Promise<DocResult<DocSaveResult & { what: string }>> {
    return this.docsPart.renameDoc(path, name);
  }
}

import type { ResolvedKeys } from '@vn/config';
import type { ProjectFinding } from '@vn/artgen';
import type { FetchImpl } from '@vn/providers';
import type { Lettering, ShotForm } from '@vn/types';
import type { KeyScope, KeyStatusView, ProjectView } from '../../../shared/ipc.js';
import type { GuideUrlField, KeyGuide } from '../../../shared/apikeys.js';
import type { UpdateCheck } from '../../distribution/updates.js';
import type { ProjectPart } from '../project.js';
import type { CollectPart, CollectResult } from '../collect.js';
import type { PromptResult, PromptWriteResult } from '../types/results.js';
import { AssetsSurface } from './assets.js';
export abstract class ProjectSurface extends AssetsSurface {
  abstract readonly projectPart: ProjectPart;
  abstract readonly collectPart: CollectPart;

  async projectView(): Promise<ProjectView> {
    return this.projectPart.projectView();
  }

  /**
   * Lists every reference that would fail a run or a read, for `project.validate`. Writes nothing.
   */
  async validateProject(): Promise<ProjectFinding[]> {
    return this.projectPart.validate();
  }

  async previewCollect(opts: {
    oldAnswers: boolean;
    keepForUndo: boolean;
  }): Promise<{ ok: boolean; message: string }> {
    return this.collectPart.preview(opts);
  }

  async collectAssets(opts: { oldAnswers: boolean; keepForUndo: boolean }): Promise<CollectResult> {
    return this.collectPart.collect(opts);
  }

  async previewArtStyle(style: string): Promise<PromptResult> {
    return this.projectPart.previewArtStyle(style);
  }

  /**
   * Write the project's art style. It is spliced into `project.yaml` rather than re-serialized,
   * so an author's comments and key order survive — the same posture the prose writers take with
   * front-matter.
   */
  async setProjectArtStyle(style: string): Promise<PromptWriteResult> {
    return this.projectPart.setProjectArtStyle(style);
  }

  async previewImageModel(modelId: string): Promise<PromptResult> {
    return this.projectPart.previewImageModel(modelId);
  }

  /** Write the project's image model, spliced into `project.yaml`'s `models:` block. */
  async setProjectImageModel(modelId: string): Promise<PromptWriteResult> {
    return this.projectPart.setProjectImageModel(modelId);
  }

  async previewTextModel(modelId: string): Promise<PromptResult> {
    return this.projectPart.previewTextModel(modelId);
  }

  /** Write the project's text model, spliced into `project.yaml`'s `models:` block. */
  async setProjectTextModel(modelId: string): Promise<PromptWriteResult> {
    return this.projectPart.setProjectTextModel(modelId);
  }

  async previewVisionModels(modelIds: readonly string[]): Promise<PromptResult> {
    return this.projectPart.previewVisionModels(modelIds);
  }

  /** Write the project's vision reviewers, spliced into `project.yaml`'s `models:` block. */
  async setProjectVisionModels(modelIds: readonly string[]): Promise<PromptWriteResult> {
    return this.projectPart.setProjectVisionModels(modelIds);
  }

  /** Fetch OpenRouter's image-model listing into `<user>/models.json`. */
  async refreshModelCatalog(
    fetchImpl?: FetchImpl,
  ): Promise<{ ok: true; message: string; listed: number } | { ok: false; reason: string }> {
    return this.projectPart.refreshModelCatalog(fetchImpl);
  }

  async previewStoryboardNotes(notes: string): Promise<PromptResult> {
    return this.projectPart.previewStoryboardNotes(notes);
  }

  /** Write the decomposer's directives, spliced into `project.yaml` like the art style. */
  async setProjectStoryboardNotes(notes: string): Promise<PromptWriteResult> {
    return this.projectPart.setProjectStoryboardNotes(notes);
  }

  async previewLettering(lettering: Lettering): Promise<PromptResult> {
    return this.projectPart.previewLettering(lettering);
  }

  /** Write who letters a page shot, spliced into `project.yaml` like the art style. */
  async setProjectLettering(lettering: Lettering): Promise<PromptWriteResult> {
    return this.projectPart.setProjectLettering(lettering);
  }

  async previewBubbleNames(on: boolean): Promise<PromptResult> {
    return this.projectPart.previewBubbleNames(on);
  }

  /** What `project.setShotForm` would do, without writing it. */
  async previewShotForm(form: ShotForm): Promise<PromptResult> {
    return this.projectPart.previewShotForm(form);
  }

  /** Write what a shot is, spliced into `project.yaml`. */
  async setProjectShotForm(form: ShotForm): Promise<PromptWriteResult> {
    return this.projectPart.setProjectShotForm(form);
  }

  /** Write whether bubbles name their speaker, spliced into `project.yaml` like the art style. */
  async setProjectBubbleNames(on: boolean): Promise<PromptWriteResult> {
    return this.projectPart.setProjectBubbleNames(on);
  }

  async previewBuiltinSkills(ids: readonly string[]): Promise<PromptResult> {
    return this.projectPart.previewBuiltinSkills(ids);
  }

  /** Write which builtin skills the project enables, spliced into `project.yaml`. */
  async setProjectBuiltinSkills(ids: readonly string[]): Promise<PromptWriteResult> {
    return this.projectPart.setProjectBuiltinSkills(ids);
  }

  async previewKey(vendor: keyof ResolvedKeys, scope: KeyScope = 'project'): Promise<PromptResult> {
    return this.projectPart.previewKey(vendor, scope);
  }

  /**
   * Store an API key. The value reaches exactly one file — the first name `resolveKeys` looks
   * for — and nothing else: not the message, not the log, and not `commands.jsonl`, where
   * `prop.secret` has already replaced it.
   *
   * At the project scope, `keys` is ignored before the write happens, because commit-on-save runs
   * `git commit -A` and would otherwise commit the file within the second. At the user scope
   * there is no repository to ignore it in — the directory is deliberately outside every one —
   * so the guard is the file mode instead: `0600` on POSIX. A project's `keys/` never needed
   * that because the repository boundary already kept it out of history.
   */
  async setKey(
    vendor: keyof ResolvedKeys,
    key: string,
    scope: KeyScope = 'project',
  ): Promise<PromptWriteResult> {
    return this.projectPart.setKey(vendor, key, scope);
  }

  /**
   * For each vendor, whether a key resolved and which source answered — never the value. The
   * Setup pane is built on this, and so is the first-run check that decides whether to offer it.
   */
  async keyStatusView(): Promise<KeyStatusView> {
    return this.projectPart.keyStatusView();
  }

  /**
   * The key walkthrough, read from the one file that holds it and parsed into blocks.
   *
   * Parsed here rather than in the pane because main is the side with a filesystem: what crosses
   * the IPC boundary is already drawable, and the pane cannot end up with a second opinion about
   * what the page says.
   */
  async keyGuide(): Promise<KeyGuide> {
    return this.projectPart.keyGuide();
  }

  /**
   * Open one of a vendor's pages — its key console, its documentation, its pricing — in the
   * system browser.
   *
   * The URL is looked up here, from the shipped guide, rather than passed in. A renderer that
   * could name any URL for the OS to open is a renderer that can be talked into opening one, and
   * nothing about these buttons needs that: the pages they may reach are three fields of a file
   * the app ships.
   */
  async openKeyLink(vendor: keyof ResolvedKeys, link: GuideUrlField): Promise<PromptResult> {
    return this.projectPart.openKeyLink(vendor, link);
  }

  /**
   * Ask GitHub whether there is a newer VN Studio than this one.
   *
   * The decision is `updates.ts`'s and is pure; this is the request. Unauthenticated, so it is
   * rate-limited at 60 an hour per IP — fine for one desktop app, which is why nothing automated
   * may ever call this.
   *
   * It never throws. Every failure comes back as an `unreachable` verdict carrying its own
   * sentence, because a check the author did not ask for must be able to fail without filing an
   * `error` notification at someone mid-scene. `announcementFor` is what decides whether the
   * verdict is worth saying out loud.
   */
  async checkForUpdates(): Promise<UpdateCheck> {
    return this.projectPart.checkForUpdates();
  }

  /**
   * Open VN Studio's own releases page — the notes and the installers are one page there.
   *
   * The address is derived from `ISSUE_REPO` rather than passed in, for the reason
   * {@link openKeyLink} states: nothing in this app opens a URL it was handed, and a notification
   * — a line of a file git union-merges across clones — is exactly the input that rule is for.
   */
  async openReleases(): Promise<PromptResult> {
    return this.projectPart.openReleases();
  }

  async openCollaboratingGuide(): Promise<PromptResult> {
    return this.projectPart.openCollaboratingGuide();
  }

  /**
   * Whether {@link testKey} has anything to try, in its own sentence either way — so the Setup
   * pane's greyed-out button says why it is grey rather than looking broken.
   */
  async previewTestKey(vendor: keyof ResolvedKeys): Promise<PromptResult> {
    return this.projectPart.previewTestKey(vendor);
  }

  /**
   * Make one real, cheap call with a vendor's key and say whether it worked.
   *
   * The Setup pane exists to end the state of "I pasted something and I do not know". A key can
   * resolve and still be wrong — revoked, mistyped, or belonging to an account with no credit —
   * and every one of those failures otherwise surfaces much later, inside a run, as a stack of
   * pipeline errors that name a task rather than a key.
   *
   * The model is one the project already configures for that vendor, not a name written down
   * here: a model id this file invented could be one the account has no access to, and the
   * refusal would then be about our choice rather than about their key.
   */
  async testKey(vendor: keyof ResolvedKeys): Promise<PromptResult> {
    return this.projectPart.testKey(vendor);
  }
}

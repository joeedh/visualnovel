import type { ResolvedKeys } from '@vn/config';
import type { FetchImpl } from '@vn/providers';
import type { Lettering, ShotForm } from '@vn/types';
import type { KeyScope } from '../../shared/ipc.js';
import type { GuideUrlField } from '../../shared/apikeys.js';
import type { WorkspaceSession } from './core.js';
import type { LoadedProject } from './load/project.js';
import * as keys from './project/keys.js';
import * as models from './project/models.js';
import * as settings from './project/settings.js';
import * as skills from './project/skills.js';
import * as updates from './project/updates.js';
import * as view from './project/view.js';

/**
 * The project view, the `project.*` settings writes and their previews, API keys, and update
 * checks. Each method delegates to a module under `project/`, grouped by what the code touches:
 * the view and model catalog, `project.yaml` settings, model choices, builtin skills, keys, and
 * release links.
 */
export class ProjectPart {
  constructor(private readonly session: WorkspaceSession) {}

  validate() {
    return view.validate(this.session);
  }

  projectView() {
    return view.projectView(this.session);
  }

  previewBuiltinSkills(ids: readonly string[]) {
    return skills.previewBuiltinSkills(this.session, ids);
  }

  setProjectBuiltinSkills(ids: readonly string[]) {
    return skills.setProjectBuiltinSkills(this.session, ids);
  }

  refreshModelCatalog(fetchImpl?: FetchImpl) {
    return view.refreshModelCatalog(this.session, fetchImpl);
  }

  previewArtStyle(style: string) {
    return settings.previewArtStyle(this.session, style);
  }

  setProjectArtStyle(style: string) {
    return settings.setProjectArtStyle(this.session, style);
  }

  previewImageModel(modelId: string) {
    return models.previewImageModel(this.session, modelId);
  }

  setProjectImageModel(modelId: string) {
    return models.setProjectImageModel(this.session, modelId);
  }

  previewTextModel(modelId: string) {
    return models.previewTextModel(this.session, modelId);
  }

  setProjectTextModel(modelId: string) {
    return models.setProjectTextModel(this.session, modelId);
  }

  previewVisionModels(modelIds: readonly string[]) {
    return models.previewVisionModels(this.session, modelIds);
  }

  setProjectVisionModels(modelIds: readonly string[]) {
    return models.setProjectVisionModels(this.session, modelIds);
  }

  previewStoryboardNotes(notes: string) {
    return settings.previewStoryboardNotes(this.session, notes);
  }

  setProjectStoryboardNotes(notes: string) {
    return settings.setProjectStoryboardNotes(this.session, notes);
  }

  previewLettering(lettering: Lettering) {
    return settings.previewLettering(this.session, lettering);
  }

  setProjectLettering(lettering: Lettering) {
    return settings.setProjectLettering(this.session, lettering);
  }

  previewShotForm(form: ShotForm) {
    return settings.previewShotForm(this.session, form);
  }

  setProjectShotForm(form: ShotForm) {
    return settings.setProjectShotForm(this.session, form);
  }

  previewBubbleNames(on: boolean) {
    return settings.previewBubbleNames(this.session, on);
  }

  setProjectBubbleNames(on: boolean) {
    return settings.setProjectBubbleNames(this.session, on);
  }

  previewKey(vendor: keyof ResolvedKeys, scope: KeyScope = 'project') {
    return keys.previewKey(this.session, vendor, scope);
  }

  setKey(vendor: keyof ResolvedKeys, key: string, scope: KeyScope = 'project') {
    return keys.setKey(this.session, vendor, key, scope);
  }

  keyStatusView() {
    return keys.keyStatusView(this.session);
  }

  keyGuide() {
    return keys.keyGuide();
  }

  openKeyLink(vendor: keyof ResolvedKeys, link: GuideUrlField) {
    return keys.openKeyLink(this.session, vendor, link);
  }

  checkForUpdates() {
    return updates.checkForUpdates(this.session);
  }

  openReleases() {
    return updates.openReleases(this.session);
  }

  openCollaboratingGuide() {
    return updates.openCollaboratingGuide(this.session);
  }

  previewTestKey(vendor: keyof ResolvedKeys) {
    return keys.previewTestKey(this.session, vendor);
  }

  testKey(vendor: keyof ResolvedKeys) {
    return keys.testKey(this.session, vendor);
  }

  condensingText(project: LoadedProject, flat: string) {
    return view.condensingText(this.session, project, flat);
  }
}

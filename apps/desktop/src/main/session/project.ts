import {
  CONFIG_FILENAME,
  KEY_VENDORS,
  keyStatus,
  loadConfig,
  resolveKeys,
  secretDirsFor,
  secretFileFor,
  setArtStyle,
  setLettering,
  setStoryboardNotes,
  userKeysDir,
  type ResolvedKeys,
  type VendorKeyStatus,
} from '@vn/config';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { exists, writeFileAtomic } from '@vn/util';
import { chatBackendFor, chatVendorFor, createMockProviders } from '@vn/providers';
import type { Lettering, ProjectConfig, TextLLM } from '@vn/types';
import type { KeyScope, KeyStatusView, ProjectView } from '../../shared/ipc.js';
import { parseKeyGuide, type GuideUrlField, type KeyGuide } from '../../shared/apikeys.js';
import { readResource } from '../distribution/resources.js';
import {
  CHECK_TIMEOUT_MS,
  RELEASES_API,
  RELEASES_PAGE,
  checkAgainst,
  runningVersion,
  unreachable,
  type UpdateCheck,
} from '../distribution/updates.js';
import { ensureIgnored } from '../workspace/workspace.js';
import type { WorkspaceSession, LoadedProject, PromptResult, PromptWriteResult } from './core.js';
import {
  IMAGE_KINDS,
  relPath,
  describeKeySource,
  loadProject,
  buildProviders,
  readAllShots,
} from './core.js';

/** Answers with the sent key's label and limits; a wrong key gets a 401 and nothing is billed. */
const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';

/** How much of an OpenRouter error body {@link ProjectPart.testKey} quotes. */
const OPENROUTER_ERROR_CHARS = 200;

/**
 * How many of a project's shots are pages, which is what a change of lettering re-keys. A
 * storyboard that will not parse counts for nothing here, since its pages cannot render either.
 */
async function pageShotCount(project: LoadedProject): Promise<number> {
  let pages = 0;
  for (const shots of (await readAllShots(project)).values()) {
    for (const shot of shots ?? []) if (shot.panels) pages += 1;
  }
  return pages;
}

export class ProjectPart {
  constructor(private readonly session: WorkspaceSession) {}

  async projectView(): Promise<ProjectView> {
    const project = await loadProject(this.session.dir);
    const { config } = project;
    return {
      root       : this.session.dir,
      title      : config.title,
      artStyle   : config.art_style,
      start      : config.start ?? '',
      models     : { ...config.models },
      imageParams: { ...config.image_params },
      imageTasks : project.graph.all().filter((task) => IMAGE_KINDS.has(task.kind)).length,
    };
  }

  /** What `project.setArtStyle` would do, without writing it. */
  async previewArtStyle(style: string): Promise<PromptResult> {
    const project = await loadProject(this.session.dir);
    if (project.config.art_style === style) {
      return { ok: false, message: 'The project already says that.' };
    }
    const count = project.graph.all().filter((task) => IMAGE_KINDS.has(task.kind)).length;
    const said = style.trim() ? `Set the art style to "${style.trim()}".` : 'Clear the art style.';
    return {
      ok     : true,
      message: `${said} It opens every image prompt, so it re-keys ${count} image task(s).`,
    };
  }

  /**
   * Write the project's art style. It is spliced into `project.yaml` rather than re-serialized,
   * so an author's comments and key order survive — the same posture the prose writers take with
   * front-matter.
   */
  async setProjectArtStyle(style: string): Promise<PromptWriteResult> {
    const preview = await this.session.previewArtStyle(style);
    if (!preview.ok) return { ...preview, written: [] };
    if (!(await setArtStyle(this.session.dir, style))) {
      return { ok: false, message: 'The project already says that.', written: [] };
    }
    return {
      ok     : true,
      message: preview.message,
      written: [relPath(this.session.dir, join(this.session.dir, CONFIG_FILENAME))],
    };
  }

  /** What `project.setStoryboardNotes` would do, without writing it. */
  async previewStoryboardNotes(notes: string): Promise<PromptResult> {
    const project = await loadProject(this.session.dir);
    if (project.config.storyboard_notes === notes) {
      return { ok: false, message: 'The project already says that.' };
    }
    const said = notes.trim()
      ? `Set the storyboard notes to "${notes.trim()}".`
      : 'Clear the storyboard notes.';
    return {
      ok     : true,
      message:
        `${said} The decomposer reads them the next time a scene is storyboarded; no shot ` +
        'already written is re-keyed.',
    };
  }

  /** Write the decomposer's directives, spliced into `project.yaml` like the art style. */
  async setProjectStoryboardNotes(notes: string): Promise<PromptWriteResult> {
    const preview = await this.session.previewStoryboardNotes(notes);
    if (!preview.ok) return { ...preview, written: [] };
    if (!(await setStoryboardNotes(this.session.dir, notes))) {
      return { ok: false, message: 'The project already says that.', written: [] };
    }
    return {
      ok     : true,
      message: preview.message,
      written: [relPath(this.session.dir, join(this.session.dir, CONFIG_FILENAME))],
    };
  }

  /**
   * What `project.setLettering` would do, without writing it. Lettering is in a page shot's
   * prompt and nowhere else, so the price is the page shots the project holds.
   */
  async previewLettering(lettering: Lettering): Promise<PromptResult> {
    const project = await loadProject(this.session.dir);
    if (project.config.lettering === lettering) {
      return { ok: false, message: 'The project already says that.' };
    }
    const pages = await pageShotCount(project);
    return {
      ok     : true,
      message:
        `Set lettering to "${lettering}". It applies to page shots alone, so it re-keys ` +
        `${pages} of them.`,
    };
  }

  /** Write who letters a page shot, spliced into `project.yaml` like the art style. */
  async setProjectLettering(lettering: Lettering): Promise<PromptWriteResult> {
    const preview = await this.session.previewLettering(lettering);
    if (!preview.ok) return { ...preview, written: [] };
    if (!(await setLettering(this.session.dir, lettering))) {
      return { ok: false, message: 'The project already says that.', written: [] };
    }
    return {
      ok     : true,
      message: preview.message,
      written: [relPath(this.session.dir, join(this.session.dir, CONFIG_FILENAME))],
    };
  }

  /**
   * Where a vendor's key file sits, whether one is already there, and whether an environment
   * variable would shadow it — `resolveKeys` reads `$NAME` first, so a file written under a set
   * variable is a key that never gets used. Reads no key back, here or anywhere.
   */
  private async keyFile(
    vendor: keyof ResolvedKeys,
    scope: KeyScope,
  ): Promise<{ path: string; shown: string; had: boolean; shadow: string }> {
    const file = secretFileFor(vendor);
    // The project scope is shown as a relative path because it sits inside the workspace the
    // author is looking at; the user scope is shown in full because it deliberately does not.
    const path =
      scope === 'user' ? join(userKeysDir(), file) : join(this.session.dir, 'keys', file);
    const shown = scope === 'user' ? path : `keys/${file}`;
    const envName = (await loadConfig(this.session.dir)).keys[vendor];
    const set = (process.env[envName] ?? '').trim() !== '';
    return {
      path,
      shown,
      had   : await exists(path),
      shadow: set ? ` $${envName} is set and is read first, so the file goes unused.` : '',
    };
  }

  /** What `project.setKey` would do, without writing it. */
  async previewKey(vendor: keyof ResolvedKeys, scope: KeyScope = 'project'): Promise<PromptResult> {
    const { shown, had, shadow } = await this.keyFile(vendor, scope);
    const reach =
      scope === 'user' ? ' Every project on this machine reads it.' : ' This project reads it.';
    return {
      ok     : true,
      message: `${had ? 'Replace' : 'Write'} the ${vendor} key in ${shown}.${reach}${shadow}`,
    };
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
    const value = key.trim();
    if (!value) return { ok: false, message: 'No key given.', written: [] };

    const { path, shown, had, shadow } = await this.keyFile(vendor, scope);
    const ignored = scope === 'project' ? await ensureIgnored(this.session.dir, ['keys']) : false;
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, `${value}\n`);
    if (scope === 'user' && process.platform !== 'win32') {
      await chmod(path, 0o600).catch(() => undefined);
    }

    // The key file itself is never reported as written: it is ignored (or outside the repo
    // entirely), so nothing downstream may treat it as a document. The `.gitignore` is, because
    // it is committed.
    const safety = scope === 'user' ? ', which is outside every repository' : ', which git ignores';
    const reach =
      scope === 'user' ? ' Every project on this machine reads it.' : ' This project reads it.';
    return {
      ok     : true,
      message: `${had ? 'Replaced' : 'Wrote'} the ${vendor} key in ${shown}${safety}.${reach}${shadow}`,
      written: ignored ? ['.gitignore'] : [],
    };
  }

  /**
   * For each vendor, whether a key resolved and which source answered — never the value. The
   * Setup pane is built on this, and so is the first-run check that decides whether to offer it.
   */
  async keyStatusView(): Promise<KeyStatusView> {
    const config = await loadConfig(this.session.dir);
    const status = await keyStatus(config, { secretsDirs: await secretDirsFor(this.session.dir) });
    const byVendor = new Map<string, VendorKeyStatus>(status.map((s) => [s.vendor, s]));
    return {
      userKeysDir: userKeysDir(),
      vendors: KEY_VENDORS.map((vendor) => {
        const s = byVendor.get(vendor);
        return {
          vendor,
          resolved : s?.resolved ?? false,
          source   : describeKeySource(this.session.dir, s),
          envName  : s?.envName ?? config.keys[vendor],
          envShadow: s?.envShadow ?? false,
          writesTo: {
            project: `keys/${secretFileFor(vendor)}`,
            user   : join(userKeysDir(), secretFileFor(vendor)),
          },
        };
      }),
    };
  }

  /**
   * The key walkthrough, read from the one file that holds it and parsed into blocks.
   *
   * Parsed here rather than in the pane because main is the side with a filesystem: what crosses
   * the IPC boundary is already drawable, and the pane cannot end up with a second opinion about
   * what the page says.
   */
  async keyGuide(): Promise<KeyGuide> {
    return parseKeyGuide(await readResource('docs', 'guides', 'api-keys.md'));
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
    const guide = await this.session.keyGuide();
    const url = guide.vendors.find((entry) => entry.vendor === vendor)?.[link] ?? '';
    if (!/^https:\/\//.test(url)) {
      return { ok: false, message: `The setup guide names no ${link} page for ${vendor}.` };
    }
    const open = this.session.deps.openExternal;
    if (!open) return { ok: false, message: 'This build cannot open a browser.' };
    await open(url);
    return { ok: true, message: `Opened ${url}.` };
  }

  /**
   * Ask GitHub whether there is a newer VN Studio than this one.
   *
   * The decision is `updates.ts`'s and is pure; this is the request. Unauthenticated, so it is
   * rate-limited at 60 an hour per IP — fine for one desktop app, which is why nothing automated
   * may ever call this.session.
   *
   * It never throws. Every failure comes back as an `unreachable` verdict carrying its own
   * sentence, because a check the author did not ask for must be able to fail without filing an
   * `error` notification at someone mid-scene. `announcementFor` is what decides whether the
   * verdict is worth saying out loud.
   */
  async checkForUpdates(): Promise<UpdateCheck> {
    const running = runningVersion(this.session.deps.appVersion ?? '');
    try {
      const response = await fetch(RELEASES_API, {
        headers: {
          accept      : 'application/vnd.github+json',
          // GitHub asks every client to name itself, and answers 403 to one that does not.
          'user-agent': `vnstudio/${running || 'dev'} (+${RELEASES_PAGE})`,
        },
        signal : AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      // 403 and 429 are the rate limit, and 404 is a repository with no release yet. All three
      // are "no answer today" rather than anything the author can act on.
      if (!response.ok) return unreachable(running, `GitHub answered ${response.status}`);
      return checkAgainst(running, await response.json());
    } catch (err) {
      return unreachable(running, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Open VN Studio's own releases page — the notes and the installers are one page there.
   *
   * The address is derived from `ISSUE_REPO` rather than passed in, for the reason
   * {@link openKeyLink} states: nothing in this app opens a URL it was handed, and a notification
   * — a line of a file git union-merges across clones — is exactly the input that rule is for.
   */
  async openReleases(): Promise<PromptResult> {
    const open = this.session.deps.openExternal;
    if (!open) return { ok: false, message: 'This build cannot open a browser.' };
    await open(RELEASES_PAGE);
    return { ok: true, message: `Opened ${RELEASES_PAGE}.` };
  }

  /**
   * Whether {@link testKey} has anything to try, in its own sentence either way — so the Setup
   * pane's greyed-out button says why it is grey rather than looking broken.
   */
  async previewTestKey(vendor: keyof ResolvedKeys): Promise<PromptResult> {
    if (this.session.mock) {
      return { ok: false, message: 'Mock mode makes no calls, so there is nothing to test.' };
    }
    const entry = (await this.session.keyStatusView()).vendors.find((v) => v.vendor === vendor);
    if (!entry?.resolved) {
      return { ok: false, message: `No ${vendor} key resolves yet, so there is nothing to try.` };
    }
    return { ok: true, message: `One small ${vendor} call, with the key it already reads.` };
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
    if (this.session.mock)
      return { ok: true, message: 'Mock mode makes no calls, so there is nothing to test.' };

    const config = await loadConfig(this.session.dir);
    if (vendor === 'openrouter') return this.testOpenRouterKey(config);
    const modelId = [config.models.text, ...config.models.vision].find(
      (id) => chatVendorFor(id) === vendor,
    );
    if (!modelId) {
      return {
        ok     : false,
        message: `This project configures no ${vendor} chat model, so there is nothing cheap to call.`,
      };
    }

    try {
      const keys = await resolveKeys(config, {
        secretsDirs: await secretDirsFor(this.session.dir),
        require    : [vendor],
      });
      const backend = chatBackendFor(modelId, keys).backend;
      await backend.message({ prompt: 'Reply with the single word OK.' });
      return { ok: true, message: `The ${vendor} key works — ${modelId} answered.` };
    } catch (err) {
      // The provider's own sentence, which is the one that distinguishes "no credit" from
      // "revoked" from "no access to that model". `resolveKeys` names sources, never values, and
      // a vendor SDK does not echo the key back, so this is safe to show.
      return { ok: false, message: `The ${vendor} key did not work: ${(err as Error).message}` };
    }
  }

  /**
   * OpenRouter has no chat backend here, so the cheap call is its key endpoint, which describes
   * the key it was sent and bills nothing.
   */
  private async testOpenRouterKey(config: ProjectConfig): Promise<PromptResult> {
    try {
      const keys = await resolveKeys(config, {
        secretsDirs: await secretDirsFor(this.session.dir),
        require    : ['openrouter'],
      });
      const response = await fetch(OPENROUTER_KEY_URL, {
        headers: { authorization: `Bearer ${keys.openrouter}` },
        signal : AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (!response.ok) {
        // The error body carries the reason (401 for an unknown key) and no copy of the key, so
        // it is safe to show
        const body = (await response.text()).slice(0, OPENROUTER_ERROR_CHARS);
        return {
          ok     : false,
          message: `The openrouter key did not work: HTTP ${response.status} ${body}`,
        };
      }
      return { ok: true, message: 'The openrouter key works — OpenRouter recognised it.' };
    } catch (err) {
      return { ok: false, message: `The openrouter key did not work: ${(err as Error).message}` };
    }
  }

  /**
   * The text provider a condensation runs against. Under `--mock` the backend echoes the prompt,
   * which no schema accepts, so every condensation would take the deterministic fallback and the
   * real path would never run; the canned answer is the identity condensation, which exercises it
   * with the chunks' own words.
   */
  condensingText(project: LoadedProject, flat: string): Promise<TextLLM> {
    if (!this.session.mock) return buildProviders(project, false).then((p) => p.text);
    return Promise.resolve(
      createMockProviders({ textResponses: [JSON.stringify({ prompt: flat, omitted: [] })] }).text,
    );
  }

  /** The derivation an override sits on: the chunks, the rung, and what is stored there today. */
}

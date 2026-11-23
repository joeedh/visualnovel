import {
  KEY_VENDORS,
  keyStatus,
  loadConfig,
  resolveKeys,
  secretDirsFor,
  secretFileFor,
  userKeysDir,
  type ResolvedKeys,
  type VendorKeyStatus,
} from '@vn/config';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { exists, writeFileAtomic } from '@vn/util';
import { chatBackendFor, chatVendorFor } from '@vn/providers';
import { chatRouteFor, type KeysPresent, type ProjectConfig } from '@vn/types';
import type { KeyScope, KeyStatusView } from '../../../shared/ipc.js';
import { parseKeyGuide, type GuideUrlField, type KeyGuide } from '../../../shared/apikeys.js';
import { readResource } from '../../distribution/resources.js';
import { CHECK_TIMEOUT_MS } from '../../distribution/updates.js';
import { ensureIgnored } from '../../workspace/workspace.js';
import { routingNotes } from '../routing.js';
import type { WorkspaceSession } from '../core.js';
import type { PromptResult, PromptWriteResult } from '../types/results.js';
import { describeKeySource } from '../rules/keys.js';

/** Answers with the sent key's label and limits; a wrong key gets a 401 and nothing is billed. */
const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';

/** How much of an OpenRouter error body {@link testKey} quotes. */
const OPENROUTER_ERROR_CHARS = 200;

/**
 * Where a vendor's key file sits, whether one is already there, and whether an environment
 * variable would shadow it — `resolveKeys` reads `$NAME` first, so a file written under a set
 * variable is a key that never gets used. Reads no key back, here or anywhere.
 */
async function keyFile(
  session: WorkspaceSession,
  vendor: keyof ResolvedKeys,
  scope: KeyScope,
): Promise<{ path: string; shown: string; had: boolean; shadow: string }> {
  const file = secretFileFor(vendor);
  // The project scope is shown as a relative path because it sits inside the workspace the
  // author is looking at; the user scope is shown in full because it deliberately does not.
  const path = scope === 'user' ? join(userKeysDir(), file) : join(session.dir, 'keys', file);
  const shown = scope === 'user' ? path : `keys/${file}`;
  const envName = (await loadConfig(session.dir)).keys[vendor];
  const set = (process.env[envName] ?? '').trim() !== '';
  return {
    path,
    shown,
    had   : await exists(path),
    shadow: set ? ` $${envName} is set and is read first, so the file goes unused.` : '',
  };
}

/** What `project.setKey` would do, without writing it. */
export async function previewKey(
  session: WorkspaceSession,
  vendor: keyof ResolvedKeys,
  scope: KeyScope = 'project',
): Promise<PromptResult> {
  const { shown, had, shadow } = await keyFile(session, vendor, scope);
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
export async function setKey(
  session: WorkspaceSession,
  vendor: keyof ResolvedKeys,
  key: string,
  scope: KeyScope = 'project',
): Promise<PromptWriteResult> {
  const value = key.trim();
  if (!value) return { ok: false, message: 'No key given.', written: [] };

  const { path, shown, had, shadow } = await keyFile(session, vendor, scope);
  const ignored = scope === 'project' ? await ensureIgnored(session.dir, ['keys']) : false;
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
export async function keyStatusView(session: WorkspaceSession): Promise<KeyStatusView> {
  const config = await loadConfig(session.dir);
  const status = await keyStatus(config, { secretsDirs: await secretDirsFor(session.dir) });
  const byVendor = new Map<string, VendorKeyStatus>(status.map((s) => [s.vendor, s]));
  const present = Object.fromEntries(
    status.map((s) => [s.vendor, s.resolved]),
  ) as unknown as KeysPresent;
  const { notes, unrouted } = routingNotes(config, present);
  return {
    userKeysDir: userKeysDir(),
    unrouted,
    vendors: KEY_VENDORS.map((vendor) => {
      const s = byVendor.get(vendor);
      return {
        vendor,
        resolved : s?.resolved ?? false,
        source   : describeKeySource(session.dir, s),
        envName  : s?.envName ?? config.keys[vendor],
        envShadow: s?.envShadow ?? false,
        writesTo: {
          project: `keys/${secretFileFor(vendor)}`,
          user   : join(userKeysDir(), secretFileFor(vendor)),
        },
        routing  : notes[vendor],
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
export async function keyGuide(): Promise<KeyGuide> {
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
export async function openKeyLink(
  session: WorkspaceSession,
  vendor: keyof ResolvedKeys,
  link: GuideUrlField,
): Promise<PromptResult> {
  const guide = await session.keyGuide();
  const url = guide.vendors.find((entry) => entry.vendor === vendor)?.[link] ?? '';
  if (!/^https:\/\//.test(url)) {
    return { ok: false, message: `The setup guide names no ${link} page for ${vendor}.` };
  }
  const open = session.deps.openExternal;
  if (!open) return { ok: false, message: 'This build cannot open a browser.' };
  await open(url);
  return { ok: true, message: `Opened ${url}.` };
}

/**
 * Whether {@link testKey} has anything to try, in its own sentence either way — so the Setup
 * pane's greyed-out button says why it is grey rather than looking broken.
 */
export async function previewTestKey(
  session: WorkspaceSession,
  vendor: keyof ResolvedKeys,
): Promise<PromptResult> {
  if (session.mock) {
    return { ok: false, message: 'Mock mode makes no calls, so there is nothing to test.' };
  }
  const entry = (await session.keyStatusView()).vendors.find((v) => v.vendor === vendor);
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
export async function testKey(
  session: WorkspaceSession,
  vendor: keyof ResolvedKeys,
): Promise<PromptResult> {
  if (session.mock)
    return { ok: true, message: 'Mock mode makes no calls, so there is nothing to test.' };

  const config = await loadConfig(session.dir);
  if (vendor === 'openrouter') return testOpenRouterKey(session, config);
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
    // This is the one caller that means a specific key: the route is narrowed to the vendor
    // under test so the call cannot slip through OpenRouter and report the wrong key working
    const keys = await resolveKeys(config, {
      secretsDirs: await secretDirsFor(session.dir),
      require    : [vendor],
    });
    const only = { anthropic: false, gemini: false, openrouter: false, [vendor]: true };
    const backend = chatBackendFor(chatRouteFor(modelId, only)!, keys).backend;
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
async function testOpenRouterKey(
  session: WorkspaceSession,
  config: ProjectConfig,
): Promise<PromptResult> {
  try {
    const keys = await resolveKeys(config, {
      secretsDirs: await secretDirsFor(session.dir),
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

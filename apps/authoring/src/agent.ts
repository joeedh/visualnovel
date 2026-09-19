/**
 * Wire a ready-to-run `Agent` for a workspace directory (plan §M4). This is the app's only
 * point of contact with provider construction: it picks a text `ChatBackend` from
 * `project.yaml`'s `models.text` and resolved keys, wraps it in the structured Path-A
 * backend, and assembles the system prompt from the built-in contract + `AICONTEXT.md`.
 * `--mock` swaps in an offline backend so the REPL runs end-to-end without API keys.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveKeys, secretDirsFor } from '@vn/config';
import { openGit } from '@vn/git';
import { chatBackendFor, chatRoute, type EffortChoice } from '@vn/providers';

// The curated model list and what reasoning each model takes both live in `@vn/types`, so the
// desktop app can offer the same menus without importing a package that loads a vendor SDK.
// `@vn/providers` re-exports them, which is the import used here.
export {
  DEFAULT_AGENT_EFFORT,
  EFFORT_CHOICES,
  EFFORT_LEVELS,
  TEXT_MODELS,
  effortChoicesFor,
  effortLabel,
  resolveEffort,
  supportsEffort,
  type Effort,
  type EffortChoice,
} from '@vn/providers';
export { BUDGET_CHOICES, DEFAULT_BUDGET, budgetLabel, type BudgetChoice } from '@vn/types';
import { type BudgetChoice } from '@vn/types';
import {
  Agent,
  BUILTIN_SKILLS_PATH,
  NativeAgentBackend,
  StructuredAgentBackend,
  Workspace,
  composeSystem,
  loadContext,
  workspaceArtGen,
  workspaceTextLLM,
  type AgentBackend,
  type AgentEvent,
  type ApiFailure,
  type ApiRecovery,
  type Permission,
  type ToolContext,
} from '@vn/authoring';

/**
 * The builtin skill catalog, found by walking up from the bundle this runs as: `vnauthor` is
 * built to `apps/authoring/dist/`, so the checkout root is above it. `import.meta.url` is the
 * bundle's own path under node and is empty under jest's CommonJS transform, where a test gets
 * project and user skills only unless it names the directory itself.
 */
export function builtinSkillsDir(): string | undefined {
  const url = (import.meta as { url?: string }).url;
  if (!url) return undefined;
  let dir = dirname(fileURLToPath(url));
  for (;;) {
    const candidate = join(dir, ...BUILTIN_SKILLS_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** A backend that does no LLM work: it just acknowledges, so the REPL runs offline. */
class MockAgentBackend implements AgentBackend {
  readonly kind = 'mock';

  next(): Promise<{ final: string }> {
    return Promise.resolve({
      final:
        '[mock] No model is configured (running with --mock). I can read the workspace, ' +
        'but I cannot reason about edits offline. Re-run without --mock to use a real model.',
    });
  }
}

/**
 * Build the agent backend for a project, or a mock when offline. `model`/`effort` override
 * the configured defaults (used by `/model` and `/effort`). Path B (provider-native
 * function-calling) is the default wherever the chosen `ChatBackend` can hold a conversation,
 * because it is the only path whose prefix caches. `noNative` forces Path A (structured ReAct
 * over the text seam), which is also where a backend without `chatConversation` lands.
 *
 * The probe is `chatConversation` rather than `chatWithTools`: Gemini implements the latter for
 * a request that is still single-shot and still caches nothing.
 */
export async function buildAgentBackend(
  dir: string,
  opts: { mock?: boolean; noNative?: boolean; model?: string; effort?: EffortChoice },
): Promise<AgentBackend> {
  if (opts.mock) return new MockAgentBackend();
  const config = await loadConfig(dir);
  const modelId = opts.model ?? config.models.text;
  const keys = await resolveKeys(config, { secretsDirs: await secretDirsFor(dir) });
  const chat = chatBackendFor(chatRoute(config, keys, modelId), keys, opts.effort).backend;
  if (!opts.noNative && chat.chatConversation) return new NativeAgentBackend(chat);
  return new StructuredAgentBackend(chat);
}

/** Everything the REPL needs to talk to one workspace. */
export interface AuthoringSession {
  agent: Agent;
  ctx: ToolContext;
  /** The text model the agent is currently bound to (what `/model` reports and changes). */
  model: string;
}

/** Assemble an {@link Agent} bound to `dir`, with `permission` driving the gates. */
export async function createAuthoringAgent(
  dir: string,
  permission: Permission,
  opts: {
    mock?: boolean;
    noNative?: boolean;
    /** What one turn may spend, in non-cached tokens. Defaults to {@link DEFAULT_BUDGET}. */
    budget?: BudgetChoice;
    onEvent?: (e: AgentEvent) => void;
    /** What to do when a call to the model fails. Omitting it lets the error propagate. */
    onApiError?: (failure: ApiFailure) => Promise<ApiRecovery>;
  } = {},
): Promise<AuthoringSession> {
  const workspace = new Workspace(dir);
  const builtin = builtinSkillsDir();
  const ctx: ToolContext = {
    workspace,
    git : openGit(dir),
    art : workspaceArtGen(workspace, { mock: opts.mock }),
    text: workspaceTextLLM(workspace, { mock: opts.mock }),
    ...(builtin ? { builtinSkillsDir: builtin } : {}),
  };
  const context = await loadContext(dir);
  const model = (await loadConfig(dir)).models.text;
  const backend = await buildAgentBackend(dir, { mock: opts.mock, noNative: opts.noNative, model });
  const agent = new Agent({
    backend,
    ctx,
    permission,
    system: composeSystem(context),
    ...(opts.budget ? { budget: opts.budget } : {}),
    onEvent: opts.onEvent,
    ...(opts.onApiError ? { onApiError: opts.onApiError } : {}),
  });
  return { agent, ctx, model };
}

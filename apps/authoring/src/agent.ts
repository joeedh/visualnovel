/**
 * Wire a ready-to-run `Agent` for a workspace directory (plan §M4). This is the app's only
 * point of contact with provider construction: it picks a text `ChatBackend` from
 * `project.yaml`'s `models.text` and resolved keys, wraps it in the structured Path-A
 * backend, and assembles the system prompt from the built-in contract + `AICONTEXT.md`.
 * `--mock` swaps in an offline backend so the REPL runs end-to-end without API keys.
 */
import { loadConfig, resolveKeys, secretDirsFor } from '@vn/config';
import { openGit } from '@vn/git';
import {
  createAnthropicChat,
  createGeminiChat,
  type ChatBackend,
  type EffortChoice,
} from '@vn/providers';

// The curated model list and what reasoning each model takes both live in `@vn/types`: the
// desktop app offers the same menus and cannot import a package that loads a vendor SDK.
export {
  DEFAULT_EFFORT,
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
import {
  Agent,
  NativeAgentBackend,
  StructuredAgentBackend,
  Workspace,
  composeSystem,
  loadContext,
  workspaceArtGen,
  type AgentBackend,
  type AgentEvent,
  type Permission,
  type ToolContext,
} from '@vn/authoring';

/** A backend that does no LLM work: it just acknowledges, so the REPL runs offline. */
class MockAgentBackend implements AgentBackend {
  next(): Promise<{ final: string }> {
    return Promise.resolve({
      final:
        '[mock] No model is configured (running with --mock). I can read the workspace, ' +
        'but I cannot reason about edits offline. Re-run without --mock to use a real model.',
    });
  }
}

/** Choose the vendor backend for a text model id (mirrors @vn/providers’ private picker). */
function chatBackendFor(
  modelId: string,
  keys: { gemini: string; anthropic: string },
  effort?: EffortChoice,
): ChatBackend {
  const id = modelId.toLowerCase();
  if (id.startsWith('claude') || id.startsWith('anthropic')) {
    return createAnthropicChat(keys.anthropic, modelId, { effort });
  }
  return createGeminiChat(keys.gemini, modelId);
}

/**
 * Build the agent backend for a project, or a mock when offline. `model`/`effort` override
 * the configured defaults (used by `/model` and `/effort`). Path B (provider-native
 * function-calling) is the default wherever the chosen `ChatBackend` can hold a conversation,
 * because it is the only path whose prefix caches; `noNative` is the escape hatch back to
 * Path A (structured ReAct over the text seam), which is also where a backend without
 * `chatConversation` lands anyway.
 *
 * The probe is `chatConversation` and deliberately not `chatWithTools`: Gemini implements the
 * latter for a request that is still single-shot and still caches nothing.
 */
export async function buildAgentBackend(
  dir: string,
  opts: { mock?: boolean; noNative?: boolean; model?: string; effort?: EffortChoice },
): Promise<AgentBackend> {
  if (opts.mock) return new MockAgentBackend();
  const config = await loadConfig(dir);
  const modelId = opts.model ?? config.models.text;
  const vendor = modelId.toLowerCase().startsWith('claude') ? 'anthropic' : 'gemini';
  const keys = await resolveKeys(config, {
    secretsDirs: await secretDirsFor(dir),
    require: [vendor],
  });
  const chat = chatBackendFor(modelId, keys, opts.effort);
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
    onEvent?: (e: AgentEvent) => void;
  } = {},
): Promise<AuthoringSession> {
  const workspace = new Workspace(dir);
  const ctx: ToolContext = {
    workspace,
    git: openGit(dir),
    art: workspaceArtGen(workspace, { mock: opts.mock }),
  };
  const context = await loadContext(dir);
  const model = (await loadConfig(dir)).models.text;
  const backend = await buildAgentBackend(dir, { mock: opts.mock, noNative: opts.noNative, model });
  const agent = new Agent({
    backend,
    ctx,
    permission,
    system: composeSystem(context),
    onEvent: opts.onEvent,
  });
  return { agent, ctx, model };
}

/**
 * Wire a ready-to-run `Agent` for a workspace directory (plan §M4). This is the app's only
 * point of contact with provider construction: it picks a text `ChatBackend` from
 * `project.yaml`'s `models.text` and resolved keys, wraps it in the structured Path-A
 * backend, and assembles the system prompt from the built-in contract + `AICONTEXT.md`.
 * `--mock` swaps in an offline backend so the REPL runs end-to-end without API keys.
 */
import { loadConfig, resolveKeys, secretDirsFor } from '@vn/config';
import { openGit } from '@vn/git';
import { createAnthropicChat, createGeminiChat, type ChatBackend } from '@vn/providers';
import {
  Agent,
  NativeAgentBackend,
  StructuredAgentBackend,
  Workspace,
  composeSystem,
  loadContext,
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
function chatBackendFor(modelId: string, keys: { gemini: string; anthropic: string }): ChatBackend {
  const id = modelId.toLowerCase();
  if (id.startsWith('claude') || id.startsWith('anthropic')) {
    return createAnthropicChat(keys.anthropic, modelId);
  }
  return createGeminiChat(keys.gemini, modelId);
}

/**
 * Build the agent backend for a project, or a mock when offline. `native` selects Path B
 * (provider-native function-calling) when the chosen `ChatBackend` supports `chatWithTools`;
 * otherwise it falls back to Path A (structured ReAct over the text seam).
 */
async function buildBackend(
  dir: string,
  opts: { mock?: boolean; native?: boolean },
): Promise<AgentBackend> {
  if (opts.mock) return new MockAgentBackend();
  const config = await loadConfig(dir);
  const modelId = config.models.text;
  const vendor = modelId.toLowerCase().startsWith('claude') ? 'anthropic' : 'gemini';
  const keys = await resolveKeys(config, {
    secretsDirs: await secretDirsFor(dir),
    require: [vendor],
  });
  const chat = chatBackendFor(modelId, keys);
  if (opts.native && chat.chatWithTools) return new NativeAgentBackend(chat);
  return new StructuredAgentBackend(chat);
}

/** Everything the REPL needs to talk to one workspace. */
export interface AuthoringSession {
  agent: Agent;
  ctx: ToolContext;
}

/** Assemble an {@link Agent} bound to `dir`, with `permission` driving the gates. */
export async function createAuthoringAgent(
  dir: string,
  permission: Permission,
  opts: {
    mock?: boolean;
    native?: boolean;
    onEvent?: (e: AgentEvent) => void;
  } = {},
): Promise<AuthoringSession> {
  const ctx: ToolContext = { workspace: new Workspace(dir), git: openGit(dir) };
  const context = await loadContext(dir);
  const backend = await buildBackend(dir, opts);
  const agent = new Agent({
    backend,
    ctx,
    permission,
    system: composeSystem(context),
    onEvent: opts.onEvent,
  });
  return { agent, ctx };
}

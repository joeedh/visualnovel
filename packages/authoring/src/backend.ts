/**
 * The agent backend seam (authoring-agent plan §6 "Agent backend & tool protocol").
 * The conversation loop is written against `AgentBackend` so the tool-call protocol can
 * evolve without touching the loop. Path A (the MVP, here) runs a structured ReAct loop
 * on the existing `ChatBackend` text seam — the model emits one zod-validated action per
 * turn and we feed back an observation. Path B (native function-calling) can implement the
 * same interface later (M5).
 */
import { z } from 'zod';
import { parseStructured } from '@vn/providers';
import type { ChatBackend, ToolSchema } from '@vn/providers';

/** A message in the running transcript handed to the backend. */
export interface AgentMessage {
  role: 'user' | 'assistant' | 'observation';
  content: string;
}

/** A tool the model may call, as advertised to the backend. */
export interface ToolSpec {
  name: string;
  description: string;
  mutating: boolean;
  /** Compact `name?: type (note)` argument signature, so the model needn't guess fields. */
  parameters?: string;
}

/** A single requested tool call. */
export interface AgentAction {
  tool: string;
  args: unknown;
}

/** One step the backend produces: an optional message + either an action or a final answer. */
export interface AgentTurn {
  /** Free-text reasoning/narration to surface to the user. */
  message?: string;
  /** A tool to execute next. */
  action?: AgentAction;
  /** When set, the turn is the final answer to the user and the loop ends. */
  final?: string;
}

/** The protocol the loop targets; swap implementations to change tool-call mechanics. */
export interface AgentBackend {
  next(
    system: string,
    messages: AgentMessage[],
    tools: ToolSpec[],
    mode: 'plan' | 'execute',
  ): Promise<AgentTurn>;
}

/** The JSON shape the structured backend asks the model to emit each turn. */
const turnSchema = z
  .object({
    thought: z.string().optional(),
    tool: z.string().optional(),
    args: z.unknown().optional(),
    final: z.string().optional(),
  })
  .refine((t) => t.tool !== undefined || t.final !== undefined, {
    message: 'each turn must contain either "tool" or "final"',
  });

const PROTOCOL = `Respond with a SINGLE JSON object and nothing else. Either call a tool:
  {"thought": "why", "tool": "tool_name", "args": { ... }}
or finish your turn with a message to the user:
  {"thought": "why", "final": "your message"}
Call exactly one tool per step; you will receive its result as an observation and may then
call another tool or finish. Never invent tools outside the provided list.`;

/** Render the tool catalog for the prompt. */
function renderTools(tools: ToolSpec[]): string {
  return tools
    .map((t) => {
      const head = `- ${t.name}${t.mutating ? ' (mutating)' : ''}: ${t.description}`;
      return t.parameters ? `${head}\n    args: ${t.parameters}` : head;
    })
    .join('\n');
}

/** Render the transcript for a single-turn text backend. */
function renderTranscript(messages: AgentMessage[]): string {
  return messages
    .map((m) => {
      const label = m.role === 'observation' ? 'OBSERVATION' : m.role.toUpperCase();
      return `${label}: ${m.content}`;
    })
    .join('\n\n');
}

/**
 * Path A: structured ReAct over a plain `ChatBackend`. Builds a one-shot prompt from the
 * transcript + tool catalog + protocol, then parses the model's JSON into an `AgentTurn`
 * (with retry on malformed output via `parseStructured`). No `@vn/providers` change.
 */
export class StructuredAgentBackend implements AgentBackend {
  constructor(
    private readonly chat: ChatBackend,
    private readonly opts: { attempts?: number } = {},
  ) {}

  async next(
    system: string,
    messages: AgentMessage[],
    tools: ToolSpec[],
    mode: 'plan' | 'execute',
  ): Promise<AgentTurn> {
    const prompt = [
      `MODE: ${mode}${mode === 'plan' ? ' (read-only — mutating tools are blocked until a plan is approved)' : ''}`,
      '',
      'TOOLS:',
      renderTools(tools),
      '',
      PROTOCOL,
      '',
      'TRANSCRIPT:',
      renderTranscript(messages),
      '',
      'Your next JSON action:',
    ].join('\n');

    const attempts = this.opts.attempts ?? 3;
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const raw = await this.chat.message({ system, prompt });
        const parsed = parseStructured(raw, turnSchema);
        const turn: AgentTurn = { message: parsed.thought };
        if (parsed.final !== undefined) turn.final = parsed.final;
        else if (parsed.tool !== undefined) turn.action = { tool: parsed.tool, args: parsed.args };
        return turn;
      } catch (err) {
        lastErr = err;
      }
    }
    // Degrade gracefully: surface the parse failure as a final message rather than throw.
    return {
      final: `I couldn't produce a valid action (${lastErr instanceof Error ? lastErr.message : String(lastErr)}).`,
    };
  }
}

/** A permissive object schema — the agent loop re-validates args via the registry's zod. */
const LOOSE_PARAMS = { type: 'object', additionalProperties: true } as const;

/**
 * Path B: native function-calling over a `ChatBackend` that implements `chatWithTools`. The
 * loop's `ToolSpec`s become provider tool schemas (with permissive parameters — the loop is
 * the real arg-validation authority), and the model's first tool call maps to an
 * `AgentTurn` action; text-only replies become a final message. Same `AgentBackend`
 * contract as Path A, so the conversation loop is unchanged.
 */
export class NativeAgentBackend implements AgentBackend {
  constructor(private readonly chat: ChatBackend) {
    if (!chat.chatWithTools) {
      throw new Error(`backend "${chat.modelId}" does not support native tool-calling`);
    }
  }

  async next(
    system: string,
    messages: AgentMessage[],
    tools: ToolSpec[],
    mode: 'plan' | 'execute',
  ): Promise<AgentTurn> {
    const schemas: ToolSchema[] = tools.map((t) => {
      let description = t.mutating ? `${t.description} (mutating)` : t.description;
      if (t.parameters) description += ` Args: ${t.parameters}`;
      return { name: t.name, description, parameters: LOOSE_PARAMS };
    });
    const prompt = [
      `MODE: ${mode}${mode === 'plan' ? ' (read-only — mutating tools are blocked until a plan is approved)' : ''}`,
      '',
      'TRANSCRIPT:',
      renderTranscript(messages),
    ].join('\n');

    const reply = await this.chat.chatWithTools!({ system, prompt }, schemas);
    const call = reply.toolCalls[0];
    if (call) {
      const turn: AgentTurn = { action: { tool: call.name, args: call.args } };
      if (reply.text) turn.message = reply.text;
      return turn;
    }
    return { final: reply.text ?? '' };
  }
}

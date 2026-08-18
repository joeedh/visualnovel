/**
 * The agent backend seam (authoring-agent plan §6 "Agent backend & tool protocol").
 * The conversation loop is written against `AgentBackend` so the tool-call protocol can
 * evolve without touching the loop. Path A (the MVP, here) runs a structured ReAct loop
 * on the existing `ChatBackend` text seam — the model emits one zod-validated action per
 * turn and we feed back an observation. Path B is native function-calling over
 * `chatConversation`, which is the cached path
 * (`docs/plans/prompt-caching-and-deferred-tool-loading.md`).
 */
import { z } from 'zod';
import { parseStructured } from '@vn/providers';
import type { ChatBackend, ChatReply, ChatTurn, TokenUsage, ToolSchema } from '@vn/providers';

/**
 * A message in the running transcript handed to the backend.
 *
 * `context` is what the *host* knew when the turn started — which scene the author had open, say.
 * It is a message rather than part of the system prompt because it was true at that turn and not
 * at the others, and a transcript is the only place that distinction survives.
 *
 * `system` is out-of-band truth filed the same way and for the same reason: the mode, or a
 * section of the system prompt that has since been rewritten. Editing the prompt itself would
 * invalidate the whole cached prefix; appending a message does not.
 *
 * `content` is a string on every message the loop writes itself. It is the provider's own blocks
 * on an assistant turn that came back from a native backend — thinking blocks must be echoed
 * complete and unmodified, so the only safe transcript entry is the one that was received.
 */
export interface AgentMessage {
  role: 'user' | 'assistant' | 'observation' | 'context' | 'system';
  content: string | unknown[];
  /** For an `observation`: the call it answers, so a native backend can pair the two. */
  toolUseId?: string;
}

/** A tool the model may call, as advertised to the backend. */
export interface ToolSpec {
  name: string;
  description: string;
  mutating: boolean;
  /** Compact `name?: type (note)` argument signature, so the model needn't guess fields. */
  parameters?: string;
  /** Keep out of context until the model searches for it. Advisory — a text path renders all. */
  defer?: boolean;
}

/** A single requested tool call. */
export interface AgentAction {
  tool: string;
  args: unknown;
  /** The provider's id for the call, when there is one; a `tool_result` must quote it back. */
  id?: string;
}

/** One step the backend produces: an optional message + either some actions or a final answer. */
export interface AgentTurn {
  /** Free-text reasoning/narration to surface to the user. */
  message?: string;
  /**
   * Tools to execute next. More than one when the model asked for them in parallel — every call
   * must be answered, so the loop runs them all rather than picking the first.
   */
  actions?: AgentAction[];
  /** When set, the turn is the final answer to the user and the loop ends. */
  final?: string;
  /**
   * The assistant's content blocks exactly as the provider sent them. Recorded in place of the
   * rendered text when present, because a thinking block that is rebuilt rather than echoed is
   * rejected outright.
   */
  raw?: unknown[];
  /**
   * What this step cost, when the provider said. A step that was retried carries the sum of
   * every attempt: each one was a call, and each one was billed.
   */
  usage?: TokenUsage;
}

/**
 * Add up two receipts. `undefined` throughout means nothing was reported, not that it was free —
 * so a cache field stays absent until some attempt actually reported one.
 */
function plus(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!b) return a;
  const sum: TokenUsage = {
    input: (a?.input ?? 0) + b.input,
    output: (a?.output ?? 0) + b.output,
  };
  if (a?.cacheRead !== undefined || b.cacheRead !== undefined) {
    sum.cacheRead = (a?.cacheRead ?? 0) + (b.cacheRead ?? 0);
  }
  if (a?.cacheWrite !== undefined || b.cacheWrite !== undefined) {
    sum.cacheWrite = (a?.cacheWrite ?? 0) + (b.cacheWrite ?? 0);
  }
  // One estimated attempt makes the sum an estimate: a total is only as exact as its vaguest term.
  if (a?.cacheEstimated || b.cacheEstimated) sum.cacheEstimated = true;
  return sum;
}

/**
 * The protocol the loop targets; swap implementations to change tool-call mechanics.
 *
 * There is no `mode` parameter: the plan/execute mode is filed into `messages` as a `system`
 * turn, so switching it appends rather than rewriting a prompt every cached byte depends on.
 */
export interface AgentBackend {
  next(system: string, messages: AgentMessage[], tools: ToolSpec[]): Promise<AgentTurn>;
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

/** A message's text, for the paths and panes that can only carry text. */
export function messageText(content: string | unknown[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => (b && typeof b === 'object' ? ((b as { text?: string }).text ?? '') : ''))
    .filter((t) => t)
    .join('\n');
}

/** Render the transcript for a single-turn text backend. */
function renderTranscript(messages: AgentMessage[]): string {
  return messages
    .map((m) => {
      const label =
        m.role === 'observation'
          ? 'OBSERVATION'
          : m.role === 'system'
            ? 'SYSTEM (out-of-band)'
            : m.role.toUpperCase();
      return `${label}: ${messageText(m.content)}`;
    })
    .join('\n\n');
}

/** What attempt 2 and on append: the same prompt plus what was wrong with the last answer. */
const REPAIR =
  'Your previous reply was not a single JSON object. Reply with the JSON object only — no ' +
  'prose around it, no code fence.';

/** Whether unparseable output was a fumbled tool call rather than an answer written in prose. */
function looksLikeToolCall(raw: string): boolean {
  return raw.trim() === '' || /"tool"\s*:/.test(raw);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Path A: structured ReAct over a plain `ChatBackend`. Builds a one-shot prompt from the
 * transcript + tool catalog + protocol, then parses the model's JSON into an `AgentTurn`
 * (with retry on malformed output via `parseStructured`). No `@vn/providers` change.
 *
 * Every tool is rendered whatever its `defer` flag says: deferral is a property of the API's
 * own tool search, and there is nothing here to search.
 */
export class StructuredAgentBackend implements AgentBackend {
  constructor(
    private readonly chat: ChatBackend,
    private readonly opts: { attempts?: number } = {},
  ) {}

  async next(system: string, messages: AgentMessage[], tools: ToolSpec[]): Promise<AgentTurn> {
    const prompt = [
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
    let lastRaw = '';
    // Every attempt is a call the author pays for, so the receipt accumulates across the retries
    // and rides out on whichever turn is finally returned — including the one that gave up.
    let spent: TokenUsage | undefined;
    for (let i = 0; i < attempts; i++) {
      try {
        // A repeat of a prompt that already failed is a request for the same answer. From the
        // second attempt on, say what was wrong with the last one.
        const reply = await this.reply({
          system,
          prompt:
            i === 0
              ? prompt
              : `${prompt}

${REPAIR}`,
        });
        spent = plus(spent, reply.usage);
        lastRaw = reply.text;
        const parsed = parseStructured(reply.text, turnSchema);
        const turn: AgentTurn = { message: parsed.thought };
        if (parsed.final !== undefined) turn.final = parsed.final;
        else if (parsed.tool !== undefined) {
          turn.actions = [{ tool: parsed.tool, args: parsed.args }];
        }
        if (spent) turn.usage = spent;
        return turn;
      } catch (err) {
        lastErr = err;
      }
    }
    // A model that answered in prose finished its turn: the JSON envelope is our bookkeeping,
    // not its intent, and discarding the answer loses the only thing the author asked for. Text
    // reaching for a tool is the other case — there the model meant to act and got it wrong, and
    // handing the author a half-typed call as an answer would be worse than saying so.
    const failed: AgentTurn = looksLikeToolCall(lastRaw)
      ? { final: `I couldn't produce a valid action (${errorText(lastErr)}).` }
      : { final: lastRaw };
    if (spent) failed.usage = spent;
    return failed;
  }

  /** One text turn, with the receipt when the backend keeps one. */
  private async reply(req: { system: string; prompt: string }): Promise<ChatReply> {
    if (this.chat.messageWithUsage) return this.chat.messageWithUsage(req);
    return { text: await this.chat.message(req) };
  }
}

/** A permissive object schema — the agent loop re-validates args via the registry's zod. */
const LOOSE_PARAMS = { type: 'object', additionalProperties: true } as const;

/** One transcript message as a conversation turn. Roles the API lacks are prefixed instead. */
function turnOf(m: AgentMessage): ChatTurn {
  if (m.role === 'assistant') return { role: 'assistant', content: m.content };
  if (m.role === 'system') return { role: 'system', content: m.content };
  if (m.role === 'observation') {
    // A native call is answered by quoting its id back; an observation with no id is a
    // host-authored note (a refusal, a cancellation) that belongs in the transcript as prose.
    if (m.toolUseId) {
      return {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: m.toolUseId, content: messageText(m.content) },
        ],
      };
    }
    return { role: 'user', content: `OBSERVATION: ${messageText(m.content)}` };
  }
  if (m.role === 'context') return { role: 'user', content: `CONTEXT: ${messageText(m.content)}` };
  return { role: 'user', content: m.content };
}

/**
 * Path B: native function-calling over a `ChatBackend` that implements `chatConversation`. The
 * transcript is sent as turns rather than re-rendered into one prompt, which is what makes the
 * prefix cacheable, and every tool call in a reply is returned — the API requires all of them to
 * be answered. Same `AgentBackend` contract as Path A, so the conversation loop is unchanged.
 */
export class NativeAgentBackend implements AgentBackend {
  /** Where the previous request put its trailing breakpoint — the one this request reads from. */
  private prevBreak = -1;

  constructor(private readonly chat: ChatBackend) {
    if (!chat.chatConversation) {
      throw new Error(`backend "${chat.modelId}" does not support native tool-calling`);
    }
  }

  async next(system: string, messages: AgentMessage[], tools: ToolSpec[]): Promise<AgentTurn> {
    const schemas: ToolSchema[] = tools.map((t) => {
      let description = t.mutating ? `${t.description} (mutating)` : t.description;
      if (t.parameters) description += ` Args: ${t.parameters}`;
      return {
        name: t.name,
        description,
        parameters: LOOSE_PARAMS,
        ...(t.defer ? { defer: true } : {}),
      };
    });

    const turns = messages.map(turnOf);
    // Two rolling breakpoints: the tail, which writes, and the previous tail, which reads. A
    // conversation that got shorter (it was cleared) has no prefix left worth reading.
    if (messages.length <= this.prevBreak) this.prevBreak = -1;
    const last = turns.length - 1;
    if (last >= 0) {
      turns[last] = { ...turns[last]!, cache: true };
      if (this.prevBreak >= 0 && this.prevBreak < last) {
        turns[this.prevBreak] = { ...turns[this.prevBreak]!, cache: true };
      }
      this.prevBreak = last;
    }

    const reply = await this.chat.chatConversation!({ system, turns }, schemas);
    const turn: AgentTurn = { raw: reply.raw };
    const actions = reply.toolCalls.map((c) => ({ tool: c.name, args: c.args, id: c.id }));
    if (actions.length) {
      turn.actions = actions;
      if (reply.text) turn.message = reply.text;
    } else {
      turn.final = reply.text ?? '';
    }
    if (reply.usage) turn.usage = reply.usage;
    return turn;
  }
}

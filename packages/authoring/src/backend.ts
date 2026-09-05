/**
 * The agent backend seam (authoring-agent plan §6 "Agent backend & tool protocol").
 * The conversation loop is written against `AgentBackend` so the tool-call protocol can
 * evolve without touching the loop. Path A (the MVP, here) runs a structured ReAct loop
 * on the existing `ChatBackend` text seam — the model emits one zod-validated action per
 * turn and we feed back an observation. Path B is native function-calling over
 * `chatConversation`, which is the cached path
 * (`docs/plans/archive/INDEX.md#prompt-caching-and-deferred-tool-loading`).
 */
import { z } from 'zod';
import { ProviderError } from '@vn/util';
import { parseStructured } from '@vn/providers';
import type { ChatBackend, ChatReply, ChatTurn, TokenUsage, ToolSchema } from '@vn/providers';

/**
 * A message in the running transcript handed to the backend.
 *
 * `context` is what the host knew when the turn started — which scene the author had open, say.
 * It is a message rather than part of the system prompt because it was true at that turn and not
 * at the others, and a transcript is the only place that distinction survives.
 *
 * `system` carries out-of-band truth filed as a message for the same reason: the mode, or a
 * section of the system prompt that has since been rewritten. Editing the prompt itself would
 * invalidate the whole cached prefix; appending a message does not.
 *
 * `content` is a string on every message the loop writes itself. An assistant turn that came back
 * from a native backend carries the provider's own blocks instead, because thinking blocks must be
 * echoed complete and unmodified.
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
  /**
   * The same arguments as JSON Schema, for a backend that takes one. Absent for a tool with no
   * zod shape in the registry, which falls back to a permissive object.
   */
  schema?: Record<string, unknown>;
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
   * What this step cost, when the provider said. A step that was retried carries the sum of every
   * attempt, because each attempt was a billed call.
   */
  usage?: TokenUsage;
  /**
   * Whether the prompt cache was read as it should have been, when the backend's figures can be
   * compared across calls. Absent means the question was not answerable, never that the cache hit.
   */
  cacheVerdict?: CacheVerdict;
}

/**
 * What one call did to the prompt cache. `cold` opens a conversation and is not a defect;
 * `expired` is a prefix that aged out between calls. `miss` is the one worth a record: the prefix
 * broke while it was still readable.
 */
export type CacheVerdict = 'cold' | 'hit' | 'expired' | 'miss';

/**
 * Adds two token-usage receipts together. `undefined` throughout means nothing was reported,
 * not that usage was free, so a cache field stays absent until some attempt actually reports
 * one.
 */
function plus(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!b) return a;
  const sum: TokenUsage = {
    input : (a?.input ?? 0) + b.input,
    output: (a?.output ?? 0) + b.output,
  };
  if (a?.cacheRead !== undefined || b.cacheRead !== undefined) {
    sum.cacheRead = (a?.cacheRead ?? 0) + (b.cacheRead ?? 0);
  }
  if (a?.cacheWrite !== undefined || b.cacheWrite !== undefined) {
    sum.cacheWrite = (a?.cacheWrite ?? 0) + (b.cacheWrite ?? 0);
  }
  // One estimated attempt makes the whole sum an estimate
  if (a?.cacheEstimated || b.cacheEstimated) sum.cacheEstimated = true;
  return sum;
}

/**
 * The three tool-call protocols a backend can speak. `native` sends provider tool blocks,
 * `structured` asks for one JSON object per turn, and `mock` answers from a script.
 */
export type BackendKind = 'native' | 'structured' | 'mock';

/**
 * The protocol the loop targets; swap implementations to change tool-call mechanics.
 *
 * There is no `mode` parameter: the plan/execute mode is filed into `messages` as a `system`
 * turn, so switching modes appends a message instead of rewriting the prompt the cached prefix
 * depends on.
 */
export interface AgentBackend {
  /**
   * Which protocol this backend speaks. A stored transcript can only be replayed to a backend of
   * the same kind, because the native path's messages carry provider blocks the structured path
   * does not understand.
   */
  readonly kind: BackendKind;
  next(system: string, messages: AgentMessage[], tools: ToolSpec[]): Promise<AgentTurn>;
  /**
   * The conversation was cleared and the next call starts from nothing. Called by `Agent.clear`,
   * which keeps the backend it was given, so per-conversation state that outlived the transcript
   * would otherwise be compared against a prefix that no longer exists.
   */
  reset?(): void;
}

/** The JSON shape the structured backend asks the model to emit each turn. */
const turnSchema = z
  .object({
    thought: z.string().optional(),
    tool   : z.string().optional(),
    args   : z.unknown().optional(),
    final  : z.string().optional(),
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

/**
 * Render the transcript as labelled prose, for a single-turn text backend and for anything else
 * that must show a conversation to a model as one block of text.
 */
export function renderTranscript(messages: readonly AgentMessage[]): string {
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

/** Appended from the second attempt on, naming what was wrong with the previous answer. */
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
  readonly kind = 'structured';

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
    // Every attempt is a call the author pays for, so the receipt accumulates across retries and
    // is returned on whichever turn ends the loop, including a turn that gave up
    let spent: TokenUsage | undefined;
    for (let i = 0; i < attempts; i++) {
      try {
        // From the second attempt on, append what was wrong with the last answer; repeating the
        // failed prompt unchanged would ask for the same answer again
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
        // A `ProviderError` is the API refusing the request, not the model answering badly.
        // Retrying an unchanged body buys the same refusal three times, and folding it into a
        // `final` reports an API fault as a normal turn: no card, `ok: true`, nothing to diagnose
        if (err instanceof ProviderError) throw err;
        lastErr = err;
      }
    }
    // Prose that reached for no tool is the model finishing its turn, and it is returned as the
    // answer because the JSON envelope is only our bookkeeping. Text that fumbled a tool call is
    // reported as a failure instead, since a half-typed call is not an answer.
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
    // A native call is answered by quoting its id back. An observation with no id is a
    // host-authored note (a refusal, a cancellation) and belongs in the transcript as prose
    if (m.toolUseId) {
      return {
        role   : 'user',
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
  readonly kind = 'native';

  /** Where the previous request put its trailing breakpoint — the one this request reads from. */
  private prevBreak = -1;
  /** The previous call's receipt and the moment it arrived, which is what a verdict compares. */
  private prev: { usage: TokenUsage; at: number } | undefined;

  constructor(
    private readonly chat: ChatBackend,
    private readonly now: () => number = Date.now,
  ) {
    if (!chat.chatConversation) {
      throw new Error(`backend "${chat.modelId}" does not support native tool-calling`);
    }
  }

  reset(): void {
    this.prevBreak = -1;
    this.prev = undefined;
  }

  /**
   * What this receipt says the cache did, against the one before it. Everything readable last call
   * plus everything written last call should be readable this call, so a drop means the prefix was
   * invalidated in between.
   *
   * Answered only where the backend says its figures are lines on a bill and both receipts carry
   * both figures. An absent count means the vendor said nothing rather than zero, so reading one as
   * a zero would report a miss against a cache that worked.
   */
  private verdictFor(usage: TokenUsage): CacheVerdict | undefined {
    if (this.chat.cacheReporting !== 'billed') return undefined;
    const prev = this.prev;
    const at = this.now();
    this.prev = { usage, at };
    if (!prev) return 'cold';
    if (usage.cacheRead === undefined) return undefined;
    if (prev.usage.cacheRead === undefined || prev.usage.cacheWrite === undefined) return undefined;
    if (usage.cacheRead >= prev.usage.cacheRead + prev.usage.cacheWrite) return 'hit';
    // A prefix that aged out is not a defect, and telling the two apart needs a TTL only the
    // backend knows. Without one the drop is real and its cause is not, so neither is reported
    const ttl = this.chat.cacheTtlMs;
    if (ttl === undefined) return undefined;
    return at - prev.at > ttl ? 'expired' : 'miss';
  }

  async next(system: string, messages: AgentMessage[], tools: ToolSpec[]): Promise<AgentTurn> {
    const schemas: ToolSchema[] = tools.map((t) => {
      let description = t.mutating ? `${t.description} (mutating)` : t.description;
      // A tool that carries a schema already states its arguments in the request; appending the
      // signature too would put the same information in the cached prefix twice.
      if (t.parameters && !t.schema) description += ` Args: ${t.parameters}`;
      return {
        name: t.name,
        description,
        parameters: t.schema ?? LOOSE_PARAMS,
        ...(t.defer ? { defer: true } : {}),
      };
    });

    const turns = messages.map(turnOf);
    // Two rolling breakpoints: the tail turn writes the cache and the previous tail reads it. A
    // conversation that got shorter (it was cleared) has no prefix left worth reading
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
    if (reply.usage) {
      turn.usage = reply.usage;
      const verdict = this.verdictFor(reply.usage);
      if (verdict) turn.cacheVerdict = verdict;
    }
    return turn;
  }
}

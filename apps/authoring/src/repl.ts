/**
 * The interactive `vnauthor` REPL (plan §9). It owns the terminal: one readline channel is
 * shared by the prompt and by every permission question, so user input is always
 * sequential — the agent loop awaits a plan approval or confirmation before the next line
 * is read. Agent events stream as they happen via the `onEvent` sink; the final message is
 * printed as the assistant's reply.
 */
import { createInterface, type Interface } from 'node:readline';
import { discoverSkills, formatIndex, skillRoots, type Permission, type Plan } from '@vn/authoring';
import { createAuthoringAgent, type AuthoringSession } from './agent.js';
import { bold, cyan, dim, renderEvent, renderPlan, green, yellow } from './render.js';

/**
 * A line-oriented terminal abstraction (so tests can swap in a scripted channel).
 * `ask` resolves to `null` when input is exhausted (EOF / closed stream).
 */
export interface Channel {
  ask(question: string): Promise<string | null>;
  write(text: string): void;
  close(): void;
}

/**
 * A {@link Channel} over the real stdin/stdout via node:readline. Lines are queued so none
 * are dropped between prompts — `rl.question` silently discards `line` events emitted while
 * no question is pending, which loses buffered/piped input. `ask` resolves `null` at EOF.
 */
export function terminalChannel(): Channel {
  const rl: Interface = createInterface({ input: process.stdin, output: process.stdout });
  const pending: string[] = [];
  const waiters: ((value: string | null) => void)[] = [];
  let closed = false;

  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else pending.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()!(null);
  });

  return {
    ask: (question) => {
      process.stdout.write(question);
      if (pending.length) return Promise.resolve(pending.shift()!);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
    write: (text) => void process.stdout.write(text.endsWith('\n') ? text : text + '\n'),
    close: () => {
      if (!closed) rl.close();
    },
  };
}

const isYes = (s: string): boolean => /^y(es)?$/i.test(s.trim());

/** A {@link Permission} backed by terminal prompts (the plan-approval / confirm gates). */
export function terminalPermission(channel: Channel): Permission {
  return {
    async approvePlan(plan: Plan) {
      channel.write('');
      channel.write(renderPlan(plan));
      const answer = await channel.ask(
        bold('Approve this plan and switch to execute mode? [y/N] '),
      );
      if (isYes(answer ?? '')) return { approved: true };
      const feedback = await channel.ask(dim('Optional feedback for the agent (enter to skip): '));
      return { approved: false, feedback: (feedback ?? '').trim() || undefined };
    },
    async confirmAction(tool, args) {
      const detail = describeArgs(args);
      const answer = await channel.ask(
        yellow(`Confirm ${bold(tool)}${detail ? ` ${detail}` : ''}? [y/N] `),
      );
      return isYes(answer ?? '');
    },
    async ask(question) {
      return ((await channel.ask(cyan(`${question} `))) ?? '').trim();
    },
  };
}

function describeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const parts = Object.entries(args as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return parts.length ? `(${parts.join(', ')})` : '';
}

const HELP = [
  'Commands:',
  '  /help            show this help',
  '  /mode            show the current mode (plan or execute)',
  '  /status          list characters, locations, and scenes',
  '  /skills          list available authoring skills',
  '  /exit, /quit     leave vnauthor',
  '',
  'Otherwise, just type what you want to do. The agent plans first (read-only); it asks',
  'before it edits or commits.',
].join('\n');

/** Options for {@link runRepl}. */
export interface ReplOptions {
  dir: string;
  mock?: boolean;
  /** Use provider-native function-calling (Path B) when the model supports it. */
  native?: boolean;
  secretsDir?: string;
  /** Inject a channel (tests); defaults to the real terminal. */
  channel?: Channel;
}

/** Run the REPL until the user exits or stdin closes. Returns a process exit code. */
export async function runRepl(opts: ReplOptions): Promise<number> {
  const channel = opts.channel ?? terminalChannel();
  const permission = terminalPermission(channel);

  let session: AuthoringSession;
  try {
    session = await createAuthoringAgent(opts.dir, permission, {
      mock: opts.mock,
      native: opts.native,
      secretsDir: opts.secretsDir,
      onEvent: (event) => {
        const line = renderEvent(event);
        if (line !== undefined) channel.write(line);
      },
    });
  } catch (err) {
    channel.write(`Failed to open workspace: ${err instanceof Error ? err.message : String(err)}`);
    channel.close();
    return 1;
  }

  channel.write(bold('vnauthor') + dim(` — authoring agent for ${opts.dir}`));
  channel.write(dim('Type /help for commands, /exit to quit. You start in plan mode.\n'));

  try {
    for (;;) {
      const tag = session.agent.currentMode === 'execute' ? green('execute') : cyan('plan');
      const raw = await channel.ask(`${tag} ${bold('›')} `);
      if (raw === null) break; // EOF / closed stdin
      const line = raw.trim();
      if (!line) continue;

      if (line === '/exit' || line === '/quit') break;
      if (line === '/help') {
        channel.write(HELP);
        continue;
      }
      if (line === '/mode') {
        channel.write(dim(`mode: ${session.agent.currentMode}`));
        continue;
      }
      if (line === '/status') {
        await printStatus(session, channel);
        continue;
      }
      if (line === '/skills') {
        await printSkills(session, channel);
        continue;
      }
      if (line.startsWith('/')) {
        channel.write(yellow(`unknown command "${line}". Try /help.`));
        continue;
      }

      const result = await session.agent.run(line);
      channel.write('');
      channel.write(result.final);
      channel.write('');
    }
  } finally {
    channel.close();
  }
  return 0;
}

async function printStatus(session: AuthoringSession, channel: Channel): Promise<void> {
  try {
    const index = await session.ctx.workspace.index();
    channel.write(formatIndex(index));
  } catch (err) {
    channel.write(yellow(`could not load workspace: ${err instanceof Error ? err.message : err}`));
  }
}

async function printSkills(session: AuthoringSession, channel: Channel): Promise<void> {
  const skills = await discoverSkills(
    skillRoots(session.ctx.workspace.root, session.ctx.skillDirs),
  );
  if (skills.length === 0) {
    channel.write(dim('No skills found under .aiagent/skills.'));
    return;
  }
  for (const s of skills) {
    const kind = s.script ? yellow('script') : dim('guide');
    channel.write(`${bold(s.id)} [${kind}] — ${s.description}`);
    if (s.whenToUse) channel.write(dim(`    when: ${s.whenToUse}`));
  }
}

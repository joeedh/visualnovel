/**
 * The interactive `vnauthor` REPL (plan §9). It owns the terminal: one readline channel is
 * shared by the prompt and by every permission question, so user input is always
 * sequential — the agent loop awaits a plan approval or confirmation before the next line
 * is read. Agent events stream as they happen via the `onEvent` sink; the final message is
 * printed as the assistant's reply.
 */
import { relative } from 'node:path';
import { createInterface, emitKeypressEvents, type Interface } from 'node:readline';
import {
  archiveUpload,
  describeUpload,
  discoverSkills,
  formatIndex,
  formatSubject,
  loadContext,
  skillRoots,
  systemSections,
  uploadSuggestions,
  type AskQuestion,
  type Permission,
  type Plan,
} from '@vn/authoring';
import {
  buildAgentBackend,
  createAuthoringAgent,
  effortChoicesFor,
  effortLabel,
  resolveEffort,
  supportsEffort,
  DEFAULT_EFFORT,
  EFFORT_CHOICES,
  TEXT_MODELS,
  BUDGET_CHOICES,
  budgetLabel,
  type AuthoringSession,
  type BudgetChoice,
  type EffortChoice,
} from './agent.js';
import { bold, cyan, dim, renderEvent, renderPlan, renderTokens, green, yellow } from './render.js';

/**
 * A line-oriented terminal abstraction (so tests can swap in a scripted channel).
 * `ask` resolves to `null` when input is exhausted (EOF / closed stream).
 */
export interface Channel {
  ask(question: string): Promise<string | null>;
  write(text: string): void;
  close(): void;
  /**
   * Register a handler for the Shift-Tab key (terminal only; absent in scripted channels).
   * Used to cycle plan/execute mode without typing a command.
   */
  onShiftTab?(handler: () => void): void;
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
    onShiftTab: (handler) => {
      emitKeypressEvents(process.stdin, rl);
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.on('keypress', (_str, key?: { name?: string; shift?: boolean }) => {
        if (key?.name === 'tab' && key.shift) handler();
      });
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
    // A form is put one question at a time here, and there is no going back: a terminal has no
    // Back button, and the line above the cursor has already scrolled. The desktop pane is where
    // a form is a form; this stays the degraded-but-never-wrong reading of the same request.
    async ask(form) {
      const answers: string[] = [];
      for (const [i, item] of form.entries()) {
        if (form.length > 1) channel.write(dim(`Question ${i + 1} of ${form.length}`));
        answers.push(await askOne(channel, item));
      }
      return answers;
    },
  };
}

/** One question of a form, put to the terminal. Free text where there is no shortlist. */
async function askOne(channel: Channel, item: AskQuestion): Promise<string> {
  const options = item.choices ?? [];
  if (!options.length) return ((await channel.ask(cyan(`${item.question} `))) ?? '').trim();
  channel.write(cyan(item.question));
  options.forEach((opt, i) => channel.write(`  ${i + 1}. ${opt}`));
  const how = item.multi ? 'numbers, comma-separated' : 'a number';
  const raw = ((await channel.ask(cyan(`Pick ${how}, or just answer: `))) ?? '').trim();
  return pickedOr(raw, item);
}

/**
 * Turn `2` — or `1,3` for a multi-pick — into the options it names. Anything that is not a run of
 * valid numbers is the author's own words and comes back untouched, which is what makes "type
 * your own" and "let's talk about it" need no affordance of their own in a terminal.
 */
function pickedOr(raw: string, item: AskQuestion): string {
  const options = item.choices ?? [];
  if (!raw) return raw;
  const parts = raw.split(',').map((p) => p.trim());
  if (!item.multi && parts.length > 1) return raw;
  const picked = parts.map((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : undefined;
  });
  return picked.every((p) => p !== undefined) ? picked.join(', ') : raw;
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
  '  /model [id]      show/switch the text model (no arg → interactive menu)',
  '  /effort [level]  show/set reasoning effort (no arg → interactive menu)',
  '  /budget [size]   show/set what one turn may spend (no arg → interactive menu)',
  '  /clear           clear the conversation context (back to plan mode)',
  '  /status          list characters, locations, and scenes',
  '  /skills          list available authoring skills',
  '  /makeimage <what>  draw a concept image of it (costs one generation)',
  '  /upload <file...>  archive documents, then ask what to do with them',
  '  /exit, /quit     leave vnauthor',
  '',
  'Shift-Tab cycles between plan and execute mode.',
  '',
  'Otherwise, just type what you want to do. The agent plans first (read-only); it asks',
  'before it edits or commits.',
].join('\n');

/**
 * Print a numbered menu and read a 1-based choice. Returns the chosen option, or null if
 * the user entered nothing (cancel) or an out-of-range value.
 */
async function chooseFromMenu(
  channel: Channel,
  title: string,
  options: readonly string[],
  current: string,
): Promise<string | null> {
  channel.write(bold(title));
  options.forEach((opt, i) => {
    channel.write(`  ${i + 1}. ${opt}${opt === current ? green(' (current)') : ''}`);
  });
  const raw = (await channel.ask(cyan('Choose a number (enter to cancel): ')))?.trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > options.length) {
    channel.write(yellow('Invalid choice.'));
    return null;
  }
  return options[n - 1] ?? null;
}

/** Options for {@link runRepl}. */
export interface ReplOptions {
  dir: string;
  mock?: boolean;
  /** Force the text tool protocol (Path A) even where the model can call tools natively. */
  noNative?: boolean;
  /** What one turn may spend, in non-cached tokens. Defaults to the agent's own default (200k). */
  budget?: BudgetChoice;
  /** Inject a channel (tests); defaults to the real terminal. */
  channel?: Channel;
}

/** Run the REPL until the user exits or stdin closes. Returns a process exit code. */
export async function runRepl(opts: ReplOptions): Promise<number> {
  const channel = opts.channel ?? terminalChannel();
  const permission = terminalPermission(channel);

  // What the session has cost so far. Accumulated here rather than asked of the agent, because a
  // `usage` event is the only place the number exists — nothing stores it.
  const spent = { input: 0, output: 0 };

  let session: AuthoringSession;
  try {
    session = await createAuthoringAgent(opts.dir, permission, {
      mock: opts.mock,
      noNative: opts.noNative,
      ...(opts.budget ? { budget: opts.budget } : {}),
      onEvent: (event) => {
        if (event.type === 'usage') {
          spent.input += event.input;
          spent.output += event.output;
        }
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
  channel.write(
    dim('Type /help for commands, /exit to quit. Shift-Tab cycles plan/execute mode.\n'),
  );

  // Shift-Tab cycles plan ⇆ execute mode (terminal only — scripted channels have no hook).
  channel.onShiftTab?.(() => {
    const next = session.agent.currentMode === 'plan' ? 'execute' : 'plan';
    session.agent.setMode(next);
    channel.write(dim(`-- ${next} mode (shift-tab) --`));
  });

  // Live model/effort settings; `/model` and `/effort` rebuild the backend and swap it in.
  let currentModel = session.model;
  let currentEffort: EffortChoice = DEFAULT_EFFORT;

  /** Rebuild the backend with the current model+effort and hot-swap it into the agent. */
  async function applySettings(model: string, effort: EffortChoice): Promise<boolean> {
    try {
      const backend = await buildAgentBackend(opts.dir, { noNative: opts.noNative, model, effort });
      session.agent.setBackend(backend);
      currentModel = model;
      currentEffort = effort;
      return true;
    } catch (err) {
      channel.write(
        yellow(`Could not apply settings: ${err instanceof Error ? err.message : err}`),
      );
      return false;
    }
  }

  async function handleModel(arg: string): Promise<void> {
    if (opts.mock) {
      channel.write(yellow('Running with --mock — no model is in use, so /model has no effect.'));
      return;
    }
    let target = arg;
    if (!target) {
      const picked = await chooseFromMenu(
        channel,
        'Select a text model',
        TEXT_MODELS,
        currentModel,
      );
      if (!picked) return void channel.write(dim('No change.'));
      target = picked;
    }
    if (target === currentModel) return void channel.write(dim(`Already using ${target}.`));
    // Step the bound effort down to what the new model takes rather than sending one it refuses.
    const was = currentEffort;
    const stepped = resolveEffort(target, was) ?? was;
    if (await applySettings(target, stepped)) {
      channel.write(green(`Model set to ${target}.`));
      if (!supportsEffort(target)) {
        channel.write(yellow(`Note: ${target} ignores effort; it has no extended-thinking knob.`));
      } else if (stepped !== was) {
        const note = `${target} has no ${effortLabel(was)} — using ${effortLabel(stepped)}.`;
        channel.write(yellow(`Note: ${note}`));
      }
    }
  }

  async function handleEffort(arg: string): Promise<void> {
    if (opts.mock) {
      channel.write(yellow('Running with --mock — no model is in use, so /effort has no effect.'));
      return;
    }
    // Only what this model takes. An unsupported one still gets the menu — the setting is kept
    // across a model switch — so fall back to the full list rather than offering nothing.
    const offered = effortChoicesFor(currentModel);
    const menu = offered.length > 0 ? offered : EFFORT_CHOICES;
    let choice = arg;
    if (!choice) {
      const picked = await chooseFromMenu(
        channel,
        'Select reasoning effort',
        menu.map(effortLabel),
        effortLabel(currentEffort),
      );
      if (!picked) return void channel.write(dim('No change.'));
      choice = picked === 'no thinking' ? 'none' : picked;
    }
    if (!menu.includes(choice as EffortChoice)) {
      const options = menu.map(effortLabel).join(', ');
      return void channel.write(yellow(`Unknown effort "${choice}". Options: ${options}.`));
    }
    const effort = choice as EffortChoice;
    if (await applySettings(currentModel, effort)) {
      channel.write(green(`Effort set to ${effortLabel(effort)}.`));
      if (!supportsEffort(currentModel)) {
        channel.write(yellow(`Note: ${currentModel} ignores effort (Claude Opus 4.5+ only).`));
      }
    }
  }

  /**
   * The turn ceiling. Unlike /model and /effort this rebuilds nothing — the budget is the loop's
   * own meter, not something the backend was constructed with — so it works under --mock too.
   */
  async function handleBudget(arg: string): Promise<void> {
    let choice = arg;
    if (!choice) {
      const picked = await chooseFromMenu(
        channel,
        'Select what one turn may spend',
        BUDGET_CHOICES.map(budgetLabel),
        budgetLabel(session.agent.currentBudget),
      );
      if (!picked) return void channel.write(dim('No change.'));
      choice = picked;
    }
    if (!BUDGET_CHOICES.includes(choice as BudgetChoice)) {
      const options = BUDGET_CHOICES.join(', ');
      return void channel.write(yellow(`Unknown budget "${choice}". Options: ${options}.`));
    }
    session.agent.setBudget(choice as BudgetChoice);
    channel.write(green(`Turn budget set to ${choice} non-cached tokens.`));
  }

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
      if (line === '/clear') {
        session.agent.clear();
        channel.write(dim('Context cleared. Back in plan mode.'));
        continue;
      }
      if (line === '/model' || line.startsWith('/model ')) {
        await handleModel(line.slice('/model'.length).trim());
        continue;
      }
      if (line === '/effort' || line.startsWith('/effort ')) {
        await handleEffort(line.slice('/effort'.length).trim());
        continue;
      }
      if (line === '/budget' || line.startsWith('/budget ')) {
        await handleBudget(line.slice('/budget'.length).trim());
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
      if (line === '/makeimage' || line.startsWith('/makeimage ')) {
        await makeImage(session, channel, line.slice('/makeimage'.length).trim());
        continue;
      }
      if (line === '/upload' || line.startsWith('/upload ')) {
        await upload(session, channel, line.slice('/upload'.length).trim());
        continue;
      }
      if (line.startsWith('/')) {
        channel.write(yellow(`unknown command "${line}". Try /help.`));
        continue;
      }

      // The project map inside the system message is a snapshot of a file the agent's own
      // `update_context` rewrites, so it is re-read per turn rather than frozen at startup —
      // section by section, so a rewrite supersedes itself in a message rather than editing the
      // prompt every cached byte behind it depends on.
      session.agent.refreshSystem(systemSections(await loadContext(opts.dir)));
      const result = await session.agent.run(line);
      channel.write('');
      channel.write(result.final);
      const tokens = renderTokens(spent.input, spent.output);
      if (tokens !== undefined) channel.write(tokens);
      channel.write('');
    }
  } finally {
    channel.close();
  }
  return 0;
}

/**
 * `/makeimage <sentence>` — draw a concept image, directly.
 *
 * Not a turn through the model: a one-line request should cost one generation and no tokens. It
 * obeys plan mode like every other mutating act, and there it still composes and prints the prompt,
 * which is the part worth reading before spending anything.
 */
async function makeImage(
  session: AuthoringSession,
  channel: Channel,
  sentence: string,
): Promise<void> {
  if (!sentence) {
    channel.write(yellow('Usage: /makeimage <what to draw>'));
    return;
  }
  const art = session.ctx.art;
  if (!art) {
    channel.write(yellow('Image generation is not wired up in this session.'));
    return;
  }
  const planning = session.agent.currentMode !== 'execute';
  try {
    const preview = await art.preview({ sentence });
    channel.write(dim(`subject: ${preview.subject ? formatSubject(preview.subject) : 'none'}`));
    channel.write(dim(`prompt: ${preview.prompt}`));
    if (planning) {
      channel.write(yellow('Plan mode — nothing generated. Shift-Tab to execute, then re-run.'));
      return;
    }
    const result = await art.generate({ sentence });
    channel.write(green(`wrote ${relative(session.ctx.workspace.root, result.file)}`));
    channel.write(dim(`  ${result.ref.hash}.${result.ref.ext}`));
  } catch (err) {
    channel.write(yellow(`could not draw it: ${err instanceof Error ? err.message : err}`));
  }
}

/**
 * `/upload <file...>` — copy the author's own documents into `archive/`, then ask about them.
 *
 * The same `archiveUpload` the desktop's `upload.pick` runs, so a file uploaded from either place
 * lands in the same layout. It is not a turn: the model is told nothing here, and what it is told
 * next is whichever suggestion the author picks. Plan mode afterwards for that reason — the answer
 * to "what should I do with these" is a plan, not an edit.
 */
async function upload(session: AuthoringSession, channel: Channel, rest: string): Promise<void> {
  const paths = splitPaths(rest);
  if (paths.length === 0) {
    channel.write(yellow('Usage: /upload <file> [file...]   (quote paths containing spaces)'));
    return;
  }
  let batch;
  try {
    batch = await archiveUpload(session.ctx.workspace, paths);
  } catch (err) {
    channel.write(yellow(`could not upload: ${err instanceof Error ? err.message : err}`));
    return;
  }
  channel.write('');
  channel.write(describeUpload(batch));
  if (batch.files.length === 0) return;

  const suggestions = uploadSuggestions(batch);
  channel.write('');
  channel.write(dim('What next? For example:'));
  suggestions.forEach((s, i) => channel.write(`  ${i + 1}. ${s}`));
  channel.write('');
  session.agent.setMode('plan');
}

/** Split a command line into paths, honouring quotes so a Windows path with spaces survives. */
function splitPaths(rest: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of rest.matchAll(pattern)) {
    const path = m[1] ?? m[2] ?? m[3] ?? '';
    if (path !== '') out.push(path);
  }
  return out;
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

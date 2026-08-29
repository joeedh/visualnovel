/**
 * Reporting a conversation that went wrong.
 *
 * `mutating: false` and deliberately so: the analysis reads a saved transcript and the act log,
 * borrows the bound model for one call, and writes nothing into the project. Nothing here rebinds
 * the agent either — an author who switches to Opus to read a bad conversation has not changed
 * what their next turn runs on.
 */
import { defineFor, prop, type CheckResult } from '@vn/commands';
import { BUSY_REPORT } from '../../shared/ipc.js';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

/** A session preview read as a precondition: the session's own sentence either way. */
function verdict(result: { ok: boolean; message: string }): CheckResult {
  return result.ok ? { ok: true, note: result.message } : { ok: false, reason: result.message };
}

export const reportAgent = define({
  id: 'report.agent',
  title: 'Report a difficult agent',
  description:
    'Analyse a conversation that went wrong and draft a bug report. The analysis runs on your ' +
    'own machine with your own model key — the conversation is never sent to us. Names from ' +
    'your story are replaced before the model sees them, and you review the report before ' +
    'anything is posted.',
  notes:
    "Have a conversation that went wrong read by a debug agent and draft a bug report from it, in one answer. This is the headless path, kept for scripts, CDP and the API-fault seam; what Help ▸ Report a Difficult Agent… opens is the conversation (`report.open`). Non-mutating on purpose: it reads a saved transcript and the act log, borrows the bound model for one call, and writes nothing into the project — nor does it rebind the agent, so reading a bad conversation with Opus does not change what the next turn runs on. Checked because it spends a minute of a real model's time on a real key; refused outright under `--mock`. Names from the fiction are replaced before the model sees them.",
  mutating: false,
  props: {
    thread: prop.string('the conversation to analyse; empty means the most recent one', {
      default: '',
    }),
    note: prop.string('what you had wanted the agent to do', { default: '', multiline: true }),
    source: prop.boolean('let the debug agent read the source code (uses more tokens)', {
      default: false,
      hint:
        "The debug agent reads this app's own code and design docs, so it can point at the rule " +
        'that was broken instead of guessing from the conversation. Slower, and it spends more ' +
        'of your tokens.',
    }),
    detail: prop.boolean('let it read the requests this app sent to the model API', {
      default: false,
      hint:
        'When the API rejected a request by position — "messages.1.content.0" — only the request ' +
        'itself says what was at that position, so the debug agent reads the ones this session ' +
        'sent. They stay on this machine: they are read on your own key and none of what it ' +
        'finds there goes into the report.',
    }),
    // Both are `prop.string`, not `prop.oneOf`: an enum's values are baked into the catalog at
    // module load, and this menu's rows depend on the model chosen in the same form.
    model: prop.string('the model that reads the conversation; empty means the bound one', {
      default: '',
    }),
    effort: prop.string('how hard it thinks about it; empty means the bound setting, raised', {
      default: '',
    }),
  },
  async check(props, ctx) {
    return verdict(await ctx.host.session.previewReport(props));
  },
  async run(props, ctx) {
    const draft = await ctx.host.session.reportAgent(props);
    const read = draft.report.readSource ? ' It read the source.' : '';
    return { message: `${draft.report.analysis.summary}${read}`, data: { ...draft } };
  },
});

export const reportOpen = define({
  id: 'report.open',
  title: 'Talk to the debug agent about a conversation',
  description:
    'Start a conversation with the debug agent about a conversation that went wrong. It runs on ' +
    'your own machine with your own model key, names from your story are replaced before the ' +
    'model sees them, and you can keep talking to it until the report says what happened.',
  notes:
    "Start a conversation with the debug agent instead of taking one answer from it. Takes `report.agent`'s field set verbatim, because a field one path did not accept would be a second way to ask for an analysis, and refuses through the same `previewReport`, so the setup card's Start button and the headless form say the same sentences. Ends by pushing the Debug Agent pane — a focus in practice, since the card that started it is the pane, and an opening when CDP or the palette reaches it with none up.",
  mutating: false,
  // The same field set `report.agent` takes, because the two paths resolve the same request and a
  // field one of them did not accept would be a second way to ask for an analysis.
  props: reportAgent.props,
  async check(props, ctx) {
    return verdict(await ctx.host.session.previewReport(props));
  },
  async run(props, ctx) {
    const state = await ctx.host.session.openReport(props);
    // A focus rather than an opening in practice: the setup card that started this is already the
    // pane. The push is still made, since CDP and the palette can reach this with no pane open.
    ctx.host.ui({ type: 'view', action: 'open', editor: 'report', where: 'popup' }, ctx.origin);
    return { message: `Reading “${state.thread?.title ?? 'the conversation'}”.`, data: state };
  },
});

export const reportSay = define({
  id: 'report.say',
  title: 'Say something to the debug agent',
  description: 'Send one more message to the open debug conversation and run its turn.',
  notes:
    'One more message to the open debug conversation, and its turn. Refused while the analyst is answering ("The debug agent is still on the last turn."), with nothing open, and with nothing to say — the composer\'s send button shows whichever applies.',
  mutating: false,
  props: {
    text: prop.string('what to say to the debug agent', { default: '', multiline: true }),
  },
  check(props, ctx) {
    const state = ctx.host.session.reportState();
    if (!state.thread)
      return Promise.resolve({
        ok: false,
        reason: 'No debug conversation is open — start one from Help ▸ Report a Difficult Agent….',
      });
    if (state.busy)
      return Promise.resolve({ ok: false, reason: 'The debug agent is still on the last turn.' });
    if (!props.text.trim())
      return Promise.resolve({ ok: false, reason: 'There is nothing to say.' });
    return Promise.resolve({ ok: true, note: `Asks about “${state.thread.title}”.` });
  },
  async run(props, ctx) {
    const state = await ctx.host.session.sayToReport(props.text);
    const filed = state.rows.filter((row) => row.kind === 'filed').length;
    return {
      message:
        filed > 0 ? 'The debug agent answered and filed a report.' : 'The debug agent answered.',
      data: state,
    };
  },
});

export const reportStop = define({
  id: 'report.stop',
  title: 'Stop the debug agent',
  description: 'End the turn the debug agent is on after the step it is on. What it said is kept.',
  notes:
    'End the turn the debug agent is on after the step it is on; what it said is kept. Cooperative: the flag is read at the top of each step and no backend streams, so it lands when the request in flight returns. The one command accepted mid-turn. Refuses with "The debug agent is idle."',
  mutating: false,
  props: {},
  check(_props, ctx) {
    if (!ctx.host.session.running(BUSY_REPORT))
      return Promise.resolve({ ok: false, reason: 'The debug agent is idle.' });
    return Promise.resolve({ ok: true, note: 'The turn ends after the step it is on.' });
  },
  run(_props, ctx) {
    const asked = ctx.host.session.stopReport();
    return Promise.resolve({
      message: asked ? 'Stopping after the step in progress.' : 'The debug agent is idle.',
    });
  },
});

export const reportGrant = define({
  id: 'report.grant',
  title: 'Let the debug agent read more',
  description:
    'Give the open debug conversation the source code or the requests this app sent. The debug ' +
    'agent is told about them with your next message, so a grant made while it is answering ' +
    'lands on the turn after that.',
  notes:
    'Open one of the two reading doors on a conversation already under way. One tick is one grant and there is no field that turns a box back off, because tools already used cannot be un-remembered from the transcript. The tool catalog is built once per turn, so a grant lands on the next message; the check is `previewGrant`, which refuses each door by name when there is nothing behind it.',
  mutating: false,
  props: {
    // `prop.oneOf` rather than two booleans: one tick is one grant, and a form that could turn a
    // box back off would promise something the conversation cannot deliver.
    access: prop.oneOf(['source', 'detail'] as const, 'what to let it read', {
      default: 'source',
    }),
  },
  async check(props, ctx) {
    return verdict(await ctx.host.session.previewGrant(props.access));
  },
  async run(props, ctx) {
    const state = await ctx.host.session.grantReport(props.access);
    return {
      message:
        props.access === 'source'
          ? 'The debug agent can read the source from your next message.'
          : 'The debug agent can read this session’s requests from your next message.',
      data: state,
    };
  },
});

export const reportState = define({
  id: 'report.state',
  title: 'Read the debug conversation',
  description:
    'Return the debug conversation so far, so a pane opened part way through shows what it ' +
    'missed. Reads nothing and spends nothing.',
  notes:
    'The debug conversation so far, so a pane opened part way through shows what it missed. Reads nothing and spends nothing; the pane reduces these rows through the same reducer it reduces live `report:event`s with.',
  mutating: false,
  props: {},
  run(_props, ctx) {
    const state = ctx.host.session.reportState();
    const rows = state.rows.length;
    return Promise.resolve({
      message: state.thread
        ? `${rows} row${rows === 1 ? '' : 's'} about “${state.thread.title}”.`
        : 'No debug conversation is open.',
      data: state,
    });
  },
});

export const reportOpenIssue = define({
  id: 'report.openIssue',
  title: 'Open a GitHub issue on this report',
  description:
    'Copy the report to your clipboard and open a new issue in your browser, for you to paste it ' +
    'into. Nothing is posted until you press Create there.',
  notes:
    "Put the report on the clipboard and open GitHub's new-issue form for the author to paste it into. Checked, and the check is a **leak scan**: a name the redactor still recognises in the body is refused by name rather than silently rewritten. The repo is fixed at build time and the composed URL is asserted before the OS sees it. Nothing is posted — the author presses Create.",
  mutating: false,
  props: {
    title: prop.string('the issue title'),
    // `digest: true` is about the record, not the form: a report is thousands of words of
    // someone's conversation, and `commands.jsonl` is committed. The report preview dialog is
    // where the body is edited.
    body: prop.string('the report, as it will be filed', { digest: true }),
  },
  async check(props, ctx) {
    return verdict(await ctx.host.session.previewIssue(props));
  },
  async run(props, ctx) {
    await ctx.host.session.openIssue(props);
    return {
      message: 'Copied the report to your clipboard and opened a new issue in your browser.',
    };
  },
});

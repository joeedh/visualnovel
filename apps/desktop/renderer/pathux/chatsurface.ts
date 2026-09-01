/**
 * The parts a chat pane is built from: the stylesheet, the transcript rows, the dialogue box, the
 * composer and the question card. Two panes draw a conversation — vnauthor's and the debug
 * agent's — and a second copy of the composer would be the one nobody looks at.
 *
 * Nothing here knows which conversation it is drawing. A pane supplies the wording and the
 * callbacks; the store the answers go back to is the pane's own.
 */
import STUDIO_CSS from '../styles/studio.css?inline';
import {
  answersOf,
  answersOnPick,
  blankPages,
  goTo,
  isFirst,
  isLast,
  isPicked,
  pageLabel,
  pageOf,
  pick,
  type,
  type AskForm,
} from '../rules/askform.js';
import {
  completeSlash,
  expandSlash,
  matchSkills,
  moveHighlight,
  slashQuery,
} from '../rules/slash.js';
import type { CompactionMark, FeedItem } from '../../src/shared/convo.js';
import type { AskRequest, SkillEntry } from '../../src/shared/ipc.js';

/**
 * The frame around `studio.css`, which is imported as-is: the transcript, the dialogue box and the
 * plan card are the React shell's, down to the sodium glow. This supplies the reset that does not
 * cross the shadow boundary, and `.convo` filling the surface instead of a grid column of
 * `.studio`.
 */
const SURFACE_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
.convo.cv-surface {
  height: 100%;
  background: var(--ink);
  color: var(--paper);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.5;
}
.cv-surface button { font-family: inherit; color: inherit; cursor: pointer; }
.cv-surface .composer .send:disabled { opacity: 0.45; cursor: default; }

/* Stop takes Send's shape and stands where the eye is already going, but only while a turn is in
   flight — an idle composer has nothing to interrupt, and a permanently greyed square would say
   otherwise. Vermilion, the one colour this shell spends on stopping things. */
.cv-surface .composer .stop {
  width: 40px;
  height: 40px;
  border-radius: var(--r-soft);
  border: 1px solid var(--ink-line);
  background: var(--ink-raised);
  place-items: center;
  color: var(--vermilion);
  font-size: 13px;
}
.cv-surface .composer .stop:hover {
  border-color: var(--vermilion);
}

/* A plan is the machine proposing, so it is signal. A question and a confirmation are the
   author's own turn to take — sodium, the same warm the header uses for the human side. */
.cv-surface .plan.ask,
.cv-surface .plan.confirm {
  border-color: rgba(244, 162, 76, 0.4);
  background: linear-gradient(180deg, rgba(244, 162, 76, 0.07), rgba(244, 162, 76, 0.015));
}
.cv-surface .plan.ask .plan-head,
.cv-surface .plan.confirm .plan-head {
  color: var(--sodium);
}
.cv-surface .ask-input {
  width: 100%;
  margin-bottom: 12px;
  background: var(--ink-sunken);
  border: 1px solid var(--ink-line);
  border-radius: var(--r-soft);
  padding: 10px 13px;
  color: var(--paper);
  font: inherit;
  font-size: 13.5px;
}
.cv-surface .ask-input:focus {
  outline: none;
  border-color: var(--sodium);
}

/* Openers offered by whatever started this conversation. Between the dialogue box and the
   composer, because that is the gap the eye crosses on the way to typing — and they *fill* the
   composer, so they read as drafts rather than as buttons that do something. */
.cv-surface .chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.cv-surface .chips button {
  border: 1px solid var(--ink-line);
  border-radius: 999px;
  background: var(--ink-raised);
  color: var(--mist);
  font-size: 12.5px;
  padding: 6px 13px;
  text-align: left;
}
.cv-surface .chips button:hover {
  color: var(--paper);
  border-color: var(--sodium);
}

/* The shortlist on an ask card. Full-width rows rather than chips: these are answers, and an
   answer is read before it is clicked, so it gets a line of its own. */
.cv-surface .ask-choices {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}
.cv-surface .ask-choices button {
  border: 1px solid var(--ink-line);
  border-radius: var(--r-soft);
  background: var(--ink-sunken);
  color: var(--paper);
  font-size: 13.5px;
  padding: 9px 13px;
  text-align: left;
}
.cv-surface .ask-choices button:hover {
  border-color: var(--sodium);
}
.cv-surface .ask-choices button.picked {
  border-color: var(--sodium);
  background: rgba(244, 162, 76, 0.12);
}

/* Where the author is in a form of several. It sits in the card's own head rather than above the
   question, so the question itself is still the first thing read. */
.cv-surface .plan.ask .plan-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.cv-surface .ask-page {
  color: var(--mist-dim);
  letter-spacing: 0.08em;
}
/* Paging goes left, away from the button that ends the form: a mis-aimed click should not
   submit a form the author was only stepping through. */
.cv-surface .ask-nav {
  display: flex;
  gap: 9px;
  margin-right: auto;
}
.cv-surface .ask-nav button:disabled {
  opacity: 0.45;
  cursor: default;
}

/* The skill menu a slash opens, over the transcript rather than under the composer: the composer
   is already at the bottom of the pane, so a list below it would be off screen. */
.cv-surface .composer { position: relative; }
.cv-surface .slash {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 5;
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--ink-line);
  border-radius: var(--r-soft);
  background: var(--ink-raised);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
}
.cv-surface .slash button {
  display: block;
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--ink-line);
  background: none;
  padding: 8px 13px;
  text-align: left;
}
.cv-surface .slash button:last-child { border-bottom: 0; }
.cv-surface .slash button.at { background: rgba(244, 162, 76, 0.12); }
.cv-surface .slash .sk-id {
  color: var(--sodium);
  font-size: 13px;
}
.cv-surface .slash .sk-what {
  display: block;
  color: var(--mist-dim);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Where the agent's memory of the conversation was replaced by a summary. A rule rather than a
   turn: nobody said it, and the turns above it are still there to read. */
.cv-surface .compaction {
  margin: 16px 0;
}
.cv-surface .compaction .rule {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: var(--mist-dim);
  font-size: 11px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}
.cv-surface .compaction .rule::before,
.cv-surface .compaction .rule::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--ink-line);
}
.cv-surface .compaction .rule:hover {
  color: var(--mist);
}
.cv-surface .compaction .summary {
  margin-top: 9px;
  padding: 10px 13px;
  border: 1px solid var(--ink-line);
  border-radius: var(--r-soft);
  background: var(--ink-sunken);
  color: var(--mist);
  font-size: 13px;
  white-space: pre-wrap;
}
`;

/** What a chat pane adopts. `studio.css` first, so the frame around it wins. */
export const CHAT_CSS = STUDIO_CSS + SURFACE_CSS;

export function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A token count at a glance: `842`, `12.3k`, `1.4M`. The exact figures are in the tooltip. */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** One row of the transcript: the author's own turn, or a line the agent said or was refused. */
export function turnRow(item: FeedItem): HTMLElement {
  if (item.role === 'user') {
    const turn = el('div', 'turn-user');
    turn.appendChild(el('div', 'who', 'AUTHOR'));
    turn.appendChild(el('div', 'bubble', item.text));
    return turn;
  }
  // A tool call and a refusal use the same shape with the verb coloured differently, so a
  // blocked call reads as the same act stopped
  const action = el('div', item.role === 'blocked' ? 'action blocked' : 'action');
  action.appendChild(el('span', item.role === 'agent' ? '' : 'verb', item.text));
  return action;
}

/**
 * Where a compaction happened, drawn between the turns it covers and the ones after it. Clicking
 * the rule opens the summary the agent is carrying in place of everything above.
 */
export function compactionRule(mark: CompactionMark): HTMLElement {
  const row = el('div', 'compaction');
  const rule = document.createElement('button');
  rule.className = 'rule';
  rule.textContent = `compacted ${mark.covers} messages`;
  rule.title =
    `Compacted ${mark.covers} messages — the agent sees a summary in place of everything above ` +
    'this line. Click to read the summary. Nothing was deleted.';
  rule.setAttribute('aria-expanded', 'false');
  const summary = el('div', 'summary', mark.full ?? mark.text);
  summary.style.display = 'none';
  rule.addEventListener('click', () => {
    const open = summary.style.display === 'none';
    summary.style.display = open ? 'block' : 'none';
    rule.setAttribute('aria-expanded', String(open));
  });
  row.appendChild(rule);
  row.appendChild(summary);
  return row;
}

/** The wording and the callbacks a pane's dialogue box and composer are built from. */
export interface StageHooks {
  /** Who is speaking in the dialogue box. */
  nameplate: string;
  placeholder: string;
  inputTitle: string;
  sendTitle: string;
  stopTitle: string;
  /** The Stop button, once. Hosts anchor it here rather than reaching into the composer. */
  onStopButton?(button: HTMLButtonElement): void;
  onSend(text: string): void;
  onStop(): void;
  /** The `⌘` button beside the composer. Left out where the pane is not a palette host. */
  onPalette?: () => void;
  /**
   * The project's skills, as the composer last heard them. A pane that supplies this gets the `/`
   * menu and the expansion that goes with it; one that does not — the debug agent's, which talks
   * to an agent with no project — gets a composer where `/` is an ordinary character.
   */
  skills?: () => readonly SkillEntry[];
}

/**
 * The dialogue box, the openers and the composer: the same element whatever the transcript above
 * is doing. The composer is built once and never rebuilt, so what the author is typing and what a
 * seed lands in both outlive a redraw.
 */
export class ChatStage {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly lineEl: HTMLDivElement;
  /** The one word said while a turn is in flight; a CSS animation does the rest. */
  private readonly workingEl: HTMLDivElement;
  private readonly chipsEl: HTMLDivElement;
  private readonly sendBtn: HTMLButtonElement;
  /** Shown only while a turn is in flight; the stop command refuses an idle agent by name anyway. */
  private readonly stopBtn: HTMLButtonElement;

  private readonly hooks: StageHooks;
  /** The `/` menu, empty and hidden until a token is being typed. */
  private readonly menuEl: HTMLDivElement;
  /** What the menu is offering, in the order it draws them. */
  private offered: readonly SkillEntry[] = [];
  /** Which row the keyboard is on. */
  private at = 0;
  /** Escape closes the menu until the token changes, so it does not reopen on the next keystroke. */
  private dismissed = false;

  constructor(hooks: StageHooks) {
    this.hooks = hooks;
    this.root = el('div', 'stage');

    const dbox = el('div', 'dbox');
    dbox.appendChild(el('div', 'nameplate', hooks.nameplate));
    this.lineEl = el('div', 'line') as HTMLDivElement;
    dbox.appendChild(this.lineEl);
    // Built once and shown while busy: a turn that says nothing for half a minute is otherwise
    // indistinguishable from one that never started. `@keyframes` animates the one word
    this.workingEl = el('div', 'working', 'working') as HTMLDivElement;
    dbox.appendChild(this.workingEl);
    this.root.appendChild(dbox);

    this.chipsEl = el('div', 'chips') as HTMLDivElement;
    this.root.appendChild(this.chipsEl);

    const composer = el('div', 'composer');
    this.input = document.createElement('input');
    this.input.name = 'composer';
    this.input.placeholder = hooks.placeholder;
    this.input.title = hooks.inputTitle;
    // The shell keymap is a bubble-phase window listener, so a composer that does not stop its
    // own keys hands Ctrl+Z and the shell's other gestures away mid-edit.
    this.input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (this.menuKey(event)) return;
      if (event.key === 'Enter') this.send(hooks);
    });
    // A caret moved by an arrow key or a click leaves a token it is no longer in, and a menu that
    // stayed open over one would complete a word nobody is typing.
    this.input.addEventListener('input', () => this.offerSkills());
    this.input.addEventListener('click', () => this.offerSkills());
    this.input.addEventListener('keyup', () => this.offerSkills());
    this.input.addEventListener('blur', () => this.closeMenu());
    composer.appendChild(this.input);

    this.menuEl = el('div', 'slash') as HTMLDivElement;
    this.menuEl.hidden = true;
    // Stops the box losing focus, since the blur would detach the row before its click landed
    this.menuEl.addEventListener('mousedown', (event) => event.preventDefault());
    composer.appendChild(this.menuEl);

    if (hooks.onPalette) {
      const palette = document.createElement('button');
      palette.className = 'cmdbtn';
      // A `>` rather than the `/` it used to be: `/` now names a skill in the box beside it, and
      // one glyph cannot mean two things a keystroke apart.
      palette.textContent = '>';
      palette.title = 'Open the palette and run a command by name (Ctrl+Shift+P)';
      palette.addEventListener('click', () => hooks.onPalette!());
      composer.appendChild(palette);
    }

    this.sendBtn = document.createElement('button');
    this.sendBtn.className = 'send';
    this.sendBtn.textContent = '↑';
    this.sendBtn.title = hooks.sendTitle;
    this.sendBtn.addEventListener('click', () => this.send(hooks));
    composer.appendChild(this.sendBtn);

    this.stopBtn = document.createElement('button');
    this.stopBtn.className = 'stop';
    this.stopBtn.textContent = '■';
    this.stopBtn.title = hooks.stopTitle;
    this.stopBtn.addEventListener('click', () => hooks.onStop());
    composer.appendChild(this.stopBtn);
    hooks.onStopButton?.(this.stopBtn);

    this.root.appendChild(composer);
  }

  private send(hooks: StageHooks): void {
    const text = this.input.value;
    if (!text.trim()) return;
    this.input.value = '';
    this.closeMenu();
    hooks.onSend(hooks.skills ? expandSlash(text, hooks.skills()) : text);
  }

  // -------------------------------------------------------------------------
  // The `/` menu
  // -------------------------------------------------------------------------

  /**
   * Offer the skills the token in the box names, or close the menu because it names none. Called on
   * every keystroke and every caret move, so it decides both when the menu opens and when it goes.
   */
  private offerSkills(): void {
    const skills = this.hooks.skills?.();
    const query = skills ? slashQuery(this.input.value, this.input.selectionStart ?? 0) : null;
    // Leaving the token forgets an Escape, so the next `/` opens the menu again while the one it
    // was pressed over stays closed for as long as the author is typing it.
    if (query === null) this.dismissed = false;
    if (query === null || this.dismissed) return this.closeMenu();
    const matched = matchSkills(skills as readonly SkillEntry[], query);
    if (matched.length === 0) return this.closeMenu();
    // The highlight starts at the best match again whenever the list changes, because the row that
    // was highlighted is rarely still the row under the same index.
    if (matched.length !== this.offered.length || matched[0]?.id !== this.offered[0]?.id)
      this.at = 0;
    this.offered = matched;
    this.paintMenu();
  }

  private paintMenu(): void {
    this.menuEl.textContent = '';
    this.menuEl.hidden = false;
    this.offered.forEach((skill, index) => {
      const row = document.createElement('button');
      if (index === this.at) row.classList.add('at');
      row.title = skill.description
        ? `${skill.description} Enter puts /${skill.id} in the box; the agent is asked to follow it.`
        : `Ask the agent to follow the ${skill.name} playbook.`;
      row.appendChild(el('span', 'sk-id', `/${skill.id}`));
      row.appendChild(el('span', 'sk-what', skill.description || skill.name));
      row.addEventListener('click', () => this.takeSkill(skill));
      this.menuEl.appendChild(row);
    });
    (this.menuEl.children[this.at] as HTMLElement | undefined)?.scrollIntoView({
      block: 'nearest',
    });
  }

  private closeMenu(): void {
    this.menuEl.hidden = true;
    this.menuEl.textContent = '';
    this.offered = [];
    this.at = 0;
  }

  /** Put the picked skill in the box, and leave the caret where what it applies to is typed. */
  private takeSkill(skill: SkillEntry): void {
    const { text, caret } = completeSlash(this.input.value, skill);
    this.input.value = text;
    this.closeMenu();
    this.input.focus();
    this.input.setSelectionRange(caret, caret);
  }

  /**
   * A key the open menu answers, in which case the composer does not. Enter completes rather than
   * sending, which is what makes the list worth opening — Enter on a half-typed name would send the
   * half-typed name.
   */
  private menuKey(event: KeyboardEvent): boolean {
    if (this.menuEl.hidden || this.offered.length === 0) return false;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        this.at = moveHighlight(this.at, this.offered.length, event.key === 'ArrowDown' ? 1 : -1);
        this.paintMenu();
        return true;
      case 'Enter':
      case 'Tab':
        event.preventDefault();
        this.takeSkill(this.offered[this.at] as SkillEntry);
        return true;
      case 'Escape':
        event.preventDefault();
        this.dismissed = true;
        this.closeMenu();
        return true;
      default:
        return false;
    }
  }

  /** What the dialogue box says. */
  say(line: string): void {
    this.lineEl.textContent = line;
  }

  /** Show a turn is in flight: Send goes dead, Stop appears, and the box says so. */
  setBusy(busy: boolean): void {
    this.sendBtn.disabled = busy;
    this.stopBtn.style.display = busy ? 'grid' : 'none';
    this.workingEl.style.display = busy ? 'block' : 'none';
  }

  /**
   * The openers, as chips. Clicking one fills the composer and focuses it, and sends nothing. The
   * chip teaches the shape of a useful prompt, and sending it would remove the moment where the
   * author edits it into what they actually meant.
   */
  setChips(suggestions: readonly string[]): void {
    this.chipsEl.textContent = '';
    for (const text of suggestions) {
      const chip = document.createElement('button');
      chip.textContent = text;
      chip.title = 'Put this in the composer to edit before you send it — clicking sends nothing.';
      chip.addEventListener('click', () => this.fill(text));
      this.chipsEl.appendChild(chip);
    }
  }

  /** Put text in the composer with the caret after it, ready to be edited. */
  fill(text: string): void {
    this.input.value = text;
    this.input.focus();
    this.input.setSelectionRange(text.length, text.length);
  }
}

/** Where a question card's answers go, and what the pane calls the agent asking it. */
export interface AskHost {
  /** The card's heading, above the question. */
  head: string;
  /** The form for this request, started on arrival and kept until the answers go back. */
  formFor(request: AskRequest): AskForm;
  /** The form as it stands, which is not the one a cached card was drawn from. */
  formNow(): AskForm | null;
  /** Replace the form. A keystroke passes `redraw` false, to keep the caret in the box. */
  setForm(next: AskForm, redraw?: boolean): void;
  /** Send one answer per question of the form, in its order. */
  send(answers: string[]): void;
  /** Redraw the pane around a form transition. */
  redraw(): void;
}

/**
 * The question card, and the cache that keeps it across a redraw the author did not cause.
 *
 * A pane replaces its transcript wholesale, and a redraw landing between a click's press and its
 * release detaches the row under the pointer — the click then never fires, and the author's pick
 * silently goes nowhere. The two keys say when the card is genuinely stale: a different request,
 * or a form the author has since moved.
 */
export class AskCards {
  private cardEl: HTMLElement | null = null;
  private cardRequest: AskRequest | null = null;
  private cardForm: AskForm | null = null;
  /** The form page whose box already took focus, so a redraw does not steal the caret back. */
  private focused = '';
  /** The live Submit answers button, so typing can keep its tooltip's blank count true. */
  private sendAct: HTMLButtonElement | null = null;

  constructor(private readonly host: AskHost) {}

  /** Whether the node with the caret in it belongs to the card being reused. */
  holds(node: Node | null): boolean {
    return node !== null && this.cardEl !== null && this.cardEl.contains(node);
  }

  /** The card for this request, reused while nothing about it has changed. */
  cardFor(request: AskRequest): HTMLElement {
    const form = this.host.formFor(request);
    if (this.cardEl && this.cardRequest === request && this.cardForm === form) return this.cardEl;
    this.cardRequest = request;
    this.cardForm = form;
    this.cardEl = this.build(request);
    return this.cardEl;
  }

  /**
   * The agent asked something and its turn is parked on the answer. It takes the plan card's shape
   * because it is the same kind of moment, with the conversation stopped and waiting on the author,
   * and the box takes focus on arrival since nothing else on this pane is worth typing into.
   *
   * A request carries a form: usually one question, sometimes several the model wants settled
   * together. Several are drawn one page at a time with ‹ Back / Next › between them and one
   * Submit answers at the end, because a wall of four questions reads as a chore while one
   * question with a pager reads as a question. A single question draws as it always did.
   */
  private build(request: AskRequest): HTMLElement {
    const form = this.host.formFor(request);
    const page = pageOf(form);
    const card = el('div', 'plan ask');
    const head = el('div', 'plan-head', this.host.head);
    const where = pageLabel(form);
    if (where) {
      const pager = el('span', 'ask-page', where);
      pager.title = 'The agent asked these together; answer them all, then submit once.';
      head.appendChild(pager);
    }
    card.appendChild(head);

    const body = el('div', 'plan-body');
    body.appendChild(el('div', 'plan-sum', page?.question ?? ''));

    const choices = page?.choices ?? [];
    const first = choices.length ? this.drawChoices(body, form, choices) : null;
    const field = this.drawAnswerBox(body, form, choices.length > 0);

    body.appendChild(this.drawActs(form, choices.length > 0));
    card.appendChild(body);

    // Keyed per page rather than per request: paging to question 3 puts the caret on question 3,
    // and an event that redraws the card mid-answer leaves the caret where the author put it
    const here = `${request.id}:${form.at}`;
    if (this.focused !== here) {
      this.focused = here;
      // The card is not in the document until the pane has appended it. With a list, the list is
      // what the author came to read, so the caret starts there rather than in the box.
      queueMicrotask(() => (first ?? field).focus());
    }
    return card;
  }

  /** Apply a transition to the form and redraw the card around it. */
  private page(next: AskForm): void {
    this.host.setForm(next);
    this.host.redraw();
  }

  /**
   * The shortlist. On a lone single-pick question a click answers outright — there is nothing
   * else to say — while every other shape ticks and waits, because a form has more pages to fill
   * in and a multi-pick's second choice is the whole point.
   *
   * A tick redraws nothing. Rebuilding the card would take the row out from under the pointer
   * between one click and the next and scroll the list as it went, and a click whose row is gone
   * is never delivered — which is how a picked answer reaches the agent as no answer at all. The
   * rows and the tooltip are updated in place instead, and the cache key follows the form the way
   * typing's does.
   *
   * Returns the first row so the card can start the focus there.
   */
  private drawChoices(body: HTMLElement, form: AskForm, choices: string[]): HTMLButtonElement {
    const multi = pageOf(form)?.multi === true;
    const outright = answersOnPick(form);
    const list = el('div', 'ask-choices');
    const rows = choices.map((choice) => {
      const row = document.createElement('button');
      row.textContent = choice;
      row.title = multi
        ? `Include “${choice}” in your answer. Pick as many as apply.`
        : outright
          ? `Answer “${choice}”.`
          : `Answer “${choice}” to this question. The rest of the form stays as you left it.`;
      if (isPicked(form, choice)) row.classList.add('picked');
      row.addEventListener('click', () => {
        // Whatever was typed beside the list rides along, on an outright pick too: a choice
        // qualified in the box is one answer, and sending the choice alone would drop half of it.
        const picked = pick(this.host.formNow() ?? form, choice);
        if (outright) return this.sendAnswers(answersOf(picked));
        if (!multi) return this.page(goTo(picked, picked.at + 1));
        // Picking the last question's answer must not submit. On the last page the pick simply
        // stands, and Submit remains the one thing that ends the form.
        this.host.setForm(picked, false);
        this.cardForm = picked;
        rows.forEach((r, i) => r.classList.toggle('picked', isPicked(picked, choices[i]!)));
        if (this.sendAct) this.sendAct.title = this.sendTitle(picked, true);
      });
      list.appendChild(row);
      return row;
    });
    body.appendChild(list);
    return rows[0]!;
  }

  /** The free-text box under the list, or instead of it where the question offered none. */
  private drawAnswerBox(body: HTMLElement, form: AskForm, listed: boolean): HTMLInputElement {
    const field = document.createElement('input');
    field.className = 'ask-input';
    field.placeholder = listed
      ? 'Or type an answer of your own…'
      : 'Answer, or press Enter to say nothing…';
    field.title = listed
      ? 'Answer in your own words instead of picking from the list.'
      : 'Answer the question. Sending an empty box says you have nothing to add.';
    field.value = form.typed[form.at] ?? '';
    // Typing does not redraw — that would take the caret away mid-word — so what was typed is
    // written into the form on every keystroke instead, where a redraw will find it again.
    field.addEventListener('input', () => {
      const typed = type(this.host.formNow() ?? form, field.value);
      this.host.setForm(typed, false);
      // The element on screen already shows this keystroke, so the card key follows the form:
      // otherwise the next unrelated rebuild would count typing as staleness and rebuild the
      // card, which is exactly the redraw-under-the-pointer this cache exists to prevent.
      this.cardForm = typed;
      // The tooltip counts what is still blank, and this keystroke may have just filled one in.
      if (this.sendAct) this.sendAct.title = this.sendTitle(typed, listed);
    });
    field.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key !== 'Enter') return;
      const now = this.host.formNow() ?? form;
      if (isLast(now)) this.reply();
      else this.page(goTo(now, now.at + 1));
    });
    body.appendChild(field);
    return field;
  }

  /** Back / Next on the left, and the one button that ends the form on the right. */
  private drawActs(form: AskForm, listed: boolean): HTMLElement {
    const acts = el('div', 'plan-acts');
    if (form.questions.length > 1) {
      const nav = el('div', 'ask-nav');
      nav.appendChild(
        this.navButton('‹ Back', isFirst(form), 'Go back to the previous question.', () =>
          this.page(goTo(this.host.formNow() ?? form, form.at - 1)),
        ),
      );
      nav.appendChild(
        this.navButton('Next ›', isLast(form), 'Go on to the next question.', () =>
          this.page(goTo(this.host.formNow() ?? form, form.at + 1)),
        ),
      );
      acts.appendChild(nav);
    }

    const send = document.createElement('button');
    send.className = 'btn primary';
    send.textContent = form.questions.length > 1 ? 'Submit answers' : 'Answer →';
    send.title = this.sendTitle(form, listed);
    send.addEventListener('click', () => this.reply());
    this.sendAct = send;
    acts.appendChild(send);
    if (listed) acts.appendChild(this.chatButton(form));
    return acts;
  }

  /**
   * What the one button that ends the form promises. A blank answer is a real answer (the tool
   * exists to hear "nothing to add") so what is still empty is named in the tooltip rather than
   * used to grey the button out. Recomputed on every keystroke, because a stale count would
   * misstate what the author just typed.
   */
  private sendTitle(form: AskForm, listed: boolean): string {
    if (form.questions.length === 1) {
      return listed
        ? 'Send what you picked, plus anything you typed.'
        : 'Send this answer and let the agent carry on.';
    }
    const blank = blankPages(form);
    if (!blank.length) return 'Send all your answers and let the agent carry on.';
    return (
      `Send all ${form.questions.length} answers. Question${blank.length > 1 ? 's' : ''} ` +
      `${blank.join(', ')} will go back blank, which the agent reads as “nothing to add”.`
    );
  }

  private navButton(
    text: string,
    disabled: boolean,
    title: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'btn';
    button.textContent = text;
    button.disabled = disabled;
    // A greyed control says why, and here the why is simply where the author is in the form.
    button.title = disabled
      ? text.startsWith('‹')
        ? 'This is the first question.'
        : 'This is the last question.'
      : title;
    button.addEventListener('click', onClick);
    return button;
  }

  /**
   * The way out of a list that does not have the answer on it. It answers rather than dismissing
   * the card, because the turn is parked on this reply and a card closed without one would hang.
   * What it sends is the author's own position, and the transcript shows it as theirs.
   *
   * On a form it fills in every question the author left unanswered and leaves the answered ones
   * alone, since declining to pick can be meant about some of a form and not the rest.
   */
  private chatButton(form: AskForm): HTMLButtonElement {
    const chat = document.createElement('button');
    chat.className = 'btn';
    chat.textContent = 'Chat about this';
    chat.title =
      form.questions.length > 1
        ? 'Answer every question you have left blank with “let us talk it through” and send.'
        : 'Answer that you would rather talk it through than pick from the list.';
    chat.addEventListener('click', () => {
      const said = 'None of those — let us talk it through before I pick.';
      this.sendAnswers(answersOf(this.host.formNow() ?? form).map((a) => (a === '' ? said : a)));
    });
    return chat;
  }

  /** What Answer → and Submit answers send: every page's picks, then what was typed. */
  private reply(): void {
    const now = this.host.formNow();
    if (now) this.sendAnswers(answersOf(now));
  }

  /** The form itself is cleared by the host, since it belongs to the question rather than here. */
  private sendAnswers(answers: string[]): void {
    this.cardEl = null;
    this.cardRequest = null;
    this.cardForm = null;
    this.host.send(answers);
  }
}

import type { Container } from 'pathux';
import { check, exec, onInvalidate, report } from '../bridge.js';
import { VnEditor, registerEditor } from '../editor.js';
import { redrawing, type AnchorPass } from '../anchors.js';
import type { Offer } from '../../rules/anchors.js';
import { KEY_SUPPLIES } from '../../rules/keysetup.js';
import ONBOARDING_CSS from '../../styles/onboarding.css?inline';
import {
  GUIDE_URL_FIELDS,
  type KeyGuide,
  type KeyGuideVendor,
} from '../../../src/shared/apikeys.js';
import type { Block, Inline } from '../../../src/shared/markdown.js';
import type { KeyScope, KeyStatusView, VendorKeyView } from '../../../src/shared/ipc.js';

/**
 * The Setup pane: how to get a model key, and what this machine currently has.
 *
 * It is the one pane that is read before there is a project worth opening, which is why it is
 * `offered: false` in `EDITORS` — named, reachable from File ▸ Set Up API Keys…, the palette and
 * a stored layout, and absent from the pane switcher, because an author does not navigate here
 * twice.
 *
 * Every word on it comes from `docs/guides/api-keys.md`, over `app.keyGuide`. Nothing is typed in
 * here: a second copy of the steps goes stale the first time a console moves a button, and this
 * file only says which of the steps are already done. What it adds to the page is the three
 * things the page cannot know — whether a key resolved and from where, whether an environment
 * variable is shadowing one, and whether the key that resolved actually works.
 */
export class OnboardingEditor extends VnEditor {
  private surface!: HTMLDivElement;
  private page!: HTMLDivElement;
  private noteEl!: HTMLDivElement;

  private guide: KeyGuide | undefined;
  private status: KeyStatusView | undefined;
  /** Rising with every load, so a slow read that arrives after a newer one is dropped. */
  private token = 0;
  /** The scope each vendor's box would write to, remembered across a repaint. */
  private scopes = new Map<string, KeyScope>();
  private unwatch: (() => void) | undefined;

  static override define() {
    return {
      tagname: 'vn-onboarding-editor-x',
      areaname: 'onboarding',
      icon: -1,
    };
  }

  override init() {
    super.init();

    const bar = (this.header as Container).row();
    bar.label('SETUP').style['padding'] = '0px 8px';
    const reload = bar.button('⟳', () => void this.load());
    reload.description = 'Re-read the walkthrough and check which keys resolve now';
    bar.flushUpdate();

    this.adoptStyle(ONBOARDING_CSS);
    this.surface = el('div', 'ob-surface') as HTMLDivElement;
    this.page = el('div', 'ob-page') as HTMLDivElement;
    this.noteEl = el('div', 'ob-note') as HTMLDivElement;
    this.surface.append(this.page, this.noteEl);
    this.appendSurface(this.surface);

    // `project.setKey` is mutating, so pasting a key here re-reads the other vendor's row too.
    // Opening another workspace does the same, because its project may name different variables.
    this.unwatch = onInvalidate(() => void this.load());

    void this.load();
  }

  private anchors: AnchorPass = redrawing('onboarding', 'page');

  override on_remove() {
    this.unwatch?.();
    this.unwatch = undefined;
    super.on_remove();
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  private async load(): Promise<void> {
    const mine = ++this.token;
    const [guide, status] = await Promise.all([exec('app.keyGuide'), exec('project.keyStatus')]);
    if (mine !== this.token) return;

    // The guide is what the app ships and the status is what the machine has. Either can fail on
    // its own — a packaging mistake loses the guide, no project open loses the status — and the
    // pane is worth drawing with only one of them.
    this.guide = guide.ok ? (guide.data as KeyGuide) : undefined;
    this.status = status.ok ? (status.data as KeyStatusView) : undefined;
    const trouble = [guide.ok ? '' : guide.error, status.ok ? '' : status.error].filter(Boolean);
    this.note(trouble.join(' '), trouble.length > 0);
    this.paint();
  }

  private vendorStatus(vendor: string): VendorKeyView | undefined {
    return this.status?.vendors.find((entry) => entry.vendor === vendor);
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private note(text: string, bad = false): void {
    this.noteEl.textContent = text;
    this.noteEl.className = bad ? 'ob-note bad' : 'ob-note';
    this.noteEl.title = text;
  }

  private paint(): void {
    this.anchors = redrawing('onboarding', 'page');
    this.page.textContent = '';
    const guide = this.guide;
    if (!guide) {
      this.page.appendChild(el('div', 'ob-prose', 'The setup walkthrough could not be read.'));
      return;
    }

    this.page.appendChild(prose(guide.intro));
    for (const vendor of guide.vendors) this.page.appendChild(this.vendorCard(vendor));
    for (const note of guide.notes) {
      const card = el('div', 'ob-card');
      const head = el('div', 'ob-head');
      head.appendChild(el('h2', '', note.title));
      card.append(head, wrap('ob-body', prose(note.body)));
      this.page.appendChild(card);
    }
  }

  /** Renders one vendor's card, showing what the guide says about the vendor and what key this machine has for the vendor. */
  private vendorCard(vendor: KeyGuideVendor): HTMLElement {
    const view = this.vendorStatus(vendor.vendor);
    const card = el('div', 'ob-card');

    const head = el('div', 'ob-head');
    head.appendChild(el('h2', '', vendor.name));
    const env = el('span', 'ob-env', `$${view?.envName ?? vendor.env}`);
    env.title = 'The environment variable project.yaml names for this provider';
    head.appendChild(env);
    const badge = el(
      'span',
      `ob-badge ${vendor.freeTier ? 'yes' : 'no'}`,
      vendor.freeTier ? 'free tier' : 'paid only',
    );
    badge.title = vendor.freeTier
      ? 'Some use costs nothing, within a rate limit'
      : 'Every call is billed — a new account needs credit before anything works';
    head.appendChild(badge);
    card.appendChild(head);

    const body = el('div', 'ob-body');
    body.appendChild(this.statusRow(vendor, view));
    if (view?.envShadow) {
      const warn = el(
        'div',
        'ob-shadow',
        `$${view.envName} is set in this app's environment, and it is read before any file — ` +
          'so a key pasted below will not be the one used until that variable is unset.',
      );
      warn.title = 'Why pasting a key here may appear to change nothing';
      body.appendChild(warn);
    }
    body.appendChild(this.linkRow(vendor));
    body.appendChild(prose(vendor.body));
    body.appendChild(this.pasteRow(vendor, view));
    card.appendChild(body);
    return card;
  }

  private statusRow(vendor: KeyGuideVendor, view: VendorKeyView | undefined): HTMLElement {
    const row = el('div', `ob-status ${view?.resolved ? 'set' : 'unset'}`);
    row.appendChild(el('span', 'ob-dot', view?.resolved ? '●' : '○'));
    row.appendChild(el('span', '', view?.source ?? 'No project open, so no key was looked for.'));
    row.title = view?.resolved
      ? 'Which source answered. Never the key itself.'
      : `Nothing answers for ${vendor.vendor} yet — paste a key below, or set $${vendor.env}.`;
    return row;
  }

  /** The three pages the app is willing to open, which are three fields of the shipped guide. */
  private linkRow(vendor: KeyGuideVendor): HTMLElement {
    const row = el('div', 'ob-buttons');
    const labels: Record<(typeof GUIDE_URL_FIELDS)[number], [string, string]> = {
      console: ['Open console', 'Open the page where a key is created, in your browser'],
      docs: ['Provider docs', "Open the provider's own version of these steps"],
      billing: ['Pricing', 'Open what this provider charges'],
    };
    for (const field of GUIDE_URL_FIELDS) {
      const url = vendor[field];
      const [label, why] = labels[field];
      const button = el(
        'button',
        field === 'console' ? 'ob-btn go' : 'ob-btn',
        label,
      ) as HTMLButtonElement;
      button.disabled = url === '';
      button.title =
        url === ''
          ? `The setup guide names no ${field} page for ${vendor.vendor}.`
          : `${why} — ${url}`;
      const offer: Offer =
        url === ''
          ? { ok: false, id: 'app.openKeyLink', reason: button.title }
          : { ok: true, id: 'app.openKeyLink', props: { provider: vendor.vendor, link: field } };
      this.anchors.act(button, offer, (action) => void exec(action.id, action.props).then(report), {
        on: `${vendor.vendor}/${field}`,
      });
      row.appendChild(button);
    }
    return row;
  }

  /**
   * The box, its scope, and the two acts. The scope defaults to every project: an author who
   * pastes a key once has almost never meant "and only for this one folder".
   */
  private pasteRow(vendor: KeyGuideVendor, view: VendorKeyView | undefined): HTMLElement {
    const wrapEl = el('div', '');
    const row = el('div', 'ob-paste');
    const said = el('div', 'ob-said') as HTMLDivElement;
    const where = el('div', 'ob-where') as HTMLDivElement;

    const box = document.createElement('input');
    box.type = 'password';
    box.className = 'ob-key';
    box.placeholder = `paste the ${vendor.name} key`;
    box.autocomplete = 'off';
    box.spellcheck = false;
    box.title =
      'The key goes to one file and nowhere else — not to the log, and not to the command ' +
      'history, which records it as <secret>.';
    // The screen keymap is a bubble-phase window listener, so a box that does not stop its own
    // keys hands Ctrl+Z and the shell's other gestures away mid-edit.
    box.addEventListener('keydown', (event) => event.stopPropagation());

    const scope = document.createElement('select');
    scope.className = 'ob-scope';
    for (const [value, label] of [
      ['user', 'every project'],
      ['project', 'this project'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      scope.appendChild(option);
    }
    scope.value = this.scopes.get(vendor.vendor) ?? 'user';
    scope.title = 'Where the key is written: once for this machine, or inside this project';

    const save = el('button', 'ob-btn go', 'Save key') as HTMLButtonElement;
    const test = el('button', 'ob-btn', 'Test key') as HTMLButtonElement;

    const describe = async (): Promise<void> => {
      const chosen = scope.value as KeyScope;
      this.scopes.set(vendor.vendor, chosen);
      where.textContent = view ? `Writes to ${view.writesTo[chosen]}` : '';
      // The command's own sentence about what it would do, so the pane never invents one.
      const verdict = await check('project.setKey', {
        provider: vendor.vendor,
        key: '',
        scope: chosen,
      });
      const reason = verdict.state === 'refuse' ? verdict.message : '';
      save.disabled = reason !== '' || box.value.trim() === '';
      save.title =
        reason ||
        (box.value.trim() === '' ? 'Paste a key first' : verdict.message || 'Write this key');
      // Re-recorded whenever the scope changes, because the scope is a prop the anchor carries.
      // The key is not: it is typed, so it is what the anchor says the widget supplies.
      this.anchors.record(
        save,
        save.disabled
          ? { ok: false, id: 'project.setKey', reason: save.title }
          : { ok: true, id: 'project.setKey', props: { provider: vendor.vendor, scope: chosen } },
        { on: vendor.vendor, supplies: KEY_SUPPLIES },
      );
    };

    box.addEventListener('input', () => void describe());
    scope.addEventListener('change', () => void describe());

    save.addEventListener('click', () => {
      const key = box.value.trim();
      if (!key) return;
      void exec('project.setKey', {
        provider: vendor.vendor,
        key,
        scope: (scope.value as KeyScope) ?? 'user',
      }).then((outcome) => {
        // The box is cleared whatever the answer was, because a key that failed to write should
        // not sit on screen for the next person here.
        box.value = '';
        report(outcome);
        this.say(said, outcome.ok ? outcome.record.message : outcome.error, outcome.ok);
        void describe();
      });
    });

    test.addEventListener('click', () => {
      this.say(said, `Calling ${vendor.name}…`, true, true);
      void exec('project.testKey', { provider: vendor.vendor }).then((outcome) => {
        report(outcome);
        this.say(said, outcome.ok ? outcome.record.message : outcome.error, outcome.ok);
      });
    });

    row.append(box, scope, save, test);
    wrapEl.append(row, where, said);

    void describe();
    // A greyed control says why it is grey, in the command's own words — `project.testKey`
    // refuses when nothing resolves, and that refusal is the more useful sentence here than
    // anything this pane could work out for itself.
    void check('project.testKey', { provider: vendor.vendor }).then((verdict) => {
      const refused = verdict.state === 'refuse';
      test.disabled = refused;
      test.title = refused
        ? verdict.message
        : 'Make one small real call and say whether the key works. It costs a fraction of a cent.';
      // Recorded once the verdict lands rather than beside the button: the button is drawn before
      // the answer comes back, and the anchor has to carry the refusal it ends up wearing.
      this.anchors.record(
        test,
        refused
          ? { ok: false, id: 'project.testKey', reason: verdict.message }
          : { ok: true, id: 'project.testKey', props: { provider: vendor.vendor } },
        { on: vendor.vendor },
      );
    });

    return wrapEl;
  }

  private say(into: HTMLDivElement, text: string, good: boolean, plain = false): void {
    into.textContent = text;
    into.className = plain ? 'ob-said' : good ? 'ob-said good' : 'ob-said bad';
    into.title = text;
  }
}

// ---------------------------------------------------------------------------
// Markdown, drawn
// ---------------------------------------------------------------------------

/** A run of blocks as one prose section. */
function prose(blocks: readonly Block[]): HTMLElement {
  const node = el('div', 'ob-prose');
  for (const block of blocks) node.appendChild(drawBlock(block));
  return node;
}

function drawBlock(block: Block): HTMLElement {
  switch (block.kind) {
    case 'heading':
      return spans(el('h3', ''), block.spans);
    case 'para':
      return spans(el('p', ''), block.spans);
    case 'list': {
      const list = el(block.ordered ? 'ol' : 'ul', '');
      for (const item of block.items) list.appendChild(spans(el('li', ''), item));
      return list;
    }
    case 'table': {
      const table = el('table', '');
      if (block.head.length > 0) {
        const head = el('tr', '');
        for (const cell of block.head) head.appendChild(spans(el('th', ''), cell));
        table.appendChild(head);
      }
      for (const row of block.rows) {
        const tr = el('tr', '');
        for (const cell of row) tr.appendChild(spans(el('td', ''), cell));
        table.appendChild(tr);
      }
      return table;
    }
    case 'code':
      return el('pre', '', block.text);
  }
}

/**
 * A run of spans into an element.
 *
 * A link becomes a `span`, not an `a`. There is no navigation inside this shadow root — a
 * renderer that followed an href would show a web page where a pane was — and the only way out
 * to the browser is `app.openKeyLink`, which names a field of the shipped guide rather than a
 * URL. The address therefore goes in the tooltip, and each vendor card's link buttons are how a
 * page is opened.
 */
function spans(into: HTMLElement, runs: readonly Inline[]): HTMLElement {
  for (const run of runs) {
    if (run.kind === 'text') {
      into.appendChild(document.createTextNode(run.text));
    } else if (run.kind === 'code') {
      into.appendChild(el('code', '', run.text));
    } else if (run.kind === 'strong') {
      into.appendChild(el('strong', '', run.text));
    } else {
      const link = el('span', 'ob-link', run.text);
      link.title = run.href.startsWith('#') ? 'Further down this page' : run.href;
      into.appendChild(link);
    }
  }
  return into;
}

function wrap(className: string, child: HTMLElement): HTMLElement {
  const node = el('div', className);
  node.appendChild(child);
  return node;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

registerEditor(OnboardingEditor, 'vn.OnboardingEditor');

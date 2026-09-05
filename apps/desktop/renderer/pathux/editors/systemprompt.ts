import type { Container } from 'pathux';
import { api } from '../../api.js';
import { onInvalidate } from '../app/bridge.js';
import { joined, scaleOf } from '../../rules/systemprompt.js';
import { VnEditor, registerEditor } from '../app/editor.js';
import SYSTEM_PROMPT_CSS from '../../styles/systemprompt.css?inline';
import type { AgentSystem } from '../../../src/shared/ipc.js';

/**
 * The system prompt the agent's next turn will carry, in its sections.
 *
 * Named but not listed (`offered: false` in `EDITORS`), so it is reached by name —
 * `view.open(editor='systemprompt')` from the command palette — and stays out of the two menus an
 * author browses editors in. It is a place to look when a turn misbehaves rather than a place to
 * work.
 *
 * Read-only, and singular in the same way the Project pane is: the prompt is a property of the
 * workspace rather than of anything selected, so this pane has no subject and takes no pin. It
 * asks main for the prompt rather than reconstructing it, so that what it shows is the same
 * assembly `runAgent` makes. A second implementation here could disagree with the one that ships,
 * and be wrong in exactly the case being investigated.
 */
export class SystemPromptEditor extends VnEditor {
  private surface!: HTMLDivElement;
  private noteEl!: HTMLDivElement;
  private filesEl!: HTMLDivElement;
  private body!: HTMLDivElement;

  private view: AgentSystem | undefined;
  /** Rising with every load, so a slow read that arrives after a newer one is dropped. */
  private token = 0;

  static override define() {
    return {
      tagname : 'vn-systemprompt-editor-x',
      areaname: 'systemprompt',
      icon    : -1,
    };
  }

  override init() {
    super.init();

    const bar = (this.header as Container).row();
    bar.label('SYSTEM PROMPT').style['padding'] = '0px 8px';
    bar.button('Copy', () => void this.copyAll()).description =
      'Put the whole prompt — every section, joined the way the agent gets it — on the clipboard';
    bar.button('⟳', () => void this.load()).description =
      'Re-read the prompt. The project map and AICONTEXT.md are files, and either may have moved';
    bar.flushUpdate();

    this.adoptStyle(SYSTEM_PROMPT_CSS);
    this.surface = el('div', 'sp-surface') as HTMLDivElement;
    this.noteEl = el('div', 'sp-note') as HTMLDivElement;
    this.filesEl = el('div', 'sp-files') as HTMLDivElement;
    this.body = el('div', 'sp-body') as HTMLDivElement;
    this.body.style.display = 'contents';
    this.surface.append(this.noteEl, this.filesEl, this.body);
    this.appendSurface(this.surface);

    // Two of the three sections are files in the workspace, and `update_context` rewrites one of
    // them mid-conversation — so this follows the same invalidation every other pane does rather
    // than showing whatever was true when it was opened.
    const refollow = (): void => void this.load();
    this.watch(() => onInvalidate(refollow), refollow);

    void this.load();
  }

  private async load(): Promise<void> {
    const mine = ++this.token;
    try {
      const view = await api.invoke('agent:system');
      if (mine !== this.token) return;
      this.view = view;
      this.note(view ? scaleOf(view.sections, view.modelId) : '');
    } catch (error) {
      if (mine !== this.token) return;
      this.view = undefined;
      this.note(error instanceof Error ? error.message : String(error), true);
    }
    this.paint();
  }

  /** The whole prompt, joined the way the agent receives it — not the section under the cursor. */
  private async copyAll(): Promise<void> {
    const view = this.view;
    if (!view) return void this.note('nothing to copy yet', true);
    try {
      await navigator.clipboard.writeText(joined(view.sections));
      this.note('copied');
    } catch (error) {
      this.note(error instanceof Error ? error.message : String(error), true);
    }
  }

  private note(text: string, bad = false): void {
    this.noteEl.textContent = text;
    this.noteEl.className = bad ? 'sp-note bad' : 'sp-note';
    this.noteEl.title = text;
  }

  private paint(): void {
    this.filesEl.textContent = '';
    this.body.textContent = '';

    const view = this.view;
    if (!view || view.sections.length === 0) {
      const empty = el('div', 'sp-empty', 'No prompt — open a project first.');
      this.body.appendChild(empty);
      return;
    }

    for (const path of view.files) {
      const line = el('div', '', path);
      line.title = 'A context file that contributed to the prompt below';
      this.filesEl.appendChild(line);
    }

    for (const section of view.sections) {
      // The author's own file is the one part of this a reader can go and change, so it is the
      // one section given the `authored` styling
      const authored = section.name.startsWith('PROJECT CONTEXT');
      const card = el('div', authored ? 'sp-card authored' : 'sp-card');
      const head = el('h2', '', section.name);
      head.title = authored
        ? 'Your AICONTEXT.md, quoted into the prompt verbatim'
        : 'Sent to the model exactly as shown';
      const text = el('div', 'sp-text', section.text);
      text.title = 'Read-only — the prompt is assembled per turn, not stored';
      card.append(head, text);
      this.body.appendChild(card);
    }
  }
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

registerEditor(SystemPromptEditor, 'vn.SystemPromptEditor');

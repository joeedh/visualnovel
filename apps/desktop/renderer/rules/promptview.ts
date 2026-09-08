/**
 * Decisions the prompt half of the asset editor makes before it draws: how a chunk reads, where its
 * `⇱` button goes, what the mode strip offers, and how holding reads as a sentence
 * (`docs/plans/archive/INDEX.md#chunked-prompts` §7, §8, §9).
 *
 * These functions are pure because the desktop jest project is node-only and the pane itself can
 * only be checked live over CDP, so everything that is a rule rather than markup is tested here.
 * Parallel to `assetview.ts`, which does the same job for the rest of that pane.
 */
import type { ChunkOrigin } from '@vn/types';
import { TOP_CHUNK } from '../../src/shared/promptops.js';
import type { PromptChunkInfo, PromptView } from '../../src/shared/prompt.js';
import { refuse, type Action, type Offer } from './anchors.js';

/**
 * The hue distinguishes who wrote the words. `--sodium` means they come verbatim out of a
 * document an author edits, `--signal` means the builders wrote the sentence. Twelve categories
 * cannot be twelve hues, so the tag and the rail's texture carry the category instead.
 */
export function chunkVoice(chunk: PromptChunkInfo): 'sodium' | 'signal' {
  switch (chunk.category) {
    case 'subject':
    case 'framing':
    case 'scaffolding':
      return 'signal';
    default:
      return 'sodium';
  }
}

/**
 * The rail's texture. Twelve categories cannot be twelve hues or twelve textures, so this groups
 * them into the words the author wrote plainly, the words a builder assembled, and the addenda
 * appended at the end. The mono tag names the exact category.
 */
export function chunkTexture(chunk: PromptChunkInfo): 'solid' | 'dash' | 'dot' {
  switch (chunk.category) {
    case 'art-notes':
    case 'request':
      return 'dash';
    case 'framing':
    case 'scaffolding':
      return 'dot';
    default:
      return 'solid';
  }
}

/** The mono uppercase tag on a card: the category, plus what an override did to it. */
export function chunkTag(chunk: PromptChunkInfo): string {
  const name = chunk.category.replace(/-/g, ' ').toUpperCase();
  if (chunk.edit === 'replace') return `${name} · REPLACED`;
  if (chunk.edit === 'append') return `${name} · APPENDED`;
  return name;
}

/** The card's address — the document rung behind the words, or `built in` when there is none. */
export function chunkAddress(origin: ChunkOrigin): string {
  switch (origin.kind) {
    case 'project':
      return `project#${origin.field}`;
    case 'character':
      return `character:${origin.id}#${origin.field}`;
    case 'outfit':
      return `character:${origin.id}/${origin.outfit}`;
    case 'location':
      return `location:${origin.id}#${origin.field}`;
    case 'variant':
      return `location:${origin.id}/${origin.variant}`;
    case 'shot':
      return `shot:${origin.sceneId}/${origin.shotId}#${origin.field}`;
    case 'art-notes':
      return origin.target;
    case 'request':
      return 'the sentence it was asked for';
    case 'builder':
      return 'built in';
  }
}

/** Where the `⇱` button goes: another editor, somewhere further down this pane, or nowhere. */
export type OriginAction =
  | {
      ok: true;
      kind: 'open';
      editor: string;
      subject: string;
      /** `ShellState` fields to publish before the editor opens — see {@link originAction}. */
      publish: Record<string, string>;
      label: string;
    }
  | { ok: true; kind: 'scroll'; to: string; label: string }
  | { ok: false; reason: string };

/**
 * The routing table, which answers with either an open or a scroll.
 *
 * A shot needs two selection fields, so it cannot be addressed by `view.open`'s single `subject`.
 * The pane publishes the selection and then opens, following `showTask()`'s pattern. The ordering
 * is load-bearing: the new pane reads the selection on its first `update()`, so publishing after
 * the open shows the previous selection. A shot chunk must never route to `wiki`, because
 * `doc.write` refuses `scenes/**` and prose has exactly one write path.
 */
export function originAction(origin: ChunkOrigin): OriginAction {
  switch (origin.kind) {
    case 'project':
      return {
        ok     : true,
        kind   : 'open',
        editor : 'project',
        subject: '',
        publish: {},
        label  : 'Open project.yaml',
      };
    case 'character':
    case 'outfit':
      return {
        ok     : true,
        kind   : 'open',
        editor : 'wiki',
        subject: `characters/${origin.id}/character.md`,
        publish: { characterId: origin.id },
        label  : `Open ${origin.id}'s sheet`,
      };
    case 'location':
    case 'variant':
      return {
        ok     : true,
        kind   : 'open',
        editor : 'wiki',
        subject: `locations/${origin.id}.md`,
        publish: { docPath: `locations/${origin.id}.md` },
        label  : `Open ${origin.id}'s sheet`,
      };
    case 'shot':
      return {
        ok     : true,
        kind   : 'open',
        editor : 'timeline',
        subject: '',
        publish: { sceneId: origin.sceneId, shotId: origin.shotId },
        label  : `Show ${origin.shotId} in the timeline`,
      };
    case 'art-notes':
      return { ok: true, kind: 'scroll', to: origin.target, label: 'Edit these art notes' };
    case 'request':
      return { ok: true, kind: 'scroll', to: 'request', label: 'Edit the request' };
    case 'builder':
      return {
        ok    : false,
        reason: 'The builders wrote this sentence — there is no document behind it.',
      };
  }
}

/** One segment of the mode strip: whether it is on, and what a click runs. */
export interface ModeButton {
  id: 'chunks' | 'custom' | 'agent';
  active: boolean;
  /** A refusal names its command too, so a greyed segment is still an anchor rather than a gap. */
  offer: Offer;
}

/** Which command each segment runs, so a refused segment still names what it is about. */
const MODE_SEGMENTS: Record<ModeButton['id'], { command: string; label: string; tooltip: string }> =
  {
    chunks: {
      command: 'prompt.clear',
      label  : 'Chunks',
      tooltip: 'Send the clauses below as they stand, dropping the whole-prompt text in force',
    },
    custom: {
      command: 'prompt.setCustom',
      label  : 'Custom',
      tooltip: 'Write the whole prompt yourself, starting from the text composed above',
    },
    agent: {
      command: 'prompt.condense',
      label  : 'Agent',
      tooltip: 'Have a model condense the clauses into one prompt',
    },
  };

/**
 * The three modes, as three commands. Nothing here sets a mode field, because a mode is a
 * consequence of what is written: `Chunks` clears whatever whole-prompt text is in force, `Custom`
 * writes the composed text whole (so the style preamble and the framing sentence survive the edit
 * by default), and `Agent` condenses. A disabled segment carries its refusal above its tooltip.
 */
export function modeStrip(view: PromptView): ModeButton[] {
  const frozen = view.frozen;
  // Entering a mode is an action of its own, or another module's offer with its own refusal
  const seg = (id: ModeButton['id'], enter: Action | Offer): ModeButton => {
    const { command, label, tooltip } = MODE_SEGMENTS[id];
    const control = { id: command, label, tooltip, on: id };
    const entered: Offer =
      'ok' in enter ? { ...enter, ...control } : { ok: true, ...enter, ...control };
    return {
      id,
      active: view.mode === id,
      offer: frozen
        ? { ...refuse(frozen), ...control }
        : view.mode === id
          ? { ...refuse(`This prompt is already in ${id} mode.`), ...control }
          : entered,
    };
  };

  return [
    seg('chunks', {
      id   : 'prompt.clear',
      props: { hash: view.hash, part: view.mode === 'agent' ? 'agent' : 'custom' },
    }),
    seg('custom', {
      id   : 'prompt.setCustom',
      props: { hash: view.hash, text: view.text },
    }),
    seg('agent', condenseAction(view)),
  ];
}

/**
 * The sentence `prompt.condense`'s own check gives when it is asked to discard a custom prompt.
 * Exported so the button and the command say the same words rather than two that drifted.
 */
export const condenseNeedsForce = (hash: string): string =>
  `A custom prompt is already written. prompt.condense(hash='${hash}' force=true) reconciles it ` +
  `against the chunks instead of discarding it.`;

/**
 * The Condense control: the invocation it runs, or why there is nothing to condense. Condensing
 * from custom mode passes `force`, because refusing would leave an author who wrote a custom
 * prompt with no way back to an agent one. {@link condenseNeedsForce} is what the command says
 * when the flag is absent. The button supplies the flag and says what it will do with the text it
 * is about to reconcile.
 */
export function condenseAction(view: PromptView): Offer {
  const id = 'prompt.condense';
  const plain = 'Rewrite the chunks into one prompt an image model handles well.';
  if (view.frozen) return { ...refuse(view.frozen), id, label: 'Condense…', tooltip: plain };
  if (view.chunks.length === 0) {
    return {
      ...refuse('There are no chunks to condense.'),
      id,
      label  : 'Condense…',
      tooltip: plain,
    };
  }
  if (view.mode === 'custom') {
    return {
      ok: true,
      id,
      props  : { hash: view.hash, force: true },
      label  : 'Reconcile…',
      tooltip: 'Your custom prompt is handed to the model as the thing to preserve.',
    };
  }
  return {
    ok: true,
    id,
    props  : { hash: view.hash },
    label  : view.held ? 'Recondense' : 'Condense…',
    tooltip: view.held
      ? 'Condense the chunks as they stand now, replacing the held prompt.'
      : plain,
  };
}

/**
 * The held banner, or an empty string when there is none. Like `driftNote`, the banner names what
 * changed underneath rather than only that something did, and says why the stale text is still
 * the text being sent.
 */
export function heldNote(view: PromptView): string {
  if (!view.held) return '';
  return (
    'This prompt was condensed from chunks that have since changed. It is still what gets sent — ' +
    're-rendering it would move the task hash and re-render the asset — so recondense when you ' +
    'are ready for that.'
  );
}

/** One thumbnail in a chunk's reference strip: what it shows, and what its tooltip says. */
export interface RefChip {
  pin: string;
  ext: string;
  label: string;
  /** Greyed on a muted chunk, because neither its clause nor its references are being sent. */
  muted: boolean;
  drift: boolean;
  title: string;
}

/**
 * The strip under a card. A reference is evidence for its clause, so a muted chunk still shows its
 * references (dropping them silently would leave an author wondering where they went) and says
 * they are not being sent.
 */
export function refStrip(chunk: PromptChunkInfo): RefChip[] {
  return (chunk.refs ?? []).map((ref) => ({
    pin  : ref.pin,
    ext  : ref.ext,
    label: ref.label,
    muted: chunk.muted,
    drift: !!ref.drift,
    title: [
      ref.label,
      ref.from ? `follows ${ref.from}` : 'pinned by hash — it follows nothing',
      ref.drift ? 'that slot holds something else now; prompt.repin moves the pin to it' : '',
      chunk.muted ? 'this clause is muted, so it is not being sent' : '',
    ]
      .filter(Boolean)
      .join(' · '),
  }));
}

/** One act on a clause: the invocation a click runs, and what the click opens on the way. */
export interface ChunkAct {
  key: 'mute' | 'replace' | 'append' | 'attach' | 'reset';
  offer: Offer;
  /**
   * The box this click opens instead of running the offer at once. `text` is typed into it and
   * arrives as a supplied prop, which is why the two boxed acts record `supplies` rather than a
   * complete invocation.
   */
  opens?: 'replace' | 'append';
  /**
   * The click opens the asset gallery instead of running the offer at once. The hash the author
   * picks arrives as the supplied `ref` prop, which is why this act names it in `supplies`.
   */
  picks?: true;
}

/**
 * The five acts on one clause. `Reset` is also how a mute comes off — `prompt.setChunk(op=clear)`
 * discards everything done to the chunk, which is one act to explain rather than two.
 *
 * Four of the five are the same command with a different `op`, so the strip is a list rather than
 * hand-wired buttons, and each carries the invocation the click runs rather than a description of
 * it. Attach is the exception: a different command, and one whose `ref` the gallery supplies.
 */
export function chunkActs(view: PromptView, chunk: PromptChunkInfo): ChunkAct[] {
  const at = (key: ChunkAct['key']): string => `${chunk.key}/${key}`;
  const setChunk = (
    key: ChunkAct['key'],
    op: string,
    text?: string,
  ): Action & { ok: true; on: string } => ({
    ok   : true,
    id   : 'prompt.setChunk',
    props: { hash: view.hash, chunk: chunk.key, op, ...(text === undefined ? {} : { text }) },
    on   : at(key),
  });
  const nothingDone = !chunk.muted && !chunk.edit;

  return [
    {
      key  : 'mute',
      offer: {
        ...(chunk.muted ? refuse('Already muted.') : setChunk('mute', 'mute', '')),
        id     : 'prompt.setChunk',
        label  : 'Mute',
        tooltip: 'Leave this clause out of the prompt',
        on     : at('mute'),
      },
    },
    {
      key  : 'replace',
      offer: {
        ...setChunk('replace', 'replace'),
        label   : 'Replace…',
        tooltip : 'Say this clause in your own words',
        supplies: ['text'],
      },
      opens: 'replace',
    },
    {
      key  : 'append',
      offer: {
        ...setChunk('append', 'append'),
        label   : 'Append…',
        tooltip : 'Add to what the builders derived, keeping it',
        supplies: ['text'],
      },
      opens: 'append',
    },
    {
      key  : 'attach',
      offer: {
        ok      : true,
        id      : 'prompt.addRef',
        props   : { hash: view.hash, chunk: chunk.key },
        label   : 'Attach…',
        tooltip : 'Send a reference image with this clause',
        on      : at('attach'),
        supplies: ['ref'],
      },
      picks: true,
    },
    {
      key  : 'reset',
      offer: {
        ...(nothingDone
          ? refuse('Nothing has been done to this clause.')
          : setChunk('reset', 'clear', '')),
        id     : 'prompt.setChunk',
        label  : 'Reset',
        tooltip: 'Go back to the words the builders derived',
        on     : at('reset'),
      },
    },
  ];
}

/** Detach one reference image from a clause. Its own function so the strip records what it runs. */
export function dropRefAction(
  view: PromptView,
  chunk: PromptChunkInfo,
  ref: Pick<RefChip, 'pin' | 'label'>,
): Offer {
  return {
    ok     : true,
    id     : 'prompt.dropRef',
    props  : { hash: view.hash, chunk: chunk.key, ref: ref.pin },
    label  : '×',
    tooltip: `Stop sending ${ref.label} with this clause`,
    on     : `${chunk.key}/${ref.pin}`,
  };
}

/**
 * The whole prompt, written by hand. The text is supplied by the box, so the offer carries only
 * the subject and names the text as what is still owed.
 */
export function customAction(view: PromptView): Offer {
  const control = {
    id      : 'prompt.setCustom',
    label   : 'Save',
    tooltip : 'Send this prompt instead of the clauses below',
    supplies: ['text'],
  };
  if (view.frozen) return { ...refuse(view.frozen), ...control };
  return { ok: true, props: { hash: view.hash }, ...control };
}

/** Which clauses the prompt in force no longer appears to say. Reads; writes nothing. */
export function checkAction(view: PromptView): Offer {
  return {
    ok     : true,
    id     : 'prompt.check',
    props  : { hash: view.hash },
    label  : 'Check',
    tooltip: 'Which clauses the prompt above no longer appears to say',
  };
}

/**
 * Every offer the prompt half draws from this module, in the order it draws them: the mode strip
 * and its two buttons, the custom prompt's Save, then each clause's five acts and the drops on its
 * references. The chunk boxes and the reference thumbnails are the editor's own.
 */
export function controls(view: PromptView): readonly Offer[] {
  const chunks = view.chunks.flatMap((chunk) => [
    ...chunkActs(view, chunk).map((act) => act.offer),
    ...(chunk.refs ?? []).map((ref) => dropRefAction(view, chunk, ref)),
  ]);
  return [
    ...modeStrip(view).map((segment) => segment.offer),
    condenseAction(view),
    checkAction(view),
    customAction(view),
    ...chunks,
  ];
}

/** One card's vertical extent on screen, which is all the drop geometry reads. */
export interface ChunkRow {
  key: string;
  top: number;
  bottom: number;
}

/**
 * The insertion point a pointer at `y` names, in `prompt.moveChunk`'s own vocabulary:
 * {@link TOP_CHUNK} above the first card's midpoint, otherwise the last card whose midpoint the
 * pointer has passed.
 *
 * Uses midpoints rather than the gaps between cards, for the reason `shotDropTarget` gives: a gap
 * is a hairline, so an author cannot aim at an insertion point defined by one.
 */
export function chunkDropTarget(rows: readonly ChunkRow[], y: number): string {
  let target = TOP_CHUNK;
  for (const row of rows) {
    if (y >= (row.top + row.bottom) / 2) target = row.key;
  }
  return target;
}

/**
 * The coverage marker on a card in custom or agent mode. In chunks mode every chunk already forms
 * the prompt, so there is nothing to check. The wording is deliberately passive because this is a
 * word-match heuristic: a surface says "not found", never "the agent dropped it".
 */
export function coverageMark(
  view: PromptView,
  chunk: PromptChunkInfo,
): { mark: string; found: boolean; title: string } | undefined {
  if (view.mode === 'chunks' || chunk.muted) return undefined;
  const found = !view.missing.includes(chunk.key);
  return {
    mark: found ? '✓' : '✗',
    found,
    title: found
      ? 'The prompt above appears to say this.'
      : 'Not found in the prompt above — check it before regenerating.',
  };
}

/**
 * The override algebra: replace, append, mute, reorder, and the two whole-prompt modes
 * (`docs/plans/archive/chunked-prompts.md` §18).
 *
 * The hold is the load-bearing case. An agent-condensed prompt whose chunks have moved must keep
 * returning the stored text. Falling back to freshly rendered chunks would move the task hash and
 * re-render the asset, which is what holding exists to prevent.
 */
import type { PromptChunk, PromptOverride } from '@vn/types';
import { sha256 } from '@vn/util';
import { chunkFingerprint, composePrompt, effectiveChunks, renderPrompt } from '../index.js';

function chunks(...texts: [string, string][]): PromptChunk[] {
  return texts.map(([key, text]) => ({
    key,
    category: 'description' as const,
    text,
    origin: { kind: 'builder' as const },
  }));
}

const BASE = chunks(
  ['style', 'Art style: watercolor.'],
  ['subject', 'A cat.'],
  ['tail', 'No text.'],
);

const compose = (o?: PromptOverride) => composePrompt(BASE, o).text;

describe('per-chunk operations', () => {
  it('renders the derived list when nothing is overridden', () => {
    expect(compose()).toBe('Art style: watercolor. A cat. No text.');
    expect(compose({ mode: 'chunks' })).toBe(renderPrompt(BASE));
  });

  it('replaces a chunk', () => {
    expect(compose({ mode: 'chunks', replace: { subject: { text: 'A dog.' } } })).toBe(
      'Art style: watercolor. A dog. No text.',
    );
  });

  it('appends after replacing, on the same chunk', () => {
    const text = compose({
      mode: 'chunks',
      replace: { subject: { text: 'A dog.' } },
      append: { subject: { text: 'Sitting.' } },
    });
    expect(text).toBe('Art style: watercolor. A dog. Sitting. No text.');
  });

  it('mutes a chunk', () => {
    expect(compose({ mode: 'chunks', mute: ['subject'] })).toBe('Art style: watercolor. No text.');
  });

  it('mutes a chunk it also replaced — the mute wins', () => {
    expect(
      compose({ mode: 'chunks', mute: ['subject'], replace: { subject: { text: 'A dog.' } } }),
    ).toBe('Art style: watercolor. No text.');
  });

  it('marks an edit stale only when it records what it was written against', () => {
    const fresh = effectiveChunks(BASE, {
      mode: 'chunks',
      replace: { subject: { text: 'A dog.', of: sha256('A cat.') } },
    });
    expect(fresh.find((c) => c.key === 'subject')!.editStale).toBe(false);

    const moved = effectiveChunks(BASE, {
      mode: 'chunks',
      replace: { subject: { text: 'A dog.', of: sha256('A bird.') } },
    });
    expect(moved.find((c) => c.key === 'subject')!.editStale).toBe(true);

    const unknown = effectiveChunks(BASE, {
      mode: 'chunks',
      replace: { subject: { text: 'A dog.' } },
    });
    expect(unknown.find((c) => c.key === 'subject')!.editStale).toBeUndefined();
  });
});

describe('order', () => {
  it('puts the named keys first, in the order named', () => {
    expect(compose({ mode: 'chunks', order: ['tail', 'subject'] })).toBe(
      'No text. A cat. Art style: watercolor.',
    );
  });

  it('ignores a key that names no chunk', () => {
    expect(compose({ mode: 'chunks', order: ['ghost', 'tail'] })).toBe(
      'No text. Art style: watercolor. A cat.',
    );
  });

  it('never drops a chunk a later builder added', () => {
    const grown = [...BASE, ...chunks(['brandnew', 'Newly derived.'])];
    const o: PromptOverride = { mode: 'chunks', order: ['tail', 'style', 'subject'] };
    expect(composePrompt(grown, o).text).toBe(
      'No text. Art style: watercolor. A cat. Newly derived.',
    );
  });
});

describe('chunkFingerprint', () => {
  it('round-trips through mute and unmute', () => {
    const muted: PromptOverride = { mode: 'chunks', mute: ['subject'] };
    expect(chunkFingerprint(BASE, muted)).not.toBe(chunkFingerprint(BASE));
    expect(chunkFingerprint(BASE, { mode: 'chunks', mute: [] })).toBe(chunkFingerprint(BASE));
  });

  it('is sensitive to order and to text', () => {
    expect(chunkFingerprint(BASE, { mode: 'chunks', order: ['tail'] })).not.toBe(
      chunkFingerprint(BASE),
    );
    expect(
      chunkFingerprint(BASE, { mode: 'chunks', replace: { subject: { text: 'A dog.' } } }),
    ).not.toBe(chunkFingerprint(BASE));
  });
});

describe('whole-prompt modes', () => {
  it('sends the custom text verbatim, trimmed only', () => {
    const out = composePrompt(BASE, { mode: 'custom', custom: '  A cat, painted.  ' });
    expect(out.text).toBe('A cat, painted.');
    expect(out.held).toBe(false);
    // The chunk list survives so the pane can still show what the custom text is standing in for.
    expect(out.chunks).toHaveLength(3);
  });

  it('prefers custom over an agent condensation that is also stored', () => {
    const out = composePrompt(BASE, {
      mode: 'custom',
      custom: 'Mine.',
      agent: { text: 'Theirs.', of: chunkFingerprint(BASE) },
    });
    expect(out.text).toBe('Mine.');
  });

  it('sends a current agent prompt and does not hold it', () => {
    const out = composePrompt(BASE, {
      mode: 'agent',
      agent: { text: 'Watercolor cat, no text.', of: chunkFingerprint(BASE) },
    });
    expect(out.text).toBe('Watercolor cat, no text.');
    expect(out.held).toBe(false);
  });

  it('holds a stale agent prompt: the text does not move, only the flag', () => {
    const o: PromptOverride = {
      mode: 'agent',
      agent: { text: 'Watercolor cat, no text.', of: sha256('something else') },
    };
    const out = composePrompt(BASE, o);
    expect(out.held).toBe(true);
    // The stored text is returned unchanged, which is what keeps the task hash where it is
    expect(out.text).toBe('Watercolor cat, no text.');
    expect(out.text).not.toBe(renderPrompt(BASE));
  });

  it('falls back to the chunks when a mode names text that is not there', () => {
    expect(compose({ mode: 'custom' })).toBe(renderPrompt(BASE));
    expect(compose({ mode: 'agent' })).toBe(renderPrompt(BASE));
  });
});

import type { PromptChunk, PromptOverride } from '@vn/types';
import { chunkFingerprint } from '@vn/artgen';
import { sha256 } from '@vn/util';
import { applyPromptEdit } from '../promptedit.js';

const chunks: PromptChunk[] = [
  {
    key: 'style',
    category: 'style',
    origin: { kind: 'project', field: 'art_style' },
    text: 'Watercolour.',
  },
  {
    key: 'subject',
    category: 'subject',
    origin: { kind: 'character', id: 'aiko', field: 'appearance' },
    text: 'Aiko.',
  },
  {
    key: 'palette',
    category: 'palette',
    origin: { kind: 'project', field: 'art_style' },
    text: 'Muted blues.',
  },
];

/** The result's override, or a failure the test wanted to succeed. */
function overrideOf(result: ReturnType<typeof applyPromptEdit>): PromptOverride | undefined {
  if (!result.ok) throw new Error(`expected an accept, got: ${result.reason}`);
  return result.override;
}

describe('applyPromptEdit — refusals', () => {
  it('names the chunks it has when the edit names one it does not', () => {
    const result = applyPromptEdit(chunks, undefined, {
      op: 'chunk',
      chunk: 'mood',
      how: 'mute',
      text: '',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'No chunk "mood" in this prompt. It has: style, subject, palette.',
    });
  });

  it('refuses to mute a chunk that is already muted', () => {
    const current: PromptOverride = { mode: 'chunks', mute: ['style'] };
    const result = applyPromptEdit(chunks, current, {
      op: 'chunk',
      chunk: 'style',
      how: 'mute',
      text: '',
    });
    expect(result).toEqual({ ok: false, reason: '"style" is already muted.' });
  });

  it('refuses to clear a chunk with nothing on it', () => {
    const result = applyPromptEdit(chunks, undefined, {
      op: 'chunk',
      chunk: 'style',
      how: 'clear',
      text: '',
    });
    expect(result).toEqual({ ok: false, reason: '"style" has no override to clear.' });
  });

  it('refuses an empty replacement, and names the op that restores the words', () => {
    const result = applyPromptEdit(chunks, undefined, {
      op: 'chunk',
      chunk: 'style',
      how: 'replace',
      text: '   ',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('prompt.setChunk(op=clear)');
  });

  it('refuses an empty custom prompt, and names the part that goes back', () => {
    const result = applyPromptEdit(chunks, undefined, { op: 'custom', text: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('prompt.clear(part=custom)');
  });

  it('refuses to clear a part that is not there', () => {
    for (const part of ['all', 'chunks', 'order', 'custom', 'agent'] as const) {
      expect(applyPromptEdit(chunks, undefined, { op: 'clear', part }).ok).toBe(false);
    }
  });
});

describe('applyPromptEdit — writes', () => {
  it('stamps a replacement with the derived text it was written against', () => {
    const override = overrideOf(
      applyPromptEdit(chunks, undefined, {
        op: 'chunk',
        chunk: 'palette',
        how: 'replace',
        text: '  Warm ochres.  ',
      }),
    );
    expect(override).toEqual({
      mode: 'chunks',
      replace: { palette: { text: 'Warm ochres.', of: sha256('Muted blues.') } },
    });
  });

  it('appends without touching a replacement of another chunk', () => {
    const current: PromptOverride = { mode: 'chunks', replace: { style: { text: 'Ink.' } } };
    const override = overrideOf(
      applyPromptEdit(chunks, current, {
        op: 'chunk',
        chunk: 'palette',
        how: 'append',
        text: 'A little gold.',
      }),
    );
    expect(override?.replace).toEqual({ style: { text: 'Ink.' } });
    expect(override?.append?.palette?.text).toBe('A little gold.');
  });

  it('moves a chunk through the same rule the drag previews', () => {
    const override = overrideOf(
      applyPromptEdit(chunks, undefined, { op: 'move', chunk: 'palette', after: '' }),
    );
    expect(override?.order).toEqual(['palette', 'style', 'subject']);
  });

  it('refuses a move that would change nothing', () => {
    const result = applyPromptEdit(chunks, undefined, {
      op: 'move',
      chunk: 'subject',
      after: 'style',
    });
    expect(result.ok).toBe(false);
  });

  it('fingerprints an agent prompt over the chunks as the override leaves them', () => {
    const current: PromptOverride = { mode: 'chunks', mute: ['palette'] };
    const override = overrideOf(
      applyPromptEdit(chunks, current, { op: 'agent', text: 'Aiko in watercolour.' }),
    );
    expect(override?.mode).toBe('agent');
    expect(override?.agent?.of).toBe(chunkFingerprint(chunks, current));
    // The mute is what makes the fingerprint differ from the unoverridden one; if it did not,
    // muting a chunk after condensing would silently send a prompt the model never saw.
    expect(override?.agent?.of).not.toBe(chunkFingerprint(chunks, { mode: 'chunks' }));
  });

  it('carries the model and the timestamp when the caller supplies them', () => {
    const override = overrideOf(
      applyPromptEdit(chunks, undefined, {
        op: 'agent',
        text: 'Aiko.',
        modelId: 'claude-opus-4-8',
        at: '2026-01-01T00:00:00.000Z',
      }),
    );
    expect(override?.agent).toMatchObject({
      modelId: 'claude-opus-4-8',
      at: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('applyPromptEdit — settling back to nothing', () => {
  it('returns no override at all once the last thing on it is cleared', () => {
    const current: PromptOverride = { mode: 'chunks', mute: ['style'] };
    const result = applyPromptEdit(chunks, current, {
      op: 'chunk',
      chunk: 'style',
      how: 'clear',
      text: '',
    });
    expect(result).toEqual({
      ok: true,
      note: 'Restored the derived words of "style".',
    });
  });

  it('clears everything with part=all', () => {
    const current: PromptOverride = { mode: 'custom', custom: 'By hand.', mute: ['style'] };
    expect(applyPromptEdit(chunks, current, { op: 'clear', part: 'all' })).toEqual({
      ok: true,
      note: 'Cleared the override; the prompt is the derived chunks again.',
    });
  });

  it('falls back to chunks mode when the text that mode named is discarded', () => {
    const current: PromptOverride = { mode: 'custom', custom: 'By hand.', order: ['palette'] };
    const override = overrideOf(applyPromptEdit(chunks, current, { op: 'clear', part: 'custom' }));
    expect(override).toEqual({ mode: 'chunks', order: ['palette'] });
  });

  it('keeps the other half when only one is cleared', () => {
    const current: PromptOverride = {
      mode: 'agent',
      mute: ['style'],
      agent: { text: 'Aiko.', of: 'abc' },
    };
    const override = overrideOf(applyPromptEdit(chunks, current, { op: 'clear', part: 'chunks' }));
    expect(override).toEqual({ mode: 'agent', agent: { text: 'Aiko.', of: 'abc' } });
  });
});

describe('applyPromptEdit — repin', () => {
  const pinned: PromptOverride = {
    mode: 'chunks',
    refs: {
      subject: [
        { pin: 'oldportrait', ext: 'png', from: { kind: 'portrait', characterId: 'aiko' } },
        { pin: 'anupload', ext: 'png' },
      ],
    },
  };

  it('moves the one reference it names and leaves the rest of the list alone', () => {
    const override = overrideOf(
      applyPromptEdit(chunks, pinned, {
        op: 'repin',
        chunk: 'subject',
        ref: 'oldportrait',
        to: 'newportrait',
        ext: 'png',
      }),
    );
    expect(override?.refs?.['subject']).toEqual([
      { pin: 'newportrait', ext: 'png', from: { kind: 'portrait', characterId: 'aiko' } },
      { pin: 'anupload', ext: 'png' },
    ]);
  });

  // An upload names no slot, so it is a fixed point by construction — the refusal says so rather
  // than letting an author pin it somewhere it can never drift back from.
  it('refuses an unlinked reference', () => {
    const result = applyPromptEdit(chunks, pinned, {
      op: 'repin',
      chunk: 'subject',
      ref: 'anupload',
      to: 'newportrait',
      ext: 'png',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('unlinked reference');
  });

  it('lists what the chunk has when the reference is not one of them', () => {
    const result = applyPromptEdit(chunks, pinned, {
      op: 'repin',
      chunk: 'subject',
      ref: 'somethingelse',
      to: 'newportrait',
      ext: 'png',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('oldportr');
  });

  it('refuses a chunk carrying no references at all', () => {
    const result = applyPromptEdit(chunks, pinned, {
      op: 'repin',
      chunk: 'palette',
      ref: 'oldportrait',
      to: 'newportrait',
      ext: 'png',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no reference images');
  });

  it('refuses a repin that would not move anything', () => {
    const result = applyPromptEdit(chunks, pinned, {
      op: 'repin',
      chunk: 'subject',
      ref: 'oldportrait',
      to: 'oldportrait',
      ext: 'png',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('already pins');
  });
});

describe('applyPromptEdit — addRef and dropRef', () => {
  const pinned: PromptOverride = {
    mode: 'chunks',
    refs: {
      subject: [
        { pin: 'oldportrait', ext: 'png', from: { kind: 'portrait', characterId: 'aiko' } },
        { pin: 'anupload', ext: 'png' },
      ],
    },
  };

  it('appends to the chunk it names, keeping authored order', () => {
    const override = overrideOf(
      applyPromptEdit(chunks, pinned, {
        op: 'addRef',
        chunk: 'subject',
        ref: {
          pin: 'aplate',
          ext: 'png',
          from: { kind: 'plate', locationId: 'cafe', variant: 'night' },
        },
      }),
    );
    expect(override?.refs?.['subject']?.map((r) => r.pin)).toEqual([
      'oldportrait',
      'anupload',
      'aplate',
    ]);
  });

  it('starts a chunk that had no references', () => {
    const override = overrideOf(
      applyPromptEdit(chunks, undefined, {
        op: 'addRef',
        chunk: 'palette',
        ref: { pin: 'anupload', ext: 'png' },
      }),
    );
    expect(override?.refs).toEqual({ palette: [{ pin: 'anupload', ext: 'png' }] });
  });

  it('names the chunks it has when the edit names one it does not', () => {
    const result = applyPromptEdit(chunks, pinned, {
      op: 'addRef',
      chunk: 'mood',
      ref: { pin: 'anupload', ext: 'png' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('No chunk "mood"');
  });

  // `refs` is inside the task hash and maps positionally, so a duplicate is not free.
  it('refuses a reference the chunk already carries', () => {
    const result = applyPromptEdit(chunks, pinned, {
      op: 'addRef',
      chunk: 'subject',
      ref: { pin: 'anupload', ext: 'png' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('already a reference');
  });

  it('drops the one it names, by prefix, and leaves the rest', () => {
    const override = overrideOf(
      applyPromptEdit(chunks, pinned, { op: 'dropRef', chunk: 'subject', ref: 'oldport' }),
    );
    expect(override?.refs?.['subject']).toEqual([{ pin: 'anupload', ext: 'png' }]);
  });

  // Dropping the last one must leave a sheet that looks untouched, not an empty block.
  it('comes back to no override at all when the last reference goes', () => {
    const one: PromptOverride = {
      mode: 'chunks',
      refs: { subject: [{ pin: 'anupload', ext: 'png' }] },
    };
    const result = applyPromptEdit(chunks, one, {
      op: 'dropRef',
      chunk: 'subject',
      ref: 'anupload',
    });
    expect(result).toEqual({ ok: true, note: 'Removed anupload from "subject".' });
  });

  it('refuses a chunk carrying no references at all', () => {
    const result = applyPromptEdit(chunks, pinned, {
      op: 'dropRef',
      chunk: 'palette',
      ref: 'anupload',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no reference images');
  });
});

/**
 * The pure order rules behind `prompt.moveChunk` and the `prompt.reorder` gesture
 * (`docs/plans/chunked-prompts.md` §7).
 */
import { effectiveChunks } from '@vn/artgen';
import type { PromptChunk, PromptOverride } from '@vn/types';
import {
  effectiveOrder,
  enabledChunks,
  moveChunk,
  TOP_CHUNK,
  type OrderChunk,
  type PromptOrderState,
} from '../promptops.js';

const chunks: OrderChunk[] = [
  { key: 'style', text: 'Watercolour.' },
  { key: 'subject', text: 'Aiko.' },
  { key: 'palette', text: 'Palette: #112233.' },
  { key: 'scaffolding', text: 'No text.' },
];

const keysOf = (list: readonly OrderChunk[]): string[] => list.map((c) => c.key);

const state = (over: Partial<PromptOrderState> = {}): PromptOrderState => ({
  chunks,
  mode: 'chunks',
  ...over,
});

describe('effectiveOrder', () => {
  it('keeps derivation order when nothing is written', () => {
    expect(keysOf(effectiveOrder(chunks))).toEqual(['style', 'subject', 'palette', 'scaffolding']);
    expect(keysOf(effectiveOrder(chunks, []))).toEqual(keysOf(chunks));
  });

  it('is a partial order: named keys first, then everything else as derived', () => {
    expect(keysOf(effectiveOrder(chunks, ['palette', 'style']))).toEqual([
      'palette',
      'style',
      'subject',
      'scaffolding',
    ]);
  });

  it('ignores a key naming no chunk, and never loses a chunk the order omits', () => {
    const order = ['gone', 'scaffolding'];
    expect(keysOf(effectiveOrder(chunks, order))).toEqual([
      'scaffolding',
      'style',
      'subject',
      'palette',
    ]);
  });

  // The one function in this file that is duplicated across a package boundary — artgen is
  // node-side and `shared/` is in the browser bundle — so the two are pinned together here.
  it('agrees with the reordering @vn/artgen does inside composePrompt', () => {
    const derived: PromptChunk[] = chunks.map((c) => ({
      key: c.key,
      category: 'style',
      text: c.text!,
      origin: { kind: 'builder' },
    }));
    for (const order of [undefined, ['palette', 'style'], ['gone', 'scaffolding'], []]) {
      const o = order ? ({ mode: 'chunks', order } satisfies PromptOverride) : undefined;
      expect(keysOf(effectiveChunks(derived, o))).toEqual(keysOf(effectiveOrder(chunks, order)));
    }
  });
});

describe('enabledChunks', () => {
  it('drops the muted and the empty — neither is sent', () => {
    expect(
      keysOf(
        enabledChunks([
          { key: 'a', text: 'One.' },
          { key: 'b', text: 'Two.', muted: true },
          { key: 'c', text: '' },
          { key: 'd' },
        ]),
      ),
    ).toEqual(['a']);
  });
});

describe('moveChunk', () => {
  it('writes the complete order, not only the keys it touched', () => {
    const op = moveChunk(state(), { chunk: 'palette', after: '' });
    expect(op.ok && op.order).toEqual(['palette', 'style', 'subject', 'scaffolding']);
    expect(op.ok && op.message).toBe('palette now sits first.');
  });

  it('puts the chunk directly after the one it was dropped on', () => {
    const op = moveChunk(state(), { chunk: 'style', after: 'palette' });
    expect(op.ok && op.order).toEqual(['subject', 'palette', 'style', 'scaffolding']);
    expect(op.ok && op.message).toBe('style now sits after palette.');
  });

  it('moves within the order already in force, not the derivation order', () => {
    const s = state({ order: ['scaffolding', 'palette'] });
    // Effective: scaffolding, palette, style, subject.
    const op = moveChunk(s, { chunk: 'subject', after: 'scaffolding' });
    expect(op.ok && op.order).toEqual(['scaffolding', 'subject', 'palette', 'style']);
  });

  it('refuses a drop that changes nothing, and says it is a no-op', () => {
    const already = moveChunk(state(), { chunk: 'subject', after: 'style' });
    expect(already).toEqual({ ok: false, error: 'subject is already where it is.', noop: true });
    expect(moveChunk(state(), { chunk: 'style', after: '' })).toMatchObject({ noop: true });
    expect(moveChunk(state(), { chunk: 'style', after: 'style' })).toMatchObject({ noop: true });
  });

  it('refuses a chunk or an anchor the prompt does not have — and that is not a no-op', () => {
    expect(moveChunk(state(), { chunk: 'gone', after: '' })).toEqual({
      ok: false,
      error: 'No chunk "gone" in this prompt.',
      noop: false,
    });
    expect(moveChunk(state(), { chunk: 'style', after: 'gone' })).toEqual({
      ok: false,
      error: 'No chunk "gone" to sit after.',
      noop: false,
    });
  });

  it('warns, in agent mode only, that the condensation will be held', () => {
    const plain = moveChunk(state(), { chunk: 'palette', after: '' });
    const agent = moveChunk(state({ mode: 'agent' }), { chunk: 'palette', after: '' });
    expect(plain.ok && plain.message).not.toContain('held');
    expect(agent.ok && agent.message).toContain('held until it is recondensed');
    expect(agent.ok && agent.order).toEqual(plain.ok && plain.order);
  });

  it('reaches every position through some anchor, top included', () => {
    const anchors = ['', ...keysOf(chunks)];
    const reached = new Set<string>();
    for (const after of anchors) {
      const op = moveChunk(state(), { chunk: 'style', after });
      if (op.ok) reached.add(op.order.indexOf('style').toString());
    }
    // Four slots; the one it already occupies is refused as a no-op, so three are reachable.
    expect([...reached].sort()).toEqual(['1', '2', '3']);
    expect(TOP_CHUNK).toBe('top');
  });
});

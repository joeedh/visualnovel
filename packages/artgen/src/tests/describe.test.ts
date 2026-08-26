/**
 * Tests reading a picture back through a plain `ChatBackend` seam. The test records what was
 * actually sent (one image and one question) and pins the refusal that keeps an answer honest.
 */
import { SCRIPTS, makeProject } from '@vn/testkit';
import { RecordedChatBackend, type ChatRequest } from '@vn/providers';
import type { ImageProvider, ImageResult } from '@vn/types';
import { DEFAULT_QUESTION, describeAsset, generateConcept } from '../index.js';

const image: ImageProvider = {
  generate: (): Promise<ImageResult> =>
    Promise.resolve({
      bytes: new TextEncoder().encode('the picture itself'),
      ext: 'png',
      modelId: 'fake-image',
    }),
  edit: () => Promise.reject(new Error('a concept is generated, never edited')),
};

/** A project holding one real picture, plus a backend that records what it was asked. */
async function fixture() {
  const p = await makeProject({ script: SCRIPTS.branching });
  const { config, model, store } = await p.reload();
  const { ref } = await generateConcept(
    { config, model, store, image },
    { sentence: 'a brutalist rooftop', subject: { kind: 'location', id: 'rooftop' } },
  );
  const sent: ChatRequest[] = [];
  const backend = new RecordedChatBackend('fake-vision', (req) => {
    sent.push(req);
    return '  A grey concrete parapet under an evening sky.  ';
  });
  return { p, ref, sent, deps: { store, backend } };
}

describe('describeAsset', () => {
  it('sends the bytes with the question and answers in the picture’s own name', async () => {
    const { p, ref, sent, deps } = await fixture();
    try {
      const result = await describeAsset(deps, {
        hash: ref.hash,
        question: 'Does this read as brutalist yet?',
      });
      expect(result).toEqual({
        hash: ref.hash,
        label: 'a brutalist rooftop',
        answer: 'A grey concrete parapet under an evening sky.',
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.prompt).toBe('Does this read as brutalist yet?');
      expect(sent[0]!.images).toHaveLength(1);
      expect(sent[0]!.images![0]!.ext).toBe('png');
      expect(new TextDecoder().decode(sent[0]!.images![0]!.bytes)).toBe('the picture itself');
      expect(sent[0]!.system).toContain('do not invent detail');
    } finally {
      await p.cleanup();
    }
  });

  it('asks the widest question when the caller has none', async () => {
    const { p, ref, sent, deps } = await fixture();
    try {
      await describeAsset(deps, { hash: ref.hash, question: '   ' });
      expect(sent[0]!.prompt).toBe(DEFAULT_QUESTION);
    } finally {
      await p.cleanup();
    }
  });

  // A task that is queued but not run has no picture yet. Describing the previous render
  // instead would answer about the wrong image, which is worse than answering nothing
  it('refuses an asset the store has never heard of, and spends nothing', async () => {
    const { p, sent, deps } = await fixture();
    try {
      await expect(describeAsset(deps, { hash: 'f'.repeat(64) })).rejects.toThrow(
        'has not run has no picture to look at yet',
      );
      expect(sent).toHaveLength(0);
    } finally {
      await p.cleanup();
    }
  });
});

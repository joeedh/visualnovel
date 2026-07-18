import type { ShotSpec } from '@vn/types';
import {
  BackendImageProvider,
  ChatTextLLM,
  ChatVisionReviewer,
  RecordedChatBackend,
  StubImageBackend,
  createGeminiImage,
  mapRefLoader,
  mergeReports,
  supportsEffort,
} from './index.js';

const spec: ShotSpec = {
  description: 'Aiko smiles',
  characters: ['aiko'],
  location: 'classroom_day',
};
const loadRef = mapRefLoader();

describe('ChatVisionReviewer — VisionReviewer contract', () => {
  it('returns a structured DefectReport stamped with the reviewer id', async () => {
    const backend = new RecordedChatBackend('m', [
      '{"reviewer":"raw","defects":[{"severity":"major","category":"outfit","description":"wrong shirt"}]}',
    ]);
    const reviewer = new ChatVisionReviewer('gemini', backend, loadRef);
    const report = await reviewer.review({ hash: 'img', ext: 'png' }, spec, []);
    expect(report.reviewer).toBe('gemini');
    expect(report.defects).toHaveLength(1);
    expect(report.defects[0]!.severity).toBe('major');
  });

  it('retries past malformed model output (structured-output enforcement)', async () => {
    const backend = new RecordedChatBackend('m', [
      'not json at all',
      '{"reviewer":"x","defects":[]}',
    ]);
    const reviewer = new ChatVisionReviewer('claude', backend, loadRef);
    const report = await reviewer.review({ hash: 'img', ext: 'png' }, spec, []);
    expect(report.defects).toEqual([]);
  });
});

describe('mergeReports', () => {
  it('flags blocking when any reviewer reports a blocking defect', () => {
    const merged = mergeReports([
      { reviewer: 'gemini', defects: [{ severity: 'minor', category: 'c', description: 'd' }] },
      { reviewer: 'claude', defects: [{ severity: 'blocking', category: 'c', description: 'd' }] },
    ]);
    expect(merged.blocking).toBe(true);
    expect(merged.defects).toHaveLength(2);
  });
});

describe('ChatTextLLM', () => {
  it('completes via the backend', async () => {
    const llm = new ChatTextLLM(new RecordedChatBackend('m', ['hello']));
    expect(await llm.complete('hi')).toBe('hello');
  });

  it('structured() retries when the parser throws', async () => {
    const llm = new ChatTextLLM(new RecordedChatBackend('m', ['bad', '{"v":7}']));
    const parse = (raw: string) => {
      const obj = JSON.parse(raw) as { v: number };
      return obj.v;
    };
    expect(await llm.structured('give json', parse)).toBe(7);
  });
});

describe('BackendImageProvider — ImageProvider contract', () => {
  it('generates deterministic bytes for the same prompt', async () => {
    const provider = new BackendImageProvider(new StubImageBackend(), loadRef);
    const a = await provider.generate('a portrait of Aiko', [], { modelId: 'mock-image' });
    const b = await provider.generate('a portrait of Aiko', [], { modelId: 'mock-image' });
    expect(a.ext).toBe('png');
    expect(new TextDecoder().decode(a.bytes)).toBe(new TextDecoder().decode(b.bytes));
  });

  it('edits relative to a base image', async () => {
    const provider = new BackendImageProvider(new StubImageBackend(), loadRef);
    const result = await provider.edit({ hash: 'base', ext: 'png' }, 'swap outfit', [], {
      modelId: 'mock-image',
    });
    expect(result.bytes.length).toBeGreaterThan(0);
  });
});

describe('createGeminiImage — input validation', () => {
  it('rejects non-image reference bytes before any API call (e.g. --mock placeholders)', async () => {
    const image = createGeminiImage('fake-key', 'gemini-2.5-flash-image');
    const mockRef = { bytes: new TextEncoder().encode('IMG:deadbeef'), ext: 'png' };
    await expect(
      image.generate('a shot', [mockRef], { modelId: 'gemini-2.5-flash-image' }),
    ).rejects.toThrow(/not a valid PNG\/JPEG\/WebP/);
  });
});

describe('supportsEffort', () => {
  it('accepts models with output_config.effort and rejects those that 400 on it', () => {
    for (const id of [
      'claude-opus-4-8',
      'claude-opus-4-5',
      'claude-sonnet-4-6',
      'claude-fable-5',
    ]) {
      expect(supportsEffort(id)).toBe(true);
    }
    for (const id of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'gemini-2.5-pro']) {
      expect(supportsEffort(id)).toBe(false);
    }
  });
});

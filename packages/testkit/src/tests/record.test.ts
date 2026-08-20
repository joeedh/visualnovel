import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageParams } from '@vn/types';
import { AssetCache, requestKey } from '@vn/providers';
import { checkCorpus, formatReport } from '../record.js';

const PARAMS: ImageParams = { modelId: 'test-image-1' };
const ART = (tag: string) => new TextEncoder().encode(`pretend this is art: ${tag}`);

/**
 * The audit half of the refresh script: free, offline, and the only half a suite may run.
 * `recordCorpus` is deliberately untested because it spends real money.
 */
describe('checkCorpus', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(join(tmpdir(), 'vn-corpus-'));
  });

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('reports what nothing asked for and what is indexed but gone, without failing', async () => {
    const cache = await AssetCache.open(cacheDir);
    const orphanKey = requestKey('generate', 'a prompt no fixture will ever issue', [], PARAMS);
    const goneKey = requestKey('generate', 'another prompt no fixture issues', [], PARAMS);
    for (const [key, tag] of [
      [orphanKey, 'orphan'],
      [goneKey, 'gone'],
    ] as const) {
      await cache.put(
        key,
        { bytes: ART(tag), ext: 'png', modelId: 'test-image-1' },
        { op: 'generate', prompt: tag, refs: [], params: PARAMS },
      );
    }
    await fs.rm(join(cacheDir, `${goneKey}.png`));

    const report = await checkCorpus({ fixture: 'linear', cacheDir });

    expect(report.fixture).toBe('linear');
    // Nothing in this corpus answers a real request, so the whole run falls through.
    expect(report.reused).toBe(0);
    expect(report.missed).toBeGreaterThan(0);
    // Auditing never records, whatever it finds.
    expect(report.added).toBe(0);
    expect(report.orphaned.map((e) => e.key).sort()).toEqual([orphanKey, goneKey].sort());
    expect(report.missingFiles.map((e) => e.key)).toEqual([goneKey]);

    const text = formatReport(report);
    expect(text).toContain('nothing asked for (2)');
    expect(text).toContain('indexed but missing on disk (1)');
    // The report warns that an orphan list is unreliable while entries are still missing.
    expect(text).toContain('Treat the orphan list as suspect');
  }, 30_000);
});

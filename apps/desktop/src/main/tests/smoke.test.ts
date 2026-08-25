/**
 * The packaged-build self-check, with `import()` and the source lookup faked. Only the packaged
 * executable can prove the three packages and the source snapshot are in the app image. What is
 * testable here is that the check does not call a resolved-but-wrong module a success, and does
 * not call a missing source tree one either.
 */
import { formatSmoke, runSmoke, SMOKE_PREFIX } from '../smoke.js';

class Fake {
  constructor(readonly opts: { apiKey: string }) {}
}

/** A bundler that strips the type annotation, which is all the check reads the output for. */
const fakeBundler = {
  transform: async (src: string) => ({ code: src.replace(': number', '') }),
};

/** Every external present, each exported the way the code reaching for it does. */
const good = async (spec: string) => {
  if (spec === '@google/genai') return { GoogleGenAI: Fake };
  if (spec === 'esbuild') return fakeBundler;
  return { default: Fake };
};

const foundSource = async () => '/resources/source';
const noSource = async () => undefined;

describe('runSmoke', () => {
  it('passes when both modules resolve and the source is there', async () => {
    const report = await runSmoke(good, foundSource);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.what)).toEqual([
      '@anthropic-ai/sdk',
      '@google/genai',
      'esbuild',
      'source',
    ]);
  });

  it('reports the module that could not be found, and keeps going', async () => {
    const report = await runSmoke(async (spec) => {
      if (spec === '@anthropic-ai/sdk') throw new Error("Cannot find module '@anthropic-ai/sdk'");
      return { GoogleGenAI: Fake };
    }, foundSource);
    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ what: '@anthropic-ai/sdk', ok: false });
    expect(report.checks[1]).toMatchObject({ what: '@google/genai', ok: true });
  });

  // A bare `await import(spec)` would miss this failure, where the file resolves but is not the SDK
  it('fails a module that resolved to something without a constructor', async () => {
    const report = await runSmoke(async () => ({ default: 42 }), foundSource);
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.detail).toMatch(/no constructor/);
  });

  it('fails a constructor that throws rather than reporting a pass', async () => {
    const report = await runSmoke(
      async () => ({
        default: class {
          constructor() {
            throw new Error('boom');
          }
        },
      }),
      foundSource,
    );
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.detail).toBe('boom');
  });

  // A bundler whose binary did not ship resolves and then throws on first use, so the check
  // runs a transform rather than settling for the import having succeeded.
  it('fails a bundler that resolved and cannot transform', async () => {
    const report = await runSmoke(async (spec) => {
      if (spec === 'esbuild') {
        return {
          transform: async () => {
            throw new Error('The service was stopped');
          },
        };
      }
      return good(spec);
    }, foundSource);
    expect(report.ok).toBe(false);
    expect(report.checks[2]).toMatchObject({ what: 'esbuild', ok: false });
    expect(report.checks[2]!.detail).toMatch(/service was stopped/);
  });

  // The failure this exists for: an image that runs perfectly and shipped no source
  it('fails an image whose source snapshot is missing, with everything else fine', async () => {
    const report = await runSmoke(good, noSource);
    expect(report.ok).toBe(false);
    expect(report.checks.slice(0, 3).every((c) => c.ok)).toBe(true);
    expect(report.checks[3]).toMatchObject({ what: 'source', ok: false });
  });

  it('treats a source lookup that threw as a missing source', async () => {
    const report = await runSmoke(good, async () => {
      throw new Error('EACCES');
    });
    expect(report.ok).toBe(false);
    expect(report.checks[3]).toMatchObject({ what: 'source', ok: false });
  });

  // The placeholder key stays inside the smoke module, so the formatted line cannot carry it out
  it('says nothing about the placeholder key it constructed with', async () => {
    const line = formatSmoke(await runSmoke(good, foundSource));
    expect(line.startsWith(SMOKE_PREFIX)).toBe(true);
    expect(line).not.toMatch(/apiKey|smoke-test-not-a-key/);
    expect(JSON.parse(line.slice(SMOKE_PREFIX.length)).ok).toBe(true);
  });
});

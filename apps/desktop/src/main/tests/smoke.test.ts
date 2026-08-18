/**
 * The packaged-build self-check, with the `import()` faked. What the real thing proves — that the
 * two SDKs are *in* the app image — only the packaged executable can say; what is testable here
 * is that the check does not call a resolved-but-wrong module a success.
 */
import { formatSmoke, runSmoke, SMOKE_PREFIX } from '../smoke.js';

class Fake {
  constructor(readonly opts: { apiKey: string }) {}
}

/** Both SDKs present, each exported the way its backend reaches for it. */
const good = async (spec: string) =>
  spec === '@google/genai' ? { GoogleGenAI: Fake } : { default: Fake };

describe('runSmoke', () => {
  it('passes when both modules resolve and construct', async () => {
    const report = await runSmoke(good);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.spec)).toEqual(['@anthropic-ai/sdk', '@google/genai']);
  });

  it('reports the module that could not be found, and keeps going', async () => {
    const report = await runSmoke(async (spec) => {
      if (spec === '@anthropic-ai/sdk') throw new Error("Cannot find module '@anthropic-ai/sdk'");
      return { GoogleGenAI: Fake };
    });
    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ spec: '@anthropic-ai/sdk', ok: false });
    expect(report.checks[1]).toMatchObject({ spec: '@google/genai', ok: true });
  });

  // The failure a bare `await import(spec)` would miss: the file is there, and it is not the SDK.
  it('fails a module that resolved to something without a constructor', async () => {
    const report = await runSmoke(async () => ({ default: 42 }));
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.detail).toMatch(/no constructor/);
  });

  it('fails a constructor that throws rather than reporting a pass', async () => {
    const report = await runSmoke(async () => ({
      default: class {
        constructor() {
          throw new Error('boom');
        }
      },
    }));
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.detail).toBe('boom');
  });

  // The key never leaves this module, so nothing that quotes it can carry one out.
  it('says nothing about the placeholder key it constructed with', async () => {
    const line = formatSmoke(await runSmoke(good));
    expect(line.startsWith(SMOKE_PREFIX)).toBe(true);
    expect(line).not.toMatch(/apiKey|smoke-test-not-a-key/);
    expect(JSON.parse(line.slice(SMOKE_PREFIX.length)).ok).toBe(true);
  });
});

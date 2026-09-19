import {
  NATIVE_VERSION,
  continuingTransport,
  headerTransport,
  resumeNote,
  resumeRefusal,
} from '../threads.js';
import type { ResumeState } from '../threads.js';
import type { ResumeHeader } from '../convo.js';

const header = (over: Partial<ResumeHeader> = {}): ResumeHeader => ({
  v       : NATIVE_VERSION,
  thread  : 't1',
  at      : '2026-08-22T14:00:28.041Z',
  backend : 'native',
  vendor  : 'anthropic',
  model   : 'claude-opus-5',
  sections: [{ name: 'BUILT-IN', text: 'the contract' }],
  ...over,
});

const recorded = (over: Partial<ResumeHeader> = {}): ResumeState => ({ header: header(over) });

describe('resumeRefusal', () => {
  it('allows a conversation recorded on the model that is bound', () => {
    expect(
      resumeRefusal('Casting', recorded(), { model: 'claude-opus-5', backend: 'native' }),
    ).toBe(undefined);
  });

  it('allows a sibling model of the same vendor, which is the swap the app already permits', () => {
    expect(
      resumeRefusal('Casting', recorded(), { model: 'claude-sonnet-5', backend: 'native' }),
    ).toBe(undefined);
  });

  it('refuses a log a merge damaged, before it asks anything else of it', () => {
    const refusal = resumeRefusal('Casting', { damaged: true }, { model: 'claude-opus-5' });
    expect(refusal).toContain('merged from two copies');
    expect(refusal).toContain('Casting');
  });

  it('refuses a thread recorded before the history existed', () => {
    const refusal = resumeRefusal('Casting', {}, { model: 'claude-opus-5' });
    expect(refusal).toContain('recorded before conversations could be continued');
  });

  it('refuses a log a newer build wrote', () => {
    const refusal = resumeRefusal('Casting', recorded({ v: NATIVE_VERSION + 1 }), {
      model: 'claude-opus-5',
    });
    expect(refusal).toContain('newer version of VN Studio');
  });

  it('refuses the other vendor, and names the one to bind', () => {
    const refusal = resumeRefusal('Casting', recorded(), { model: 'gemini-3-pro' });
    expect(refusal).toContain('do not share a message format');
    expect(refusal).toContain('Bind a Claude model');
  });

  it('refuses a transport the thread was not recorded through, naming the key to provide', () => {
    const viaOpenRouter = recorded({ transport: 'openrouter' });
    const refusal = resumeRefusal('Casting', viaOpenRouter, {
      model    : 'claude-opus-5',
      transport: 'anthropic',
    });
    expect(refusal).toContain('recorded through OpenRouter');
    expect(refusal).toContain("continue it through Anthropic's own API");
    expect(refusal).toContain('Provide an OpenRouter key first');

    const native = recorded({ transport: 'anthropic' });
    expect(
      resumeRefusal('Casting', native, { model: 'claude-opus-5', transport: 'openrouter' }),
    ).toContain('Provide an Anthropic key first');
  });

  it('allows the transport the thread was recorded through, and reads an old header as its vendor', () => {
    expect(
      resumeRefusal('Casting', recorded({ transport: 'openrouter' }), {
        model    : 'claude-opus-5',
        transport: 'openrouter',
      }),
    ).toBe(undefined);
    expect(
      resumeRefusal('Casting', recorded(), { model: 'claude-opus-5', transport: 'anthropic' }),
    ).toBe(undefined);
    expect(headerTransport(header())).toBe('anthropic');
    expect(headerTransport(header({ transport: 'openrouter' }))).toBe('openrouter');
  });

  it('skips the transport check when main did not fill one in', () => {
    expect(
      resumeRefusal('Casting', recorded({ transport: 'openrouter' }), { model: 'claude-opus-5' }),
    ).toBe(undefined);
  });

  it('refuses a protocol the bound backend does not speak', () => {
    const refusal = resumeRefusal('Casting', recorded(), {
      model  : 'claude-opus-5',
      backend: 'structured',
    });
    expect(refusal).toContain('native tool-calling path');
  });

  it('skips the vendor and protocol checks while nothing is bound', () => {
    expect(resumeRefusal('Casting', recorded(), { model: '', backend: 'structured' })).toBe(
      undefined,
    );
  });

  it('names the vendor from the header when the log recorded no model id', () => {
    const refusal = resumeRefusal('Casting', recorded({ model: undefined }), {
      model: 'gemini-3-pro',
    });
    expect(refusal).toContain('recorded on Claude');
  });
});

describe('continuingTransport', () => {
  const all = { anthropic: true, gemini: true, openrouter: true };

  it('keeps the recorded transport while its key resolves, over the free route', () => {
    expect(continuingTransport('claude-opus-5', all, 'openrouter')).toBe('openrouter');
    expect(continuingTransport('claude-opus-5', all, 'anthropic')).toBe('anthropic');
  });

  it('falls back to the free route when the recorded key is gone, or nothing was recorded', () => {
    expect(continuingTransport('claude-opus-5', { ...all, openrouter: false }, 'openrouter')).toBe(
      'anthropic',
    );
    expect(continuingTransport('claude-opus-5', all)).toBe('anthropic');
    expect(continuingTransport('claude-opus-5', { ...all, anthropic: false })).toBe('openrouter');
  });

  it('answers nothing when no key can carry the model at all', () => {
    const none = { anthropic: false, gemini: false, openrouter: false };
    expect(continuingTransport('claude-opus-5', none, 'openrouter')).toBeUndefined();
  });
});

describe('resumeNote', () => {
  it('says which swap a resume is making', () => {
    expect(resumeNote(recorded(), { model: 'claude-sonnet-5' })).toBe(
      'Recorded on claude-opus-5, continuing on claude-sonnet-5.',
    );
  });

  it('says nothing when the model is the one it was recorded on', () => {
    expect(resumeNote(recorded(), { model: 'claude-opus-5' })).toBe(undefined);
    expect(resumeNote({}, { model: 'claude-opus-5' })).toBe(undefined);
  });
});

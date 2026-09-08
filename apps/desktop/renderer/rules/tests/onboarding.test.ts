import {
  controls,
  linkAction,
  saveKeyAction,
  setKeyKey,
  testKeyAction,
  type OnboardingState,
} from '../onboarding.js';
import { duplicateKeys, keyOf } from '../anchors.js';
import type { KeyGuideVendor } from '../../../src/shared/apikeys';
import type { CommandCheck } from '../../../src/shared/ipc';

const vendor = (over: Partial<KeyGuideVendor> = {}): KeyGuideVendor => ({
  vendor  : 'anthropic',
  name    : 'Anthropic',
  console : 'https://console.example/keys',
  docs    : 'https://docs.example/keys',
  billing : 'https://console.example/billing',
  env     : 'ANTHROPIC_API_KEY',
  freeTier: false,
  body    : [],
  ...over,
});

const ACCEPT: CommandCheck = { state: 'accept', message: 'Writes keys/anthropic.' };
const REFUSE: CommandCheck = { state: 'refuse', message: 'No project is open.' };
const UNDECLARED: CommandCheck = { state: 'undeclared', message: '' };

const state = (over: Partial<OnboardingState> = {}): OnboardingState => ({
  vendors : [vendor()],
  typed   : {},
  scopes  : {},
  verdicts: { setKey: {}, testKey: {} },
  ...over,
});

describe('linkAction', () => {
  it('opens the guide’s page, naming the url in its tooltip', () => {
    expect(linkAction(vendor(), 'console')).toEqual({
      ok     : true,
      id     : 'app.openKeyLink',
      props  : { provider: 'anthropic', link: 'console' },
      label  : 'Open console',
      on     : 'anthropic/console',
      tooltip:
        'Open the page where a key is created, in your browser — https://console.example/keys',
    });
    expect(linkAction(vendor(), 'docs')).toMatchObject({ ok: true, label: 'Provider docs' });
    expect(linkAction(vendor(), 'billing')).toMatchObject({ ok: true, label: 'Pricing' });
  });

  it('refuses a page the guide does not name, keeping the button’s own sentence', () => {
    expect(linkAction(vendor({ billing: '' }), 'billing')).toMatchObject({
      ok     : false,
      id     : 'app.openKeyLink',
      on     : 'anthropic/billing',
      tooltip: 'Open what this provider charges',
      refusal: { reason: 'The setup guide names no billing page for anthropic.' },
    });
  });

  it('keys each link by vendor and field, so twins across vendors stay apart', () => {
    expect(keyOf(linkAction(vendor(), 'docs'))).toBe('cmd:app.openKeyLink#anthropic/docs');
    expect(keyOf(linkAction(vendor({ vendor: 'openai' }), 'docs'))).toBe(
      'cmd:app.openKeyLink#openai/docs',
    );
  });
});

describe('setKeyKey', () => {
  it('carries the vendor and the scope the verdict was asked about', () => {
    expect(setKeyKey('anthropic', 'project')).toBe('anthropic/project');
  });
});

describe('saveKeyAction', () => {
  it('writes the typed key to the chosen scope, with the accepted sentence as its tooltip', () => {
    expect(saveKeyAction('anthropic', 'sk-1', 'project', ACCEPT)).toEqual({
      ok      : true,
      id      : 'project.setKey',
      props   : { provider: 'anthropic', scope: 'project' },
      label   : 'Save key',
      tooltip : ACCEPT.message,
      on      : 'anthropic',
      supplies: ['key'],
    });
  });

  it('never carries the key, which the click supplies', () => {
    const offer = saveKeyAction('anthropic', 'sk-secret', 'user', ACCEPT);
    expect(JSON.stringify(offer)).not.toContain('sk-secret');
  });

  it('falls back to its own sentence when the check says nothing', () => {
    expect(saveKeyAction('anthropic', 'sk-1', 'user', UNDECLARED)).toMatchObject({
      ok     : true,
      tooltip: 'Write this key',
    });
  });

  it('refuses with an empty box', () => {
    expect(saveKeyAction('anthropic', '   ', 'user', ACCEPT)).toMatchObject({
      ok     : false,
      id     : 'project.setKey',
      refusal: { reason: 'Paste a key first' },
    });
  });

  it('names the command’s refusal before the empty box', () => {
    expect(saveKeyAction('anthropic', '', 'user', REFUSE)).toMatchObject({
      ok     : false,
      refusal: { reason: REFUSE.message },
    });
  });
});

describe('testKeyAction', () => {
  it('makes the one call for the vendor', () => {
    expect(testKeyAction('anthropic', ACCEPT)).toEqual({
      ok     : true,
      id     : 'project.testKey',
      props  : { provider: 'anthropic' },
      label  : 'Test key',
      tooltip:
        'Make one small real call and say whether the key works. It costs a fraction of a cent.',
      on     : 'anthropic',
    });
  });

  it('greys the button with the command’s own refusal', () => {
    expect(testKeyAction('anthropic', REFUSE)).toMatchObject({
      ok     : false,
      id     : 'project.testKey',
      on     : 'anthropic',
      refusal: { reason: REFUSE.message },
    });
  });
});

describe('controls', () => {
  const two = [vendor(), vendor({ vendor: 'openai', name: 'OpenAI' })];

  it('lists the three links alone until the verdicts are in', () => {
    expect(controls(state()).map(keyOf)).toEqual([
      'cmd:app.openKeyLink#anthropic/console',
      'cmd:app.openKeyLink#anthropic/docs',
      'cmd:app.openKeyLink#anthropic/billing',
    ]);
  });

  it('adds the save box for the scope on screen, and the test button, once answered', () => {
    const answered = state({
      typed   : { anthropic: 'sk-1' },
      scopes  : { anthropic: 'project' },
      verdicts: {
        setKey : { [setKeyKey('anthropic', 'project')]: ACCEPT },
        testKey: { anthropic: REFUSE },
      },
    });
    expect(controls(answered).map(keyOf)).toEqual([
      'cmd:app.openKeyLink#anthropic/console',
      'cmd:app.openKeyLink#anthropic/docs',
      'cmd:app.openKeyLink#anthropic/billing',
      'cmd:project.setKey#anthropic',
      'cmd:project.testKey#anthropic',
    ]);
  });

  // A verdict about the other scope was asked with a different prop, so it is not this box's
  it('ignores a save verdict for a scope that is no longer chosen', () => {
    const stale = state({
      scopes  : { anthropic: 'project' },
      verdicts: { setKey: { [setKeyKey('anthropic', 'user')]: ACCEPT }, testKey: {} },
    });
    expect(controls(stale).map(keyOf)).not.toContain('cmd:project.setKey#anthropic');
  });

  it('lists every control the pane draws, each key once', () => {
    const full = state({
      vendors : two,
      typed   : { anthropic: 'sk-1' },
      scopes  : { openai: 'project' },
      verdicts: {
        setKey: {
          [setKeyKey('anthropic', 'user')]: ACCEPT,
          [setKeyKey('openai', 'project')]: REFUSE,
        },
        testKey: { anthropic: ACCEPT, openai: REFUSE },
      },
    });
    for (const s of [state(), state({ vendors: two }), full]) {
      const listed = controls(s);
      const each = s.vendors.flatMap((v) => {
        const id = v.vendor;
        const scope = s.scopes[id] ?? 'user';
        const set = s.verdicts.setKey[setKeyKey(id, scope)];
        const test = s.verdicts.testKey[id];
        return [
          linkAction(v, 'console'),
          linkAction(v, 'docs'),
          linkAction(v, 'billing'),
          ...(set ? [saveKeyAction(id, s.typed[id] ?? '', scope, set)] : []),
          ...(test ? [testKeyAction(id, test)] : []),
        ];
      });
      expect(new Set(listed.map(keyOf))).toEqual(new Set(each.map(keyOf)));
      expect(duplicateKeys(listed)).toEqual([]);
    }
  });
});

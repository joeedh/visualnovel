/** The Setup pane's situations: what the key boxes hold, and what the two commands said. */
import { situations } from './situation.js';
import { setKeyKey, type OnboardingState } from '../onboarding.js';
import type { KeyGuideVendor } from '../../../src/shared/apikeys.js';

const anthropic: KeyGuideVendor = {
  vendor  : 'anthropic',
  name    : 'Anthropic',
  console : 'https://console.anthropic.com/settings/keys',
  docs    : 'https://docs.anthropic.com/en/api/getting-started',
  billing : 'https://console.anthropic.com/settings/billing',
  env     : 'ANTHROPIC_API_KEY',
  freeTier: false,
  body    : [],
};

const base: OnboardingState = {
  vendors : [anthropic],
  typed   : {},
  scopes  : {},
  verdicts: { setKey: {}, testKey: {} },
};

const MOCK = 'Mock mode makes no calls, so there is nothing to test.';

export const SITUATIONS = situations<OnboardingState>(
  {
    name : 'blank',
    why: 'The key box is empty, so Save key is refused until something is pasted; Test key is offered.',
    state: {
      ...base,
      verdicts: {
        setKey: {
          [setKeyKey('anthropic', 'user')]: {
            state  : 'accept',
            message: 'Writes the key to your user directory.',
          },
        },
        testKey: { anthropic: { state: 'accept', message: '' } },
      },
    },
  },
  {
    name : 'typed',
    why: 'A key has been pasted at project scope and the command accepts, so Save key is offered.',
    state: {
      ...base,
      typed   : { anthropic: 'sk-ant-…' },
      scopes  : { anthropic: 'project' },
      verdicts: {
        setKey: {
          [setKeyKey('anthropic', 'project')]: {
            state  : 'accept',
            message: 'Writes keys/anthropic.',
          },
        },
        testKey: { anthropic: { state: 'accept', message: '' } },
      },
    },
  },
  {
    name : 'mock',
    why: 'The workspace runs with mock providers, so Test key is refused with the command’s sentence.',
    state: {
      ...base,
      verdicts: {
        setKey: {
          [setKeyKey('anthropic', 'user')]: {
            state  : 'accept',
            message: 'Writes the key to your user directory.',
          },
        },
        testKey: { anthropic: { state: 'refuse', message: MOCK } },
      },
    },
  },
  {
    name : 'no-links',
    why: 'The guide names no pricing page for this vendor, so that link is refused; the verdicts are not in yet.',
    state: { ...base, vendors: [{ ...anthropic, billing: '' }] },
  },
);

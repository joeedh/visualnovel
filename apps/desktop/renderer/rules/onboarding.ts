/**
 * What the Setup pane's controls offer, per vendor: the three guide links, the Save key box and
 * the Test key button. The two commands' verdicts are asked by the pane and reach this module as
 * state, keyed as finely as they were asked: `project.setKey` per vendor and scope, because the
 * scope is a prop the anchor carries, and `project.testKey` per vendor.
 */
import {
  GUIDE_URL_FIELDS,
  type GuideUrlField,
  type KeyGuideVendor,
} from '../../src/shared/apikeys.js';
import type { CommandCheck, KeyScope } from '../../src/shared/ipc.js';
import { refuse, type Offer } from './anchors.js';

/** What the Setup pane reads when it draws its vendor cards. */
export interface OnboardingState {
  vendors: KeyGuideVendor[];
  /** What each vendor's key box holds, by vendor id. Never carried on an offer. */
  typed: Record<string, string>;
  /** Each vendor's chosen scope, by vendor id; `user` when none was chosen. */
  scopes: Record<string, KeyScope>;
  verdicts: {
    /** Keyed by {@link setKeyKey}. */
    setKey: Record<string, CommandCheck>;
    /** Keyed by vendor id. */
    testKey: Record<string, CommandCheck>;
  };
}

/** The three pages the app is willing to open: a button's text and its sentence, per field. */
const LINKS: Record<GuideUrlField, [label: string, why: string]> = {
  console: ['Open console', 'Open the page where a key is created, in your browser'],
  docs   : ['Provider docs', "Open the provider's own version of these steps"],
  billing: ['Pricing', 'Open what this provider charges'],
};

/** Open one of the guide's pages for a vendor, refused when the guide names no such page. */
export function linkAction(vendor: KeyGuideVendor, field: GuideUrlField): Offer {
  const url = vendor[field];
  const [label, why] = LINKS[field];
  const control = { id: 'app.openKeyLink', label, on: `${vendor.vendor}/${field}` };
  if (url === '') {
    return {
      ...refuse(`The setup guide names no ${field} page for ${vendor.vendor}.`),
      ...control,
      tooltip: why,
    };
  }
  return {
    ok   : true,
    props: { provider: vendor.vendor, link: field },
    ...control,
    tooltip: `${why} — ${url}`,
  };
}

/** Where a Save key verdict is kept: the vendor and the scope it was asked about. */
export const setKeyKey = (vendor: string, scope: KeyScope): string => `${vendor}/${scope}`;

/**
 * Write the typed key. The key itself is never carried: `project.setKey` declares it
 * `prop.secret`, and an anchor is dumped and swept to disk, so it is named as supplied. Refuses
 * with the command's own sentence first, then with an empty box.
 */
export function saveKeyAction(
  vendor: string,
  typed: string,
  scope: KeyScope,
  check: CommandCheck,
): Offer {
  const control = {
    id      : 'project.setKey',
    label   : 'Save key',
    tooltip : (check.state === 'accept' && check.message) || 'Write this key',
    on      : vendor,
    supplies: ['key'],
  };
  if (check.state === 'refuse') return { ...refuse(check.message), ...control };
  if (typed.trim() === '') return { ...refuse('Paste a key first'), ...control };
  return { ok: true, props: { provider: vendor, scope }, ...control };
}

/**
 * Make one small real call with the vendor's key. Greyed with `project.testKey`'s own refusal,
 * which says what fails to resolve better than the pane could.
 */
export function testKeyAction(vendor: string, check: CommandCheck): Offer {
  const control = {
    id     : 'project.testKey',
    label  : 'Test key',
    tooltip:
      'Make one small real call and say whether the key works. It costs a fraction of a cent.',
    on     : vendor,
  };
  if (check.state === 'refuse') return { ...refuse(check.message), ...control };
  return { ok: true, props: { provider: vendor }, ...control };
}

/**
 * Every offer the Setup pane draws from this module: per vendor, the three links, then the Save
 * key box and the Test key button once their verdicts are in.
 */
export function controls(state: OnboardingState): readonly Offer[] {
  const list: Offer[] = [];
  for (const vendor of state.vendors) {
    const id = vendor.vendor;
    for (const field of GUIDE_URL_FIELDS) list.push(linkAction(vendor, field));
    const scope = state.scopes[id] ?? 'user';
    const setKey = state.verdicts.setKey[setKeyKey(id, scope)];
    if (setKey) list.push(saveKeyAction(id, state.typed[id] ?? '', scope, setKey));
    const testKey = state.verdicts.testKey[id];
    if (testKey) list.push(testKeyAction(id, testKey));
  }
  return list;
}

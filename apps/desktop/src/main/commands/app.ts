/**
 * The app itself as commands — the few acts that are about VN Studio rather than about the
 * project it happens to have open.
 *
 * They are commands for the same reason everything else is: the Setup pane, the palette, CDP and
 * the agent then reach one implementation, and a pane that fetched its own words over a bespoke
 * channel would be a second way to ask the same question.
 */
import { defineFor, prop } from '@vn/commands';
import { KEY_VENDORS } from '@vn/config';
import { GUIDE_URL_FIELDS, keyGuideProblems } from '../../shared/apikeys.js';
import { notify } from '../notifications.js';
import { announcementFor } from '../updates.js';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

export const appKeyGuide = define({
  id: 'app.keyGuide',
  title: 'The API key walkthrough',
  description:
    'The steps for getting a model key, read from `docs/api-keys.md` — the one copy of them, ' +
    'which the docs site serves and the Setup pane draws. Per vendor: where the console is, ' +
    'what the environment variable is called, whether there is a free tier, and the steps.',
  mutating: false,
  props: {},
  async run(_props, ctx) {
    const guide = await ctx.host.session.keyGuide();
    const problems = keyGuideProblems(guide, KEY_VENDORS);
    return {
      // A guide that is missing a section is still returned — the pane draws what there is. The
      // message is what says so, because the alternative is a pane that is quietly short.
      message:
        problems.length === 0
          ? `${guide.vendors.length} provider(s).`
          : `The setup guide is incomplete: ${problems.join(' ')}`,
      data: guide,
    };
  },
});

export const appOpenKeyLink = define({
  id: 'app.openKeyLink',
  title: "Open a provider's page",
  description:
    'Open one of a model provider’s own pages in your browser: the console where keys are made, ' +
    'its documentation, or what it charges. The addresses are the ones `docs/api-keys.md` ' +
    'states, so a button and the written instructions cannot point at different pages — and ' +
    'naming a *field* rather than a URL is why no part of the app can ask the OS to open an ' +
    'address it was handed.',
  mutating: false,
  props: {
    provider: prop.oneOf(KEY_VENDORS, 'which provider’s page to open'),
    link: prop.oneOf(GUIDE_URL_FIELDS, 'which of its pages', { default: 'console' }),
  },
  async run({ provider, link }, ctx) {
    const result = await ctx.host.session.openKeyLink(provider, link);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message };
  },
});

export const appCheckForUpdates = define({
  id: 'app.checkForUpdates',
  title: 'Check for updates',
  description:
    'Ask GitHub whether a newer VN Studio has been released, and say so. It downloads nothing ' +
    'and installs nothing — an update you want is one you fetch from the releases page yourself. ' +
    'Nothing calls this on your behalf: there is no scheduled check, so the app does not reach ' +
    'the network until you ask it to.',
  mutating: false,
  props: {
    quiet: prop.boolean(
      'say nothing unless there is actually an update — what a background check would pass',
      { default: false },
    ),
  },
  async run({ quiet }, ctx) {
    const check = await ctx.host.session.checkForUpdates();
    // The verdict is always returned; only the durable notification is conditional. A failed
    // check is deliberately not a thrown error — see `announcementFor`.
    const announcement = announcementFor(check, quiet);
    if (announcement) await notify(announcement);
    return { message: check.message, data: check };
  },
});

export const appOpenReleases = define({
  id: 'app.openReleases',
  title: 'Open the releases page',
  description:
    'Open VN Studio’s releases page in your browser, where the notes for each version and the ' +
    'installers are the same page. The address comes from the repository this build was made ' +
    'from, so — like every other link the app opens — it is one the app already knew rather ' +
    'than one it was handed.',
  mutating: false,
  props: {},
  async run(_props, ctx) {
    const result = await ctx.host.session.openReleases();
    if (!result.ok) throw new Error(result.message);
    return { message: result.message };
  },
});

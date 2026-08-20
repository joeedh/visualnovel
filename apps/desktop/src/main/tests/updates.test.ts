/**
 * The update check's decisions, with no network anywhere in the file — and that is a rule rather
 * than a convenience. The GitHub API allows 60 unauthenticated requests an hour per IP, and a
 * CI runner shares one with every other job on it, so a test that reached the real endpoint would
 * spend a budget the app itself depends on.
 */
import {
  RELEASES_API,
  RELEASES_PAGE,
  announcementFor,
  checkAgainst,
  compareVersions,
  parseVersion,
  runningVersion,
  unreachable,
} from '../updates.js';
import { LINK_COMMANDS, linkCommand } from '../../shared/notify.js';
import { NotificationLinkSchema, type Notification } from '@vn/types';

/** A release payload, with only the fields a verdict turns on. */
function release(tag: string): unknown {
  return { tag_name: tag, prerelease: false, draft: false, html_url: 'https://example.invalid' };
}

describe('where it looks', () => {
  it('asks for the latest release rather than a listing', () => {
    // The endpoint is what excludes prereleases and drafts, so it is worth asserting: swapping it
    // for `/releases` would silently start offering a beta to everyone.
    expect(RELEASES_API).toBe('https://api.github.com/repos/joeedh/visualnovel/releases/latest');
  });

  it('sends the author to a page that is both the notes and the download', () => {
    expect(RELEASES_PAGE).toBe('https://github.com/joeedh/visualnovel/releases/latest');
  });
});

describe('parseVersion', () => {
  it('reads x.y.z with or without the tag prefix', () => {
    expect(parseVersion('0.1.0')).toEqual([0, 1, 0]);
    expect(parseVersion('v10.20.30')).toEqual([10, 20, 30]);
  });

  it('refuses anything that is not exactly three numbers', () => {
    for (const text of ['', '1', '1.2', '1.2.3.4', '1.2.x', 'v1.2.3-beta.1', 'latest']) {
      expect(parseVersion(text)).toBeUndefined();
    }
  });
});

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions([1, 0, 0], [0, 9, 9])).toBeGreaterThan(0);
    expect(compareVersions([0, 2, 0], [0, 10, 0])).toBeLessThan(0);
    expect(compareVersions([0, 1, 2], [0, 1, 10])).toBeLessThan(0);
    expect(compareVersions([1, 2, 3], [1, 2, 3])).toBe(0);
  });
});

describe('runningVersion', () => {
  it('takes the version out of what a dev build says about itself', () => {
    // `describeVersion` writes one of these two; both must compare as 0.1.0.
    expect(runningVersion('0.1.0')).toBe('0.1.0');
    expect(runningVersion('0.1.0 (dev abc1234)')).toBe('0.1.0');
    expect(runningVersion('0.1.0 (dev)')).toBe('0.1.0');
  });
});

describe('checkAgainst', () => {
  it('offers a newer release', () => {
    const check = checkAgainst('0.3.1', release('v0.4.0'));
    expect(check.state).toBe('available');
    expect(check.latest).toBe('0.4.0');
    expect(check.message).toBe('v0.4.0 is available — you have v0.3.1.');
  });

  it('says so when the versions match', () => {
    const check = checkAgainst('0.4.0', release('v0.4.0'));
    expect(check.state).toBe('current');
    expect(check.message).toContain('up to date');
  });

  it('does not claim a checkout ahead of the last release is up to date', () => {
    const check = checkAgainst('0.5.0', release('v0.4.0'));
    expect(check.state).toBe('ahead');
    expect(check.message).toContain('ahead of the latest release');
  });

  it('compares the dev build’s own version, not the string around it', () => {
    expect(checkAgainst(runningVersion('0.3.1 (dev abc1234)'), release('v0.4.0')).state).toBe(
      'available',
    );
  });

  it('reports a tag it cannot compare rather than guessing at it', () => {
    const check = checkAgainst('0.3.1', release('nightly'));
    expect(check.state).toBe('unreadable');
    expect(check.message).toContain('nightly');
  });

  it('reports a build that does not know its own version', () => {
    // A session with no `appVersion` (a test harness, a preview) produces this.
    const check = checkAgainst('', release('v0.4.0'));
    expect(check.state).toBe('unreadable');
  });

  it('reports an answer that is not a release', () => {
    const check = checkAgainst('0.3.1', { message: 'Not Found' });
    expect(check.state).toBe('unreadable');
    expect(check.message).toContain(RELEASES_PAGE);
  });
});

describe('unreachable', () => {
  it('names the reason and offers the page as a fallback', () => {
    const check = unreachable('0.3.1', 'GitHub answered 403');
    expect(check.state).toBe('unreachable');
    expect(check.message).toContain('GitHub answered 403');
    expect(check.message).toContain(RELEASES_PAGE);
  });
});

describe('announcementFor', () => {
  it('announces an update however the check was started', () => {
    const check = checkAgainst('0.3.1', release('v0.4.0'));
    for (const quiet of [false, true]) {
      const note = announcementFor(check, quiet);
      expect(note?.level).toBe('info');
      expect(note?.message).toContain('v0.4.0 is available');
    }
  });

  it('never announces that nothing has changed', () => {
    // A manual check files nothing either: the command's own message says it on screen, and a
    // durable line per "you are up to date" would bury the log the one time it has news.
    for (const running of ['0.4.0', '0.5.0']) {
      expect(announcementFor(checkAgainst(running, release('v0.4.0')), false)).toBeUndefined();
      expect(announcementFor(checkAgainst(running, release('v0.4.0')), true)).toBeUndefined();
    }
  });

  it('tells a person who asked that it could not check, and a background one nothing', () => {
    const failed = unreachable('0.3.1', 'fetch failed');
    expect(announcementFor(failed, false)?.level).toBe('warn');
    expect(announcementFor(failed, true)).toBeUndefined();

    const unreadable = checkAgainst('0.3.1', { message: 'Not Found' });
    expect(announcementFor(unreadable, false)?.level).toBe('warn');
    expect(announcementFor(unreadable, true)).toBeUndefined();
  });

  it('links an act rather than an address', () => {
    const note = announcementFor(checkAgainst('0.3.1', release('v0.4.0')), false);
    expect(note?.link).toEqual({ command: LINK_COMMANDS.releases });
    // The whole shape exists for one rule: nothing the app opens is a URL it was handed.
    expect(JSON.stringify(note?.link)).not.toContain('http');
  });

  it('writes a link this build will actually follow', () => {
    const note = announcementFor(checkAgainst('0.3.1', release('v0.4.0')), false);
    const link = NotificationLinkSchema.parse(note?.link);
    expect(linkCommand({ link } as Notification)).toBe(LINK_COMMANDS.releases);
  });

  it('refuses a link naming a command that is not allow-listed', () => {
    // The allow-list exists because `notifications.jsonl` is tracked and git union-merges it, so
    // a line asking for `pipeline.run` can arrive from somebody else's branch.
    expect(linkCommand({ link: { command: 'pipeline.run' } } as Notification)).toBeUndefined();
    expect(linkCommand({ link: { command: 'notify.deleteAll' } } as Notification)).toBeUndefined();
    expect(linkCommand({} as Notification)).toBeUndefined();
  });
});

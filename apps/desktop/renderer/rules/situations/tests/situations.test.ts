import { situations, type Situation } from '../situation.js';
import { duplicateKeys, keyOf, type Offer } from '../../anchors.js';
import { SITUATIONS as headerbar } from '../headerbar.js';
import { SITUATIONS as convobar } from '../convobar.js';
import { SITUATIONS as assetview } from '../assetview.js';
import { SITUATIONS as promptview } from '../promptview.js';
import { SITUATIONS as branch } from '../branch.js';
import { SITUATIONS as documents } from '../documents.js';
import { SITUATIONS as gengraph } from '../gengraph.js';
import { SITUATIONS as onboarding } from '../onboarding.js';
import { SITUATIONS as projectbar } from '../projectbar.js';
import { SITUATIONS as reportconvo } from '../reportconvo.js';
import { SITUATIONS as script } from '../script.js';
import { SITUATIONS as skills } from '../skills.js';
import { SITUATIONS as taskGraph } from '../taskGraph.js';
import { SITUATIONS as tasklist } from '../tasklist.js';
import { SITUATIONS as timeline } from '../timeline.js';
import { SITUATIONS as wiki } from '../wiki.js';
import * as headerbarRules from '../../headerbar.js';
import * as convobarRules from '../../convobar.js';
import * as assetviewRules from '../../assetview.js';
import * as promptviewRules from '../../promptview.js';
import * as branchRules from '../../branch/controls.js';
import * as documentsRules from '../../documents.js';
import * as gengraphRules from '../../gengraph.js';
import * as onboardingRules from '../../onboarding.js';
import * as projectbarRules from '../../projectbar.js';
import * as reportconvoRules from '../../reportconvo.js';
import * as scriptRules from '../../script.js';
import * as skillsRules from '../../skills.js';
import * as taskGraphRules from '../../taskGraph.js';
import * as tasklistRules from '../../tasklist.js';
import * as timelineRules from '../../timeline/controls.js';
import * as wikiRules from '../../wiki.js';

// A method rather than a function-typed field, so a row over one state type is a `Row<unknown>`
interface Row<S> {
  module: string;
  list: readonly Situation<S>[];
  controls(state: S): readonly Offer[];
}

const row = <S>(
  module: string,
  list: readonly Situation<S>[],
  controls: (state: S) => readonly Offer[],
): Row<S> => ({
  module,
  list,
  controls,
});

const ROWS: Row<unknown>[] = [
  row('headerbar', headerbar, headerbarRules.controls),
  row('convobar', convobar, convobarRules.controls),
  row('assetview', assetview, assetviewRules.controls),
  row('promptview', promptview, ({ view, editing }) => promptviewRules.controls(view, editing)),
  row('branch', branch, branchRules.controls),
  row('documents', documents, documentsRules.controls),
  row('gengraph', gengraph, gengraphRules.controls),
  row('onboarding', onboarding, onboardingRules.controls),
  row('projectbar', projectbar, projectbarRules.controls),
  row('reportconvo', reportconvo, reportconvoRules.controls),
  row('script', script, scriptRules.controls),
  row('skills', skills, skillsRules.controls),
  row('taskGraph', taskGraph, taskGraphRules.controls),
  row('tasklist', tasklist, tasklistRules.controls),
  row('timeline', timeline, timelineRules.controls),
  row('wiki', wiki, wikiRules.controls),
];

describe('situations', () => {
  it('refuses two of one name', () => {
    expect(() =>
      situations({ name: 'a', why: 'w', state: 1 }, { name: 'a', why: 'w', state: 2 }),
    ).toThrow('two situations are named a');
  });

  describe.each(ROWS.map((r) => [r.module, r] as const))('%s', (_module, { list, controls }) => {
    it('has at least one situation, each with a sentence', () => {
      expect(list.length).toBeGreaterThan(0);
      for (const { why } of list) expect(why).toMatch(/\S/);
    });

    it.each(list.map((s) => [s.name, s] as const))(
      '%s is a state controls accepts',
      (_name, { state }) => {
        const listed = controls(state);
        expect(duplicateKeys(listed)).toEqual([]);
        for (const offer of listed) expect(keyOf(offer)).toMatch(/^(cmd|item|fx):/);
      },
    );
  });
});

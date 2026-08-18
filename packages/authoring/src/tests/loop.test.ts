import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit } from '@vn/git';
import { RecordedChatBackend, type ChatBackend } from '@vn/providers';
import {
  Agent,
  focusOnScene,
  type AskChoices,
  StructuredAgentBackend,
  Workspace,
  type Permission,
  type Plan,
  type PlanDecision,
  type ToolContext,
} from '../index.js';

const CHARACTER = `---
id: aiko
name: Aiko
status: draft
default_outfit: uniform
palette: ['#1a2a44']
traits: [curious]
---

Aiko is a transfer student.
`;

const LOCATION = `---
id: classroom
name: Classroom 2-B
variants: [afternoon]
---

A second-floor classroom.
`;

const SCENE = `---
scene: arrival
---

INT. CLASSROOM - AFTERNOON

AIKO
Hello.
`;

/** A scene pointing at a target that does not exist → an error-severity diagnostic. */
const BROKEN_SCENE = `---
scene: arrival
---

INT. CLASSROOM - AFTERNOON

[[next: nowhere]]

AIKO
Hello.
`;

async function tempProject(scene = SCENE): Promise<{
  ctx: ToolContext;
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-loop-'));
  await fs.mkdir(join(dir, 'characters', 'aiko'), { recursive: true });
  await fs.mkdir(join(dir, 'locations'), { recursive: true });
  await fs.mkdir(join(dir, 'scenes'), { recursive: true });
  await fs.writeFile(join(dir, 'characters', 'aiko', 'character.md'), CHARACTER);
  await fs.writeFile(join(dir, 'locations', 'classroom.md'), LOCATION);
  await fs.writeFile(join(dir, 'scenes', 'arrival.md'), scene);
  await fs.writeFile(join(dir, 'project.yaml'), 'title: Test Project\nstart: arrival\n');
  const ctx: ToolContext = { workspace: new Workspace(dir), git: openGit(dir) };
  return { ctx, dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** Init a repo with a local identity so commits succeed without relying on global config. */
function initRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'VN Test'], { cwd: dir });
}

/** A permission host scripted from fixed decisions, recording what it was asked. */
function scriptPermission(over: Partial<Permission> = {}): Permission & {
  plans: Plan[];
  confirms: string[];
} {
  const plans: Plan[] = [];
  const confirms: string[] = [];
  return {
    plans,
    confirms,
    async approvePlan(plan): Promise<PlanDecision> {
      plans.push(plan);
      return over.approvePlan ? over.approvePlan(plan) : { approved: true };
    },
    async confirmAction(tool, args): Promise<boolean> {
      confirms.push(tool);
      return over.confirmAction ? over.confirmAction(tool, args) : true;
    },
    async ask(question, choices): Promise<string> {
      return over.ask ? over.ask(question, choices) : 'ok';
    },
  };
}

/** Build an Agent over a scripted chat backend emitting the given JSON turns. */
function agentWith(
  ctx: ToolContext,
  turns: string[],
  permission: Permission,
  mode: 'plan' | 'execute' = 'plan',
): Agent {
  const backend = new StructuredAgentBackend(new RecordedChatBackend('mock', turns));
  return new Agent({ backend, ctx, permission, system: 'SYS', mode });
}

describe('read-only plan flow', () => {
  it('dispatches read tools and returns a final message', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const agent = agentWith(
        ctx,
        [
          JSON.stringify({ thought: 'look around', tool: 'list_workspace', args: {} }),
          JSON.stringify({ final: 'There is one character, aiko.' }),
        ],
        scriptPermission(),
      );
      const res = await agent.run('what is in this project?');
      expect(res.final).toContain('aiko');
      expect(res.mode).toBe('plan');
      const toolEvents = res.events.filter((e) => e.type === 'tool');
      expect(toolEvents).toHaveLength(1);
      expect(toolEvents[0]).toMatchObject({ tool: 'list_workspace' });
    } finally {
      await cleanup();
    }
  });
});

describe('what the turn cost', () => {
  it('is one event per model call, before whatever that call decided', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      // Two calls: the tool step and the one that finishes. Each is billed, each is reported.
      const chat: ChatBackend = {
        modelId: 'mock-usage',
        message: () => Promise.reject(new Error('the usage path should be preferred')),
        messageWithUsage: (() => {
          const answers = [
            JSON.stringify({ thought: 'look around', tool: 'list_workspace', args: {} }),
            JSON.stringify({ final: 'one character.' }),
          ];
          let i = 0;
          return () =>
            Promise.resolve({
              text: answers[Math.min(i++, 1)]!,
              usage: { input: 900, output: 40 },
            });
        })(),
      };
      const agent = new Agent({
        backend: new StructuredAgentBackend(chat),
        ctx,
        permission: scriptPermission(),
        system: 'SYS',
      });
      const res = await agent.run('what is in this project?');
      expect(res.events.filter((e) => e.type === 'usage')).toEqual([
        { type: 'usage', input: 900, output: 40 },
        { type: 'usage', input: 900, output: 40 },
      ]);
      // The receipt lands before the step it paid for, so a total never lags the transcript.
      expect(res.events[0]).toMatchObject({ type: 'usage' });
    } finally {
      await cleanup();
    }
  });

  it('says nothing at all when the backend keeps no receipt', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const agent = agentWith(ctx, [JSON.stringify({ final: 'ok' })], scriptPermission());
      const res = await agent.run('hello');
      expect(res.events.some((e) => e.type === 'usage')).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe('what the host knew when the turn started', () => {
  /** Run one turn and hand back every prompt the model was actually sent. */
  async function promptsFor(ctx: ToolContext, focus?: string): Promise<string[]> {
    const prompts: string[] = [];
    const chat = new RecordedChatBackend('mock', (req) => {
      prompts.push(req.prompt);
      return JSON.stringify({ final: 'ok' });
    });
    const agent = new Agent({
      backend: new StructuredAgentBackend(chat),
      ctx,
      permission: scriptPermission(),
      system: 'SYS',
    });
    await agent.run('rewrite the last line', focus);
    return prompts;
  }

  it('files the focus as its own labelled message, ahead of what was asked', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const [prompt] = await promptsFor(ctx, 'The author is looking at scene "arrival".');
      expect(prompt).toContain('CONTEXT: The author is looking at scene "arrival".');
      // Ahead of it, so "the last line" is read with the scene already in hand.
      expect(prompt!.indexOf('CONTEXT:')).toBeLessThan(prompt!.indexOf('USER:'));
    } finally {
      await cleanup();
    }
  });

  it('adds nothing when the host knew nothing', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const [prompt] = await promptsFor(ctx);
      expect(prompt).not.toContain('CONTEXT:');
    } finally {
      await cleanup();
    }
  });

  it('focusOnScene names the scene, its cast and the file it is in', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const focus = focusOnScene(await ctx.workspace.index(), 'arrival');
      expect(focus).toContain('scene "arrival"');
      expect(focus).toContain('location classroom');
      expect(focus).toContain('cast aiko');
      expect(focus).toContain('scenes/arrival.md');
    } finally {
      await cleanup();
    }
  });

  it('focusOnScene says nothing about a scene the project does not have', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      expect(focusOnScene(await ctx.workspace.index(), 'deleted-yesterday')).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe('setMode & clear', () => {
  it('setMode forces the mode and clear resets to plan', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const agent = agentWith(ctx, [JSON.stringify({ final: 'ok' })], scriptPermission());
      expect(agent.currentMode).toBe('plan');
      agent.setMode('execute');
      expect(agent.currentMode).toBe('execute');
      agent.clear();
      expect(agent.currentMode).toBe('plan');
    } finally {
      await cleanup();
    }
  });
});

describe('setBackend', () => {
  it('hot-swaps the model backend; the next turn uses the new one', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const permission = scriptPermission();
      const backend = new StructuredAgentBackend(
        new RecordedChatBackend('mock', [JSON.stringify({ final: 'from the first model' })]),
      );
      const agent = new Agent({ backend, ctx, permission, system: 'SYS' });
      const first = await agent.run('hello');
      expect(first.final).toBe('from the first model');

      agent.setBackend(
        new StructuredAgentBackend(
          new RecordedChatBackend('mock', [JSON.stringify({ final: 'from the second model' })]),
        ),
      );
      const second = await agent.run('again');
      expect(second.final).toBe('from the second model');
    } finally {
      await cleanup();
    }
  });
});

describe('plan-mode gate', () => {
  it('blocks a mutating tool in plan mode, then applies it after plan approval', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const permission = scriptPermission();
      const agent = agentWith(
        ctx,
        [
          // 1. Try to edit before a plan — must be blocked.
          JSON.stringify({ tool: 'edit_character', args: { id: 'aiko', status: 'approved' } }),
          // 2. Propose a plan — approved → switches to execute mode.
          JSON.stringify({
            tool: 'propose_plan',
            args: { summary: 'Approve Aiko', steps: ['set status'], files: ['characters/aiko'] },
          }),
          // 3. Now the edit succeeds in execute mode.
          JSON.stringify({ tool: 'edit_character', args: { id: 'aiko', status: 'approved' } }),
          JSON.stringify({ final: 'Aiko is approved.' }),
        ],
        permission,
      );
      const res = await agent.run('approve aiko');

      expect(res.events.some((e) => e.type === 'blocked')).toBe(true);
      expect(permission.plans).toHaveLength(1);
      expect(res.mode).toBe('execute');
      const text = await fs.readFile(join(dir, 'characters', 'aiko', 'character.md'), 'utf8');
      expect(text).toContain('status: approved');
    } finally {
      await cleanup();
    }
  });

  it('stays in plan mode and does not edit when the plan is rejected', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const permission = scriptPermission({
        approvePlan: () => Promise.resolve({ approved: false, feedback: 'not yet' }),
      });
      const agent = agentWith(
        ctx,
        [
          JSON.stringify({
            tool: 'propose_plan',
            args: { summary: 'Approve Aiko', steps: [], files: [] },
          }),
          JSON.stringify({ final: 'Holding off.' }),
        ],
        permission,
      );
      const res = await agent.run('approve aiko');
      expect(res.mode).toBe('plan');
      const text = await fs.readFile(join(dir, 'characters', 'aiko', 'character.md'), 'utf8');
      expect(text).toContain('status: draft');
    } finally {
      await cleanup();
    }
  });
});

describe('always-confirm gate', () => {
  it('does not run a confirm-gated tool when the user declines', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const permission = scriptPermission({ confirmAction: () => Promise.resolve(false) });
      const agent = agentWith(
        ctx,
        [
          JSON.stringify({ tool: 'git_revert', args: { ref: 'HEAD' } }),
          JSON.stringify({ final: 'Did not revert.' }),
        ],
        permission,
        'execute',
      );
      const res = await agent.run('undo the last commit');
      expect(permission.confirms).toContain('git_revert');
      expect(res.events.some((e) => e.type === 'blocked')).toBe(true);
      expect(res.events.some((e) => e.type === 'tool')).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe('commit gate', () => {
  it('blocks git_commit while error-severity diagnostics remain', async () => {
    const { ctx, dir, cleanup } = await tempProject(BROKEN_SCENE);
    try {
      await openGit(dir).init();
      const agent = agentWith(
        ctx,
        [
          JSON.stringify({ tool: 'git_commit', args: { message: 'wip' } }),
          JSON.stringify({ final: 'Cannot commit; fix the dangling scene first.' }),
        ],
        scriptPermission(),
        'execute',
      );
      const res = await agent.run('commit my work');
      const blocked = res.events.find((e) => e.type === 'blocked');
      expect(blocked).toMatchObject({ tool: 'git_commit' });
      expect(res.events.some((e) => e.type === 'tool')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('auto-stages the agent edits and commits them when given no explicit paths', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      initRepo(dir);
      const agent = agentWith(
        ctx,
        [
          JSON.stringify({
            tool: 'propose_plan',
            args: { summary: 'Approve Aiko', steps: ['set status'], files: ['characters/aiko'] },
          }),
          JSON.stringify({ tool: 'edit_character', args: { id: 'aiko', status: 'approved' } }),
          // No `paths` — the loop must stage exactly what the agent edited this plan.
          JSON.stringify({ tool: 'git_commit', args: { message: 'Approve Aiko' } }),
          JSON.stringify({ final: 'Committed.' }),
        ],
        scriptPermission(),
      );
      const res = await agent.run('approve aiko and commit');
      expect(res.events.some((e) => e.type === 'blocked')).toBe(false);

      // Exactly one commit, containing only the edited character file — untracked siblings
      // (locations, scenes, project.yaml) must NOT be swept in.
      const log = execFileSync('git', ['log', '--oneline'], { cwd: dir }).toString().trim();
      expect(log.split('\n')).toHaveLength(1);
      expect(log).toContain('Approve Aiko');
      const committed = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], {
        cwd: dir,
      })
        .toString()
        .trim();
      expect(committed).toBe('characters/aiko/character.md');
      // The untracked siblings were not swept in: the tree is still dirty after the commit.
      const status = await openGit(dir).status();
      expect(status.dirty).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe('ask_user', () => {
  it('routes a question through the permission host and feeds the answer back', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const permission = scriptPermission({ ask: () => Promise.resolve('Call her Aiko.') });
      const agent = agentWith(
        ctx,
        [
          JSON.stringify({ tool: 'ask_user', args: { question: 'What name?' } }),
          JSON.stringify({ final: 'Got it.' }),
        ],
        permission,
      );
      const res = await agent.run('rename the lead');
      expect(res.final).toBe('Got it.');
    } finally {
      await cleanup();
    }
  });
});

describe('ask_choice', () => {
  /**
   * Run one `ask_choice` turn. Reports what the permission host was offered, and the prompt the
   * *next* step was built from — which is where a control tool's observation shows up, there being
   * no `tool` event for one.
   */
  async function askWith(
    ctx: ToolContext,
    args: unknown,
    reply = 'ok',
  ): Promise<{ asked: [string, AskChoices | undefined][]; observed: string }> {
    const asked: [string, AskChoices | undefined][] = [];
    const permission = scriptPermission({
      ask: (question, choices) => {
        asked.push([question, choices]);
        return Promise.resolve(reply);
      },
    });
    const prompts: string[] = [];
    const chat = new RecordedChatBackend('mock', (req, call) => {
      prompts.push(req.prompt);
      return call === 0
        ? JSON.stringify({ tool: 'ask_choice', args })
        : JSON.stringify({ final: 'done' });
    });
    const agent = new Agent({
      backend: new StructuredAgentBackend(chat),
      ctx,
      permission,
      system: 'SYS',
    });
    await agent.run('what should she wear?');
    return { asked, observed: prompts[1] ?? '' };
  }

  it('hands the shortlist to the host beside the question', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const { asked } = await askWith(ctx, {
        question: 'Which outfit?',
        choices: ['uniform', 'track'],
      });
      expect(asked).toEqual([['Which outfit?', { options: ['uniform', 'track'], multi: false }]]);
    } finally {
      await cleanup();
    }
  });

  it('passes multi through, so a host knows whether more than one may be picked', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const { asked } = await askWith(ctx, {
        question: 'Which scenes?',
        choices: ['arrival', 'greet', 'ending'],
        multi: true,
      });
      expect(asked[0]?.[1]?.multi).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('refuses a shortlist of one rather than asking a leading question', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const { asked, observed } = await askWith(ctx, { question: 'Sure?', choices: ['yes'] });
      expect(asked).toHaveLength(0);
      expect(observed).toContain('at least two "choices"');
    } finally {
      await cleanup();
    }
  });

  it('feeds back whatever the author said, whether it was on the list or not', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const said = 'None of those — let us talk it through before I pick.';
      const { observed } = await askWith(
        ctx,
        { question: 'Which outfit?', choices: ['uniform', 'track'] },
        said,
      );
      expect(observed).toContain(`OBSERVATION: User answered: ${said}`);
    } finally {
      await cleanup();
    }
  });
});

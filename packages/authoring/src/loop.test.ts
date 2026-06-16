import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit } from '@vn/git';
import { RecordedChatBackend } from '@vn/providers';
import {
  Agent,
  StructuredAgentBackend,
  Workspace,
  type Permission,
  type Plan,
  type PlanDecision,
  type ToolContext,
} from './index.js';

const CHARACTER = `---
id: aiko
name: Aiko
status: draft
default_outfit: uniform
palette: ['#1a2a44']
traits: [curious]
reference_images: []
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

const SCRIPT = `Title: Test

INT. CLASSROOM - AFTERNOON

[[scene: arrival]]

AIKO
Hello.
`;

/** A screenplay with a dangling target → an error-severity diagnostic. */
const BROKEN_SCRIPT = `Title: Test

INT. CLASSROOM - AFTERNOON

[[scene: arrival]]
[[next: nowhere]]

AIKO
Hello.
`;

async function tempProject(script = SCRIPT): Promise<{
  ctx: ToolContext;
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-loop-'));
  await fs.mkdir(join(dir, 'characters', 'aiko'), { recursive: true });
  await fs.mkdir(join(dir, 'locations'), { recursive: true });
  await fs.mkdir(join(dir, 'screenplay'), { recursive: true });
  await fs.writeFile(join(dir, 'characters', 'aiko', 'character.md'), CHARACTER);
  await fs.writeFile(join(dir, 'locations', 'classroom.md'), LOCATION);
  await fs.writeFile(join(dir, 'screenplay', 'script.fountain'), script);
  await fs.writeFile(join(dir, 'project.yaml'), 'title: Test Project\n');
  const ctx: ToolContext = { workspace: new Workspace(dir), git: openGit(dir) };
  return { ctx, dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
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
    async ask(question): Promise<string> {
      return over.ask ? over.ask(question) : 'ok';
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
    const { ctx, dir, cleanup } = await tempProject(BROKEN_SCRIPT);
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

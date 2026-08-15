import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProject } from '@vn/testkit';
import { renderDiff, renderEvent, renderPlan } from '../render.js';
import { runRepl, terminalPermission, type Channel } from '../repl.js';

/** A scripted channel: feeds fixed answers, records everything written/asked. */
function scriptChannel(inputs: string[]): { channel: Channel; out: string[] } {
  const out: string[] = [];
  let i = 0;
  const channel: Channel = {
    ask(question) {
      out.push(question);
      return Promise.resolve(inputs[i++] ?? '/exit');
    },
    write(text) {
      out.push(text);
    },
    close() {},
  };
  return { channel, out };
}

async function tempProject(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const p = await makeProject({
    title: 'Test Project',
    script: 'INT. CLASSROOM - DAY\n\n[[scene: arrival]]\n\nAIKO\nHi.\n',
  });
  return { dir: p.dir, cleanup: () => p.cleanup() };
}

describe('render helpers', () => {
  it('renders a plan with steps, files, and risks', () => {
    const text = renderPlan({
      summary: 'Approve Aiko',
      steps: ['set status to approved'],
      files: ['characters/aiko/character.md'],
      risks: ['locks the portrait'],
    });
    expect(text).toContain('Approve Aiko');
    expect(text).toContain('set status to approved');
    expect(text).toContain('characters/aiko/character.md');
    expect(text).toContain('locks the portrait');
  });

  it('renders an empty diff as a placeholder', () => {
    expect(renderDiff('')).toContain('no changes');
  });

  it('summarizes a tool event with its written paths', () => {
    const line = renderEvent({
      type: 'tool',
      tool: 'edit_character',
      args: {},
      result: { ok: true, output: 'done', written: ['characters/aiko/character.md'] },
    });
    expect(line).toContain('edit_character');
    expect(line).toContain('characters/aiko/character.md');
  });
});

describe('terminalPermission', () => {
  it('approves a plan on yes', async () => {
    const { channel } = scriptChannel(['y']);
    const decision = await terminalPermission(channel).approvePlan({
      summary: 's',
      steps: [],
      files: [],
    });
    expect(decision.approved).toBe(true);
  });

  it('rejects a plan on no and captures feedback', async () => {
    const { channel } = scriptChannel(['n', 'not yet']);
    const decision = await terminalPermission(channel).approvePlan({
      summary: 's',
      steps: [],
      files: [],
    });
    expect(decision).toEqual({ approved: false, feedback: 'not yet' });
  });

  it('gates a confirm-action on yes/no', async () => {
    const yes = await terminalPermission(scriptChannel(['y']).channel).confirmAction('git_revert', {
      ref: 'HEAD',
    });
    const no = await terminalPermission(scriptChannel(['n']).channel).confirmAction('git_revert', {
      ref: 'HEAD',
    });
    expect(yes).toBe(true);
    expect(no).toBe(false);
  });
});

describe('runRepl (offline)', () => {
  it('handles commands and a turn, then exits cleanly', async () => {
    const { dir, cleanup } = await tempProject();
    try {
      const { channel, out } = scriptChannel(['/help', '/status', 'introduce yourself', '/exit']);
      const code = await runRepl({ dir, mock: true, channel });
      const text = out.join('\n');
      expect(code).toBe(0);
      expect(text).toContain('Commands:');
      expect(text).toContain('/model');
      expect(text).toContain('/effort');
      expect(text).toContain('/clear');
      expect(text).toContain('Shift-Tab');
      expect(text).toContain('aiko');
      expect(text).toContain('[mock]');
    } finally {
      await cleanup();
    }
  });

  it('clears context with /clear', async () => {
    const { dir, cleanup } = await tempProject();
    try {
      const { channel, out } = scriptChannel(['/clear', '/exit']);
      const code = await runRepl({ dir, mock: true, channel });
      const text = out.join('\n');
      expect(code).toBe(0);
      expect(text).not.toContain('unknown command');
      expect(text).toContain('Context cleared');
    } finally {
      await cleanup();
    }
  });

  it('composes a /makeimage prompt in plan mode and draws nothing', async () => {
    const { dir, cleanup } = await tempProject();
    try {
      const { channel, out } = scriptChannel(['/makeimage', '/makeimage the classroom at dusk']);
      const code = await runRepl({ dir, mock: true, channel });
      const text = out.join('\n');
      expect(code).toBe(0);
      expect(text).not.toContain('unknown command');
      expect(text).toContain('Usage: /makeimage');
      // The prompt is worth reading before spending anything, so plan mode still composes it.
      expect(text).toContain('subject: location:classroom');
      expect(text).toContain('the classroom at dusk');
      expect(text).toContain('Plan mode');
      expect(text).not.toContain('wrote ');
    } finally {
      await cleanup();
    }
  });

  it('archives /upload files and offers openers without asking the model anything', async () => {
    const { dir, cleanup } = await tempProject();
    const source = join(await fs.mkdtemp(join(tmpdir(), 'vn-upload-')), 'field notes.md');
    await fs.writeFile(source, '# Field notes\n\nThe third district burned.\n');
    try {
      const { channel, out } = scriptChannel(['/upload', `/upload "${source}"`, '/exit']);
      const code = await runRepl({ dir, mock: true, channel });
      const text = out.join('\n');
      expect(code).toBe(0);
      expect(text).not.toContain('unknown command');
      expect(text).toContain('Usage: /upload');
      // A quoted path with a space survives the split, and the name is kept verbatim.
      expect(text).toContain('field notes.md');
      expect(text).toContain('What next?');
      expect(text).toContain('1. ');

      const batches = await fs.readdir(join(dir, 'archive'));
      expect(batches).toHaveLength(1);
      const stored = join(dir, 'archive', batches[0] as string, 'field notes.md');
      expect(await fs.readFile(stored, 'utf8')).toBe(
        '# Field notes\n\nThe third district burned.\n',
      );
    } finally {
      await cleanup();
    }
  });

  it('routes /model and /effort, reporting they have no effect under --mock', async () => {
    const { dir, cleanup } = await tempProject();
    try {
      const { channel, out } = scriptChannel(['/model', '/effort', '/exit']);
      const code = await runRepl({ dir, mock: true, channel });
      const text = out.join('\n');
      expect(code).toBe(0);
      // Both commands are recognized (not "unknown command") and explain the --mock no-op.
      expect(text).not.toContain('unknown command');
      expect(text).toContain('/model has no effect');
      expect(text).toContain('/effort has no effect');
    } finally {
      await cleanup();
    }
  });
});

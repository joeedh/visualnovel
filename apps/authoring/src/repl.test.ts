import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderDiff, renderEvent, renderPlan } from './render.js';
import { runRepl, terminalPermission, type Channel } from './repl.js';

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
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-repl-'));
  await fs.mkdir(join(dir, 'characters', 'aiko'), { recursive: true });
  await fs.mkdir(join(dir, 'locations'), { recursive: true });
  await fs.mkdir(join(dir, 'screenplay'), { recursive: true });
  await fs.writeFile(
    join(dir, 'characters', 'aiko', 'character.md'),
    '---\nid: aiko\nname: Aiko\nstatus: draft\n---\n\nA transfer student.\n',
  );
  await fs.writeFile(
    join(dir, 'screenplay', 'script.fountain'),
    'Title: Test\n\nINT. CLASSROOM - DAY\n\n[[scene: arrival]]\n\nAIKO\nHi.\n',
  );
  await fs.writeFile(join(dir, 'project.yaml'), 'title: Test Project\n');
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
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
      expect(text).toContain('aiko');
      expect(text).toContain('[mock]');
    } finally {
      await cleanup();
    }
  });
});

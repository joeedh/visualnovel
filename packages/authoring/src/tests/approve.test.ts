/**
 * Approving art on the author's say-so. Three things are worth pinning: that the authority is the
 * author's own words and not the agent's argument, that nothing outside the host's list can be
 * approved however it is named, and that the author sees the final list before anything is
 * written.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGit } from '@vn/git';
import type { ChatBackend } from '@vn/providers';
import {
  Workspace,
  approvalCard,
  createRegistry,
  narrowTriage,
  offlineTriage,
  triageApprovals,
  type Approvable,
  type ApprovalControl,
  type ApprovalTriage,
  type Tool,
  type ToolContext,
} from '../index.js';

const AIKO: Approvable = {
  hash: 'a'.repeat(64),
  kind: 'sheet',
  label: 'Aiko — uniform sheet',
  slot: 'sheet:aiko/uniform',
  door: 'accept',
};
const PLATE: Approvable = {
  hash: 'b'.repeat(64),
  kind: 'plate',
  label: 'Classroom 2-B — day plate',
  slot: 'plate:classroom/day',
  door: 'accept',
};
const PORTRAIT: Approvable = {
  hash: 'c'.repeat(64),
  kind: 'portrait',
  label: 'Aiko — portrait',
  slot: 'portrait:aiko',
  door: 'gate',
  characterId: 'aiko',
};
const ALL = [PORTRAIT, AIKO, PLATE];

/** A backend that answers with whatever JSON it was handed, and records what it was asked. */
function fakeTriage(answer: unknown): ChatBackend & { asked: string[] } {
  const backend = {
    asked: [] as string[],
    modelId: 'fake-haiku',
    message(req: { system?: string; prompt: string }): Promise<string> {
      backend.asked.push(req.prompt);
      return Promise.resolve(JSON.stringify(answer));
    },
  };
  return backend;
}

describe('reading what the author asked for', () => {
  it('only ever hands back hashes that were on the list', async () => {
    const backend = fakeTriage({
      asked: true,
      reason: 'you said "approve the art"',
      hashes: [AIKO.hash, 'd'.repeat(64)],
    });
    const triage = await triageApprovals(backend, { said: ['approve the art'], assets: ALL });
    expect(triage.hashes).toEqual([AIKO.hash]);
  });

  it('is shown the author, and only the author', async () => {
    const backend = fakeTriage({ asked: false, reason: 'no', hashes: [] });
    await triageApprovals(backend, { said: ['approve the plates'], assets: ALL });
    const prompt = backend.asked[0] ?? '';
    expect(prompt).toContain('approve the plates');
    expect(prompt).toContain(PLATE.hash);
    // The assistant's side of the conversation is never in there: being asked is not evidence.
    expect(prompt).not.toContain('assistant');
  });

  // Two rules the model is told and the code enforces anyway, because both fail silently.
  it('drops everything when the answer is that they did not ask', () => {
    const answered: ApprovalTriage = { asked: false, reason: 'no', hashes: [AIKO.hash] };
    expect(narrowTriage(answered, ALL).hashes).toEqual([]);
  });
});

describe('the offline matcher', () => {
  it('says no when nothing in the conversation asks for it', () => {
    const triage = offlineTriage({ said: ['draw me a classroom', 'nice'], assets: ALL });
    expect(triage.asked).toBe(false);
    expect(triage.hashes).toEqual([]);
  });

  it('covers everything when the request names nothing in particular', () => {
    const triage = offlineTriage({ said: ['approve all of it'], assets: ALL });
    expect(triage.asked).toBe(true);
    expect(triage.hashes).toEqual(ALL.map((a) => a.hash));
  });

  it('covers only what a qualified request names', () => {
    const triage = offlineTriage({ said: ['approve the plate please'], assets: ALL });
    expect(triage.hashes).toEqual([PLATE.hash]);
  });

  // The reason is what the author reads on the card, so it must not read like a model's judgement.
  it('says out loud that no model read anything', () => {
    expect(offlineTriage({ said: ['approve it'], assets: ALL }).reason).toContain(
      'without a model',
    );
  });
});

describe('the card the author confirms', () => {
  it('names every picture and what approving it does, and why it is on the list', () => {
    const card = approvalCard(
      { asked: true, reason: 'you said "approve everything"', hashes: [] },
      [PORTRAIT, PLATE],
    );
    expect(card).toContain('Approve 2 pictures?');
    expect(card).toContain('Aiko — portrait — clears the character gate');
    expect(card).toContain('Classroom 2-B — day plate — accepted for its slot');
    expect(card).toContain('you said "approve everything"');
  });
});

describe('the approve_assets tool', () => {
  const registry = createRegistry();
  const approveTool = registry.get('approve_assets');
  if (!approveTool) throw new Error('no approve_assets tool');

  async function tempCtx(over: Partial<ToolContext> = {}): Promise<{
    ctx: ToolContext;
    cleanup: () => Promise<void>;
  }> {
    const dir = await fs.mkdtemp(join(tmpdir(), 'vn-approve-'));
    const ctx: ToolContext = { workspace: new Workspace(dir), git: openGit(dir), ...over };
    return { ctx, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
  }

  /** A host that lists `assets`, answers `triage`, and records what it was told to approve. */
  function host(
    assets: Approvable[],
    triage: ApprovalTriage,
  ): ApprovalControl & {
    approved: string[];
  } {
    const it = {
      approved: [] as string[],
      list: () => Promise.resolve(assets),
      approve: (item: Approvable) => {
        it.approved.push(item.hash);
        return Promise.resolve({ ok: true, message: `Accepted ${item.hash.slice(0, 8)}.` });
      },
      // Answering `null` puts the offline matcher in charge, so the fixed `triage` is injected
      // by handing back a backend that replies with it.
      triage: () => Promise.resolve(fakeTriage(triage) as ChatBackend | null),
    };
    return it;
  }

  const run = (ctx: ToolContext): ReturnType<Tool['run']> => approveTool.run({}, ctx);

  it('refuses where there is no host that can approve anything', async () => {
    const { ctx, cleanup } = await tempCtx({ said: () => ['approve it'] });
    try {
      const result = await run(ctx);
      expect(result.ok).toBe(false);
      expect(result.output).toContain('vnauthor does not do');
    } finally {
      await cleanup();
    }
  });

  it('refuses where nobody is there to confirm', async () => {
    const approval = host(ALL, { asked: true, reason: 'r', hashes: [AIKO.hash] });
    const { ctx, cleanup } = await tempCtx({ approval, said: () => ['approve it'] });
    try {
      const result = await run(ctx);
      expect(result.ok).toBe(false);
      expect(result.output).toContain('nobody is here to confirm');
      expect(approval.approved).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('refuses, and approves nothing, when the author did not ask', async () => {
    const approval = host(ALL, { asked: false, reason: 'you asked to see it.', hashes: [] });
    const { ctx, cleanup } = await tempCtx({
      approval,
      said: () => ['show me the plate'],
      confirm: () => Promise.resolve(true),
    });
    try {
      const result = await run(ctx);
      expect(result.ok).toBe(false);
      expect(result.output).toContain('You did not ask me to approve anything');
      expect(approval.approved).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('shows the list, then approves it in the order it was listed', async () => {
    const approval = host(ALL, {
      asked: true,
      reason: 'you said "approve the art"',
      hashes: [PLATE.hash, PORTRAIT.hash],
    });
    const cards: string[] = [];
    const { ctx, cleanup } = await tempCtx({
      approval,
      said: () => ['approve the art'],
      confirm: (message) => {
        cards.push(message);
        return Promise.resolve(true);
      },
    });
    try {
      const result = await run(ctx);
      expect(result.ok).toBe(true);
      // Listed order, not the order the triage model happened to name them in: upstream first is
      // what lets one call approve a plate and the frame drawn from it.
      expect(approval.approved).toEqual([PORTRAIT.hash, PLATE.hash]);
      expect(cards[0]).toContain('Approve 2 pictures?');
    } finally {
      await cleanup();
    }
  });

  it('writes nothing when the author says no to the card', async () => {
    const approval = host(ALL, { asked: true, reason: 'r', hashes: [AIKO.hash] });
    const { ctx, cleanup } = await tempCtx({
      approval,
      said: () => ['approve it'],
      confirm: () => Promise.resolve(false),
    });
    try {
      const result = await run(ctx);
      expect(result.ok).toBe(true);
      expect(result.output).toContain('you said no');
      expect(approval.approved).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('holds back what is waiting upstream, and says so on the card', async () => {
    const held: Approvable = { ...PLATE, blocked: 'the sketch it was drawn from is unapproved' };
    const approval = host([AIKO, held], {
      asked: true,
      reason: 'you said "approve everything"',
      hashes: [AIKO.hash, held.hash],
    });
    const cards: string[] = [];
    const { ctx, cleanup } = await tempCtx({
      approval,
      said: () => ['approve everything'],
      confirm: (message) => {
        cards.push(message);
        return Promise.resolve(true);
      },
    });
    try {
      const result = await run(ctx);
      expect(result.ok).toBe(true);
      expect(approval.approved).toEqual([AIKO.hash]);
      expect(cards[0]).toContain('Held back');
      expect(cards[0]).toContain('the sketch it was drawn from is unapproved');
    } finally {
      await cleanup();
    }
  });

  it('refuses when everything named is waiting upstream', async () => {
    const held: Approvable = { ...PLATE, blocked: 'its plate is unapproved' };
    const approval = host([held], { asked: true, reason: 'r', hashes: [held.hash] });
    const { ctx, cleanup } = await tempCtx({
      approval,
      said: () => ['approve the plate'],
      confirm: () => Promise.resolve(true),
    });
    try {
      const result = await run(ctx);
      expect(result.ok).toBe(false);
      expect(result.output).toContain('waiting on something upstream');
      expect(approval.approved).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('says so plainly when there is nothing to approve', async () => {
    const approval = host([], { asked: true, reason: 'r', hashes: [] });
    const { ctx, cleanup } = await tempCtx({
      approval,
      said: () => ['approve everything'],
      confirm: () => Promise.resolve(true),
    });
    try {
      const result = await run(ctx);
      expect(result.ok).toBe(true);
      expect(result.output).toContain('Nothing is waiting for approval');
    } finally {
      await cleanup();
    }
  });
});

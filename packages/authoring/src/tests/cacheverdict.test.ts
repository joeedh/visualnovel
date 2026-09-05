/**
 * Whether a call read the prompt cache as it should have, judged from two consecutive receipts.
 *
 * No vendor reports a miss, so every case here is the relation between one receipt and the one
 * before it: everything readable last call plus everything written last call should be readable
 * this call. The scripted backend hands out receipts in order and the clock is a variable, so the
 * TTL branch is reachable without waiting five minutes.
 */
import type { ChatBackend, TokenUsage } from '@vn/providers';
import { NativeAgentBackend, type AgentMessage, type ToolSpec } from '../backend.js';

const TOOLS: ToolSpec[] = [{ name: 'read_file', description: 'Read a file.', mutating: false }];
const MESSAGES: AgentMessage[] = [{ role: 'user', content: 'Show me the script.' }];

/** A conversation backend that returns the given receipts, one per call, and no tool calls. */
function scripted(
  receipts: (TokenUsage | undefined)[],
  claims: Pick<ChatBackend, 'cacheReporting' | 'cacheTtlMs'>,
): ChatBackend {
  let call = 0;
  return {
    modelId: 'mock-native',
    ...claims,
    message         : () => Promise.reject(new Error('the native path does not call message()')),
    chatConversation: () => {
      const usage = receipts[call++];
      return Promise.resolve({ raw: [], toolCalls: [], text: 'ok', ...(usage ? { usage } : {}) });
    },
  };
}

const BILLED = { cacheReporting: 'billed', cacheTtlMs: 60_000 } as const;

/** Every verdict a run of receipts produced, in order. */
async function verdicts(
  chat: ChatBackend,
  clock: () => number,
  calls = 2,
): Promise<(string | undefined)[]> {
  const backend = new NativeAgentBackend(chat, clock);
  const out: (string | undefined)[] = [];
  for (let i = 0; i < calls; i++) {
    out.push((await backend.next('sys', MESSAGES, TOOLS)).cacheVerdict);
  }
  return out;
}

describe('the cache verdict on a billed backend', () => {
  it('opens cold and reads a rising count as a hit', async () => {
    const chat = scripted(
      [
        { input: 1000, output: 10, cacheRead: 0, cacheWrite: 900 },
        { input: 1000, output: 10, cacheRead: 900, cacheWrite: 80 },
      ],
      BILLED,
    );
    expect(await verdicts(chat, () => 0)).toEqual(['cold', 'hit']);
  });

  it('reads a drop inside the TTL as a miss', async () => {
    const chat = scripted(
      [
        { input: 1000, output: 10, cacheRead: 900, cacheWrite: 80 },
        { input: 1000, output: 10, cacheRead: 0, cacheWrite: 980 },
      ],
      BILLED,
    );
    expect(await verdicts(chat, () => 0)).toEqual(['cold', 'miss']);
  });

  it('reads the same drop after the TTL as expired, which is not a defect', async () => {
    const chat = scripted(
      [
        { input: 1000, output: 10, cacheRead: 900, cacheWrite: 80 },
        { input: 1000, output: 10, cacheRead: 0, cacheWrite: 980 },
      ],
      BILLED,
    );
    let clock = 0;
    const backend = new NativeAgentBackend(chat, () => clock);
    await backend.next('sys', MESSAGES, TOOLS);
    clock = 60_001;
    expect((await backend.next('sys', MESSAGES, TOOLS)).cacheVerdict).toBe('expired');
  });

  it('says nothing about a drop when the backend declared no TTL', async () => {
    // The drop is real and its cause is not: without a TTL, aged-out and broken are the same bytes
    const chat = scripted(
      [
        { input: 1000, output: 10, cacheRead: 900, cacheWrite: 80 },
        { input: 1000, output: 10, cacheRead: 0, cacheWrite: 980 },
      ],
      { cacheReporting: 'billed' },
    );
    expect(await verdicts(chat, () => 0)).toEqual(['cold', undefined]);
  });

  it('says nothing where a figure the comparison needs was never reported', async () => {
    // An absent count means the vendor said nothing, so reading it as a zero would report a miss
    // against a cache that worked
    const chat = scripted(
      [
        { input: 1000, output: 10, cacheRead: 900, cacheWrite: 80 },
        { input: 1000, output: 10 },
        { input: 1000, output: 10, cacheRead: 0, cacheWrite: 980 },
      ],
      BILLED,
    );
    expect(await verdicts(chat, () => 0, 3)).toEqual(['cold', undefined, undefined]);
  });

  it('is cold again after the conversation is cleared', async () => {
    const chat = scripted(
      [
        { input: 1000, output: 10, cacheRead: 900, cacheWrite: 80 },
        { input: 1000, output: 10, cacheRead: 0, cacheWrite: 980 },
      ],
      BILLED,
    );
    const backend = new NativeAgentBackend(chat, () => 0);
    await backend.next('sys', MESSAGES, TOOLS);
    backend.reset();
    expect((await backend.next('sys', MESSAGES, TOOLS)).cacheVerdict).toBe('cold');
  });

  it('says nothing where the call reported no receipt at all', async () => {
    const chat = scripted([undefined, undefined], BILLED);
    expect(await verdicts(chat, () => 0)).toEqual([undefined, undefined]);
  });
});

describe('the cache verdict on a backend that cannot be compared', () => {
  const dropping: TokenUsage[] = [
    { input: 1000, output: 10, cacheRead: 900 },
    { input: 1000, output: 10, cacheRead: 0 },
  ];

  it('is absent where the backend claims nothing', async () => {
    expect(await verdicts(scripted(dropping, {}), () => 0)).toEqual([undefined, undefined]);
  });

  it('is absent where the figures are an estimate', async () => {
    const chat = scripted(dropping, { cacheReporting: 'estimated' });
    expect(await verdicts(chat, () => 0)).toEqual([undefined, undefined]);
  });

  it('is absent for a hardcoded zero, which is what this gate exists for', async () => {
    // Ollama, KoboldCpp and LM Studio emit `cached_tokens: 0` on every call whatever the cache
    // did. Judged on shape alone this is an unbroken run of misses against a working cache.
    const stub = { input: 1000, output: 10, cacheRead: 0, cacheEstimated: true };
    const chat = scripted([stub, stub, stub], { cacheReporting: 'estimated' });
    expect(await verdicts(chat, () => 0, 3)).toEqual([undefined, undefined, undefined]);
  });
});

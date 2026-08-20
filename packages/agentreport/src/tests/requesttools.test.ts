import type { Tool, ToolResult } from '@vn/authoring';
import type { CaptureSnapshot, CapturedHeader } from '@vn/providers';
import { buildRedactor } from '../redact.js';
import { createRequestTools, MAX_VALUE } from '../requesttools.js';
import { Budget } from '../sourcetools.js';

const redactor = buildRedactor({
  entities: [{ id: 'ember', name: 'Ember Vale', kind: 'character' }],
});

/** A body the shapes below are read out of: two messages, a tool result, and a picture. */
const BODY = {
  model: 'claude-x',
  max_tokens: 4096,
  system: [{ type: 'text', text: 'You are an author.', cache_control: { type: 'ephemeral' } }],
  messages: [
    { role: 'user', content: 'Ember Vale walks west.' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'thinking about it' },
        { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.fountain' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_9', content: 'the file' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(40) },
        },
      ],
    },
  ],
  tools: [{ name: 'read_file' }, { name: 'write_file' }],
};

function snapshot(
  over: Partial<CapturedHeader> = {},
  body: unknown = BODY,
  keepBody = true,
): CaptureSnapshot {
  const header: CapturedHeader = {
    seq: 1,
    label: 'convo',
    at: '2026-08-19T00:00:00.000Z',
    bytes: 900,
    dropped: false,
    ...over,
  };
  return {
    headers: () => [header],
    body: (seq) => (keepBody && seq === header.seq ? JSON.stringify(body) : undefined),
  };
}

const call = (
  tools: Map<string, Tool>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> =>
  (tools.get(name) as Tool<Record<string, unknown>>).run(args, {
    ask: () => Promise.resolve(''),
  } as never);

describe('list_requests', () => {
  it('lists headers, and never a body', async () => {
    const tools = createRequestTools({ snapshot: snapshot(), redactor });
    const res = await call(tools, 'list_requests');
    expect(res.ok).toBe(true);
    expect(res.output).toContain('#1');
    expect(res.output).toContain('convo');
    expect(res.output).toContain('900 B');
    expect(res.output).not.toContain('Ember');
  });

  it('says so when nothing was captured', async () => {
    const empty: CaptureSnapshot = { headers: () => [], body: () => undefined };
    const res = await call(createRequestTools({ snapshot: empty, redactor }), 'list_requests');
    expect(res.output).toMatch(/No requests were captured/);
  });

  it('marks a dropped body and redacts the failure it quotes', async () => {
    const tools = createRequestTools({
      snapshot: snapshot({ dropped: true, error: 'Ember Vale broke it\nstack line' }),
      redactor,
    });
    const res = await call(tools, 'list_requests');
    expect(res.output).toContain('header only');
    expect(res.output).not.toContain('Ember Vale');
    // Only the first line of the failure — the part that names a position.
    expect(res.output).not.toContain('stack line');
  });
});

describe('read_request without a path', () => {
  it('outlines the body by pointer, with no content in it', async () => {
    const tools = createRequestTools({ snapshot: snapshot(), redactor });
    const res = await call(tools, 'read_request', { seq: 1 });
    expect(res.ok).toBe(true);
    const out = res.output;
    // A scalar field is measured, not quoted: even `model` is content until proven otherwise.
    expect(out).toContain('/model  string, 8 chars');
    expect(out).toContain('/max_tokens  4096');
    expect(out).toContain('/messages  3 message(s)');
    expect(out).toContain('/messages/1  role=assistant, 2 block(s)');
    expect(out).toContain('/messages/1/content/1  tool_use, name=read_file, id=tu_1, input: path');
    expect(out).toContain('tool_use_id=tu_9');
    expect(out).toContain('of base64 — not readable');
    expect(out).toContain('/tools  2: read_file, write_file');
    // The shape, never the prose.
    expect(out).not.toContain('walks west');
    expect(out).not.toContain('You are an author');
  });

  it('refuses a seq nobody captured, and a body that was let go', async () => {
    const missing = await call(
      createRequestTools({ snapshot: snapshot(), redactor }),
      'read_request',
      {
        seq: 7,
      },
    );
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain('no request #7');

    const dropped = createRequestTools({
      snapshot: snapshot({ dropped: true }, BODY, false),
      redactor,
    });
    const res = await call(dropped, 'read_request', { seq: 1 });
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/body was not kept/);
  });
});

describe('read_request with a path', () => {
  const tools = () => createRequestTools({ snapshot: snapshot(), redactor });

  it(`returns one node's text, redacted`, async () => {
    const res = await call(tools(), 'read_request', { seq: 1, path: '/messages/0' });
    expect(res.ok).toBe(true);
    expect(res.output).toContain('walks west');
    expect(res.output).not.toContain('Ember Vale');
    expect(res.output).toContain('Character A');
  });

  it('names the segment a pointer stopped at', async () => {
    const gone = await call(tools(), 'read_request', { seq: 1, path: '/messages/9' });
    expect(gone.ok).toBe(false);
    expect(gone.output).toContain('3 item(s)');

    const nokey = await call(tools(), 'read_request', { seq: 1, path: '/nope' });
    expect(nokey.ok).toBe(false);
    expect(nokey.output).toContain('the body has no "nope"');

    const notpointer = await call(tools(), 'read_request', { seq: 1, path: 'messages' });
    expect(notpointer.ok).toBe(false);
    expect(notpointer.output).toContain('JSON Pointer');
  });

  it('refuses an encoded block by kind rather than by size', async () => {
    const res = await call(tools(), 'read_request', { seq: 1, path: '/messages/2/content/1' });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('encoded image block');
    expect(res.output).not.toContain('AAAA');
  });

  it('never walks into base64 under a node that holds it', async () => {
    const res = await call(tools(), 'read_request', { seq: 1, path: '/messages/2' });
    expect(res.ok).toBe(true);
    expect(res.output).toContain('the file');
    expect(res.output).not.toContain('AAAA');
  });

  it('caps a long value, says it capped, and redacts after the cut', async () => {
    // Cap first, redact second — so the pseudonym is never sliced through.
    const long = 'Ember Vale ' + 'x'.repeat(50);
    const body = { messages: [{ role: 'user', content: long }] };
    const tools = createRequestTools({ snapshot: snapshot({}, body), redactor, maxValue: 20 });
    const res = await call(tools, 'read_request', { seq: 1, path: '/messages/0/content' });
    expect(res.output).toContain(`(${long.length} chars, first 20 shown)`);
    expect(res.output).toContain('Character A');
    expect(res.output).not.toContain('Ember');
    expect(MAX_VALUE).toBeGreaterThan(20);
  });

  it('charges the shared budget and stops when it is spent', async () => {
    const budget = new Budget(100);
    const tools = createRequestTools({ snapshot: snapshot(), redactor, budget });
    const first = await call(tools, 'read_request', { seq: 1, path: '/messages/0' });
    expect(first.ok).toBe(true);
    expect(budget.spent).toBeGreaterThan(0);
    const second = await call(tools, 'read_request', { seq: 1 });
    expect(second.ok).toBe(false);
    expect(second.output).toMatch(/reading budget/);
  });
});

import { compactRange, compactionMessage, compactionPrompt } from '../compact.js';
import type { AgentMessage } from '../backend.js';

const call = (id: string): AgentMessage => ({
  role   : 'assistant',
  content: [{ type: 'tool_use', id, name: 'read_file', input: {} }],
});
const result = (id: string): AgentMessage => ({
  role     : 'observation',
  toolUseId: id,
  content  : 'the file',
});

describe('compactRange', () => {
  it('replaces a finished conversation with the summary alone', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'draft the second scene' },
      call('a'),
      result('a'),
      { role: 'assistant', content: 'done' },
    ];
    const cut = compactRange(messages, 'the summary');
    expect(cut.to).toBe(3);
    expect(cut.messages).toEqual([compactionMessage('the summary')]);
  });

  it('never cuts between a call and its result', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'draft the second scene' },
      { role: 'assistant', content: 'reading' },
      call('a'),
      result('a'),
    ];
    // The tail is dropped rather than divided when the last turn is still open.
    const open = compactRange([...messages, call('b')], 'the summary');
    expect(open.to).toBe(3);
    expect(open.messages).toEqual([compactionMessage('the summary'), call('b')]);
  });

  it('never leaves an observation first in the tail', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'draft the second scene' },
      call('a'),
      result('a'),
      call('b'),
      result('b'),
    ];
    const cut = compactRange(messages, 'the summary');
    expect(cut.to).toBe(4);
    expect(cut.messages.slice(1).some((m) => m.role === 'observation')).toBe(false);
  });

  it('answers -1 for a conversation with no completed turn', () => {
    expect(compactRange([call('a')], 'the summary').to).toBe(-1);
  });

  it('carries a summary as context, prefaced by what no longer counts as read', () => {
    const summary = compactionMessage('the summary');
    expect(summary.role).toBe('context');
    expect(summary.content).toContain('counts as read');
    expect(summary.content).toContain('the summary');
  });
});

describe('compactionPrompt', () => {
  it('renders the whole conversation into one user message', () => {
    const prompt = compactionPrompt([
      { role: 'user', content: 'draft the second scene' },
      call('a'),
      result('a'),
    ]);
    expect(prompt).toHaveLength(1);
    expect(prompt[0]?.role).toBe('user');
    expect(prompt[0]?.content).toContain('draft the second scene');
    expect(prompt[0]?.content).toContain('STILL OPEN');
  });
});

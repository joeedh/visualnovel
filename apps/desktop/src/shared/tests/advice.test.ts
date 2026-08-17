import {
  adviseEffort,
  adviseModel,
  adviseRun,
  analysisEffort,
  raisedEffort,
  stronger,
} from '../advice.js';

describe('adviseModel', () => {
  it('has nothing to say about the models this is meant to run on', () => {
    expect(adviseModel('claude-opus-4-8', false)).toEqual({ level: 'ok', text: '' });
    expect(adviseModel('claude-sonnet-4-6', true)).toEqual({ level: 'ok', text: '' });
  });

  it('warns off a fast model, and names a better one', () => {
    const advice = adviseModel('claude-haiku-4-5', false);
    expect(advice.level).toBe('warn');
    expect(advice.text).toContain('Haiku');
    expect(advice.text).toContain('Sonnet or Opus');
  });

  it('says the same about Flash, which is the same shape of model', () => {
    expect(adviseModel('gemini-2.5-flash', false).level).toBe('warn');
    expect(adviseModel('gemini-2.5-flash', false).text).toContain('Gemini Flash');
  });

  it('is sharper about a small model when it also has to read the source', () => {
    const plain = adviseModel('claude-haiku-4-5', false).text;
    const withSource = adviseModel('claude-haiku-4-5', true).text;
    expect(withSource.length).toBeGreaterThan(plain.length);
    expect(withSource).toContain('tool loop');
  });

  it('leads the Fable warning with the retention, because that is the point of this feature', () => {
    const advice = adviseModel('claude-fable-5', false);
    expect(advice.level).toBe('warn');
    expect(advice.text.indexOf('zero data retention')).toBeLessThan(advice.text.indexOf('costs'));
  });

  it('says Gemini Pro is usable but has no knob to turn up', () => {
    const advice = adviseModel('gemini-2.5-pro', false);
    expect(advice.level).toBe('note');
    expect(advice.text).toContain('no reasoning setting');
  });

  it('says nothing about a model it has never heard of', () => {
    expect(adviseModel('llama-99', true).level).toBe('ok');
  });
});

describe('adviseEffort', () => {
  it('warns when thinking is off', () => {
    const advice = adviseEffort('claude-opus-4-8', 'none');
    expect(advice.level).toBe('warn');
    expect(advice.text).toContain('summary of the conversation');
  });

  it('notes, rather than warns, that low is thin for a diagnosis', () => {
    expect(adviseEffort('claude-opus-4-8', 'low').level).toBe('note');
  });

  it('is quiet at medium and high', () => {
    expect(adviseEffort('claude-opus-4-8', 'medium').level).toBe('ok');
    expect(adviseEffort('claude-opus-4-8', 'high').level).toBe('ok');
  });

  it('notes that more than high is more than this needs, without refusing it', () => {
    expect(adviseEffort('claude-opus-4-8', 'max').level).toBe('note');
    expect(adviseEffort('claude-opus-4-8', 'max').text).toContain('not a search');
  });

  it('says nothing about effort on a model that has no such setting', () => {
    expect(adviseEffort('claude-haiku-4-5', 'none').level).toBe('ok');
    expect(adviseEffort('gemini-2.5-pro', 'max').level).toBe('ok');
  });
});

describe('the effort this dialog opens on', () => {
  it('takes the stronger of the two, by menu order', () => {
    expect(stronger('low', 'medium')).toBe('medium');
    expect(stronger('max', 'medium')).toBe('max');
    expect(stronger('none', 'none')).toBe('none');
  });

  it('steps the default up, so the low note is only ever seen by someone who chose low', () => {
    expect(analysisEffort('claude-opus-4-8', 'low')).toBe('medium');
    expect(raisedEffort('claude-opus-4-8', 'low')).toBe(true);
  });

  it('leaves a stronger binding alone', () => {
    expect(analysisEffort('claude-opus-4-8', 'high')).toBe('high');
    expect(raisedEffort('claude-opus-4-8', 'high')).toBe(false);
  });

  it('is nothing at all for a model with no knob', () => {
    expect(analysisEffort('claude-haiku-4-5', 'high')).toBeUndefined();
    expect(raisedEffort('claude-haiku-4-5', 'low')).toBe(false);
  });
});

describe('adviseRun', () => {
  it('is empty when there is nothing to say, so the strip shows the plain accept', () => {
    expect(adviseRun('claude-opus-4-8', 'medium', false)).toBe('');
  });

  it('puts the warning before the note', () => {
    const note = adviseRun('claude-fable-5', 'max', false);
    expect(note.indexOf('zero data retention')).toBeLessThan(note.indexOf('More thinking'));
  });

  it('says when it raised the effort, so nothing changed silently', () => {
    expect(adviseRun('claude-opus-4-8', 'medium', false, 'low')).toContain(
      'your conversation setting is unchanged',
    );
  });

  it('does not claim to have raised anything the author raised themselves', () => {
    expect(adviseRun('claude-opus-4-8', 'high', false, 'high')).not.toContain('Raised to');
  });
});

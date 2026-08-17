import {
  DEFAULT_EFFORT,
  EFFORT_CHOICES,
  effortChoicesFor,
  effortLabel,
  resolveEffort,
  supportsEffort,
} from '../textmodels.js';

describe('effortChoicesFor', () => {
  it('offers the full ladder and no-thinking on Opus 4.7+ and the 5s', () => {
    for (const id of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5']) {
      expect(effortChoicesFor(id)).toEqual(EFFORT_CHOICES);
    }
  });

  it('stops at high before xhigh landed on Opus 4.7', () => {
    for (const id of ['claude-opus-4-5', 'claude-opus-4-6', 'claude-sonnet-4-6']) {
      expect(effortChoicesFor(id)).toEqual(['none', 'low', 'medium', 'high', 'max']);
    }
  });

  it('never offers no-thinking on Fable/Mythos, which 400 on an explicit disable', () => {
    for (const id of ['claude-fable-5', 'claude-mythos-5']) {
      expect(effortChoicesFor(id)).not.toContain('none');
      expect(effortChoicesFor(id)).toContain('max');
    }
  });

  it('offers nothing for models with no knob at all', () => {
    for (const id of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'gemini-2.5-pro', '']) {
      expect(effortChoicesFor(id)).toEqual([]);
      expect(supportsEffort(id)).toBe(false);
    }
  });
});

describe('resolveEffort', () => {
  it('keeps a choice the model offers', () => {
    expect(resolveEffort('claude-opus-4-8', 'xhigh')).toBe('xhigh');
    expect(resolveEffort('claude-opus-4-8', 'none')).toBe('none');
  });

  it('steps down to the strongest weaker choice the model does offer', () => {
    expect(resolveEffort('claude-sonnet-4-6', 'xhigh')).toBe('high');
  });

  it('steps up when nothing weaker is offered', () => {
    // Fable thinks unconditionally, so `none` has to become the cheapest level it takes.
    expect(resolveEffort('claude-fable-5', 'none')).toBe('low');
  });

  it('answers undefined for a model with no knob', () => {
    expect(resolveEffort('claude-haiku-4-5', 'low')).toBeUndefined();
    expect(resolveEffort('gemini-2.5-flash', 'max')).toBeUndefined();
  });
});

describe('the stated default', () => {
  it('is a level, not the absence of one, and every model with a knob takes it', () => {
    expect(DEFAULT_EFFORT).toBe('low');
    for (const id of ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-fable-5', 'claude-opus-5']) {
      expect(resolveEffort(id, DEFAULT_EFFORT)).toBe('low');
    }
  });
});

describe('effortLabel', () => {
  it('spells out the one choice that is a state rather than a level', () => {
    expect(effortLabel('none')).toBe('no thinking');
    expect(effortLabel('max')).toBe('max');
  });
});

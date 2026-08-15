/**
 * The confirm card's wording. The author is being asked to spend an image call or throw work
 * away, so what the sentence *says* is the whole safeguard — a card reading `{"hash":"a1b2…"}`
 * is one the author clicks through without reading.
 */
import { confirmDetail } from '../toolconfirm.js';

describe('confirmDetail', () => {
  it('names the sentence a concept will be drawn from, and the cost', () => {
    const said = confirmDetail('generate_image', {
      sentence: 'an aerial shot of the high school at dusk',
      subject: 'location:school',
    });
    expect(said).toContain('an aerial shot of the high school at dusk');
    expect(said).toContain('location:school');
    expect(said).toContain('one image generation');
  });

  it('says a redraw keeps the original, and quotes the edited prompt', () => {
    const said = confirmDetail('edit_image', {
      hash: 'abcdef0123456789abcdef',
      prompt: 'the same shot, but at night',
    });
    expect(said).toContain('abcdef012345');
    expect(said).not.toContain('6789'); // the hash is clipped to something readable
    expect(said).toContain('the same shot, but at night');
    expect(said).toContain('the original stays');
  });

  it('distinguishes a redraw with no new prompt', () => {
    expect(confirmDetail('edit_image', { hash: 'a1b2c3d4' })).toContain('from the same prompt');
  });

  it('says what the destructive git tools destroy', () => {
    expect(confirmDetail('git_revert', { ref: 'HEAD~2' })).toContain('HEAD~2');
    expect(confirmDetail('git_restore', { path: 'characters/aiko' })).toContain('cannot be undone');
  });

  it('passes a skill’s own sentence through, and falls back to its name', () => {
    expect(confirmDetail('run_skill', { message: 'Runs pace.mjs over every scene.' })).toBe(
      'Runs pace.mjs over every scene.',
    );
    expect(confirmDetail('run_skill', { name: 'pacing' })).toContain('pacing');
  });

  it('gives an unknown tool a sentence rather than a blank', () => {
    // A new confirm-gated tool must never be *easier* to allow than the ones named above.
    expect(confirmDetail('some_new_tool', { a: 1 })).toBe('Run some_new_tool with {"a":1}.');
    expect(confirmDetail('some_new_tool', undefined)).toBe('Run some_new_tool.');
  });

  it('does not trust the argument shape', () => {
    expect(confirmDetail('generate_image', null)).toContain('Draw a concept sketch');
    expect(confirmDetail('edit_image', { hash: 42 })).toContain('from the same prompt');
  });

  it('flattens a multi-line prompt onto one line', () => {
    const said = confirmDetail('generate_image', { sentence: 'a hall,\n  then a door' });
    expect(said).toContain('a hall, then a door');
  });
});

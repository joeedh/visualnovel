/**
 * The Setup pane's per-vendor routing notes, and the list the startup notice names.
 */
import { projectConfig, type KeysPresent } from '@vn/types';
import { routingNotes } from '../session/routing.js';

const config = projectConfig.parse({
  title : 'T',
  models: {
    image : 'gemini-2.5-flash-image',
    vision: ['gemini-2.5-flash', 'claude-opus-4-8'],
    text  : 'claude-opus-4-8',
  },
});

const none: KeysPresent = { anthropic: false, gemini: false, openrouter: false };

describe('routingNotes', () => {
  it('says nothing under a vendor whose key resolves', () => {
    const { notes, unrouted } = routingNotes(config, { ...none, anthropic: true, gemini: true });
    expect(notes).toEqual({ anthropic: '', gemini: '', openrouter: '' });
    expect(unrouted).toEqual([]);
  });

  it('says which models OpenRouter carries, under their own vendor and under OpenRouter', () => {
    const { notes, unrouted } = routingNotes(config, { ...none, openrouter: true });
    expect(notes.anthropic).toBe(
      'claude-opus-4-8 will run through OpenRouter until an Anthropic key is provided',
    );
    expect(notes.gemini).toBe(
      'gemini-2.5-flash and gemini-2.5-flash-image will run through OpenRouter until a Gemini key is provided',
    );
    expect(notes.openrouter).toBe(
      'carrying gemini-2.5-flash, claude-opus-4-8 and gemini-2.5-flash-image right now',
    );
    expect(unrouted).toEqual([]);
  });

  it('names the models that cannot run when no key carries them', () => {
    const { notes, unrouted } = routingNotes(config, { ...none, anthropic: true });
    expect(notes.anthropic).toBe('');
    expect(notes.gemini).toBe(
      'no OpenRouter key either, so gemini-2.5-flash and gemini-2.5-flash-image cannot run',
    );
    expect(notes.openrouter).toBe('');
    expect(unrouted).toEqual(['gemini-2.5-flash', 'gemini-2.5-flash-image']);
  });

  it('files an id the author spelled for OpenRouter under that row alone', () => {
    const spelled = projectConfig.parse({
      title : 'T',
      models: { image: 'openai/gpt-image-2', vision: ['claude-opus-4-8'], text: 'claude-opus-4-8' },
    });
    const { notes, unrouted } = routingNotes(spelled, { ...none, anthropic: true });
    expect(notes.openrouter).toBe('no key, so openai/gpt-image-2 cannot run');
    expect(notes.anthropic).toBe('');
    expect(unrouted).toEqual(['openai/gpt-image-2']);
  });
});

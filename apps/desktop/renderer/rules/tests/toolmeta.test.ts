/**
 * `VnToolMeta` built with no DOM, which is what the `pathux-meta` alias is for: `ui_meta_tags.ts`
 * imports nothing at runtime but nstructjs, so the derived tier can build the same tag the live
 * pane attaches to a widget.
 */
import * as nstructjs from 'nstructjs';
import { StdUXMeta, readMetaJSON, widgetSegment } from 'pathux-meta';
import { VnToolMeta, type ToolFacts } from '../toolmeta.js';

const tool = (over: Partial<ToolFacts> = {}) => new VnToolMeta({ id: 'asset.regenerate', ...over });

describe('VnToolMeta', () => {
  it('carries the command id as its tool path', () => {
    expect(tool().toolPath).toBe('asset.regenerate');
    expect(tool().type).toBe('vn');
  });

  it('round-trips props and a then list through their JSON fields', () => {
    const built = tool({
      props: { hash: 'a1b2', count: 2, all: true, kinds: ['portrait', 'bg'] },
      then : [{ id: 'view.open', props: { editor: 'asset' } }],
    });
    expect(built.propValues).toEqual({
      hash : 'a1b2',
      count: 2,
      all  : true,
      kinds: ['portrait', 'bg'],
    });
    expect(built.thenActions).toEqual([{ id: 'view.open', props: { editor: 'asset' } }]);
  });

  it('reads the id, on, form and supplies as its identity, and nothing else', () => {
    const base = tool({ on: 'style', form: true, supplies: ['notes', 'hash'] });
    expect(base.identity()).toBe(
      tool({ on: 'style', form: true, supplies: ['hash', 'notes'] }).identity(),
    );
    expect(base.identity()).not.toBe(
      tool({ on: 'seed', form: true, supplies: ['hash'] }).identity(),
    );
    expect(base.identity()).not.toBe(tool({ on: 'style', supplies: ['hash', 'notes'] }).identity());
    // A widget supplies props at commit time, so two controls that differ only there are one
    expect(tool({ props: { hash: 'a' } }).identity()).toBe(
      tool({ props: { hash: 'b' } }).identity(),
    );
    expect(tool({ then: [{ id: 'view.focus', props: {} }] }).identity()).toBe(tool().identity());
  });

  it('copies every field it declares', () => {
    const built = tool({ on: 'style', form: true, supplies: ['notes'], props: { hash: 'a1b2' } });
    const copy = built.copy();
    expect(copy).not.toBe(built);
    expect(copy.supplies).not.toBe(built.supplies);
    expect({ ...copy }).toEqual({ ...built });
  });

  it('names a widget segment whose stem is the command it runs', () => {
    const tag = new StdUXMeta({ tools: [tool()] });
    expect(widgetSegment(tag)).toMatch(/^asset-regenerate~[0-9a-f]{8}$/);
  });

  it('survives nstructjs, so a tag holding one crosses IPC', () => {
    const tag = new StdUXMeta<VnToolMeta>({ description: 'Draw it again.', tools: [tool()] });
    tag.widgetPath = `asset/${widgetSegment(tag)}`;
    const read = readMetaJSON<StdUXMeta<VnToolMeta>>(nstructjs.writeJSON(tag), StdUXMeta);
    expect(read.widgetPath).toBe(tag.widgetPath);
    expect(read.tools[0]?.identity()).toBe(tool().identity());
  });
});

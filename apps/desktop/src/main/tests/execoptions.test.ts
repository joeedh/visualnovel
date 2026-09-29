import { execOptions } from '../runtime/execoptions.js';

describe('execOptions', () => {
  it('treats a CDP call as confirmed, so a script is never asked', () => {
    expect(execOptions(undefined, { id: 'asset.upload', source: 'cdp' })).toEqual({
      confirmed: true,
    });
    expect(execOptions(2, { dsl: 'pipeline.draw()', source: 'cdp' })).toEqual({
      origin   : 2,
      confirmed: true,
    });
  });

  it('asks for a window call unless the surface already asked', () => {
    expect(execOptions(1, { id: 'asset.upload', source: 'ui' })).toEqual({
      origin   : 1,
      confirmed: false,
    });
    expect(execOptions(1, { id: 'asset.upload' })).toEqual({ origin: 1, confirmed: false });
    expect(execOptions(1, { id: 'asset.upload', source: 'ui', confirmed: true })).toEqual({
      origin   : 1,
      confirmed: true,
    });
  });

  it('carries a checkpoint through', () => {
    expect(execOptions(1, { id: 'gengraph.addNode', checkpoint: { seq: 7 } })).toEqual({
      origin    : 1,
      checkpoint: { seq: 7 },
      confirmed : false,
    });
  });
});

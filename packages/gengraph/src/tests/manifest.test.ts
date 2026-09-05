import { installDescription, parseGenPluginManifest } from '../index.js';
import { GEN_PLUGIN_API_VERSION } from '../plugin.js';

/** A manifest that parses, so each case below changes one thing about it. */
function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name       : 'acme-image',
    version    : '1.2.0',
    apiVersion : GEN_PLUGIN_API_VERSION,
    description: 'Draws pictures through the Acme backend.',
    nodeTypes  : ['AcmeImage'],
    services   : ['image', 'key'],
    keys       : ['ACME_API_KEY'],
    ...over,
  };
}

function refusal(over: Record<string, unknown>): string {
  const result = parseGenPluginManifest(raw(over));
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.manifest)}`);
  return result.reason;
}

describe('reading a plugin manifest', () => {
  it('reads the fields a plugin declares', () => {
    const result = parseGenPluginManifest(raw());
    expect(result).toMatchObject({
      ok      : true,
      manifest: { name: 'acme-image', nodeTypes: ['AcmeImage'], keys: ['ACME_API_KEY'] },
    });
  });

  it('fills in the entry and the two empty lists', () => {
    const result = parseGenPluginManifest(raw({ services: undefined, keys: undefined }));
    expect(result).toMatchObject({
      ok      : true,
      manifest: { entry: 'index.ts', services: [], keys: [] },
    });
  });

  // The name is the directory the plugin installs into, so anything but a slug is a path
  // fragment nobody meant to write.
  it.each(['Acme Image', '../escape', 'acme/image', '-leading', ''])(
    'refuses %p as a name',
    (name) => {
      expect(refusal({ name })).toContain('name');
    },
  );

  it('refuses an entry that is not a TypeScript file in the plugin', () => {
    expect(refusal({ entry: 'index.js' })).toContain('entry');
    expect(refusal({ entry: '/abs/index.ts' })).toContain('entry');
  });

  it('refuses an entry that climbs out of the plugin directory', () => {
    expect(refusal({ entry: 'src/../../elsewhere/index.ts' })).toContain(
      'climbs out of the plugin directory',
    );
  });

  it('refuses a plugin declaring no node type, since a plugin is its node types', () => {
    expect(refusal({ nodeTypes: [] })).toContain('nodeTypes');
  });

  it('refuses a service this host does not offer', () => {
    expect(refusal({ services: ['shell'] })).toContain('services');
  });

  // Named rather than left to fail at the first run of one of its nodes.
  it('names the API version mismatch and both versions', () => {
    const reason = refusal({ apiVersion: GEN_PLUGIN_API_VERSION + 1 });
    expect(reason).toContain(`plugin API ${GEN_PLUGIN_API_VERSION + 1}`);
    expect(reason).toContain(`offers ${GEN_PLUGIN_API_VERSION}`);
  });

  it('refuses a price fragment whose date is not a day', () => {
    expect(refusal({ prices: { pricesAsOf: 'January', models: {} } })).toContain('prices');
  });
});

describe('what an author is asked to confirm', () => {
  function described(over: Record<string, unknown> = {}): string {
    const result = parseGenPluginManifest(raw(over));
    if (!result.ok) throw new Error(result.reason);
    return installDescription(result.manifest);
  }

  it('names the version, the capabilities and the keys', () => {
    const text = described();
    expect(text).toContain('acme-image 1.2.0');
    expect(text).toContain('1 node type');
    expect(text).toContain('image and key');
    expect(text).toContain('ACME_API_KEY key');
  });

  // A plugin declaring nothing still gets a sentence saying so, because a blank half of a
  // confirmation reads as a missing one.
  it('says so where a plugin declares no capability and no key', () => {
    const text = described({ services: [], keys: [] });
    expect(text).toContain('reaches nothing outside the graph it runs in');
    expect(text).toContain('needs no API key');
  });

  it('pluralizes what there is more than one of', () => {
    const text = described({
      nodeTypes: ['AcmeImage', 'AcmeEdit'],
      keys     : ['ACME_API_KEY', 'ACME_ORG'],
    });
    expect(text).toContain('2 node types');
    expect(text).toContain('ACME_API_KEY and ACME_ORG keys');
  });
});

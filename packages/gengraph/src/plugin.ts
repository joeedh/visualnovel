/**
 * The surface a plugin's own sources are written against, reached as `@vn/gengraph/plugin`
 * so a plugin names one versioned specifier rather than reaching into this package.
 *
 * A plugin imports it for types only. The values arrive as the argument to its `activate`
 * function, because a bundle that resolved this module at load time would carry a second
 * copy of the registry and register its node types into maps the host never reads.
 */
import { Node } from 'pathux-graph';
import {
  BoolProperty,
  EnumProperty,
  FloatProperty,
  IntProperty,
  StringProperty,
} from 'pathux-toolprop';

import { ImageSocket, RefsSocket, TextSocket } from './nodes/sockets.js';
import { mtok } from './prices.js';
import { registerGenNode, registerGenRuntime } from './registry.js';
import type { GenNodeRun, GenNodeSpec } from './registry.js';

export type { NodeDef, Sockets } from 'pathux-graph';
export type {
  GenCostLine,
  GenCostUnit,
  GenEstimateContext,
  GenInputs,
  GenNodeEstimate,
  GenNodeRun,
  GenNodeSpec,
  GenOutputs,
  GenProps,
} from './registry.js';
export type {
  GenAssetService,
  GenBlobRef,
  GenBlobService,
  GenFetchInit,
  GenFetchResult,
  GenImageInput,
  GenImageService,
  GenServices,
  GenTextService,
} from './services.js';
export type { GenImageRef } from './nodes/sockets.js';
export type { GenPriceTable } from './prices.js';

/**
 * What `plugin.json` declares of the API it was written against. A plugin naming a version
 * this host does not offer is refused at install rather than at the first run of a node.
 */
export const GEN_PLUGIN_API_VERSION = 1;

/**
 * Everything a plugin may reach at activation. The classes are values rather than types
 * because a plugin subclasses `Node` and constructs sockets and properties, and passing
 * them keeps the plugin's bundle free of a second path.ux.
 */
export interface GenPluginApi {
  /** The value of {@link GEN_PLUGIN_API_VERSION} this host activated the plugin with. */
  readonly version: number;
  readonly Node: typeof Node;
  readonly TextSocket: typeof TextSocket;
  readonly ImageSocket: typeof ImageSocket;
  readonly RefsSocket: typeof RefsSocket;
  readonly StringProperty: typeof StringProperty;
  readonly BoolProperty: typeof BoolProperty;
  readonly IntProperty: typeof IntProperty;
  readonly FloatProperty: typeof FloatProperty;
  readonly EnumProperty: typeof EnumProperty;
  /** Declares a node type, the way a built-in does through `registerGenNode`. */
  registerNode(spec: GenNodeSpec): void;
  /** Binds a declared type's work. Refuses a type name this plugin did not declare. */
  registerRuntime(typeName: string, run: GenNodeRun): void;
  /** Millions of tokens, which is what a `mtok-in` or `mtok-out` count is measured in. */
  mtok(tokens: number): number;
}

/** What a plugin's entry module default-exports. */
export type GenPluginActivate = (api: GenPluginApi) => void;

/** The shape a loaded plugin bundle is read as. */
export interface GenPluginModule {
  default: GenPluginActivate;
}

/**
 * Builds the API one plugin is activated with. The two registration functions are wrapped
 * rather than passed through, so every type a plugin declares is recorded against its name
 * and a runtime for a type the plugin did not declare is refused here rather than reaching
 * the shared registry.
 */
export function genPluginApi(pluginName: string, declared: readonly string[]): GenPluginApi {
  const allowed = new Set(declared);

  return {
    version: GEN_PLUGIN_API_VERSION,
    Node,
    TextSocket,
    ImageSocket,
    RefsSocket,
    StringProperty,
    BoolProperty,
    IntProperty,
    FloatProperty,
    EnumProperty,
    registerNode(spec) {
      const typeName = spec.cls.graphDef().typeName;
      if (!allowed.has(typeName)) {
        throw new Error(
          `plugin ${pluginName} registered node type '${typeName}', which its manifest does not declare`,
        );
      }
      registerGenNode(spec);
    },
    registerRuntime(typeName, run) {
      if (!allowed.has(typeName)) {
        throw new Error(
          `plugin ${pluginName} registered a runtime for '${typeName}', which its manifest does not declare`,
        );
      }
      registerGenRuntime(typeName, run);
    },
    mtok,
  };
}

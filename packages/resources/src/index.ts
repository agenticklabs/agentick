/**
 * @agentick/resources — ResourcesHarness.
 *
 * A read-projection seam (ADR 62): a registry of `URI → resolver`
 * bindings (+ `uriTemplate → resolver`) plus the subscribe /
 * `list_changed` notifier. It owns NO content — resolvers read from
 * wherever the content already lives (the sandbox fs, a store, a
 * computed view). The MCP server projects this registry out over
 * `resources/*`, exactly as it projects `PromptsHarness` over
 * `prompts/*`.
 *
 * Private workspace package. Bundled into the `agentick` metapackage;
 * not published independently.
 *
 * @see docs/proposals/v2/blueprint/62-resources-harness.md
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

// Side-effect import — registers the `bridges.resources` slot on
// `HookBridges` via TypeScript module augmentation. Per ADR 27, every
// harness package owns its own slot declaration.
import "./augment.js";

export { ResourcesHarness, type ResourcesHarnessOptions } from "./harness.js";
export { withResources, type WithResourcesOptions } from "./extension.js";
export { EXTENSION_NAME } from "./extension-name.js";
export {
  buildResourcesTools,
  type ResourcesToolsBundle,
  RESOURCE_LIST,
  RESOURCE_READ,
} from "./tools.js";
export { compileUriTemplate, matchesTemplate } from "./uri-template.js";

// ── Mounting a keyed store as a browsable resource tree ──
export {
  storeResolver,
  mount,
  createTree,
  registerTree,
  type MountStore,
  type Child,
  type Page,
  type MountProjection,
  type Mount,
  type MountTree,
} from "./mounts.js";

// ── Durable backing (data-layer plan §6-C, Phase 5 run #9) ──
export { InMemoryResourceStore, matchesResourceQuery } from "./store.js";
export {
  fromArray,
  fromModule,
  type FromModuleOptions,
  type ResourceLoader,
  type ResourceLoaderItem,
} from "./loaders.js";

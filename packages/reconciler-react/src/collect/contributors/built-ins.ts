/**
 * Built-in contributor registration.
 *
 * `createBuiltInRegistry()` returns a fresh `ContributorRegistry`
 * preloaded with the framework's structural primitives. Callers (the
 * harness, tests) may then `register()` additional contributors for
 * application-defined component types.
 */

import { ContributorRegistry } from "../registry.js";
import { sectionContributor } from "./section.js";
import { messageContributor } from "./message.js";
import { toolContributor } from "./tool.js";
import { resourceContributor } from "./resource.js";
import { outputContributor } from "./output.js";
import { mcpContributor } from "./mcp.js";
import { modelContributor } from "./model.js";

export function createBuiltInRegistry(): ContributorRegistry {
  const r = new ContributorRegistry();
  r.register(sectionContributor);
  r.register(messageContributor);
  r.register(toolContributor);
  r.register(resourceContributor);
  r.register(outputContributor);
  r.register(mcpContributor);
  r.register(modelContributor);
  return r;
}

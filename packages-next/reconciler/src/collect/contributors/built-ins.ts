/**
 * Built-in contributor registration.
 *
 * `createBuiltInRegistry()` returns a fresh `ContributorRegistry`
 * preloaded with the framework's structural primitives + content-block
 * primitives. Callers (the harness, tests) may then `register()`
 * additional contributors for application-defined component types.
 */

import { ContributorRegistry } from "../registry.js";
// Structural / declarative primitives
import { sectionContributor } from "./section.js";
import { messageContributor } from "./message.js";
import { toolContributor } from "./tool.js";
import { resourceContributor } from "./resource.js";
import { outputContributor } from "./output.js";
import { mcpContributor } from "./mcp.js";
import { modelContributor } from "./model.js";
// Content blocks
import {
  audioContributor,
  documentContributor,
  imageContributor,
  videoContributor,
} from "./media.js";
import {
  codeContributor,
  csvContributor,
  htmlContributor,
  jsonContributor,
  reasoningContributor,
  textBlockContributor,
  xmlBlockContributor,
} from "./textual-blocks.js";
import {
  stateChangeContributor,
  systemEventContributor,
  userActionContributor,
} from "./event-blocks.js";
import { customBlockContributor } from "./custom-block.js";
import { semanticHtmlContributors } from "./semantic-html.js";
import { contentPassthroughContributor } from "./content-passthrough.js";

export function createBuiltInRegistry(): ContributorRegistry {
  const r = new ContributorRegistry();
  // Structural
  r.register(sectionContributor);
  r.register(messageContributor);
  r.register(toolContributor);
  r.register(resourceContributor);
  r.register(outputContributor);
  r.register(mcpContributor);
  r.register(modelContributor);
  // Content blocks
  r.register(imageContributor);
  r.register(documentContributor);
  r.register(audioContributor);
  r.register(videoContributor);
  r.register(textBlockContributor);
  r.register(codeContributor);
  r.register(jsonContributor);
  r.register(xmlBlockContributor);
  r.register(csvContributor);
  r.register(htmlContributor);
  r.register(reasoningContributor);
  r.register(userActionContributor);
  r.register(systemEventContributor);
  r.register(stateChangeContributor);
  r.register(customBlockContributor);
  r.register(contentPassthroughContributor);
  // Semantic HTML — produces semantic-node fragments that fold into the
  // enclosing TextBlock's semanticNode sidecar. See ADR 22 §D5.
  for (const c of semanticHtmlContributors()) r.register(c);
  return r;
}

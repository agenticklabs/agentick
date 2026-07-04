/**
 * `@agentick/model-next/testing` — model-layer test doubles.
 *
 * `scriptedAdapter` is the canonical stub `LanguageModelAdapter`;
 * spread-override individual hooks for behavior-specific variants
 * (`{ ...scriptedAdapter("x"), openStream: () => { throw ... } }`).
 */

export {
  scriptedAdapter,
  type ScriptedAdapter,
  type ScriptedAdapterOptions,
} from "./scripted-adapter.js";

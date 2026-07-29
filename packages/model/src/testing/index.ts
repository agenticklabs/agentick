/**
 * `@agentick/model/testing` — model-layer test doubles.
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

// The `capabilities.media` declaration bound to the adapter's real wire projection.
// Lives here rather than in @agentick/spec-conformance because it needs
// `detectDroppedInputs`, and that package is spec + utils only by design.
export {
  runMediaDeclarationCheck,
  MEDIA_MODALITIES,
  type MediaModality,
} from "./media-declaration.js";

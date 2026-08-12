/**
 * Execution target — what the executor harness is asked to run against.
 *
 * `[PLACEHOLDER]` capabilities synthesized from v1's `ContextUpdateEvent`
 * fields (`packages/shared/src/streaming.ts`). Sign-off needed.
 *
 * @see docs/proposals/v2/blueprint/02-data-model.md §ExecutionTarget
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 */

import type { MediaSource } from "./content-blocks.js";
import type { ProviderOptions } from "./rendered-tree.js";

/** The `MediaSource` discriminators, as a value-level kind. */
export type MediaSourceKind = MediaSource["type"];

/**
 * Which {@link MediaSource} kinds a target can carry, per modality — the
 * refinement `supportsVision?: boolean` gestures at and cannot express.
 *
 * ## Why a declaration rather than per-adapter discipline
 *
 * Whether a media part can go on the wire is decided **four times** today, once
 * per adapter, inside a `switch` that returns `null` for what it cannot project.
 * Two things follow, both bad:
 *
 *   - **The verdict is discarded.** A part that cannot be carried is skipped and
 *     the request SUCCEEDS — the model never sees the user's attachment and
 *     nobody is told. Silent data loss.
 *   - **Some verdicts are not even reached.** Anthropic's message projection has
 *     no `audio` or `video` arm at all: those parts fall off the end of the
 *     switch. There is no `null` to observe, so no amount of reporting
 *     discipline at the decline sites could have caught them.
 *
 * Asking each adapter to *report* its declines would leave both problems in
 * place — it is opt-in at every arm, and a new adapter has nothing forcing it to
 * comply. Declaring support instead moves the decision to ONE framework-owned
 * site: `applyMediaSupport` in `@agentick/model` screens the projected messages
 * against this table before `prepareRequest` runs. An adapter cannot forget to
 * report a decline it never makes.
 *
 * ## Reading the table
 *
 * - **Absent `media`** — undeclared, so nothing is screened. The adapter's own
 *   projection remains the only authority, exactly as before. Absence must never
 *   read as "carries nothing" or every undeclared target would drop all media.
 * - **Present `media`** — the declaration is **complete**. A modality with no
 *   entry carries nothing, which is how "Anthropic cannot take audio" becomes a
 *   stated fact rather than a hole in a switch. `[]` says the same thing
 *   explicitly.
 *
 * Because it is data, it is checkable: the executor conformance suite probes each
 * declared kind and each undeclared one against the adapter's real projection, so
 * a declaration that drifts from behaviour fails a test rather than silently
 * dropping media that used to work.
 */
export interface MediaSupport {
  readonly image?: readonly MediaSourceKind[];
  readonly document?: readonly MediaSourceKind[];
  readonly audio?: readonly MediaSourceKind[];
  readonly video?: readonly MediaSourceKind[];
  /**
   * URI schemes a `url` source may use, without the `:` — `["http", "https", "data"]`
   * when absent.
   *
   * This is the precision that let `s3` and `gcs` be deleted from {@link MediaSource}.
   * Those variants existed to be re-concatenated into a URI, so the only fact they
   * really encoded was *which scheme this provider can fetch* — Gemini reads `gs://`
   * natively, Anthropic does not. Stating it here says exactly that, and says it about
   * every scheme rather than the two that happened to get variants: `r2`, `azure`,
   * `ipfs`, `file` are all just strings, so adding one is data rather than a release.
   *
   * Target-wide rather than per modality, because a provider that fetches a scheme
   * fetches it for every modality — no provider reads `gs://` for images but not
   * documents.
   *
   * The default is the closure of what is universally fetchable: `http`/`https` (any
   * provider that takes a URL at all) plus `data` (an inline payload, which several
   * providers accept through their URL field). A target that reads anything else must
   * say so, and one that reads FEWER — no URL fetching at all — omits `url` from the
   * modality lists instead.
   */
  readonly urlSchemes?: readonly string[];
}

/** Schemes every URL-accepting target can be assumed to handle. */
export const DEFAULT_URL_SCHEMES: readonly string[] = ["http", "https", "data"];

/**
 * Capabilities advertised by an execution target. Drives loop-executor
 * decisions (tool exposure, streaming opt-in, max-output negotiation).
 */
export interface TargetCapabilities {
  readonly supportsTools?: boolean;
  readonly supportsVision?: boolean;
  readonly supportsReasoning?: boolean;
  readonly supportsStreaming?: boolean;
  /** Native structured-output support (json_schema responseFormat). */
  readonly supportsJsonSchema?: boolean;
  /**
   * Per-modality {@link MediaSource} support. Read by `applyMediaSupport` in
   * [@agentick/model](../../../model) to screen media parts BEFORE the adapter
   * sees them — so the decline is made once, by the framework, instead of four
   * times inside adapters that then discard it.
   */
  readonly media?: MediaSupport;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly [key: string]: unknown;
}

/**
 * Base execution target. The `kind` discriminator opens the door to future
 * families (code-execution, tool-only, custom executors). Today only
 * `language-model` ships.
 */
export interface ExecutionTarget {
  readonly kind: "language-model" | (string & {});
  readonly provider?: string;
  readonly modelId?: string;
  readonly capabilities?: TargetCapabilities;
  /**
   * Provider-specific escape hatch. Typed via the module-augmentable
   * {@link ProviderOptions} interface — adapter packages contribute
   * typed slots (e.g., `openai`, `anthropic`) via `declare module
   * "@agentick/spec"`. The spec ships an empty seed, so call sites
   * stay type-safe across provider-specific knobs.
   */
  readonly providerOptions?: ProviderOptions;
  /**
   * Self-described pricing (USD/MTok) — the adapter is the authority
   * on its own model's economics (#186). Consumers resolve
   * adopter-table > target.pricing > seed. Shape defined in
   * `@agentick/model` (ModelPricing); carried structurally here.
   */
  readonly pricing?: {
    readonly inputPerMTok: number;
    readonly outputPerMTok: number;
    readonly cachedInputPerMTok?: number;
    readonly cacheWritePerMTok?: number;
  };
  /**
   * Adopter-supplied rates, declared at model construction
   * (`anthropic("claude-sonnet-5", { rates })`). The framework ships NO
   * prices — an absent card means an UNPRICED tick, which rolls up as
   * explicitly unpriced rather than as zero.
   *
   * Rates live on the target rather than in an app-level table keyed by
   * model name so a per-tick `<Model>` override carries its own card
   * through the model cascade with no extra plumbing.
   *
   * An app-level `CostResolver` wins over this when it returns a value.
   *
   * @see docs/proposals/v2/usage-cost.md
   */
  readonly rates?: import("./usage-cost.js").RateCard;
  /**
   * Self-described token cost for content a character count cannot read — an
   * image, a PDF page, a minute of audio. Same authority argument as
   * {@link pricing}: only the adapter knows how ITS provider bills a
   * screenshot, and the same image is ~765 tokens on OpenAI and ~1365 on
   * Anthropic because they use different formulas.
   *
   * On the target rather than in a table inside `@agentick/model` so a
   * third-party adapter can supply rates at all — a central table is closed to
   * every package that is not agentick's own. Consumers resolve
   * adopter-registry > `target.mediaTokens` > seed, the ladder `pricing` uses.
   */
  readonly mediaTokens?: Partial<MediaTokenRates>;
}

/**
 * Tokens charged per whole media block, by modality.
 *
 * Flat per block because a `MediaSource` carries no dimensions, page count or
 * duration — there is nothing to compute from. An adapter states the published
 * formula evaluated at one typical instance; a deployment that knows its own
 * media better overrides through the model registry.
 */
export interface MediaTokenRates {
  readonly image: number;
  readonly document: number;
  readonly audio: number;
  readonly video: number;
}

export interface LanguageModelTarget extends ExecutionTarget {
  readonly kind: "language-model";
}

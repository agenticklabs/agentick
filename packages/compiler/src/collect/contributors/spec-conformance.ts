/**
 * Type-level conformance harness for contributors.
 *
 * Every contributor turns an element's props into a spec value (a
 * `ToolDeclaration`, a `MessageEntry`, an `ImageBlock`, …). The runtime
 * `contribute` body hand-assembles that value, so a NEW optional field on
 * the spec type compiles fine everywhere and is SILENTLY DROPPED — the
 * exact bug class that lost `ToolDeclaration.aliases` and
 * `ToolDeclaration.providerOptions` for two passes.
 *
 * The guard: each contributor declares, at the type level, the partition
 * of its spec type's keys into
 *
 *   - **forwarded** — keys spread straight through from props, and
 *   - **supplied**  — keys the compiler provides a value for (a constant
 *     discriminant like `type`/`kind`, an id default, a children-folded
 *     `description`/`text`, a runtime/adapter-populated field the tree
 *     never authors),
 *
 * then instantiates {@link Exhausted}`<`{@link UnhandledSpecKeys}`<…>>`.
 * A new spec key that is in neither partition lands in
 * `UnhandledSpecKeys`, and `Exhausted` refuses to resolve — the package
 * fails `tsc` until the contributor accounts for the field. The
 * `extends keyof Spec` bounds also catch a STALE key (one removed from
 * the spec) at the same site, so the partition can never rot in either
 * direction.
 *
 * This is the drift-proofing referenced by the compiler README's
 * "contributor ownership" section: spec is the single sync point, and
 * this harness makes a spec edit break the contributor at compile time.
 */

/**
 * Compile-time assertion that `T` is exactly `never`. Instantiate it with
 * {@link UnhandledSpecKeys}; any residual key makes `T` a non-`never`
 * union, violating the `extends never` bound and failing the build.
 */
export type Exhausted<T extends never> = T;

/**
 * The spec keys a contributor has NOT accounted for: every key of `Spec`
 * that is neither `Forwarded` (spread through from props) nor `Supplied`
 * (defaulted, transformed, or a constant discriminant). Resolves to
 * `never` exactly when the two partitions together cover `keyof Spec`.
 *
 * Both partitions are bounded by `keyof Spec`, so listing a key the spec
 * no longer has is itself a compile error at the declaration site.
 */
export type UnhandledSpecKeys<
  Spec,
  Forwarded extends keyof Spec,
  Supplied extends keyof Spec,
> = Exclude<keyof Spec, Forwarded | Supplied>;

/**
 * Frozen roster of {@link BaseContentBlock} keys — minus the `type`
 * discriminant — that every block contributor forwards from props. Block
 * contributors compose this with their own discriminant fields when
 * partitioning their spec type's keys.
 *
 * Deliberately an EXPLICIT union rather than `Exclude<keyof
 * BaseContentBlock, "type">`: a new field added to `BaseContentBlock`
 * (which every block inherits) is NOT in this roster, so the
 * {@link _baseBlockRosterIsTotal} self-check below — and, transitively,
 * every block contributor's conformance assertion — fails until the field
 * is triaged. A derived `Exclude` would silently absorb it.
 */
export type BaseBlockKey =
  | "id"
  | "messageId"
  | "createdAt"
  | "mimeType"
  | "index"
  | "metadata"
  | "summary"
  | "providerMetadata"
  | "cache"
  | "citations"
  | "sources";

// Self-check: the roster must cover BaseContentBlock exactly (minus `type`).
type _baseBlockRosterIsTotal = Exhausted<
  Exclude<keyof import("@agentick/spec").BaseContentBlock, "type" | BaseBlockKey>
>;

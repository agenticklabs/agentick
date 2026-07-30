/**
 * `MessageSource` augmentation — the `prompt` provenance slot.
 *
 * A prompt `invoke` puts RENDERED content into the timeline. Without a stamp the
 * resulting entries are indistinguishable from typed user input, so a chat
 * projection has to render the whole wall of rendered text as if the human typed
 * it — they typed `/quoting_report period:2026-01`, they see 400 words. The stamp
 * is what lets the projection collapse it to a pill and lets an audit follow the
 * entry back to the operation that produced it.
 *
 * Split out of {@link ./augment.ts} for the same reason `./wire-augment.ts` is:
 * the CLIENT reads this stamp (it is the client that renders the pill), and it
 * must type `metadata.source.prompt` WITHOUT loading the server augmentations.
 * Pure type-only augmentation, zero runtime. The exported interface below is what
 * keeps this a MODULE that AUGMENTS `@agentick/spec` rather than a script that
 * SHADOWS it — do not reduce this file to the `declare module` block alone.
 *
 * @see docs/proposals/v2/materialization-provenance.md §3
 * @see packages/spec/src/data/message-source.ts (the seed, and why the grammar is
 *   a keyed bag rather than a `kind` union)
 */

/**
 * What a prompt `invoke` knows about itself at the moment it queues an entry —
 * and NOTHING more. Every field is a fact already in hand at the stamp site: no
 * hashing, no computed revision, no second lookup.
 */
export interface PromptMessageSource {
  /** The invoked prompt's declared name. */
  readonly name: string;
  /**
   * The arguments the invoke was called with, verbatim from the operation input.
   * Duplicated from the journal on purpose: the pill renders from the TIMELINE on
   * a client that holds no journal, and the values are already inline in the
   * rendered content — no new exposure. Absent when the invoke passed none.
   */
  readonly args?: Readonly<Record<string, unknown>>;
  /**
   * The `prompts:command:invoke` operation that produced the entry — the
   * navigable link from timeline entry to journal. Optional only because
   * `RuntimeContext.opId` is; inside the command it is always set.
   */
  readonly opId?: string;
  /**
   * The declaration's own `version` at invoke time, copied verbatim. Absent when
   * the adopter declared none — the framework never computes one.
   */
  readonly version?: string;
}

declare module "@agentick/spec" {
  interface MessageSource {
    /**
     * Present iff a prompt `invoke` materialized this entry. A reader
     * discriminates on the KEY (`source.prompt !== undefined`) — see the seed's
     * doc-block for why the grammar is a keyed bag and not a `kind` union.
     */
    readonly prompt?: PromptMessageSource;
  }
}

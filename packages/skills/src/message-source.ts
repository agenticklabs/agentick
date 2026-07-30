/**
 * `MessageSource` augmentation — the `skill` provenance slot.
 *
 * `skills.run` composes a send from a skill's content: a system message carrying
 * the skill body and a user message carrying the args. Both enter the timeline as
 * an ordinary turn, so without a stamp a chat projection has to render the entire
 * skill document as if the human typed it. The stamp is what lets the projection
 * collapse it to "ran the `refund_flow` skill" and lets an audit ask which
 * revision of the document drove the turn.
 *
 * Split out of {@link ./augment.ts} for the same reason `./wire-augment.ts` is:
 * the CLIENT reads this stamp (it is the client that renders the pill), and it
 * must type `metadata.source.skill` WITHOUT loading the server augmentations.
 * Pure type-only augmentation, zero runtime. The exported interface below is what
 * keeps this a MODULE that AUGMENTS `@agentick/spec` rather than a script that
 * SHADOWS it — do not reduce this file to the `declare module` block alone.
 *
 * @see docs/proposals/v2/materialization-provenance.md §3
 * @see packages/spec/src/data/message-source.ts (the seed, and why the grammar is
 *   a keyed bag rather than a `kind` union)
 */

/**
 * What a skill run knows about itself at the moment it composes the send — and
 * NOTHING more. No hashing, no computed revision, no second lookup.
 */
export interface SkillMessageSource {
  /** The run skill's declared name. */
  readonly name: string;
  /**
   * The skill record's own `version` at run time, copied verbatim. Absent when
   * the adopter declared none — the framework never computes one.
   */
  readonly version?: string;
  /**
   * The `skills:run` operation that composed this message — the navigable link
   * from a timeline entry back to its journal envelope, the same one
   * `PromptMessageSource.opId` provides.
   *
   * Present on every run since `skills:run` became a declared command (#249).
   * Optional because a `SkillMessageSource` READ off a restored timeline may
   * predate that, and because the framework never fabricates an id it does not
   * have.
   */
  readonly opId?: string;
}

declare module "@agentick/spec" {
  interface MessageSource {
    /**
     * Present iff `skills.run` composed this entry. A reader discriminates on the
     * KEY (`source.skill !== undefined`) — see the seed's doc-block for why the
     * grammar is a keyed bag and not a `kind` union.
     */
    readonly skill?: SkillMessageSource;
  }
}

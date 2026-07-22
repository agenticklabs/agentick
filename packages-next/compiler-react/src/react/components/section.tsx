/**
 * `<Section>` — typed PascalCase wrapper around the `<section>` intrinsic.
 *
 * Author-facing surface for emitting a structured context entry with an
 * optional title. Mirrors `sectionContributor`'s prop shape so authors
 * get type-checked props without `JSX.IntrinsicElements` augmentation.
 *
 * The lowercase `<section>` intrinsic remains the host primitive; this
 * wrapper is the canonical author API (parallel to `<Message>`).
 *
 * @see packages/compiler-react/src/collect/contributors/section.ts
 */

import React, { type ReactNode } from "react";
import type { SectionMetadata } from "@agentick/spec-next";

export interface SectionProps {
  readonly id?: string;
  readonly title?: string;
  /** Hint to executors that may reorder context entries. */
  readonly priority?: number;
  readonly cache?: SectionMetadata["cache"];
  readonly providerMetadata?: SectionMetadata["providerMetadata"];
  readonly metadata?: Record<string, unknown>;
  readonly children?: ReactNode;
}

export function Section(props: SectionProps): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return React.createElement("section" as any, props);
}

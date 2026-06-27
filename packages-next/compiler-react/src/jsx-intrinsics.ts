/**
 * JSX.IntrinsicElements augmentation for `@agentick/compiler-react-next`.
 *
 * Declares the Agentick-specific lowercase tags the static walker
 * understands so adopters writing TSX templates get type safety:
 *
 *   <section id="intro" audience="model"> ... </section>
 *   <user>What is 47 × 23?</user>
 *   <code language="typescript">const x = 1;</code>
 *   <json data={{ ok: true }} />
 *
 * Adopters who don't write these tags directly (using uppercase
 * function-component wrappers like `<Section>`/`<User>` instead) don't
 * need this file — those wrappers carry their own props types.
 *
 * # HTML overlap
 *
 * `section` and `code` overlap with React's HTML element names.
 * TypeScript merges the declarations, so HTML attributes still work
 * alongside the v2 props (the walker ignores them).
 *
 * # Why a local copy, not shared from reconciler-react-next
 *
 * reconciler-react-next has its own augmentation tied to its host-
 * config + collect-walker. Importing it here would couple compiler-
 * react-next to a heavier package and bring in transitive deps the
 * static walker doesn't need. A future "shared JSX vocabulary" package
 * can consolidate both — defer until concrete drift surfaces.
 */

import type { ReactNode } from "react";

type MessageRole = "system" | "user" | "assistant" | "tool" | (string & {});

interface MessageProps {
  readonly role?: MessageRole;
  readonly id?: string;
  readonly children?: ReactNode;
}

interface MessageRoleProps {
  readonly id?: string;
  readonly children?: ReactNode;
}

interface JsonProps {
  readonly data?: unknown;
  readonly children?: ReactNode;
}

interface ParagraphProps {
  readonly children?: ReactNode;
}

// NOTE: HTML-overlap intrinsics (`section`, `code`, `text`) are NOT
// declared here. TypeScript interface-merging rejects conflicting
// property types, and these tags already exist on React's
// IntrinsicElements with HTML/SVG attribute shapes. Adopters who need
// the Agentick-specific props (`audience` on `<section>`, `language`
// on `<code>`) currently use either:
//   - `React.createElement("section", { audience: "model" }, ...)`
//   - uppercase function-component wrappers (`<Section>`/`<Code>`,
//     shipped in a future package once we add them)
//
// Same approach as `reconciler-react-next/src/react/jsx-intrinsics.ts`.
//
// TODO(adr-39-phase-3): The semantic-html vocabulary that Step 1b added
// to the walker (strong / em / ul / ol / li / table / blockquote / pre
// / br / hr / kbd / var / q / cite / a / img) currently has no JSX
// type declarations — adopters get React's default HTML typings, which
// don't expose the Agentick-specific props the walker reads (currently
// only `href` on `<a>` and `src`/`alt` on `<img>`, so the existing
// HTML typings match by accident). When we add semantic intrinsics
// that need non-HTML props, declare them here OR ship uppercase FCs.

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      readonly message: MessageProps;
      readonly system: MessageRoleProps;
      readonly user: MessageRoleProps;
      readonly assistant: MessageRoleProps;
      readonly tool: MessageRoleProps;
      readonly json: JsonProps;
      readonly paragraph: ParagraphProps;
    }
  }
}

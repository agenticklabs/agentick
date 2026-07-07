/**
 * JSX.IntrinsicElements augmentation for `@agentick/reconciler-react-next`.
 *
 * Declares the v2 reconciler's host intrinsics so adopters and tests
 * can write JSX like:
 *
 * ```tsx
 * <message role="user">
 *   <text>hello</text>
 * </message>
 * ```
 *
 * Without this augmentation, TypeScript rejects unknown lowercase tag
 * names with `TS2339: Property 'message' does not exist on type
 * 'JSX.IntrinsicElements'`.
 *
 * # What's declared here vs not
 *
 * Adopters normally write the **uppercase React-component wrappers**
 * (`<Message>`, `<Tool>`, `<Section>`, `<Code>`, ...) exported from
 * `@agentick/reconciler-react-next` and friends. Those components are
 * typed by their own export signatures — they do NOT need any
 * augmentation here.
 *
 * The intrinsics declared here are the **lowercase host primitives**
 * the reconciler treats as the wire shape: the uppercase wrappers
 * compile down to them. Tests and adopter code that want to write the
 * lowercase form directly get type safety via this file.
 *
 * Per-prop shapes mirror each contributor's expected `props` interface
 * in `packages-next/reconciler/src/collect/contributors/`.
 *
 * # HTML-overlap policy
 *
 * Several intrinsics (`section`, `code`, `audio`, `video`, `image`,
 * `html`) overlap with React's HTML element names. Interface merging
 * applies — augmentation here ADDS v2-specific props (like `audience`
 * on `section`) without removing HTML's existing attributes. Adopters
 * can pass either set; the reconciler reads the v2 props, HTML attrs
 * are ignored at the v2 layer.
 *
 * # Type discipline
 *
 * All prop shapes reference types from `@agentick/spec-next` where
 * possible. When the spec changes, this file fails to typecheck until
 * updated — the same drift-detection guarantee the canonical fakes
 * have.
 *
 * @see docs/proposals/v2/blueprint/03-reconciler-harness.md
 * @see packages-next/reconciler/src/collect/contributors/
 */

import type {
  ContentBlock,
  MediaSource,
  ProviderOptions,
  ProviderToolOptions,
  SessionMessageRole,
  ToolExposure,
} from "@agentick/spec-next";

type ReactChildren = import("react").ReactNode;
type ReactKey = import("react").Key | null;

// React 19 + `jsxImportSource: "react"` puts JSX.IntrinsicElements inside
// `import("react").JSX`. Module augmentation merges per-key with React's
// existing IntrinsicElements — HTML keys (`section`, `code`, `image`, ...)
// pick up our props on top of their HTML attribute shape.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      // ────────── Top-level structural intrinsics ──────────

      /**
       * Conversation message. Compiles to a `MessageEntry` on
       * `RenderedTree.context.entries`. Adopters typically use the
       * uppercase `<Message>` wrapper from `@agentick/reconciler-react-next`.
       */
      message: {
        readonly id?: string;
        readonly role: SessionMessageRole;
        /** Pre-built content blocks; takes precedence over children when non-empty. */
        readonly content?: readonly ContentBlock[];
        readonly cache?: Record<string, unknown>;
        readonly providerMetadata?: Record<string, unknown>;
        readonly metadata?: Record<string, unknown>;
        readonly children?: ReactChildren;
        readonly key?: ReactKey;
      };

      // NOTE: `<section>` is omitted — collides with HTML's `<section>`.
      // Adopters use `<Section>` (the uppercase wrapper).

      /**
       * Projection override (ADR 63). Declares that its subtree overrides
       * a surfacing-capable harness's projection for `projectionKey`,
       * suppressing that harness's lazy default. Adopters use the
       * uppercase `<Project>` wrapper, or a harness's own surfacing
       * component (`<Timeline>` renders `<project projectionKey="timeline">`).
       */
      project: {
        readonly projectionKey: string;
        readonly children?: ReactChildren;
        readonly key?: ReactKey;
      };

      /**
       * Tool declaration. Compiles to a `ToolDeclaration` on
       * `RenderedTree.declarations.tools`.
       */
      tool: {
        readonly id?: string;
        readonly name: string;
        readonly description?: string;
        readonly inputSchema?: Record<string, unknown>;
        readonly outputSchema?: Record<string, unknown>;
        readonly exposure?: readonly ToolExposure[];
        readonly handlerRef?: string;
        readonly providerOptions?: ProviderToolOptions;
        readonly metadata?: Record<string, unknown>;
        readonly children?: ReactChildren;
        readonly key?: ReactKey;
      };

      /**
       * Model selection + per-call provider options. Compiles to
       * `RenderedTree.config` + `RenderedTree.providerOptions`.
       */
      model: {
        readonly id?: string;
        readonly temperature?: number;
        readonly maxOutputTokens?: number;
        readonly topP?: number;
        readonly stopSequences?: readonly string[];
        readonly providerOptions?: ProviderOptions;
        readonly metadata?: Record<string, unknown>;
        readonly key?: ReactKey;
      };

      /**
       * Tree-declared per-tick model (ADR 56). Compiles to
       * `RenderedTree.declarations.model`. Distinct from `<model>` above,
       * which drives `RenderedTree.config` (model selection + generation
       * knobs). `useModelRegistration` renders this — adopters use the
       * (deferred) `<Model>` sugar rather than the lowercase form.
       */
      "model-declaration": {
        readonly modelRef: string;
        readonly parameters?: Readonly<Record<string, unknown>>;
        readonly key?: ReactKey;
      };

      /**
       * Resource declaration. Compiles to
       * `RenderedTree.declarations.resources`.
       */
      resource: {
        readonly id?: string;
        readonly uri: string;
        readonly mimeType?: string;
        readonly metadata?: Record<string, unknown>;
        readonly children?: ReactChildren;
        readonly key?: ReactKey;
      };

      // NOTE: `<output>` is also omitted — it collides with HTML's
      // form-`<output>` element. `<text>` is omitted — collides with
      // SVG's `<text>` element. Tests for these contributors use
      // React.createElement directly, and adopters use the uppercase
      // wrappers (`<Output>`, `<Text>`).

      /**
       * MCP server declaration. Compiles to
       * `RenderedTree.declarations.mcp`.
       */
      mcp: {
        readonly id?: string;
        readonly serverName: string;
        readonly transport: "stdio" | "websocket" | "sse" | (string & {});
        readonly config?: Record<string, unknown>;
        readonly exposes?: readonly ("tools" | "resources" | "prompts")[];
        readonly metadata?: Record<string, unknown>;
        readonly key?: ReactKey;
      };

      // ────────── Content block primitives ──────────

      /** Reasoning content block (thinking / chain-of-thought). */
      reasoning: {
        readonly text?: string;
        readonly children?: ReactChildren;
        readonly key?: ReactKey;
      };

      // NOTE: `<code>`, `<image>`, `<audio>`, `<video>`, `<section>`,
      // `<html>` are intentionally omitted. They collide with React's
      // pre-typed HTML/SVG intrinsics whose shape we cannot override via
      // declaration merging (TypeScript keeps the original definition
      // for already-defined keys). Adopters use the uppercase wrappers
      // (`<Code>`, `<Image>`, `<Audio>`, `<Section>`) — recommended path
      // — or `React.createElement("code", { language: "ts" }, ...)` with
      // a documented cast where the test needs the lowercase form.
      //
      // Renaming the contributors to non-HTML names (e.g. `agentick-code`,
      // `code-block`) would let us declare them here cleanly — flagged as
      // a separate design discussion.

      /** JSON data block. */
      json: {
        readonly data: unknown;
        readonly metadata?: Record<string, unknown>;
        readonly key?: ReactKey;
      };

      /** XML data block — distinct from formatter-scope `<XML>`. */
      "xml-block": {
        readonly tag?: string;
        readonly attributes?: Record<string, string>;
        readonly children?: ReactChildren;
        readonly key?: ReactKey;
      };

      /** CSV data block. */
      csv: {
        readonly data: string | readonly (readonly string[])[];
        readonly headers?: readonly string[];
        readonly key?: ReactKey;
      };

      /** Custom content block — adopter-defined kind. */
      custom: {
        readonly kind: string;
        readonly data?: unknown;
        readonly children?: ReactChildren;
        readonly key?: ReactKey;
      };

      /**
       * Content passthrough — flattens children into parent's content
       * blocks without introducing a wrapping entry.
       */
      content: {
        readonly children?: ReactChildren;
        readonly key?: ReactKey;
      };

      // ────────── Media blocks (only `document` declared) ──────────
      //
      // `<image>`, `<audio>`, `<video>` collide with React's HTML/SVG
      // intrinsics and can't be safely augmented (see omitted-elements
      // comment above). Adopters use `<Image>`, `<Audio>`, `<Video>`
      // wrappers from `@agentick/reconciler-react-next`. Only `document`
      // (no HTML conflict) is declared here.

      /** Document attachment. */
      document: {
        readonly source: MediaSource;
        readonly metadata?: Record<string, unknown>;
        readonly key?: ReactKey;
      };

      // ────────── Event blocks (snake_case per contributor names) ──────────

      user_action: {
        readonly action: string;
        readonly actor?: string;
        readonly target?: string;
        readonly metadata?: Record<string, unknown>;
        readonly children?: ReactChildren;
        readonly key?: ReactKey;
      };

      system_event: {
        readonly event: string;
        readonly source?: string;
        readonly severity?: "info" | "warning" | "error";
        readonly metadata?: Record<string, unknown>;
        readonly children?: ReactChildren;
        readonly key?: ReactKey;
      };

      state_change: {
        readonly entity: string;
        readonly field?: string;
        readonly from: unknown;
        readonly to: unknown;
        readonly trigger?: string;
        readonly metadata?: Record<string, unknown>;
        readonly children?: ReactChildren;
        readonly key?: ReactKey;
      };
    }
  }
}

// Marker: this file is a module (not a script). Without it, the
// `declare module` augmentation could leak into consumer scope as a
// script-mode side effect.
export {};

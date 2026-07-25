/**
 * `<Resource>` — declare an application-controlled resource inside a
 * JSX agent tree (ADR 62). The read-side analogue of `<Tool>`: where
 * `<Tool>` registers a callable the model INVOKES, `<Resource>`
 * registers readable content the model (or adopter code, or the MCP
 * server projection) PULLS on demand by URI.
 *
 * Mirrors `<Tool>`'s registration ergonomics exactly:
 *
 *   1. On mount, register the `uri → resolver` (or `uriTemplate →
 *      resolver`) binding on the session's resources bridge
 *      (`useResourceBridge()`); unregister on unmount (ADR 63
 *      "registration → harness source" path — live side).
 *   2. A shared ref holds the latest resolver so re-renders that change
 *      the resolver identity never re-register (identical to `<Tool>`'s
 *      `useRef` capture).
 *   3. Renders `null` — resources DON'T surface by rendering a host
 *      intrinsic. The CATALOG surfaces via the harness's `resources`
 *      default projection (ADR 63), which reads the registry directly.
 *
 * ## Three ways to supply content (pick the cleanest for the case)
 *
 * ```tsx
 * // 1. Static content — a string or ResourceContents:
 * <Resource uri="config://app" name="App config" content={JSON.stringify(cfg)} />
 *
 * // 2. A resolver prop (lazy, may be async):
 * <Resource uri="db://users/count" resolver={async () => textContents(uri, `${await count()}`)} />
 *
 * // 3. Children-as-resolver (reads most like <Tool>):
 * <Resource uri="file://readme" mimeType="text/markdown">
 *   {() => readme}
 * </Resource>
 *
 * // Template — the resolver receives the CONCRETE matched uri:
 * <Resource uriTemplate="file://{path}">
 *   {(uri) => readFileAsContents(uri)}
 * </Resource>
 * ```
 *
 * A resolver may return a `string` (wrapped as a single text
 * `ResourceContents` for the read uri, with the declared `mimeType`), a
 * single `ResourceContents`, or an array. `content` accepts the same.
 *
 * @see docs/proposals/v2/blueprint/62-resources-harness.md
 * @see docs/proposals/v2/blueprint/63-compiler-surfacing.md
 */

import * as React from "react";

import type { ResourceContents, ResourceMeta, ResourceTemplateMeta } from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

import { useResourceBridge } from "./use-resource-bridge.js";

// ============================================================================
// Content coercion
// ============================================================================

/** What a resolver / the `content` prop may yield for a single read. */
export type ResourceContentSource = string | ResourceContents | readonly ResourceContents[];

/** A `<Resource>` resolver — sync or async, receives the concrete uri. */
export type ResourceResolveFn = (
  uri: string,
) => ResourceContentSource | Promise<ResourceContentSource>;

/**
 * Normalize a resolver's output to the wire `ResourceContents[]`. A bare
 * string becomes one text-contents entry keyed to the read uri (with the
 * declared mimeType, if any).
 */
function toContents(
  value: ResourceContentSource,
  uri: string,
  mimeType: string | undefined,
): readonly ResourceContents[] {
  if (typeof value === "string") {
    return [omitUndefined({ uri, text: value, mimeType }) as ResourceContents];
  }
  if (Array.isArray(value)) return value as readonly ResourceContents[];
  return [value as ResourceContents];
}

// ============================================================================
// Props
// ============================================================================

interface ResourceCommonProps {
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly title?: string;
  readonly size?: number;
  /** A resolver prop. Precedence: `resolver` > `children` > `content`. */
  readonly resolver?: ResourceResolveFn;
  /** Static content — sugar over a resolver that returns it verbatim. */
  readonly content?: ResourceContentSource;
  /** Children-as-resolver. Only a function child is treated as a resolver. */
  readonly children?: ResourceResolveFn;
}

export interface FixedResourceProps extends ResourceCommonProps {
  readonly uri: string;
  readonly uriTemplate?: never;
}

export interface TemplateResourceProps extends ResourceCommonProps {
  readonly uriTemplate: string;
  readonly uri?: never;
  /** `content` is meaningless for a template (no single concrete uri). */
  readonly content?: never;
}

export type ResourceProps = FixedResourceProps | TemplateResourceProps;

// ============================================================================
// Component
// ============================================================================

/**
 * Resolve the effective resolver from props precedence:
 * `resolver` prop > function `children` > `content` (static).
 */
function pickResolver(props: ResourceCommonProps): ResourceResolveFn | undefined {
  if (props.resolver) return props.resolver;
  if (typeof props.children === "function") return props.children;
  if (props.content !== undefined) {
    const captured = props.content;
    return () => captured;
  }
  return undefined;
}

export function Resource(props: ResourceProps): React.ReactElement | null {
  const bridge = useResourceBridge();
  const mimeType = props.mimeType;

  // Latest-resolver ref (identical to <Tool>'s deps capture): re-renders
  // update the resolver the stable wrapper calls, without re-registering.
  const resolverRef = React.useRef<ResourceResolveFn | undefined>(undefined);
  resolverRef.current = pickResolver(props);

  const uri = "uri" in props ? props.uri : undefined;
  const uriTemplate = "uriTemplate" in props ? props.uriTemplate : undefined;

  // Meta object — omit undefined so `list()` descriptors stay clean.
  const meta = omitUndefined({
    name: props.name,
    description: props.description,
    mimeType: props.mimeType,
    title: props.title,
    size: props.size,
  }) as ResourceMeta & ResourceTemplateMeta;
  // Serialize meta so the effect's dep array is value-stable (a fresh
  // object literal every render would thrash register/unregister).
  const metaKey = JSON.stringify(meta);

  React.useEffect(() => {
    if (!bridge) return;
    // Stable wrapper closes over the ref — the registered resolver never
    // goes stale, and identity is fixed across re-renders.
    const resolve = (
      concreteUri: string,
    ): readonly ResourceContents[] | Promise<readonly ResourceContents[]> => {
      const fn = resolverRef.current;
      if (!fn) {
        throw new Error(
          `<Resource ${uriTemplate ?? uri}> has no content source — supply \`content\`, ` +
            "a `resolver` prop, or a function child.",
        );
      }
      const out = fn(concreteUri);
      return out instanceof Promise
        ? out.then((v) => toContents(v, concreteUri, mimeType))
        : toContents(out, concreteUri, mimeType);
    };
    const unregister = uriTemplate
      ? bridge.registerTemplate(uriTemplate, resolve, meta)
      : bridge.register(uri as string, resolve, meta);
    return () => {
      unregister();
    };
    // `meta` is covered by `metaKey`; `resolve` reads the live ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, uri, uriTemplate, metaKey, mimeType]);

  return null;
}
Resource.displayName = "Resource";

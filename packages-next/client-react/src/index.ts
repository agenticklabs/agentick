/**
 * `@agentick/client-react-next` — React bindings for the agentick wire client.
 *
 * The client is headless-first: every sub-handle (`session.knobs`,
 * `session.timeline`, …) is a framework-agnostic `useSyncExternalStore` store by
 * construction (the zero-arg `subscribe` + snapshot `list`). So the React surface
 * is TWO one-liners, not a hook per handle:
 *
 *   - {@link useHandle} — subscribe to ANY handle's enumerable state.
 *   - {@link useView} — mint + lifecycle-manage a handle's filtered view.
 *
 * ```tsx
 * import { useHandle, useView } from "@agentick/client-react-next";
 *
 * const knobs = useHandle(session.knobs);        // readonly WireKnobDescriptor[]
 * const entries = useHandle(session.timeline);   // readonly TimelineEntry[]
 * const modelOnly = useView(session.timeline, { filter: (e) => e.visibility === "model" });
 * ```
 *
 * This is the BROWSER binding for the wire client — NOT the server-side JSX
 * surface (`@agentick/compiler-react-next` / `BridgeProvider`), which compiles
 * JSX to IR. Different React, different direction.
 *
 * @see docs/proposals/v2/client-handles.md §7b (React bindings)
 * @see docs/proposals/v2/north-star.md §2 (the React appendix)
 */

export { useHandle } from "./use-handle.js";
export { useView, type ViewCapableHandle } from "./use-view.js";

/**
 * In-memory {@link HandlerResolver}.
 *
 * The spec firewall forbids `ToolDeclaration` from embedding executable
 * code. Concrete handlers (and the compiled validators that gate them)
 * live OUTSIDE the spec. The harness resolves them at dispatch time
 * via a {@link HandlerResolver} — this reference impl is a plain
 * `Map<handlerRef, HandlerEntry>`.
 *
 * Cluster deployments may substitute a resolver that routes by
 * `handlerRef` to a remote node; the protocol surface is identical.
 */

import type {
  HandlerEntry,
  HandlerResolver,
  ToolHandler,
  Validator,
} from "./types.js";
import { permissiveValidator } from "./validator.js";

export class InMemoryHandlerResolver implements HandlerResolver {
  private readonly entries = new Map<string, HandlerEntry>();

  /**
   * Register a handler for a `handlerRef`. `validator` defaults to the
   * permissive validator — explicit Standard Schema wiring is the
   * caller's choice.
   *
   * Re-registering an existing ref overwrites silently (last-writer
   * wins). The protocol surface — `ToolExecutorHarness.register()` —
   * is the place to enforce idempotency; the resolver is a plain
   * lookup table.
   */
  register(handlerRef: string, handler: ToolHandler, validator?: Validator): void {
    this.entries.set(handlerRef, {
      handler,
      validator: validator ?? permissiveValidator,
    });
  }

  /** Remove a handler by ref. No-op for unknown refs. */
  unregister(handlerRef: string): void {
    this.entries.delete(handlerRef);
  }

  /** Look up a handler entry by ref. */
  resolve(handlerRef: string): HandlerEntry | undefined {
    return this.entries.get(handlerRef);
  }

  /** Current count — useful for tests + diagnostics. */
  size(): number {
    return this.entries.size;
  }

  /** Drop every registration. Used on harness close. */
  clear(): void {
    this.entries.clear();
  }
}

/**
 * Conformance suite for `ElicitationHarnessProtocol` implementations.
 *
 * Validates the invariants every impl MUST honor:
 *
 *   1. **Round-trip.** `elicit(...)` publishes a request on the
 *      harness's canonical channel; `respond({correlationId, ...})`
 *      resolves the pending elicit with the matching outcome.
 *   2. **Schema validation.** Accepted responses run through the
 *      request's Standard-Schema (sync OR async). Valid values
 *      surface as `{ outcome: "accepted", value }`. Invalid values
 *      surface as `{ outcome: "failed", failure.kind:
 *      "schema_violation", failure.issues }` — NEVER throw.
 *   3. **Declined / cancelled.** User-driven non-accepted outcomes
 *      pass through verbatim (including `reason`).
 *   4. **Timeout.** A request that doesn't receive a response within
 *      `timeoutMs` resolves to `{ outcome: "failed", failure.kind:
 *      "timeout" }`.
 *   5. **Abort.** A pre-aborted or mid-flight aborted signal resolves
 *      to `{ outcome: "failed", failure.kind: "aborted",
 *      failure.reason }`.
 *   6. **Idempotence.** `respond()` for an unknown correlationId is
 *      a no-op. A second `respond()` on an already-resolved
 *      correlationId is also a no-op (first-write-wins).
 *   7. **Concurrent elicitations.** Multiple in-flight elicitations
 *      maintain correlation-id integrity; responses route to the
 *      right pending Deferred regardless of order.
 *   8. **`close()` cancels pending.** All in-flight elicitations
 *      resolve to `{ outcome: "failed", failure.kind: "aborted",
 *      failure.reason: "harness_closed" }` on close.
 *
 * Portability note: the factory's `nextCorrelationId()` hook lets the
 * suite pair an `elicit(...)` with a matching `respond(...)`. In-process
 * impls implement this by subscribing to their local bus and reading
 * `metadata.correlationId` from the next outbound envelope. Remote /
 * cluster impls implement it by tapping their outbound transport hook —
 * whatever path the impl uses to publish requests to subscribers.
 */

import { describe, expect, it } from "vitest";
import type {
  ElicitationHarnessProtocol,
  FormElicitationRequest,
  StandardSchemaV1,
} from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";

// ============================================================================
// Factory contract
// ============================================================================

export interface ElicitationConformanceFactoryInput {
  readonly harnessId: string;
}

/**
 * Shell handed to the suite per-test. The impl owns its own substrate
 * and exposes `nextCorrelationId()` so the suite can pair an
 * `elicit(...)` call with a matching `respond(...)` without the
 * protocol surface needing to expose the correlation engine.
 */
export interface ElicitationConformanceShell {
  readonly harness: ElicitationHarnessProtocol;
  /**
   * Returns a Promise that resolves with the correlationId of the
   * NEXT outbound elicitation request the harness publishes. Call
   * BEFORE `harness.elicit(...)` so the subscription is live by the
   * time the harness publishes.
   *
   * Typical in-process impl: subscribe to the impl's bus, filter on
   * the canonical channel, take the first envelope, return its
   * `metadata.correlationId`. Remote impls tap the outbound transport.
   */
  nextCorrelationId(): Promise<string>;
  /**
   * Resolves with the FULL next outbound elicitation request envelope
   * — payload, metadata, etc. Used by mode-specific tests that need
   * to assert wire shape (URL-mode field presence, schema-mode
   * absence-of-schema-for-url, etc.). Same subscription discipline
   * as {@link nextCorrelationId}: call BEFORE `elicit(...)`.
   */
  nextEnvelope(): Promise<
    Readonly<{
      readonly payload?: unknown;
      readonly metadata?: Readonly<{ readonly correlationId?: string; readonly replyTo?: string }>;
    }>
  >;
  close(): Promise<void>;
}

export type ElicitationConformanceFactory = (
  input: ElicitationConformanceFactoryInput,
) => Promise<ElicitationConformanceShell>;

// ============================================================================
// Fixtures
// ============================================================================

function objectSchema(): StandardSchemaV1<unknown, Record<string, unknown>> {
  return jsonSchema<Record<string, unknown>>(
    { type: "object" },
    {
      validator: (raw) =>
        raw !== null && typeof raw === "object"
          ? { value: raw as Record<string, unknown> }
          : { issues: [{ message: "expected an object" }] },
    },
  );
}

function approvalSchema(): StandardSchemaV1<unknown, { readonly approved: boolean }> {
  return jsonSchema<{ readonly approved: boolean }>(
    {
      type: "object",
      properties: { approved: { type: "boolean" } },
      required: ["approved"],
    },
    {
      validator: (raw) => {
        if (
          raw !== null &&
          typeof raw === "object" &&
          typeof (raw as { approved?: unknown }).approved === "boolean"
        ) {
          return { value: { approved: (raw as { approved: boolean }).approved } };
        }
        return { issues: [{ message: "missing required boolean property `approved`" }] };
      },
    },
  );
}

/** Async-validator fixture — exercises the Promise-resolution path. */
function asyncApprovalSchema(): StandardSchemaV1<unknown, { readonly approved: boolean }> {
  return jsonSchema<{ readonly approved: boolean }>(
    {
      type: "object",
      properties: { approved: { type: "boolean" } },
      required: ["approved"],
    },
    {
      validator: async (raw) => {
        // Force a real microtask before resolving so the harness has
        // to actually await the verdict.
        await Promise.resolve();
        if (
          raw !== null &&
          typeof raw === "object" &&
          typeof (raw as { approved?: unknown }).approved === "boolean"
        ) {
          return { value: { approved: (raw as { approved: boolean }).approved } };
        }
        return { issues: [{ message: "async validator: missing `approved`" }] };
      },
    },
  );
}

function mkRequest<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  overrides: Partial<FormElicitationRequest<TSchema>> = {},
): FormElicitationRequest<TSchema> {
  return {
    message: "Confirm action",
    schema,
    ...overrides,
  };
}

// ============================================================================
// Suite
// ============================================================================

export function runElicitationHarnessConformance(factory: ElicitationConformanceFactory): void {
  describe("ElicitationHarnessProtocol — accepted round-trip", () => {
    it("resolves to { outcome: 'accepted', value } when respond() carries a schema-valid value", async () => {
      const shell = await factory({ harnessId: "elic-accepted-1" });
      try {
        const idP = shell.nextCorrelationId();
        const pending = shell.harness.elicit(mkRequest(approvalSchema()), { timeoutMs: 1_000 });
        const correlationId = await idP;
        await shell.harness.respond({
          correlationId,
          outcome: "accepted",
          value: { approved: true },
        });
        const result = await pending;
        expect(result.outcome).toBe("accepted");
        if (result.outcome === "accepted") {
          expect(result.value).toEqual({ approved: true });
        }
      } finally {
        await shell.close();
      }
    });

    it("supports async validators (Promise<StandardSchemaResult>)", async () => {
      const shell = await factory({ harnessId: "elic-async-1" });
      try {
        const idP = shell.nextCorrelationId();
        const pending = shell.harness.elicit(mkRequest(asyncApprovalSchema()), {
          timeoutMs: 1_000,
        });
        const correlationId = await idP;
        await shell.harness.respond({
          correlationId,
          outcome: "accepted",
          value: { approved: false },
        });
        const result = await pending;
        expect(result.outcome).toBe("accepted");
        if (result.outcome === "accepted") {
          expect(result.value).toEqual({ approved: false });
        }
      } finally {
        await shell.close();
      }
    });
  });

  describe("ElicitationHarnessProtocol — schema validation", () => {
    it("invalid accepted value resolves to { outcome: 'failed', failure.kind: 'schema_violation' }", async () => {
      const shell = await factory({ harnessId: "elic-invalid-1" });
      try {
        const idP = shell.nextCorrelationId();
        const pending = shell.harness.elicit(mkRequest(approvalSchema()), { timeoutMs: 1_000 });
        const correlationId = await idP;
        await shell.harness.respond({
          correlationId,
          outcome: "accepted",
          value: { unrelated: true },
        });
        const result = await pending;
        expect(result.outcome).toBe("failed");
        if (result.outcome === "failed") {
          expect(result.failure.kind).toBe("schema_violation");
          expect(result.failure.issues).toBeDefined();
          expect(result.failure.issues!.length).toBeGreaterThan(0);
        }
      } finally {
        await shell.close();
      }
    });
  });

  describe("ElicitationHarnessProtocol — user-driven outcomes", () => {
    it("declined passes through with reason", async () => {
      const shell = await factory({ harnessId: "elic-decline-1" });
      try {
        const idP = shell.nextCorrelationId();
        const pending = shell.harness.elicit(mkRequest(objectSchema()), { timeoutMs: 1_000 });
        const correlationId = await idP;
        await shell.harness.respond({
          correlationId,
          outcome: "declined",
          reason: "user said no",
        });
        const result = await pending;
        expect(result.outcome).toBe("declined");
        if (result.outcome === "declined") {
          expect(result.reason).toBe("user said no");
        }
      } finally {
        await shell.close();
      }
    });

    it("cancelled passes through with reason", async () => {
      const shell = await factory({ harnessId: "elic-cancel-1" });
      try {
        const idP = shell.nextCorrelationId();
        const pending = shell.harness.elicit(mkRequest(objectSchema()), { timeoutMs: 1_000 });
        const correlationId = await idP;
        await shell.harness.respond({
          correlationId,
          outcome: "cancelled",
          reason: "modal dismissed",
        });
        const result = await pending;
        expect(result.outcome).toBe("cancelled");
        if (result.outcome === "cancelled") {
          expect(result.reason).toBe("modal dismissed");
        }
      } finally {
        await shell.close();
      }
    });
  });

  describe("ElicitationHarnessProtocol — URL mode", () => {
    it("URL-mode accepted resolves to { outcome: 'accepted', value: undefined } (consent-only)", async () => {
      const shell = await factory({ harnessId: "elic-url-accept-1" });
      try {
        const idP = shell.nextCorrelationId();
        const pending = shell.harness.elicit({
          mode: "url",
          message: "Open OAuth page",
          url: "https://example.com/oauth?state=abc",
          elicitationId: "el-url-1",
        });
        const correlationId = await idP;
        // Any value sent is ignored — URL mode is consent-only.
        await shell.harness.respond({
          correlationId,
          outcome: "accepted",
          value: { ignored: true },
        });
        const result = await pending;
        expect(result.outcome).toBe("accepted");
        if (result.outcome === "accepted") {
          expect(result.value).toBeUndefined();
        }
      } finally {
        await shell.close();
      }
    });

    it("URL-mode declined / cancelled pass through verbatim", async () => {
      const shell = await factory({ harnessId: "elic-url-decline-1" });
      try {
        const idP = shell.nextCorrelationId();
        const pending = shell.harness.elicit({
          mode: "url",
          message: "Open OAuth page",
          url: "https://example.com/oauth",
          elicitationId: "el-url-2",
        });
        const correlationId = await idP;
        await shell.harness.respond({
          correlationId,
          outcome: "declined",
          reason: "user said no",
        });
        const result = await pending;
        expect(result).toEqual({ outcome: "declined", reason: "user said no" });
      } finally {
        await shell.close();
      }
    });

    it("wire payload carries `relatedTaskId` when the request sets it (#173)", async () => {
      // Per-task UI surfaces (devtools task panels, agentick-react
      // task hooks) filter elicits by `payload.relatedTaskId`. The
      // contract is: whatever a caller passes on the request lands
      // verbatim on the published envelope. Conformance because every
      // ElicitationHarness impl — including future remote / cluster-
      // shimmed variants — must honor this.
      const shell = await factory({ harnessId: "elic-related-task-1" });
      try {
        const envP = shell.nextEnvelope();
        const pending = shell.harness.elicit({
          message: "Confirm?",
          schema: objectSchema(),
          relatedTaskId: "task:abc",
        });
        const env = await envP;
        const payload = env.payload as { relatedTaskId?: string };
        expect(payload.relatedTaskId).toBe("task:abc");
        await shell.harness.respond({
          correlationId: env.metadata!.correlationId as string,
          outcome: "cancelled",
        });
        await pending;
      } finally {
        await shell.close();
      }
    });

    it("wire payload omits `relatedTaskId` when the request does not set it (#173)", async () => {
      const shell = await factory({ harnessId: "elic-no-related-task-1" });
      try {
        const envP = shell.nextEnvelope();
        const pending = shell.harness.elicit({
          message: "Plain elicit",
          schema: objectSchema(),
        });
        const env = await envP;
        const payload = env.payload as { relatedTaskId?: string };
        expect(payload.relatedTaskId).toBeUndefined();
        await shell.harness.respond({
          correlationId: env.metadata!.correlationId as string,
          outcome: "cancelled",
        });
        await pending;
      } finally {
        await shell.close();
      }
    });

    it("URL-mode wire payload carries url + elicitationId, NO schema", async () => {
      const shell = await factory({ harnessId: "elic-url-wire-1" });
      try {
        const envP = shell.nextEnvelope();
        const pending = shell.harness.elicit({
          mode: "url",
          message: "Open OAuth page",
          url: "https://example.com/oauth",
          elicitationId: "el-url-3",
          hints: { kind: "oauth" },
        });
        const env = await envP;
        const payload = env.payload as {
          mode?: string;
          url?: string;
          elicitationId?: string;
          schema?: unknown;
          hints?: Record<string, unknown>;
        };
        expect(payload.mode).toBe("url");
        expect(payload.url).toBe("https://example.com/oauth");
        expect(payload.elicitationId).toBe("el-url-3");
        expect(payload.schema).toBeUndefined();
        expect(payload.hints).toEqual({ kind: "oauth" });
        await shell.harness.respond({
          correlationId: env.metadata!.correlationId as string,
          outcome: "cancelled",
        });
        await pending;
      } finally {
        await shell.close();
      }
    });
  });

  describe("ElicitationHarnessProtocol — timeout", () => {
    it("resolves to { outcome: 'failed', kind: 'timeout' } when no response arrives", async () => {
      const shell = await factory({ harnessId: "elic-timeout-1" });
      try {
        const result = await shell.harness.elicit(mkRequest(objectSchema()), { timeoutMs: 50 });
        expect(result.outcome).toBe("failed");
        if (result.outcome === "failed") {
          expect(result.failure.kind).toBe("timeout");
        }
      } finally {
        await shell.close();
      }
    });
  });

  describe("ElicitationHarnessProtocol — abort", () => {
    it("pre-aborted signal resolves to { failed, aborted, reason }", async () => {
      const shell = await factory({ harnessId: "elic-abort-pre-1" });
      try {
        const ctrl = new AbortController();
        ctrl.abort("user navigated away");
        const result = await shell.harness.elicit(mkRequest(objectSchema()), {
          timeoutMs: 1_000,
          signal: ctrl.signal,
        });
        expect(result.outcome).toBe("failed");
        if (result.outcome === "failed") {
          expect(result.failure.kind).toBe("aborted");
          expect(result.failure.reason).toBe("user navigated away");
        }
      } finally {
        await shell.close();
      }
    });

    it("mid-flight abort resolves to { failed, aborted }", async () => {
      const shell = await factory({ harnessId: "elic-abort-mid-1" });
      try {
        const ctrl = new AbortController();
        const idP = shell.nextCorrelationId();
        const pending = shell.harness.elicit(mkRequest(objectSchema()), {
          timeoutMs: 1_000,
          signal: ctrl.signal,
        });
        await idP;
        ctrl.abort();
        const result = await pending;
        expect(result.outcome).toBe("failed");
        if (result.outcome === "failed") {
          expect(result.failure.kind).toBe("aborted");
        }
      } finally {
        await shell.close();
      }
    });
  });

  describe("ElicitationHarnessProtocol — idempotence", () => {
    it("respond() with an unknown correlationId is a no-op (does NOT throw)", async () => {
      const shell = await factory({ harnessId: "elic-unknown-1" });
      try {
        await expect(
          shell.harness.respond({ correlationId: "req:does-not-exist", outcome: "declined" }),
        ).resolves.toBeUndefined();
      } finally {
        await shell.close();
      }
    });

    it("double-respond on the same correlationId is first-write-wins", async () => {
      const shell = await factory({ harnessId: "elic-double-1" });
      try {
        const idP = shell.nextCorrelationId();
        const pending = shell.harness.elicit(mkRequest(objectSchema()), { timeoutMs: 1_000 });
        const correlationId = await idP;
        await shell.harness.respond({
          correlationId,
          outcome: "declined",
          reason: "first",
        });
        // Second response on the same correlationId — silent no-op.
        await expect(
          shell.harness.respond({ correlationId, outcome: "accepted", value: { x: 1 } }),
        ).resolves.toBeUndefined();
        const result = await pending;
        expect(result.outcome).toBe("declined");
        if (result.outcome === "declined") {
          expect(result.reason).toBe("first");
        }
      } finally {
        await shell.close();
      }
    });

    it("respond() arriving after timeout is a no-op", async () => {
      const shell = await factory({ harnessId: "elic-late-1" });
      try {
        const idP = shell.nextCorrelationId();
        const pending = shell.harness.elicit(mkRequest(objectSchema()), { timeoutMs: 30 });
        const correlationId = await idP;
        const result = await pending;
        expect(result.outcome).toBe("failed");
        // The pending already terminated; this respond is a stale
        // delivery and MUST be silently dropped.
        await expect(
          shell.harness.respond({ correlationId, outcome: "accepted", value: { x: 1 } }),
        ).resolves.toBeUndefined();
      } finally {
        await shell.close();
      }
    });
  });

  describe("ElicitationHarnessProtocol — concurrent elicitations", () => {
    it("two in-flight elicitations route responses by correlationId", async () => {
      const shell = await factory({ harnessId: "elic-concurrent-1" });
      try {
        // Start two elicits; collect their correlationIds in order.
        const idP1 = shell.nextCorrelationId();
        const pending1 = shell.harness.elicit(mkRequest(approvalSchema()), { timeoutMs: 1_000 });
        const id1 = await idP1;

        const idP2 = shell.nextCorrelationId();
        const pending2 = shell.harness.elicit(mkRequest(approvalSchema()), { timeoutMs: 1_000 });
        const id2 = await idP2;

        expect(id1).not.toBe(id2);

        // Respond OUT OF ORDER — second elicit answered first.
        await shell.harness.respond({
          correlationId: id2,
          outcome: "accepted",
          value: { approved: false },
        });
        await shell.harness.respond({
          correlationId: id1,
          outcome: "accepted",
          value: { approved: true },
        });

        const [r1, r2] = await Promise.all([pending1, pending2]);
        expect(r1.outcome).toBe("accepted");
        expect(r2.outcome).toBe("accepted");
        if (r1.outcome === "accepted") expect(r1.value).toEqual({ approved: true });
        if (r2.outcome === "accepted") expect(r2.value).toEqual({ approved: false });
      } finally {
        await shell.close();
      }
    });
  });

  describe("ElicitationHarnessProtocol — close() cancels pending", () => {
    it("close() resolves in-flight elicitations to { failed, aborted, reason: 'harness_closed' }", async () => {
      const shell = await factory({ harnessId: "elic-close-1" });
      const idP = shell.nextCorrelationId();
      const pending = shell.harness.elicit(mkRequest(objectSchema()), { timeoutMs: 60_000 });
      await idP;
      // Close BEFORE responding — pending elicit MUST be cancelled.
      await shell.close();
      const result = await pending;
      expect(result.outcome).toBe("failed");
      if (result.outcome === "failed") {
        expect(result.failure.kind).toBe("aborted");
        expect(result.failure.reason).toBe("harness_closed");
      }
    });
  });
}

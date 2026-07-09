/**
 * Conformance suite for `ToolExecutorProtocol` implementations.
 *
 * Validates the invariants the pluggability charter promises:
 *
 *   1. **Registry shape.** `register` adds; `unregister` removes;
 *      `list` reports the canonical view filtered by exposure / intent.
 *   2. **Dispatch happy path.** A valid input returns a `DispatchResult`
 *      whose `content` is the handler's output.
 *   3. **Two doors.** A tool with `exposure: ["model"]` accepts
 *      `via: "model"` and rejects `via: "dispatch"` with a
 *      `ToolPermissionError`. Mirror for `exposure: ["dispatch"]`.
 *   4. **Validation.** Input that fails the tool's `inputSchema`
 *      produces `ToolValidationError`.
 *   5. **Not found.** Dispatching an unregistered name produces
 *      `ToolNotFoundError`.
 *   6. **Abort.** A successful `abort(toolCallId)` causes the matching
 *      in-flight dispatch to reject with `ToolAbortedError`.
 *   7. **JSON firewall.** `DispatchResult` round-trips through
 *      `JSON.parse(JSON.stringify(r))` without loss.
 *
 * Confirmation flow + middleware semantics are exercised by the
 * harness's own tests (not here) because they require richer fixtures
 * than the substrate-agnostic factory exposes.
 *
 * The suite is parametrized by a `factory` that returns a fresh
 * executor + a small set of pre-registered fixture tools so the
 * substrate impl owns its handler-registry plumbing.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 */

import { describe, expect, it } from "vitest";
import type {
  DispatchInput,
  ToolDeclaration,
  ToolExecutorProtocol,
  ToolRegistration,
} from "@agentick/spec-next";
import {
  ToolAbortedError,
  ToolHandlerError,
  ToolNotFoundError,
  ToolPermissionError,
  ToolValidationError,
  jsonSchema,
} from "@agentick/spec-next";

/**
 * Fixture tool description for the conformance factory. The factory
 * resolves `handlerRef` to an implementation in its substrate; the
 * suite refers to handlers only by ref string + declared behavior.
 */
export interface FixtureToolSpec {
  readonly declaration: ToolDeclaration;
  /**
   * Logical handler shape the substrate MUST implement. The suite
   * inspects the resulting `DispatchResult` to verify each shape.
   */
  readonly behavior:
    | { readonly kind: "echo" } // returns [{ type: "text", text: JSON.stringify(input) }]
    | { readonly kind: "throw"; readonly message: string }
    | { readonly kind: "slow"; readonly ms: number; readonly text: string }
    | { readonly kind: "deny-validation" }; // produces structured ToolValidationError when input.bad
}

export interface ToolExecutorConformanceFactory {
  /**
   * Create a fresh executor with the supplied fixture tools registered.
   * Implementations resolve handlerRef → handler in their substrate
   * (e.g., reading from an in-memory handler map keyed by ref string).
   */
  createExecutor(fixtures: readonly FixtureToolSpec[]): Promise<ToolExecutorProtocol>;
}

// ============================================================================
// Helpers — canonical fixtures the suite uses across tests
// ============================================================================

function echoTool(name = "echo"): FixtureToolSpec {
  return {
    declaration: {
      id: name,
      name,
      description: "Echo back the JSON-stringified input.",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model", "dispatch"],
    },
    behavior: { kind: "echo" },
  };
}

function modelOnlyTool(name = "model.only"): FixtureToolSpec {
  return {
    declaration: {
      id: name,
      name,
      description: "Model-door only.",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model"],
    },
    behavior: { kind: "echo" },
  };
}

function dispatchOnlyTool(name = "dispatch.only"): FixtureToolSpec {
  return {
    declaration: {
      id: name,
      name,
      description: "Host-door only.",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["dispatch"],
    },
    behavior: { kind: "echo" },
  };
}

function strictTool(name = "strict"): FixtureToolSpec {
  return {
    declaration: {
      id: name,
      name,
      description: "Requires { q: string } at minimum.",
      inputSchema: jsonSchema({
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      }),
      exposure: ["dispatch"],
    },
    behavior: { kind: "deny-validation" },
  };
}

function throwingTool(name = "boom"): FixtureToolSpec {
  return {
    declaration: {
      id: name,
      name,
      description: "Throws.",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["dispatch"],
    },
    behavior: { kind: "throw", message: "intentional handler failure" },
  };
}

function slowTool(name = "slow"): FixtureToolSpec {
  return {
    declaration: {
      id: name,
      name,
      description: "Takes 50ms.",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["dispatch"],
    },
    behavior: { kind: "slow", ms: 50, text: "done" },
  };
}

function dispatchOf(
  name: string,
  via: "model" | "dispatch",
  input: unknown,
  overrides: Partial<DispatchInput> = {},
): DispatchInput {
  return {
    toolCallId: overrides.toolCallId ?? `c_${name}_${via}`,
    name,
    input,
    context: { via },
    ...overrides,
  };
}

// ============================================================================
// Suite
// ============================================================================

export function runToolExecutorConformance(factory: ToolExecutorConformanceFactory): void {
  describe("ToolExecutorProtocol — registry", () => {
    it("list reports registered declarations", async () => {
      const exec = await factory.createExecutor([echoTool(), modelOnlyTool()]);
      const names = (await exec.list()).map((d) => d.name).sort();
      expect(names).toEqual(["echo", "model.only"]);
    });

    it("unregister removes the tool from list and rejects subsequent dispatch", async () => {
      const exec = await factory.createExecutor([echoTool()]);
      await exec.unregister({ name: "echo" });
      const names = (await exec.list()).map((d) => d.name);
      expect(names).not.toContain("echo");
      await expect(exec.dispatch(dispatchOf("echo", "dispatch", {}))).rejects.toMatchObject({
        _tag: "ToolNotFoundError",
      });
    });

    it("list supports exposure filter", async () => {
      const exec = await factory.createExecutor([modelOnlyTool("m1"), dispatchOnlyTool("d1")]);
      const modelNames = (await exec.list({ exposure: "model" })).map((d) => d.name);
      expect(modelNames).toContain("m1");
      expect(modelNames).not.toContain("d1");
    });

    it("register accepts a new ToolRegistration via the protocol", async () => {
      const exec = await factory.createExecutor([]);
      const decl: ToolDeclaration = {
        id: "added.later",
        name: "added.later",
        description: "Registered through the protocol.",
        inputSchema: jsonSchema({ type: "object" }),
        exposure: ["dispatch"],
      };
      const reg: ToolRegistration = {
        declaration: decl,
        // Implementations resolve handlerRef in their substrate. The
        // suite stipulates the substrate accepts at least the literal
        // "echo" handlerRef for tools whose declared name is registered
        // via the factory. For protocol-side register(), the substrate
        // MAY treat an unknown handlerRef as a no-op handler returning
        // an empty content array — verified only by shape here.
        handlerRef: "h.added.later",
        binding: { scope: "runtime" },
      };
      await exec.register({ registration: reg });
      const names = (await exec.list()).map((d) => d.name);
      expect(names).toContain("added.later");
    });
  });

  describe("ToolExecutorProtocol — dispatch happy path", () => {
    it("returns a DispatchResult with the handler's content", async () => {
      const exec = await factory.createExecutor([echoTool()]);
      const result = await exec.dispatch(dispatchOf("echo", "dispatch", { hello: "world" }));
      expect(result.name).toBe("echo");
      expect(result.isError ?? false).toBe(false);
      expect(result.content[0]).toMatchObject({ type: "text" });
    });

    it("preserves toolCallId across the round-trip", async () => {
      const exec = await factory.createExecutor([echoTool()]);
      const result = await exec.dispatch(
        dispatchOf("echo", "dispatch", {}, { toolCallId: "stable-id-42" }),
      );
      expect(result.toolCallId).toBe("stable-id-42");
    });

    it("JSON firewall — DispatchResult round-trips through JSON without loss", async () => {
      const exec = await factory.createExecutor([echoTool()]);
      const result = await exec.dispatch(dispatchOf("echo", "dispatch", { hello: "world" }));
      const round = JSON.parse(JSON.stringify(result));
      expect(round).toEqual(result);
    });
  });

  describe("ToolExecutorProtocol — two doors", () => {
    it("model-only tool rejects host-door dispatch with ToolPermissionError", async () => {
      const exec = await factory.createExecutor([modelOnlyTool()]);
      await expect(exec.dispatch(dispatchOf("model.only", "dispatch", {}))).rejects.toBeInstanceOf(
        ToolPermissionError,
      );
    });

    it("dispatch-only tool rejects model-door dispatch with ToolPermissionError", async () => {
      const exec = await factory.createExecutor([dispatchOnlyTool()]);
      await expect(exec.dispatch(dispatchOf("dispatch.only", "model", {}))).rejects.toBeInstanceOf(
        ToolPermissionError,
      );
    });

    it("dual-exposure tool accepts both doors", async () => {
      const exec = await factory.createExecutor([echoTool()]);
      const m = await exec.dispatch(dispatchOf("echo", "model", {}));
      const d = await exec.dispatch(dispatchOf("echo", "dispatch", {}));
      expect(m.isError ?? false).toBe(false);
      expect(d.isError ?? false).toBe(false);
    });
  });

  describe("ToolExecutorProtocol — validation + lookup", () => {
    it("unknown name rejects with ToolNotFoundError", async () => {
      const exec = await factory.createExecutor([echoTool()]);
      await expect(exec.dispatch(dispatchOf("missing", "dispatch", {}))).rejects.toBeInstanceOf(
        ToolNotFoundError,
      );
    });

    it("input that violates inputSchema rejects with ToolValidationError", async () => {
      const exec = await factory.createExecutor([strictTool()]);
      // Missing required `q` field.
      await expect(
        exec.dispatch(dispatchOf("strict", "dispatch", { other: 1 })),
      ).rejects.toBeInstanceOf(ToolValidationError);
    });

    it("valid input passes validation and reaches the handler", async () => {
      // Use echoTool (lenient schema) so the handler runs; strict tool's
      // `deny-validation` behavior produces failures by design.
      const exec = await factory.createExecutor([echoTool()]);
      const result = await exec.dispatch(dispatchOf("echo", "dispatch", { q: "ok" }));
      expect(result.isError ?? false).toBe(false);
    });
  });

  describe("ToolExecutorProtocol — handler errors", () => {
    it("handler throwing rejects with ToolHandlerError", async () => {
      const exec = await factory.createExecutor([throwingTool()]);
      await expect(exec.dispatch(dispatchOf("boom", "dispatch", {}))).rejects.toBeInstanceOf(
        ToolHandlerError,
      );
    });
  });

  describe("ToolExecutorProtocol — abort", () => {
    it("abort(toolCallId) causes the in-flight dispatch to reject", async () => {
      const exec = await factory.createExecutor([slowTool()]);
      const callId = "slow-call-1";
      const inFlight = exec.dispatch(dispatchOf("slow", "dispatch", {}, { toolCallId: callId }));
      // Abort shortly after dispatch begins.
      await new Promise<void>((r) => setTimeout(r, 5));
      await exec.abort({ toolCallId: callId, reason: "test" });
      await expect(inFlight).rejects.toBeInstanceOf(ToolAbortedError);
    });

    it("abort of an unknown toolCallId is a no-op (does not throw)", async () => {
      const exec = await factory.createExecutor([echoTool()]);
      await exec.abort({ toolCallId: "never-dispatched" });
    });
  });
}

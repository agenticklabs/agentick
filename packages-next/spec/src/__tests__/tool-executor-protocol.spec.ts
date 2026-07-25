/**
 * Surface check for `@agentick/spec-next` tool-executor types.
 *
 * These tests don't exercise behavior — that lives in the conformance
 * suite at `@agentick/spec-conformance-next/tool-executor`. They pin the
 * shape of the public types so that accidental breaking changes show up
 * as TS errors here.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AbortInput,
  DispatchContext,
  DispatchInput,
  DispatchResult,
  RegisterToolInput,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  ToolDeclaration,
  ToolDispatchTerminal,
  ToolExecutorError,
  ToolExecutorProtocol,
  ToolLifecycleEvent,
  ToolListFilter,
  ToolRegistration,
  UnregisterToolInput,
} from "../index.js";
import {
  jsonSchema,
  ToolConfirmationDeniedError,
  ToolNotFoundError,
  ToolTimeoutError,
} from "../index.js";

describe("@agentick/spec-next — tool executor protocol", () => {
  describe("DispatchInput / DispatchContext", () => {
    it("accepts a minimal model-door dispatch", () => {
      const input: DispatchInput = {
        toolCallId: "call_1",
        name: "calc.add",
        input: { a: 1, b: 2 },
        context: { via: "model" },
      };
      expect(input.context.via).toBe("model");
    });

    it("accepts a host-door dispatch with full context", () => {
      const input: DispatchInput = {
        toolCallId: "call_2",
        name: "search",
        input: { query: "react" },
        context: {
          via: "dispatch",
          sessionId: "s_1",
          executionId: "e_1",
          tickId: "t_1",
          request: { traceparent: "00-…" },
          use: { sandbox: "opaque-bridge-ref" },
        },
        signal: new AbortController().signal,
        timeoutMs: 5_000,
      };
      expect(input.context.via).toBe("dispatch");
    });

    it("DispatchContext.via is the disjoint union", () => {
      const ctx: DispatchContext = { via: "model" };
      expectTypeOf(ctx.via).toEqualTypeOf<"model" | "dispatch">();
    });
  });

  describe("DispatchResult", () => {
    it("returns ContentBlock[] (executedBy + metrics optional; isError absent = success)", () => {
      const result: DispatchResult = {
        toolCallId: "c1",
        name: "calc.add",
        content: [{ type: "text", text: "3" }],
        executedBy: "agentick",
        durationMs: 2,
      };
      // ADR 70 — success is the default (isError absent/false); HARD
      // failures reject rather than resolving a result.
      expect(result.isError ?? false).toBe(false);
    });

    it("carries a SOFT error (isError) + structuredContent (ADR 70)", () => {
      const result: DispatchResult = {
        toolCallId: "c2",
        name: "weather.get",
        isError: false,
        content: [{ type: "text", text: "72F, clear" }],
        structuredContent: { tempF: 72, condition: "clear" },
      };
      expect(result.structuredContent).toEqual({ tempF: 72, condition: "clear" });
      const soft: DispatchResult = {
        toolCallId: "c3",
        name: "weather.get",
        isError: true,
        content: [{ type: "text", text: "location not found" }],
      };
      expect(soft.isError).toBe(true);
    });
  });

  describe("AbortInput / UnregisterToolInput / ToolListFilter", () => {
    it("AbortInput requires toolCallId only", () => {
      const a: AbortInput = { toolCallId: "c1" };
      expect(a.toolCallId).toBe("c1");
    });

    it("UnregisterToolInput requires name", () => {
      const u: UnregisterToolInput = { name: "calc.add" };
      expect(u.name).toBe("calc.add");
    });

    it("ToolListFilter is fully optional", () => {
      const f1: ToolListFilter = {};
      const f2: ToolListFilter = { exposure: "model", intent: "action" };
      expect(f1).toEqual({});
      expect(f2.exposure).toBe("model");
    });
  });

  describe("Registry I/O", () => {
    it("ToolRegistration carries declaration + handlerRef (+ optional useDeps)", () => {
      const decl: ToolDeclaration = {
        id: "calc.add",
        name: "calc.add",
        description: "add two numbers",
        inputSchema: jsonSchema({ type: "object" }),
        exposure: ["model"],
      };
      const reg: ToolRegistration = {
        declaration: decl,
        handlerRef: "h.calc.add",
        useDeps: { logger: "opaque" },
        binding: { scope: "runtime" },
      };
      const input: RegisterToolInput = { registration: reg };
      expect(input.registration.declaration.name).toBe("calc.add");
    });
  });

  describe("Confirmation flow", () => {
    it("ToolConfirmationRequest shape carries arguments + optional UI metadata", () => {
      const req: ToolConfirmationRequest = {
        toolUseId: "tu_1",
        name: "fs.delete",
        arguments: { path: "/tmp/foo" },
        message: "Delete /tmp/foo?",
      };
      expect(req.name).toBe("fs.delete");
    });

    it("ToolConfirmationResponse supports approved/denied + modifiedArguments", () => {
      const ok: ToolConfirmationResponse = {
        toolUseId: "tu_1",
        approved: true,
        modifiedArguments: { path: "/tmp/foo-renamed" },
      };
      const no: ToolConfirmationResponse = {
        toolUseId: "tu_1",
        approved: false,
        reason: "policy denies fs.delete",
      };
      expect(ok.approved).toBe(true);
      expect(no.approved).toBe(false);
    });
  });

  describe("Lifecycle events", () => {
    it("ToolLifecycleEvent narrows on kind", () => {
      const ev: ToolLifecycleEvent = {
        kind: "tool-dispatch-terminal",
        toolCallId: "c1",
        name: "calc.add",
        outcome: "succeeded",
        durationMs: 3,
      };
      if (ev.kind === "tool-dispatch-terminal") {
        expectTypeOf(ev.outcome).toEqualTypeOf<ToolDispatchTerminal["outcome"]>();
      }
      expect(ev.kind).toBe("tool-dispatch-terminal");
    });

    it("outcome union is closed (succeeded | failed | vetoed | aborted)", () => {
      const terminal: ToolDispatchTerminal = {
        kind: "tool-dispatch-terminal",
        toolCallId: "c1",
        name: "calc.add",
        outcome: "failed",
        durationMs: 7,
      };
      expectTypeOf(terminal.outcome).toEqualTypeOf<"succeeded" | "failed" | "vetoed" | "aborted">();
    });
  });

  describe("Errors", () => {
    it("ToolExecutorError tags discriminate", () => {
      const e1: ToolExecutorError = new ToolNotFoundError({
        name: "missing",
        registered: ["a", "b"],
      });
      const e2: ToolExecutorError = new ToolTimeoutError({
        toolName: "slow",
        ms: 5_000,
      });
      const e3: ToolExecutorError = new ToolConfirmationDeniedError({
        toolName: "fs.delete",
        reason: "user denied",
      });
      expect(e1._tag).toBe("ToolNotFoundError");
      expect(e2._tag).toBe("ToolTimeoutError");
      expect(e3._tag).toBe("ToolConfirmationDeniedError");
    });
  });

  describe("Inbox messages", () => {
    it("abort routes via the generic command-invocation shape (type tool:abort, payload AbortInput)", () => {
      // The tool executor defines no custom inbox message type. `abort`
      // is a declared command (`tool:abort`); an external actor sends the
      // generic command shape and BaseHarness.dispatchMessage validates
      // the payload against AbortInput before invoking. Pin that the
      // payload IS an AbortInput.
      const payload: AbortInput = { toolCallId: "c1", reason: "user pressed escape" };
      const message = { type: "tool:abort", payload };
      expect(message.type).toBe("tool:abort");
      expect(message.payload.toolCallId).toBe("c1");
    });
  });

  describe("ToolExecutorProtocol surface", () => {
    it("declares the full method set (register/unregister/respondToToolCall/dispatch/abort/list/tools + binding scopes)", () => {
      type Methods = keyof ToolExecutorProtocol;
      expectTypeOf<Methods>().toEqualTypeOf<
        | "fx"
        | "tools"
        | "register"
        | "unregister"
        | "respondToToolCall"
        | "dispatch"
        | "abort"
        | "list"
        | "removeBoundTools"
        | "replaceCompilerTools"
        | "compileForTick"
      >();
    });
  });
});

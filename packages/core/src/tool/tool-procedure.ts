import { useRef } from "react";
import { createEngineProcedure, isProcedure } from "../procedure";
import { useCom } from "../hooks";
import type { Middleware } from "@agentick/kernel";

/**
 * Create a Procedure from a raw tool handler function.
 * The handler receives (input, context) where context comes from contextRef.current.
 *
 * Does NOT check isProcedure — callers must guard before calling.
 */
export function createToolProcedure(
  toolName: string,
  handler: Function,
  contextRef: { current: any },
  middleware?: Middleware[],
) {
  return createEngineProcedure(
    {
      name: "tool:run" as const,
      metadata: { type: "tool", toolName, id: toolName, operation: "run" },
      middleware: middleware || [],
      executionBoundary: "child" as const,
      executionType: "tool",
    },
    async (input: any) => handler(input, contextRef.current),
  );
}

/**
 * React hook: wraps a tool handler as a Procedure with ctx injection.
 * Returns undefined if no handler provided.
 * Passes through existing Procedures unchanged.
 */
export function useToolProcedure(
  handler: Function | undefined,
  name: string,
  middleware?: Middleware[],
) {
  const ctx = useCom();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const ref = useRef<any>(null);
  if (handler && !ref.current) {
    if (isProcedure(handler)) {
      ref.current = handler;
    } else {
      ref.current = createToolProcedure(name, handler, ctxRef, middleware);
    }
  }
  return ref.current ?? undefined;
}

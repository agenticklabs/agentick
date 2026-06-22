/**
 * Wire `runToolExecutorConformance` from `@agentick/spec-conformance-next`
 * against the reference impl in this package.
 *
 * The factory translates `FixtureToolSpec.behavior` into concrete
 * handler functions registered on the bundled `InMemoryHandlerResolver`.
 */

import {
  type FixtureToolSpec,
  type ToolExecutorConformanceFactory,
  runToolExecutorConformance,
} from "@agentick/spec-conformance-next";
import type { ContentBlock, ToolExecutorProtocol } from "@agentick/spec-next";
import type { ToolHandler, Validator } from "../types.js";
import { createTestHarness } from "../testing/index.js";
import { permissiveValidator } from "../validator.js";

function makeHandlerForBehavior(fixture: FixtureToolSpec): {
  handler: ToolHandler;
  validator: Validator;
} {
  switch (fixture.behavior.kind) {
    case "echo":
      return {
        handler: async (input) => [
          { type: "text", text: JSON.stringify(input) } satisfies ContentBlock,
        ],
        validator: permissiveValidator,
      };
    case "throw": {
      const message = fixture.behavior.message;
      return {
        handler: async () => {
          throw new Error(message);
        },
        validator: permissiveValidator,
      };
    }
    case "slow": {
      const ms = fixture.behavior.ms;
      const text = fixture.behavior.text;
      return {
        handler: async (_input, deps) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => resolve(), ms);
            deps.ctx.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(deps.ctx.signal.reason);
            });
          });
          return [{ type: "text", text } satisfies ContentBlock];
        },
        validator: permissiveValidator,
      };
    }
    case "deny-validation":
      return {
        handler: async () => [{ type: "text", text: "should never run" }],
        validator: {
          validate: (value: unknown) => {
            // The fixture's strict tool has inputSchema requiring `q: string`.
            // Mirror that here so the validator rejects { other: 1 } etc.
            const v = value as Record<string, unknown> | null;
            if (v === null || typeof v.q !== "string") {
              return { issues: [{ message: "q must be a string", path: ["q"] }] };
            }
            return { value };
          },
        },
      };
  }
}

const factory: ToolExecutorConformanceFactory = {
  async createExecutor(fixtures): Promise<ToolExecutorProtocol> {
    const { harness } = await createTestHarness({
      tools: fixtures.map((f) => ({
        declaration: f.declaration,
        handlerRef: `h.${f.declaration.name}`,
        binding: { scope: "runtime" as const },
      })),
      handlers: fixtures.map((f) => {
        const { handler, validator } = makeHandlerForBehavior(f);
        return {
          handlerRef: `h.${f.declaration.name}`,
          handler,
          validator,
        };
      }),
    });
    return harness;
  },
};

runToolExecutorConformance(factory);

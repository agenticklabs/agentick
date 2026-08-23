/**
 * `completions/complete` — the wire route, driven directly.
 *
 * Exercises the real `completionsWireExtension` handler against a stub
 * gateway/app/session (the stub style `knobs/src/__tests__/wire.spec.ts` uses).
 * What is pinned here is the ROUTING — the two-hop join no single harness can
 * own — and the silence contract:
 *
 *   - a `resolved` outcome from prompts passes straight through;
 *   - a `ref` outcome triggers the second hop into the completions registry,
 *     carrying the typed value and the sibling arguments;
 *   - every unanswerable shape answers `{ values: [] }`: no prompts surface, an
 *     `unavailable` argument, a ref with no registry mounted, a ref no one bound;
 *   - a resolver that THREW is a real failure and surfaces;
 *   - `PromptNotFound` propagates as the error it is;
 *   - an unresolved session throws, like every other session-scoped route.
 *
 * The harnesses' own semantics are proven in their own suites (`complete` in
 * `@agentick/prompts`, `resolve` in `./harness.spec.ts`); this is the projection.
 */

import { describe, expect, it, vi } from "vitest";
import {
  SessionNotFoundError,
  CompletionNotFound,
  CompletionResolveFailed,
  PromptNotFound,
} from "@agentick/spec";
import type {
  AppHarnessProtocol,
  Completions,
  CompletionsResolveInput,
  PromptsCompleteInput,
  PromptsCompleteOutcome,
  SessionHarnessProtocol,
  WireExtensionContext,
} from "@agentick/spec";

import { fakeGatewayHarness } from "@agentick/spec-conformance";

import { completionsWireExtension } from "../wire.js";

const SESSION_ID = "sess-1";

interface StubParts {
  /** What the prompts completion surface answers, or a throw. */
  readonly outcome?: PromptsCompleteOutcome | (() => never);
  /** Present only when the session mounts the completions namespace. */
  readonly registry?: Partial<Completions>;
  /** Omit the prompts surface entirely. */
  readonly noPrompts?: boolean;
}

function stubSession(parts: StubParts, calls: unknown[]): SessionHarnessProtocol {
  const prompts = parts.noPrompts
    ? undefined
    : {
        complete: async (input: PromptsCompleteInput): Promise<PromptsCompleteOutcome> => {
          calls.push(input);
          const outcome = parts.outcome;
          if (typeof outcome === "function") return outcome();
          return outcome ?? { kind: "unavailable" };
        },
      };
  return {
    id: SESSION_ID,
    prompts,
    completions: parts.registry,
  } as unknown as SessionHarnessProtocol;
}

function stubCtx(session: SessionHarnessProtocol | undefined): WireExtensionContext {
  const app = {
    getSession: (id: string) => (session && id === SESSION_ID ? session : undefined),
  } as unknown as AppHarnessProtocol;
  return {
    gateway: fakeGatewayHarness({ apps: [app] }),
  } as unknown as WireExtensionContext;
}

const complete = completionsWireExtension.methods["completions/complete"]!;

/** The params a composer sends for `phase`, with `job` already filled. */
const PHASE_PARAMS = {
  sessionId: SESSION_ID,
  ref: { type: "prompt", name: "tm_change_order_actual_cost" },
  argument: { name: "phase", value: "fra" },
  context: { arguments: { job: "Miller Residence" } },
} as const;

describe("completions/complete — hop 1, the prompts completion surface", () => {
  it("passes a resolved outcome straight through, ref and context intact", async () => {
    const calls: unknown[] = [];
    const result = await complete(
      PHASE_PARAMS,
      stubCtx(
        stubSession({ outcome: { kind: "resolved", result: { values: ["Framing"] } } }, calls),
      ),
    );

    expect(result).toEqual({ values: ["Framing"] });
    // The ref's NAME becomes the prompt name; `context.arguments` is carried
    // nested (MCP parity), not flattened at this boundary.
    expect(calls).toEqual([
      {
        name: "tm_change_order_actual_cost",
        argument: { name: "phase", value: "fra" },
        context: { arguments: { job: "Miller Residence" } },
      },
    ]);
  });

  it("answers empty for an unavailable argument", async () => {
    const result = await complete(
      PHASE_PARAMS,
      stubCtx(stubSession({ outcome: { kind: "unavailable" } }, [])),
    );
    expect(result).toEqual({ values: [] });
  });

  it("answers empty when the session mounts no prompts surface", async () => {
    const result = await complete(PHASE_PARAMS, stubCtx(stubSession({ noPrompts: true }, [])));
    expect(result).toEqual({ values: [] });
  });

  it("propagates PromptNotFound — an unknown prompt is a client bug, not silence", async () => {
    await expect(
      complete(
        PHASE_PARAMS,
        stubCtx(
          stubSession(
            {
              outcome: () => {
                throw new PromptNotFound({ promptName: "no-such" });
              },
            },
            [],
          ),
        ),
      ),
    ).rejects.toBeInstanceOf(PromptNotFound);
  });
});

describe("completions/complete — hop 2, the registry", () => {
  it("resolves a returned ref with the typed value and the sibling arguments", async () => {
    const resolve = vi.fn(async (_name: string, _input: CompletionsResolveInput) => ({
      values: ["Framing"],
      total: 1,
    }));
    const result = await complete(
      PHASE_PARAMS,
      stubCtx(
        stubSession(
          { outcome: { kind: "ref", completeRef: "knowify.phases" }, registry: { resolve } },
          [],
        ),
      ),
    );

    expect(result).toEqual({ values: ["Framing"], total: 1 });
    // `context.arguments` FLATTENS onto the seam's own name here — the registry
    // speaks `resolvedArguments`.
    expect(resolve).toHaveBeenCalledWith("knowify.phases", {
      value: "fra",
      resolvedArguments: { job: "Miller Residence" },
    });
  });

  it("answers empty when no registry is mounted to answer the ref", async () => {
    const result = await complete(
      PHASE_PARAMS,
      stubCtx(stubSession({ outcome: { kind: "ref", completeRef: "knowify.phases" } }, [])),
    );
    expect(result).toEqual({ values: [] });
  });

  it("answers empty for a ref nobody bound", async () => {
    // A shared prompt library may name a source this deployment never mounted.
    // An unanswered question is not a wire fault.
    const resolve = vi.fn(async () => {
      throw new CompletionNotFound({ completionName: "knowify.phases" });
    });
    const result = await complete(
      PHASE_PARAMS,
      stubCtx(
        stubSession(
          { outcome: { kind: "ref", completeRef: "knowify.phases" }, registry: { resolve } },
          [],
        ),
      ),
    );
    expect(result).toEqual({ values: [] });
  });

  it("surfaces a resolver that threw — that is a failure, not an empty answer", async () => {
    const resolve = vi.fn(async () => {
      throw new CompletionResolveFailed({
        completionName: "knowify.phases",
        cause: "upstream 503",
      });
    });
    await expect(
      complete(
        PHASE_PARAMS,
        stubCtx(
          stubSession(
            { outcome: { kind: "ref", completeRef: "knowify.phases" }, registry: { resolve } },
            [],
          ),
        ),
      ),
    ).rejects.toBeInstanceOf(CompletionResolveFailed);
  });
});

describe("completions/complete — session resolution", () => {
  it("throws SessionNotFoundError when the session does not resolve", async () => {
    await expect(complete(PHASE_PARAMS, stubCtx(undefined))).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });
});

describe("completionsWireExtension — the declaration", () => {
  it("declares completions/complete bus-only so a keystroke never journals", async () => {
    expect(completionsWireExtension.journal).toEqual({ "completions/complete": "bus-only" });
  });
});

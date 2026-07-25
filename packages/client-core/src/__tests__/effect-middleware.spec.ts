/**
 * effectMiddleware — Effect-flavored middleware adapter.
 *
 * README claims adopters can write client middleware against the
 * Effect-native signature and the framework bridges to Promise at the
 * boundary. Verifies the adapter composes correctly with the Promise
 * pipeline.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ClientExtension, RequestInput } from "@agentick/spec";

import { composeRequest } from "../pipeline.js";
import { effectMiddleware } from "../effect-middleware.js";

describe("effectMiddleware", () => {
  it("composes an Effect-flavored middleware into the Promise pipeline", async () => {
    const seen: string[] = [];

    const effectExt: ClientExtension = {
      name: "effect-observer",
      request: effectMiddleware((req, next) =>
        Effect.gen(function* () {
          seen.push(`effect:before:${req.method}`);
          const result = yield* next(req);
          seen.push(`effect:after:${req.method}`);
          return result;
        }),
      ),
    };

    const composed = composeRequest([effectExt], async (req) => {
      seen.push(`terminal:${req.method}`);
      return { ok: true } as never;
    });

    const result = await composed({ method: "ping", params: {} } as RequestInput<"ping">);
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual(["effect:before:ping", "terminal:ping", "effect:after:ping"]);
  });

  it("propagates errors from the inner Effect", async () => {
    const failingExt: ClientExtension = {
      name: "fails",
      request: effectMiddleware(() => Effect.fail("boom") as never),
    };

    const composed = composeRequest([failingExt], async () => ({}) as never);
    await expect(
      composed({ method: "ping", params: {} } as RequestInput<"ping">),
    ).rejects.toBeDefined();
  });

  it("interleaves with Promise-native middleware in outer→inner order", async () => {
    const seen: string[] = [];
    const promiseOuter: ClientExtension = {
      name: "promise-outer",
      async request(req, next) {
        seen.push("promise-outer:before");
        const r = await next(req);
        seen.push("promise-outer:after");
        return r;
      },
    };
    const effectInner: ClientExtension = {
      name: "effect-inner",
      request: effectMiddleware((req, next) =>
        Effect.gen(function* () {
          seen.push("effect-inner:before");
          const r = yield* next(req);
          seen.push("effect-inner:after");
          return r;
        }),
      ),
    };

    const composed = composeRequest([promiseOuter, effectInner], async () => {
      seen.push("terminal");
      return {} as never;
    });
    await composed({ method: "ping", params: {} } as RequestInput<"ping">);

    expect(seen).toEqual([
      "promise-outer:before",
      "effect-inner:before",
      "terminal",
      "effect-inner:after",
      "promise-outer:after",
    ]);
  });
});

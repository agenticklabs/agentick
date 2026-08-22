/**
 * ADR 93 — the GENESIS laws for prompts, plus the interceptor-cascade ORDER the
 * `hooks:` / `guards:` bags desugar into.
 *
 * Laws pinned here (ADR 93 landmines 1, 2, 3 and the cascade-order gate):
 *   - genesis output is SEED — no `prompts:register` op, no store write
 *     (landmine 3) — but the `{ template, render }` sidecar IS populated, because
 *     that is the only place a hydrator's code can live;
 *   - a throwing hydrator surfaces `PromptsHydrateFailed` with nothing
 *     half-installed (landmine 2);
 *   - FORK / SPAWN-inherit never re-runs genesis (landmine 1);
 *   - a definition's `hooks:` / `guards:` bags use DROP-LAYER keys and land on the
 *     same ops the discriminated app-level names reach;
 *   - APP-level interceptors wrap DEFINITION-level ones.
 */

import { describe, expect, it } from "vitest";
import {
  guardsToMiddlewares,
  hooksToMiddlewares,
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  generateId,
  type Middleware,
} from "@agentick/runtime";
import { isCheckpointCapable, PromptsHydrateFailed } from "@agentick/spec";
import type {
  CollectionMutation,
  PromptDeclarationRecord,
  PromptStoreQuery,
  Store,
} from "@agentick/spec";

import { PromptsHarness, type PromptsHarnessOptions } from "../harness.js";
import { definePrompts } from "../definition.js";
import { hydrateFrom, hydrateFromStore } from "../hydrators.js";
import { InMemoryPromptStore } from "../store.js";

async function harness(options: PromptsHarnessOptions = {}): Promise<PromptsHarness> {
  const h = new PromptsHarness(
    `prompts-genesis-${generateId()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    options,
  );
  await h.ready;
  return h;
}

/** A store that records every mutation it is asked to make. */
function spyStore(): {
  store: Store<
    PromptDeclarationRecord,
    PromptStoreQuery,
    CollectionMutation<PromptDeclarationRecord>
  >;
  mutations: CollectionMutation<PromptDeclarationRecord>[];
} {
  const mutations: CollectionMutation<PromptDeclarationRecord>[] = [];
  const inner = new InMemoryPromptStore();
  return {
    mutations,
    store: {
      backend: "spy",
      query: (q, ctx) => inner.query(q, ctx),
      mutate: async (m, ctx) => {
        mutations.push(m);
        await inner.mutate(m, ctx);
      },
    },
  };
}

const prompt = (name: string, template = `${name} body`) => ({
  declaration: { name, description: `${name} description`, template },
});

describe("genesis — the seed law (ADR 93 landmine 3)", () => {
  it("seeded prompts never reach the store's mutate", async () => {
    const { store, mutations } = spyStore();
    const h = await harness({ store, hydrate: hydrateFrom([prompt("g1"), prompt("g2")]) });

    await h.hydrate();
    expect(h.list().map((d) => d.name)).toEqual(["g1", "g2"]);
    expect(mutations).toEqual([]);

    // A real register still writes through — genesis is the ONLY exemption.
    await h.register(prompt("live"));
    expect(mutations).toHaveLength(1);
    await h.close();
  });

  it("seeded prompts produce no `prompts:register` op", async () => {
    const fired: string[] = [];
    const h = await harness({
      hydrate: hydrateFrom([prompt("g1")]),
      hooks: {
        onBeforeRegister: (input) => {
          fired.push(input.declaration.name);
        },
      },
    });
    await h.hydrate();
    expect(fired).toEqual([]);
    expect(h.has("g1")).toBe(true);
    // A real register does fire it, so the assertion above is not vacuous.
    await h.register(prompt("live"));
    expect(fired).toEqual(["live"]);
    await h.close();
  });

  it("populates the `{ template, render }` sidecar, so a seeded prompt RENDERS", async () => {
    // The seed law says "no store write", not "no content". A hydrator is
    // in-process code, so its `render` is as real as a register's — and the store
    // slice could never have held it.
    const h = await harness({
      hydrate: hydrateFrom([
        {
          declaration: {
            name: "dynamic",
            description: "d",
            render: (args) => `hi ${String(args.who)}`,
          },
        },
      ]),
    });
    await h.hydrate();
    const result = await h.render({ name: "dynamic", args: { who: "world" } });
    expect(result.messages[0]!.content).toEqual([{ type: "text", text: "hi world" }]);
    await h.close();
  });

  it("no hydrator ⇒ genesis is a no-op (the zero-cost default)", async () => {
    const h = await harness();
    await h.hydrate();
    expect(h.list()).toEqual([]);
    await h.close();
  });

  it("a `store` WITHOUT a hydrator loads nothing — prompts names no default", async () => {
    const store = new InMemoryPromptStore();
    await store.mutate({ put: { name: "durable", description: "d" } }, {} as never);
    const h = await harness({ store });
    await h.hydrate();
    expect(h.list()).toEqual([]);
    // Ask for it and it is there — the seam, not a setting.
    const asked = await harness({ store, hydrate: hydrateFromStore() });
    await asked.hydrate();
    expect(asked.list().map((d) => d.name)).toEqual(["durable"]);
    await h.close();
    await asked.close();
  });

  it("a seeded catalog pings its subscribers so the first render sees it", async () => {
    const h = await harness({ hydrate: hydrateFrom([prompt("g1")]) });
    let pings = 0;
    h.subscribeAll(() => {
      pings += 1;
    });
    await h.hydrate();
    expect(pings).toBeGreaterThan(0);
    await h.close();
  });
});

describe("genesis — typed failure (ADR 93 landmine 2)", () => {
  it("a throwing hydrator rejects with PromptsHydrateFailed carrying the cause", async () => {
    const boom = new Error("prompt module unresolvable");
    const h = await harness({ hydrate: () => Promise.reject(boom) });
    await expect(h.hydrate()).rejects.toBeInstanceOf(PromptsHydrateFailed);
    await expect(h.hydrate()).rejects.toMatchObject({ cause: boom });
    expect(h.list()).toEqual([]);
    await h.close();
  });

  it("an already-typed failure is not double-wrapped", async () => {
    const typed = new PromptsHydrateFailed({ cause: "inner" });
    const h = await harness({ hydrate: () => Promise.reject(typed) });
    await expect(h.hydrate()).rejects.toBe(typed);
    await h.close();
  });

  it("the failure propagates out of the extension install, so session creation fails", async () => {
    const { withPrompts } = await import("../extension.js");
    const installer = {
      kind: "session",
      hostId: "host",
      sessionId: "sess",
      substrate: {
        journal: new MemoryJournal(),
        bus: new LocalEventBus(),
        inbox: new LocalInbox(),
      },
      interceptors: {},
      registerNamespace: () => () => {},
      getNamespace: () => undefined,
      registerToolHandler: () => () => {},
      registerExtensionTool: () => () => {},
      onClose: () => () => {},
    } as unknown as import("@agentick/spec").SessionInstaller;

    await expect(
      withPrompts({ hydrate: () => Promise.reject(new Error("nope")) }).install(installer),
    ).rejects.toBeInstanceOf(PromptsHydrateFailed);
  });
});

describe("genesis — the ctx.store facet (ADR 91/93)", () => {
  it("the hydrator receives the definition's own store plus session identity", async () => {
    const store = new InMemoryPromptStore();
    let seen: { store?: unknown; sessionId?: string; hasLog?: boolean; hasRun?: boolean } = {};
    const h = await harness({
      store,
      hydrate: async (ctx) => {
        seen = {
          store: ctx.store,
          sessionId: ctx.sessionId,
          hasLog: typeof ctx.log === "function",
          hasRun: typeof ctx.run === "function",
        };
        return [];
      },
    });
    await h.hydrate();
    expect(seen.store).toBe(store);
    expect(seen.sessionId).toBe(h.id);
    expect(seen.hasLog).toBe(true);
    expect(seen.hasRun).toBe(true);
    await h.close();
  });

  it("carries the journal's READ slice, so an event-sourced catalog is writable", async () => {
    let reader: unknown;
    const h = await harness({
      hydrate: async (ctx) => {
        reader = (ctx as { journalReader?: unknown }).journalReader;
        return [];
      },
    });
    await h.hydrate();
    expect(typeof (reader as { readByQuery?: unknown } | undefined)?.readByQuery).toBe("function");
    await h.close();
  });

  it("exposes `principal` — the per-tenant-catalog seam", async () => {
    const seen: (string | undefined)[] = [];
    const h = await harness({
      principal: "tenant-a",
      hydrate: async (ctx) => {
        seen.push(ctx.principal);
        return ctx.principal === "tenant-a" ? [prompt("premium")] : [];
      },
    });
    await h.hydrate();
    expect(seen).toEqual(["tenant-a"]);
    expect(h.list().map((d) => d.name)).toEqual(["premium"]);
    await h.close();
  });
});

describe("genesis hydrate is NOT the checkpoint contract", () => {
  it("the harness is not CheckpointCapable — one `persist` away from silent enrollment", async () => {
    // The session's checkpoint fold is feature-detected on `persist` + `hydrate`
    // TOGETHER, and this `hydrate` is GENESIS: it re-seeds from the SOURCE.
    // Adding a `persist` here enrolls the harness without another line of code,
    // and every `session.restore()` would then re-run genesis over live state
    // (skills' "second hydrate RESTAMPS" pins the same hazard). If prompts ever
    // persists, the checkpoint contract has to be implemented deliberately.
    const h = await harness({ hydrate: hydrateFrom([prompt("p")]) });
    expect(isCheckpointCapable(h)).toBe(false);
    await h.close();
  });
});

describe("definition hooks:/guards: — drop-layer keys reach the discriminated ops", () => {
  it("hooks: { onBeforeRegister } fires on prompts:register", async () => {
    const seen: string[] = [];
    const h = await harness(
      definePrompts({
        hooks: {
          onBeforeRegister: (input) => {
            seen.push(`before:${input.declaration.name}`);
          },
          onAfterRegister: () => {
            seen.push("after");
          },
        },
      }),
    );
    await h.register(prompt("a"));
    expect(seen).toEqual(["before:a", "after"]);
    await h.close();
  });

  it("guards: { invoke } can VETO an invoke", async () => {
    const h = await harness(
      definePrompts({
        guards: {
          invoke: (input) =>
            input.name === "blocked" ? { kind: "veto", reason: "blocked prompt" } : undefined,
        },
      }),
    );
    await h.register(prompt("allowed"));
    await h.register(prompt("blocked"));
    await expect(h.invoke({ name: "allowed" })).resolves.toMatchObject({
      description: "allowed description",
    });
    await expect(h.invoke({ name: "blocked" })).rejects.toMatchObject({
      outcome: "vetoed",
      terminal: { outcome: "vetoed", reason: "blocked prompt" },
    });
    await h.close();
  });
});

describe("cascade ORDER — app wraps definition (ADR 93 §Guards on configs)", () => {
  function appTier(
    hooks: Parameters<typeof hooksToMiddlewares>[0],
    guards: Parameters<typeof guardsToMiddlewares>[0],
  ): readonly Middleware<unknown, unknown, unknown>[] {
    return [...guardsToMiddlewares(guards), ...hooksToMiddlewares(hooks)];
  }

  it("an APP guard vetoes before a DEFINITION guard is consulted", async () => {
    const order: string[] = [];
    const h = await harness({
      inheritedInterceptors: appTier(
        {},
        {
          promptsRegister: () => {
            order.push("app-guard");
            return { kind: "veto", reason: "app says no" };
          },
        },
      ),
      guards: {
        register: () => {
          order.push("definition-guard");
          return undefined;
        },
      },
    });
    await expect(h.register(prompt("a"))).rejects.toMatchObject({
      outcome: "vetoed",
      terminal: { reason: "app says no" },
    });
    expect(order).toEqual(["app-guard"]);
    expect(h.list()).toEqual([]);
    await h.close();
  });

  it("an APP before-hook wraps a DEFINITION before-hook; afters unwind in reverse", async () => {
    const order: string[] = [];
    const h = await harness({
      inheritedInterceptors: appTier(
        {
          onBeforePromptsRegister: () => {
            order.push("app-before");
          },
          onAfterPromptsRegister: () => {
            order.push("app-after");
          },
        },
        {},
      ),
      hooks: {
        onBeforeRegister: () => {
          order.push("definition-before");
        },
        onAfterRegister: () => {
          order.push("definition-after");
        },
      },
    });
    await h.register(prompt("a"));
    expect(order).toEqual(["app-before", "definition-before", "definition-after", "app-after"]);
    await h.close();
  });

  it("the TOTAL order is app guards → definition guards → app before → definition before → body", async () => {
    const order: string[] = [];
    const h = await harness({
      inheritedInterceptors: appTier(
        {
          onBeforePromptsRegister: () => {
            order.push("app-before");
          },
        },
        {
          promptsRegister: () => {
            order.push("app-guard");
            return undefined;
          },
        },
      ),
      hooks: {
        onBeforeRegister: () => {
          order.push("definition-before");
        },
      },
      guards: {
        register: () => {
          order.push("definition-guard");
          return undefined;
        },
      },
    });
    await h.register(prompt("a"));
    expect(order).toEqual(["app-guard", "definition-guard", "app-before", "definition-before"]);
    await h.close();
  });
});

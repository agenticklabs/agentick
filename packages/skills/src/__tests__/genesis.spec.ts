/**
 * ADR 93 — the GENESIS laws for skills, plus the interceptor-cascade ORDER the
 * `hooks:` / `guards:` bags desugar into.
 *
 * Laws pinned here (ADR 93 landmines 1, 2, 3 and the cascade-order gate):
 *   - genesis output is SEED — no `skills:register` op, no store write
 *     (landmine 3);
 *   - a throwing hydrator surfaces `SkillsHydrateFailed` with nothing
 *     half-installed (landmine 2);
 *   - FORK / SPAWN-inherit never re-runs genesis (landmine 1) — a child that
 *     inherits its parent's image is restored, not re-hydrated;
 *   - a definition's `hooks:` / `guards:` bags use DROP-LAYER keys and land on
 *     the same ops the discriminated app-level names reach;
 *   - APP-level interceptors wrap DEFINITION-level ones: app guards veto before a
 *     definition guard runs, app before-hooks run first, afters unwind in reverse
 *     ("governance outranks local policy").
 */

import { describe, expect, it } from "vitest";
import {
  guardsToMiddlewares,
  hooksToMiddlewares,
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  ulid,
  type Middleware,
} from "@agentick/runtime";
import { SkillsHydrateFailed } from "@agentick/spec";
import type { CollectionMutation, Skill, SkillStoreQuery, Store } from "@agentick/spec";

import { SkillsHarness, type SkillsHarnessOptions } from "../harness.js";
import { defineSkills } from "../definition.js";
import { hydrateFrom, hydrateFromStore } from "../hydrators.js";
import { InMemorySkillStore } from "../store.js";

async function harness(options: SkillsHarnessOptions = {}): Promise<SkillsHarness> {
  const h = new SkillsHarness(
    `skills-genesis-${ulid()}`,
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
  store: Store<Skill, SkillStoreQuery, CollectionMutation<Skill>>;
  mutations: CollectionMutation<Skill>[];
} {
  const mutations: CollectionMutation<Skill>[] = [];
  const inner = new InMemorySkillStore();
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

const skill = (name: string): { name: string; description: string; content: string } => ({
  name,
  description: `${name} description`,
  content: `${name} body`,
});

describe("genesis — the seed law (ADR 93 landmine 3)", () => {
  it("seeded skills never reach the store's mutate", async () => {
    const { store, mutations } = spyStore();
    const h = await harness({ store, hydrate: hydrateFrom([skill("g1"), skill("g2")]) });

    await h.hydrate();
    expect(h.list().map((s) => s.name)).toEqual(["g1", "g2"]);
    expect(mutations).toEqual([]);

    // A real register still writes through — genesis is the ONLY exemption.
    await h.register(skill("live"));
    expect(mutations).toHaveLength(1);
    await h.close();
  });

  it("seeded skills produce no `skills:register` op", async () => {
    // The op path is observable through its own interceptors: if genesis went
    // through `skills:register`, the register hook would fire. It must not — the
    // seed is an adoption into the read view, not a command.
    const fired: string[] = [];
    const h = await harness({
      hydrate: hydrateFrom([skill("g1")]),
      hooks: {
        onBeforeRegister: (input) => {
          fired.push(input.name);
        },
      },
    });
    await h.hydrate();
    expect(fired).toEqual([]);
    // But the skill IS there, readable synchronously by the first render.
    expect(h.has("g1")).toBe(true);
    // A real register does fire it, so the assertion above is not vacuous.
    await h.register(skill("live"));
    expect(fired).toEqual(["live"]);
    await h.close();
  });

  it("preserves timestamps a seed carries, defaults the ones it does not", async () => {
    const h = await harness({
      hydrate: async () => [
        { ...skill("replayed"), createdAt: 1000, updatedAt: 2000 },
        skill("fresh"),
      ],
    });
    await h.hydrate();
    expect(h.get("replayed")).toMatchObject({ createdAt: 1000, updatedAt: 2000 });
    expect(h.get("fresh")!.createdAt).toBeGreaterThan(2000);
    await h.close();
  });

  it("no hydrator ⇒ genesis is a no-op (the zero-cost default)", async () => {
    const h = await harness();
    await h.hydrate();
    expect(h.list()).toEqual([]);
    await h.close();
  });

  it("a `store` WITHOUT a hydrator loads nothing — skills names no default", async () => {
    const store = new InMemorySkillStore();
    await store.mutate({ put: { ...skill("durable"), createdAt: 1, updatedAt: 1 } }, {} as never);
    const h = await harness({ store });
    await h.hydrate();
    expect(h.list()).toEqual([]);
    // Ask for it and it is there — the seam, not a setting.
    const asked = await harness({ store, hydrate: hydrateFromStore() });
    await asked.hydrate();
    expect(asked.list().map((s) => s.name)).toEqual(["durable"]);
    await h.close();
    await asked.close();
  });

  it("a seeded library pings its subscribers so the first render sees it", async () => {
    const h = await harness({ hydrate: hydrateFrom([skill("g1")]) });
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
  it("a throwing hydrator rejects with SkillsHydrateFailed carrying the cause", async () => {
    const boom = new Error("tier catalog unreachable");
    const h = await harness({ hydrate: () => Promise.reject(boom) });
    await expect(h.hydrate()).rejects.toBeInstanceOf(SkillsHydrateFailed);
    await expect(h.hydrate()).rejects.toMatchObject({ cause: boom });
    // Nothing was installed — no half-genesis library.
    expect(h.list()).toEqual([]);
    await h.close();
  });

  it("an already-typed failure is not double-wrapped", async () => {
    const typed = new SkillsHydrateFailed({ cause: "inner" });
    const h = await harness({ hydrate: () => Promise.reject(typed) });
    await expect(h.hydrate()).rejects.toBe(typed);
    await h.close();
  });

  it("the failure propagates out of the extension install, so session creation fails", async () => {
    const { withSkills } = await import("../extension.js");
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
      withSkills({ hydrate: () => Promise.reject(new Error("nope")) }).install(installer),
    ).rejects.toBeInstanceOf(SkillsHydrateFailed);
  });
});

describe("genesis — the ctx.store facet (ADR 91/93)", () => {
  it("the hydrator receives the definition's own store plus session identity", async () => {
    const store = new InMemorySkillStore();
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
    // The derived ctx is not a bare bag — the ADR-91 facets are there.
    expect(seen.hasLog).toBe(true);
    expect(seen.hasRun).toBe(true);
    await h.close();
  });

  it("the ctx is also a StoreCtx — a hydrator hands it straight to the store", async () => {
    const store = new InMemorySkillStore();
    await store.mutate({ put: { ...skill("durable"), createdAt: 1, updatedAt: 1 } }, {} as never);
    const h = await harness({ store, hydrate: (ctx) => ctx.store.query(undefined, ctx) });
    await h.hydrate();
    expect(h.list().map((s) => s.name)).toEqual(["durable"]);
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

  it("exposes `principal` — the tiered-catalog seam", async () => {
    const seen: (string | undefined)[] = [];
    const h = new SkillsHarness(
      `skills-genesis-${ulid()}`,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      {
        principal: "tenant-a",
        hydrate: async (ctx) => {
          seen.push(ctx.principal);
          return ctx.principal === "tenant-a" ? [skill("premium")] : [];
        },
      },
    );
    await h.ready;
    await h.hydrate();
    expect(seen).toEqual(["tenant-a"]);
    expect(h.list().map((s) => s.name)).toEqual(["premium"]);
    await h.close();
  });
});

describe("genesis — fork / spawn never re-runs it (ADR 93 landmine 1)", () => {
  it("a child seeded from the parent's IMAGE is restored, not re-hydrated", async () => {
    let hydratorRuns = 0;
    const definition = defineSkills({
      hydrate: async () => {
        hydratorRuns += 1;
        return [skill("from-source")];
      },
    });

    const parent = await harness(definition);
    await parent.hydrate();
    expect(hydratorRuns).toBe(1);
    await parent.register(skill("added-live"));

    // A fork inherits the parent's image. The child harness is constructed from
    // the SAME definition — the genesis-vs-restore choice belongs to the layer
    // that knows lineage, so a fork imports the snapshot and never calls
    // `hydrate()`.
    const child = await harness(definition);
    child.importSnapshot(parent.exportSnapshot());

    expect(hydratorRuns).toBe(1);
    expect(child.list().map((s) => s.name)).toEqual(["added-live", "from-source"]);
    await parent.close();
    await child.close();
  });

  it("a re-hydrated child would DUPLICATE nothing but would restamp — which is why it must not run", async () => {
    // Genesis is idempotent by KEY (the view is keyed by name), so the harm of a
    // double genesis is divergence, not duplication: a fork's inherited live
    // edits would be silently overwritten by the source. Pin that the seed does
    // overwrite, so the fork law is load-bearing rather than decorative.
    const h = await harness({ hydrate: hydrateFrom([{ ...skill("x"), content: "FROM-SOURCE" }]) });
    await h.hydrate();
    await h.update({ name: "x", content: "EDITED-LIVE" });
    expect(h.get("x")!.content).toBe("EDITED-LIVE");
    await h.hydrate();
    expect(h.get("x")!.content).toBe("FROM-SOURCE");
    await h.close();
  });
});

describe("definition hooks:/guards: — drop-layer keys reach the discriminated ops", () => {
  it("hooks: { onBeforeRegister } fires on skills:register", async () => {
    const seen: string[] = [];
    const h = await harness(
      defineSkills({
        hooks: {
          onBeforeRegister: (input) => {
            seen.push(`before:${input.name}`);
          },
          onAfterRegister: () => {
            seen.push("after");
          },
        },
      }),
    );
    await h.register(skill("a"));
    expect(seen).toEqual(["before:a", "after"]);
    await h.close();
  });

  it("guards: { register } can VETO a register", async () => {
    const h = await harness(
      defineSkills({
        guards: {
          register: (input) =>
            input.name.startsWith("_") ? { kind: "veto", reason: "reserved prefix" } : undefined,
        },
      }),
    );
    await h.register(skill("allowed"));
    expect(h.has("allowed")).toBe(true);
    await expect(h.register(skill("_internal"))).rejects.toMatchObject({
      outcome: "vetoed",
      terminal: { outcome: "vetoed", reason: "reserved prefix" },
    });
    expect(h.has("_internal")).toBe(false);
    await h.close();
  });

  it("a definition guard does NOT gate genesis — the seed bypasses the ops", async () => {
    // Deliberate: genesis is not a register, so a register guard has nothing to
    // decide about it. Admission policy over the SOURCE belongs in the hydrator.
    const h = await harness(
      defineSkills({
        hydrate: hydrateFrom([skill("_seeded")]),
        guards: { register: () => ({ kind: "veto", reason: "no registers at all" }) },
      }),
    );
    await h.hydrate();
    expect(h.has("_seeded")).toBe(true);
    await h.close();
  });
});

describe("cascade ORDER — app wraps definition (ADR 93 §Guards on configs)", () => {
  /**
   * The app tier is modelled the way the real app does it: its declarative bags
   * are adapted to op-scoped middleware and handed down as
   * `inheritedInterceptors` (the construction fold). The definition's bags
   * register on the harness's OWN chain. `resolvedInterceptors()` orders
   * inherited-before-own, and `orderInterceptors` floats guards outermost with a
   * STABLE sort — so the tier order survives inside each kind.
   */
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
          skillsRegister: () => {
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
    await expect(h.register(skill("a"))).rejects.toMatchObject({
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
          onBeforeSkillsRegister: () => {
            order.push("app-before");
          },
          onAfterSkillsRegister: () => {
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
    await h.register(skill("a"));
    expect(order).toEqual(["app-before", "definition-before", "definition-after", "app-after"]);
    await h.close();
  });

  it("the TOTAL order is app guards → definition guards → app before → definition before → body", async () => {
    const order: string[] = [];
    const h = await harness({
      inheritedInterceptors: appTier(
        {
          onBeforeSkillsRegister: () => {
            order.push("app-before");
          },
        },
        {
          skillsRegister: () => {
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
    await h.register(skill("a"));
    expect(order).toEqual(["app-guard", "definition-guard", "app-before", "definition-before"]);
    await h.close();
  });
});

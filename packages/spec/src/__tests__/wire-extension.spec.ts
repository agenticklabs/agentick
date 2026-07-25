/**
 * `defineWireExtension` validation suite — ADR 46 Phase A.
 *
 * Pins:
 *   - Type-level: method names typed against `WireMethods`; notifications
 *     against `WireNotifications`. Both index-signature-constrained on
 *     the WireExtension shape.
 *   - Runtime: defineWireExtension catches namespace prefix mismatches,
 *     missing namespace, "/" in namespace, auth/clusterRoute referencing
 *     undeclared methods, empty extensions.
 *
 * @see docs/proposals/v2/blueprint/46-wire-extensions.md
 */

import { describe, expect, it } from "vitest";

import {
  defineWireExtension,
  WireExtensionDefinitionError,
  type WireExtension,
  type WireMiddleware,
} from "../wire/extension.js";

// Set up a test extension declaration that ALL tests reference. The
// type-level alignment requires us to declare-merge method names into
// WireMethods at the test boundary. We use the existing `ping` method
// (already in WireMethods) for the happy-path tests; rejection tests
// type the WireExtension as a loose value to exercise the validator.

describe("defineWireExtension — happy path", () => {
  it("accepts a minimal extension with one method", () => {
    const ext = defineWireExtension({
      name: "test:minimal",
      namespace: "gateway",
      methods: {
        "gateway/list_apps": async () => ({ apps: [] }),
      },
    });

    expect(ext.name).toBe("test:minimal");
    expect(ext.namespace).toBe("gateway");
    expect(Object.keys(ext.methods)).toEqual(["gateway/list_apps"]);
  });

  it("accepts version + auth + clusterRoute", () => {
    const ext = defineWireExtension({
      name: "test:full",
      namespace: "gateway",
      version: "1.2.3",
      methods: {
        "gateway/list_apps": async () => ({ apps: [] }),
      },
      auth: {
        "gateway/list_apps": { required: false },
      },
      clusterRoute: {
        "gateway/list_apps": "any",
      },
    });

    expect(ext.version).toBe("1.2.3");
    expect(ext.auth?.["gateway/list_apps"]?.required).toBe(false);
    expect(ext.clusterRoute?.["gateway/list_apps"]).toBe("any");
  });
});

describe("defineWireExtension — rejection: namespace", () => {
  it("rejects empty namespace", () => {
    expect(() =>
      defineWireExtension({
        name: "test:empty-ns",
        namespace: "",
        methods: { "gateway/list_apps": async () => ({ apps: [] }) },
      } as WireExtension),
    ).toThrow(WireExtensionDefinitionError);
  });

  it("rejects namespace containing /", () => {
    expect(() =>
      defineWireExtension({
        name: "test:slash-ns",
        namespace: "gateway/sub",
        methods: { "gateway/list_apps": async () => ({ apps: [] }) },
      } as WireExtension),
    ).toThrow(/MUST NOT contain "\/"/);
  });
});

describe("defineWireExtension — rejection: method name prefix", () => {
  it("rejects a method whose name doesn't start with the namespace", () => {
    expect(() =>
      defineWireExtension({
        name: "test:bad-prefix",
        namespace: "gateway",
        methods: {
          // `subscribe` is in WireMethods but not under the `gateway/` prefix.
          subscribe: async () => ({ subscriptionId: "x" }),
        } as Partial<WireExtension["methods"]>,
      } as WireExtension),
    ).toThrow(/must start with the declared namespace prefix "gateway\/"/);
  });
});

describe("defineWireExtension — rejection: empty methods", () => {
  it("rejects extension with no method handlers", () => {
    expect(() =>
      defineWireExtension({
        name: "test:no-methods",
        namespace: "gateway",
        methods: {},
      } as WireExtension),
    ).toThrow(/no methods/);
  });
});

describe("defineWireExtension — rejection: auth references unknown method", () => {
  it("rejects auth entry whose method isn't in `methods`", () => {
    expect(() =>
      defineWireExtension({
        name: "test:stray-auth",
        namespace: "gateway",
        methods: {
          "gateway/list_apps": async () => ({ apps: [] }),
        },
        auth: {
          subscribe: { required: true },
        } as Partial<WireExtension["auth"]>,
      } as WireExtension),
    ).toThrow(/auth.*references method "subscribe"/);
  });
});

describe("defineWireExtension — rejection: clusterRoute references unknown method", () => {
  it("rejects clusterRoute entry whose method isn't in `methods`", () => {
    expect(() =>
      defineWireExtension({
        name: "test:stray-route",
        namespace: "gateway",
        methods: {
          "gateway/list_apps": async () => ({ apps: [] }),
        },
        clusterRoute: {
          subscribe: "leader",
        } as Partial<WireExtension["clusterRoute"]>,
      } as WireExtension),
    ).toThrow(/clusterRoute.*references method "subscribe"/);
  });
});

describe("defineWireExtension — method dichotomy normalization (ADR 90)", () => {
  it("normalizes a rich method config to bare handler + ops + merged auth", () => {
    const mw: WireMiddleware<"gateway/list_apps"> = (p, next) => next(p);
    const ext = defineWireExtension({
      name: "test:rich",
      namespace: "gateway",
      methods: {
        "gateway/list_apps": {
          handler: async () => ({ apps: [] }),
          guard: () => ({ kind: "veto", reason: "nope" }),
          middleware: mw,
          spanAttributes: { "test.tier": "premium" },
          auth: { required: true, scope: "admin" },
        },
      },
    });

    // The stored method is a BARE handler (single internal representation) — the
    // registry + dispatcher only ever see a callable.
    expect(typeof ext.methods["gateway/list_apps"]).toBe("function");
    // The op config is extracted; middleware is normalized to an array.
    expect(ext.ops?.["gateway/list_apps"]?.guard).toBeTypeOf("function");
    expect(ext.ops?.["gateway/list_apps"]?.middleware).toEqual([mw]);
    expect(ext.ops?.["gateway/list_apps"]?.spanAttributes).toEqual({ "test.tier": "premium" });
    // The config's auth merged into the extension auth map (single enforcement point).
    expect(ext.auth?.["gateway/list_apps"]).toEqual({ required: true, scope: "admin" });
  });

  it("leaves a bare-handler method with no op config (shorthand unchanged)", () => {
    const ext = defineWireExtension({
      name: "test:bare",
      namespace: "gateway",
      methods: { "gateway/list_apps": async () => ({ apps: [] }) },
    });
    expect(typeof ext.methods["gateway/list_apps"]).toBe("function");
    expect(ext.ops).toBeUndefined();
  });

  it("accepts a single middleware and normalizes it to a one-element array", () => {
    const mw: WireMiddleware<"gateway/list_apps"> = (p, next) => next(p);
    const ext = defineWireExtension({
      name: "test:single-mw",
      namespace: "gateway",
      methods: {
        "gateway/list_apps": { handler: async () => ({ apps: [] }), middleware: mw },
      },
    });
    expect(ext.ops?.["gateway/list_apps"]?.middleware).toEqual([mw]);
  });
});

describe("defineWireExtension — rejection: auth declared in both sites (ADR 90)", () => {
  it("rejects a method whose `auth` is declared in BOTH the config and the auth map", () => {
    expect(() =>
      defineWireExtension({
        name: "test:double-auth",
        namespace: "gateway",
        methods: {
          "gateway/list_apps": {
            handler: async () => ({ apps: [] }),
            auth: { required: true },
          },
        },
        auth: {
          "gateway/list_apps": { required: false },
        },
      }),
    ).toThrow(WireExtensionDefinitionError);
  });

  it("the conflict message names the method AND both declaration sites", () => {
    try {
      defineWireExtension({
        name: "test:double-auth-msg",
        namespace: "gateway",
        methods: {
          "gateway/list_apps": {
            handler: async () => ({ apps: [] }),
            auth: { required: true },
          },
        },
        auth: { "gateway/list_apps": { required: false } },
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WireExtensionDefinitionError);
      const msg = (err as Error).message;
      // Names the method…
      expect(msg).toMatch(/gateway\/list_apps/);
      // …and both sites (the method config AND the auth map)…
      expect(msg).toMatch(/method config/);
      expect(msg).toMatch(/auth.*map/);
      // …and the extension it came from.
      expect((err as WireExtensionDefinitionError).extensionName).toBe("test:double-auth-msg");
    }
  });
});

describe("defineWireExtension — error shape", () => {
  it("WireExtensionDefinitionError carries extension name + message", () => {
    try {
      defineWireExtension({
        name: "test:err-shape",
        namespace: "",
        methods: { "gateway/list_apps": async () => ({ apps: [] }) },
      } as WireExtension);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WireExtensionDefinitionError);
      expect((err as WireExtensionDefinitionError).extensionName).toBe("test:err-shape");
      expect((err as Error).message).toMatch(/test:err-shape/);
    }
  });
});

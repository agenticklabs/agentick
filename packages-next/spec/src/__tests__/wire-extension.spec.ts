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

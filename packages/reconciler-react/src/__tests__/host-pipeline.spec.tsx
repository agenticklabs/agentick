import { describe, expect, it } from "vitest";
import React, { useState } from "react";
import { createContainer } from "@agentick/reconciler";
import {
  createElementInstance,
  isElementInstance,
  isTextInstance,
  type ElementInstance,
  type HostInstance,
} from "@agentick/reconciler";
import {
  createHostScope,
  resolveFormatter,
  rootScope,
  withFormatter,
  withPath,
} from "@agentick/reconciler";
import { createReconciler } from "../react/reconciler.js";
import { flush } from "../testing/flush.js";

describe("host-pipeline — host layer only", () => {
  it("createHostScope seeds a default formatter", () => {
    const scope = createHostScope({ formatter: { id: "markdown" } });
    expect(scope.formatters.default.id).toBe("markdown");
    expect(scope.path).toEqual([]);
  });

  it("withFormatter is immutable (returns a new scope)", () => {
    const a = createHostScope({ formatter: { id: "markdown" } });
    const b = withFormatter(a, { formatter: { id: "xml" } });
    expect(a.formatters.default.id).toBe("markdown");
    expect(b.formatters.default.id).toBe("xml");
    expect(a).not.toBe(b);
  });

  it("withFormatter scoped by purpose only overrides that purpose", () => {
    const a = createHostScope({ formatter: { id: "markdown" } });
    const b = withFormatter(a, { formatter: { id: "xml" }, purpose: "section" });
    expect(resolveFormatter(b, "section").id).toBe("xml");
    expect(resolveFormatter(b, "message").id).toBe("markdown");
    expect(resolveFormatter(b).id).toBe("markdown");
  });

  it("withPath extends ancestry", () => {
    const a = withPath(rootScope, "section.todo");
    const b = withPath(a, "list.0");
    expect(b.path).toEqual(["section.todo", "list.0"]);
  });

  it("createElementInstance strips reserved props", () => {
    const inst = createElementInstance(
      "section",
      { id: "s1", key: "k", children: "ignored" } as Record<string, unknown>,
      rootScope,
    );
    expect(inst.props).toEqual({ id: "s1" });
    expect("key" in inst.props).toBe(false);
    expect("children" in inst.props).toBe(false);
  });

  it("host instances carry stable hostIds", () => {
    const a = createElementInstance("section", { id: "1" }, rootScope);
    const b = createElementInstance("section", { id: "1" }, rootScope);
    expect(a.hostId).not.toBe(b.hostId);
  });
});

describe("host-pipeline — react-reconciler end-to-end", () => {
  it("mounts a flat tree of intrinsics", () => {
    const container = createContainer({
      mountId: "m_1",
      rootScope: createHostScope({ formatter: { id: "markdown" } }),
    });
    const reconciler = createReconciler({ container, idPrefix: "m_1" });
    const root = reconciler.createRoot();

    reconciler.render(
      <>
        {React.createElement("section", { id: "s.greeting" }, "Hello world")}
        {React.createElement("message", { role: "user" }, "Hi there")}
      </>,
      root,
    );

    expect(container.children).toHaveLength(2);
    const [section, message] = container.children;
    expect(isElementInstance(section!)).toBe(true);
    expect(isElementInstance(message!)).toBe(true);
    if (isElementInstance(section!)) {
      expect(section.type).toBe("section");
      expect(section.props).toEqual({ id: "s.greeting" });
      expect(section.children).toHaveLength(1);
      const child = section.children[0]!;
      expect(isTextInstance(child)).toBe(true);
      if (isTextInstance(child)) expect(child.text).toBe("Hello world");
    }
  });

  it("renders function components and propagates props", () => {
    const container = createContainer({ mountId: "m_2" });
    const reconciler = createReconciler({ container, idPrefix: "m_2" });
    const root = reconciler.createRoot();

    function Greeting({ name }: { name: string }) {
      return React.createElement("message", { role: "user" }, `Hello, ${name}`);
    }
    reconciler.render(React.createElement(Greeting, { name: "Ryan" }), root);

    expect(container.children).toHaveLength(1);
    const msg = container.children[0]!;
    if (isElementInstance(msg)) {
      expect(msg.type).toBe("message");
      expect(msg.props).toEqual({ role: "user" });
      const text = msg.children[0]!;
      if (isTextInstance(text)) expect(text.text).toBe("Hello, Ryan");
    }
  });

  it("propagates external setState through React's scheduler with flush", async () => {
    const container = createContainer({ mountId: "m_state" });
    const reconciler = createReconciler({ container, idPrefix: "m_state" });
    const root = reconciler.createRoot();

    let setValue: ((v: number) => void) | null = null;
    function Counter() {
      const [v, setV] = useState(0);
      setValue = setV;
      return React.createElement("section", { id: "s.count" }, `value=${v}`);
    }
    reconciler.render(React.createElement(Counter), root);
    await flush();

    const textOf = (n: HostInstance | undefined) =>
      n && isElementInstance(n) && isTextInstance(n.children[0]!)
        ? (n.children[0] as { text: string }).text
        : "";
    expect(textOf(container.children[0])).toBe("value=0");

    setValue!(42);
    await flush();
    expect(textOf(container.children[0])).toBe("value=42");
  });

  it("commits updates when props change between renders", () => {
    const container = createContainer({ mountId: "m_3" });
    const reconciler = createReconciler({ container, idPrefix: "m_3" });
    const root = reconciler.createRoot();

    function View({ value }: { value: number }) {
      return React.createElement("section", { id: "s.count" }, `value=${value}`);
    }
    reconciler.render(React.createElement(View, { value: 0 }), root);

    const textOf = (n: HostInstance | undefined) =>
      n && isElementInstance(n) && isTextInstance(n.children[0]!)
        ? (n.children[0] as { text: string }).text
        : "";
    expect(textOf(container.children[0])).toBe("value=0");

    reconciler.render(React.createElement(View, { value: 42 }), root);
    expect(textOf(container.children[0])).toBe("value=42");
  });

  it("removes children when count shrinks across renders", () => {
    const container = createContainer({ mountId: "m_4" });
    const reconciler = createReconciler({ container, idPrefix: "m_4" });
    const root = reconciler.createRoot();

    function List({ items }: { items: readonly string[] }) {
      return React.createElement(
        React.Fragment,
        null,
        ...items.map((id) => React.createElement("message", { key: id, role: id }, id)),
      );
    }

    reconciler.render(React.createElement(List, { items: ["a", "b", "c"] }), root);
    const idsOf = () =>
      container.children
        .filter(isElementInstance)
        .map((c: ElementInstance) => (c.props as { role: string }).role);
    expect(idsOf()).toEqual(["a", "b", "c"]);

    reconciler.render(React.createElement(List, { items: ["a"] }), root);
    expect(idsOf()).toEqual(["a"]);
  });

  it("reorders keyed children without duplicating (within a parent element)", () => {
    const container = createContainer({ mountId: "m_reorder" });
    const reconciler = createReconciler({ container, idPrefix: "m_reorder" });
    const root = reconciler.createRoot();

    function List({ items }: { items: readonly string[] }) {
      return React.createElement(
        "section",
        { id: "s.list" },
        ...items.map((id) => React.createElement("message", { key: id, role: id }, id)),
      );
    }

    reconciler.render(React.createElement(List, { items: ["a", "b", "c"] }), root);
    const section = container.children[0]! as ElementInstance;
    const idsOf = () =>
      section.children
        .filter(isElementInstance)
        .map((c: ElementInstance) => (c.props as { role: string }).role);
    expect(idsOf()).toEqual(["a", "b", "c"]);

    reconciler.render(React.createElement(List, { items: ["c", "a"] }), root);
    expect(idsOf()).toEqual(["c", "a"]);
    expect(section.children).toHaveLength(2);

    reconciler.render(React.createElement(List, { items: ["b", "c", "a"] }), root);
    expect(idsOf()).toEqual(["b", "c", "a"]);
    expect(section.children).toHaveLength(3);
  });

  it("preserves component identity (hostId) across re-renders with same key", () => {
    const container = createContainer({ mountId: "m_5" });
    const reconciler = createReconciler({ container, idPrefix: "m_5" });
    const root = reconciler.createRoot();

    function App({ label }: { label: string }) {
      return React.createElement("message", { key: "stable", role: "user" }, label);
    }
    reconciler.render(React.createElement(App, { label: "hi" }), root);
    const firstId = container.children[0]!.hostId;

    reconciler.render(React.createElement(App, { label: "hello" }), root);
    const secondId = container.children[0]!.hostId;

    expect(firstId).toBe(secondId);
  });
});

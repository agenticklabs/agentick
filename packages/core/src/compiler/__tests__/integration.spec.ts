/**
 * Integration Tests for Compiler
 *
 * Tests that verify the compiler works end-to-end with real components.
 */

import { FiberCompiler } from "../fiber-compiler";
import { COM } from "../../com/object-model";
import type { TickState } from "../../component/component";
import { Component } from "../../component/component";
import { Section, Message, Timeline, ModelOptions } from "../../jsx/components/primitives";
import { StructureRenderer } from "../structure-renderer";
import { MarkdownRenderer } from "../../renderers";
import { Text } from "../../jsx/components/content";
import { createElement } from "../../jsx/jsx-runtime";
import {
  useState,
  useComState,
  useTickStart,
  useTickEnd,
  useOnMount,
  useEffect,
} from "../../state/hooks";

describe("Compiler Integration", () => {
  let com: COM;
  let compiler: FiberCompiler;
  let tickState: TickState;

  beforeEach(() => {
    com = new COM();
    compiler = new FiberCompiler(com);
    tickState = {
      tick: 1,
      stop: vi.fn(),
      queuedMessages: [],
      current: {
        timeline: [],
      },
    } as TickState;
  });

  describe("Mixed Function and Class Components", () => {
    it("should compile mixed component tree", async () => {
      function FunctionWrapper(props: { children: any }) {
        return createElement(Section, { id: "wrapper" }, props.children);
      }

      class ClassContent extends Component {
        render() {
          return createElement(Text, {}, "Class content");
        }
      }

      const element = createElement(FunctionWrapper, {}, createElement(ClassContent, {}));

      const result = await compiler.compile(element, tickState);

      expect(result.sections.has("wrapper")).toBe(true);
    });
  });

  describe("State Management", () => {
    it("should handle state updates across renders", async () => {
      function Counter() {
        const [count, setCount] = useState(0);

        useEffect(() => {
          if (count < 2) {
            setCount((c) => c + 1);
            com.requestRecompile("increment");
          }
        }, [count]);

        return createElement(Section, { id: "counter" }, `Count: ${count}`);
      }

      const element = createElement(Counter, {});
      const result = await compiler.compileUntilStable(element, tickState);

      expect(result.iterations).toBeGreaterThan(1);
    });

    it("should sync COM state between components", async () => {
      function Writer() {
        const data = useComState("shared", "");

        useTickStart(() => {
          data.set("written");
        });

        return null;
      }

      function Reader() {
        const data = useComState("shared", "");
        return createElement(Section, { id: "reader" }, data());
      }

      const element = createElement(
        "div",
        {},
        createElement(Writer, {}),
        createElement(Reader, {}),
      );

      await compiler.compile(element, tickState);
      await compiler.notifyTickStart(tickState);

      const data = com.getState("shared");
      expect(data).toBe("written");
    });
  });

  describe("Lifecycle Integration", () => {
    it("should run lifecycle hooks in correct order", async () => {
      const order: string[] = [];

      function LifecycleComponent() {
        useOnMount(() => {
          order.push("mount");
        });

        useTickStart(() => {
          order.push("tick-start");
        });

        useTickEnd(() => {
          order.push("tick-end");
        });

        return createElement(Section, { id: "lifecycle" });
      }

      const element = createElement(LifecycleComponent, {});
      await compiler.compile(element, tickState);

      // Mount effects run during commit
      expect(order).toContain("mount");

      await compiler.notifyTickStart(tickState);
      expect(order).toContain("tick-start");

      await compiler.notifyTickEnd(tickState);
      expect(order).toContain("tick-end");
    });

    it("should handle class component lifecycle", async () => {
      const order: string[] = [];

      class LifecycleComponent extends Component {
        onMount = () => {
          order.push("class-mount");
        };
        onTickStart = () => {
          order.push("class-tick-start");
        };
        onTickEnd = () => {
          order.push("class-tick-end");
        };

        render() {
          return createElement(Section, { id: "class-lifecycle" });
        }
      }

      const element = createElement(LifecycleComponent, {});
      await compiler.compile(element, tickState);

      expect(order).toContain("class-mount");

      await compiler.notifyTickStart(tickState);
      expect(order).toContain("class-tick-start");

      await compiler.notifyTickEnd(tickState);
      expect(order).toContain("class-tick-end");
    });
  });

  describe("Content Collection", () => {
    it("should collect timeline entries", async () => {
      function Chat() {
        return createElement(
          Timeline,
          {},
          createElement(Message, { role: "user" }, "Hello"),
          createElement(Message, { role: "assistant" }, "Hi there"),
        );
      }

      const element = createElement(Chat, {});
      const result = await compiler.compile(element, tickState);

      expect(result.timelineEntries.length).toBe(2);
      expect(result.timelineEntries[0].message?.role).toBe("user");
      expect(result.timelineEntries[1].message?.role).toBe("assistant");
    });

    it("should collect sections", async () => {
      function MultiSection() {
        return createElement(
          "div",
          {},
          createElement(Section, { id: "a" }, "Section A"),
          createElement(Section, { id: "b" }, "Section B"),
        );
      }

      const element = createElement(MultiSection, {});
      const result = await compiler.compile(element, tickState);

      expect(result.sections.size).toBe(2);
      expect(result.sections.has("a")).toBe(true);
      expect(result.sections.has("b")).toBe(true);
    });
  });

  describe("Error Handling", () => {
    it("should handle component render errors gracefully", async () => {
      function ErrorComponent() {
        throw new Error("Render error");
      }

      const element = createElement(ErrorComponent, {});

      await expect(compiler.compile(element, tickState)).rejects.toThrow("Render error");
    });

    it("should handle effect errors", async () => {
      function ErrorEffect() {
        useEffect(() => {
          throw new Error("Effect error");
        }, []);

        return createElement(Section, { id: "error" });
      }

      const element = createElement(ErrorEffect, {});

      // Should compile but effect error might be caught
      await compiler.compile(element, tickState);
    });
  });

  describe("Unmounting", () => {
    it("should cleanup all resources on unmount", async () => {
      const cleanupSpy = vi.fn();

      function CleanupComponent() {
        useEffect(() => {
          return cleanupSpy;
        }, []);

        return createElement(Section, { id: "cleanup" });
      }

      const element = createElement(CleanupComponent, {});
      await compiler.compile(element, tickState);

      await compiler.unmount();

      expect(cleanupSpy).toHaveBeenCalled();
    });

    it("should unmount class components", async () => {
      const unmountSpy = vi.fn();

      class UnmountComponent extends Component {
        onUnmount = unmountSpy;

        render() {
          return createElement(Section, { id: "unmount" });
        }
      }

      const element = createElement(UnmountComponent, {});
      await compiler.compile(element, tickState);

      await compiler.unmount();

      expect(unmountSpy).toHaveBeenCalled();
    });
  });

  describe("Reconciliation", () => {
    it("should reuse fibers when possible", async () => {
      function ListItem(props: { id: string }) {
        return createElement(Section, { id: props.id });
      }

      const element1 = createElement(
        "div",
        {},
        createElement(ListItem, { id: "a", key: "a" }),
        createElement(ListItem, { id: "b", key: "b" }),
      );

      await compiler.compile(element1, tickState);

      const element2 = createElement(
        "div",
        {},
        createElement(ListItem, { id: "a", key: "a" }),
        createElement(ListItem, { id: "b", key: "b" }),
      );

      const result = await compiler.compile(element2, tickState);

      expect(result.sections.has("a")).toBe(true);
      expect(result.sections.has("b")).toBe(true);
    });

    it("should handle key changes", async () => {
      function Item(props: { id: string }) {
        return createElement(Section, { id: props.id });
      }

      const element1 = createElement("div", {}, createElement(Item, { id: "first", key: "1" }));

      await compiler.compile(element1, tickState);

      const element2 = createElement("div", {}, createElement(Item, { id: "second", key: "2" }));

      const result = await compiler.compile(element2, tickState);

      expect(result.sections.has("second")).toBe(true);
    });
  });

  describe("Props Updates", () => {
    it("should update function component props", async () => {
      function PropsComponent(props: { value: string }) {
        return createElement(Section, { id: "props" }, props.value);
      }

      const element1 = createElement(PropsComponent, { value: "first" });
      await compiler.compile(element1, tickState);

      const element2 = createElement(PropsComponent, { value: "second" });
      const result = await compiler.compile(element2, tickState);

      expect(result.sections.has("props")).toBe(true);
    });

    it("should update class component props", async () => {
      class PropsComponent extends Component {
        render() {
          const value = (this.props as { value?: string }).value || "default";
          return createElement(Section, { id: "props" }, value);
        }
      }

      const element1 = createElement(PropsComponent, { value: "first" });
      await compiler.compile(element1, tickState);

      const element2 = createElement(PropsComponent, { value: "second" });
      const result = await compiler.compile(element2, tickState);

      expect(result.sections.has("props")).toBe(true);
    });
  });

  describe("StructureRenderer modelOptions", () => {
    it("should pass through modelOptions in formatInput", async () => {
      const structureRenderer = new StructureRenderer(com, new MarkdownRenderer());

      // Set up modelOptions via ModelOptions component
      const element = createElement(ModelOptions, { temperature: 0.7, maxTokens: 100 });
      await compiler.compile(element, tickState);

      // Get COMInput with modelOptions
      const comInput = com.toInput();
      expect(comInput.modelOptions).toBeDefined();
      expect(comInput.modelOptions?.temperature).toBe(0.7);
      expect(comInput.modelOptions?.maxTokens).toBe(100);

      // Verify formatInput preserves modelOptions
      const formatted = await structureRenderer.formatInput(comInput);
      expect(formatted.modelOptions).toBeDefined();
      expect(formatted.modelOptions?.temperature).toBe(0.7);
      expect(formatted.modelOptions?.maxTokens).toBe(100);
    });

    it("should preserve modelOptions with timeline content", async () => {
      const structureRenderer = new StructureRenderer(com, new MarkdownRenderer());

      // Compile component that sets modelOptions and adds a message
      const element = createElement(
        "div",
        {},
        createElement(ModelOptions, { temperature: 0.9, maxTokens: 50 }),
        createElement(Message, { role: "user" }, "Test message"),
      );

      const compileResult = await compiler.compileUntilStable(element, tickState, {
        maxIterations: 3,
      });

      // Apply timeline entries to COM
      for (const entry of compileResult.compiled.timelineEntries) {
        if (entry.kind === "message" && entry.message) {
          com.addMessage(entry.message as any, {});
        }
      }

      // Format and verify modelOptions preserved
      const formatted = await structureRenderer.formatInput(com.toInput());
      expect(formatted.modelOptions?.temperature).toBe(0.9);
      expect(formatted.modelOptions?.maxTokens).toBe(50);
    });
  });
});

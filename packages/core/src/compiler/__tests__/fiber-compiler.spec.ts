/**
 * Tests for FiberCompiler
 */

import { FiberCompiler } from "../fiber-compiler";
import { COM } from "../../com/object-model";
import type { TickState } from "../../component/component";
import { Component } from "../../component/component";
import { Section, Message, Timeline, Tool, ModelOptions } from "../../jsx/components/primitives";
import { Text } from "../../jsx/components/content";
import { createElement, Fragment } from "../../jsx/jsx-runtime";
import { useState, useComState, useTickStart, useTickEnd, useEffect } from "../../state/hooks";
import type { COMTimelineEntry } from "../../com/types";

describe("FiberCompiler", () => {
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
    } as unknown as TickState;
  });

  describe("Basic Compilation", () => {
    it("should compile simple JSX element", async () => {
      const element = createElement(Section, { id: "test" }, createElement(Text, {}, "Hello"));

      const result = await compiler.compile(element, tickState);

      expect(result.sections.has("test")).toBe(true);
      const section = result.sections.get("test")!;
      expect(section.id).toBe("test");
    });

    it("should compile function component", async () => {
      function MyComponent() {
        return createElement(Section, { id: "func" }, "Content");
      }

      const element = createElement(MyComponent, {});
      const result = await compiler.compile(element, tickState);

      expect(result.sections.has("func")).toBe(true);
    });

    it("should compile class component", async () => {
      class MyComponent extends Component {
        render() {
          return createElement(Section, { id: "class" }, "Content");
        }
      }

      const element = createElement(MyComponent, {});
      const result = await compiler.compile(element, tickState);

      expect(result.sections.has("class")).toBe(true);
    });

    it("should handle Fragment", async () => {
      const element = createElement(
        Fragment,
        {},
        createElement(Section, { id: "a" }),
        createElement(Section, { id: "b" }),
      );

      const result = await compiler.compile(element, tickState);

      expect(result.sections.has("a")).toBe(true);
      expect(result.sections.has("b")).toBe(true);
    });
  });

  describe("Function Components with Hooks", () => {
    it("should compile component with useState", async () => {
      function Counter() {
        const [count] = useState(0);
        return createElement(Section, { id: "counter" }, `Count: ${count}`);
      }

      const element = createElement(Counter, {});
      const result = await compiler.compile(element, tickState);

      expect(result.sections.has("counter")).toBe(true);
    });

    it("should compile component with useComState", async () => {
      function TimelineView() {
        const timeline = useComState<COMTimelineEntry[]>("timeline", []);
        return createElement(
          Timeline,
          {},
          timeline().map((msg: unknown, i: number) =>
            createElement(Message, { key: i, role: "user" }, String(msg)),
          ),
        );
      }

      const element = createElement(TimelineView, {});
      const result = await compiler.compile(element, tickState);

      expect(result.timelineEntries).toBeDefined();
    });

    it("should handle non-rendering component", async () => {
      function StateManager() {
        const _data = useComState("data", []);
        useTickStart(() => {});
        return null;
      }

      const element = createElement(StateManager, {});
      const result = await compiler.compile(element, tickState);

      // Component exists but produces no output
      expect(result.sections.size).toBe(0);
    });
  });

  describe("Class Components", () => {
    it("should call onMount lifecycle", async () => {
      const onMountSpy = vi.fn();

      class LifecycleComponent extends Component {
        onMount = onMountSpy;

        render() {
          return createElement(Section, { id: "lifecycle" });
        }
      }

      const element = createElement(LifecycleComponent, {});
      await compiler.compile(element, tickState);

      expect(onMountSpy).toHaveBeenCalledWith(com);
    });

    it("should call onTickStart lifecycle", async () => {
      const onTickStartSpy = vi.fn();

      class TickComponent extends Component {
        onTickStart = onTickStartSpy;

        render() {
          return createElement(Section, { id: "tick" });
        }
      }

      const element = createElement(TickComponent, {});
      await compiler.compile(element, tickState);

      await compiler.notifyTickStart(tickState);

      expect(onTickStartSpy).toHaveBeenCalledWith(com, tickState);
    });

    it("should handle class component with signals", async () => {
      class SignalComponent extends Component {
        private count = 0;

        render() {
          this.count++;
          return createElement(Section, { id: "signal" }, `Render ${this.count}`);
        }
      }

      const element = createElement(SignalComponent, {});
      const result1 = await compiler.compile(element, tickState);
      const result2 = await compiler.compile(element, tickState);

      expect(result1.sections.has("signal")).toBe(true);
      expect(result2.sections.has("signal")).toBe(true);
    });
  });

  describe("Content Blocks", () => {
    it("should handle pure content block objects", async () => {
      function ContentProvider() {
        return createElement(Message, { role: "user" }, { type: "text", text: "Raw content" });
      }

      const element = createElement(ContentProvider, {});
      const result = await compiler.compile(element, tickState);

      expect(result.timelineEntries.length).toBeGreaterThan(0);
    });

    it("should handle array of content blocks", async () => {
      function MultiBlock() {
        return createElement(Message, { role: "user" }, [
          { type: "text", text: "Block 1" },
          { type: "text", text: "Block 2" },
        ]);
      }

      const element = createElement(MultiBlock, {});
      const result = await compiler.compile(element, tickState);

      const entry = result.timelineEntries[0];
      expect(entry.message?.content.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Effect Phases", () => {
    it("should run tick start effects", async () => {
      const tickStartSpy = vi.fn();

      function EffectComponent() {
        useTickStart(tickStartSpy);
        return createElement(Section, { id: "effects" });
      }

      const element = createElement(EffectComponent, {});
      await compiler.compile(element, tickState);

      await compiler.notifyTickStart(tickState);

      expect(tickStartSpy).toHaveBeenCalledWith(com, tickState);
    });

    it("should run tick end effects", async () => {
      const tickEndSpy = vi.fn();

      function EffectComponent() {
        useTickEnd(tickEndSpy);
        return createElement(Section, { id: "effects" });
      }

      const element = createElement(EffectComponent, {});
      await compiler.compile(element, tickState);

      await compiler.notifyTickEnd(tickState);

      expect(tickEndSpy).toHaveBeenCalledWith(com, tickState);
    });

    it("should run mount effects", async () => {
      const mountSpy = vi.fn();

      function EffectComponent() {
        useEffect(() => {
          mountSpy();
        }, []);
        return createElement(Section, { id: "effects" });
      }

      const element = createElement(EffectComponent, {});
      await compiler.compile(element, tickState);

      // Effects run during commit phase
      expect(mountSpy).toHaveBeenCalled();
    });
  });

  describe("Compile Stabilization", () => {
    it("should compile until stable", async () => {
      let _compileCount = 0;

      function RecompileComponent() {
        _compileCount++;
        const [count, setCount] = useState(0);

        useEffect(() => {
          if (count < 2) {
            setCount((c) => c + 1);
          }
        }, [count]);

        return createElement(Section, { id: "recompile" }, `Count: ${count}`);
      }

      const element = createElement(RecompileComponent, {});
      const result = await compiler.compileUntilStable(element, tickState, { maxIterations: 5 });

      expect(result.iterations).toBe(3);
      expect(result.forcedStable).toBe(false);
    });

    it("should respect max iterations", async () => {
      function InfiniteRecompile() {
        com.requestRecompile("always");
        return createElement(Section, { id: "infinite" });
      }

      const element = createElement(InfiniteRecompile, {});
      const result = await compiler.compileUntilStable(element, tickState, { maxIterations: 3 });

      expect(result.iterations).toBe(3);
      expect(result.forcedStable).toBe(true);
    });
  });

  describe("Unmounting", () => {
    it("should call onUnmount for class components", async () => {
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

      expect(unmountSpy).toHaveBeenCalledWith(com);
    });

    it("should run cleanup for function component effects", async () => {
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
  });

  describe("Tools", () => {
    it("should collect tools from Tool components", async () => {
      const toolDef = {
        metadata: { name: "test-tool", description: "Test" },
        run: vi.fn(),
      };

      const element = createElement(Tool, { definition: toolDef });
      const result = await compiler.compile(element, tickState);

      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools[0].name).toBe("test-tool");
    });
  });

  describe("Sections", () => {
    it("should merge sections with same id", async () => {
      const element1 = createElement(Section, { id: "merged" }, "First");
      const element2 = createElement(Section, { id: "merged" }, "Second");

      await compiler.compile(element1, tickState);
      const result = await compiler.compile(element2, tickState);

      const section = result.sections.get("merged")!;
      expect(section).toBeDefined();
    });

    it("should handle section visibility and audience", async () => {
      const element = createElement(
        Section,
        {
          id: "visible",
          visibility: "model",
          audience: "human",
        },
        "Content",
      );

      const result = await compiler.compile(element, tickState);
      const section = result.sections.get("visible")!;

      expect(section.visibility).toBe("model");
      expect(section.audience).toBe("human");
    });
  });

  describe("Messages", () => {
    it("should compile user message", async () => {
      const element = createElement(Message, { role: "user" }, "Hello");
      const result = await compiler.compile(element, tickState);

      expect(result.timelineEntries.length).toBeGreaterThan(0);
      expect(result.timelineEntries[0].message?.role).toBe("user");
    });

    it("should compile system message", async () => {
      const element = createElement(Message, { role: "system" }, "System message");
      const result = await compiler.compile(element, tickState);

      expect(result.systemMessageItems.length).toBeGreaterThan(0);
    });
  });

  describe("Props Updates", () => {
    it("should update props for class components", async () => {
      class PropsComponent extends Component {
        render() {
          const title = (this.props as { title?: string }).title || "Default";
          return createElement(Section, { id: "props" }, title);
        }
      }

      const element1 = createElement(PropsComponent, { title: "First" });
      await compiler.compile(element1, tickState);

      const element2 = createElement(PropsComponent, { title: "Second" });
      const result = await compiler.compile(element2, tickState);

      expect(result.sections.has("props")).toBe(true);
    });

    it("should update props for function components", async () => {
      function PropsComponent(props: { title?: string }) {
        return createElement(Section, { id: "props" }, props.title || "Default");
      }

      const element1 = createElement(PropsComponent, { title: "First" });
      await compiler.compile(element1, tickState);

      const element2 = createElement(PropsComponent, { title: "Second" });
      const result = await compiler.compile(element2, tickState);

      expect(result.sections.has("props")).toBe(true);
    });
  });

  describe("ModelOptions", () => {
    it("should set model options during render (not onTickStart)", async () => {
      // This tests the fix: ModelOptions should set options in render()
      // so they are available before toInput() is called
      const element = createElement(
        Fragment,
        {},
        createElement(ModelOptions, { temperature: 0.8, maxTokens: 150 }),
        createElement(Section, { id: "test" }, "Content"),
      );

      await compiler.compile(element, tickState);

      // Check that modelOptions were set on the COM during render
      const modelOptions = com.getModelOptions();
      expect(modelOptions).toBeDefined();
      expect(modelOptions?.temperature).toBe(0.8);
      expect(modelOptions?.maxTokens).toBe(150);
    });

    it("should include model options in toInput() result", async () => {
      const element = createElement(
        Fragment,
        {},
        createElement(ModelOptions, { temperature: 0.5, maxTokens: 200 }),
      );

      await compiler.compile(element, tickState);

      // Verify that toInput() includes the modelOptions
      const comInput = com.toInput();
      expect(comInput.modelOptions).toBeDefined();
      expect(comInput.modelOptions?.temperature).toBe(0.5);
      expect(comInput.modelOptions?.maxTokens).toBe(200);
    });

    it("should allow multiple ModelOptions to merge (last wins)", async () => {
      const element = createElement(
        Fragment,
        {},
        createElement(ModelOptions, { temperature: 0.5 }),
        createElement(ModelOptions, { maxTokens: 100 }),
        createElement(ModelOptions, { temperature: 0.9 }), // Override temperature
      );

      await compiler.compile(element, tickState);

      const modelOptions = com.getModelOptions();
      expect(modelOptions?.temperature).toBe(0.9); // Last temperature wins
      expect(modelOptions?.maxTokens).toBe(100); // maxTokens preserved
    });

    it("should set model options before notifyTickStart", async () => {
      // This verifies the fix: on tick 1, modelOptions should be available
      // even though notifyTickStart happens before compile
      let optionsAtTickStart: any = undefined;

      function CheckOptionsComponent() {
        useTickStart((comArg) => {
          optionsAtTickStart = comArg.getModelOptions();
        });
        return null;
      }

      const element = createElement(
        Fragment,
        {},
        createElement(ModelOptions, { temperature: 0.7 }),
        createElement(CheckOptionsComponent, {}),
      );

      // First compile sets up the fiber tree
      await compiler.compile(element, tickState);

      // notifyTickStart runs effects (including useTickStart)
      await compiler.notifyTickStart(tickState);

      // On first tick, useTickStart runs AFTER compile, so options should be set
      // This verifies the fix works
      expect(optionsAtTickStart?.temperature).toBe(0.7);
    });
  });
});

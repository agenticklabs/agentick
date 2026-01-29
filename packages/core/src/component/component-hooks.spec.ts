import { ComponentHookRegistry } from "./component-hooks";
import { Component } from "./component";
import { type TickState } from "./component";
import { COM } from "../com/object-model";

describe("ComponentHookRegistry", () => {
  let registry: ComponentHookRegistry;
  let _mockCom: COM;
  let _mockState: TickState;

  beforeEach(() => {
    registry = new ComponentHookRegistry();
    _mockCom = {} as COM;
    _mockState = {
      tick: 1,
      stop: () => {},
    } as TickState;
  });

  describe("register overloads", () => {
    it("should register middleware for specific hook and specific component", () => {
      class TimelineManager extends Component {}

      const middleware = vi.fn(async (input, ctx, next) => {
        return next();
      });

      registry.register("onTickStart", TimelineManager, middleware);

      const middlewareList = registry.getMiddleware(
        "onTickStart",
        TimelineManager,
        "TimelineManager",
        [],
      );
      expect(middlewareList).toHaveLength(1);
      expect(middlewareList[0]).toBe(middleware);
    });

    it("should register middleware for specific hook and all components", () => {
      const middleware = vi.fn(async (input, ctx, next) => {
        return next();
      });

      registry.register("onTickStart", middleware);

      class AnyComponent extends Component {}
      const middlewareList = registry.getMiddleware(
        "onTickStart",
        AnyComponent,
        "AnyComponent",
        [],
      );
      expect(middlewareList).toHaveLength(1);
      expect(middlewareList[0]).toBe(middleware);
    });

    it("should register middleware for all hooks and specific component", () => {
      class TimelineManager extends Component {}

      const middleware = vi.fn(async (input, ctx, next) => {
        return next();
      });

      registry.register(TimelineManager, middleware);

      // Check that middleware is registered for multiple hooks
      const onTickStartMw = registry.getMiddleware(
        "onTickStart",
        TimelineManager,
        "TimelineManager",
        [],
      );
      const renderMw = registry.getMiddleware("render", TimelineManager, "TimelineManager", []);
      const onTickEndMw = registry.getMiddleware(
        "onTickEnd",
        TimelineManager,
        "TimelineManager",
        [],
      );

      expect(onTickStartMw).toHaveLength(1);
      expect(renderMw).toHaveLength(1);
      expect(onTickEndMw).toHaveLength(1);
      expect(onTickStartMw[0]).toBe(middleware);
      expect(renderMw[0]).toBe(middleware);
      expect(onTickEndMw[0]).toBe(middleware);
    });

    it("should register middleware for all hooks and all components", () => {
      const middleware = vi.fn(async (input, ctx, next) => {
        return next();
      });

      registry.register(middleware);

      class AnyComponent extends Component {}
      // Check that middleware is registered for multiple hooks
      const onTickStartMw = registry.getMiddleware("onTickStart", AnyComponent, "AnyComponent", []);
      const renderMw = registry.getMiddleware("render", AnyComponent, "AnyComponent", []);
      const onTickEndMw = registry.getMiddleware("onTickEnd", AnyComponent, "AnyComponent", []);

      expect(onTickStartMw).toHaveLength(1);
      expect(renderMw).toHaveLength(1);
      expect(onTickEndMw).toHaveLength(1);
      expect(onTickStartMw[0]).toBe(middleware);
      expect(renderMw[0]).toBe(middleware);
      expect(onTickEndMw[0]).toBe(middleware);
    });

    it("should combine multiple registrations correctly", () => {
      class TimelineManager extends Component {}
      class OtherComponent extends Component {}

      const globalMw = vi.fn(async (input, ctx, next) => next());
      const componentMw = vi.fn(async (input, ctx, next) => next());
      const hookMw = vi.fn(async (input, ctx, next) => next());

      // Register global middleware for all hooks
      registry.register(globalMw);

      // Register component-specific middleware for all hooks
      registry.register(TimelineManager, componentMw);

      // Register hook-specific middleware for all components
      registry.register("onTickStart", hookMw);

      // TimelineManager.onTickStart should have all three
      const timelineMw = registry.getMiddleware(
        "onTickStart",
        TimelineManager,
        "TimelineManager",
        [],
      );
      expect(timelineMw).toHaveLength(3);
      expect(timelineMw).toContain(componentMw); // Component-specific first
      expect(timelineMw).toContain(hookMw); // Hook-specific
      expect(timelineMw).toContain(globalMw); // Global last

      // OtherComponent.onTickStart should have hook-specific and global (not component-specific)
      const otherMw = registry.getMiddleware("onTickStart", OtherComponent, "OtherComponent", []);
      expect(otherMw).toHaveLength(2);
      expect(otherMw).toContain(hookMw);
      expect(otherMw).toContain(globalMw);
      expect(otherMw).not.toContain(componentMw);

      // TimelineManager.render should have component-specific and global (not hook-specific)
      const renderMw = registry.getMiddleware("render", TimelineManager, "TimelineManager", []);
      expect(renderMw).toHaveLength(2);
      expect(renderMw).toContain(componentMw);
      expect(renderMw).toContain(globalMw);
      expect(renderMw).not.toContain(hookMw);
    });

    it("should handle string selector (component name)", () => {
      const middleware = vi.fn(async (input, ctx, next) => next());

      registry.register("onTickStart", "TimelineManager", middleware);

      class TimelineManager extends Component {}
      const middlewareList = registry.getMiddleware(
        "onTickStart",
        TimelineManager,
        "TimelineManager",
        [],
      );
      expect(middlewareList).toHaveLength(1);
      expect(middlewareList[0]).toBe(middleware);
    });

    it("should handle tag selector", () => {
      const middleware = vi.fn(async (input, ctx, next) => next());

      registry.register("onTickStart", { tags: ["timeline"] }, middleware);

      class TimelineManager extends Component {}
      TimelineManager.tags = ["timeline", "manager"];
      const middlewareList = registry.getMiddleware(
        "onTickStart",
        TimelineManager,
        "TimelineManager",
        ["timeline", "manager"],
      );
      expect(middlewareList).toHaveLength(1);
      expect(middlewareList[0]).toBe(middleware);
    });
  });

  describe("getMiddleware ordering", () => {
    it("should return middleware in correct order: component-defined -> class-based -> tag-based -> name-based -> global", () => {
      const componentDefinedHook = vi.fn(async (input, ctx, next) => next());

      class TimelineManager extends Component {
        static hooks = {
          onTickStart: [componentDefinedHook as any],
        };
      }

      const classMw = vi.fn(async (input, ctx, next) => next());
      const tagMw = vi.fn(async (input, ctx, next) => next());
      const nameMw = vi.fn(async (input, ctx, next) => next());
      const globalMw = vi.fn(async (input, ctx, next) => next());

      registry.register("onTickStart", TimelineManager, classMw);
      registry.register("onTickStart", { tags: ["timeline"] }, tagMw);
      registry.register("onTickStart", "TimelineManager", nameMw);
      registry.register("onTickStart", globalMw);

      const middlewareList = registry.getMiddleware(
        "onTickStart",
        TimelineManager,
        "TimelineManager",
        ["timeline", "manager"],
      );

      // Component-defined hooks are converted to middleware, so we check the length and order
      // Component-defined should be first (converted from hooks)
      expect(middlewareList.length).toBeGreaterThanOrEqual(5);
      // The first middleware should be the wrapper around componentDefinedHook
      expect(middlewareList[0]).toBeDefined();

      // Then class-based
      expect(middlewareList).toContain(classMw);
      // Then tag-based
      expect(middlewareList).toContain(tagMw);
      // Then name-based
      expect(middlewareList).toContain(nameMw);
      // Then global
      expect(middlewareList).toContain(globalMw);

      // Verify order: component-defined first, then class-based, tag-based, name-based, global last
      const classMwIndex = middlewareList.indexOf(classMw);
      const tagMwIndex = middlewareList.indexOf(tagMw);
      const nameMwIndex = middlewareList.indexOf(nameMw);
      const globalMwIndex = middlewareList.indexOf(globalMw);

      expect(classMwIndex).toBeGreaterThan(0); // After component-defined
      expect(tagMwIndex).toBeGreaterThan(classMwIndex);
      expect(nameMwIndex).toBeGreaterThan(tagMwIndex);
      expect(globalMwIndex).toBeGreaterThan(nameMwIndex);
      expect(globalMwIndex).toBe(middlewareList.length - 1); // Global should be last
    });
  });
});

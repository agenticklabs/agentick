// @vitest-environment happy-dom

import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useSlashCommands,
  helpCommand,
  clearCommand,
  exitCommand,
  type SlashCommand,
  type CommandContext,
} from "../commands.js";

function createMockCtx(
  overrides: Partial<Omit<CommandContext, "addCommand" | "removeCommand">> = {},
): Omit<CommandContext, "addCommand" | "removeCommand"> {
  return {
    sessionId: "test",
    send: vi.fn(),
    abort: vi.fn(),
    output: vi.fn(),
    ...overrides,
  };
}

describe("useSlashCommands", () => {
  describe("dispatch", () => {
    it("returns false for non-slash input", () => {
      const ctx = createMockCtx();
      const { result } = renderHook(() => useSlashCommands([], ctx));

      expect(result.current.dispatch("hello world")).toBe(false);
      expect(ctx.output).not.toHaveBeenCalled();
    });

    it("returns true and prints error for unknown commands", () => {
      const ctx = createMockCtx();
      const { result } = renderHook(() => useSlashCommands([], ctx));

      expect(result.current.dispatch("/unknown")).toBe(true);
      expect(ctx.output).toHaveBeenCalledWith(
        "Unknown command: /unknown. Type /help for available commands.",
      );
    });

    it("dispatches to matching command by name", () => {
      const handler = vi.fn();
      const cmd: SlashCommand = {
        name: "test",
        description: "A test command",
        handler,
      };
      const ctx = createMockCtx();
      const { result } = renderHook(() => useSlashCommands([cmd], ctx));

      expect(result.current.dispatch("/test")).toBe(true);
      expect(handler).toHaveBeenCalledWith("", expect.objectContaining({ sessionId: "test" }));
    });

    it("passes args after the command name", () => {
      const handler = vi.fn();
      const cmd: SlashCommand = {
        name: "greet",
        description: "Greet someone",
        args: "<name>",
        handler,
      };
      const ctx = createMockCtx();
      const { result } = renderHook(() => useSlashCommands([cmd], ctx));

      result.current.dispatch("/greet Alice Bob");
      expect(handler).toHaveBeenCalledWith(
        "Alice Bob",
        expect.objectContaining({ sessionId: "test" }),
      );
    });

    it("dispatches to command by alias", () => {
      const handler = vi.fn();
      const cmd: SlashCommand = {
        name: "exit",
        description: "Exit",
        aliases: ["quit", "q"],
        handler,
      };
      const ctx = createMockCtx();
      const { result } = renderHook(() => useSlashCommands([cmd], ctx));

      expect(result.current.dispatch("/quit")).toBe(true);
      expect(handler).toHaveBeenCalled();

      handler.mockClear();
      expect(result.current.dispatch("/q")).toBe(true);
      expect(handler).toHaveBeenCalled();
    });

    it("returns empty string for no-arg commands", () => {
      const handler = vi.fn();
      const cmd: SlashCommand = {
        name: "ping",
        description: "Ping",
        handler,
      };
      const ctx = createMockCtx();
      const { result } = renderHook(() => useSlashCommands([cmd], ctx));

      result.current.dispatch("/ping");
      expect(handler).toHaveBeenCalledWith("", expect.anything());
    });
  });

  describe("help", () => {
    it("prints formatted help for all registered commands", () => {
      const ctx = createMockCtx();
      const cmds: SlashCommand[] = [clearCommand(() => {}), exitCommand(() => {}), helpCommand()];
      const { result } = renderHook(() => useSlashCommands(cmds, ctx));

      result.current.dispatch("/help");

      expect(ctx.output).toHaveBeenCalledTimes(1);
      const output = (ctx.output as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;

      expect(output).toContain("/clear");
      expect(output).toContain("/exit");
      expect(output).toContain("/help");
      expect(output).toContain("Clear message history");
      expect(output).toContain("aliases: /quit");
    });
  });

  describe("addCommand", () => {
    it("adds a command that can be dispatched", () => {
      const handler = vi.fn();
      const ctx = createMockCtx();
      const { result } = renderHook(() => useSlashCommands([], ctx));

      act(() => {
        result.current.addCommand({
          name: "dynamic",
          description: "Added at runtime",
          handler,
        });
      });

      expect(result.current.dispatch("/dynamic")).toBe(true);
      expect(handler).toHaveBeenCalled();
    });

    it("is available on CommandContext passed to handlers", () => {
      const ctx = createMockCtx();
      let capturedCtx: CommandContext | undefined;
      const cmd: SlashCommand = {
        name: "capture",
        description: "Captures context",
        handler: (_args, handlerCtx) => {
          capturedCtx = handlerCtx;
        },
      };
      const { result } = renderHook(() => useSlashCommands([cmd], ctx));

      result.current.dispatch("/capture");
      expect(capturedCtx).toBeDefined();
      expect(typeof capturedCtx!.addCommand).toBe("function");
      expect(typeof capturedCtx!.removeCommand).toBe("function");
    });
  });

  describe("removeCommand", () => {
    it("removes a command so it can no longer be dispatched", () => {
      const handler = vi.fn();
      const cmd: SlashCommand = {
        name: "temp",
        description: "Temporary",
        handler,
      };
      const ctx = createMockCtx();
      const { result } = renderHook(() => useSlashCommands([cmd], ctx));

      expect(result.current.dispatch("/temp")).toBe(true);
      expect(handler).toHaveBeenCalled();
      handler.mockClear();

      act(() => {
        result.current.removeCommand("temp");
      });

      expect(result.current.dispatch("/temp")).toBe(true); // still consumed (starts with /)
      expect(handler).not.toHaveBeenCalled(); // but handler not called
      expect(ctx.output).toHaveBeenCalledWith(
        "Unknown command: /temp. Type /help for available commands.",
      );
    });
  });

  describe("commands list", () => {
    it("returns all registered commands", () => {
      const ctx = createMockCtx();
      const cmd1: SlashCommand = { name: "a", description: "A", handler: vi.fn() };
      const cmd2: SlashCommand = { name: "b", description: "B", handler: vi.fn() };
      const { result } = renderHook(() => useSlashCommands([cmd1, cmd2], ctx));

      expect(result.current.commands).toHaveLength(2);
      expect(result.current.commands.map((c) => c.name)).toEqual(
        expect.arrayContaining(["a", "b"]),
      );
    });

    it("accepts nested arrays (command packs)", () => {
      const ctx = createMockCtx();
      const pack: SlashCommand[] = [
        { name: "x", description: "X", handler: vi.fn() },
        { name: "y", description: "Y", handler: vi.fn() },
      ];
      const single: SlashCommand = { name: "z", description: "Z", handler: vi.fn() };
      const { result } = renderHook(() => useSlashCommands([pack, single], ctx));

      expect(result.current.commands).toHaveLength(3);
    });
  });
});

describe("built-in commands", () => {
  describe("clearCommand", () => {
    it("calls onClear when dispatched", () => {
      const onClear = vi.fn();
      const cmd = clearCommand(onClear);
      const ctx = createMockCtx();
      const { result } = renderHook(() => useSlashCommands([cmd], ctx));

      result.current.dispatch("/clear");
      expect(onClear).toHaveBeenCalledTimes(1);
    });
  });

  describe("exitCommand", () => {
    it("calls onExit when dispatched", () => {
      const onExit = vi.fn();
      const cmd = exitCommand(onExit);
      const ctx = createMockCtx();
      const { result } = renderHook(() => useSlashCommands([cmd], ctx));

      result.current.dispatch("/exit");
      expect(onExit).toHaveBeenCalledTimes(1);
    });

    it("responds to /quit alias", () => {
      const onExit = vi.fn();
      const cmd = exitCommand(onExit);
      const ctx = createMockCtx();
      const { result } = renderHook(() => useSlashCommands([cmd], ctx));

      result.current.dispatch("/quit");
      expect(onExit).toHaveBeenCalledTimes(1);
    });
  });
});

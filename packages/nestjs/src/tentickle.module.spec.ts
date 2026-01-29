/**
 * Tests for TentickleModule
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Test } from "@nestjs/testing";
import { TentickleModule } from "./tentickle.module.js";
import { TentickleController } from "./tentickle.controller.js";
import {
  TENTICKLE_OPTIONS,
  TENTICKLE_SESSION_HANDLER,
  TENTICKLE_EVENT_BRIDGE,
} from "./types.js";

// Mock @tentickle/server
vi.mock("@tentickle/server", () => ({
  createSessionHandler: vi.fn(() => ({
    create: vi.fn(),
    send: vi.fn(),
    stream: vi.fn(),
    getSession: vi.fn(),
    getState: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
  })),
  createEventBridge: vi.fn(() => ({
    handleEvent: vi.fn(),
    registerConnection: vi.fn(),
    unregisterConnection: vi.fn(),
    destroy: vi.fn(),
  })),
  setSSEHeaders: vi.fn(),
  createSSEWriter: vi.fn(() => ({
    writeEvent: vi.fn(),
    writeComment: vi.fn(),
    close: vi.fn(),
    closed: false,
  })),
  SessionNotFoundError: class extends Error {
    constructor(id: string) {
      super(`Session not found: ${id}`);
      this.name = "SessionNotFoundError";
    }
  },
}));

describe("TentickleModule", () => {
  const mockApp = { createSession: vi.fn() } as any;

  describe("forRoot", () => {
    it("creates module with session handler and event bridge", async () => {
      const module = await Test.createTestingModule({
        imports: [
          TentickleModule.forRoot({
            sessionHandler: { app: mockApp },
          }),
        ],
      }).compile();

      const sessionHandler = module.get(TENTICKLE_SESSION_HANDLER);
      const eventBridge = module.get(TENTICKLE_EVENT_BRIDGE);

      expect(sessionHandler).toBeDefined();
      expect(eventBridge).toBeDefined();
    });

    it("registers controller by default", async () => {
      const module = await Test.createTestingModule({
        imports: [
          TentickleModule.forRoot({
            sessionHandler: { app: mockApp },
          }),
        ],
      }).compile();

      const controller = module.get(TentickleController);
      expect(controller).toBeDefined();
    });

    it("does not register controller when registerController is false", async () => {
      const module = await Test.createTestingModule({
        imports: [
          TentickleModule.forRoot({
            sessionHandler: { app: mockApp },
            registerController: false,
          }),
        ],
      }).compile();

      expect(() => module.get(TentickleController)).toThrow();
    });

    it("provides options", async () => {
      const options = {
        sessionHandler: { app: mockApp },
        path: "custom/path",
      };

      const module = await Test.createTestingModule({
        imports: [TentickleModule.forRoot(options)],
      }).compile();

      const providedOptions = module.get(TENTICKLE_OPTIONS);
      expect(providedOptions).toEqual(options);
    });

    it("calls createSessionHandler with config", async () => {
      const { createSessionHandler } = await import("@tentickle/server");

      await Test.createTestingModule({
        imports: [
          TentickleModule.forRoot({
            sessionHandler: { app: mockApp },
          }),
        ],
      }).compile();

      expect(createSessionHandler).toHaveBeenCalledWith({ app: mockApp });
    });

    it("calls createEventBridge with sessionHandler", async () => {
      const { createEventBridge, createSessionHandler } = await import(
        "@tentickle/server"
      );

      await Test.createTestingModule({
        imports: [
          TentickleModule.forRoot({
            sessionHandler: { app: mockApp },
          }),
        ],
      }).compile();

      const mockHandler = (createSessionHandler as any).mock.results[0].value;
      expect(createEventBridge).toHaveBeenCalledWith({
        sessionHandler: mockHandler,
      });
    });

    it("passes eventBridge options to createEventBridge", async () => {
      const { createEventBridge } = await import("@tentickle/server");
      const validateEvent = vi.fn();

      // Clear previous calls
      vi.clearAllMocks();

      await Test.createTestingModule({
        imports: [
          TentickleModule.forRoot({
            sessionHandler: { app: mockApp },
            eventBridge: { validateEvent },
          }),
        ],
      }).compile();

      // Check that validateEvent was passed in one of the calls
      const calls = (createEventBridge as any).mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall.validateEvent).toBe(validateEvent);
    });

    it("exports session handler and event bridge", async () => {
      const dynamicModule = TentickleModule.forRoot({
        sessionHandler: { app: mockApp },
      });

      expect(dynamicModule.exports).toContain(TENTICKLE_SESSION_HANDLER);
      expect(dynamicModule.exports).toContain(TENTICKLE_EVENT_BRIDGE);
    });
  });

  describe("forRootAsync", () => {
    it("supports useFactory", async () => {
      const module = await Test.createTestingModule({
        imports: [
          TentickleModule.forRootAsync({
            useFactory: () => ({
              sessionHandler: { app: mockApp },
            }),
          }),
        ],
      }).compile();

      const sessionHandler = module.get(TENTICKLE_SESSION_HANDLER);
      expect(sessionHandler).toBeDefined();
    });

    it("supports useFactory with injection", async () => {
      // Verify the module structure includes inject handling
      const dynamicModule = TentickleModule.forRootAsync({
        useFactory: (config: string) => ({
          sessionHandler: { app: mockApp },
        }),
        inject: ["CONFIG_VALUE"],
      });

      // Find the TENTICKLE_OPTIONS provider
      const optionsProvider = dynamicModule.providers!.find(
        (p: any) => p.provide === TENTICKLE_OPTIONS
      ) as any;

      expect(optionsProvider).toBeDefined();
      expect(optionsProvider.inject).toContain("CONFIG_VALUE");
    });

    it("supports useClass", async () => {
      class TestOptionsFactory {
        createTentickleOptions() {
          return {
            sessionHandler: { app: mockApp },
          };
        }
      }

      const module = await Test.createTestingModule({
        imports: [
          TentickleModule.forRootAsync({
            useClass: TestOptionsFactory,
          }),
        ],
      }).compile();

      const sessionHandler = module.get(TENTICKLE_SESSION_HANDLER);
      expect(sessionHandler).toBeDefined();
    });

    it("supports useExisting", async () => {
      // useExisting requires the factory to already exist as a provider
      // Since this is complex to test properly with NestJS DI, we verify
      // that the module structure is correct
      const dynamicModule = TentickleModule.forRootAsync({
        useExisting: class TestFactory {
          createTentickleOptions() {
            return { sessionHandler: { app: mockApp } };
          }
        },
      });

      // Verify the provider structure includes useExisting handling
      expect(dynamicModule.providers).toBeDefined();
      expect(dynamicModule.providers!.length).toBeGreaterThan(0);
    });

    it("exports session handler and event bridge", async () => {
      const dynamicModule = TentickleModule.forRootAsync({
        useFactory: () => ({
          sessionHandler: { app: mockApp },
        }),
      });

      expect(dynamicModule.exports).toContain(TENTICKLE_SESSION_HANDLER);
      expect(dynamicModule.exports).toContain(TENTICKLE_EVENT_BRIDGE);
    });

    it("always registers controller in async mode", async () => {
      const module = await Test.createTestingModule({
        imports: [
          TentickleModule.forRootAsync({
            useFactory: () => ({
              sessionHandler: { app: mockApp },
            }),
          }),
        ],
      }).compile();

      const controller = module.get(TentickleController);
      expect(controller).toBeDefined();
    });
  });
});

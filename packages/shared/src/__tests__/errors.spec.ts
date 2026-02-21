/**
 * Tests for the Agentick error hierarchy
 */

import {
  AgentickError,
  AbortError,
  NotFoundError,
  ValidationError,
  StateError,
  TransportError,
  AdapterError,
  ContextError,
  ReactivityError,
  isAgentickError,
  isAbortError,
  isNotFoundError,
  isValidationError,
  isStateError,
  isTransportError,
  isAdapterError,
  isContextError,
  isReactivityError,
  ensureError,
  wrapAsAgentickError,
} from "../errors.js";

describe("AgentickError", () => {
  describe("constructor", () => {
    it("should create error with code and message", () => {
      const error = new AgentickError("STATE_INVALID", "Something went wrong");

      expect(error.message).toBe("Something went wrong");
      expect(error.code).toBe("STATE_INVALID");
      expect(error.name).toBe("AgentickError");
      expect(error.details).toEqual({});
    });

    it("should create error with details", () => {
      const error = new AgentickError("STATE_INVALID", "Error", { foo: "bar" });

      expect(error.details).toEqual({ foo: "bar" });
    });

    it("should create error with cause", () => {
      const cause = new Error("Original error");
      const error = new AgentickError("STATE_INVALID", "Wrapped", {}, cause);

      expect(error.cause).toBe(cause);
    });

    it("should have proper prototype chain", () => {
      const error = new AgentickError("STATE_INVALID", "Test");

      expect(error instanceof AgentickError).toBe(true);
      expect(error instanceof Error).toBe(true);
    });
  });

  describe("toJSON", () => {
    it("should serialize basic error", () => {
      const error = new AgentickError("STATE_INVALID", "Test message");
      const json = error.toJSON();

      expect(json.name).toBe("AgentickError");
      expect(json.code).toBe("STATE_INVALID");
      expect(json.message).toBe("Test message");
      expect(json.stack).toBeDefined();
    });

    it("should serialize details", () => {
      const error = new AgentickError("STATE_INVALID", "Test", { key: "value" });
      const json = error.toJSON();

      expect(json.details).toEqual({ key: "value" });
    });

    it("should serialize AgentickError cause recursively", () => {
      const cause = new AgentickError("NOT_FOUND_MODEL", "Model not found");
      const error = new AgentickError("STATE_INVALID", "Wrapped", {}, cause);
      const json = error.toJSON();

      expect(json.cause).toBeDefined();
      expect((json.cause as any).code).toBe("NOT_FOUND_MODEL");
    });

    it("should serialize regular Error cause", () => {
      const cause = new Error("Original");
      const error = new AgentickError("STATE_INVALID", "Wrapped", {}, cause);
      const json = error.toJSON();

      expect(json.cause).toEqual({ message: "Original", name: "Error" });
    });
  });

  describe("fromJSON", () => {
    it("should deserialize basic error", () => {
      const json = {
        name: "AgentickError",
        code: "STATE_INVALID" as const,
        message: "Test message",
      };

      const error = AgentickError.fromJSON(json);

      expect(error.code).toBe("STATE_INVALID");
      expect(error.message).toBe("Test message");
    });

    it("should deserialize with details", () => {
      const json = {
        name: "AgentickError",
        code: "STATE_INVALID" as const,
        message: "Test",
        details: { foo: "bar" },
      };

      const error = AgentickError.fromJSON(json);

      expect(error.details).toEqual({ foo: "bar" });
    });

    it("should deserialize nested cause", () => {
      const json = {
        name: "AgentickError",
        code: "STATE_INVALID" as const,
        message: "Outer",
        cause: {
          name: "AgentickError",
          code: "NOT_FOUND_MODEL" as const,
          message: "Inner",
        },
      };

      const error = AgentickError.fromJSON(json);

      expect(error.cause).toBeInstanceOf(AgentickError);
      expect((error.cause as AgentickError).code).toBe("NOT_FOUND_MODEL");
    });
  });
});

describe("AbortError", () => {
  it("should create with default values", () => {
    const error = new AbortError();

    expect(error.message).toBe("Operation aborted");
    expect(error.code).toBe("ABORT_CANCELLED");
    expect(error.name).toBe("AbortError");
  });

  it("should create with custom message and code", () => {
    const error = new AbortError("Timed out", "ABORT_TIMEOUT");

    expect(error.message).toBe("Timed out");
    expect(error.code).toBe("ABORT_TIMEOUT");
  });

  describe("fromSignal", () => {
    it("should create from AbortSignal with Error reason", () => {
      const controller = new AbortController();
      const reason = new Error("User cancelled");
      controller.abort(reason);

      const error = AbortError.fromSignal(controller.signal);

      expect(error.message).toBe("User cancelled");
      expect(error.code).toBe("ABORT_SIGNAL");
      expect(error.cause).toBe(reason);
    });

    it("should create from AbortSignal with string reason", () => {
      const controller = new AbortController();
      controller.abort("Cancelled");

      const error = AbortError.fromSignal(controller.signal);

      expect(error.message).toBe("Cancelled");
    });

    it("should return existing AbortError unchanged", () => {
      const controller = new AbortController();
      const original = new AbortError("Original", "ABORT_TIMEOUT");
      controller.abort(original);

      const error = AbortError.fromSignal(controller.signal);

      expect(error).toBe(original);
    });
  });

  describe("timeout", () => {
    it("should create timeout error", () => {
      const error = AbortError.timeout(5000);

      expect(error.message).toBe("Operation timed out after 5000ms");
      expect(error.code).toBe("ABORT_TIMEOUT");
      expect(error.details.timeoutMs).toBe(5000);
    });
  });
});

describe("NotFoundError", () => {
  it("should create with resource type and id", () => {
    const error = new NotFoundError("model", "gpt-4");

    expect(error.message).toBe("model 'gpt-4' not found");
    expect(error.code).toBe("NOT_FOUND_MODEL");
    expect(error.resourceType).toBe("model");
    expect(error.resourceId).toBe("gpt-4");
    expect(error.name).toBe("NotFoundError");
  });

  it("should create with custom message", () => {
    const error = new NotFoundError("tool", "search", "Tool not in registry");

    expect(error.message).toBe("Tool not in registry");
    expect(error.code).toBe("NOT_FOUND_TOOL");
  });

  it("should map resource types to codes", () => {
    expect(new NotFoundError("model", "x").code).toBe("NOT_FOUND_MODEL");
    expect(new NotFoundError("tool", "x").code).toBe("NOT_FOUND_TOOL");
    expect(new NotFoundError("agent", "x").code).toBe("NOT_FOUND_AGENT");
    expect(new NotFoundError("execution", "x").code).toBe("NOT_FOUND_EXECUTION");
    expect(new NotFoundError("channel", "x").code).toBe("NOT_FOUND_RESOURCE");
  });
});

describe("ValidationError", () => {
  it("should create with field and message", () => {
    const error = new ValidationError("email", "Invalid email format");

    expect(error.message).toBe("Invalid email format");
    expect(error.code).toBe("VALIDATION_REQUIRED");
    expect(error.field).toBe("email");
    expect(error.name).toBe("ValidationError");
  });

  it("should create with expected and received", () => {
    const error = new ValidationError("count", "Must be number", {
      expected: "number",
      received: "string",
    });

    expect(error.expected).toBe("number");
    expect(error.received).toBe("string");
  });

  describe("required", () => {
    it("should create required field error", () => {
      const error = ValidationError.required("name");

      expect(error.message).toBe("name is required");
      expect(error.code).toBe("VALIDATION_REQUIRED");
      expect(error.field).toBe("name");
    });

    it("should accept custom message", () => {
      const error = ValidationError.required("name", "Name cannot be empty");

      expect(error.message).toBe("Name cannot be empty");
    });
  });

  describe("type", () => {
    it("should create type mismatch error", () => {
      const error = ValidationError.type("count", "number", "string");

      expect(error.message).toBe("count must be number, received string");
      expect(error.code).toBe("VALIDATION_TYPE");
      expect(error.expected).toBe("number");
      expect(error.received).toBe("string");
    });

    it("should work without received", () => {
      const error = ValidationError.type("count", "number");

      expect(error.message).toBe("count must be number");
    });
  });
});

describe("StateError", () => {
  it("should create with states and message", () => {
    const error = new StateError("running", "stopped", "Cannot stop running process");

    expect(error.message).toBe("Cannot stop running process");
    expect(error.code).toBe("STATE_INVALID");
    expect(error.current).toBe("running");
    expect(error.expectedState).toBe("stopped");
    expect(error.name).toBe("StateError");
  });

  describe("notReady", () => {
    it("should create not ready error", () => {
      const error = StateError.notReady("Engine", "initializing");

      expect(error.message).toBe("Engine is not ready (current state: initializing)");
      expect(error.code).toBe("STATE_NOT_READY");
      expect(error.current).toBe("initializing");
      expect(error.expectedState).toBe("ready");
    });
  });

  describe("alreadyComplete", () => {
    it("should create already complete error", () => {
      const error = StateError.alreadyComplete("send message");

      expect(error.message).toBe("Cannot send message: already complete");
      expect(error.code).toBe("STATE_ALREADY_COMPLETE");
      expect(error.current).toBe("complete");
    });
  });
});

describe("TransportError", () => {
  it("should create with transport code", () => {
    const error = new TransportError("timeout", "Request timed out");

    expect(error.message).toBe("Request timed out");
    expect(error.code).toBe("TRANSPORT_TIMEOUT");
    expect(error.transportCode).toBe("timeout");
    expect(error.name).toBe("TransportError");
  });

  it("should include status code", () => {
    const error = new TransportError("response", "Not found", {
      statusCode: 404,
    });

    expect(error.statusCode).toBe(404);
  });

  describe("timeout", () => {
    it("should create timeout error", () => {
      const error = TransportError.timeout(30000, "https://api.example.com");

      expect(error.message).toBe("Request timeout after 30000ms");
      expect(error.code).toBe("TRANSPORT_TIMEOUT");
      expect(error.details.url).toBe("https://api.example.com");
    });
  });

  describe("connection", () => {
    it("should create connection error", () => {
      const cause = new Error("ECONNREFUSED");
      const error = TransportError.connection(
        "Connection refused",
        "https://api.example.com",
        cause,
      );

      expect(error.code).toBe("TRANSPORT_CONNECTION");
      expect(error.cause).toBe(cause);
    });
  });

  describe("http", () => {
    it("should create HTTP error", () => {
      const error = TransportError.http(500, "https://api.example.com", "Internal Server Error");

      expect(error.message).toBe("Internal Server Error");
      expect(error.code).toBe("TRANSPORT_RESPONSE");
      expect(error.statusCode).toBe(500);
    });

    it("should use default message", () => {
      const error = TransportError.http(404, "https://api.example.com");

      expect(error.message).toBe("HTTP 404");
    });
  });
});

describe("AdapterError", () => {
  it("should create with provider", () => {
    const error = new AdapterError("openai", "No response");

    expect(error.message).toBe("No response");
    expect(error.code).toBe("ADAPTER_RESPONSE");
    expect(error.provider).toBe("openai");
    expect(error.name).toBe("AdapterError");
  });

  describe("rateLimit", () => {
    it("should create rate limit error", () => {
      const error = AdapterError.rateLimit("openai", 60);

      expect(error.message).toBe("Rate limit exceeded. Retry after 60s");
      expect(error.code).toBe("ADAPTER_RATE_LIMIT");
      expect(error.details.retryAfter).toBe(60);
    });

    it("should work without retry after", () => {
      const error = AdapterError.rateLimit("openai");

      expect(error.message).toBe("Rate limit exceeded");
    });
  });

  describe("contentFiltered", () => {
    it("should create content filtered error", () => {
      const error = AdapterError.contentFiltered("openai", "Violence detected");

      expect(error.message).toBe("Violence detected");
      expect(error.code).toBe("ADAPTER_CONTENT_FILTER");
    });
  });

  describe("contextLength", () => {
    it("should create context length error", () => {
      const error = AdapterError.contextLength("openai", 128000, 150000);

      expect(error.message).toBe("Context length exceeded. Max: 128000, Requested: 150000");
      expect(error.code).toBe("ADAPTER_CONTEXT_LENGTH");
    });
  });
});

describe("ContextError", () => {
  it("should create with message", () => {
    const error = new ContextError("Context missing");

    expect(error.message).toBe("Context missing");
    expect(error.code).toBe("CONTEXT_NOT_FOUND");
    expect(error.name).toBe("ContextError");
  });

  describe("notFound", () => {
    it("should create helpful error message", () => {
      const error = ContextError.notFound();

      expect(error.message).toContain("Context not found");
      expect(error.message).toContain("Context.run()");
    });
  });
});

describe("ReactivityError", () => {
  it("should create with message", () => {
    const error = new ReactivityError("Circular dependency");

    expect(error.message).toBe("Circular dependency");
    expect(error.code).toBe("REACTIVITY_CIRCULAR");
    expect(error.name).toBe("ReactivityError");
  });

  describe("circular", () => {
    it("should create circular dependency error", () => {
      const error = ReactivityError.circular("computedValue");

      expect(error.message).toContain("Circular dependency");
      expect(error.message).toContain("computedValue");
    });

    it("should work without signal name", () => {
      const error = ReactivityError.circular();

      expect(error.message).toBe("Circular dependency detected in computed signal");
    });
  });
});

describe("Type Guards", () => {
  it("should identify AgentickError", () => {
    expect(isAgentickError(new AgentickError("STATE_INVALID", "test"))).toBe(true);
    expect(isAgentickError(new AbortError())).toBe(true);
    expect(isAgentickError(new Error("test"))).toBe(false);
    expect(isAgentickError("string")).toBe(false);
    expect(isAgentickError(null)).toBe(false);
  });

  it("should identify AbortError", () => {
    expect(isAbortError(new AbortError())).toBe(true);
    expect(isAbortError(new AgentickError("ABORT_CANCELLED", "test"))).toBe(false);
    expect(isAbortError(new Error())).toBe(false);
  });

  it("should identify NotFoundError", () => {
    expect(isNotFoundError(new NotFoundError("model", "x"))).toBe(true);
    expect(isNotFoundError(new AgentickError("NOT_FOUND_MODEL", "test"))).toBe(false);
  });

  it("should identify ValidationError", () => {
    expect(isValidationError(new ValidationError("field", "msg"))).toBe(true);
    expect(isValidationError(new Error())).toBe(false);
  });

  it("should identify StateError", () => {
    expect(isStateError(new StateError("a", "b", "msg"))).toBe(true);
    expect(isStateError(new Error())).toBe(false);
  });

  it("should identify TransportError", () => {
    expect(isTransportError(new TransportError("timeout", "msg"))).toBe(true);
    expect(isTransportError(new Error())).toBe(false);
  });

  it("should identify AdapterError", () => {
    expect(isAdapterError(new AdapterError("openai", "msg"))).toBe(true);
    expect(isAdapterError(new Error())).toBe(false);
  });

  it("should identify ContextError", () => {
    expect(isContextError(new ContextError("msg"))).toBe(true);
    expect(isContextError(new Error())).toBe(false);
  });

  it("should identify ReactivityError", () => {
    expect(isReactivityError(new ReactivityError("msg"))).toBe(true);
    expect(isReactivityError(new Error())).toBe(false);
  });
});

describe("Utility Functions", () => {
  describe("ensureError", () => {
    it("should return Error unchanged", () => {
      const error = new Error("test");
      expect(ensureError(error)).toBe(error);
    });

    it("should wrap string", () => {
      const error = ensureError("string error");
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("string error");
    });

    it("should wrap number", () => {
      const error = ensureError(42);
      expect(error.message).toBe("42");
    });

    it("should wrap null", () => {
      const error = ensureError(null);
      expect(error.message).toBe("null");
    });

    it("should wrap object", () => {
      const error = ensureError({ foo: "bar" });
      expect(error.message).toBe("[object Object]");
    });
  });

  describe("wrapAsAgentickError", () => {
    it("should return AgentickError unchanged", () => {
      const error = new AbortError();
      expect(wrapAsAgentickError(error)).toBe(error);
    });

    it("should wrap regular Error", () => {
      const original = new Error("test");
      const wrapped = wrapAsAgentickError(original);

      expect(wrapped).toBeInstanceOf(AgentickError);
      expect(wrapped.message).toBe("test");
      expect(wrapped.cause).toBe(original);
    });

    it("should use provided default code", () => {
      const wrapped = wrapAsAgentickError(new Error("test"), "TRANSPORT_TIMEOUT");

      expect(wrapped.code).toBe("TRANSPORT_TIMEOUT");
    });

    it("should wrap non-Error values", () => {
      const wrapped = wrapAsAgentickError("string error");

      expect(wrapped).toBeInstanceOf(AgentickError);
      expect(wrapped.message).toBe("string error");
    });
  });
});

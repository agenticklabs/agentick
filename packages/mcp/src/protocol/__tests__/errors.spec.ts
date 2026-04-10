import { describe, it, expect } from "vitest";
import {
  sanitizeErrorMessage,
  toolError,
  toolResult,
  toMCPResult,
  safeToolHandler,
  ErrorCodes,
} from "../errors.js";

describe("ErrorCodes", () => {
  it("defines standard JSON-RPC codes", () => {
    expect(ErrorCodes.INVALID_PARAMS).toBe(-32602);
    expect(ErrorCodes.METHOD_NOT_FOUND).toBe(-32601);
    expect(ErrorCodes.SERVER_ERROR).toBe(-32001);
  });
});

describe("sanitizeErrorMessage", () => {
  it("passes through safe messages", () => {
    expect(sanitizeErrorMessage("Tool not found")).toBe("Tool not found");
    expect(sanitizeErrorMessage("Invalid input")).toBe("Invalid input");
  });

  it("strips stack traces", () => {
    const msg = "Error: something\n    at Object.run (/app/src/server.ts:42:10)";
    expect(sanitizeErrorMessage(msg)).toBe("Internal server error");
  });

  it("strips file paths with line numbers", () => {
    expect(sanitizeErrorMessage("Failed at /usr/src/app/index.ts:15")).toBe(
      "Internal server error",
    );
  });

  it("strips database connection strings", () => {
    expect(sanitizeErrorMessage("Cannot connect to postgres://user:pass@host/db")).toBe(
      "Internal server error",
    );
    expect(sanitizeErrorMessage("mongodb://admin:secret@localhost:27017")).toBe(
      "Internal server error",
    );
  });

  it("strips secrets and tokens", () => {
    expect(sanitizeErrorMessage("token=abc123xyz")).toBe("Internal server error");
    expect(sanitizeErrorMessage("secret: my-api-key")).toBe("Internal server error");
  });

  it("uses custom fallback message", () => {
    expect(sanitizeErrorMessage("at fn (/app/src/foo.ts:1:1)", "Something went wrong")).toBe(
      "Something went wrong",
    );
  });
});

describe("toolError", () => {
  it("creates isError result with sanitized message", () => {
    const result = toolError("Bad input");
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Bad input" }]);
  });

  it("sanitizes sensitive error messages", () => {
    const result = toolError("Error at /app/src/handler.ts:42");
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Internal server error",
    });
  });
});

describe("toolResult", () => {
  it("creates successful text result", () => {
    const result = toolResult("Done");
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "Done" }]);
  });
});

describe("toMCPResult", () => {
  it("converts text blocks", () => {
    const result = toMCPResult({ content: [{ type: "text", text: "hello" }] });
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("converts image blocks with mediaType → mimeType", () => {
    const result = toMCPResult({
      content: [{ type: "image", data: "base64data", mediaType: "image/jpeg" }],
    });
    expect(result.content).toEqual([{ type: "image", data: "base64data", mimeType: "image/jpeg" }]);
  });

  it("defaults image mimeType to image/png", () => {
    const result = toMCPResult({
      content: [{ type: "image", data: "base64data" }],
    });
    expect(result.content[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
  });

  it("serializes unknown block types as JSON text", () => {
    const result = toMCPResult({
      content: [{ type: "custom", foo: "bar" }],
    });
    expect(result.content).toEqual([{ type: "text", text: '{"type":"custom","foo":"bar"}' }]);
  });

  it("handles mixed content", () => {
    const result = toMCPResult({
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "abc", mediaType: "image/png" },
      ],
    });
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: "text", text: "hello" });
    expect(result.content[1]).toEqual({
      type: "image",
      data: "abc",
      mimeType: "image/png",
    });
  });
});

describe("safeToolHandler", () => {
  it("passes through successful results", async () => {
    const handler = safeToolHandler(async () => toolResult("ok"));
    const result = await handler();
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(result.isError).toBeUndefined();
  });

  it("catches errors and returns safe isError result", async () => {
    const handler = safeToolHandler(async () => {
      throw new Error("Something broke at /app/src/db.ts:99");
    });
    const result = await handler();
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Internal server error",
    });
  });

  it("handles non-Error throws", async () => {
    const handler = safeToolHandler(async () => {
      throw "string error";
    });
    const result = await handler();
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "string error" });
  });
});

/**
 * Tests for TentickleExceptionFilter
 */

import { describe, it, expect, vi } from "vitest";
import { HttpStatus } from "@nestjs/common";
import { TentickleExceptionFilter } from "./tentickle.filter.js";
import { SessionNotFoundError } from "@tentickle/server";

describe("TentickleExceptionFilter", () => {
  const filter = new TentickleExceptionFilter();

  it("converts SessionNotFoundError to 404 response", () => {
    const mockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    const mockHost = {
      switchToHttp: vi.fn().mockReturnValue({
        getResponse: vi.fn().mockReturnValue(mockResponse),
      }),
    };

    filter.catch(new SessionNotFoundError("test-session"), mockHost as any);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(mockResponse.json).toHaveBeenCalledWith({
      statusCode: HttpStatus.NOT_FOUND,
      message: "Session not found",
      error: "Not Found",
    });
  });
});

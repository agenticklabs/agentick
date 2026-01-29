/**
 * Exception filter for Tentickle errors.
 *
 * Converts domain errors into appropriate HTTP exceptions.
 *
 * @module @tentickle/nestjs/filter
 */

import {
  Catch,
  HttpStatus,
  type ExceptionFilter,
  type ArgumentsHost,
} from "@nestjs/common";
import type { Response } from "express";
import { SessionNotFoundError } from "@tentickle/server";

/**
 * Exception filter that handles SessionNotFoundError.
 *
 * Converts SessionNotFoundError to HTTP 404 Not Found.
 *
 * @example Controller usage (scoped)
 * ```typescript
 * @Controller()
 * @UseFilters(TentickleExceptionFilter)
 * export class MyController { ... }
 * ```
 *
 * @example Global registration
 * ```typescript
 * app.useGlobalFilters(new TentickleExceptionFilter());
 * ```
 */
@Catch(SessionNotFoundError)
export class TentickleExceptionFilter implements ExceptionFilter {
  catch(exception: SessionNotFoundError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    response.status(HttpStatus.NOT_FOUND).json({
      statusCode: HttpStatus.NOT_FOUND,
      message: "Session not found",
      error: "Not Found",
    });
  }
}

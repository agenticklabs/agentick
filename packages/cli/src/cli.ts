/**
 * CLI - Main CLI class
 */

import { createClient, type TentickleClient, type TentickleClientConfig } from "@tentickle/client";
import EventSource from "eventsource";
import { EventEmitter } from "events";

/**
 * CLI configuration
 */
export interface CLIConfig {
  /** Server URL */
  url: string;

  /** Session ID (optional - server will create one if not provided) */
  sessionId?: string;

  /** Authentication token */
  token?: string;

  /** Enable streaming (default: true) */
  streaming?: boolean;

  /** Enable debug mode */
  debug?: boolean;

  /** Custom headers */
  headers?: Record<string, string>;
}

/**
 * CLI event types
 */
export interface CLIEvents {
  connected: [];
  disconnected: [];
  error: [Error];
  "message:sent": [{ content: string }];
  "message:received": [{ content: string; tokens?: { input: number; output: number } }];
  "stream:delta": [{ text: string }];
  "stream:start": [];
  "stream:end": [];
  "tool:start": [{ name: string; args: Record<string, unknown> }];
  "tool:end": [{ name: string; result: unknown }];
}

/**
 * CLI class for programmatic usage
 */
export class CLI extends EventEmitter {
  private client: TentickleClient;
  private config: CLIConfig;
  private _sessionId?: string;
  private _isConnected = false;

  constructor(config: CLIConfig) {
    super();
    this.config = config;

    // Create client with Node.js EventSource
    const clientConfig: TentickleClientConfig = {
      baseUrl: config.url,
      token: config.token,
      headers: config.headers,
      // @ts-expect-error - EventSource types differ slightly
      EventSource: EventSource,
    };

    this.client = createClient(clientConfig);
    this._sessionId = config.sessionId;

    // Forward connection state changes
    this.client.onConnectionChange((state) => {
      if (state === "connected" && !this._isConnected) {
        this._isConnected = true;
        this.emit("connected");
      } else if (state === "disconnected" && this._isConnected) {
        this._isConnected = false;
        this.emit("disconnected");
      } else if (state === "error") {
        this.emit("error", new Error("Connection error"));
      }
    });
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Send a message and get the response
   */
  async send(message: string): Promise<string> {
    const handle = this.client.send(message, {
      sessionId: this._sessionId,
    });

    // Track session ID from response
    let response = "";

    this.emit("stream:start");

    for await (const event of handle) {
      // Update session ID if we get one
      if ("sessionId" in event && event.sessionId) {
        this._sessionId = event.sessionId;
      }

      switch (event.type) {
        case "content_delta":
          if ("delta" in event) {
            const delta = (event as { delta: string }).delta;
            response += delta;
            this.emit("stream:delta", { text: delta });
          }
          break;

        case "tool_call_start":
          if ("name" in event) {
            const toolStart = event as unknown as { name: string; input?: Record<string, unknown> };
            this.emit("tool:start", {
              name: toolStart.name,
              args: toolStart.input ?? {},
            });
          }
          break;

        case "tool_result":
          if ("name" in event) {
            const toolResult = event as unknown as { name: string; result?: unknown };
            this.emit("tool:end", {
              name: toolResult.name,
              result: toolResult.result,
            });
          }
          break;
      }
    }

    this.emit("stream:end");

    // Get final result
    try {
      const result = await handle.result;
      if (result?.response) {
        response =
          typeof result.response === "string" ? result.response : JSON.stringify(result.response);
      }

      this.emit("message:received", {
        content: response,
        tokens: result?.usage
          ? {
              input: result.usage.inputTokens ?? 0,
              output: result.usage.outputTokens ?? 0,
            }
          : undefined,
      });
    } catch (error) {
      // Result might fail if we already consumed the stream
      if (!response) {
        throw error;
      }
    }

    return response;
  }

  /**
   * Send a message and stream the response
   */
  async *stream(message: string): AsyncGenerator<{ type: string; data: unknown }> {
    const handle = this.client.send(message, {
      sessionId: this._sessionId,
    });

    for await (const event of handle) {
      // Update session ID
      if ("sessionId" in event && event.sessionId) {
        this._sessionId = event.sessionId;
      }

      yield { type: event.type, data: event };
    }
  }

  /**
   * Destroy the client
   */
  destroy(): void {
    this.client.destroy();
    this._isConnected = false;
  }
}

/**
 * Create a CLI instance
 */
export function createCLI(config: CLIConfig): CLI {
  return new CLI(config);
}

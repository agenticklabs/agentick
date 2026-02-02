/**
 * Agent Testing Utilities
 *
 * Provides a React Testing Library-like API for testing Tentickle agents.
 */

import { createApp } from "../app";
import type { AppOptions, SessionOptions, SendResult, ComponentFunction } from "../app/types";
import type { Session } from "../app/types";
import type { Message, ContentBlock } from "@tentickle/shared";
import type { TestModelInstance } from "./test-model";
import { createTestModel } from "./test-model";
import { flushMicrotasks } from "./act";

// ============================================================================
// Types
// ============================================================================

export interface RenderAgentOptions<P extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * Initial props for the agent component.
   */
  props?: P;

  /**
   * Model to use. If not provided, creates a default test model.
   */
  model?: TestModelInstance | ReturnType<typeof createTestModel>;

  /**
   * App options (maxTicks, etc.)
   */
  appOptions?: Omit<AppOptions, "model">;

  /**
   * Session options.
   */
  sessionOptions?: SessionOptions;

  /**
   * Whether to auto-run the first tick.
   * @default false
   */
  autoTick?: boolean;
}

export interface RenderAgentResult<P extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * The session instance.
   */
  session: Session<P>;

  /**
   * The test model (for assertions).
   */
  model: TestModelInstance;

  /**
   * Send a user message and wait for completion.
   */
  send: (message: string | Message) => Promise<SendResult>;

  /**
   * Run a tick with optional new props.
   */
  tick: (props?: P) => Promise<SendResult>;

  /**
   * Current result state (updated after each tick/send).
   */
  result: {
    current: AgentTestResult;
  };

  /**
   * Cleanup the session. Called automatically if using `cleanup()`.
   */
  unmount: () => void;

  /**
   * Rerender with new props.
   */
  rerender: (props: P) => Promise<SendResult>;
}

export interface AgentTestResult {
  /**
   * All messages in the timeline.
   */
  timeline: Message[];

  /**
   * The last assistant message text.
   */
  lastAssistantMessage: string | null;

  /**
   * The last user message text.
   */
  lastUserMessage: string | null;

  /**
   * Total number of ticks executed.
   */
  tickCount: number;

  /**
   * Current session status.
   */
  status: "idle" | "running" | "completed" | "error";

  /**
   * Any error that occurred.
   */
  error: Error | null;

  /**
   * Raw send results from all ticks.
   */
  sendResults: SendResult[];
}

// ============================================================================
// Cleanup Registry
// ============================================================================

const sessionsToCleanup: Set<Session<any>> = new Set();

/**
 * Cleanup all rendered agents.
 * Call this in afterEach() to ensure sessions are closed.
 *
 * @example
 * ```tsx
 * import { cleanup } from '@tentickle/core/testing';
 *
 * afterEach(() => {
 *   cleanup();
 * });
 * ```
 */
export function cleanup(): void {
  for (const session of sessionsToCleanup) {
    try {
      session.close();
    } catch {
      // Ignore errors during cleanup
    }
  }
  sessionsToCleanup.clear();
}

// ============================================================================
// Main API
// ============================================================================

/**
 * Render an agent for testing.
 *
 * Similar to React Testing Library's `render()`, but for Tentickle agents.
 *
 * @example
 * ```tsx
 * import { renderAgent, cleanup, act } from '@tentickle/core/testing';
 *
 * afterEach(() => cleanup());
 *
 * test('agent responds to user messages', async () => {
 *   const { send, result, model } = renderAgent(MyAgent, {
 *     props: { systemPrompt: "You are helpful" },
 *   });
 *
 *   await act(async () => {
 *     await send("Hello!");
 *   });
 *
 *   expect(result.current.lastAssistantMessage).toBe("Test response");
 *   expect(model.getCapturedInputs()).toHaveLength(1);
 * });
 * ```
 *
 * @example With custom model
 * ```tsx
 * const { send, result } = renderAgent(MyAgent, {
 *   model: createTestModel({
 *     defaultResponse: "Custom response",
 *     delay: 10,
 *   }),
 * });
 * ```
 */
export function renderAgent<P extends Record<string, unknown> = Record<string, unknown>>(
  Agent: ComponentFunction<P>,
  options: RenderAgentOptions<P> = {},
): RenderAgentResult<P> {
  const {
    props = {} as P,
    model = createTestModel(),
    appOptions = {},
    sessionOptions,
    autoTick = false,
  } = options;

  // Create app and session
  const app = createApp(Agent, {
    ...appOptions,
    model: model as any,
    maxTicks: appOptions.maxTicks ?? 1,
  });

  const session = sessionOptions ? app.session(sessionOptions) : app.session();

  // Register for cleanup
  sessionsToCleanup.add(session);

  // Result state
  const resultState: AgentTestResult = {
    timeline: [],
    lastAssistantMessage: null,
    lastUserMessage: null,
    tickCount: 0,
    status: "idle",
    error: null,
    sendResults: [],
  };

  const result = {
    current: resultState,
  };

  // Helper to update result state
  const updateResult = (sendResult: SendResult) => {
    resultState.sendResults.push(sendResult);
    resultState.tickCount++;

    // Extract timeline messages from raw COMInput
    if (sendResult.raw?.timeline) {
      resultState.timeline = sendResult.raw.timeline
        .map((entry: any) => entry.message)
        .filter((m: Message | undefined): m is Message => !!m);
    }

    // Find last assistant message
    const assistantMessages = resultState.timeline.filter((m) => m.role === "assistant");
    if (assistantMessages.length > 0) {
      const last = assistantMessages[assistantMessages.length - 1];
      resultState.lastAssistantMessage = extractText(last.content as ContentBlock[]);
    }

    // Find last user message
    const userMessages = resultState.timeline.filter((m) => m.role === "user");
    if (userMessages.length > 0) {
      const last = userMessages[userMessages.length - 1];
      resultState.lastUserMessage = extractText(last.content as ContentBlock[]);
    }

    resultState.status = "completed";
  };

  // Send function
  const send = async (message: string | Message): Promise<SendResult> => {
    resultState.status = "running";
    resultState.error = null;

    try {
      const messageObj: Message =
        typeof message === "string"
          ? { role: "user", content: [{ type: "text", text: message }] }
          : message;

      const handle = session.send({ message: messageObj });
      const sendResult = await handle.result;
      updateResult(sendResult);
      await flushMicrotasks();
      return sendResult;
    } catch (error) {
      resultState.status = "error";
      resultState.error = error as Error;
      throw error;
    }
  };

  // Tick function
  const tick = async (newProps?: P): Promise<SendResult> => {
    resultState.status = "running";
    resultState.error = null;

    try {
      const handle = session.tick(newProps ?? props);
      const sendResult = await handle.result;
      updateResult(sendResult);
      await flushMicrotasks();
      return sendResult;
    } catch (error) {
      resultState.status = "error";
      resultState.error = error as Error;
      throw error;
    }
  };

  // Rerender function
  const rerender = async (newProps: P): Promise<SendResult> => {
    return tick(newProps);
  };

  // Unmount function
  const unmount = () => {
    session.close();
    sessionsToCleanup.delete(session);
  };

  // Auto-tick if requested
  if (autoTick) {
    // This is sync but the tick happens async
    // User should await or use act()
    tick(props).catch((err) => {
      resultState.error = err;
      resultState.status = "error";
    });
  }

  return {
    session,
    model: model as TestModelInstance,
    send,
    tick,
    result,
    unmount,
    rerender,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract text from content blocks.
 */
function extractText(content: ContentBlock[]): string {
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

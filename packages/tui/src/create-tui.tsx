/**
 * createTUI — entry point for the terminal UI.
 *
 * Supports local (in-process) and remote (gateway) agents.
 * The TUI components don't know or care about local vs remote.
 * Same hooks, same rendering. The transport determines where the agent lives.
 *
 * @example Local
 * ```typescript
 * createTUI({ app: myApp }).start();
 * ```
 *
 * @example Remote
 * ```typescript
 * createTUI({ url: 'https://my-agent.fly.dev/api' }).start();
 * ```
 *
 * @example Custom UI
 * ```typescript
 * createTUI({ app: myApp, ui: MyDashboard }).start();
 * ```
 *
 * @module @agentick/tui/create-tui
 */

import type { ComponentType } from "react";
import { render } from "ink";
import { createClient } from "@agentick/client";
import { createLocalTransport } from "@agentick/core";
import { AgentickProvider } from "@agentick/react";
import { Chat } from "./ui/chat.js";
import type { App } from "@agentick/core";
import EventSourcePolyfill from "eventsource";

/** A TUI component receives a sessionId and renders the full interface. */
export type TUIComponent = ComponentType<{ sessionId: string }>;

export type TUIOptions =
  | { app: App; sessionId?: string; ui?: TUIComponent }
  | { url: string; token?: string; sessionId?: string; ui?: TUIComponent };

export function createTUI(options: TUIOptions) {
  return {
    start() {
      const sessionId = options.sessionId ?? "main";
      const Component = options.ui ?? Chat;

      const client =
        "app" in options
          ? createClient({
              baseUrl: "local://",
              transport: createLocalTransport(options.app),
            })
          : createClient({
              baseUrl: options.url,
              token: options.token,
              EventSource: (globalThis.EventSource ??
                EventSourcePolyfill) as unknown as typeof EventSource,
            });

      const { waitUntilExit } = render(
        <AgentickProvider client={client}>
          <Component sessionId={sessionId} />
        </AgentickProvider>,
        { exitOnCtrlC: false },
      );

      return waitUntilExit();
    },
  };
}

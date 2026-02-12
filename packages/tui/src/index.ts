/**
 * @agentick/tui - Terminal UI for Agentick
 *
 * Ink-based terminal UI that reuses @agentick/react hooks.
 * Works with both local (in-process) and remote agents.
 *
 * @example Local agent
 * ```typescript
 * import { createApp } from '@agentick/core';
 * import { createTUI } from '@agentick/tui';
 *
 * const app = createApp(MyAgent, { model });
 * createTUI({ app }).start();
 * ```
 *
 * @example Remote agent
 * ```typescript
 * import { createTUI } from '@agentick/tui';
 *
 * createTUI({ url: 'https://my-agent.fly.dev/api' }).start();
 * ```
 *
 * @example Custom UI
 * ```typescript
 * import { createTUI } from '@agentick/tui';
 * import { MyDashboard } from './my-dashboard.js';
 *
 * createTUI({ app, ui: MyDashboard }).start();
 * ```
 *
 * @module @agentick/tui
 */

export { createTUI, type TUIOptions, type TUIComponent } from "./create-tui.js";

// Built-in UIs
export { Chat } from "./ui/chat.js";

// Components for custom UI composition
export { MessageList } from "./components/MessageList.js";
export { StreamingMessage } from "./components/StreamingMessage.js";
export { ToolCallIndicator } from "./components/ToolCallIndicator.js";
export { ToolConfirmationPrompt } from "./components/ToolConfirmationPrompt.js";
export { ErrorDisplay } from "./components/ErrorDisplay.js";
export { InputBar } from "./components/InputBar.js";
export { default as Spinner } from "ink-spinner";

export { TelegramPlugin, type TelegramPluginOptions } from "./telegram-plugin.js";
export { escapeMarkdownV2 } from "./telegram-format.js";
export { parseTextConfirmation, formatConfirmationMessage } from "./confirmation-utils.js";

/** Module augmentation — makes FileConfig.connectors.telegram typed */
declare module "@agentick/gateway" {
  interface ConnectorConfigs {
    telegram?: {
      token: string;
      allowedUsers?: number[];
      chatId?: number;
      confirmationStyle?: "inline-keyboard" | "text";
    };
  }
}

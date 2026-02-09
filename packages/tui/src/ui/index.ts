import { Chat } from "./chat.js";

export { Chat };

/** Registry of built-in UIs, keyed by CLI name. */
export const builtinUIs = { chat: Chat };

export type BuiltinUIName = keyof typeof builtinUIs;

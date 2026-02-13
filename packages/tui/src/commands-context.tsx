import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { SlashCommand } from "./commands.js";

const CommandsConfigContext = createContext<(SlashCommand | SlashCommand[])[]>([]);

interface CommandsProviderProps {
  commands: (SlashCommand | SlashCommand[])[];
  children: ReactNode;
}

export function CommandsProvider({ commands, children }: CommandsProviderProps) {
  return (
    <CommandsConfigContext.Provider value={commands}>{children}</CommandsConfigContext.Provider>
  );
}

export function useCommandsConfig(): (SlashCommand | SlashCommand[])[] {
  return useContext(CommandsConfigContext);
}

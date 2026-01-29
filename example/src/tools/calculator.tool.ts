import { createTool } from "@tentickle/core/tool";
import { Logger } from "@tentickle/core/core";
import { type ContentBlock } from "@tentickle/shared";
import { z } from "zod";

const log = Logger.for("CalculatorTool");

const CalculatorInputSchema = z.object({
  expression: z.string().describe('Mathematical expression to evaluate (e.g., "2 + 2")'),
});

type CalculatorInput = z.infer<typeof CalculatorInputSchema>;

export const CalculatorTool = createTool({
  name: "calculator",
  description: "Performs mathematical calculations",
  input: CalculatorInputSchema,
  handler: async (input: CalculatorInput): Promise<ContentBlock[]> => {
    log.debug({ expression: input.expression }, "Evaluating expression");
    try {
      // Simple safe evaluation (in production, use a proper math parser)
      const result = Function(`"use strict"; return (${input.expression})`)();
      log.info({ expression: input.expression, result }, "Calculation complete");
      return [{ type: "text", text: `${input.expression} = ${result}` }];
    } catch (error: any) {
      log.warn({ expression: input.expression, err: error }, "Calculation failed");
      return [
        { type: "text", text: `Error: Invalid expression "${input.expression}": ${error.message}` },
      ];
    }
  },
});

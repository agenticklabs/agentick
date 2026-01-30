/**
 * Calculator Tool
 *
 * A simple tool that evaluates mathematical expressions.
 * Demonstrates basic tool creation with Zod schema validation.
 */

import { createTool } from "@tentickle/core";
import { z } from "zod";

/**
 * Calculator tool for mathematical expressions.
 *
 * @example
 * ```tsx
 * function MyAgent() {
 *   return (
 *     <>
 *       <CalculatorTool />
 *       <Model />
 *     </>
 *   );
 * }
 * ```
 */
export const CalculatorTool = createTool({
  name: "calculator",
  description:
    "Evaluates a mathematical expression and returns the result. " +
    "Supports basic arithmetic (+, -, *, /), parentheses, and common math functions (Math.sqrt, Math.pow, etc.).",
  input: z.object({
    expression: z
      .string()
      .describe("The mathematical expression to evaluate, e.g., '2 + 2' or 'Math.sqrt(16)'"),
  }),
  handler: async ({ expression }) => {
    try {
      // Safe evaluation using Function constructor
      // Only allows mathematical operations
      const sanitized = expression.replace(/[^0-9+\-*/().Math sqrtpowabsceilfloorround\s]/g, "");

      if (sanitized !== expression) {
        return [
          {
            type: "text" as const,
            text: `Error: Expression contains invalid characters. Only numbers, operators (+, -, *, /), parentheses, and Math functions are allowed.`,
          },
        ];
      }

      // Create a sandboxed evaluation context
      const mathContext = {
        Math: {
          sqrt: Math.sqrt,
          pow: Math.pow,
          abs: Math.abs,
          ceil: Math.ceil,
          floor: Math.floor,
          round: Math.round,
        },
      };

      // Evaluate the expression
      const evalFn = new Function("Math", `"use strict"; return (${expression})`);
      const result = evalFn(mathContext.Math);

      if (typeof result !== "number" || !isFinite(result)) {
        return [
          {
            type: "text" as const,
            text: `Error: Expression "${expression}" did not produce a valid number.`,
          },
        ];
      }

      return [
        {
          type: "text" as const,
          text: `${expression} = ${result}`,
        },
      ];
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return [
        {
          type: "text" as const,
          text: `Error evaluating "${expression}": ${message}`,
        },
      ];
    }
  },
});

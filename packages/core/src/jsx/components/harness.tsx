/**
 * Harness component - spawns a child runtime for sub-agent execution
 *
 * Harness creates a child session with its own tick loop. Props flow down
 * to the child component, results flow up via onResult callback. The parent
 * orchestrates while children execute independently.
 *
 * @example
 * ```tsx
 * const Pipeline = ({ query }) => {
 *   const [research, setResearch] = useState(null);
 *
 *   return (
 *     <>
 *       <Harness
 *         name="researcher"
 *         component={ResearchAgent}
 *         props={{ query }}
 *         onResult={(result) => setResearch(result.outputs.findings)}
 *       />
 *       {research && (
 *         <Harness
 *           name="synthesizer"
 *           component={SynthesisAgent}
 *           props={{ research }}
 *         />
 *       )}
 *     </>
 *   );
 * };
 * ```
 *
 * @module tentickle/components/harness
 */

import React, { useEffect, useRef } from "react";
import type { JSX } from "react";
import { COM } from "../../com/object-model";
import { type ComponentBaseProps } from "../jsx-types";
import { SessionImpl } from "../../app/session";
import type { ComponentFunction, SendResult, AppOptions, SessionOptions } from "../../app/types";
import type { ModelInstance } from "../../model/model";

/**
 * Context for harness topology awareness.
 */
export interface HarnessContext {
  /** Name of this harness */
  name: string;
  /** Parent harness name (if nested) */
  parent?: string;
  /** Full path from root */
  path: string[];
  /** Depth in harness tree */
  depth: number;
}

/**
 * Props for Harness component.
 */
export interface HarnessProps<P = Record<string, unknown>> extends ComponentBaseProps {
  /**
   * Name for this harness (for identification and debugging).
   */
  name: string;

  /**
   * Component function to execute in the child session.
   */
  component: ComponentFunction<P>;

  /**
   * Props to pass to the child component.
   */
  props: P;

  /**
   * Model to use for the child session.
   * If not provided, inherits from parent context.
   */
  model?: ModelInstance;

  /**
   * Callback when child execution completes.
   */
  onResult?: (result: SendResult) => void | Promise<void>;

  /**
   * Callback when child execution errors.
   */
  onError?: (error: Error) => void | Promise<void>;

  /**
   * Whether to wait for completion before allowing parent tick to continue.
   * @default false
   */
  waitUntilComplete?: boolean;

  /**
   * Maximum ticks for child execution.
   */
  maxTicks?: number;

  /**
   * Session options for the child session.
   */
  sessionOptions?: SessionOptions;
}

// Global context for harness topology (using WeakMap to avoid memory leaks)
const harnessContextMap = new WeakMap<object, HarnessContext>();

/**
 * Get the current harness context (for use in components).
 * Returns undefined if not inside a harness.
 */
export function getHarnessContext(com: COM): HarnessContext | undefined {
  return harnessContextMap.get(com);
}

/**
 * Harness component for spawning child agent sessions.
 *
 * Uses React hooks for lifecycle management.
 *
 * @example
 * ```tsx
 * <Harness
 *   name="research"
 *   component={ResearchAgent}
 *   props={{ query: "climate change" }}
 *   onResult={(result) => handleResult(result)}
 * />
 * ```
 */
export function Harness<P = Record<string, unknown>>(props: HarnessProps<P>): JSX.Element | null {
  const {
    name,
    component,
    props: childProps,
    model,
    onResult,
    onError,
    maxTicks,
    sessionOptions,
  } = props;

  const sessionRef = useRef<SessionImpl<P> | null>(null);
  const hasStartedRef = useRef(false);

  // Start execution on mount
  useEffect(() => {
    if (hasStartedRef.current) return;
    hasStartedRef.current = true;

    // Build app options
    const appOptions: AppOptions = {};
    if (model) {
      appOptions.model = model;
    }
    if (maxTicks) {
      appOptions.maxTicks = maxTicks;
    }

    // Create child session
    const session = new SessionImpl<P>(component, appOptions, sessionOptions);
    sessionRef.current = session;

    // Execute child session
    session
      .tick(childProps)
      .result.then((result) => {
        if (onResult) {
          return Promise.resolve(onResult(result)).then(() => result);
        }
        return result;
      })
      .catch((err: Error) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (onError) {
          onError(error);
        }
      })
      .finally(() => {
        // Clean up session
        if (sessionRef.current) {
          sessionRef.current.close();
          sessionRef.current = null;
        }
      });

    // Cleanup on unmount
    return () => {
      if (sessionRef.current) {
        sessionRef.current.close();
        sessionRef.current = null;
      }
    };
  }, [name, component, childProps, model, maxTicks, sessionOptions, onResult, onError]);

  // Harness doesn't render any content to parent context
  return null;
}

// Export HarnessComponent as an alias for backwards compatibility
export const HarnessComponent = Harness;

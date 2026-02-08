/**
 * # Agentick Context Object Model (COM)
 *
 * The Context Object Model is the intermediate representation between JSX components
 * and model input. Components render to the COM, which is then compiled into the
 * format expected by AI models.
 *
 * ## Features
 *
 * - **Sections** - Organize content into logical groups (system, user, assistant)
 * - **Timeline** - Message history with role-based entries
 * - **State Management** - Shared state across components via COM
 * - **Tick Control** - Stop/continue execution based on conditions
 *
 * ## Architecture
 *
 * ```
 * JSX Components → COM (Context Object Model) → Model Input
 * ```
 *
 * @see {@link COM} - Main COM class
 * @see {@link COMSection} - Section structure
 * @see {@link COMTimelineEntry} - Timeline entry structure
 *
 * @module agentick/com
 */

export * from "./object-model";
export * from "./types";

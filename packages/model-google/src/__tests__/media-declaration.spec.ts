/**
 * `google()`'s `capabilities.media` declaration, bound to what it actually puts on the
 * wire. The framework enforces the declaration, so a declaration that drifts from this
 * adapter's real projection silently drops media that works — or forwards media that gets
 * rejected, which is the bug that started all of this.
 *
 * No Gemini-shaped assertions here any more: `detectDroppedInputs` answers "did this reach
 * the wire" generically, so the hand-written `inlineData` / `fileData` predicate this file
 * used to carry is gone.
 */

import { runMediaDeclarationCheck } from "@agentick/model/testing";

import { google } from "../google-adapter.js";

runMediaDeclarationCheck(google("gemini-2.0-flash"));

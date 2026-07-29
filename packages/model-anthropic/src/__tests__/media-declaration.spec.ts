/**
 * `anthropic()`'s `capabilities.media` declaration, bound to the blocks it really emits.
 *
 * This adapter is why the declaration exists. Its message projection has NO `audio` or
 * `video` arm — those parts fall off the end of the switch, so there is no `null` for any
 * decline-reporting convention to observe. The declaration states the hole; this proves
 * the statement is true.
 */

import { runMediaDeclarationCheck } from "@agentick/model/testing";

import { anthropic } from "../anthropic-adapter.js";

runMediaDeclarationCheck(anthropic("claude-sonnet-4-5"));

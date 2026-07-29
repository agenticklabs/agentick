/**
 * `openai()`'s `capabilities.media` declaration, bound to its real Chat Completions
 * projection.
 *
 * Worth checking per modality rather than as one flag, because this adapter genuinely
 * gives three different answers: `image_url` takes a URL or a data URI, a `file` part
 * takes inline base64 or a Files API `file_id` and has NO url form, `input_audio` takes
 * base64 only, and video has no Chat Completions part at all.
 */

import { runMediaDeclarationCheck } from "@agentick/model/testing";

import { openai } from "../openai-adapter.js";

runMediaDeclarationCheck(openai("gpt-4o"));

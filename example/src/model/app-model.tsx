import { Model } from "@tentickle/core/jsx";
import { createGoogleModel } from "@tentickle/google";
import { createOpenAIModel } from "@tentickle/openai";
import { useComputed, useComState } from "@tentickle/core/hooks";

/**
 * MyModel - Dynamic model selection component
 *
 * Uses environment variables to configure:
 * - USE_GOOGLE_MODEL: "true" to use Google, otherwise OpenAI
 * - OPENAI_API_KEY: OpenAI API key
 * - OPENAI_MODEL: OpenAI model name (default: gpt-4o-mini)
 * - GOOGLE_API_KEY: Google AI API key (for non-Vertex usage)
 * - GOOGLE_MODEL: Google model name (default: gemini-2.0-flash)
 *
 * For Vertex AI, set:
 * - GCP_PROJECT_ID: Google Cloud project ID
 * - GCP_LOCATION: Region (default: us-central1)
 * - GCP_CREDENTIALS: Base64-encoded service account JSON
 */

// Parse Google credentials if provided
const GOOGLE_CREDENTIALS = process.env["GCP_CREDENTIALS"]
  ? JSON.parse(Buffer.from(process.env["GCP_CREDENTIALS"], "base64").toString("utf8"))
  : undefined;

export function MyModel() {
  // COM-bound state - persistent across ticks
  const useGoogle = useComState<boolean>("useGoogle", process.env["USE_GOOGLE_MODEL"] === "true");
  const openaiModelName = useComState<string>(
    "openaiModel",
    process.env["OPENAI_MODEL"] || "gpt-4o-mini",
  );
  const googleModelName = useComState<string>(
    "googleModel",
    process.env["GOOGLE_MODEL"] || "gemini-2.0-flash",
  );

  // Create the appropriate model based on state
  const model = useComputed(() => {
    if (useGoogle()) {
      // Use Google/Vertex AI
      return createGoogleModel({
        model: googleModelName(),
        apiKey: process.env["GOOGLE_API_KEY"],
        // Vertex AI config (if using Vertex instead of AI Studio)
        vertexai: !!process.env["GCP_PROJECT_ID"],
        project: process.env["GCP_PROJECT_ID"],
        location: process.env["GCP_LOCATION"] || "us-central1",
        googleAuthOptions: GOOGLE_CREDENTIALS ? { credentials: GOOGLE_CREDENTIALS } : undefined,
      });
    } else {
      // Use OpenAI
      return createOpenAIModel({
        model: openaiModelName(),
        apiKey: process.env["OPENAI_API_KEY"],
        baseURL: process.env["OPENAI_BASE_URL"],
      });
    }
  }, [useGoogle, googleModelName, openaiModelName]);

  return <Model model={model()} />;
}

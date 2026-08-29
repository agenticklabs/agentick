/**
 * The Google provider's `image-model` and `embedding-model` family factories
 * (ADR 105) — `google.images(...)` / `google.embeddings(...)`, the modality
 * siblings of `google(...)`. Same options, same client resolution.
 *
 * Developer API by design (Vertex is not this adapter's endpoint — see the
 * `gs://` note in `google-adapter.ts`): a prompt-only call is Imagen via
 * `models.generateImages`; a call carrying `references` is an EDIT and routes
 * to the Gemini image model via `generateContent` with an IMAGE response
 * modality, the references riding as parts. Vertex-only verbs (`upscaleImage`,
 * `outputGcsUri`) are not modeled. Embeddings are `models.embedContent`.
 */

import type {
  EmbedResult,
  EmbeddingModelAdapter,
  ExecutionTarget,
  GeneratedImage,
  ImageGenerateInput,
  ImageGenerateResult,
  ImageModelAdapter,
} from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";
import type { GenerateContentResponse, Part } from "@google/genai";
import { GoogleGenAI } from "@google/genai";

import {
  buildClientOptions,
  googlePartFromSource,
  type GoogleAdapterOptions,
} from "./google-adapter.js";

const DEFAULT_IMAGE_MODEL = "imagen-4.0-generate-001";
/** The image-capable generation model edits route to when `references` are present. */
const DEFAULT_EDIT_MODEL = "gemini-2.5-flash-image";
const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";

/** The slice of the genai client the modality adapters use — injectable for tests. */
export interface GoogleModalityClient {
  readonly models: {
    generateImages(params: {
      model: string;
      prompt: string;
      config?: Record<string, unknown>;
    }): Promise<{
      generatedImages?: Array<{
        image?: { imageBytes?: string; mimeType?: string };
        enhancedPrompt?: string;
      }>;
    }>;
    generateContent(params: {
      model: string;
      contents: unknown;
      config?: Record<string, unknown>;
    }): Promise<GenerateContentResponse>;
    embedContent(params: {
      model: string;
      contents: unknown;
      config?: Record<string, unknown>;
    }): Promise<{ embeddings?: Array<{ values?: number[] }> }>;
  };
}

export interface GoogleImagesOptions extends Omit<GoogleAdapterOptions, "client"> {
  readonly client?: GoogleModalityClient;
  /** The model an edit (a call with `references`) routes to. Default `gemini-2.5-flash-image`. */
  readonly editModel?: string;
}

export interface GoogleEmbeddingsOptions extends Omit<GoogleAdapterOptions, "client"> {
  readonly client?: GoogleModalityClient;
}

function clientFor(
  options: { client?: GoogleModalityClient } & GoogleAdapterOptions,
): () => GoogleModalityClient {
  let memo: GoogleModalityClient | undefined = options.client;
  return () =>
    (memo ??= new GoogleGenAI(buildClientOptions(options)) as unknown as GoogleModalityClient);
}

function imageBlocks(images: readonly GeneratedImage[]): ImageGenerateResult["output"] {
  return images.map((image) => ({
    type: "image" as const,
    source: { type: "base64" as const, data: image.data, mimeType: image.mimeType },
  }));
}

export function googleImages(
  model = DEFAULT_IMAGE_MODEL,
  options: GoogleImagesOptions = {},
): ImageModelAdapter {
  const client = clientFor(options as GoogleAdapterOptions & { client?: GoogleModalityClient });
  const editModel = options.editModel ?? DEFAULT_EDIT_MODEL;
  const target: ExecutionTarget = {
    kind: "image-model",
    provider: "google",
    modelId: model,
    ...(options.target?.pricing !== undefined ? { pricing: options.target.pricing } : {}),
  };

  return {
    provider: "google",
    target,
    async generate(input, signal): Promise<ImageGenerateResult> {
      const mimeType = input.mimeType ?? "image/png";
      const images =
        input.references !== undefined && input.references.length > 0
          ? await editWithGemini(client(), editModel, input, signal)
          : await generateWithImagen(client(), model, input, mimeType, signal);
      return {
        specVersion: SPEC_VERSION,
        output: imageBlocks(images),
        images,
        finishMetadata: { model: input.references?.length ? editModel : model },
      };
    },
  };
}

async function generateWithImagen(
  client: GoogleModalityClient,
  model: string,
  input: ImageGenerateInput,
  mimeType: string,
  signal: AbortSignal | undefined,
): Promise<GeneratedImage[]> {
  const res = await client.models.generateImages({
    model,
    prompt: input.prompt,
    config: {
      numberOfImages: input.count ?? 1,
      outputMimeType: mimeType,
      ...(input.aspectRatio !== undefined ? { aspectRatio: input.aspectRatio } : {}),
      ...(input.negativePrompt !== undefined ? { negativePrompt: input.negativePrompt } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      ...(signal !== undefined ? { abortSignal: signal } : {}),
      ...(input.providerOptions ?? {}),
    },
  });
  const images: GeneratedImage[] = [];
  for (const generated of res.generatedImages ?? []) {
    const bytes = generated.image?.imageBytes;
    if (!bytes) continue;
    images.push({
      data: bytes,
      mimeType: generated.image?.mimeType ?? mimeType,
      ...(generated.enhancedPrompt !== undefined
        ? { enhancedPrompt: generated.enhancedPrompt }
        : {}),
    });
  }
  if (images.length === 0) throw new Error(`google images: "${model}" returned no image bytes`);
  return images;
}

async function editWithGemini(
  client: GoogleModalityClient,
  model: string,
  input: ImageGenerateInput,
  signal: AbortSignal | undefined,
): Promise<GeneratedImage[]> {
  const parts: Part[] = [{ text: input.prompt }];
  for (const ref of input.references ?? []) {
    const part = googlePartFromSource(
      ref,
      ref.type === "reference" ? ref.mimeType : ref.mimeType,
      "image/png",
    );
    if (part) parts.push(part);
  }
  const res = await client.models.generateContent({
    model,
    contents: [{ role: "user", parts }],
    config: {
      responseModalities: ["IMAGE", "TEXT"],
      ...(signal !== undefined ? { abortSignal: signal } : {}),
      ...(input.providerOptions ?? {}),
    },
  });
  const images: GeneratedImage[] = [];
  for (const candidate of res.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const inline = part.inlineData;
      if (inline?.data)
        images.push({ data: inline.data, mimeType: inline.mimeType ?? "image/png" });
    }
  }
  if (images.length === 0) throw new Error(`google images: "${model}" returned no image parts`);
  return images;
}

export function googleEmbeddings(
  model = DEFAULT_EMBEDDING_MODEL,
  options: GoogleEmbeddingsOptions = {},
): EmbeddingModelAdapter {
  const client = clientFor(options as GoogleAdapterOptions & { client?: GoogleModalityClient });
  const target: ExecutionTarget = {
    kind: "embedding-model",
    provider: "google",
    modelId: model,
    ...(options.target?.pricing !== undefined ? { pricing: options.target.pricing } : {}),
  };

  return {
    provider: "google",
    target,
    async embed(input, signal): Promise<EmbedResult> {
      const res = await client().models.embedContent({
        model,
        contents: input.input.map((text) => ({ role: "user", parts: [{ text }] })),
        config: {
          ...(input.dimensions !== undefined ? { outputDimensionality: input.dimensions } : {}),
          ...(input.task !== undefined
            ? { taskType: input.task === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" }
            : {}),
          ...(signal !== undefined ? { abortSignal: signal } : {}),
          ...(input.providerOptions ?? {}),
        },
      });
      const embeddings = (res.embeddings ?? []).map((e) => e.values ?? []);
      if (embeddings.length !== input.input.length) {
        throw new Error(
          `google embeddings: expected ${input.input.length} vectors, got ${embeddings.length}`,
        );
      }
      return {
        specVersion: SPEC_VERSION,
        output: [],
        embeddings,
        dimensions: embeddings[0]?.length ?? input.dimensions ?? 0,
      };
    },
  };
}

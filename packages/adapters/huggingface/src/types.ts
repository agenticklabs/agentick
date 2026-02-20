export interface HuggingFaceEmbeddingConfig {
  /** Model ID from HuggingFace Hub. Default: "Xenova/all-MiniLM-L6-v2" */
  model?: string;
  /** Output dimensions. Default: 384 (derived from model) */
  dimensions?: number;
  /** Cache directory for model files. Default: HF default (~/.cache/huggingface/hub/) */
  cacheDir?: string;
  /** Data type for model weights. Default: "fp32" */
  dtype?: "auto" | "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "bnb4" | "q4f16";
}

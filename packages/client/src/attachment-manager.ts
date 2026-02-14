import type { ContentBlock } from "@agentick/shared";
import type {
  Attachment,
  AttachmentInput,
  AttachmentSource,
  AttachmentManagerOptions,
  AttachmentValidator,
  AttachmentToBlock,
} from "./chat-types.js";

const DEFAULT_MAX_ATTACHMENTS = 10;

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

let attachmentIdCounter = 0;

function generateAttachmentId(): string {
  return `att_${Date.now()}_${++attachmentIdCounter}`;
}

function isUrl(value: string): boolean {
  return /^https?:\/\//.test(value) || /^data:/.test(value) || /^blob:/.test(value);
}

function normalizeSource(source: string | AttachmentSource): AttachmentSource {
  if (typeof source !== "string") return source;
  if (isUrl(source)) return { type: "url", url: source };
  return { type: "base64", data: source };
}

export const defaultAttachmentValidator: AttachmentValidator = (input) => {
  if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
    return {
      valid: false,
      reason: `Unsupported mime type: ${input.mimeType}. Allowed: ${[...ALLOWED_MIME_TYPES].join(", ")}`,
    };
  }
  return { valid: true };
};

export const defaultAttachmentToBlock: AttachmentToBlock = (attachment): ContentBlock => {
  if (attachment.mimeType.startsWith("image/")) {
    return {
      type: "image",
      source: attachment.source,
      mimeType: attachment.mimeType,
    } as ContentBlock;
  }
  return {
    type: "document",
    source: attachment.source,
    mimeType: attachment.mimeType,
    title: attachment.name,
  } as ContentBlock;
};

/**
 * Manages a list of file attachments for multimodal messages.
 *
 * Pure client-side state — no server event subscription.
 * Platforms add/remove attachments, `consume()` converts to ContentBlock[]
 * and clears atomically.
 */
export class AttachmentManager {
  private _attachments: Attachment[] = [];
  private readonly _validator: AttachmentValidator;
  private readonly _toBlock: AttachmentToBlock;
  private readonly _maxAttachments: number;
  private _listeners = new Set<() => void>();

  constructor(options: AttachmentManagerOptions = {}) {
    this._validator = options.validator ?? defaultAttachmentValidator;
    this._toBlock = options.toBlock ?? defaultAttachmentToBlock;
    this._maxAttachments = options.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS;
  }

  get attachments(): readonly Attachment[] {
    return this._attachments;
  }

  get count(): number {
    return this._attachments.length;
  }

  get isEmpty(): boolean {
    return this._attachments.length === 0;
  }

  add(input: AttachmentInput): Attachment {
    if (this._attachments.length >= this._maxAttachments) {
      throw new Error(`Maximum attachments (${this._maxAttachments}) reached`);
    }

    const result = this._validator(input);
    if (!result.valid) {
      throw new Error(`Invalid attachment: ${result.reason}`);
    }

    const attachment: Attachment = {
      id: generateAttachmentId(),
      name: input.name,
      mimeType: input.mimeType,
      source: normalizeSource(input.source),
      size: input.size,
    };

    this._attachments = [...this._attachments, attachment];
    this._notify();
    return attachment;
  }

  remove(id: string): void {
    const before = this._attachments.length;
    this._attachments = this._attachments.filter((a) => a.id !== id);
    if (this._attachments.length !== before) {
      this._notify();
    }
  }

  clear(): void {
    if (this._attachments.length === 0) return;
    this._attachments = [];
    this._notify();
  }

  consume(): ContentBlock[] {
    if (this._attachments.length === 0) return [];
    const blocks = this._attachments.map(this._toBlock);
    this._attachments = [];
    this._notify();
    return blocks;
  }

  onStateChange(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  destroy(): void {
    this._attachments = [];
    this._listeners.clear();
  }

  private _notify(): void {
    for (const listener of this._listeners) {
      try {
        listener();
      } catch {
        // Listeners should not throw
      }
    }
  }
}

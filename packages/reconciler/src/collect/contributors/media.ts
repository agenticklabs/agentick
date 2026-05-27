/**
 * Media content-block contributors: image / document / audio / video.
 *
 * Each emits a single `content-block` IRFragment with the matching
 * block-type discriminator. They fold into the enclosing section /
 * message's `content[]` via `foldContentBlocks` — never appear as
 * top-level context entries.
 */

import type {
  AudioBlock,
  AudioMimeType,
  DocumentBlock,
  DocumentMimeType,
  ImageBlock,
  ImageMimeType,
  MediaSource,
  VideoBlock,
  VideoMimeType,
} from "@agentick/spec";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";

interface ImageProps {
  readonly source: MediaSource;
  readonly mimeType?: ImageMimeType;
  readonly altText?: string;
  readonly id?: string;
}

export const imageContributor: Contributor = {
  type: "image",
  contribute(instance: ElementInstance, _ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as ImageProps;
    if (!props.source) return missingProp("image", "source");
    const block: ImageBlock = {
      type: "image",
      source: props.source,
      ...(props.mimeType !== undefined ? { mimeType: props.mimeType } : {}),
      ...(props.altText !== undefined ? { altText: props.altText } : {}),
      ...(props.id !== undefined ? { id: props.id } : {}),
    };
    return [{ kind: "content-block", block }];
  },
};

interface DocumentProps {
  readonly source: MediaSource;
  readonly mimeType?: DocumentMimeType;
  readonly title?: string;
  readonly id?: string;
}

export const documentContributor: Contributor = {
  type: "document",
  contribute(instance: ElementInstance, _ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as DocumentProps;
    if (!props.source) return missingProp("document", "source");
    const block: DocumentBlock = {
      type: "document",
      source: props.source,
      ...(props.mimeType !== undefined ? { mimeType: props.mimeType } : {}),
      ...(props.title !== undefined ? { title: props.title } : {}),
      ...(props.id !== undefined ? { id: props.id } : {}),
    };
    return [{ kind: "content-block", block }];
  },
};

interface AudioProps {
  readonly source: MediaSource;
  readonly mimeType?: AudioMimeType;
  readonly transcript?: string;
  readonly id?: string;
}

export const audioContributor: Contributor = {
  type: "audio",
  contribute(instance: ElementInstance, _ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as AudioProps;
    if (!props.source) return missingProp("audio", "source");
    const block: AudioBlock = {
      type: "audio",
      source: props.source,
      ...(props.mimeType !== undefined ? { mimeType: props.mimeType } : {}),
      ...(props.transcript !== undefined ? { transcript: props.transcript } : {}),
      ...(props.id !== undefined ? { id: props.id } : {}),
    };
    return [{ kind: "content-block", block }];
  },
};

interface VideoProps {
  readonly source: MediaSource;
  readonly mimeType?: VideoMimeType;
  readonly transcript?: string;
  readonly id?: string;
}

export const videoContributor: Contributor = {
  type: "video",
  contribute(instance: ElementInstance, _ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as VideoProps;
    if (!props.source) return missingProp("video", "source");
    const block: VideoBlock = {
      type: "video",
      source: props.source,
      ...(props.mimeType !== undefined ? { mimeType: props.mimeType } : {}),
      ...(props.transcript !== undefined ? { transcript: props.transcript } : {}),
      ...(props.id !== undefined ? { id: props.id } : {}),
    };
    return [{ kind: "content-block", block }];
  },
};

function missingProp(type: string, prop: string): readonly IRFragment[] {
  return [
    {
      kind: "diagnostic",
      diagnostic: {
        severity: "warning",
        code: `MISSING_${prop.toUpperCase()}`,
        message: `<${type}> requires a "${prop}" prop`,
      },
    },
  ];
}

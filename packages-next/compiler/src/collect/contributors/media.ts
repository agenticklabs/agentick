/**
 * Media content-block contributors: image / document / audio / video.
 *
 * Each emits a single `content-block` IRFragment with the matching
 * block-type discriminator. They fold into the enclosing section /
 * message's `content[]` via `foldContentBlocks` — never appear as
 * top-level context entries.
 *
 * Props derive from each spec block type (minus the `type` discriminant);
 * every authored field — including the shared {@link BaseBlockKey} fields
 * (`id`, `metadata`, `providerMetadata`, `citations`, …) — forwards by
 * spread. The per-block {@link Exhausted} assertions fail `tsc` if a new
 * spec field is added without being partitioned.
 */

import type { AudioBlock, DocumentBlock, ImageBlock, VideoBlock } from "@agentick/spec-next";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";
import { omitUndefined } from "@agentick/utils-next";
import type { BaseBlockKey, Exhausted, UnhandledSpecKeys } from "./spec-conformance.js";

export type ImageProps = Omit<ImageBlock, "type">;
type _imageConformance = Exhausted<
  UnhandledSpecKeys<ImageBlock, BaseBlockKey | "source" | "altText", "type">
>;

export const imageContributor: Contributor = {
  type: "image",
  contribute(instance: ElementInstance, _ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as ImageProps;
    if (!props.source) return missingProp("image", "source");
    const block: ImageBlock = {
      ...(omitUndefined({ ...props }) as Partial<ImageBlock>),
      type: "image",
      source: props.source,
    };
    return [{ kind: "content-block", block }];
  },
};

export type DocumentProps = Omit<DocumentBlock, "type">;
type _documentConformance = Exhausted<
  UnhandledSpecKeys<DocumentBlock, BaseBlockKey | "source" | "title", "type">
>;

export const documentContributor: Contributor = {
  type: "document",
  contribute(instance: ElementInstance, _ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as DocumentProps;
    if (!props.source) return missingProp("document", "source");
    const block: DocumentBlock = {
      ...(omitUndefined({ ...props }) as Partial<DocumentBlock>),
      type: "document",
      source: props.source,
    };
    return [{ kind: "content-block", block }];
  },
};

export type AudioProps = Omit<AudioBlock, "type">;
type _audioConformance = Exhausted<
  UnhandledSpecKeys<AudioBlock, BaseBlockKey | "source" | "transcript", "type">
>;

export const audioContributor: Contributor = {
  type: "audio",
  contribute(instance: ElementInstance, _ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as AudioProps;
    if (!props.source) return missingProp("audio", "source");
    const block: AudioBlock = {
      ...(omitUndefined({ ...props }) as Partial<AudioBlock>),
      type: "audio",
      source: props.source,
    };
    return [{ kind: "content-block", block }];
  },
};

export type VideoProps = Omit<VideoBlock, "type">;
type _videoConformance = Exhausted<
  UnhandledSpecKeys<VideoBlock, BaseBlockKey | "source" | "transcript", "type">
>;

export const videoContributor: Contributor = {
  type: "video",
  contribute(instance: ElementInstance, _ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as VideoProps;
    if (!props.source) return missingProp("video", "source");
    const block: VideoBlock = {
      ...(omitUndefined({ ...props }) as Partial<VideoBlock>),
      type: "video",
      source: props.source,
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

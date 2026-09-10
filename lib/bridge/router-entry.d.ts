import { Context, Service } from "@deepseek-ai/cordis";
import http, { ServerResponse } from "node:http";
import { ZodType, z } from "zod";
import { JobId } from "@deepseek-ai/dsh-jobs/brand";
//#region node_modules/.pnpm/@deepseek-ai+dsh-scope@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2_@deepseek-ai+dsh-invariants_2fd32c0cf9230cfb915ff7d11cf8e792/node_modules/@deepseek-ai/dsh-scope/lib/types/index.d.ts
/** An opaque, identity-compared scope key. */
type ScopeKey = object;
declare const ScopedBrand: unique symbol;
/**
 * A routing-only event receiver built by {@link scopeTarget}. The type
 * parameter records the subject type for dispatch checking; the carrier does
 * not expose the subject's properties. Event payloads carry the real subject.
 */
type Scoped<T extends object> = object & {
  readonly [ScopedBrand]: T;
};
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-brand@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2/node_modules/@deepseek-ai/dsh-brand/lib/types/index.d.ts
/**
 * Duplicate-install-safe nominal primitive helpers.
 *
 * A brand makes structurally identical strings or numbers non-interchangeable
 * at the type level: a `SessionId` cannot be passed where a `ToolCallId` is
 * expected, and an event sequence cannot be passed as a log offset. Comparison,
 * logging, and serialization retain the underlying primitive behavior.
 *
 * This package owns no concrete domain value and keeps no runtime identity or mutable
 * state, so independently installed copies produce interchangeable values.
 *
 * @module @deepseek-ai/dsh-brand
 */
declare const BRAND: unique symbol;
/** A string carrying a compile-time-only brand `B`. */
type Branded<B extends string> = string & {
  readonly [BRAND]: B;
};
/** A number carrying a compile-time-only brand `B`. */
type BrandedNumber<B extends string> = number & {
  readonly [BRAND]: B;
};
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-attachment@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2_@deepseek-ai+dsh-brand_7841e9eae353fb11f43d12d9f6974d78/node_modules/@deepseek-ai/dsh-attachment/lib/types/error.d.ts
declare const ATTACHMENT_ERROR_CODES: readonly ["TOO_MANY_IMAGES", "IMAGES_TOO_LARGE", "UNSUPPORTED_IMAGE_TYPE", "INVALID_IMAGE_BASE64", "INVALID_IMAGE", "IMAGE_TYPE_MISMATCH", "IMAGE_TOO_LARGE", "IMAGE_TOO_MANY_PIXELS", "IMAGE_DIMENSION_TOO_LARGE", "INVALID_FILE_BASE64", "INVALID_ATTACHMENT_REF", "ATTACHMENT_CORRUPT", "ATTACHMENT_WRITE_FAILED", "ATTACHMENT_NOT_FOUND", "ATTACHMENT_READ_FAILED", "ATTACHMENT_PROJECTION_UNSUPPORTED", "ATTACHMENT_FILES_UNSUPPORTED"];
/** Stable attachment failure codes used for protocol error routing. */
type AttachmentErrorCode = typeof ATTACHMENT_ERROR_CODES[number];
/**
 * Stable failures suitable for host RPC error mapping.
 *
 * Deliberately re-implements the `HarnessError` shape instead of extending it:
 * the base lives in `@deepseek-ai/dsh-llm`, which itself depends on this
 * package (`ImageBlock` references `ImageAttachmentRef`), so sharing the base
 * would create a dependency cycle. Consumers route on `code`, never on the
 * prototype chain, so the shapes stay interchangeable at the wire boundary.
 */
declare class AttachmentError extends Error {
  /** Stable machine-routing failure code. */
  readonly code: AttachmentErrorCode;
  /**
   * @param message - human-readable failure description without raw bytes or host paths.
   * @param code - stable machine-routing code.
   * @param options - optional chained cause.
   */
  constructor(message: string, code: AttachmentErrorCode, options?: ErrorOptions);
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-attachment@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2_@deepseek-ai+dsh-brand_7841e9eae353fb11f43d12d9f6974d78/node_modules/@deepseek-ai/dsh-attachment/lib/types/brand.d.ts
/** Opaque content-addressed identifier for one immutable attachment object. */
type AttachmentId = Branded<'AttachmentId'>;
/**
 * Brand a validated storage identifier.
 * @param value - backend-produced opaque identifier.
 * @returns the branded identifier.
 */
declare function AttachmentId(value: string): AttachmentId;
/** Opaque deterministic identity for one request-image transformation. */
type ImageVariantId = Branded<'ImageVariantId'>;
/**
 * Brand a validated request-image transformation identifier.
 * @param value - attachment-provider-produced opaque identifier.
 * @returns the branded identifier.
 */
declare function ImageVariantId(value: string): ImageVariantId;
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-attachment@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2_@deepseek-ai+dsh-brand_7841e9eae353fb11f43d12d9f6974d78/node_modules/@deepseek-ai/dsh-attachment/lib/types/types.d.ts
/** Raster image formats accepted by the version-one attachment path. */
type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
/** Durable, serializable reference to one immutable normalized image. */
interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId;
  /** Media type verified from the stored bytes. */
  mediaType: ImageMediaType;
  /** Exact encoded byte length. */
  bytes: number;
  /** Intrinsic encoded width in pixels. */
  width: number;
  /** Intrinsic encoded height in pixels. */
  height: number;
  /** Optional display name stripped of local path information. */
  name?: string;
  /**
   * Input dimensions after applying EXIF orientation and before normalization
   * scaling. Present only when normalization reduced the image.
   */
  originalDimensions?: {
    width: number;
    height: number;
  };
}
/**
 * Durable, serializable reference to one verbatim stored file. Files are
 * stored byte-for-byte with no normalization; `attachmentId` is the sha256
 * digest of exactly those bytes.
 */
interface FileAttachmentRef {
  /** Opaque content-addressed storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId;
  /** Sanitized display filename, also the stored object's leaf name. */
  name: string;
  /** Exact byte length. */
  bytes: number;
}
/** Base64-encoded file upload accompanying one wire request. */
interface EncodedFileAttachment {
  /** Canonical base64 encoding of the file bytes. */
  data: string;
  /** Optional display name; it is never interpreted as a path. */
  name?: string;
}
/** Request to durably commit one file verbatim. */
interface SaveFileAttachment {
  data: Uint8Array;
  /** Optional browser/provider display name; it is never interpreted as a path. */
  name?: string;
}
/** Request to durably commit one file from bounded byte chunks. */
interface SaveFileStreamAttachment {
  /** Exact file bytes in order; providers must not retain the complete sequence in memory. */
  data: AsyncIterable<Uint8Array>;
  /** Optional cancellation for source reads and storage writes. */
  signal?: AbortSignal;
  /** Optional browser/provider display name; it is never interpreted as a path. */
  name?: string;
}
/** Deployment-resolved limits used by upload admission and request buffering. */
interface ImageAttachmentLimits {
  maxImageBytes: number;
  maxImagesPerMessage: number;
  maxMessageImageBytes: number;
  maxImagePixels: number;
  /** Maximum intrinsic width and maximum intrinsic height in pixels for one image. */
  maxImageDimension: number;
  mediaTypes: readonly ImageMediaType[];
}
/**
 * Browser-submitted prompt content accepted by Host prompt endpoints; the
 * accepting Host promotes image parts to durable references through
 * `ctx.attachments.admitPromptContent()` before any message is created, so a wire caller can
 * never cite an attachment it did not upload.
 */
type PromptContentPart$1 = {
  readonly type: 'text';
  readonly text: string;
} | {
  readonly type: 'image';
  readonly mediaType: ImageMediaType;
  readonly data: string;
  readonly name?: string;
};
/** Host prompt content whose file receipts are resolved and whose image bytes await admission. */
type AttachmentAdmissionPart = PromptContentPart$1 | {
  readonly type: 'file';
  readonly attachment: FileAttachmentRef;
};
/** Host-admitted prompt content with every attachment represented by its durable reference. */
type AdmittedPromptContentPart = {
  readonly type: 'text';
  readonly text: string;
} | {
  readonly type: 'image';
  readonly attachment: ImageAttachmentRef;
} | {
  readonly type: 'file';
  readonly attachment: FileAttachmentRef;
};
/** Request to validate and durably commit one image. */
interface SaveImageAttachment {
  data: Uint8Array;
  /** Caller-declared media type, checked against fully decoded bytes. */
  mediaType: ImageMediaType;
  /** Optional browser/provider display name; it is never interpreted as a path. */
  name?: string;
}
/** Stored image bytes returned after reference and digest verification. */
interface StoredImageAttachment {
  ref: ImageAttachmentRef;
  data: Uint8Array;
}
/** Deterministic request-image policy selected by one exact model route. */
interface ImageRequestPolicy {
  /** Maximum width multiplied by height after aspect-preserving projection. */
  maxPixels: number;
  /** Encoded-byte target before base64 expansion or Files API upload; the smallest quality-ladder output is kept when no quality fits. */
  maxBytes: number;
}
/** Cached request version derived from one provider-independent normalized attachment. */
interface RequestImageAttachment {
  /** Cache and upload-index key over the attachment id, policy, and fixed encoder parameters. */
  variantId: ImageVariantId;
  /** Durable normalized attachment from which this request version was derived. */
  attachment: ImageAttachmentRef;
  /** Encoded request bytes. */
  data: Uint8Array;
  mediaType: ImageMediaType;
  bytes: number;
  width: number;
  height: number;
  /** Provider-compatible sample depth proven after request encoding. */
  depth: 'uchar';
  /** Provider-compatible color space proven after request encoding. */
  space: 'srgb';
  /** Whether the encoded request version retains an alpha channel. */
  hasAlpha: boolean;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-attachment@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2_@deepseek-ai+dsh-brand_7841e9eae353fb11f43d12d9f6974d78/node_modules/@deepseek-ai/dsh-attachment/lib/types/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    attachments: AttachmentStore;
  }
}
/** Immutable binary attachment service. Implementations validate bytes before publishing a reference. */
declare abstract class AttachmentStore extends Service {
  constructor(ctx: Context);
  /** Deployment-resolved image policy used by authoritative and fast-path validation. */
  abstract readonly imageLimits: ImageAttachmentLimits;
  /**
   * Validate one image without persisting it.
   * Batch callers validate every member before saving any member.
   * @param input - encoded bytes, declared media type, and optional display name.
   * @returns completion after the encoded raster has been fully decoded.
   */
  abstract validateImage(input: SaveImageAttachment): Promise<void>;
  /**
   * Validate one ordered image batch before committing any member.
   * Validation failures start no writes; storage failures return no partial
   * references, although already published content-addressed objects may stay
   * unreachable until a future retention policy collects them.
   * @param inputs - encoded images in their owning message order.
   * @returns durable references in the exact input order.
   */
  protected validateImageBatch(inputs: readonly SaveImageAttachment[]): void;
  /**
   * Validate and durably commit one ordered image batch.
   * @param inputs - encoded images in owning-message order.
   * @returns durable normalized attachment references in the same order after every member succeeds.
   */
  saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>;
  /**
   * Admit one Host prompt and replace each uploaded image with its durable reference.
   * Text and durable file references pass through unchanged. A prompt without image parts performs no storage operation.
   * @param content - prompt parts in message order after file receipt resolution.
   * @returns admitted prompt parts in the same order as `content`.
   * @throws AttachmentError when the image batch is refused.
   */
  admitPromptContent(content: readonly AttachmentAdmissionPart[]): Promise<AdmittedPromptContentPart[]>;
  /**
   * Decode and durably commit one canonical base64 file upload.
   * @param input - canonical base64 bytes and optional display name.
   * @returns the durable content-addressed file reference.
   * @throws AttachmentError when the encoding or storage operation is refused.
   */
  admitEncodedFile(input: EncodedFileAttachment): Promise<FileAttachmentRef>;
  /**
   * Identify a failure emitted by this attachment capability by its stable code.
   * @param error - value caught from an attachment operation.
   * @returns whether the value is an attachment failure.
   */
  isAttachmentError(error: unknown): error is AttachmentError;
  /**
   * Validate and durably commit one image before its owning session event is appended.
   * The returned reference describes the persisted normalized image. When
   * normalization reduces the raster, its `originalDimensions` records the
   * orientation-applied input dimensions.
   * @param input - encoded bytes, declared media type, and optional display name.
   * @returns the durable content-addressed normalized image reference.
   */
  abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>;
  /**
   * Read one image and verify that bytes still match the recorded reference.
   * @param ref - durable reference from the session log.
   * @param signal - optional cancellation for backend read and verification work.
   * @returns the verified bytes and normalized attachment reference.
   * @throws the signal reason when aborted, or a storage error when verification fails.
   */
  abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>;
  /**
   * Locate the provider-owned normalized object in the harness host filesystem.
   * @param ref - durable normalized attachment reference.
   * @returns an absolute host path, or undefined when this backend is not host-file-backed.
   * @throws an AttachmentError when the durable reference is invalid.
   */
  imageHostPath(ref: ImageAttachmentRef): string | undefined;
  /**
   * Durably commit one file byte-for-byte before its owning session event is
   * appended. Files carry no admission limits: any byte content and length is
   * accepted, and the stored object is the exact submitted bytes. Backends
   * without verbatim file storage keep this default rejection.
   * @param input - exact bytes and optional display name.
   * @returns the durable content-addressed file reference.
   */
  saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef>;
  /**
   * Durably commit one file byte-for-byte from bounded chunks. Providers must
   * apply backpressure and must not collect the complete file in memory.
   * Backends without streamed verbatim storage keep this default rejection.
   * @param input - ordered exact bytes, optional cancellation, and display name.
   * @returns the durable content-addressed file reference.
   */
  saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef>;
  /**
   * Read and verify one verbatim stored file as bounded chunks. Providers must
   * not collect the complete file in memory. Backends without verbatim file
   * reads keep this default rejection.
   * @param ref - durable reference from the session log.
   * @param signal - optional cancellation for backend reads and verification work.
   * @returns exact file bytes in order; integrity failures reject the iteration.
   */
  readFileStream(ref: FileAttachmentRef, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  /**
   * Locate the verbatim stored file object in the harness host filesystem.
   * @param ref - durable file reference.
   * @returns an absolute host path, or undefined when this backend is not host-file-backed.
   * @throws an AttachmentError when the durable reference is invalid.
   */
  fileHostPath(ref: FileAttachmentRef): string | undefined;
  /**
   * Generate or read one deterministic model-request version from the stored normalized image.
   * @param ref - durable provider-independent normalized attachment reference.
   * @param policy - exact route pixel budget and encoded-byte target; a target no ladder quality meets yields the smallest ladder output.
   * @param signal - optional cancellation.
   * @returns request bytes and the cache/upload identity covering every transform input.
   */
  readImageRequest(ref: ImageAttachmentRef, policy: ImageRequestPolicy, signal?: AbortSignal): Promise<RequestImageAttachment>;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2/node_modules/@deepseek-ai/dsh-llm/lib/types/brand.d.ts
/** Stable identity carried by one message across inbox, log, and model-request boundaries. */
type MessageId = Branded<'MessageId'>;
/**
 * Brand a message identifier.
 * @param id - the opaque message identifier.
 * @returns the same string with the message-id brand.
 */
declare function MessageId(id: string): MessageId;
/**
 * Correlates a model-issued tool call with its result. Provider-issued for
 * real adapters; synthesized by mocks/assembler fallbacks.
 */
type ToolCallId = Branded<'ToolCallId'>;
/**
 * Brand a string as a {@link ToolCallId}.
 * @param id - the provider-issued or synthesized call id.
 * @returns the same string with the tool-call-id brand.
 */
declare function ToolCallId(id: string): ToolCallId;
/** Provider-issued request identifier retained for diagnostics across package boundaries. */
type ProviderRequestId = Branded<'ProviderRequestId'>;
/**
 * Brand a provider-issued request identifier.
 * @param id - the opaque provider-issued string.
 * @returns the same string, branded; no validation is performed.
 */
declare function ProviderRequestId(id: string): ProviderRequestId;
/** Identity of one model streaming attempt, unique within one Agent lifecycle. */
type LlmAttemptId = Branded<'LlmAttemptId'>;
/**
 * Brand one loop-owned streaming attempt identifier.
 * @param id - the opaque Agent-lifecycle-local identifier.
 * @returns the same string with the attempt-id brand.
 */
declare function LlmAttemptId(id: string): LlmAttemptId;
/** Adapter-owned identifier for one model's selectable reasoning effort. */
type ReasoningEffortId = Branded<'ReasoningEffortId'>;
/**
 * Brand an adapter-owned reasoning-effort identifier.
 * @param id - the opaque identifier exposed by one model capability.
 * @returns the same string, branded; no validation is performed.
 */
declare function ReasoningEffortId(id: string): ReasoningEffortId;
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2/node_modules/@deepseek-ai/dsh-llm/lib/types/message.d.ts
/** Provider/model identity and adapter-private replay data for an assistant message. */
interface AssistantProvenance {
  /** Provider route that produced the message. */
  provider: string;
  /** Provider model id that produced the message. */
  model: string;
  /**
   * Lossless-JSON adapter state needed to replay the provider response.
   * `LlmRuntime` exposes it to a target adapter only when that adapter instance
   * currently owns both this historical provider and the target provider.
   */
  replayState?: unknown;
}
/** Required source of an assistant message produced by a routed model. */
interface ModelMessageSource extends AssistantProvenance {
  kind: 'model';
}
/** Required source of a user-role message carrying one tool result. */
interface ToolMessageSource {
  kind: 'tool';
  callId: ToolCallId;
}
/** One named contribution to a `snapshot`-form context, in assembly order. */
interface ContextSnapshotSection {
  /** The contributing subsystem's name. */
  readonly name: string;
  /** That contribution's model-facing text, exactly as assembled. */
  readonly text: string;
}
/**
 * Producer-declared {@link ContextForm} and the fields that form requires,
 * mixed into the source types that carry one.
 *
 * Discriminated by `form` so a producer cannot select a form without the
 * fields needed to present it: a `notice` must record its one-line
 * account, a `snapshot` its sections. Omitting `form` stays valid — an
 * undeclared context is the documented default.
 */
type ContextFormed = {
  readonly form?: never;
} | {
  readonly form: 'instructions';
} | {
  readonly form: 'catalog';
} | {
  readonly form: 'snapshot';
  /** The named contributions this snapshot assembled, in order. */
  readonly sections: readonly ContextSnapshotSection[];
} | {
  readonly form: 'notice';
  /** One-line account of what happened, shown without expanding the row. */
  readonly summary: string;
} | {
  readonly form: 'relay';
} | {
  readonly form: 'recall';
};
/**
 * Where a message (or injected content) came from.
 * Merge-extensible sum type — plugins add their own `kind`s.
 */
interface MessageSourceMap {
  user: {
    kind: 'user';
  };
  plugin: {
    kind: 'plugin';
    plugin: string;
  } & ContextFormed;
  model: ModelMessageSource;
  tool: ToolMessageSource;
}
/** Any known message source, derived from {@link MessageSourceMap}; switch on `kind` and fall through unknowns (merge-extensible). */
type MessageSource = MessageSourceMap[keyof MessageSourceMap];
/** One immutable message representation shared by delivery, durable history, and model requests. */
interface Message$1 {
  /** Stable identity preserved across every representation boundary. */
  readonly id: MessageId;
  /** Provider-neutral conversation role. */
  readonly role: 'system' | 'user' | 'assistant';
  /** Exact model-facing blocks. */
  readonly content: ContentBlock[];
  /** Required source fields supplied by the producer. */
  readonly source: MessageSource;
}
/** A user-role specialization of the one shared message representation. */
interface UserMessage$1 extends Message$1 {
  readonly role: 'user';
}
/** A model-produced assistant specialization of the shared message representation. */
interface AssistantMessage$1 extends Message$1 {
  readonly role: 'assistant';
  readonly source: ModelMessageSource;
}
/**
 * A system-role specialization of the shared message representation: one
 * rendered system prompt attributed to the plugin that assembled it. Empty
 * `content` means "no system prompt" and projects to no wire message.
 */
interface SystemMessage extends Message$1 {
  readonly role: 'system';
  readonly source: MessageSourceMap['plugin'];
}
/** A tool-result specialization whose model-facing block retains call correlation. */
interface ToolResultMessage extends Message$1 {
  readonly role: 'user';
  readonly content: [ToolResultBlock];
  readonly source: ToolMessageSource;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2/node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The provider topology changed: an adapter registered or unregistered
     * routes, or the configurable-provider directory gained or lost entries.
     * This payload-free registry notification fires at each commit point
     * (including registration disposal); consumers re-read `listProviders()`,
     * `listModels()`, or `listConfigurableProviders()` for the new state.
     * Observer failures are contained and cannot veto the registry mutation.
     * @mode emit
     */
    'llm/adapters-updated'(): void;
  }
}
/** Serializable provider or transport failure facts; policy decides whether they are retryable. */
interface LlmFailure {
  /** Human-readable provider or transport failure. */
  readonly message: string;
  /** Stable provider-neutral machine-routing code. */
  readonly code: string;
  /** HTTP status returned by the provider, when available. */
  readonly status?: number;
  /** Provider-requested delay in milliseconds, when valid and available. */
  readonly providerRetryAfterMs?: number;
  /** Opaque provider-issued request identifier for diagnostics. */
  readonly requestId?: ProviderRequestId;
}
/** Plain text visible to the end user. */
interface TextBlock {
  type: 'text';
  text: string;
}
/** Reasoning / thinking content, distinct from visible text. */
interface ReasoningBlock {
  type: 'reasoning';
  text: string;
}
/**
 * A durable raster image reference, valid in user or assistant content. The
 * block is deliberately role-neutral; assistant-side rendering is forward
 * compatibility — the current production adapters declare text-only output,
 * so only user messages may carry images.
 */
interface ImageBlock {
  type: 'image';
  /** Immutable bytes and intrinsic display metadata owned by the attachment service. */
  attachment: ImageAttachmentRef;
}
/**
 * A durable verbatim file reference, valid in user content. Files never reach
 * a provider natively: request assembly projects every occurrence to
 * deterministic handle text (name, byte size, and the read-only saved path),
 * so adapters and providers see text in its place while the durable log keeps
 * the structured reference for presentation and authorization.
 */
interface FileBlock {
  type: 'file';
  /** Immutable verbatim bytes and display metadata owned by the attachment service. */
  attachment: FileAttachmentRef;
}
/** A tool invocation requested by the model. */
interface ToolCallBlock {
  type: 'tool-call';
  /** Provider-issued call id; correlates with the matching tool result. */
  id: ToolCallId;
  name: string;
  /** Raw JSON string as produced by the model. */
  arguments: string;
}
/** The result of a tool invocation, sent back to the model. */
interface ToolResultBlock {
  type: 'tool-result';
  toolCallId: ToolCallId;
  content: ContentBlock[];
  isError?: boolean;
}
/**
 * Merge-extensible content blocks keyed by `type`. New core blocks must land
 * with adapter, UI, and compaction support.
 */
interface ContentBlockMap {
  'text': TextBlock;
  'reasoning': ReasoningBlock;
  'image': ImageBlock;
  'file': FileBlock;
  'tool-call': ToolCallBlock;
  'tool-result': ToolResultBlock;
}
/** The block `type` tag vocabulary; widens as plugins add entries to {@link ContentBlockMap}. */
type ContentBlockType = keyof ContentBlockMap;
/** Any known content block, derived from {@link ContentBlockMap}; switch on `type` and fall through unknowns (merge-extensible). */
type ContentBlock = ContentBlockMap[ContentBlockType];
/**
 * Why a model response stopped.
 * Merge-extensible so adapters can surface provider-specific reasons.
 */
interface FinishReasonMap {
  'stop': {
    kind: 'stop';
  };
  'tool-calls': {
    kind: 'tool-calls';
  };
  'max-tokens': {
    kind: 'max-tokens';
  };
  'aborted': {
    kind: 'aborted';
    failure: LlmFailure;
  };
  'error': {
    kind: 'error';
    failure: LlmFailure;
  };
}
/** Any known finish reason, derived from {@link FinishReasonMap}; switch on `kind` and fall through unknowns (merge-extensible). */
type FinishReason = FinishReasonMap[keyof FinishReasonMap];
/**
 * Token accounting for one model call (cache fields are optional).
 *
 * Counts are DISJOINT: `inputTokens` is uncached input only; cached input is
 * reported separately as `cacheReadTokens`/`cacheWriteTokens` (billed input =
 * sum of the three). Adapters whose providers fold cache hits into a total
 * prompt count (DeepSeek's `prompt_tokens`) subtract them out.
 */
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Exact full-call total including aggregate prompt and output tokens.
   *
   * Adapters preserve a provider total or derive it from authoritative
   * aggregate prompt/output counters; they omit it when unavailable or
   * inconsistent.
   */
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}
/**
 * Request price of one ordered image occurrence under one exact model route's
 * request projection. Every occurrence resolves to the pair the wire actually
 * carries: provider visual tokens for a retained image, plus the model-visible
 * text sent with or instead of it (request-preview handle, offload placeholder,
 * or text-only substitution). The caller prices `text` with its own text
 * estimator so provider pricing never fixes a text tokenization.
 */
interface LlmImageRequestPrice {
  /** Provider visual tokens for the retained request image; 0 when only text represents this occurrence. */
  visualTokens: number;
  /** Model-visible text sent for this occurrence, to be priced by the caller's text estimator. */
  text: string;
}
/**
 * Provider-side request-image pricing for one exact model route. Implemented
 * by adapters whose provider charges visual tokens; consumers (the token
 * meter) resolve it synchronously per measurement, so implementations must not
 * perform I/O.
 */
interface LlmImageRequestPricing {
  /**
   * Price every image occurrence of one request projection.
   * @param images - durable image references in request order, one entry per occurrence.
   * @returns one price per occurrence, aligned by index with `images`.
   */
  priceImages(images: readonly ImageAttachmentRef[]): readonly LlmImageRequestPrice[];
}
/** Display metadata for one registered provider route. */
interface LlmProviderInfo {
  /** Provider route key used by {@link GenerateOptions.provider}. */
  id: string;
  /** Human-readable provider name for selectors and diagnostics. */
  name: string;
}
/** Merge-extensible provider model modality vocabulary. */
interface ModelModalityMap {
  text: 'text';
  image: 'image';
}
/** Any declared provider model modality. */
type ModelModality = ModelModalityMap[keyof ModelModalityMap];
/**
 * One provider route an adapter plugin can activate through configuration,
 * whether or not the route is currently registered. Configuration surfaces
 * merge this directory with `listProviders()` to offer every configurable
 * provider alongside its live/dormant state.
 */
interface LlmConfigurableProvider {
  /** Provider route key this entry activates when configured. */
  provider: string;
  /** Human-readable provider name for configuration surfaces. */
  displayName: string;
  /** User-settings namespace whose section configures this provider. */
  settingsNs: string;
  /**
   * Path from that namespace's section root to this provider's profile
   * object; empty when the whole section is the profile.
   */
  settingsPath: readonly string[];
  /**
   * Whether the owning adapter knows this route only because configuration
   * declared it — a gateway or self-hosted server it ships nothing about.
   * Absent means the adapter draws no such distinction; false means it does
   * and this route is one of its own. Only the adapter can answer: a stored
   * profile is how a user-added route AND a corrected shipped one both look
   * from outside.
   */
  declared?: boolean;
  /** Configuration diagnostic for repair; unaffected models may remain serviceable. */
  error?: string;
}
/**
 * One interrogation of a provider endpoint that configuration has not stored
 * yet. Configuration surfaces send the draft a user is still editing, so the
 * request carries the endpoint and credential directly instead of naming a
 * route: a provider being added has no route to name.
 */
interface LlmModelDiscoveryRequest {
  /**
   * Route the draft is editing, when it edits an existing one. A route whose
   * adapter already knows its models answers from that knowledge instead of
   * asking the endpoint — the adapter's own registry is the better answer, and
   * it costs no network call.
   */
  provider?: string;
  /**
   * Endpoint to interrogate. Optional because a route the adapter already
   * describes needs none; a route it does not must supply one.
   */
  baseURL?: string;
  /** Wire protocol the endpoint speaks, when the draft names one. */
  api?: string;
  /** Credential for this interrogation alone; the harness never stores it. */
  apiKey?: string;
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A draft provider interrogation refused or failed. */
    'llm/model-discovery-rejected': {
      readonly settingsNs: string;
      readonly baseURL?: string;
    };
  }
}
/**
 * One model an endpoint reports about itself. Every field but the id is
 * optional because most provider listings disclose an id and nothing else;
 * a surface adopting one of these still owes the capacities its adapter needs.
 */
interface LlmDiscoveredModel {
  /** Model id the endpoint accepts. */
  id: string;
  /** Human-readable name when the endpoint supplies one. */
  name?: string;
  /** Maximum combined request and response context, when disclosed. */
  contextWindow?: number;
  /** Maximum output tokens, when disclosed. */
  maxTokens?: number;
}
/** One adapter-discovered model; catalog membership is advisory, not request validation. */
interface LlmModelInfo {
  /** Provider route that owns this model entry. */
  provider: string;
  /** Model id passed to {@link GenerateOptions.model}. */
  id: string;
  /** Human-readable model name for selectors. */
  name: string;
  /** Optional user-facing distinction from otherwise similar models. */
  description?: string;
  /** Accepted request modalities; absent means unknown, while an explicit omission is negative capability. */
  inputModalities?: readonly ModelModality[];
}
/** Provider-owned context capacity for one exact provider/model route. */
interface LlmModelContext {
  /** Maximum combined request and response context in tokens. */
  contextWindow: number;
}
/** Display metadata for one adapter-owned reasoning effort. */
interface LlmReasoningEffortInfo {
  /** Opaque stable value accepted by {@link GenerateOptions.reasoningEffort}. */
  id: ReasoningEffortId;
  /** Human-readable effort name for selectors and diagnostics. */
  name: string;
  /** Optional user-facing distinction from otherwise similar efforts. */
  description?: string;
}
/** Selectable reasoning efforts for one exact provider/model route. */
interface LlmModelReasoningInfo {
  /** Supported efforts in adapter-preferred display order. */
  efforts: readonly LlmReasoningEffortInfo[];
  /**
   * Adapter-configured default materialized into requests when callers omit
   * an effort. Absence preserves the provider's own default.
   */
  defaultEffort?: ReasoningEffortId;
}
/**
 * How a model applies a system prompt that changes mid-conversation.
 * `'in-history'`: the model reads the latest `system` message at any position
 * of `messages` as the complete effective system prompt, so a changed prompt
 * can follow the cached history instead of rewriting message 0.
 */
type SystemPromptUpdate = 'in-history';
/** Exact-route model metadata resolved by its owning adapter. */
interface LlmResolvedModelInfo extends LlmModelInfo {
  /** Provider-owned context capacity when known. */
  context?: LlmModelContext;
  /** Adapter-configured per-request output cap materialized when callers omit one. */
  defaultMaxTokens?: number;
  /** Adapter-owned selectable reasoning levels when exposed. */
  reasoning?: LlmModelReasoningInfo;
  /** Declared mid-conversation system prompt handling; absent means only a leading system message is read. */
  systemPromptUpdate?: SystemPromptUpdate;
}
/**
 * Adapter-private lossless-JSON state for replaying a successful response,
 * carried by a terminal `finish` chunk and stored on the assembled assistant
 * message's model source. Both halves stay opaque to the harness; only the
 * split is shared vocabulary, so assembly can keep stored metadata aligned
 * with stored content without reading either half.
 */
interface ReplayEnvelope {
  /** Response-level adapter-private metadata (ids, native stop reason). */
  response: unknown;
  /**
   * Per-block adapter-private metadata, one entry per emitted block in
   * first-seen stream order. When assembly drops a block it drops the entry at
   * the same position; entries whose length does not match the emitted block
   * count discard the whole envelope. An adapter whose metadata is independent
   * of block structure omits this field and the envelope passes through
   * assembly unchanged.
   */
  blocks?: readonly unknown[];
}
/**
 * Raw streaming protocol emitted by adapters.
 * Block indexes correlate interleaved deltas, and `block-end` carries the
 * assembled block. Adapters emit usage before the terminal finish and nothing
 * afterward; tool arguments remain raw JSON strings. An adapter implementation
 * may throw, but `LlmRuntime.stream()` normalizes that failure to a terminal
 * `error` or `aborted` finish before exposing it to consumers.
 */
type StreamChunk = {
  type: 'block-start';
  index: number;
  blockType: ContentBlockType;
} | {
  type: 'text-delta';
  index: number;
  text: string;
} | {
  type: 'reasoning-delta';
  index: number;
  text: string;
} | {
  type: 'tool-call-delta';
  index: number;
  id: ToolCallId;
  name?: string;
  argumentsDelta: string;
} | {
  type: 'block-end';
  index: number;
  block: ContentBlock;
} | {
  type: 'usage';
  usage: TokenUsage;
} | {
  type: 'finish';
  reason: FinishReason;
  /** Replay metadata for a successful response; see {@link ReplayEnvelope}. */
  replayState?: ReplayEnvelope;
};
/**
 * JSON-schema description of a tool, as sent to the model.
 *
 * Declared here (not in dsh-tools) because it is part of {@link GenerateOptions};
 * dsh-tools' ToolDefinition and dsh-system-prompt's PromptAssembly both import
 * it from this package.
 */
interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>;
}
/** A single model request, fully assembled. */
interface GenerateOptions {
  /** Registered provider route selecting the adapter instance. */
  provider: string;
  model: string;
  /** Adapter-owned reasoning effort selected for this exact model. */
  reasoningEffort?: ReasoningEffortId;
  /**
   * Ordered conversation messages, exactly as the provider sees them. A
   * loop-built request passes the derived history (dsh-agent-loop), whose
   * leading system-role message carries the system prompt; a hand-built
   * one-shot passes any list.
   */
  messages: Message$1[];
  /**
   * System prompt text for one-shot callers; adapters map it to the provider's
   * system slot ahead of `messages`. Loop-built requests leave it undefined.
   */
  system?: string;
  /** Tool schemas (adapters map to the provider's `tools` field). */
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  /**
   * Stop sequences: generation halts as soon as the model produces any one of
   * these strings (adapters map to the provider's stop field, e.g. OpenAI
   * `stop`). The stop string itself is not included in the output.
   */
  stop?: string[];
  signal?: AbortSignal;
  /**
   * Session identity stamped by the loop for request routing. Replay uses it
   * to separate cursors; adapters may map it to model-hidden transport metadata.
   */
  sessionId?: Branded<'SessionId'>;
  /**
   * Provider-neutral classification for an auxiliary model call. Adapters may
   * map the purpose to model-hidden transport metadata or purpose-specific
   * generation policy. Ordinary conversation requests leave it unset.
   */
  purpose?: 'compaction' | 'session-title';
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-typert-protocol@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2/node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/remote-error.d.ts
/**
 * One Remote call failure: a real Error carrying its stable code and typed
 * details. Owners throw it at the failure point; the Host Gateway encodes it
 * onto the wire unchanged; the Client face rebuilds an instance for the
 * `RemoteResult` error branch, so `throw result.error` keeps throw semantics.
 * Discrimination is always by `code`, never by instanceof.
 */
declare class RemoteError<Code extends RemoteErrorCode = RemoteErrorCode> extends Error {
  readonly code: Code;
  readonly details: RemoteErrorDetailsMap[Code];
  /** Structural marker: cross-realm/bundle identification never uses instanceof. */
  readonly isDSHRemoteError: true;
  /**
   * @param code - stable failure code declared in {@link RemoteErrorDetailsMap}.
   * @param message - human diagnostic carried across the wire.
   * @param details - structured payload typed by the code.
   * @param options - standard Error options (`cause` survives in-process only).
   */
  constructor(code: Code, message: string, details: RemoteErrorDetailsMap[Code], options?: ErrorOptions);
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-typert-protocol@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2/node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/types.d.ts
declare const LOOKUP_HOST: unique symbol;
declare const LOOKUP_WIRE: unique symbol;
declare const CONTEXT_WIRE: unique symbol;
/** Type-level association between a Host object and its wire identity. */
interface TypertLookup<Host, Wire> {
  readonly [LOOKUP_HOST]: Host;
  readonly [LOOKUP_WIRE]: Wire;
}
/** Extract the Host object associated with one lookup declaration. */
type TypertLookupHost<Lookup> = Lookup extends TypertLookup<infer Host, infer _Wire> ? Host : never;
/** Extract the wire identity associated with one lookup declaration. */
type TypertLookupWire<Lookup> = Lookup extends TypertLookup<infer _Host, infer Wire> ? Wire : never;
/** Type-level association between a scoped Context kind and its wire identity. */
interface TypertContext<Wire> {
  readonly [CONTEXT_WIRE]: Wire;
}
/** Extract the wire identity associated with one scoped Context declaration. */
type TypertContextWire<ContextType> = ContextType extends TypertContext<infer Wire> ? Wire : never;
/** Merge-extensible Host object lookup declarations. */
interface TypertLookupMap {}
/** Merge-extensible scoped Context declarations. */
interface TypertContextMap {}
/**
 * Merge-extensible Remote failure vocabulary: this package declares the
 * universal carrier codes once; the Gateway merges its infrastructure codes
 * and every owner merges its domain codes next to the throwing code.
 */
interface RemoteErrorDetailsMap {
  /** Owner-side business validation refused the request; `issues` carries codec output when one produced it. */
  'gateway/bad-request': {
    readonly issues?: readonly object[];
  };
  /** The call was cancelled by the carrier signal or the backend. */
  'gateway/cancelled': {};
  /** Carrier, dispatch, or unclassified Host failure. */
  'gateway/internal': {};
}
/** Every declared Remote failure code. */
type RemoteErrorCode = keyof RemoteErrorDetailsMap;
/** Awaitable disposer returned by Cordis-owned Typert registrations. */
type TypertDisposer = () => Promise<void>;
type StringKeyOf<Value> = Extract<keyof Value, string>;
/** Minimal runtime-schema capability carried by strict generated codecs. */
interface TypertSchema<Output = unknown> {
  /**
   * Parse and validate one boundary value.
   * @param value - untrusted boundary value.
   * @returns the validated value.
   */
  parse(value: unknown): Output;
}
/** Codec attached to one invocation parameter or result. */
type TypertCodec = {
  readonly mode: 'strict';
  readonly typeSymbol: string;
  readonly schema: TypertSchema;
} | {
  readonly mode: 'src-json';
};
/** One ordered business parameter in a Remote invocation. */
interface InvocationParameterDescriptor {
  /** Source-level parameter name. */
  readonly name: string;
  /** Required key in the wire `args` object. */
  readonly wire: string;
  /** Whether the value is JSON or requires a registered Host lookup. */
  readonly source: 'json' | 'lookup';
  /** Lookup key when `source` is `lookup`. */
  readonly lookup?: string;
  /** Boundary codec for the wire representation. */
  readonly codec: TypertCodec;
  /** Missing wire fields decode to `undefined` only for an explicitly declared `T | undefined`. */
  readonly acceptsUndefined?: true;
}
/** Source position retained for diagnostics from generated definitions. */
interface InvocationSourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}
/** Carrier-independent description of one exported method invocation. */
interface InvocationDescriptor {
  /** Globally stable generated identity. */
  readonly id: string;
  /** Cordis service key owning the method. */
  readonly service: string;
  /** Wire namespace, defaulting to the service key. */
  readonly namespace: string;
  /** Public instance method name. */
  readonly method: string;
  /** Service member invoked when the exported method name is an alias. */
  readonly implementation?: string;
  /** Absent for unary calls; stream calls validate and deliver every yielded item. */
  readonly mode?: 'stream';
  /** Receiver selection mode. */
  readonly invocation: {
    readonly kind: 'direct';
  } | {
    readonly kind: 'context';
    readonly context: string;
    readonly wire: string;
    readonly codec: TypertCodec;
  };
  /** Optional consuming-Context projection for one direct lookup parameter. */
  readonly scope?: {
    /** Context kind whose Client adapter supplies the identity. */
    readonly context: string;
    /** Lookup parameter wire field replaced by the Context identity. */
    readonly wire: string;
  };
  /** Ordered business parameters. */
  readonly parameters: readonly InvocationParameterDescriptor[];
  /** Transport cancellation injected after business parameters instead of entering wire args. */
  readonly cancellation?: {
    /** Reserved final Host method parameter. */
    readonly parameter: 'signal';
  };
  /** Codec for the unary result or each yielded stream item. */
  readonly result: TypertCodec;
  /** Source declaration used only for diagnostics. */
  readonly sourceLocation?: InvocationSourceLocation;
}
/** Generated Host contract selected explicitly by a Client assembly. */
interface TypertRemoteContribution {
  /** npm package that owns the Remote methods. */
  readonly package: string;
  /** Consumer-side invocation descriptors generated from that package. */
  readonly descriptors: readonly InvocationDescriptor[];
}
/**
 * Resolve one validated wire identity, synchronously or asynchronously.
 * @param id - validated wire identity.
 * @returns the Host object, or `undefined` when unavailable.
 */
type TypertLookupResolver<Host = unknown, Wire = unknown> = (id: Wire) => Host | undefined | Promise<Host | undefined>;
/** Runtime provider for one declared Host object lookup. */
interface TypertLookupProvider<Host = unknown, Wire = unknown> {
  /** Source parameter name recognized by the SRC weak parser. */
  readonly parameter: string;
  /** Wire field replacing the Host object parameter. */
  readonly wire: string;
  /** Canonical Host type symbol used by strict generation. */
  readonly hostTypeSymbol: string;
  /** Canonical wire type symbol used by strict generation. */
  readonly wireTypeSymbol: string;
  /**
   * Resolve a wire identity through the provider's default policy.
   * @param id - validated wire identity.
   * @returns the object, `undefined` when unavailable, or either asynchronously.
   */
  resolve(id: Wire): Host | undefined | Promise<Host | undefined>;
}
/** Stable wire declaration retained after a lookup provider unloads. */
interface TypertLookupDefinition {
  /** Merge-declared lookup key. */
  readonly key: string;
  /** Source parameter name recognized by the SRC weak parser. */
  readonly parameter: string;
  /** Wire field replacing the Host object parameter. */
  readonly wire: string;
  /** Canonical Host type symbol used by strict generation. */
  readonly hostTypeSymbol: string;
  /** Canonical wire type symbol used by strict generation. */
  readonly wireTypeSymbol: string;
}
/** Host wire-to-Context resolver plus the declaration used by strict Remote methods. */
interface TypertHostContextAdapter<Wire = unknown> {
  /** Wire field carrying the Context identity. */
  readonly wire: string;
  /** Canonical wire type symbol used by strict generation. */
  readonly wireTypeSymbol: string;
  /**
   * Resolve a validated wire identity to a live Host Context.
   * @param id - validated wire identity.
   * @returns the Context, or `undefined` when it is unavailable.
   */
  resolve(id: Wire): Context | undefined | Promise<Context | undefined>;
}
/** Composition-owned resolver replacing one Host Context adapter's default lookup policy. */
type TypertHostContextResolver<Wire = unknown> = (id: Wire) => Context | undefined | Promise<Context | undefined>;
/** Client-side bidirectional Context adapter. */
interface TypertClientContextAdapter<Wire = unknown> {
  /**
   * Read the identity represented by a live Client Context.
   * @param ctx - Client Context inspected by a scoped Remote caller.
   * @returns the wire identity, or `undefined` for another Context kind.
   */
  identity(ctx: Context): Wire | undefined;
  /**
   * Resolve a wire identity from the Client's currently materialized Contexts.
   * @param id - validated wire identity.
   * @returns the Client Context, or `undefined` when unavailable.
   */
  resolve(id: Wire): Context | undefined;
}
/** Notification emitted after a Typert runtime registry changes. */
interface TypertRegistryChange {
  readonly kind: 'local' | 'remote' | 'lookup' | 'host-context' | 'client-context';
  readonly key: string;
}
/** Listener for one Typert runtime registry. */
type TypertRegistryListener = (change: TypertRegistryChange) => void;
/** Current-environment invocation definitions. */
interface TypertLocalRegistry {
  /**
   * Look up one invocation by `<namespace>/<method>`.
   * @param endpoint - canonical endpoint.
   * @returns the live descriptor, or `undefined` when absent.
   */
  get(endpoint: string): InvocationDescriptor | undefined;
  /**
   * Report whether a strict definition has existed during this Typert Service lifetime.
   * @param endpoint - canonical endpoint.
   * @returns `true` after the endpoint has been registered at least once, even if withdrawn.
   */
  hasSeen(endpoint: string): boolean;
  /** @returns a registration-order snapshot of local descriptors. */
  list(): readonly InvocationDescriptor[];
  /**
   * Observe later local-definition changes.
   * @param listener - synchronous contained observer.
   * @returns disposer for this subscription.
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer;
}
/** Consumer-selected Remote contribution registry. */
interface TypertRemoteRegistry {
  /**
   * Register one generated contribution for the calling Cordis fiber.
   * @param contribution - generated Remote descriptors.
   * @returns disposer withdrawing the exact contribution.
   */
  register(contribution: TypertRemoteContribution): TypertDisposer;
  /**
   * Look up one Remote descriptor by endpoint.
   * @param endpoint - canonical endpoint.
   * @returns the descriptor, or `undefined` when unmounted.
   */
  get(endpoint: string): InvocationDescriptor | undefined;
  /** @returns a registration-order snapshot of Remote descriptors. */
  list(): readonly InvocationDescriptor[];
  /**
   * Observe later Remote contribution changes.
   * @param listener - synchronous contained observer.
   * @returns disposer for this subscription.
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer;
}
/** Runtime registry for Host object lookup providers. */
interface TypertLookupRegistry {
  /**
   * Register one provider under its merge-declared key.
   * @param key - lookup key.
   * @param provider - owning package's live resolver.
   * @returns disposer withdrawing the exact provider.
   */
  register<K extends StringKeyOf<TypertLookupMap>>(key: K, provider: TypertLookupProvider<TypertLookupHost<TypertLookupMap[K]>, TypertLookupWire<TypertLookupMap[K]>>): TypertDisposer;
  /**
   * Replace one provider's default resolution policy while this contribution is active.
   * Configuration may precede provider registration; without a live provider, `get()` remains unavailable.
   * @param key - lookup key whose wire declaration remains provider-owned.
   * @param resolver - composition-owned resolver used by every lookup of this key.
   * @returns disposer restoring the provider's default resolver.
   */
  configure<K extends StringKeyOf<TypertLookupMap>>(key: K, resolver: TypertLookupResolver<TypertLookupHost<TypertLookupMap[K]>, TypertLookupWire<TypertLookupMap[K]>>): TypertDisposer;
  /**
   * Look up one provider by runtime key.
   * @param key - descriptor lookup key.
   * @returns the live provider, or `undefined` when absent.
   */
  get(key: string): TypertLookupProvider | undefined;
  /** @returns lookup declarations observed during this Typert Service lifetime. */
  definitions(): readonly TypertLookupDefinition[];
  /** @returns a snapshot of registered provider keys. */
  keys(): readonly string[];
  /**
   * Observe later lookup changes.
   * @param listener - synchronous contained observer.
   * @returns disposer for this subscription.
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer;
}
/** Runtime registry for the Host and Client adapters of each Context kind. */
interface TypertContextRegistry {
  /**
   * Register a Host Context adapter.
   * @param key - merge-declared Context key.
   * @param adapter - owning package's Host resolver and wire declaration.
   * @returns disposer withdrawing the exact adapter.
   */
  registerHost<K extends StringKeyOf<TypertContextMap>>(key: K, adapter: TypertHostContextAdapter<TypertContextWire<TypertContextMap[K]>>): TypertDisposer;
  /**
   * Override one Host Context key's resolution policy for the calling fiber.
   * Configuration may precede provider registration and restores the provider's default resolver on disposal.
   * @param key - merge-declared Context key.
   * @param resolver - composition-owned resolver used by every Host Context lookup of this key.
   * @returns disposer restoring the provider's default resolver.
   */
  configureHost<K extends StringKeyOf<TypertContextMap>>(key: K, resolver: TypertHostContextResolver<TypertContextWire<TypertContextMap[K]>>): TypertDisposer;
  /**
   * Register a Client Context adapter.
   * @param key - merge-declared Context key.
   * @param adapter - owning package's bidirectional Client projection.
   * @returns disposer withdrawing the exact adapter.
   */
  registerClient<K extends StringKeyOf<TypertContextMap>>(key: K, adapter: TypertClientContextAdapter<TypertContextWire<TypertContextMap[K]>>): TypertDisposer;
  /**
   * Look up a Host Context adapter.
   * @param key - descriptor Context key.
   * @returns the adapter, or `undefined` when absent.
   */
  getHost(key: string): TypertHostContextAdapter | undefined;
  /**
   * Look up a Client Context adapter.
   * @param key - descriptor Context key.
   * @returns the adapter, or `undefined` when absent.
   */
  getClient(key: string): TypertClientContextAdapter | undefined;
  /**
   * Observe later Context adapter changes.
   * @param listener - synchronous contained observer.
   * @returns disposer for this subscription.
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer;
}
/** Minimal Typert runtime consumed through dependency inversion. */
interface TypertRegistryContract {
  readonly local: TypertLocalRegistry;
  readonly remotes: TypertRemoteRegistry;
  readonly lookups: TypertLookupRegistry;
  readonly contexts: TypertContextRegistry;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    typert: TypertRegistryContract;
  }
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-typert-protocol@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2/node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/index.d.ts
/** Options for an explicit Service-to-Gateway binding. */
interface TypertGatewayBindingOptions {
  /** Wire namespace; defaults to the Cordis service key. */
  readonly namespace?: string;
}
/** Visible declaration that one Service participates in Typert Gateway export. */
interface TypertGatewayBinding<Service extends object = object> {
  readonly service: Service;
  readonly serviceKey: string;
  readonly namespace: string;
}
/** Cordis Service base that exposes its registered name through Typert Gateway. */
declare abstract class TypertRemoteService<out T = never> extends Service<T> {
  /** Visible binding consumed by the Gateway's source-mode discovery. */
  readonly typertRemote: TypertGatewayBinding<this>;
  /**
   * Register the Service and bind the same key to Typert Gateway.
   * @param ctx - owning Cordis Context.
   * @param serviceKey - exact Cordis service key and default wire namespace.
   * @param options - optional distinct wire namespace.
   */
  protected constructor(ctx: Context, serviceKey: string, options?: TypertGatewayBindingOptions);
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+cosmokit@1.8.3/node_modules/@deepseek-ai/cosmokit/lib/types/types.d.ts
declare function isArrayBufferLike(value: any): value is ArrayBufferLike;
declare function isArrayBufferSource(value: any): value is Binary.Source;
/** Binary source detection and base64/hex conversion helpers. */
declare namespace Binary {
  type Source<T extends ArrayBufferLike = ArrayBufferLike> = T | ArrayBufferView<T>;
  const is: typeof isArrayBufferLike;
  const isSource: typeof isArrayBufferSource;
  function fromSource<T extends ArrayBufferLike>(source: Source<T>): T;
  function toBase64(source: Source): string;
  function fromBase64(source: string): ArrayBuffer | Uint8Array<ArrayBuffer>;
  function toHex(source: Source): string;
  function fromHex(source: string): ArrayBuffer;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+cosmokit@1.8.3/node_modules/@deepseek-ai/cosmokit/lib/types/misc.d.ts
/** String/symbol keyed dictionary type. */
type Dict<T = any, K extends string | symbol = string> = { [key in K]: T; };
//#endregion
//#region node_modules/.pnpm/@standard-schema+spec@1.1.0/node_modules/@standard-schema/spec/dist/index.d.ts
/** The Standard Typed interface. This is a base type extended by other specs. */
interface StandardTypedV1<Input = unknown, Output = Input> {
  /** The Standard properties. */
  readonly "~standard": StandardTypedV1.Props<Input, Output>;
}
declare namespace StandardTypedV1 {
  /** The Standard Typed properties interface. */
  interface Props<Input = unknown, Output = Input> {
    /** The version number of the standard. */
    readonly version: 1;
    /** The vendor name of the schema library. */
    readonly vendor: string;
    /** Inferred types associated with the schema. */
    readonly types?: Types<Input, Output> | undefined;
  }
  /** The Standard Typed types interface. */
  interface Types<Input = unknown, Output = Input> {
    /** The input type of the schema. */
    readonly input: Input;
    /** The output type of the schema. */
    readonly output: Output;
  }
  /** Infers the input type of a Standard Typed. */
  type InferInput<Schema extends StandardTypedV1> = NonNullable<Schema["~standard"]["types"]>["input"];
  /** Infers the output type of a Standard Typed. */
  type InferOutput<Schema extends StandardTypedV1> = NonNullable<Schema["~standard"]["types"]>["output"];
}
/** The Standard Schema interface. */
interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** The Standard Schema properties. */
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}
declare namespace StandardSchemaV1 {
  /** The Standard Schema properties interface. */
  interface Props<Input = unknown, Output = Input> extends StandardTypedV1.Props<Input, Output> {
    /** Validates unknown input values. */
    readonly validate: (value: unknown, options?: StandardSchemaV1.Options | undefined) => Result<Output> | Promise<Result<Output>>;
  }
  /** The result interface of the validate function. */
  type Result<Output> = SuccessResult<Output> | FailureResult;
  /** The result interface if validation succeeds. */
  interface SuccessResult<Output> {
    /** The typed output value. */
    readonly value: Output;
    /** A falsy value for `issues` indicates success. */
    readonly issues?: undefined;
  }
  interface Options {
    /** Explicit support for additional vendor-specific parameters, if needed. */
    readonly libraryOptions?: Record<string, unknown> | undefined;
  }
  /** The result interface if validation fails. */
  interface FailureResult {
    /** The issues of failed validation. */
    readonly issues: ReadonlyArray<Issue>;
  }
  /** The issue interface of the failure output. */
  interface Issue {
    /** The error message of the issue. */
    readonly message: string;
    /** The path of the issue, if any. */
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  /** The path segment interface of the issue. */
  interface PathSegment {
    /** The key representing a path segment. */
    readonly key: PropertyKey;
  }
  /** The Standard types interface. */
  interface Types<Input = unknown, Output = Input> extends StandardTypedV1.Types<Input, Output> {}
  /** Infers the input type of a Standard. */
  type InferInput<Schema extends StandardTypedV1> = StandardTypedV1.InferInput<Schema>;
  /** Infers the output type of a Standard. */
  type InferOutput<Schema extends StandardTypedV1> = StandardTypedV1.InferOutput<Schema>;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+schemastery@3.18.2/node_modules/@deepseek-ai/schemastery/lib/types/index.d.ts
declare const kSchema: unique symbol;
declare global {
  namespace Schemastery {
    /** Convert primitive constructors, constants, and existing schemas into a schema type. */
    type From<X> = X extends string | number | boolean ? Schema<X> : X extends Schema ? X : X extends typeof String ? Schema<string> : X extends typeof Number ? Schema<number> : X extends typeof Boolean ? Schema<boolean> : X extends typeof Function ? Schema<Function, (...args: any[]) => any> : X extends Constructor<infer S> ? Schema<S> : never;
    type TypeS1<X> = X extends Schema<infer S, unknown> ? S : never;
    type Inverse<X> = X extends Schema<any, infer Y> ? (arg: Y) => void : never;
    /** Input type accepted by a schema-like value. */
    type TypeS<X> = TypeS1<From<X>>;
    /** Output type returned by a schema-like value after validation. */
    type TypeT<X> = ReturnType<From<X>>;
    /** Resolver callback used by custom schema types registered with `Schema.extend()`. */
    type Resolve = (data: any, schema: Schema, options: Options, strict?: boolean) => [any, any?];
    /** Input type accepted by one schema in an intersection. */
    type IntersectS<X> = From<X> extends Schema<infer S, unknown> ? S : never;
    /** Output type returned by one schema in an intersection. */
    type IntersectT<X> = Inverse<From<X>> extends ((arg: infer T) => void) ? T : never;
    type TupleS<X extends readonly any[]> = X extends readonly [infer L, ...infer R] ? [TypeS<L>?, ...TupleS<R>] : any[];
    type TupleT<X extends readonly any[]> = X extends readonly [infer L, ...infer R] ? [TypeT<L>?, ...TupleT<R>] : any[];
    type ObjectS<X extends Dict> = { [K in keyof X]?: TypeS<X[K]> | null; } & Dict;
    type ObjectT<X extends Dict> = { [K in keyof X]: TypeT<X[K]>; } & Dict;
    type Constructor<T = any> = new (...args: any[]) => T;
    /** Static constructor and factory methods exposed by the default `Schema` export. */
    interface Static {
      <T = any>(options: Partial<Schema<T>>): Schema<T>;
      new <T = any>(options: Partial<Schema<T>>): Schema<T>;
      prototype: Schema;
      /** Validate a value against a schema node and return `[output, adaptedInput?]`. */
      resolve: Resolve;
      /** Infer a schema from a primitive value, constructor, or existing schema. */
      from<X = any>(source?: X): From<X>;
      /** Register a resolver for a custom schema `type`. */
      extend(type: string, resolve: Resolve): void;
      /** Accept any value without validation. */
      any<T = any>(): Schema<T>;
      /** Accept only nullable input. */
      never(): Schema<never>;
      /** Accept exactly one constant value. */
      const<const T>(value: T): Schema<T>;
      /** Accept strings, with optional metadata constraints added by instance methods. */
      string(): Schema<string>;
      /** Accept numbers, with optional range and step constraints. */
      number(): Schema<number>;
      /** Accept non-negative integer numbers. */
      natural(): Schema<number>;
      /** Accept a number between 0 and 1 and mark it as a slider. */
      percent(): Schema<number>;
      /** Accept booleans. */
      boolean(): Schema<boolean>;
      /** Accept `Date` instances or parse datetime strings into `Date` objects. */
      date(): Schema<string | Date, Date>;
      /** Accept `RegExp` instances or parse strings into regular expressions. */
      regExp(flag?: string): Schema<string | RegExp, RegExp>;
      /** Accept binary sources and normalize them to `ArrayBufferLike`. */
      arrayBuffer(): Schema<Binary.Source, ArrayBufferLike>;
      arrayBuffer(encoding: 'hex' | 'base64'): Schema<Binary.Source | string, ArrayBufferLike>;
      /** Accept a numeric bitset or string keys and normalize to a number. */
      bitset<K extends string>(bits: Partial<Record<K, number>>): Schema<number | readonly K[], number>;
      /** Accept functions. */
      function(): Schema<Function, (...args: any[]) => any>;
      /** Accept instances of a constructor or objects whose constructor name matches. */
      is(constructor: string): Schema;
      is<T>(constructor: Constructor<T>): Schema<T>;
      /** Accept arrays whose elements match `inner`. */
      array<X>(inner: X): Schema<TypeS<X>[], TypeT<X>[]>;
      /** Accept plain objects with values matching `inner` and optional key schema. */
      dict<X, Y extends Schema<any, string> = Schema<string>>(inner: X, sKey?: Y): Schema<Dict<TypeS<X>, TypeS<Y>>, Dict<TypeT<X>, TypeT<Y>>>;
      /** Accept tuple arrays where each index matches the corresponding schema. */
      tuple<const X extends readonly any[]>(list: X): Schema<TupleS<X>, TupleT<X>>;
      /** Accept plain objects whose declared properties match the schema dictionary. */
      object<X extends Dict>(dict: X): Schema<ObjectS<X>, ObjectT<X>>;
      /** Accept values matching at least one schema in `list`. */
      union<const X>(list: readonly X[]): Schema<TypeS<X>, TypeT<X>>;
      /** Accept values matching every schema in `list`, merging object outputs. */
      intersect<const X>(list: readonly X[]): Schema<IntersectS<X>, IntersectT<X>>;
      /** Validate with `inner`, then convert the result with `callback`. */
      transform<X, T>(inner: X, callback: (value: TypeS<X>, options: Schemastery.Options) => T, preserve?: boolean): Schema<TypeS<X>, T>;
      /** Defer construction of a recursive schema until validation or serialization. */
      lazy<X extends Schema>(callback: () => X): X;
      ValidationError: typeof ValidationError;
    }
    /** Runtime validation options shared by all schema calls. */
    interface Options {
      /** Remove invalid object properties instead of throwing when possible. */
      autofix?: boolean;
      /** Skip validation for selected values and schema nodes. */
      ignore?(data: any, schema: Schema): boolean;
      /** Path used to format nested validation errors. */
      path?: (keyof any)[];
    }
    /** UI and validation metadata attached by schema builder methods. */
    interface Meta<T = any> {
      default?: T extends {} ? Partial<T> : T;
      required?: boolean;
      disabled?: boolean;
      collapse?: boolean;
      badges?: {
        text: string;
        type: string;
      }[];
      hidden?: boolean;
      loose?: boolean;
      role?: string;
      extra?: any;
      link?: string;
      description?: string | Dict<string>;
      comment?: string;
      pattern?: {
        source: string;
        flags?: string;
      };
      max?: number;
      min?: number;
      step?: number;
    }
  }
  /** Callable schema instance that validates input and returns normalized output. */
  interface Schemastery<S = any, T = S> {
    (data?: S | null, options?: Schemastery.Options): T;
    new (data?: S | null, options?: Schemastery.Options): T;
    [kSchema]: true;
    uid: number;
    meta: Schemastery.Meta<T>;
    type: string;
    sKey?: Schema;
    inner?: Schema;
    list?: Schema[];
    dict?: Dict<Schema>;
    bits?: Dict<number>;
    callback?: Function;
    constructor?: string | Function;
    builder?: Function;
    value?: T;
    refs?: Dict<Schema>;
    preserve?: boolean;
    '~standard': StandardSchemaV1.Props;
    /** Format this schema as a compact TypeScript-like type string. */
    toString(inline?: boolean): string;
    /** Serialize this schema, preserving shared and recursive references. */
    toJSON(): Schema<S, T>;
    /** Mark nullable input as invalid unless a default supplies a fallback. */
    required(value?: boolean): Schema<S, T>;
    /** Hide this schema node from UI renderers. */
    hidden(value?: boolean): Schema<S, T>;
    /** Return the default value instead of throwing when validation fails. */
    loose(value?: boolean): Schema<S, T>;
    /** Attach a renderer role and optional role-specific metadata. */
    role(text: string, extra?: any): Schema<S, T>;
    /** Attach an external documentation link. */
    link(link: string): Schema<S, T>;
    /** Set the fallback value used for nullable input. */
    default(value: T): Schema<S, T>;
    /** Attach an auxiliary comment for documentation or form UIs. */
    comment(text: string): Schema<S, T>;
    /** Attach a localized or plain description for documentation or form UIs. */
    description(text: string): Schema<S, T>;
    /** Mark this schema node as disabled for form UIs. */
    disabled(value?: boolean): Schema<S, T>;
    /** Request collapsed rendering for nested form UIs. */
    collapse(value?: boolean): Schema<S, T>;
    /** Add a deprecated badge to this schema node. */
    deprecated(): Schema<S, T>;
    /** Add an experimental badge to this schema node. */
    experimental(): Schema<S, T>;
    /** Require strings to match a regular expression. */
    pattern(regexp: RegExp): Schema<S, T>;
    /** Set an inclusive maximum for numbers or collection lengths. */
    max(value: number): Schema<S, T>;
    /** Set an inclusive minimum for numbers or collection lengths. */
    min(value: number): Schema<S, T>;
    /** Set the numeric increment constraint. */
    step(value: number): Schema<S, T>;
    /** Add or replace an object property schema. */
    set(key: string, value: Schema): Schema<S, T>;
    /** Append a tuple, union, or intersection member schema. */
    push(value: Schema): Schema<S, T>;
    /** Remove values equal to schema defaults from normalized output. */
    simplify(value?: any): any;
    /** Return a schema clone with descriptions merged from locale messages. */
    i18n(messages: Dict): Schema<S, T>;
    /** Attach arbitrary metadata consumed by form renderers and downstream tools. */
    extra<K extends keyof Schemastery.Meta>(key: K, value: Schemastery.Meta[K]): Schema<S, T>;
  }
}
declare class ValidationError extends TypeError {
  options: Schemastery.Options;
  name: string;
  constructor(message: string, options: Schemastery.Options);
  static is(error: any): error is ValidationError;
}
type Schema<S = any, T = S> = Schemastery<S, T>;
declare const Schema: Schemastery.Static;
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2/node_modules/@deepseek-ai/dsh-llm/lib/types/retry-policy.d.ts
/** Fully resolved backoff shared by both retry modes. */
interface ResolvedRetryBackoff {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}
/** Fully resolved bounded transient retry policy. */
interface ResolvedNormalRetryPolicy extends ResolvedRetryBackoff {
  readonly mode: 'normal';
  readonly maxRetries: number;
  readonly retryableCodes: readonly string[];
}
/** Fully resolved unbounded retry policy. */
interface ResolvedAlwaysRetryPolicy extends ResolvedRetryBackoff {
  readonly mode: 'always';
}
/** Immutable provider policy captured when its adapter route is registered. */
type ResolvedRetryPolicy = ResolvedNormalRetryPolicy | ResolvedAlwaysRetryPolicy;
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2/node_modules/@deepseek-ai/dsh-llm/lib/types/call-config.d.ts
/**
 * Provider, model, reasoning effort, and sampling scalars of one conversation's
 * requests. Every field maps 1:1 onto the same-named `GenerateOptions` field;
 * the loop builds requests from the logged header rather than accepting these
 * per call.
 */
interface LlmCallConfig {
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffortId;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}
/**
 * Effective config fields supplied by exact-model adapter resolution rather
 * than by the caller's request proposal.
 */
interface LlmCallConfigAdapterDefaults {
  reasoningEffort?: true;
  maxTokens?: true;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2/node_modules/@deepseek-ai/dsh-llm/lib/types/assistant-stream.d.ts
/** Lossless compact records embedded in durable Assistant attempt events. */
type AssistantStreamRecord = {
  readonly type: 'text-chunks';
  readonly time0: number;
  readonly index: number;
  readonly dt: readonly number[];
  readonly texts: readonly string[];
} | {
  readonly type: 'reasoning-chunks';
  readonly time0: number;
  readonly index: number;
  readonly dt: readonly number[];
  readonly texts: readonly string[];
} | {
  readonly type: 'tool-call-chunks';
  readonly time0: number;
  readonly index: number;
  readonly dt: readonly number[];
  readonly id: ToolCallId;
  readonly name?: string;
  readonly args: readonly string[];
} | {
  readonly type: 'chunk';
  readonly time: number;
  readonly chunk: StreamChunk;
};
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2/node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: LlmRuntime;
  }
  interface Events {
    /**
     * Waterfall around every streaming model call (retry, replay, routing).
     * Bound to the {@link LlmRuntime}; call `next()` to reach the resolved
     * adapter's stream, or yield your own chunks to short-circuit.
     * @param options - the full request. A LOOP-built request carries the
     *   process-local {@link markAgentLoopRequest} identity and arrives deep-frozen
     *   (mutation throws): its content is a pure function of the session log (the
     *   reconstructability Agent Note), so listeners read it, never rewrite it.
     *   Hand-built calls do not carry that marker; their messages already obey
     *   the immutable creation contract.
     * @mode waterfall
     */
    'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>;
  }
}
/** One model call whose config and adapter registration were resolved together. */
interface PreparedLlmCall {
  /** Detached, deep-frozen config with any adapter-owned default materialized. */
  readonly config: LlmCallConfig;
  /** Immutable retry policy captured with the adapter registration. */
  readonly retryPolicy: ResolvedRetryPolicy;
  /** Detached context metadata resolved with the registration-bound call. */
  readonly context?: LlmModelContext;
  /** Exact model modalities captured with the adapter dispatch generation. */
  readonly inputModalities?: readonly ModelModality[];
  /** Exact model system prompt update mode captured with the adapter dispatch generation. */
  readonly systemPromptUpdate?: SystemPromptUpdate;
  /** Config fields materialized by the captured adapter rather than proposed by the caller. */
  readonly adapterDefaults: LlmCallConfigAdapterDefaults;
  /**
   * Dispatch this call once through the registration captured during
   * preparation. The request's call-config fields must match {@link config};
   * reuse or mismatch fails with `INVALID_PREPARED_CALL`.
   * @param options - fully assembled request carrying the prepared config.
   * @returns the chunk stream, including the `llm/stream` waterfall.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/** One adapter-owned model-resolution generation bound to its eventual stream call. */
interface PreparedAdapterCall {
  /** Exact model metadata from the same adapter generation as {@link stream}. */
  readonly model: LlmResolvedModelInfo;
  /** Dispatch through that generation without re-reading dynamic connection facts. */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/**
 * Provider-wire adapter for the harness message and stream vocabulary. Register implementations
 * with `ctx.llm.registerAdapter(providers, adapter)`. Every provider HTTP request must include
 * `attributionHeaders()`; prove the headers are added in the wire request or library header hook. The direct-fetch
 * DeepSeek and library-backed pi-ai adapters meet this contract through different internals.
 */
declare abstract class LlmAdapter {
  /**
   * Describe one provider route owned by this adapter.
   * @param provider - a route passed to `registerAdapter()` for this instance.
   * @returns detached display metadata whose id must equal `provider`.
   */
  providerInfo(provider: string): LlmProviderInfo;
  /**
   * Return the provider-owned retry policy captured with this route.
   * @param _provider - a route passed to `registerAdapter()` for this instance.
   * @returns a resolved policy, or `undefined` to use the normal defaults.
   */
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined;
  /**
   * Resolve provider-side request-image pricing for one exact model route.
   * The default declares none, so consumers fall back to their own neutral
   * estimate. Implementations must answer synchronously without I/O; the
   * token meter resolves this per measurement.
   * @param _provider - a route passed to `registerAdapter()` for this instance.
   * @param _model - exact model id passed to {@link GenerateOptions.model}.
   * @returns route-owned image pricing, or `undefined` when the route declares none.
   */
  imageRequestPricing(_provider: string, _model: string): LlmImageRequestPricing | undefined;
  /**
   * List models this adapter can currently advertise for one owned provider.
   * The result is advisory: an adapter may accept unlisted model ids, and
   * consumers must not turn absence into request rejection.
   * @param _provider - one provider route owned by this adapter.
   * @returns discoverable models in adapter-preferred order.
   */
  listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
  /**
   * Resolve all metadata available for one exact model. This query is
   * independent of the advisory catalog and does not validate request routing.
   * @param provider - one provider route owned by this adapter.
   * @param model - exact model id passed to {@link GenerateOptions.model}.
   * @param _signal - cancellation for this exact-model lookup; asynchronous
   *   implementations must settle promptly after it aborts.
   * @returns provider/model identity plus any context, call-default, and reasoning metadata.
   */
  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  /**
   * Bind exact model metadata and the eventual request dispatch to one adapter generation.
   * Dynamic adapters override this so settings changes between preparation and
   * dispatch cannot combine one generation's capabilities with another's endpoint.
   * @param provider - registered provider route.
   * @param model - exact model id.
   * @param signal - cancellation for model resolution.
   * @returns model metadata and a one-generation stream entry point.
   */
  prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
  /**
   * Stream one model call as raw chunks. The only required method.
   * @param options - the fully-assembled request; implementations must honor `options.signal`.
   * @returns the chunk stream, obeying the adapter contract documented on `StreamChunk`.
   */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/**
 * What {@link LlmRuntime.registerAdapter} returns: the disposer, plus an
 * atomic route replacement for the same adapter instance.
 */
interface AdapterRegistrationHandle {
  /** Release every route this registration currently holds. */
  (): void;
  /**
   * Replace this registration's routes with `providers`, keeping the same
   * adapter instance. The candidate set is validated in full first — a
   * conflict with another adapter, an invalid name, or bad provider metadata
   * throws and leaves the current routes untouched — and the swap itself is
   * one synchronous section, so no request can observe a gap. An empty array
   * is legal here (a settings section that emptied holds zero routes while
   * staying registered), unlike an empty initial registration.
   *
   * Throws `LlmError` with code `REGISTRATION_DISPOSED` once the registration
   * has been released: its routes are gone and its disposer has already run,
   * so anything registered afterwards would have no owner left to release it.
   * @param providers - the complete next route set for this registration.
   */
  replace(providers: string[]): void;
}
/**
 * A live configurable-provider registration, disposable and atomically
 * replaceable — the directory counterpart of {@link AdapterRegistrationHandle}.
 */
interface DirectoryRegistrationHandle {
  /** Withdraw every entry this registration currently holds. */
  (): void;
  /**
   * Replace this registration's entries with `entries`. The candidate set is
   * validated in full first — an entry another registration already declares,
   * a duplicate within the set, or invalid metadata throws and leaves the
   * current entries untouched — and the swap is one synchronous section, so no
   * reader observes a gap. An empty array is legal here, unlike an empty
   * initial registration.
   *
   * Throws `LlmError` with code `REGISTRATION_DISPOSED` once the registration
   * has been disposed.
   */
  replace(entries: readonly LlmConfigurableProvider[]): void;
}
/**
 * The abstract `llm` service: an adapter registry plus a streaming model-call
 * API, interceptable via the `llm/stream` waterfall.
 */
declare class LlmRuntime extends TypertRemoteService {
  private adapters;
  private directory;
  private discoveries;
  constructor(ctx: Context);
  /** Notify topology observers without letting one broken listener veto the commit. */
  private emitAdaptersUpdated;
  /** Contained-listener diagnostic shared by the sync and async failure paths. */
  private warnAdaptersListenerFailure;
  /**
   * Register an adapter for the given provider routes. Throws `LlmError` with code
   * `DUPLICATE_ADAPTER` if any provider already has an adapter (all-or-nothing).
   * Disposed with the fiber.
   * @param providers - every provider route this adapter should serve.
   * @param adapter - the adapter that streams calls for those providers.
   * @returns the disposer, carrying {@link AdapterRegistrationHandle.replace}.
   */
  registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle;
  /**
   * Validate one candidate route set for `adapter`, treating routes this
   * registration already holds as available. Nothing is mutated: a rejected
   * candidate leaves the registry exactly as it was.
   */
  private prepareRoutes;
  /**
   * Swap this registration's routes for the prepared ones in one synchronous
   * section, so no observer can see the registry between the release and the
   * re-registration. The route set's one mutation point is also where
   * `llm/adapters-updated` is published, so a `replace` announces itself
   * exactly like a first registration.
   */
  private commitRoutes;
  /**
   * Describe provider routes with a registered adapter.
   * @returns detached provider metadata in registration order.
   */
  listProviders(): LlmProviderInfo[];
  /**
   * Declare provider routes an adapter plugin can activate through
   * configuration. Registration is all-or-nothing: an empty list, invalid
   * entry, or a provider already declared by any registration throws
   * `LlmError` without registering the rest. Disposed with the fiber.
   * @param entries - every configurable provider this plugin owns.
   * @returns a handle that withdraws all of them, and can atomically replace them.
   */
  registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): DirectoryRegistrationHandle;
  /**
   * List every declared configurable provider, registered or dormant.
   * @returns detached directory entries in declaration order.
   */
  listConfigurableProviders(): LlmConfigurableProvider[];
  /**
   * Offer to interrogate provider endpoints on behalf of the settings
   * namespace this plugin owns. The namespace is the key because that is what
   * a configuration surface already holds from the configurable-provider
   * directory, and because a provider being *added* has no route to name yet.
   * Disposed with the fiber.
   * @param settingsNs - the namespace whose profiles this discovery serves.
   * @param discover - interrogates one endpoint and must honor the supplied signal.
   * @returns the disposer that withdraws the offer.
   */
  registerModelDiscovery(settingsNs: string, discover: (request: LlmModelDiscoveryRequest, signal?: AbortSignal) => Promise<readonly LlmDiscoveredModel[]>): () => void;
  /**
   * Interrogate one provider endpoint for the models it advertises. The
   * request describes a draft, not a stored route, so nothing here reads or
   * writes settings or credentials — the caller owns both, and the reply is
   * candidate metadata a surface may offer for adoption.
   * @param settingsNs - namespace whose registered discovery serves this draft.
   * @param request - the endpoint, protocol, and one-shot credential to use.
   * @param signal - caller cancellation.
   * @returns the advertised models, deduplicated in endpoint order.
   */
  discoverModels(settingsNs: string, request: LlmModelDiscoveryRequest, signal?: AbortSignal): Promise<LlmDiscoveredModel[]>;
  /**
   * Remote adapter for one draft provider interrogation.
   * @param settingsNs - namespace whose registered discovery serves this draft.
   * @param request - endpoint, protocol, and one-shot credential to use.
   * @param signal - caller cancellation supplied by the Remote carrier.
   * @returns advertised models in endpoint order.
   * @throws RemoteError with `llm/model-discovery-rejected` when discovery refuses or fails.
   */
  remoteDiscoverModels(settingsNs: string, request: LlmModelDiscoveryRequest, signal: AbortSignal): Promise<LlmDiscoveredModel[]>;
  /**
   * Resolve the retry policy captured when one provider route was registered.
   * @param provider - registered provider route to inspect.
   * @returns the provider-owned policy, with normal defaults already resolved.
   */
  providerRetryPolicy(provider: string): ResolvedRetryPolicy;
  /**
   * Resolve provider-side request-image pricing for one exact route, or
   * `undefined` when the provider is unregistered or declares none. Unknown
   * providers degrade to `undefined` rather than throwing because callers
   * price durable history whose route may no longer be mounted.
   * @param provider - provider route named by a request header.
   * @param model - exact model id named by the same header.
   * @returns the owning adapter's image pricing for the route, when declared.
   */
  imageRequestPricing(provider: string, model: string): LlmImageRequestPricing | undefined;
  /**
   * Resolve the exact text one durable file occurrence contributes to every
   * provider request in the current execution environment.
   * @param ref - durable verbatim file reference from model history.
   * @returns the same deterministic handle text used at adapter dispatch.
   */
  fileRequestText(ref: FileAttachmentRef): string;
  /** Detach typed adapter-owned modality metadata. */
  private detachedModalities;
  /**
   * Discover models advertised by one registered provider. Catalog membership
   * is advisory and never changes routing or request validation.
   * @param provider - registered provider route to inspect.
   * @returns detached model metadata in adapter-preferred order.
   */
  listModels(provider: string): Promise<LlmModelInfo[]>;
  /**
   * Resolve and validate all metadata from the adapter that owns one exact
   * route. The result is detached from adapter-owned objects; catalog
   * membership remains advisory and does not control request routing.
   * @param provider - registered provider route to inspect.
   * @param model - exact model id passed to the adapter.
   * @param signal - optional cancellation for adapter-owned asynchronous lookup.
   * @returns exact model identity plus available context and reasoning metadata.
   */
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  private resolveModelInfoFor;
  /** Validate and detach one adapter-returned exact model result. */
  private normalizeModelInfo;
  /**
   * Validate a conversation call config against its exact model capability and
   * materialize adapter-configured defaults. Unsupported explicit efforts
   * reject before provider I/O; no clamping or aliasing is performed. This
   * standalone query does not bind a later dispatch; use {@link prepareCall}
   * when logging and streaming must share one adapter registration.
   * @param config - provider/model route and optional request controls.
   * @param signal - optional cancellation for adapter-owned capability lookup.
   * @returns a detached config only when a default must be materialized.
   */
  resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>;
  private resolveCallFor;
  /** Validate request controls against one already-bound exact model result. */
  private resolveCallWithInfo;
  /**
   * Resolve one call under its current adapter registration. The returned
   * one-shot handle keeps that registration across header logging and dispatch,
   * so HMR cannot combine one adapter's capability result with another adapter.
   * @param config - provider/model route and optional request controls.
   * @param signal - optional cancellation for adapter-owned capability lookup.
   * @returns a prepared config and its registration-bound stream entry point.
   */
  prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>;
  private registration;
  /** Remove replay state whose historical route is owned by another adapter. */
  private forAdapter;
  /**
   * Resolve the current execution-world read path of one durable file
   * reference through the mounted attachment and filesystem providers.
   */
  private fileReadPath;
  /**
   * Final adapter boundary. Adapter selection, dispatch, iterator construction,
   * and iteration failures become one terminal failure chunk. Middleware and
   * downstream consumer failures remain thrown plugin or consumer errors.
   */
  private adapterStream;
  /**
   * Stream one model call as raw chunks (token-level deltas). Replay state is
   * retained only when the same adapter instance owns its historical provider
   * and the target provider. Final adapter selection remains fixed through
   * asynchronous exact-model resolution and dispatch. Adapter selection,
   * dispatch, and iteration failures become terminal `error` or `aborted`
   * finish chunks; middleware, nested-call, cleanup, and consumer failures
   * remain thrown.
   * @param options - the full request; `options.provider` selects the adapter.
   * @returns the chunk stream, possibly wrapped by `llm/stream` listeners.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  private streamWithRegistration;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-util-values@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2/node_modules/@deepseek-ai/dsh-util-values/lib/types/index.d.ts
/** Duplicate-install-safe JSON and immutable-value helpers. @module @deepseek-ai/dsh-util-values */
/** A value that round-trips through JSON without loss. */
type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2_@deepseek-ai+dsh-scope@0._54d1a918d77e481567353c23a9e2039f/node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts
/** Identifies one session in the store (and its persistence artifacts). */
type SessionId = Branded<'SessionId'>;
/**
 * Brand a string as a {@link SessionId}.
 * @param id - the raw session id string.
 * @returns the same string with the session-id brand.
 */
declare function SessionId(id: string): SessionId;
/** Sequence number of one existing event in a Session log. */
type SessionSeq = BrandedNumber<'SessionSeq'>;
/**
 * Admit a numeric value as an existing Session event position.
 * @param value - non-negative safe integer admitted by the owning log operation.
 * @returns the same number with the Session-sequence brand.
 */
declare function SessionSeq(value: number): SessionSeq;
/** A Session log gap, prefix length, or read offset, which may equal the event count. */
type SessionLogOffset = BrandedNumber<'SessionLogOffset'>;
/**
 * Admit a numeric value as a Session log offset.
 * @param value - non-negative safe integer used as a gap or prefix length.
 * @returns the same number with the Session-log-offset brand.
 */
declare function SessionLogOffset(value: number): SessionLogOffset;
/** Inclusive Session event watermark, or `-1` before any event exists. */
type SessionSeqCursor = SessionSeq | -1;
/** One existing Session event position, or explicit absence. */
type OptionalSessionSeq = SessionSeq | null;
/**
 * Current logical Session format version, stamped into every newly written
 * {@link SessionHeader}. Current Session and persistence code accept only this
 * value; header-only readers classify supported historical formats, while an
 * event-body read composes the build-static adjacent chain and publishes only
 * this final generation before constructing a Session.
 *
 * The version is a single monotonic integer with no major/minor split. Whether
 * a bump is needed is decided by what the WRITER emits, never by what a newer
 * reader can accept: bump exactly when an older runtime could no longer handle
 * a new log with full semantic correctness ("parses without error" is not
 * correctness — silently skipping content that shapes reconstruction is a
 * wrong read). Only structural changes reach that bar: the header shape, the
 * {@link SessionEvent} envelope, core event semantics, or the surface
 * mechanism (the {@link SurfaceEventType} set and {@link SurfaceOp} variants).
 * Adding an ordinary event type does not bump — the per-event
 * {@link SessionEvent.ignorable} guard covers vocabulary growth instead. When
 * in doubt, bump: a near-identity upgrade step is almost free, a missed bump
 * makes older runtimes read new logs wrong silently. The released migration,
 * immutable prior-generation, and current fast-path rules are recorded in
 * `.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md`.
 */
declare const SESSION_FORMAT_VERSION = 3;
/**
 * Immutable validated storage metadata, kept outside the conversation event log.
 */
interface SessionHeader {
  /**
   * Current logical format version, stamped from {@link SESSION_FORMAT_VERSION}.
   * Historical physical headers are translated before entering this interface.
   */
  readonly version: typeof SESSION_FORMAT_VERSION;
  /** The session's id (mirrors the {@link Session}'s id). */
  readonly id: SessionId;
  /** Non-negative safe-integer Unix epoch milliseconds when the session was created. */
  readonly createdAt: number;
  /** Absolute working directory the session was created in (if any). */
  readonly cwd?: string;
  /** The session this one was forked from (seed lineage), if any. */
  readonly parentSession?: SessionId;
  /**
   * Whether this Session contains a fork-inherited event prefix. The exact prefix
   * length is Session state rather than ordinary header metadata.
   */
  readonly isSeeded: boolean;
  /**
   * Coarse product classification for a session created as a subagent child.
   * This is presentation metadata, not proof that the child is continuable.
   */
  readonly origin?: 'subagent';
  /**
   * Delegation depth: absent (zero) for a top-level session, parent depth + 1
   * for a subagent child. Persisted so a recursion budget survives restart and
   * resume — a runtime-only depth would reset a resumed child to top-level.
   */
  readonly delegationDepth?: number;
  /**
   * Id of the agent preset this session's agent was composed from, when the
   * deployment composes per session. Durable because the preset decides the
   * session's tools and prompt: a resume that restored a different composition
   * would replay history the model can no longer act on.
   */
  readonly agentPreset?: string;
}
/**
 * Options for creating a {@link Session} via the store. `seed` replays/forks
 * an existing event log; `meta` carries the caller-supplied storage fields the
 * store folds into a {@link SessionHeader}.
 */
interface CreateSessionOptions {
  /** Initial replay or fork history supplied at construction. */
  readonly seed?: readonly SessionEvent[];
  /**
   * Exact fork-inherited prefix length when `meta.isSeeded` is true. The
   * constructor seed is exactly this inherited prefix; the constructor
   * appends the child-owned tagged marker at the cut.
   */
  readonly inheritedEventCount?: SessionLogOffset;
  /**
   * Storage metadata read once before publication. `isSeeded` marks fork
   * lineage; supplying replay history alone does not make it inherited.
   */
  readonly meta?: {
    readonly cwd?: string;
    readonly parentSession?: SessionId;
    readonly createdAt?: number;
    readonly isSeeded?: boolean;
    readonly origin?: 'subagent';
    readonly delegationDepth?: number;
    readonly agentPreset?: string;
  };
}
/**
 * Aliasing state of an adoptable Session seed. `shared-frozen` permits deeply
 * frozen aliases plus independently owned unfrozen values in the same seed.
 */
type SessionSeedEventState = 'detached' | 'shared-frozen';
/**
 * Adoptable storage values transferred to {@link SessionStore.prepare}
 * without another copy or freeze pass.
 */
interface RestoredSessionOptions {
  /** Events that are independently owned or already deeply frozen. */
  readonly seed: SessionEvent[];
  /** Independently owned storage metadata to validate and freeze in place. */
  readonly meta: SessionHeader;
  /** Exact number of fork-inherited leading events decoded from storage. */
  readonly inheritedEventCount: SessionLogOffset;
  /** Aliasing state carried from the operation that produced the seed. */
  readonly eventState: SessionSeedEventState;
}
/** Inputs accepted while constructing an unpublished Session. */
type PrepareSessionOptions = (CreateSessionOptions & {
  readonly eventState?: undefined;
}) | RestoredSessionOptions;
/** Why an active agent driver was cancelled. */
type AgentCancelCause = {
  readonly kind: 'user';
} | {
  readonly kind: 'parent';
} | {
  readonly kind: 'hook';
  readonly reason: string;
} | {
  readonly kind: 'disposed';
};
/** Durable cancellation cause, including imports whose original coarse record carried no cause. */
type TurnEndCancelCause = AgentCancelCause | {
  readonly kind: 'legacy';
};
/**
 * Why a turn ended. Merge-extensible sum type.
 */
interface TurnEndReasonMap {
  completed: {
    kind: 'completed';
  };
  /** A cancellation request interrupted the live turn. */
  aborted: {
    kind: 'aborted';
    reason: TurnEndCancelCause;
  };
  blocked: {
    kind: 'blocked';
  };
  /**
   * The turn failed. `error` is always a structured failure: the `LlmError`
   * facts verbatim, or `{ message: errorChain(error), code: 'UNKNOWN' }`
   * flattened from any other error.
   */
  error: {
    kind: 'error';
    error: LlmFailure;
  };
  /** At least one step reached its output-token ceiling, even if a plugin continued the turn. */
  'max-tokens': {
    kind: 'max-tokens';
  };
  /**
   * A crash-orphaned turn was closed after the fact: agent-loop resume appends
   * this closer for a stored log whose last turn never ended, and session-query
   * synthesizes it on cold reads. The loop never emits this marker live, and
   * the events recorded before the crash remain intact.
   */
  interrupted: {
    kind: 'interrupted';
  };
}
/** The union over {@link TurnEndReasonMap} — why a turn ended; plugins extend it by merging variants into the map. */
type TurnEndReason = TurnEndReasonMap[keyof TurnEndReasonMap];
/**
 * Logged request state outside derived history: call config and tools. The
 * system prompt is derived history — surface node 0, a `system/message` event.
 * The latest full `request/header` snapshot reconstructs the header; canonical
 * empty optional fields are absent.
 */
interface EpochHeader {
  /** The conversation's call configuration (provider, model, reasoning effort, and sampling scalars). */
  config: LlmCallConfig;
  /** Effective config fields materialized from the exact adapter rather than proposed by a caller. */
  adapterDefaults?: LlmCallConfigAdapterDefaults;
  /** Assembled tool schemas; absent for a tool-less request. */
  tools?: ToolSchema[];
}
/** Registration-bound metadata for one resolved model route. */
interface RequestContext {
  /** Registered provider route the metadata belongs to. */
  provider: string;
  /** Provider-owned model id the metadata belongs to. */
  model: string;
  /** Maximum combined request and response context in tokens, when advertised. */
  contextWindow?: number;
  /** `'in-history'` when the route reads the latest `system` message at any position as the effective system prompt. */
  systemPromptUpdate?: SystemPromptUpdate;
}
/**
 * Why a `request/header` snapshot was appended: `'initial'` — the log's first
 * header (a new conversation); `'resume'` — a loop instance's first request
 * over a log that already has header events (process restart, fork seed);
 * `'change'` — a later request used a different header, with `startsSeries`
 * preserving a coincident series boundary; `'series'` — an unchanged header
 * began an explicitly distinct message series or followed a surface replacement.
 */
type RequestHeaderReason = 'initial' | 'resume' | 'change' | 'series';
/**
 * The merge-extensible, append-only source of truth for an agent interaction.
 * Message history is derived from this log. Every event is lossless JSON and
 * sequence numbers stay contiguous. Assistant attempt events embed their exact
 * compact raw streams so persistence stores one durable settlement per attempt.
 */
interface SessionEventMap {
  /**
   * Opens turn `turn` before the loop claims queued input or runs pre-step.
   * Rejection, empty input, cancellation, or failure may close it with no
   * step; otherwise the following identified `user/message` event or batch
   * records the messages entering the step.
   */
  'turn/start': {
    turn: number;
  };
  /**
   * Closes turn `turn` with the {@link TurnEndReason} that ended it. A turn
   * with no entered step has no `step/start` or `step/end`. The loop does not await a
   * flush at turn boundaries: `dsh-session-checkpoint-policy` owns the
   * per-request durability checkpoint, and consumers that read storage after
   * `whenIdle()` flush themselves. Success commits the turn; rejection is
   * reported live and does not prevent later work.
   */
  'turn/end': {
    turn: number;
    reason: TurnEndReason;
  };
  /** Opens step `step` of turn `turn` — one model call plus the tool executions it requested. */
  'step/start': {
    turn: number;
    step: number;
  };
  /** Closes step `step` of turn `turn`. */
  'step/end': {
    turn: number;
    step: number;
  };
  /**
   * A user-role message on the model-visible surface: a direct human prompt
   * (the queued message claimed for this turn), a synthetic `agent.inject()`
   * context (file-change notices, subdir AGENTS.md, skill content, cron
   * notifications, …), or an entered goal continuation round. All three
   * project their `content` verbatim; `source` tells them apart.
   */
  'user/message': UserMessage$1;
  /**
   * The rendered system prompt on the model-visible surface. The loop appends
   * the first one as surface node 0 before the step's first `user/message`.
   * A prepared in-history route can append nonempty changes in a continuing
   * series. An incapable route or new series normalizes text to the first system
   * node. Normalization empties nonempty later nodes, then rewrites the head if
   * needed, through logged per-node replacements. An empty rendering always
   * clears all active system nodes, leaving no older instructions model-visible.
   * Empty later nodes are dormant and project to no message; an empty head with
   * no active later node records "no system prompt". Restored nonempty text follows
   * the same route and series rule; empty nodes never restore older text.
   */
  'system/message': {
    turn: number;
    step: number;
    message: SystemMessage;
  };
  /**
   * Assembled assistant message for one step (derived history uses this).
   * Carries the step's `usage` when the adapter reported token accounting, so
   * the model output and its accounting travel together (there is no separate
   * usage record). `usage` is absent when the adapter reported none. A turn
   * cancelled mid-stream finalizes its delivered text/reasoning prefix as this
   * event with `interrupted: true`; undispatched tool calls are absent. The
   * marker distinguishes that prefix without re-deriving interruption from turn
   * boundaries. An aborted turn with no such event streamed no visible content.
   */
  'assistant/message': {
    turn: number;
    step: number;
    message: AssistantMessage$1;
    /** Exact timed model stream, compacted without joining delta boundaries. */
    stream: AssistantStreamRecord[];
    usage?: TokenUsage;
    interrupted?: true;
  };
  /**
   * One model attempt that committed no surface message. The embedded stream
   * preserves a failed, retried, cancelled, or stream-error attempt that
   * reached settlement without fabricating model-visible history.
   */
  'assistant/attempt': {
    turn: number;
    step: number;
    stream: AssistantStreamRecord[];
  };
  /**
   * The model requested one tool invocation: `name` with the raw `arguments`
   * JSON string exactly as the model produced it (unparsed). `callId` pairs the
   * call with its `tool/result`.
   */
  'tool/call': {
    turn: number;
    step: number;
    callId: ToolCallId;
    name: string;
    arguments: string;
  };
  /**
   * A completed tool call's model-facing result, optional internal failure
   * identity, and optional tool-private `meta` presentation payload. `meta` is
   * opaque to the core (the producing tool owns its shape and reads it back in
   * `presentResult`) but MUST be JSON-serializable: `Session.append`
   * runtime-validates all event data with `isJsonValue`, so a non-serializable
   * `meta` is rejected at the source, and the durable log reproduces the
   * identical card on replay. Absent
   * unless the tool attaches one (e.g. `dsh-tool-fs` carries its result-time
   * contextual diff here).
   */
  'tool/result': {
    turn: number;
    step: number;
    message: ToolResultMessage;
    /** Optional failure identity; allowed only when the tool-result block has `isError: true`. */
    error?: {
      name: string;
      code: string;
    };
    meta?: JsonValue;
  };
  /**
   * Full header for the next request, appended inside its step before dispatch.
   * It is log-only; the latest snapshot reconstructs the request header.
   */
  'request/header': {
    header: EpochHeader;
    reason: RequestHeaderReason;
    /** A changed header also begins a distinct model-message series. */
    startsSeries?: true;
  };
  /**
   * Route metadata for the next request, logged only when the route, capacity,
   * or system prompt update mode changes. It does not participate in request
   * reconstruction or header equality. Prompt admission uses the bound prepared
   * call's capability, not this snapshot from an earlier request.
   */
  'request/context': RequestContext;
  /**
   * Marks the end of a constructor seed. Events before it have smaller seq
   * values and came from the seed (resume, fork, or replay); this lifecycle
   * produced none of them. This log-only event is the durable projection of
   * {@link Session.firstLiveSeq}.
   *
   * A fresh fork child owns one `{ inherited: true }` marker at its exact
   * inherited-prefix cut, even when that prefix ends in an ancestor marker.
   * The last tagged marker is the current Session's cut; untagged markers keep
   * ordinary restore and replay lifecycle boundaries.
   *
   * `Session`'s constructor is the only legitimate writer. The invariant
   * companion deliberately constrains nothing here, so a plugin appending one
   * would silently classify every live bracket before it as seed history.
   *
   * An owner of a standalone open/close bracket (`compaction/start` …
   * `compaction/end`) reads it because seed history and live work are otherwise
   * byte-identical: an unmatched opening marker before this event belongs to
   * an ended lifecycle, whatever ended it. NOT a liveness signal about other
   * writers — a concurrently live session holds its own boundary elsewhere,
   * so tolerating concurrent writers needs a signal beyond the log.
   */
  'session/end-seed': {
    inherited?: true;
  };
}
/** The appendable event-type keys of {@link SessionEventMap}, plugin-merged extensions included. */
type SessionEventType = keyof SessionEventMap;
/**
 * The subset of {@link SessionEventType} values whose events produce LLM
 * messages and are eligible to appear on the ordered surface. Only these
 * event types may carry {@link SurfaceOp}; system, user, and tool events may also cite
 * earlier sources through {@link SessionEvent.sourceEventSeqs}.
 */
type SurfaceEventType = 'system/message' | 'user/message' | 'assistant/message' | 'tool/result';
/** A message-producing event carrying its required surface operation. */
type SurfaceEvent = SessionEvent<SurfaceEventType>;
/**
 * How a session event entered the ordered surface. Only valid on
 * {@link SurfaceEventType} events.
 *
 * - `'append'`: added to the tail — normal path for user/assistant/tool
 *   messages.
 * - `{ op: 'replace', startSeq, endSeq }`: replaces surface nodes from `startSeq`
 *   (inclusive) through `endSeq` (inclusive) with this node. Both must exist as
 *   surface nodes in the current surface. `startSeq === endSeq` replaces a single
 *   node. The node's {@link SessionEvent.sourceEventSeqs} must include every
 *   shadowed surface node. Used by compaction; any surface-replacing producer
 *   may use it.
 */
type SurfaceOp = 'append' | {
  op: 'replace';
  startSeq: SessionSeq;
  endSeq: SessionSeq;
};
/**
 * Surface placement and cited source-event seqs for {@link Session.append}. Required on
 * message-producing events and forbidden on log-only events.
 */
type SurfaceIntent<T extends SurfaceEventType = SurfaceEventType> = {
  surfaceOp: SurfaceOp;
} & (T extends 'assistant/message' ? {
  /** Assistant messages embed their provider stream instead of citing source events. */
  sourceEventSeqs?: never;
} : {
  /** Complete non-empty set of known earlier source-event seqs. */
  sourceEventSeqs?: SessionSeq[];
});
/**
 * One immutable entry in the session log.
 *
 * A proper discriminated union over `type` (not independent `type`/`data`
 * unions), so `switch (event.type)` narrows `event.data` without casts.
 *
 * The {@link sourceEventSeqs} and {@link surfaceOp} fields are conditional:
 * they only exist on {@link SurfaceEventType} variants (`system/message`, `user/message`,
 * `assistant/message`, `tool/result`).
 * Non-surface events (boundary markers, attempts, errors) never carry
 * surface metadata — the compiler enforces this at `Session.append()`
 * call sites.
 */
type SessionEvent<T extends SessionEventType = SessionEventType> = { [K in SessionEventType]: {
  type: K;
  /** Monotonic sequence number within the session. */
  seq: SessionSeq;
  /** Unix epoch milliseconds. */
  time: number;
  data: SessionEventMap[K];
  /**
   * Marks an event a reader may safely skip when it does not recognize
   * `type`. Absent means required: a reader meeting an unrecognized type
   * without this marker MUST refuse to reconstruct the session instead of
   * silently dropping the event, because an unrecognized required event may
   * change how the rest of the log is interpreted. A writer sets `true` only
   * on purely informational records whose loss cannot affect reconstruction;
   * defaulting to required means a forgotten marker over-refuses (an
   * inconvenience) rather than silently resuming a gutted session.
   */
  ignorable?: true;
} & (K extends SurfaceEventType ? SurfaceIntent<K> : {
  surfaceOp?: never;
  sourceEventSeqs?: never;
}); }[T];
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The named Session does not exist; produced by every layer that resolves a SessionId. */
    'session/not-found': {
      readonly sessionId: SessionId;
    };
  }
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-agent@0.1.5-rc.2_6df6622855b87cb7fde1fe609a6d039a/node_modules/@deepseek-ai/dsh-agent/lib/types/types.d.ts
/** Public live-agent handle; the runtime face augments its live capabilities. */
interface Agent {
  /** Session-backed Agent identity. */
  readonly id: SessionId;
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    agent: TypertLookup<Agent, SessionId>;
  }
  interface TypertContextMap {
    /** Agent Context identity shared by Host and Client adapters. */
    agent: TypertContext<SessionId>;
  }
}
/** One of the two ordered pending-message lists owned by an agent. */
type InboxTarget = 'next-turn' | 'next-step';
/** Complete pending Inbox value reconstructed from durable splices. */
interface InboxState {
  readonly 'next-turn': readonly UserMessage$1[];
  readonly 'next-step': readonly UserMessage$1[];
}
/**
 * Wire-JSON pending Inbox value. Each message round-trips the session log
 * losslessly, but the fold state's full `UserMessage` type cannot cross a
 * typert Remote boundary (its source union carries an `unknown` replay
 * field), so the typed projection table keeps this JSON-safe form.
 */
interface InboxWireState {
  readonly 'next-turn': readonly JsonValue[];
  readonly 'next-step': readonly JsonValue[];
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Pending agent input reconstructed from durable inbox splices. */
    inbox: InboxState;
  }
  interface SessionProjectionMap {
    /** Pending agent input reconstructed from durable inbox splices. */
    inbox: InboxWireState;
  }
}
/**
 * Turn and step boundaries folded from one agent session log.
 *
 * Reader contract: the key is registered by `dsh-agent-loop` and absent
 * otherwise. Without agent-loop no turn events exist, so readers treat an
 * absent key as "no open turn / no boundaries" — capability absence, not a
 * corrupt state. A reader whose behavior has no safe fallback for that
 * absence (the step-open decision, for example) may fail loud instead.
 */
interface TurnBoundaryProjection {
  /** Seq of the open turn's `turn/start`, or null between turns. */
  readonly openTurnStartSeq: OptionalSessionSeq;
  /** Seq of the latest `step/start` event, or null before the first step. */
  readonly lastStepStartSeq: OptionalSessionSeq;
  /** The latest step boundary (`step/start` or `step/end`) and its seq, or null before the first step boundary. */
  readonly lastStepBoundary: {
    readonly kind: 'start' | 'end';
    readonly seq: SessionSeq;
  } | null;
  /** Turn number of the latest `turn/start`; 0 before the first turn. */
  readonly lastTurn: number;
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One normalized mutation of an agent's durable pending-message lists.
     * The session-projection registry applies the committed event before
     * `Session.append()` returns; Inbox live notifications follow that commit.
     */
    'agent/inbox/spliced': {
      target: InboxTarget;
      start: number;
      removedCount?: number;
      inserted: UserMessage$1[];
      outcome?: 'canceled';
    };
  }
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-user-questions@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2_@deepseek-ai+dsh-a_9b8f2b605fd43464c281ed361980b9b2/node_modules/@deepseek-ai/dsh-user-questions/lib/types/types.d.ts
/** One selectable answer offered to the user. */
interface AskUserQuestionOption {
  /** User-facing label. */
  label: string;
  /** Optional extra context rendered by capable UIs. */
  description?: string;
}
/**
 * A caller-declared presentation intent: the question IS this kind of
 * decision, so a UI that recognises the tag may present it as such instead of as a
 * generic option list. Tagged so further intents can be added; a UI that does
 * not know a tag renders the generic flow, and the answer encoding is identical
 * either way — an intent changes presentation only, never the protocol.
 */
type AskUserQuestionIntent = {
  /** A plan submitted for review: `detail` is the plan markdown `ask()` requires, and the decision approves or declines it. */
  kind: 'plan-review';
  /**
   * The option label that approves the plan; every other option declines it.
   * Named rather than positional so no UI infers the verdict from option order.
   * An `approve` naming no option of its own question is rejected at `ask()`.
   */
  approve: string;
};
/** One question in a user-questions request. */
interface AskUserQuestionItem {
  /** Stable caller-provided question id, echoed in the answer. */
  id: string;
  /** The question to display. */
  question: string;
  /** Optional supporting detail rendered with the question but kept out of option labels. */
  detail?: string;
  /** Optional short heading/group label. */
  header?: string;
  /** Optional choices the UI can render as a menu. */
  options?: AskUserQuestionOption[];
  /** Whether more than one option may be selected. Defaults to single-select. */
  multiSelect?: boolean;
  /** Optional presentation intent for capable UIs; absent asks for the generic option list. */
  intent?: AskUserQuestionIntent;
}
/** Answer to one question. */
interface AskUserQuestionAnswerItem {
  /** The answered question id. */
  id: string;
  /** Selected option labels. May accompany custom text for a multi-select question. */
  selected: string[];
  /** Optional free-text "Other" answer. */
  custom?: string;
}
/** The human's answer. */
interface AskUserQuestionAnswer {
  /** Structured answers keyed by question id. */
  answers: AskUserQuestionAnswerItem[];
}
/** Client-safe payload declared for the user-question answerer waterfall. */
interface AskUserQuestionRequestEvent {
  /** Questions to display. */
  questions: AskUserQuestionItem[];
  /** Agent identity projected to the corresponding Client Context in transit. */
  agent?: Agent;
  /** Cancellation lifetime of the pending request. */
  signal?: AbortSignal;
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Ask composed answerers for structured user input. Return an answer to
     * claim the request or call `next()` to delegate. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param request - pending user-question request.
     * @mode waterfall
     */
    'user-questions/request'(this: Scoped<Agent>, request: AskUserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer>;
  }
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session-projection@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2_@deepseek-ai+d_84cd66f454dbfc7490c4215f4e78e5dd/node_modules/@deepseek-ai/dsh-session-projection/lib/types/types.d.ts
/**
 * Pure-type outlet of the session-projection Service Definition: the one projection type
 * table, importable from client aggregates without dragging the host-side
 * cordis Context merges of the package root (dsh-agent → dsh-session). Domain
 * packages may declare-merge through either the package root or this outlet —
 * re-export preserves symbol identity, so both land on the same table.
 *
 * @module @deepseek-ai/dsh-session-projection/types
 */
/**
 * The merge-extensible client projection table shared by wire blocks, client
 * cells, and React hooks. Domain packages merge their client-visible key here;
 * values are wire-JSON whole values. How a value is rendered is the slot
 * system's business, never this layer's.
 */
interface SessionProjectionMap {}
/**
 * The merge-extensible host fold-state table. Each client-visible key also
 * appears in {@link SessionProjectionMap}; host-only keys appear only here.
 * Values must be plain JSON so the projection cache can persist them.
 */
interface SessionProjectionStateMap {}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-workspace@0.1.5-rc.2_2faf0849fbdc6ac5919de8226950d80c/node_modules/@deepseek-ai/dsh-workspace/lib/types/types.d.ts
/**
 * Identifies one workspace record. A generated uuid, never the path: path
 * normalization rewrites paths, and a reference anchor must stay stable.
 */
type WorkspaceId = Branded<'WorkspaceId'>;
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No registration carries that Workspace identity. */
    'workspace/not-found': {
      readonly workspaceId: WorkspaceId;
    };
  }
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-api-session-controller@0.1.5-rc.2_f6abae79571f790534db48922cafdc73/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/types.d.ts
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host state persisted for cold Session list summaries. */
    sessionListMetadata: SessionListMetadata;
    /** Host state for the boot-constant image-limit view. */
    imageLimits: null;
    /** Durable model selection already used by a request and still pending for a later request. */
    modelSelection: ModelSelectionProjectionState;
  }
  interface SessionProjectionMap {
    /** Persisted facts used to summarize a Session without activating it. */
    sessionListMetadata: SessionListMetadata;
    /** Image-intake limits enforced by the Session prompt endpoint. */
    imageLimits: ImageAttachmentLimits;
    /** Durable model selection already used and selected for the next request. */
    modelSelection: ModelSelectionProjection;
  }
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Complete validated model selection requested for subsequent prompt
     * assembly. Log-only: it never enters derived model history.
     */
    'model/selection': ModelSelection;
  }
}
/** Persisted hints used to summarize a cold Session. */
interface SessionListMetadata {
  /** Whether the folded prefix contains no turn. */
  readonly blank: boolean;
  /** Latest human-authored prompt time in the folded prefix. */
  readonly lastPromptAt: number | null;
}
/** Every available cached wire value used as partial, possibly stale Session-list hints. */
interface SessionProjectionHints {
  readonly asOfSeq: number;
  /** Provider-validated values present in the cache; omitted keys remain unknown. */
  readonly values: SessionProjectionValues;
}
/** Complete projection values at an exact Session event cursor. */
interface SessionProjectionBaseline {
  readonly asOfSeq: number;
  /** Provider-validated values; omitted keys are absent capabilities at this cut. */
  readonly values: SessionProjectionValues;
}
/** Typed known projections plus JSON-safe values contributed outside this compilation face. */
type SessionProjectionValues = Partial<SessionProjectionMap> & Readonly<Record<string, SessionProjectionValue>>;
/**
 * Browser-submitted prompt content; the Host promotes image bytes to durable
 * references. File parts carry the opaque receipt returned by a preceding
 * `uploadFile` call on the same Session.
 */
type PromptContentPart = {
  readonly type: 'text';
  readonly text: string;
} | {
  readonly type: 'image';
  readonly mediaType: ImageMediaType;
  readonly data: string;
  readonly name?: string;
} | {
  readonly type: 'file';
  readonly receiptId: Branded<'file-upload-receipt-id'>;
};
/** Complete model selection for one Session. */
interface ModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}
/** Host fold state for durable model selection. */
interface ModelSelectionProjectionState {
  /** Selection consumed by the latest recorded model request. */
  readonly lastUsed: ModelSelection | null;
  /** Later user selection not yet consumed by a matching model request. */
  readonly pending: ModelSelection | null;
}
/** Client view of the durable model-selection fold. */
interface ModelSelectionProjection {
  /** Selection consumed by the latest recorded model request. */
  readonly lastUsed: ModelSelection | null;
  /** Selection the next request should use, falling back to {@link lastUsed}. */
  readonly next: ModelSelection | null;
}
/** One adapter-owned reasoning effort for an exact model route. */
interface ModelReasoningEffort {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}
/** Selectable reasoning metadata for one exact model route. */
interface ModelReasoning {
  readonly efforts: readonly ModelReasoningEffort[];
  readonly defaultEffort?: string;
}
/** One model displayed inside its provider group. */
interface ModelCatalogModel {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly reasoning?: ModelReasoning;
}
/** One provider and its successfully loaded model catalog. */
interface ModelProviderGroup {
  readonly id: string;
  readonly name: string;
  readonly models: readonly ModelCatalogModel[];
}
/** One provider whose model catalog lookup failed. */
interface ModelCatalogFailure {
  readonly id: string;
  readonly name: string;
  readonly message: string;
}
/** Host-generation model catalog and the default used by unconfigured Sessions. */
interface ModelCatalog {
  readonly default: ModelSelection;
  /** Provider routes currently able to serve a request, including empty catalogs. */
  readonly routableProviders: readonly string[];
  readonly groups: readonly ModelProviderGroup[];
  readonly failures: readonly ModelCatalogFailure[];
}
/** One client-requested mutation of a still-pending queue item. */
type QueueAction = {
  readonly kind: 'edit';
  /** Non-empty text-only replacement content. */
  readonly content: readonly ContentBlock[];
} | {
  readonly kind: 'remove';
} | {
  readonly kind: 'steer';
};
/** One Session list entry. */
interface SessionSummary$1 {
  readonly sessionId: SessionId;
  readonly updatedAt: number;
  readonly running: boolean;
  readonly blank: boolean;
  readonly parentSessionId?: SessionId;
  readonly origin?: 'subagent';
  readonly cwd?: string;
  readonly projections?: SessionProjectionHints;
}
/** One session-content search result. */
interface SessionSearchItem {
  readonly sessionId: SessionId;
  readonly snippet: string;
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'session/model-unavailable': {
      readonly provider: string;
      readonly model: string;
    };
    'session/conflict': {
      readonly sessionId: SessionId;
      readonly requestedCwd: string;
      readonly existingCwd?: string;
    };
    'session/agent-busy': {
      readonly reason: string;
    };
    'session/invalid-time-zone': {
      readonly value: string;
    };
    'session/workspace-attach-failed': {
      readonly sessionId: SessionId;
      readonly workspaceId: string;
    };
    'agent-preset/conflict': {
      readonly sessionId: SessionId;
      readonly requestedPreset: string;
      readonly existingPreset?: string;
    };
    'session/attachment-invalid': {
      readonly reason: string;
    };
    'session/queue-item-not-found': {
      readonly itemId: MessageId;
    };
    'session/steer-unavailable': {
      readonly itemId: MessageId;
    };
    'session/title-invalid': {
      readonly sessionId: SessionId;
    };
    'session/fork-unavailable': {
      readonly sessionId: SessionId;
    };
    'subagent/not-found': {
      readonly parentSessionId: SessionId;
      readonly childSessionId: SessionId;
    };
    'subagent/catalog-diagnostic': {
      readonly parentSessionId: SessionId;
      readonly childSessionId: SessionId;
      readonly reason: 'corrupt' | 'unsupported' | 'unavailable';
    };
  }
}
/** Session-addressed request for the human-invocable skill catalog. */
interface SkillListRequest {
  readonly sessionId: SessionId;
}
/** One skill available to the Session's human-facing composer. */
interface SkillEntry {
  /** Kebab-case identifier referenced as `/name`. */
  readonly name: string;
  /** Short routing description. */
  readonly description: string;
  /** Optional extra routing guidance. */
  readonly whenToUse?: string;
  /** Whether the same skill is also advertised to the model. */
  readonly modelInvocable: boolean;
}
/** Human-invocable skills visible through one Session's composition. */
interface SkillListValue {
  readonly skills: readonly SkillEntry[];
}
/** Session list request. */
interface SessionListRequest {
  readonly cursor?: string;
}
/** Session list response value. */
interface SessionListValue {
  readonly items: readonly SessionSummary$1[];
}
/** Session search request. */
interface SessionSearchRequest$1 {
  readonly query: string;
}
/** Session search response value. */
interface SessionSearchValue {
  readonly items: readonly SessionSearchItem[];
  readonly hasMore: boolean;
}
/** Session creation or explicit-id adoption request. */
interface SessionCreateRequest {
  readonly workspaceId?: WorkspaceId;
  readonly cwd?: string;
  readonly sessionId?: SessionId;
  readonly agentPreset?: string;
}
/** Session creation response value. */
interface SessionCreateValue {
  readonly sessionId: SessionId;
  readonly agentPreset?: string;
}
/** Session model-selection request. */
interface SessionSelectModelRequest extends ModelSelection {
  readonly sessionId: SessionId;
}
/** Accepted model selection after Host resolution. */
interface SessionSelectModelValue {
  readonly selected: ModelSelection;
}
/** Session rename request. */
interface SessionRenameRequest {
  readonly sessionId: SessionId;
  readonly title: string;
}
/** Normalized title and the durable event position that committed it. */
interface SessionRenameValue {
  readonly title: string;
  readonly seq: number;
}
/** Session fork request. */
interface SessionForkRequest {
  readonly sessionId: SessionId;
  readonly atSeq?: number;
}
/** Identity of a newly forked Session. */
interface SessionForkValue {
  readonly sessionId: SessionId;
}
/** Session prompt request. */
interface SessionPromptRequest {
  /** Client-minted identity persisted on the exact accepted user message. */
  readonly requestId: SessionRequestId;
  readonly sessionId: SessionId;
  readonly mode: 'queue' | 'steer';
  /** At least one non-whitespace text part or attachment. */
  readonly content: readonly PromptContentPart[];
  readonly clientTimeZone?: string;
}
/** Receipt after one prompt enters the target Agent inbox. */
interface SessionPromptValue {
  readonly accepted: true;
}
/** Durable image read request. */
interface SessionAttachmentRequest {
  readonly sessionId: SessionId;
  readonly attachmentId: AttachmentId;
}
/** Durable image read response value. */
interface SessionAttachmentValue {
  readonly attachment: ImageAttachmentRef;
  readonly data: string;
}
/** Pending queue mutation request. */
interface SessionUpdateQueueRequest {
  readonly sessionId: SessionId;
  readonly itemId: MessageId;
  readonly action: QueueAction;
}
/** Receipt after one pending queue mutation commits. */
interface SessionUpdateQueueValue {
  readonly accepted: true;
}
/** Active-turn cancellation request. */
interface SessionCancelRequest {
  readonly sessionId: SessionId;
}
/** Receipt after cancellation is admitted to the live Agent. */
interface SessionCancelValue {
  readonly accepted: true;
}
/** Request to open one path prepared by a Session-aware caller on the Host desktop. */
interface SessionOpenWorkspacePathRequest {
  /** File-manager navigation when requested; omission uses the default application. */
  readonly action?: 'reveal';
  /** Path after best-effort Session workspace resolution, in Host filesystem syntax. */
  readonly path: string;
}
/** Confirmation that the Host handed a workspace path to its native opener. */
interface SessionOpenWorkspacePathValue {
  readonly opened: true;
}
/** Client-minted prompt identity used to reconcile optimistic and durable messages. */
type SessionRequestId = Branded<'session-request-id'>;
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Browser prompt correlation and optional Host-validated time zone. */
    'user-rpc': {
      kind: 'user';
      rpcId: SessionRequestId;
      clientTimeZone?: string;
    };
  }
}
/** Durable identity selecting an ordinary Session or one direct subagent child. */
type SessionAddress = {
  readonly kind: 'session';
  readonly sessionId: SessionId;
} | {
  readonly kind: 'subagent';
  readonly parentSessionId: SessionId;
  readonly childSessionId: SessionId;
  readonly mode: 'one-shot' | 'continuable';
};
/** One raw Session event in the Remote journal. */
interface SessionEventEntry {
  readonly type: 'event';
  readonly event: SessionWireEvent;
}
/** Current logical Session metadata carried on the browser wire. */
interface SessionWireHeader {
  readonly version: number;
  readonly id: SessionId;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: SessionId;
  /** Whether the Session contains a fork-inherited prefix. */
  readonly isSeeded: boolean;
  readonly origin?: 'subagent';
  readonly delegationDepth?: number;
  readonly agentPreset?: string;
}
/** One history-page record with compact Assistant streams embedded inside events. */
type SessionHistoryRecord = SessionEventEntry;
/**
 * Exact Session event envelope accepted by the Client journal adapter.
 * Surface events require surfaceOp; only non-Assistant surface events may cite earlier sources.
 * Durable readers own recognition of merge-extensible event names.
 */
interface SessionWireEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: JsonValue;
  readonly ignorable?: true;
  /** Earlier sources on current surface events; opaque JSON on unknown ignorable events. */
  readonly sourceEventSeqs?: JsonValue;
  /** Canonical placement on current surface events; opaque JSON on unknown ignorable events. */
  readonly surfaceOp?: JsonValue;
}
/** One message-aligned backwards-history request. */
interface SessionPageRequest {
  readonly address: SessionAddress;
  /** Inclusive log cut obtained from the corresponding follow opening frame. */
  readonly throughSeq: number;
  readonly beforeSeq?: number;
  readonly maxMessages?: number;
}
/** One live event request for a durable Session address. */
interface SessionFollowRequest {
  readonly address: SessionAddress;
  readonly maxMessages?: number;
  /** Include process-local assistant presentation frames for the Web client. */
  readonly assistantStream?: true;
}
/** One active assistant attempt in a reconnect opening snapshot. */
interface SessionAssistantStreamAttempt {
  readonly attemptId: LlmAttemptId;
  /** Last durable Session seq observed when this attempt started. */
  readonly startedAfterSeq: SessionSeqCursor;
  readonly turn: number;
  readonly step: number;
  /** Dense position expected for the next live chunk frame. */
  readonly nextIndex: number;
  /** Compact detached stream accumulated at this opening revision. */
  readonly stream: readonly JsonValue[];
}
/** Complete process-local assistant state at one follow opening. */
interface SessionAssistantStreamBaseline {
  readonly revision: number;
  readonly activeAttempt?: SessionAssistantStreamAttempt;
}
/** Browser wire form of one process-local assistant frame. */
type SessionAssistantStreamFrame = {
  readonly type: 'start';
  readonly attemptId: LlmAttemptId;
  readonly revision: number;
  readonly startedAfterSeq: SessionSeqCursor;
  readonly turn: number;
  readonly step: number;
} | {
  readonly type: 'chunk';
  readonly attemptId: LlmAttemptId;
  readonly revision: number;
  readonly index: number;
  readonly time: number;
  readonly chunk: JsonValue;
} | {
  readonly type: 'end';
  readonly attemptId: LlmAttemptId;
  readonly revision: number;
  /** Number of chunk frames represented by this terminal marker. */
  readonly index: number;
  readonly outcome: {
    readonly kind: 'committed';
    readonly eventType: 'assistant/message' | 'assistant/attempt';
    readonly seq: number;
  } | {
    readonly kind: 'abandoned';
  };
};
/** One contiguous backwards page of a Session log. */
interface SessionPage {
  readonly records: readonly SessionHistoryRecord[];
  readonly hasMore: boolean;
}
/** Complete opening window followed by ordered durable events and opted-in assistant frames. */
type SessionFollowFrame = {
  readonly type: 'snapshot';
  readonly header: SessionWireHeader;
  readonly cursor: number;
  readonly records: readonly SessionHistoryRecord[];
  readonly hasMore: boolean;
  readonly projections: SessionProjectionBaseline;
  readonly assistantStream?: SessionAssistantStreamBaseline;
} | SessionEventEntry | {
  readonly type: 'assistant-stream';
  readonly frame: SessionAssistantStreamFrame;
};
/** One pending inbox occurrence in the authoritative queue snapshot. */
interface SessionQueuedItem {
  readonly id: MessageId;
  readonly placement: 'queued' | 'steering' | 'context';
  /** Prompt-RPC identity from the queued message's user source; clients retire the matching local submission echo on it. */
  readonly rpcId?: SessionRequestId;
  /** JSON-safe message fields consumed by pending-queue presentation. */
  readonly message: {
    readonly id: MessageId;
    readonly content: readonly JsonValue[];
  };
}
/** Browser-safe background-job row. */
interface SessionJob {
  readonly id: JobId;
  readonly kind: string;
  readonly label: string;
  readonly status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed';
  readonly detail?: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
}
/** Complete live control baseline emitted once per control stream generation. */
interface SessionControlBaseline {
  readonly queues: Readonly<Record<SessionId, readonly SessionQueuedItem[]>>;
  readonly jobs: Readonly<Record<SessionId, readonly SessionJob[]>>;
  readonly projections: Readonly<Record<SessionId, SessionProjectionBaseline>>;
}
/** One finished projection value and its durable watermark. */
interface SessionProjectionUpdate {
  readonly sessionId: SessionId;
  readonly key: string;
  readonly value: JsonValue;
  readonly seq: number;
}
/** Host-wide live state stream. Each generation starts with exactly one baseline. */
type SessionControlFrame = {
  readonly type: 'baseline';
  readonly value: SessionControlBaseline;
} | {
  readonly type: 'queue';
  readonly sessionId: SessionId;
  readonly items: readonly SessionQueuedItem[];
} | {
  readonly type: 'jobs';
  readonly sessionId: SessionId;
  readonly jobs: readonly SessionJob[];
} | ({
  readonly type: 'projection';
} & SessionProjectionUpdate);
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A Session became visible to Session list consumers.
     * @mode emit
     * @param summary - initial list row for the Session.
     */
    'api-session/added'(summary: SessionSummary$1): void;
    /**
     * A Session left the live Host registry.
     * @mode emit
     * @param sessionId - removed Session identity.
     */
    'api-session/removed'(sessionId: SessionId): void;
    /**
     * One Agent changed running state.
     * @mode emit
     * @param sessionId - Agent and Session identity.
     * @param running - whether the Agent is running.
     */
    'api-session/status'(sessionId: SessionId, running: boolean): void;
    /**
     * One user-authored durable message advanced Session list activity.
     * @mode emit
     * @param sessionId - addressed Session identity.
     * @param updatedAt - durable message time used for list ordering.
     */
    'api-session/activity'(sessionId: SessionId, updatedAt: number): void;
    /**
     * One Agent failed outside a durable turn position.
     * @mode emit
     * @param sessionId - Agent and Session identity.
     * @param message - user-safe failure chain.
     */
    'api-session/error'(sessionId: SessionId, message: string): void;
  }
}
/** JSON-compatible projection value accepted by list consumers. */
type SessionProjectionValue = JsonValue;
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-tools@0.1.5-rc.2_7f9e302786cf21e030eafe960666842c/node_modules/@deepseek-ai/dsh-tools/lib/types/presentation.d.ts
/**
 * Category of a tool call, used by a UI to pick an icon or treatment. The
 * provider-neutral vocabulary lets tools describe themselves without depending
 * on a particular client; `other` is the default.
 */
type ToolCallKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other';
/**
 * A file location a tool reads or modifies, so a capable UI can "follow along" —
 * highlight or jump to the file (and line) as the tool runs. `path` is what the
 * tool operated on (the model-facing path); `line` is an optional 1-based line
 * to focus (e.g. a read's offset).
 */
interface FileLocation {
  path: string;
  line?: number;
}
/**
 * A single-file change a tool is about to make, for a UI that renders inline
 * diffs. `oldText` is `null` for a new-file create (nothing to diff against);
 * an overwrite also uses `null`, because a call-time presenter has no access to
 * the file's prior content.
 */
interface FileDiff$1 {
  path: string;
  /** Prior content, or `null` for a new file / an overwrite (no prior content available at call time). */
  oldText: string | null;
  /** Content after the change. */
  newText: string;
}
/**
 * Provider-neutral pending-call presentation. Tools declare one tagged intent;
 * UI bridges map it without special-casing tool names.
 */
type ToolCallView = GenericCallView | TerminalCallView | DiffCallView;
/**
 * The default card: a titled tool-call row with an optional category icon, a
 * salient raw input, extra content blocks, and follow-along file locations. Any
 * tool whose call is not a terminal or a diff uses this.
 */
interface GenericCallView {
  card: 'generic';
  /**
   * Human-readable, always-visible label describing what THIS call does. Keep it
   * short — a UI shows it as a card header / log line.
   */
  title: string;
  /** Category for icon/treatment; defaults to `other` when omitted. */
  kind?: ToolCallKind;
  /**
   * The salient input to show in a detail/expanded view (e.g. a background
   * job id). Omit to show nothing; a string renders as-is, an object as pretty
   * JSON. NOT the full raw args object unless that is genuinely what a reader wants.
   */
  rawInput?: unknown;
  /**
   * UI-facing content blocks to show on the pending call alongside the title.
   * Omit to show none. A UI maps these to its own content blocks.
   */
  content?: ContentBlock[];
  /** Files this call reads/modifies, for editor follow-along. Omit for a call that touches no file. */
  locations?: FileLocation[];
}
/**
 * A call that IS a shell command running in a working directory: a capable UI
 * renders it as a terminal card (cwd-headed, with the command as the title and
 * live/afterward output from the {@link TerminalResultView}); an incapable UI
 * falls back to a generic card whose body is the fenced command output. Set by a
 * tool whose call is a foreground command (e.g. `bash`).
 */
interface TerminalCallView {
  card: 'terminal';
  /** The command, shown as the terminal card's title / header line. */
  title: string;
  /**
   * A human-readable one-line summary of what the command does, rendered ABOVE
   * the terminal card (the card itself has no description slot). Omit for none.
   */
  description?: string;
  /**
   * Working directory the command runs in, shown as the terminal header. An
   * ABSOLUTE path is used as-is; a RELATIVE path is resolved by the UI bridge
   * against the session workspace (the pure presenter can't see the session cwd).
   * Omit entirely to let the bridge use the session workspace.
   */
  cwd?: string;
}
/**
 * A call that creates or modifies files, rendered as an inline diff card by a
 * capable UI. Set by a tool whose call writes/edits a file (e.g. `write`,
 * `edit`). The diffs are derived from the call ARGUMENTS (a create's `oldText` is
 * `null`); the tool emits a separate {@link DiffResultView} after `execute` — the
 * applied change (an edit/overwrite hunk with context, or a whole-file diff for a
 * create).
 */
interface DiffCallView {
  card: 'diff';
  /** Card header (e.g. `Write foo.txt`). */
  title: string;
  /** One entry per file the call changes. */
  diffs: FileDiff$1[];
  /** Files this call modifies, for editor follow-along (usually the diffs' paths). */
  locations?: FileLocation[];
}
/**
 * One numbered line of a file, the unit a {@link ReadResultView} carries so a
 * capable UI can render a syntax-highlighted, line-numbered code view. `number`
 * is the 1-based line number in the file (a window past `offset` keeps the file's
 * own numbering, not a 1-based re-count); `text` is the line without its trailing
 * newline, already truncated to the read tool's per-line cap.
 */
interface ReadFileLine {
  number: number;
  text: string;
}
/**
 * How a tool wants the COMPLETED call shown — the *result* state, after `execute`
 * returns. A `card`-tagged union mirroring {@link ToolCallView}: a UI switches on
 * `card`. Lets the tool reformat its result for a UI distinctly from the
 * model-facing text it returned from `execute`. Returned by
 * `ToolDefinition.presentResult`; omitting the method keeps the pending
 * title and renders the raw result content.
 */
type ToolResultView = GenericResultView | TerminalResultView | DiffResultView | SearchResultView | ReadResultView | WebResultView;
/**
 * The default completed card: an optional replacement title and reformatted
 * content. Omit a field to keep the pending title / render the raw result content.
 */
interface GenericResultView {
  card: 'generic';
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string;
  /**
   * UI-facing result content (harness {@link ContentBlock}s), reformatted from
   * the model-facing result. Omit to let the UI render the raw result content.
   */
  content?: ContentBlock[];
}
/**
 * The completed state of a {@link TerminalCallView}: the captured output and exit
 * status. A capable UI renders `output` in the terminal card and shows an
 * exit-status pill; an incapable UI gets a fenced ```console fallback the BRIDGE
 * derives from `output` (the tool does not double-encode it).
 */
interface TerminalResultView {
  card: 'terminal';
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string;
  /** Captured command output (stdout+stderr as the tool chooses to combine them). */
  output?: string;
  /**
   * Process exit code, when the run ended by exiting (not a signal). Lets a
   * capable UI show an exit-status pill. Omit when killed by a signal or unknown.
   */
  exitCode?: number;
  /** Signal name that killed the process (e.g. `SIGTERM`). Mutually exclusive with `exitCode`. */
  signal?: string;
}
/**
 * A completed file mutation rendered as an inline diff card, the result-time
 * analogue of {@link DiffCallView}. Because a completed UI update replaces the
 * pending card content, mutation tools return this even when it repeats the
 * call-time diff; otherwise raw result text would replace the diff.
 */
interface DiffResultView {
  card: 'diff';
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string;
  /** The change to show, in file order — applied contextual hunks, or a whole-file diff when there is no before-image. */
  diffs: FileDiff$1[];
}
/** One matched line inside a {@link SearchFileMatches} group: its 1-based line number and text. */
interface SearchLineMatch {
  /** 1-based line number of the match within its file. */
  lineNumber: number;
  /** The matched line text, as the tool surfaced it (the per-line preview budget already applied). */
  line: string;
}
/** One file's grouped content matches for a {@link SearchMatchesResultView}, in first-seen file order. */
interface SearchFileMatches {
  /** The file the matches belong to (the model-facing display path). */
  path: string;
  /** The file's matched lines, in output order. */
  matches: SearchLineMatch[];
}
/**
 * A completed content search (`grep`) rendered as a search card whose matches are
 * grouped by file, so a capable UI can list each file as an expandable group of
 * its matched lines. `shape: 'matches'` discriminates this variant from the path
 * variant ({@link SearchPathsResultView}) within {@link SearchResultView}. The
 * discriminant is `shape`, not `kind`, so it never collides with the
 * {@link ToolCallKind} `kind` an icon-picking bridge reads off a call view.
 */
interface SearchMatchesResultView {
  card: 'search';
  shape: 'matches';
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string;
  /** Matched lines grouped by file, in first-seen file order. */
  files: SearchFileMatches[];
  /**
   * Whether the tool capped the inline result: `files` carries only the retained
   * matches, not every match the search found. A UI shows a capped indicator so it
   * never presents a partial group as complete.
   */
  truncated: boolean;
  /** Total matches the search found before capping (equals the retained count when not `truncated`). */
  total: number;
}
/**
 * A completed path search (`glob`) rendered as a search card whose result is a flat
 * path list. `shape: 'paths'` discriminates this variant from the grouped-matches
 * variant ({@link SearchMatchesResultView}) within {@link SearchResultView}.
 */
interface SearchPathsResultView {
  card: 'search';
  shape: 'paths';
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string;
  /** The discovered paths, in the tool's result order (the retained page when `truncated`). */
  paths: string[];
  /**
   * Whether the tool capped the inline result: `paths` carries only the retained
   * page, not every path the search found. A UI shows a capped indicator so it
   * never presents a partial list as complete.
   */
  truncated: boolean;
  /** Total paths the search found before capping (equals `paths.length` when not `truncated`). */
  total: number;
}
/**
 * A completed search rendered as a search card, the result-time view a discovery
 * tool (`grep`, `glob`) returns from `presentResult`. One `card: 'search'` view
 * with two `shape`-discriminated variants: grouped-by-file content matches
 * ({@link SearchMatchesResultView}) and a flat path list
 * ({@link SearchPathsResultView}). Both carry a `truncated`/`total` signal so a UI
 * never presents a capped result as complete. The view carries no result text: a
 * UI without a search card falls back to the raw `tool/result` content. There is
 * no call-time analogue: a search call stays a {@link GenericCallView}
 * (`kind: 'search'`) because the pending state has no matches or paths to show —
 * the structured shape exists only after `execute`.
 */
type SearchResultView = SearchMatchesResultView | SearchPathsResultView;
/**
 * A completed file read rendered as a line-numbered, optionally syntax-highlighted
 * code view by a capable UI. Set by a tool whose call reads file text (e.g.
 * `read`); the pending state stays a {@link GenericCallView} (`kind: 'read'`)
 * because a call carries no content until `execute` returns. The structured
 * `lines`/`path`/`lang`/`totalLines` fields cannot be reconstructed from the
 * model-facing result text alone, so the read tool projects them through its
 * `output.presentationMeta` (persisted with the session log) and `presentResult`
 * narrows that metadata back into this view on live and replay paths alike. A UI
 * without the read capability falls back to `content` (the model-facing text with
 * its envelope stripped), so this view degrades to the generic text card.
 */
interface ReadResultView {
  card: 'read';
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string;
  /** The read file's path (the model-facing path; the bridge relativizes it). */
  path: string;
  /**
   * The 1-based first line the window requested, preserved even when `lines` is
   * empty (a byte cap below the first selected line yields an empty window) so a
   * UI knows where the window starts and where a continuation resumes.
   */
  offset: number;
  /** The returned window's lines, in file order, each keeping its file line number. */
  lines: ReadFileLine[];
  /** Exact total line count in the file, so a UI can show a "showing N of M" affordance. */
  totalLines: number;
  /**
   * A syntax-highlighting language hint derived from the file extension (e.g.
   * `ts`, `py`), or omitted when the extension maps to no known language so a UI
   * renders the lines as plain text.
   */
  lang?: string;
  /**
   * The model-facing result content with its envelope stripped, for a UI without
   * the read capability. Omit to let such a UI render the raw result content.
   */
  content?: ContentBlock[];
}
/**
 * One citeable source in a completed {@link WebSearchResultView}, the faithful
 * projection of one web-search source. The presentation projection of `dsh-web`'s
 * `WebSearchSource`: that Service Definition type is authoritative (core cannot depend
 * on the web Service Definition, so the two are declared separately and MUST evolve together).
 * A web tool projects this shape through `output.presentationMeta` because the
 * render text cannot losslessly carry it (see the web-result-card Agent Note); its
 * `presentResult` reads it back.
 */
interface WebSource {
  /** The source URL. */
  url: string;
  /** The source title, when the provider returned one. */
  title?: string;
  /** A short excerpt or summary, when the provider returned one. */
  snippet?: string;
  /** Publication/crawl timestamp as a provider-supplied ISO-8601 string, when present. */
  publishedAt?: string;
}
/**
 * A completed web retrieval rendered as a structured card by a capable UI. Set
 * by a web tool whose call retrieves from the web (`web_search`, `web_fetch`).
 * One `kind`-tagged union carries both shapes because both are web retrieval and
 * a UI renders them with one component family; a UI switches on `kind`. An
 * incapable UI falls back to the raw `tool/result` content (this view carries no
 * `content` copy — see the web-result-card Agent Note). This is the result-time
 * analogue of the `web_search`/`web_fetch` calls' generic call views
 * (`kind: 'search'`/`'fetch'`); those tools keep their generic pending card and
 * add only this completed card.
 *
 * The `kind` field here is this union's own discriminant, NOT a
 * {@link ToolCallKind}: the two values deliberately match the tools' pending
 * `ToolCallKind` (`'search'`/`'fetch'`) so a call and its result read as one
 * category, but a new arm is a union edit plus a consumer branch, not any
 * arbitrary `ToolCallKind` value.
 */
type WebResultView = WebSearchResultView | WebFetchResultView;
/**
 * The completed state of a `web_search` call: the structured sources the model
 * cited, an optional provider answer, and whether the source list was cut to the
 * result cap. A capable UI renders the sources as a citation list; a UI without
 * the `web` capability falls back to the raw `tool/result` content.
 */
interface WebSearchResultView {
  card: 'web';
  kind: 'search';
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string;
  /** The faithful, structured sources — the field render text cannot losslessly carry. */
  sources: WebSource[];
  /** The provider-generated answer text, when any. */
  answer?: string;
  /** True when the web service cut the source list to honor the result cap. */
  truncated: boolean;
}
/**
 * The completed state of a `web_fetch` call: the fetched URL, its HTTP status,
 * and whether the content was cut. The body itself is already markdown in the
 * raw `tool/result` content, so this card carries only the retrieval summary and
 * a UI without the `web` capability falls back to that content.
 */
interface WebFetchResultView {
  card: 'web';
  kind: 'fetch';
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string;
  /** The final URL after allowed redirects. */
  url: string;
  /** HTTP status code of the fetched response. */
  statusCode: number;
  /**
   * True when the provider capped the decoded body, or the output cap or a
   * pre-conversion source cut trimmed the rendered text (the effective
   * truncation the model-facing text also reflects).
   */
  truncated: boolean;
}
//#endregion
//#region src/bridge/dsh-types.d.ts
/**
 * The plugin-merged event names the bridge consumes beyond the core
 * `SessionEvent` union. Each is read structurally. `text-chunks` /
 * `reasoning-chunks` / `tool-call-chunks` are no longer host session events in
 * dsh 0.1.5 — the bridge synthesizes them from an embedded
 * `assistant/message.stream` (see `expandRecord`) and keeps the translation
 * cases for that history path.
 */
type PluginSessionEventType = 'agent/inbox/spliced' | 'compaction/start' | 'compaction/summary' | 'compaction/end' | 'tool-call-chunks' | 'text-chunks' | 'reasoning-chunks' | 'todo/write' | 'session/title-llm-request' | 'permission/preset' | 'sandbox/mode' | 'approval/policy' | 'command/run' | 'command/done' | 'approval/asked' | 'approval/decided' | 'agent-preset/selected' | 'subagent/descriptor' | 'model/selection' | 'goal/change';
/** Core union ∪ plugin events, as the bridge's event feed actually delivers. */
type BridgeEvent = SessionEvent | {
  readonly type: PluginSessionEventType;
  readonly seq: number;
  readonly time: number;
  readonly data: unknown;
  readonly ignorable?: true;
  readonly sourceEventSeqs?: readonly number[];
  readonly surfaceOp?: unknown;
};
/** One queued inbox item as surfaced by `session/queue`. */
interface QueuedInboxItem {
  placement: 'queued' | 'steering' | 'context';
  /** 0.1.2 queue snapshots carry the prompt rpcId beside a source-less message. */
  rpcId?: string;
  message: {
    id: string;
    content: readonly unknown[];
    source?: {
      kind: string;
    };
  };
}
/** Host-wide control baseline emitted before queue/job/projection deltas. */
interface BridgeControlBaseline {
  queues?: Record<string, readonly QueuedInboxItem[]>;
  jobs?: Record<string, readonly unknown[]>;
  projections?: Record<string, {
    asOfSeq: number;
    values: Record<string, unknown>;
  }>;
}
/**
 * One frame the bridge event translator consumes. This mirrors the deleted
 * `MuxFrame` wire union but carries a plain `rpcId` field (no RpcRequest
 * envelope): the answerable frames keep it so the HTTP reply routes can
 * correlate, while the pure-push frames leave it optional.
 */
type BridgeFrame = {
  type: 'session/event';
  sessionId: string;
  event: BridgeEvent;
  view?: ToolEventView;
} | {
  /**
   * dsh 0.1.5 live assistant stream: one process-local
   * `agent/assistant-stream` chunk frame. The durable session log no longer
   * carries per-delta events, so this is the streaming feed.
   */
  type: 'session/assistant-stream';
  sessionId: string;
  turn: number;
  step: number;
  time: number;
  /** Attempt identity used to de-duplicate replayed frames. */
  attemptId: string;
  revision: number;
  /** Dense zero-based position within the attempt. */
  index: number;
  chunk: StreamChunk;
} | {
  type: 'control/baseline';
  value: BridgeControlBaseline;
} | {
  type: 'approval/requested';
  rpcId: string;
  sessionId: string;
  approvalId: string;
  toolName: string;
  callId?: string;
  reason?: string;
} | {
  type: 'approval/resolved';
  sessionId: string;
  approvalId: string;
  outcome: 'allowed-once' | 'rejected';
} | {
  type: 'question/requested';
  rpcId: string;
  sessionId: string;
  questions: AskUserQuestionItem[];
} | {
  type: 'question/resolved';
  sessionId: string;
  questionRpcId: string;
  outcome: 'answered' | 'cancelled';
  answers?: Array<Array<string>>;
} | {
  type: 'session/queue';
  sessionId: string;
  items: QueuedInboxItem[];
} | {
  type: 'session/jobs';
  sessionId: string;
  jobs: unknown[];
} | {
  type: 'session/projection';
  sessionId: string;
  key: string;
  value: unknown;
  seq: number;
} | {
  type: 'stream/error';
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};
/** One frame of the host-level lifecycle stream. */
type BridgeHostFrame = {
  type: 'host/agent-error';
  sessionId: string;
  message: string;
} | {
  type: 'host/session-status';
  sessionId: string;
  running: boolean;
  updatedAt?: number;
} | {
  type: 'host/session-activity';
  sessionId: string;
  updatedAt: number;
} | {
  type: 'host/session-added';
  sessionId: string;
  summary?: Partial<SessionSummary>;
} | {
  type: 'host/session-removed';
  sessionId: string;
};
/** Per-session agent preset, learned from the creation value or live events. */
interface SessionSummary extends SessionSummary$1 {
  /** Agent preset this session's agent was composed from (may be absent). */
  agentPreset?: string;
}
/** One cut of provider-validated projection values at a session event cursor. */
interface SessionProjectionsBlock {
  asOfSeq: number;
  values: Partial<Record<string, unknown>>;
}
/**
 * One history record the bridge reads. In 0.1.2 durable history is paginated
 * and chunk-packaged; the bridge expands it back into `{ event, view }` so the
 * rest of the translation layer keeps the pre-0.1.2 shape.
 */
interface HistoryEntry {
  event: BridgeEvent;
  /** Host-computed presenter view for tool call/result events (may be absent). */
  view?: ToolEventView;
}
/** Render intent for a `tool/call` or `tool/result` event. */
type ToolEventView = {
  for: 'call';
  view: ToolCallView;
} | {
  for: 'result';
  view: ToolResultView;
};
//#endregion
//#region node_modules/.pnpm/@opencode-ai+sdk@1.18.18/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts
type FileDiff = {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
};
type UserMessage = {
  id: string;
  sessionID: string;
  role: "user";
  time: {
    created: number;
  };
  summary?: {
    title?: string;
    body?: string;
    diffs: Array<FileDiff>;
  };
  agent: string;
  model: {
    providerID: string;
    modelID: string;
  };
  system?: string;
  tools?: {
    [key: string]: boolean;
  };
};
type ProviderAuthError = {
  name: "ProviderAuthError";
  data: {
    providerID: string;
    message: string;
  };
};
type UnknownError = {
  name: "UnknownError";
  data: {
    message: string;
  };
};
type MessageOutputLengthError = {
  name: "MessageOutputLengthError";
  data: {
    [key: string]: unknown;
  };
};
type MessageAbortedError = {
  name: "MessageAbortedError";
  data: {
    message: string;
  };
};
type ApiError = {
  name: "APIError";
  data: {
    message: string;
    statusCode?: number;
    isRetryable: boolean;
    responseHeaders?: {
      [key: string]: string;
    };
    responseBody?: string;
  };
};
type AssistantMessage = {
  id: string;
  sessionID: string;
  role: "assistant";
  time: {
    created: number;
    completed?: number;
  };
  error?: ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError | ApiError;
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  path: {
    cwd: string;
    root: string;
  };
  summary?: boolean;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
  finish?: string;
};
type Message = UserMessage | AssistantMessage;
type TextPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: {
    start: number;
    end?: number;
  };
  metadata?: {
    [key: string]: unknown;
  };
};
type ReasoningPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "reasoning";
  text: string;
  metadata?: {
    [key: string]: unknown;
  };
  time: {
    start: number;
    end?: number;
  };
};
type FilePartSourceText = {
  value: string;
  start: number;
  end: number;
};
type FileSource = {
  text: FilePartSourceText;
  type: "file";
  path: string;
};
type Range = {
  start: {
    line: number;
    character: number;
  };
  end: {
    line: number;
    character: number;
  };
};
type SymbolSource = {
  text: FilePartSourceText;
  type: "symbol";
  path: string;
  range: Range;
  name: string;
  kind: number;
};
type FilePartSource = FileSource | SymbolSource;
type FilePart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "file";
  mime: string;
  filename?: string;
  url: string;
  source?: FilePartSource;
};
type ToolStatePending = {
  status: "pending";
  input: {
    [key: string]: unknown;
  };
  raw: string;
};
type ToolStateRunning = {
  status: "running";
  input: {
    [key: string]: unknown;
  };
  title?: string;
  metadata?: {
    [key: string]: unknown;
  };
  time: {
    start: number;
  };
};
type ToolStateCompleted = {
  status: "completed";
  input: {
    [key: string]: unknown;
  };
  output: string;
  title: string;
  metadata: {
    [key: string]: unknown;
  };
  time: {
    start: number;
    end: number;
    compacted?: number;
  };
  attachments?: Array<FilePart>;
};
type ToolStateError = {
  status: "error";
  input: {
    [key: string]: unknown;
  };
  error: string;
  metadata?: {
    [key: string]: unknown;
  };
  time: {
    start: number;
    end: number;
  };
};
type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;
type ToolPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "tool";
  callID: string;
  tool: string;
  state: ToolState;
  metadata?: {
    [key: string]: unknown;
  };
};
type StepStartPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "step-start";
  snapshot?: string;
};
type StepFinishPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "step-finish";
  reason: string;
  snapshot?: string;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
};
type SnapshotPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "snapshot";
  snapshot: string;
};
type PatchPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "patch";
  hash: string;
  files: Array<string>;
};
type AgentPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "agent";
  name: string;
  source?: {
    value: string;
    start: number;
    end: number;
  };
};
type RetryPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "retry";
  attempt: number;
  error: ApiError;
  time: {
    created: number;
  };
};
type CompactionPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "compaction";
  auto: boolean;
};
type Part = TextPart | {
  id: string;
  sessionID: string;
  messageID: string;
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
} | ReasoningPart | FilePart | ToolPart | StepStartPart | StepFinishPart | SnapshotPart | PatchPart | AgentPart | RetryPart | CompactionPart;
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2_@deepseek-ai+dsh-scope@0._54d1a918d77e481567353c23a9e2039f/node_modules/@deepseek-ai/dsh-session/lib/types/surface.d.ts
/** Readonly live projection of the message-producing session events. */
interface SessionSurface {
  /** Current surface event sequences in model-visible order. */
  readonly nodes: readonly SessionSeq[];
  /** Monotonic count of committed positional replacements. */
  readonly replaceGeneration: number;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2_@deepseek-ai+dsh-scope@0._54d1a918d77e481567353c23a9e2039f/node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    sessions: SessionStore;
  }
  interface Events {
    /**
     * Creation announcement during session publication. A synchronous throw vetoes and rolls
     * back with a paired disposal; detach requested during dispatch is deferred.
     * A returned-promise rejection is logged but cannot retroactively veto this
     * synchronous boundary.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners
     * receive only sessions entered through that agent's context.
     * @param session - the session just entered and announced.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'session/created'(this: Scoped<Session>, session: Session): void;
    /**
     * Emitted once when an announced session leaves the store, including
     * publication rollback, but never for an entry whose creation announcement
     * did not begin. Listener failures are logged and contained.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`) reuses the owner scope.
     * @param session - the session that is no longer live in the store.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'session/disposed'(this: Scoped<Session>, session: Session): void;
    /**
     * Post-commit, fire-and-forget append feed. The listener snapshot resolves
     * before the log push, but callbacks run after it; observer failures are
     * logged and contained without making the committed append fail.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners
     * receive only events from sessions entered through that agent's context.
     * @param session - the session whose log grew.
     * @param event - the appended event, exactly as recorded.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void;
    /**
     * Awaited parallel durability checkpoint: every listener runs and the
     * caller awaits all of them, with no waterfall veto. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`) reuses the session's owner scope.
     * @param session - the session whose buffered events must reach durable storage.
     * @dshScopeScan unsupported
     * @mode parallel
     */
    'session/flush'(this: Scoped<Session>, session: Session): Promise<void> | void;
  }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    session: TypertLookup<Session, SessionId>;
  }
}
/**
 * An event-sourced session: an append-only log of {@link SessionEvent}s.
 *
 * Plain class (not a Service) — create live instances via
 * `ctx.sessions.create()` and detached instances via {@link create}.
 * Seeding with an existing event log replays/forks a session.
 * @typert object
 */
declare class Session {
  private log;
  /** Single incremental owner of surface acceptance and projection state. */
  private readonly surfaceManager;
  /** The ordered surface over this session's event log. */
  get surface(): SessionSurface;
  /**
   * Detached, deep-frozen creation metadata (format version, cwd, lineage,
   * and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. When a
   * `Session` is created without a store-owned header, a minimal header is
   * synthesized (stamped with the current {@link SESSION_FORMAT_VERSION}) so
   * `session.header` is always present. Kept out of the event log — it is a
   * storage concern, not replayable conversation state.
   */
  readonly header: SessionHeader;
  /** Number of leading events inherited from this Session's fork parent. */
  readonly inheritedEventCount: SessionLogOffset;
  /** The session identity, derived from its durable header's single copy. */
  get id(): SessionId;
  /**
   * The first seq appended IN THIS PROCESS: the length of the constructor
   * seed (0 without one). Events with smaller seq values entered through
   * construction — replay, fork, or resume — and were never published on the
   * `session/event` firehose (constructor seeds do not emit). This offset marks
   * the constructor-input boundary for lifecycle ownership and persistence
   * adoption; consumers that need complete canonical history still start at
   * seq 0. Distinct from {@link inheritedEventCount}, the DURABLE
   * fork-lineage cut: a resumed session's constructor seed is its full stored
   * log, while the inherited count keeps the original fork value — this field is the
   * in-process construction fact.
   *
   * Not persisted itself: a seeded session projects it into the log as the
   * `session/end-seed` event, which is what a consumer reading STORED history
   * reads. Locate the LAST such event, not necessarily one at this seq — a
   * seed already ending in one is not re-marked, so reopening an untouched
   * session leaves that event at a smaller seq than `firstLiveSeq`. Prefer
   * this field in-process: it is exact before the marker reaches storage.
   *
   * When this lifecycle appends the marker, it occupies this seq before the
   * store attaches and therefore does not publish either. Otherwise this seq
   * holds an ordinary published write.
   */
  readonly firstLiveSeq: SessionLogOffset;
  /**
   * Create a detached session by validating and snapshotting borrowed seed
   * events and storage metadata.
   * @param id - session identity.
   * @param seed - optional borrowed replay or fork events.
   * @param header - optional borrowed storage metadata.
   * @param inheritedEventCount - exact fork-inherited prefix length for a seeded header.
   * @returns a detached session.
   */
  static create(id: SessionId, seed?: readonly SessionEvent[], header?: SessionHeader, inheritedEventCount?: SessionLogOffset): Session;
  /**
   * Restore a detached session by adopting an independently owned or deeply frozen seed.
   * Runtime-required event fields, event envelopes, sequence continuity, surface
   * transitions, and header fields are validated without copying or freezing events.
   * Embedded Assistant streams remain opaque until a stream consumer or storage
   * verifier reads them.
   * @param id - restored session identity.
   * @param seed - independently owned or deeply frozen events.
   * @param header - independently owned storage metadata.
   * @param inheritedEventCount - exact fork-inherited prefix length decoded from storage.
   * @param eventState - aliasing state carried from the operation that produced the seed.
   * @returns a restored detached session.
   */
  static fromRestore(id: SessionId, seed: readonly SessionEvent[], header: SessionHeader, inheritedEventCount: SessionLogOffset, eventState: SessionSeedEventState): Session;
  private constructor();
  /** Cached immutable full snapshot of the private append-only log. */
  private eventsSnapshot;
  /**
   * Return the immutable event stored at one exact sequence number.
   * @param seq - event sequence number.
   * @returns the accepted event, or undefined when the log does not contain it.
   */
  eventAt(seq: SessionSeq): SessionEvent | undefined;
  /**
   * Materialize an immutable snapshot of a half-open event sequence range.
   * A full current snapshot is reused until the next append; every previously
   * returned snapshot remains stable after later appends.
   * @param fromSeq - non-negative inclusive sequence number; defaults to the log start.
   * @param toSeqExclusive - non-negative exclusive sequence number; defaults to the current end.
   * @returns a frozen array of the selected deeply frozen events.
   */
  snapshotEvents(fromSeq?: SessionLogOffset, toSeqExclusive?: SessionLogOffset): readonly SessionEvent[];
  /**
   * Return this Session's events after its fork-inherited prefix.
   * @returns a fresh array containing child-owned events in log order.
   */
  ownEvents(): readonly SessionEvent[];
  /**
   * Whether one existing event position is outside the fork-inherited prefix.
   * @param seq - event position in this Session.
   * @returns true when the event belongs to this Session rather than its parent.
   */
  isOwnSeq(seq: SessionSeq): boolean;
  /** The next event's sequence number — always the log length (the `seq = log.length` contiguity contract). */
  get seq(): SessionLogOffset;
  /**
   * Append one typed event to the log and synchronously notify observers via
   * the store-owned, module-private publication hooks. The hot path never blocks
   * on I/O — persistence plugins buffer asynchronously. Once the event enters
   * the log, the append is committed: observer failures are logged and
   * contained per listener, so they do not change the return value or prevent
   * later listeners from observing the same accepted event.
   *
   * @param type - The event type (key of {@link SessionEventMap}).
   * @param data - The event payload; must be JSON-serializable.
   * @param opts - Surface metadata: `surfaceOp` controls how the event enters
   *   the ordered surface; `sourceEventSeqs` lists the seq numbers of earlier
   *   events this one derives from. REQUIRED for
   *   {@link SurfaceEventType} events (every message-producing event must
   *   declare how it joins the surface, the sole source of derived model
   *   history) and
   *   rejected by the compiler for non-surface types like `turn/start` or
   *   `assistant/attempt`. Assistant messages embed their exact provider
   *   stream and cannot cite top-level source events.
   * @returns the logged event — its assigned `seq`/`time` plus the SNAPSHOT of
   *   `data` that entered the log, so reading `event.data` back sees the logged
   *   value, never the caller's still-mutable input.
   * @throws if `data` or surface metadata is not losslessly JSON-serializable
   *   (BigInt, function, symbol, undefined, negative zero, non-finite number,
   *   circular reference, sparse array, or an exotic object such as
   *   Map/Set/Date/class instance), or when the candidate violates the
   *   request-header empty-field or tool-error consistency rules, or the
   *   canonical surface contract (marker shape and eligibility, unique
   *   earlier source-event references, positional replacement validity, and complete
   *   shadowed-node coverage). One iterative pass reads, validates, and
   *   copies each nested value once, so a stateful getter cannot supply one value
   *   to validation and another to storage. The event log is the durable source
   *   of truth, so a bad event fails at the append site rather than later during
   *   a backend flush. A synchronous internal dispatch validation failure or an
   *   append reentered while this acceptance/publication boundary is open also
   *   rejects before the log changes.
   */
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []): SessionEvent<T>;
  /** Cached fold of the request-header events — see {@link requestHeader}. */
  private headerFold;
  /** Log position (events consumed) the header fold has reached. */
  private headerFoldSeq;
  /**
   * The {@link EpochHeader} in force after the log's last header event — the
   * header the NEXT request will be compared against — or undefined before
   * the first `request/header` snapshot. The live, incrementally-maintained
   * form of `foldRequestHeader(session.snapshotEvents())`: each header event is folded
   * once, when first seen, so a per-step read costs O(new events).
   * @returns the folded header, or undefined when no header event exists yet.
   */
  requestHeader(): EpochHeader | undefined;
  /** Cached fold of `request/context` events. */
  private contextFold;
  private contextFoldSeq;
  /**
   * Return the latest resolved route metadata, or `undefined` before the first
   * `request/context` event. Each event is folded once.
   * @returns the latest immutable route metadata.
   */
  requestContext(): RequestContext | undefined;
  /** The derived-message cache: frozen projections, extended per unseen node. */
  private derived;
  /** Surface position (nodes projected) the cache has reached. */
  private derivedNodes;
  /** {@link SurfaceManager.replaceGeneration} the cache was built under. */
  private derivedGeneration;
  /**
   * Derive the LLM message history by walking the ordered sequences of
   * message-producing events maintained by `surfaceOp` markers. The
   * surface is the single source of derived history: every message-producing
   * append records its `surfaceOp`, so a raw event with no marker (a chunk, a
   * turn boundary) is correctly absent, and a compaction `replace` deletes the
   * shadowed nodes from the derivation. The projection rules are
   * {@link deriveEventMessage}, folded per node.
   *
   * CACHED: each surface node is projected exactly once, when first seen — a
   * call costs O(new nodes), and a surface rewrite (a `replace`;
   * {@link SessionSurface.replaceGeneration}) rebuilds. The returned array is
   * a fresh snapshot per call (later appends never grow an array a caller
   * already holds); the `Message` objects in it are SHARED and **deep-frozen**.
   * Their content reuses the already frozen durable event data, so the cache
   * needs no second deep clone and consumers still cannot mutate the log.
   * @returns a fresh array of the shared, frozen derived history.
   */
  deriveMessages(): Message$1[];
  /**
   * Instance face of the pure per-node `deriveEventMessage` export from
   * `surface.ts`.
   * @param event - the event to project.
   * @returns the derived message, or null when the event produces none.
   */
  deriveEventMessage(event: SessionEvent): Message$1 | null;
}
/** A fork source: either the live session object or its live store id. */
type SessionForkSource = Session | SessionId;
/**
 * In-memory session store (`ctx.sessions`).
 *
 * Persistence is intentionally not implemented here — the agent lifecycle
 * attaches a session-log writer to each published session's write handle;
 * a session published outside that lifecycle persists nothing.
 */
declare class SessionStore extends Service {
  private store;
  private counter;
  constructor(ctx: Context);
  /**
   * Create a session owned by the calling fiber: disposing that fiber stops
   * event notification and removes the session from the store. `options.seed`
   * populates the session with a copy of those events (replay/fork);
   * `options.meta` attaches creation metadata (validated absolute `cwd`, seed
   * and parent lineage, and delegation depth) as the immutable
   * {@link SessionHeader} (the store fills `version`/`id`/`createdAt`).
   *
   * For an agent whose session must be torn down IN ORDER with its loop (so the
   * loop's final events are published before the store attachment ends), do NOT use this
   * — fold the session lifecycle into the agent's own effect via
   * {@link prepare} + {@link enter} + {@link announce} (see
   * `dsh-agent-loop`'s creation transaction).
   *
   * @param id - the session id; omitted, the store mints `session-<n>`.
   * @param options - seed events and/or creation metadata for the header.
   * @returns the live session, already entered and announced.
   * @throws if a session with `id` already exists, metadata is not a plain
   *   lossless-JSON record with valid scalar fields, or `meta.cwd` is a
   *   non-absolute path (storage backends key directories off it).
   */
  create(id?: SessionId, options?: CreateSessionOptions): Session;
  /**
   * Build a session WITHOUT entering it into the store — validate the id/cwd and
   * construct the {@link Session} (with its immutable {@link SessionHeader}).
   * Pairs with {@link enter} + {@link announce}: a caller that owns a composite
   * `ctx.effect` (the agent factory) folds the session lifecycle into that ONE
   * effect so a fiber unload tears the session + agent down as a single ORDERED
   * chain rather than as racing sibling effects — which would remove the publication hooks
   * before the driver's closing events commit, dropping them.
   *
   * @param id - the session id; omitted, the store mints `session-<n>`.
   * @param options - seed events and/or creation metadata for the header. With
   *   `eventState`, every seed event is either independently owned or any
   *   shared value is deeply frozen; {@link Session.fromRestore} validates and
   *   adopts those values without copying or freezing them.
   * @returns the constructed session, NOT yet in the store.
   * @throws if a session with `id` already exists, metadata is not a plain
   *   lossless-JSON record with valid scalar fields, or `meta.cwd` is a
   *   non-absolute path.
   */
  prepare(id?: SessionId, options?: PrepareSessionOptions): Session;
  /**
   * Enter a {@link prepare}d session into the store: install the module-private
   * append publication hooks and add it to the store. Returns the DETACH
   * disposer (hooks + store removal). Does NOT emit `session/created` —
   * the caller yields this disposer inside its effect and THEN calls
   * {@link announce}, so a throwing `session/created` listener rolls the attach
   * back instead of leaking it.
   *
   * Re-checks the id for a duplicate: `prepare` and `enter` are public
   * cross-package primitives and a caller may interleave arbitrary work (or
   * another create) between them, so a stale prepared session must NOT overwrite
   * a live store entry of the same id — its detach disposer would later delete
   * the REAL session. The {@link create} convenience and the agent factory call
   * the two back-to-back so they never trip this, but the public API cannot
   * assume that.
   *
   * @param session - a {@link prepare}d session not yet in the store.
   * @returns the detach disposer (publication hooks + store removal). When called from
   *   a synchronous `session/created` listener, removal and disposal wait until
   *   that creation dispatch unwinds.
   * @throws if a session with this id is already in the store.
   */
  enter(session: Session): () => void;
  /** Remove one exact entered session and emit its paired disposal when announced. */
  private detachEntered;
  /** Emit `session/created` exactly once for an {@link enter}ed session (with
   * the carrier {@link enter} captured). Separate from {@link enter} so the
   * caller can yield the detach disposer first (rollback safety — see
   * {@link enter}).
   * @param session - the entered session to announce to listeners.
   * @throws if the session is not live or its announcement already began,
   *   including a reentrant call from a creation listener. */
  announce(session: Session): void;
  /** Emit the paired teardown notification with per-listener containment. */
  private emitDisposed;
  /**
   * Dispatch the awaited `session/flush` durability checkpoint for `session`,
   * with the carrier captured at {@link enter}. THE flush entry point: the
   * store owns the carrier, so callers (the checkpoint policy's per-request
   * barrier, goal-round-driver's idle checkpoint, teardown drains, and consumers
   * that flush themselves before reading storage) must come through here
   * rather than dispatch a raw `ctx.parallel('session/flush', …)` — one owner,
   * one spelling, and the scoped-dispatch invariant can pin it.
   * @param session - the session whose buffered events must reach durable storage.
   * @returns whether at least one durability listener participated, after every
   *   listener has settled successfully.
   * @throws the first registered listener failure after every listener settles.
   */
  flush(session: Session): Promise<boolean>;
  /** Return the exact live entry; detached/prepared objects reject. */
  private liveEntryFor;
  /**
   * Look up a live session.
   * @param id - the session id to look up.
   * @returns the session, or undefined when no live session has that id.
   */
  get(id: SessionId): Session | undefined;
  /**
   * All live sessions, in creation order.
   * @returns a fresh array; mutating it does not affect the store.
   */
  list(): Session[];
  /**
   * Create a live child session from a stable prefix of a live source.
   * `boundary` is an inclusive source event seq; omitted means the source's
   * current last event. The selected slice may end with a between-turn event
   * but must not end inside an open turn.
   *
   * @param source - Live source session object or id.
   * @param boundary - Inclusive source event seq to fork through; omitted means
   *   the source's current last event, and omitted on an empty source forks an
   *   empty child.
   * @param childSessionId - Optional child session id; omitted delegates to
   *   `SessionStore`'s id policy.
   * @returns The created live child session.
   */
  fork(source: SessionForkSource, boundary?: SessionSeq, childSessionId?: SessionId): Session;
  private _forkSeed;
  private _resolveForkSource;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-agent@0.1.5-rc.2_6df6622855b87cb7fde1fe609a6d039a/node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts
declare module '@deepseek-ai/dsh-system-prompt' {
  interface AssembleContext {
    /** Agent for this assembly; absent on diagnostics. When present, `scope` must identify the same agent. */
    agent?: Agent;
  }
}
/** Merge-extensible agent creation options. Persona belongs to system-prompt sections. */
interface AgentOptions {
  /** Provider route (must have a registered adapter at call time). */
  provider?: string;
  /** Model id interpreted by the selected provider adapter. */
  model?: string;
  /** Adapter-owned reasoning effort for the selected provider/model route. */
  reasoningEffort?: ReasoningEffortId;
  /** Maximum output tokens for each conversation-model request. */
  maxTokens?: number;
}
/** Options for {@link Agent.cancel}. */
interface CancelOptions {
  /**
   * Preserve queued and steering inbox items instead of discarding them. The
   * active turn is still aborted, but un-started and pending work survives for a
   * later turn and no canceled inbox splice is logged.
   */
  keepInbox?: boolean | undefined;
}
/** Agent-owned access to pending work; concrete storage belongs to the driver. */
interface Inbox {
  /** Prompts awaiting individual turns. */
  readonly nextTurn: readonly UserMessage$1[];
  /** Input awaiting the next step boundary. */
  readonly nextStep: readonly UserMessage$1[];
  /** Durably cancel all pending input, clearing next-step before next-turn. */
  clear(): void;
  /**
   * Append one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to append.
   */
  append(target: InboxTarget, message: UserMessage$1): void;
  /**
   * Prepend one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to prepend.
   */
  prepend(target: InboxTarget, message: UserMessage$1): void;
  /**
   * Replace one pending message in place.
   * @param messageId - identity of the pending message to replace.
   * @param newMessage - replacement message.
   * @returns whether the message was still pending.
   */
  replace(messageId: MessageId, newMessage: UserMessage$1): boolean;
  /**
   * Remove one pending message.
   * @param messageId - identity of the pending message to remove.
   * @returns whether the message was still pending.
   */
  remove(messageId: MessageId): boolean;
  /**
   * Apply standard splice semantics and durably record the normalized result.
   * @param target - pending list to mutate.
   * @param start - splice position.
   * @param deleteCount - maximum number of messages to remove.
   * @param inserted - messages to insert at the resolved position.
   * @returns messages removed by the splice.
   */
  splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage$1[]): UserMessage$1[];
}
/**
 * An agent's lifecycle state, emitted on every transition as `agent/status`:
 * `idle` means no driver is active; `running` begins when waking input starts
 * cancellable pre-step processing and lasts while the driver drains,
 * closes, or checkpoints turns. Disposal removes the agent from its registry;
 * it is not a third observable status.
 */
type AgentStatus = 'idle' | 'running';
/** Whether and with which messages the loop enters a proposed step. */
type PreStepDecision = {
  kind: 'reject';
} | {
  kind: 'enter';
  messages: UserMessage$1[];
  /** Start a distinct model-message series before this step's admitted messages. */
  startsRequestSeries?: true;
};
/** Action returned by a listener that owns model-request recovery. */
type RequestErrorAction = {
  kind: 'retry';
} | undefined;
/** Why a session lifecycle began; seeded creates are `startup`, while persisted loads are `resume`. */
type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact';
/** One process-local live assistant streaming publication. */
type AssistantStreamFrame = {
  readonly type: 'start';
  readonly attemptId: LlmAttemptId;
  /** Monotone within one attached Agent lifecycle; replacement restarts at 1. */
  readonly revision: number;
  readonly turn: number;
  readonly step: number;
} | {
  readonly type: 'chunk';
  readonly attemptId: LlmAttemptId;
  readonly revision: number;
  /** Dense zero-based position within the attempt. */
  readonly index: number;
  /** Safe-integer timestamp reused by the durable embedded stream. */
  readonly time: number;
  readonly chunk: StreamChunk;
} | {
  readonly type: 'end';
  readonly attemptId: LlmAttemptId;
  readonly revision: number;
  /** Number of chunk frames emitted by this attempt. */
  readonly index: number;
  /** Durable settlement committed before this notification, or live abandonment without one. */
  readonly outcome: {
    readonly kind: 'committed';
    readonly eventType: 'assistant/message' | 'assistant/attempt';
    readonly seq: SessionSeq;
  } | {
    readonly kind: 'abandoned';
  };
};
declare module './types.ts' {
  interface Agent {
    /** The provider route and model this agent's requests use. */
    readonly options: AgentOptions;
    /** The live session this agent drives; its log is the durable source of truth. */
    readonly session: Session;
    /** Agent-owned access to durable pending work. */
    readonly inbox: Inbox;
    /** The current lifecycle state, mirrored on every `agent/status` transition. */
    readonly status: AgentStatus;
    /** Agent-scoped context; its contributions are agent-local, unwind on disposal, and reject registration afterward. */
    readonly ctx: Context;
    /**
     * Clear queued and steering work — unless `keepInbox` — and abort the active
     * turn or between-turn task. The first cause wins for that activity. With no
     * active activity, cancellation is a no-op and does not arm later work.
     * @param cause - the stable caller intent carried by the active operation signal.
     * @param options - cancellation options; `keepInbox` preserves pending work.
     */
    cancel(cause: AgentCancelCause, options?: CancelOptions): void;
    /**
     * Resolve after the current whole-agent activity reaches quiescence. This
     * follows replacement work started before the observed driver retires,
     * but does not identify the settlement of any particular message.
     * @returns fulfillment after no active driver or maintenance task remains.
     */
    whenIdle(): Promise<void>;
    /**
     * Run one non-turn maintenance task from the true idle phase. The task starts
     * synchronously after claiming that phase; later waking input remains in the
     * inbox until the task settles, while public status stays `idle`.
     * `whenIdle()` follows both the task and any waking work released behind it.
     * @param task - operation whose fulfillment or rejection is preserved, with a signal aborted by {@link cancel}.
     * @throws synchronously when turn-driving or another maintenance task already owns the agent.
     * @returns the task promise.
     */
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
    /**
     * Route identified input to an inbox boundary and optionally wake the driver.
     * Waking input submitted after active cancellation is queued for the next
     * turn and runs when the aborted activity converges to idle; a `disposed`
     * cancel leaves it parked. A wake submitted while already idle always opens
     * its turn boundary, even when its message is cleared before the driver
     * claims ([cancel-convergence wake latch](../../../../.agents/notes/implemented/bug-fix/2026-08-07-cancel-convergence-wake-latch.md)).
     * @param message - identified content and the source that supplied it.
     * @param target - the preferred next-turn or next-step inbox boundary.
     * @param wakeup - whether delivery may wake the driver.
     */
    send(message: UserMessage$1, target: InboxTarget, wakeup: boolean): void;
    /**
     * Queue an ordinary follow-up turn and wake the driver. The item becomes the
     * sole ordinary message of its own turn.
     * @param message - identified prompt content and the source that supplied it.
     */
    followup(message: UserMessage$1): void;
    /**
     * Submit steering for the nearest step. An idle driver starts a turn;
     * a running driver consumes it at its next step boundary.
     * A rejected step leaves steering parked in the inbox until the next
     * wake; cancellation or disposal may discard pending steering.
     * @param message - identified steering content and the source that supplied it.
     */
    steer(message: UserMessage$1): void;
    /**
     * Queue model-facing context for the next pre-step without waking the
     * driver. A running driver claims it at the nearest later step boundary;
     * idle drivers leave it pending until follow-up or steering
     * wakes them. It may miss a request whose pre-step already claimed its
     * batch. Cancellation or disposal may discard pending context.
     * @param message - identified injected context and the source that supplied it.
     */
    inject(message: UserMessage$1): void;
  }
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A fully configured agent and live session were published. Setup is
     * composition-only; `agent/session-start` is the first startup-driving extension point.
     * Synchronous listener failure vetoes publication, while returned-promise
     * rejection is reported. Detach requested during dispatch waits until every
     * creation listener has observed the stable entry.
     * @param payload.agent - the newly registered agent with its live session and completed setup.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/created'(this: Scoped<Agent>, payload: {
      agent: Agent;
    }): void;
    /**
     * An agent left the registry; AgentLoop emits this after driver quiescence
     * and scoped-registration unwind, but before session detachment. Custom
     * registry users own their driver-ordering contract.
     * @param payload.agent - the exact agent removed from the registry.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/disposed'(this: Scoped<Agent>, payload: {
      agent: Agent;
    }): void;
    /**
     * Agent status changed (`idle` ⇄ `running`). A waking delivery enters
     * `running` synchronously after reserving cancellation; `idle` means no
     * driver remains scheduled or active.
     * @param payload.agent - the agent whose status flipped.
     * @param payload.status - the status just entered (the transition's destination).
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/status'(this: Scoped<Agent>, payload: {
      agent: Agent;
      status: AgentStatus;
    }): void;
    /**
     * One message entered the live inbox.
     * @param payload.agent - the agent whose inbox changed.
     * @param payload.message - the inserted message.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/inbox/inserted'(this: Scoped<Agent>, payload: {
      agent: Agent;
      message: UserMessage$1;
    }): void;
    /**
     * One message left the inbox inside its open turn. If the proposed step
     * is rejected, the claimed message ends here: it is neither discarded nor
     * re-emitted as a user/message, and the turn closes without a step.
     * @param payload.agent - the agent whose inbox changed.
     * @param payload.message - the claimed message.
     * @param payload.turn - the owning turn.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/inbox/claimed'(this: Scoped<Agent>, payload: {
      agent: Agent;
      message: UserMessage$1;
      turn: number;
    }): void;
    /**
     * One message was discarded from the live inbox.
     * @param payload.agent - the agent whose inbox changed.
     * @param payload.message - the discarded message.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/inbox/discarded'(this: Scoped<Agent>, payload: {
      agent: Agent;
      message: UserMessage$1;
    }): void;
    /**
     * The session lifecycle began, once before the first turn. Use
     * `agent.inject()` to seed model-facing context. This is a notification, not
     * a veto; disposal requested by a lifecycle owner is rechecked before the
     * driver starts.
     * @param payload.agent - the agent whose session lifecycle began.
     * @param payload.source - why the session started (fresh startup, resume, …).
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/session-start'(this: Scoped<Agent>, payload: {
      agent: Agent;
      source: SessionStartSource;
    }): void;
    /**
     * Reject a proposed step or replace the messages that enter it. Calling
     * `next()` preserves the current messages.
     * @param payload.agent - the agent proposing the step.
     * @param payload.messages - messages removed from the inbox for this step.
     * @param payload.turn - the turn that will own the step.
     * @param payload.step - the step proposed by the loop.
     * @param payload.signal - the current turn's cancellation signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/pre-step'(this: Scoped<Agent>, payload: {
      agent: Agent;
      messages: UserMessage$1[];
      turn: number;
      step: number;
      signal: AbortSignal;
    }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>;
    /**
     * Replace the frozen call configuration. `await next()` yields the config
     * the machine would use (agent options on the first request, the logged
     * header afterwards); return a replacement to switch. On step admission,
     * this runs after assembly and `step/start`, before the system prompt and
     * accepted user batch are committed. Cancellation here or during subsequent
     * `prepareCall()` resolution commits neither. The prepared call capability
     * governs prompt admission. Model-visible content must use logged channels;
     * this waterfall cannot mutate messages.
     * @param payload.agent - the agent making the model call.
     * @param payload.turn - the open turn number.
     * @param payload.step - the step whose request this is.
     * @param payload.signal - the current turn's explicit abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/request'(this: Scoped<Agent>, payload: {
      agent: Agent;
      turn: number;
      step: number;
      signal: AbortSignal;
    }, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>;
    /**
     * Handle one failed model-request attempt before the loop retries or closes
     * its step. A listener returns `{ kind: 'retry' }` without calling `next()`
     * when it owns recovery, or calls `next()` to delegate. The default
     * `undefined` leaves the failure terminal.
     * @param payload.agent - the agent whose request failed.
     * @param payload.turn - the turn containing the failed request.
     * @param payload.step - the step containing the failed request attempt.
     * @param payload.provider - the provider selected for the failed request.
     * @param payload.failure - serializable facts normalized at the final adapter boundary.
     * @param payload.retryPolicy - the policy of the adapter registration that served the failed request.
     * @param payload.signal - the turn abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/request-error'(this: Scoped<Agent>, payload: {
      agent: Agent;
      turn: number;
      step: number;
      provider: string;
      failure: LlmFailure;
      retryPolicy: ResolvedRetryPolicy | undefined;
      signal: AbortSignal;
    }, next: () => Promise<RequestErrorAction>): Promise<RequestErrorAction>;
    /**
     * Process-local assistant-stream publication. Chunk frames are transient;
     * the loop appends one final v2 `assistant/message` or `assistant/attempt`
     * with the same stream before a committed end frame.
     * @param payload.agent - the agent whose attempt produced the frame.
     * @param payload.frame - one ordered start, chunk, or end publication.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/assistant-stream'(this: Scoped<Agent>, payload: {
      agent: Agent;
      frame: AssistantStreamFrame;
    }): void;
    /**
     * The turn is about to close: the model owes no response (no live tool
     * calls, no fresh steering). Awaited before the boundary commits — a
     * listener that objects steers (`agent.steer(...)`) and the machine
     * re-reads its inbox: fresh steering runs another step, none closes the
     * turn. Data decides, so listener order cannot change the outcome. The
     * inverse control (stop a tool loop early) is data too: a tool result
     * carrying `concludesTurn` ends the turn at its step. The conclusion
     * never short-circuits already-submitted next-step work: same-step
     * `additionalContexts` or racing steering still runs, and the turn
     * closes only when that inbox drains.
     * @param payload.agent - the agent whose turn is at its stop boundary.
     * @param payload.turn - the turn about to close.
     * @param payload.signal - the current turn's explicit abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode serial
     */
    'agent/turn-stopping'(this: Scoped<Agent>, payload: {
      agent: Agent;
      turn: number;
      signal: AbortSignal;
    }): Promise<void> | void;
    /**
     * A step or turn errored. The machine reports a failure here even when
     * the error has no in-turn position for a durable record.
     * @param payload.agent - the agent whose turn errored.
     * @param payload.turn - the turn in which the failure surfaced.
     * @param payload.step - the step at which the failure surfaced.
     * @param payload.error - the failure, verbatim.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode emit
     */
    'agent/error'(this: Scoped<Agent>, payload: {
      agent: Agent;
      turn: number;
      step: number;
      error: unknown;
    }): void;
  }
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-agent@0.1.5-rc.2_6df6622855b87cb7fde1fe609a6d039a/node_modules/@deepseek-ai/dsh-agent/lib/types/projection.d.ts
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** The agent session's open/last turn and step boundary facts (whole value). */
    turnBoundary: TurnBoundaryProjection;
  }
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-system-prompt@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2_@deepseek-ai+dsh-in_b3e6c82e88b9ea30d08be2f4a4f4bc82/node_modules/@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    systemPrompt: SystemPrompt;
  }
  interface Events {
    /**
     * Expert waterfall over the assembled sections, contexts, tools, and variables.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): scoped listeners
     * receive only that scope's assemblies. The returned value is authoritative.
     * A supplied signal controls only this explicit assembly request and must not
     * be retained to control later turns. A registered complete section is
     * restored after this waterfall, so listeners cannot add to or replace
     * that scope's system prompt.
     * @param assembly - the mutable assembly built from registered providers.
     * @param context - the caller's per-assembly context.
     * @mode waterfall
     */
    'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly>;
    /**
     * Emitted when any prompt provider changes. This registry notification is
     * unfiltered because a global change affects every scope.
     * @mode emit
     */
    'system-prompt/change'(): void;
  }
}
/** Merge-extensible context for one prompt assembly. */
interface AssembleContext {
  /**
   * Scope whose providers and waterfall listeners participate. When absent,
   * only global providers and subject-less listeners participate.
   */
  scope?: ScopeKey;
  /** Explicit control signal for the turn that requested this assembly, when any. */
  signal?: AbortSignal;
}
/** One contributed section of the system prompt (registry input). */
interface PromptSection {
  /** Unique name — a duplicate registration throws (see {@link SystemPrompt.section}). */
  readonly name: string;
  /**
   * Sections are concatenated in ascending order. Equal orders use code-unit
   * name order.
   */
  readonly order: number;
  /**
   * Static text or a provider evaluated at each assembly with that assembly's
   * {@link AssembleContext}. The text may reference `{{variable}}`s — they are
   * interpolated later, by {@link renderPrompt}.
   */
  readonly text: string | ((context: AssembleContext) => string);
  /**
   * Treat this contribution as the complete system prompt. Assembly still
   * runs the cooperative waterfall so tools, contexts, and variables can be
   * resolved, then restores this exact section as the sole prompt section.
   * More than one effective complete section makes assembly fail.
   */
  readonly complete?: boolean;
}
/** Dynamic model context materialized as a durable user-role snapshot. */
interface PromptContext {
  /** Unique name — a duplicate registration throws (see {@link SystemPrompt.context}). */
  readonly name: string;
  /** Contexts are joined in ascending order. */
  readonly order: number;
  /** Static text or a provider evaluated for each assembly. Empty text contributes nothing. */
  readonly text: string | ((context: AssembleContext) => string);
}
/** One section of an assembly: {@link PromptSection} with its text resolved. */
interface AssembledSection {
  /** The contributing section's unique name. */
  name: string;
  /** The resolved (but not yet interpolated) section text. */
  text: string;
}
/** One resolved dynamic context contribution. */
interface AssembledContext {
  /** The contributing context's unique name. */
  name: string;
  /** The resolved text before variable interpolation. */
  text: string;
}
/** Tool schemas visible in one assembly and their pre-restriction name set. */
interface ToolProviderResult {
  /** The schemas this provider contributes to THIS assembly. */
  readonly schemas: readonly ToolSchema[];
  /** The pre-restriction name universe for config validation (defaults to `schemas`' names). */
  readonly knownNames?: readonly string[];
}
/**
 * Merge-extensible assembled model input. Sections and contexts remain
 * uninterpolated until rendered; tools are already in canonical order.
 */
interface PromptAssembly {
  sections: AssembledSection[];
  contexts: AssembledContext[];
  tools: ToolSchema[];
  variables: Record<string, string | undefined>;
}
declare const SECTION_ORDERS: {
  readonly HARNESS_IDENTITY: -1000;
  readonly DEPLOYMENT_PERSONA_PREFIX: 0;
  readonly PLAN_POLICY: 500;
  readonly TEAM_POLICY: 600;
  readonly PTC_ONLY: 800;
  readonly FILE_REFERENCE: 900;
  readonly TOOL_BASH: 1000;
  readonly TOOL_PWSH: 1010;
  readonly TOOL_READ: 1100;
  readonly TOOL_WRITE: 1200;
  readonly TOOL_EDIT: 1300;
  readonly TOOL_GLOB: 1400;
  readonly TOOL_GREP: 1500;
  readonly TOOL_JOBS: 1600;
  readonly TOOL_PTY: 1700;
  readonly TOOL_WEB_SEARCH: 2000;
  readonly TOOL_WEB_FETCH: 2100;
  readonly TOOL_LSP: 2200;
  readonly TOOL_SESSION_QUERY: 2300;
  readonly TOOL_GOAL: 2400;
  readonly TOOL_CORDIS: 2500;
  readonly TOOL_WORKFLOW: 2600;
  readonly TOOL_RALPH: 2700;
  readonly TOOL_SUBAGENT: 2800;
  readonly TOOL_REPORT: 2900;
  readonly TOOLS_SDK: 5000;
  readonly DELIVERABLE_FILE_REFERENCES: 9000;
  readonly STRUCTURED_OUTPUT: 9900;
  readonly HARNESS_SOURCE: 10000;
  readonly WEB_SURFACE: 10100;
  readonly DEPLOYMENT_PERSONA_SUFFIX: 10200;
};
/** Name of a centrally allocated prompt-section position. */
type PromptSectionOrderName = keyof typeof SECTION_ORDERS;
declare const CONTEXT_ORDERS: {
  readonly SANDBOX_POLICY: 110;
  readonly APPROVAL_POLICY: 115;
  readonly SUBAGENT_DELEGATION: 120;
};
/** Name of a centrally allocated runtime-context position. */
type PromptContextOrderName = keyof typeof CONTEXT_ORDERS;
/** Plugin config: the deployment-authored fragment of the system prompt (see {@link Config.personaPrefix} for its contract). */
interface Config$3 {
  /** Include the fixed DeepSeek Harness identity before the deployment persona (default true). */
  includeHarnessIdentity?: boolean;
  /** Include dynamic runtime-context snapshots in model history (default true). */
  includeRuntimeContext?: boolean;
  /**
   * Deployment-wide persona prefix template before first-party guidance. A scoped section named
   * `deployment:persona-prefix` shadows it; `{{variable}}` references are strict.
   */
  personaPrefix?: string;
  /**
   * Persona suffix template after first-party guidance. A scoped `deployment:persona-suffix`
   * section shadows it; `{{variable}}` references are strict. Defaults to empty.
   */
  personaSuffix?: string;
  /**
   * Model-facing tool names in order, with {@link TOOL_ORDER_REST} exactly once.
   * Invalid fields fail at load and unknown names fail at assembly; known names
   * hidden in one scope may be absent there. Omitted means lexicographic order.
   */
  toolOrder?: string[];
}
/** Registry service for the prompt inputs assembled before each model step. */
declare class SystemPrompt extends Service {
  static Config: Schema<Config$3>;
  private readonly layers;
  private readonly toolOrder;
  constructor(ctx: Context, config: Config$3);
  /**
   * Register an ordered prompt section in the calling context's scope. A scoped
   * section shadows a global section with the same name; duplicates within one
   * layer and non-finite orders throw. Registration and disposal emit
   * `system-prompt/change`.
   * @param section - the section to register.
   * @returns the exact Cordis effect disposer.
   */
  section(section: PromptSection): () => void;
  /**
   * Resolve the centrally owned placement of a repository prompt section.
   * @param name - stable section placement name.
   * @returns the section's numeric sort order.
   */
  getSectionOrder(name: PromptSectionOrderName): number;
  /**
   * Resolve the centrally owned placement of a repository runtime context.
   * @param name - stable context placement name.
   * @returns the context's numeric sort order.
   */
  getContextOrder(name: PromptContextOrderName): number;
  /**
   * Register ordered dynamic context in the calling context's scope. Scoped
   * entries shadow global entries with the same name.
   * @param context - the context contribution to register.
   * @returns the exact Cordis effect disposer.
   */
  context(context: PromptContext): () => void;
  /**
   * Suppress every dynamic runtime-context contribution in the calling
   * context's scope without changing the services that own or enforce those
   * facts. Multiple suppressors remain independently disposable.
   * @returns the exact Cordis effect disposer.
   */
  suppressRuntimeContext(): () => void;
  /**
   * Register a tool-schema provider in the calling context's scope. Global and
   * matching scoped providers both contribute; returning the reserved
   * {@link TOOL_ORDER_REST} name makes assembly fail.
   * @param provider - evaluated for each assembly with its context.
   * @returns the exact Cordis effect disposer.
   */
  tools(provider: (context: AssembleContext) => ToolProviderResult): () => void;
  /**
   * Register a prompt variable in the calling context's scope. Scoped values
   * shadow globals; invalid or duplicate names throw. A provider may return
   * `undefined`, but rendering a section that references that value then fails.
   * @param name - the `[a-z][a-z0-9_]*` reference name.
   * @param provider - evaluated for each assembly.
   * @returns the exact Cordis effect disposer.
   */
  variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void;
  /**
   * Assemble global and scoped providers, detach tool parameters, apply
   * canonical ordering, then run the assembly waterfall. Scoped sections and
   * variables shadow globals. The returned waterfall value is authoritative
   * except that an effective complete section is restored afterwards as the
   * sole prompt section.
   * @param context - the optional scope and plugin-defined assembly fields.
   * @returns the post-waterfall assembly with any complete prompt enforced.
   */
  assemble(context?: AssembleContext): Promise<PromptAssembly>;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-agent@0.1.5-rc.2_6df6622855b87cb7fde1fe609a6d039a/node_modules/@deepseek-ai/dsh-agent/lib/types/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    agents: AgentRegistry;
  }
}
/**
 * Synchronous finalizer returned by unpublished Agent setup when its
 * contributions need validation at the exact publication commit point.
 */
interface AgentSetupCommit {
  /**
   * Validate and commit the prepared setup immediately before publication.
   * @throws when publication must roll the unpublished Agent back.
   */
  commit(): void;
}
/**
 * Compose an unpublished Agent scope and optionally return its publication commit.
 * @param agentCtx - unpublished Agent scope.
 * @param agent - unpublished Agent being composed.
 * @returns an optional synchronous commit invoked after setup awaits settle and immediately before publication.
 */
type AgentSetup = (agentCtx: Context, agent: Agent) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void;
/**
 * Options for programmatically creating an agent through the registry factory
 * ({@link AgentRegistry.create}). The caller supplies the single live
 * `sessionId` shared by the agent registry and session log (e.g. an
 * ACP-generated id), plus optional session metadata (the validated `cwd`, fork
 * lineage); the factory creates the session and agent under that identity.
 */
interface CreateAgentOptions {
  /** The live agent/session identity. */
  readonly sessionId: SessionId;
  /** Live parent Agent for runtime ownership; omit for a root Agent. */
  readonly parentAgent?: Agent;
  /**
   * Session creation metadata: validated absolute `cwd`, `parentSession`
   * fork lineage, the `isSeeded` fork marker, the coarse `origin`
   * classification, and the `delegationDepth` recursion budget. Mirrors the
   * `cwd`/`parentSession`/`isSeeded`/`origin`/`delegationDepth` fields of
   * {@link CreateSessionOptions.meta} in dsh-session (the internal-only
   * `createdAt`, used when reconstructing a persisted session, is deliberately
   * excluded — a factory caller never sets it). This is durable session data,
   * so the session boundary validates and snapshots it before asynchronous
   * setup begins.
   */
  readonly meta?: {
    readonly cwd?: string;
    readonly parentSession?: SessionId;
    readonly isSeeded?: boolean;
    readonly origin?: 'subagent';
    readonly delegationDepth?: number;
    readonly agentPreset?: string;
  };
  /** Exact fork-inherited prefix length when the session metadata sets `isSeeded`. */
  readonly inheritedEventCount?: SessionLogOffset;
  /**
   * Initial replay/fork history. A fork supplies a balanced completed-turn
   * prefix of the parent's log. The complete seed must be contiguous from seq
   * 0, carry only lossless-JSON data, and contain no open turn/step or dangling
   * tool call. The factory passes it to the session's durable
   * validator/snapshot boundary before publication.
   */
  readonly seed?: readonly SessionEvent[];
  /** Per-agent options (model, …). */
  readonly agentOptions?: AgentOptions;
  /** Optional creation-only cancellation signal; detached before the returned handle becomes visible. */
  readonly signal?: AbortSignal;
  /**
   * Creation-time composition of the agent's scoped world. The factory awaits
   * setup after minting `agentCtx` but BEFORE inserting or announcing either
   * the session or agent, so observers can never see a partially configured
   * world. Setup may return an {@link AgentSetupCommit}; the factory invokes its
   * synchronous `commit()` after every setup await settles and immediately
   * before registry publication. This lets mutable provisioning revalidate at
   * the exact publication boundary. Everything registered through `agentCtx`
   * (scoped tools, prompt sections/variables, `restrict()`, listeners, awaited
   * child plugins) exists before `session/created`, `agent/created`,
   * `agent/session-start`, and the first prompt assembly. A setup
   * throw/rejection, commit throw, or owner disposal rolls the scope back
   * without publishing either id.
   *
   * **Setup composes, it never drives**: the callback is trusted same-process
   * code and receives the full scoped context, so this is a contract rather
   * than a runtime restriction. Drive the agent only after creation resolves.
   */
  readonly setup?: AgentSetup;
}
/**
 * Options for resuming an agent on a persisted session
 * ({@link AgentRegistry.resume}).
 */
interface ResumeAgentOptions {
  /** The persisted session id to load and use as the live agent/session identity. */
  readonly resumeSessionId: SessionId;
  /** Live parent Agent for runtime ownership; omit for a root Agent. */
  readonly parentAgent?: Agent;
  /** Per-agent options (model, …). */
  readonly agentOptions?: AgentOptions;
  /** Optional creation-only cancellation signal for persistence load/setup; detached before return. */
  readonly signal?: AbortSignal;
  /**
   * Resume-time composition of the agent's fresh scoped world. Persistence is
   * loaded first; the factory then mints `agentCtx` and awaits setup while the
   * reconstructed session and agent remain unpublished. The callback has the
   * same trusted composition-only contract and optional synchronous
   * publication commit as {@link CreateAgentOptions.setup}: all registrations
   * exist before either creation announcement, and rejection, commit failure,
   * or owner disposal rolls the transaction back without publishing either id.
   */
  readonly setup?: AgentSetup;
}
/**
 * An owned agent plus its disposer, returned by {@link AgentRegistry.create} /
 * {@link AgentRegistry.resume}. The disposer is a CAPABILITY: among consumers,
 * only the holder can tear this agent down. The registered factory provider is
 * also a structural owner because the scoped agent depends on that provider's
 * service API; provider unload stops and drains every live handle it made.
 * `dispose()` stops the loop, awaits its exit, unregisters the agent, removes
 * its session from the store, and finally unwinds its scoped world.
 *
 * `ctx.agents.get(id)` still returns a bare {@link Agent} — the handle is
 * exposed only to the consumer owner that created it; the structural provider
 * reaches the same teardown internally. Config-created agents (the loop's own
 * startup) are owned by the loop fiber and never need a handle.
 */
interface AgentHandle {
  agent: Agent;
  dispose(): Promise<void>;
}
/**
 * The agent-creation factory the loop implementation provides to the registry
 * via {@link AgentRegistry.setFactory}. Kept on the `dsh-agent` interface so
 * consumers (e.g. the ACP bridge) program against `ctx.agents` without
 * depending on the concrete `dsh-agent-loop` package.
 */
interface AgentFactory {
  /**
   * Create a new agent on a caller-supplied session id. Async because creation
   * awaits unpublished setup, invokes its optional synchronous commit, inserts
   * both session and agent, emits their creation notifications in order, emits
   * `agent/session-start`, and only then starts the loop. The sequence is
   * rollback-covered, but notifications delivered before a later listener
   * failure remain observable; every agent or session creation announcement
   * that began is paired by `agent/disposed` or `session/disposed` during
   * rollback. The owner disposes the resolved handle to stop/drain,
   * unregister, remove the session, and unwind the scope.
   * The registry passes a context carrying the `create()` caller's fiber and
   * scope as `ownerCtx`. The implementation attaches the unpublished
   * transaction and resulting lifecycle to that owner; it must not infer
   * ownership from the factory object's registration context.
   * @param ownerCtx - caller-bound context that owns the transaction and live handle.
   * @param options - agent/session identity, configuration, optional live parent, and setup.
   * @returns the owned handle after setup, both announcements, and loop start complete.
   */
  createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>;
  /**
   * Resume an agent on a persisted session. Async because it opens the
   * persisted session for write, reads and repairs the log, publishes it, and
   * awaits the optional unpublished setup transaction; must be called after
   * `ctx.sessionPersistence` exists (consumers inject `sessionPersistence`).
   * Publication follows the same setup-commit and ordered boundary as
   * {@link createAgent}.
   * @param ownerCtx - caller-bound context that owns load, setup, and the live handle.
   * @param options - persisted identity, configuration, optional live parent, and setup.
   * @returns the owned handle after setup, both announcements, and loop start complete.
   */
  resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>;
}
/**
 * Agent service (`ctx.agents`): tracks live agents and carries the initiating
 * Agent through one process-local asynchronous driver chain. Agent *creation*
 * is provided by whichever plugin implements the {@link AgentFactory}
 * (`@deepseek-ai/dsh-agent-loop`), registered via {@link setFactory}.
 *
 * Initiator methods provide same-process causal attribution only. Ambient
 * presence is neither liveness proof nor authorization; subjects and owners
 * remain explicit, as does identity at worker, process, persistence, and wire
 * boundaries. Returned Promise boundaries drain during teardown, except a
 * nested lineage that starts an owning-fiber unload is excluded from its own drain.
 */
declare class AgentRegistry extends Service {
  private store;
  private factory;
  private readonly initiators;
  private readonly initiatorRuns;
  private initiatorState;
  private activeInitiatorRuns;
  private initiatorDrain;
  private initiatorDisposal;
  constructor(ctx: Context);
  /**
   * Read the Agent that initiated the inherited asynchronous driver chain.
   * Use this optional form for logging, tracing, metrics, or host attribution
   * that also supports agentless calls. When a parent creates a child, setup
   * reports the causal parent while the setup callback's Agent parameter
   * identifies the child.
   * @returns the inherited Agent, or `undefined` outside an initiator boundary
   *   and inside an explicit clearing boundary.
   * @throws when this service instance has been disposed.
   */
  currentInitiator(): Agent | undefined;
  /**
   * Read the initiating Agent and fail when no initiator boundary is active.
   * Use this for private helpers contractually below a driver, or for a
   * deployment-owned outbound request whose contract forbids agentless calls.
   * Generic or direct-call paths use optional lookup or explicit request fields.
   * @returns the inherited Agent.
   * @throws when no initiator is active or this service instance has been disposed.
   */
  requireInitiator(): Agent;
  /**
   * Run an operation with one exact Agent as its process-local initiator. The
   * exact synchronous value or Promise returned by the operation is preserved.
   * Custom drivers and test harnesses wrap their complete returned foreground
   * lifetime.
   * A queue or wire receiver may establish this boundary only after validating
   * explicit identity and resolving the exact live Agent; this method does neither.
   * Detached work remains owned by the subsystem that starts it.
   * @param agent - initiating Agent to inherit; presence is neither liveness proof nor authorization.
   * @param operation - synchronous or asynchronous operation to invoke.
   * @returns the exact value returned by `operation`.
   * @throws when the initiator scope is closing/disposed, or when `operation` throws.
   */
  withInitiator<T>(agent: Agent, operation: () => T): T;
  /**
   * Run an operation inside a boundary that hides any inherited initiating
   * Agent. The exact synchronous value or Promise is preserved.
   * Use this while creating lazy shared timers, queue pumps, pool maintenance,
   * watchers, or exporters so they do not inherit the first Agent that happens
   * to initialize them. It clears only initiator attribution, not explicit
   * fields, and does not own or drain detached resources.
   * @param operation - synchronous or asynchronous operation to invoke without an initiator.
   * @returns the exact value returned by `operation`.
   * @throws when the initiator scope is closing/disposed, or when `operation` throws.
   */
  withoutInitiator<T>(operation: () => T): T;
  /**
   * Register the agent-creation factory (the loop calls this on construction,
   * effect-scoped). A traced Cordis service is canonicalized to its concrete
   * target; each create/resume call is then traced through that caller's
   * context so ownership follows the caller without stacking proxy layers.
   * Throws if a factory is already registered. Returns the disposer; on
   * dispose the factory slot is cleared.
   * @param factory - the loop-owned factory {@link create}/{@link resume} delegate to.
   * @returns the disposer that clears the factory slot. The exact
   *   Cordis effect disposer (single-shot): composite (generator) effects may
   *   yield it directly — exact identity nests the teardown in order.
   */
  setFactory(factory: AgentFactory): () => void;
  /** Return the active creation factory. */
  private requireFactory;
  /**
   * Create and publish a new agent through the registered factory.
   * Distinct from {@link register} (which records an already-constructed
   * agent): this constructs the agent and its session. Rejects if no factory is
   * registered or creation/setup fails. The resolved {@link AgentHandle} lets
   * the owner tear down exactly this agent.
   * @param options - shared identity, optional live parent, session seed/metadata, and agent options.
   * @returns the handle after setup, rollback-covered publication, and loop start complete.
   */
  create(options: CreateAgentOptions): Promise<AgentHandle>;
  /**
   * Load a persisted session and resume an agent on it through the registered
   * factory. Rejects if no factory is registered; the factory rejects if
   * session persistence is not configured or persistence/setup fails.
   * @param options - persisted identity, optional live parent, configuration, and setup.
   * @returns the handle after setup, rollback-covered publication, and loop start complete.
   */
  resume(options: ResumeAgentOptions): Promise<AgentHandle>;
  /**
   * Register a live agent. Throws if an agent with the same id is already
   * registered. Emits `agent/created` on registration and `agent/disposed`
   * when the calling fiber is disposed — both with the agent's scope carrier
   * (`scopeTarget(agent, agent)`): the subject is the agent in hand, so the
   * emits are scope-filtered regardless of which context invoked `register`
   * (calling through `agent.ctx` scopes EFFECTS; dispatch scoping always
   * requires passing the carrier). The entry is a runtime root; factory-backed
   * creation uses `options.parentAgent` for child ownership. Returns the disposer.
   * @param agent - the already-constructed agent to record in the store.
   * @returns the EXACT Cordis effect disposer (single-shot; a repeat call
   *   returns undefined without awaiting an in-flight teardown). Exact
   *   identity is load-bearing: a composite (generator) effect that owns a
   *   teardown ORDER — the agent factory's lifecycle chain — must yield THIS
   *   function so Cordis nests the unregistration at that yield position;
   *   yielding a wrapper would leave it disposing as a concurrent sibling on
   *   owner unload, unregistering the agent (and emitting `agent/disposed`)
   *   while its final turn is still draining.
   */
  register(agent: Agent): () => void;
  /**
   * Insert an already-constructed agent without announcing it. This is the
   * advanced ordered-lifecycle primitive used by the async agent factory: it
   * first completes setup while the agent is unpublished, then assigns the
   * returned detach closure into its pre-installed composite teardown before
   * calling {@link announce}. Ordinary callers use {@link register}.
   * @param agent - the prepared, unpublished agent.
   * @param owner - explicitly supplied live runtime owner, or
   *   undefined for a top-level runtime root. This is runtime ownership, not
   *   the resumed session's durable parent lineage.
   * @returns an idempotent closure that removes this exact entry and emits
   *   `agent/disposed` with listener failures contained. When called from a
   *   synchronous `agent/created` listener, removal and disposal wait until
   *   that creation dispatch unwinds.
   */
  enter(agent: Agent, owner: Agent | undefined): () => void;
  /** Remove one exact entered agent and emit its paired disposal when announced. */
  private detachEntered;
  /** Emit the paired disposal edge through the entry's stable carrier. */
  private emitDisposed;
  /**
   * Announce an agent previously inserted with {@link enter}.
   * @param agent - the live inserted agent to announce.
   * @throws if `agent` is not the exact live registry entry for its id, or its
   *   creation announcement already began (including a reentrant call from a
   *   creation listener).
   */
  announce(agent: Agent): void;
  /**
   * Look up a live agent.
   * @param id - the shared agent/session id to look up.
   * @returns the agent, or undefined when no live agent has that id.
   */
  get(id: SessionId): Agent | undefined;
  /**
   * Test whether a live agent was created through one exact parent agent's
   * scoped context. Runtime ownership is independent of durable session
   * lineage and remains unambiguous when unrelated providers reuse an id.
   * @param id - the candidate child agent's shared agent/session id.
   * @param owner - the expected runtime creator agent.
   * @returns true only while the exact child entry is live under that owner.
   */
  isOwnedBy(id: SessionId, owner: Agent): boolean;
  /**
   * All live agents, in registration order.
   * @returns a fresh array; mutating it does not affect the registry.
   */
  list(): Agent[];
  /**
   * All live top-level agents in registration order. A top-level agent was
   * created without an owning agent context; durable session lineage does not
   * affect this runtime relation, so a resumed fork may still be a root.
   * @returns a fresh array; mutating it does not affect the registry.
   */
  roots(): Agent[];
  /** Reject new initiator boundaries while inherited continuations drain. */
  private closeInitiators;
  /** Wait for returned-Promise boundaries, then invalidate retained references. */
  private disposeInitiators;
  /** Establish one tracked initiator or clearing boundary. */
  private runWithInitiator;
  /** Whether one unloading fiber owns this service's lifecycle. */
  private hasLifecycleAncestor;
  private assertInitiatorsReadable;
  /** Exclude the boundary chain that initiated this teardown from its own drain. */
  private releaseReentrantInitiatorRuns;
  private releaseInitiatorRun;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session-persistence@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2_@deepseek-ai+_435c924909c3d31ac09fb45aac40f3fd/node_modules/@deepseek-ai/dsh-session-persistence/lib/types/handle.d.ts
/**
 * Log access granted by an open. `write` is read-write: the session's single
 * mutator, which also reads its own log. `read` only observes — it never
 * takes ownership and works while another handle or process holds `write`.
 */
type SessionAccess = 'read' | 'write';
/** Options for {@link SessionHandle.read}. */
interface SessionHandleReadOptions {
  /** Optional cancellation for backend read work. */
  readonly signal?: AbortSignal;
}
/** One persistence event slice returned by {@link SessionHandle.read}. */
interface SessionHandleReadResult {
  /**
   * Whether event values are exclusively owned or shared only after deep
   * freezing. Slicing preserves the producer's state even when no events remain.
   */
  readonly eventState: SessionSeedEventState;
  /** Event values in a caller-owned outer array. */
  readonly events: readonly SessionEvent[];
}
/** Options for {@link SessionHandle.append}. */
interface SessionHandleAppendOptions {
  /** Optional cancellation observed before the write starts. */
  readonly signal?: AbortSignal;
}
/** Options for {@link SessionHandle.flush}. */
interface SessionHandleFlushOptions {
  /** Optional cancellation observed before the barrier starts. */
  readonly signal?: AbortSignal;
}
/**
 * One open channel onto a stored session. A handle is single-owner state, not
 * a shared service: `read` never backtracks below what this handle already
 * observed, a `write` handle reads its own successful appends, and `close()`
 * is the one teardown (idempotent, uncancellable; `Symbol.asyncDispose`
 * delegates to it). Every operation on a closed handle rejects with
 * `SessionHandleClosedError`.
 *
 * Freshness across handles: once an `append` or `flush` resolves on a write
 * handle, every read STARTED afterwards on the same backend instance — on any
 * handle, or through `stat`/`list` — observes at least that prefix.
 * Reads concurrent with a mutation carry no ordering promise beyond the valid
 * contiguous prefix.
 */
interface SessionHandle extends AsyncDisposable {
  /** The stored session this handle addresses. */
  readonly id: SessionId;
  /** The immutable stored header, fixed at `create`/`open`. */
  readonly header: SessionHeader;
  /**
   * Exact fork-inherited prefix length stored with the log; `0` when
   * `header.isSeeded` is false. Storage metadata paired with the header for
   * every body read, never part of the replayable event log.
   */
  readonly inheritedEventCount: SessionLogOffset;
  /** Whether this handle may mutate the log. */
  readonly access: SessionAccess;
  /**
   * Read a slice of the valid contiguous logical log. The slice is a legal log
   * prefix segment: a torn physical tail is never returned, and repeated reads
   * on this handle never observe an older state than a prior read.
   * @param offset - first logical event seq to include; defaults to `0`.
   * @param length - maximum number of events to return; defaults to the rest
   *   of the log. An offset at or past the end returns an empty list.
   * @param options - optional cancellation.
   * @returns the caller-owned outer slice plus the ownership state of its event values.
   */
  read(offset?: number, length?: number, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult>;
  /**
   * Append a contiguous batch continuing the current logical end. The first
   * event's `seq` MUST equal the stored next-seq; committed events are never
   * rewritten. Persistence is best-effort: on resolution the batch is
   * accepted, ordered, and visible to reads on this backend instance, but
   * only a resolved {@link flush} promises it survives a crash — a backend
   * may buffer or batch physical writes behind append. Rejects with
   * `SessionReadOnlyError` on a read handle and `SessionOwnershipLostError`
   * when write ownership is gone.
   * @param events - the contiguous batch, in seq order.
   * @param options - optional cancellation observed before the write starts.
   */
  append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void>;
  /**
   * The durability barrier — the one operation that promises storage: on
   * resolution every acknowledged append is durable and the session is
   * materialized for other processes; an empty created session becomes
   * durably listable here. Callers that must survive a crash flush; a backend
   * whose `append` already persists on resolution treats this as
   * materialize-if-needed. Rejects with `SessionReadOnlyError` on a read
   * handle.
   * @param options - optional cancellation observed before the barrier starts.
   */
  flush(options?: SessionHandleFlushOptions): Promise<void>;
  /**
   * Release the handle: a read handle frees local resources; a write handle
   * completes pending durability and releases write ownership. Idempotent,
   * asynchronous, and deliberately not cancellable.
   */
  close(): Promise<void>;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session-persistence@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2_@deepseek-ai+_435c924909c3d31ac09fb45aac40f3fd/node_modules/@deepseek-ai/dsh-session-persistence/lib/types/revision.d.ts
/**
 * Backend-owned token that identifies both one storage source and one revision
 * of a persisted session log.
 */
type SessionPersistenceRevision = Branded<'SessionPersistenceRevision'>;
/**
 * Brand a backend revision for the provider-neutral persistence contract.
 * @param value - backend-owned opaque revision representation.
 * @returns the same runtime string with persistence-revision identity.
 */
declare function SessionPersistenceRevision(value: string): SessionPersistenceRevision;
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session-persistence@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2_@deepseek-ai+_435c924909c3d31ac09fb45aac40f3fd/node_modules/@deepseek-ai/dsh-session-persistence/lib/types/index.d.ts
/**
 * Lightweight stored-session observation returned by {@link SessionPersistence.stat}
 * and {@link SessionPersistence.list} without reading the full event log.
 */
interface SessionPersistenceSnapshot {
  /** Detached metadata for one stored session. */
  readonly header: SessionHeader;
  /** Opaque change token; see {@link SessionPersistence.stat}. */
  readonly revision: SessionPersistenceRevision;
  /** Logical event count, when the backend can provide it cheaply from metadata; otherwise absent. */
  readonly eventCount?: number;
  /** Physical artifact byte size, when the backend can provide it cheaply (JSONL); otherwise absent. */
  readonly sizeBytes?: number;
}
/** Options for {@link SessionPersistence.create}. */
interface SessionPersistenceCreateOptions {
  /** Optional cancellation observed before backend work starts. */
  readonly signal?: AbortSignal;
  /**
   * Exact fork-inherited prefix length. Required when `header.isSeeded` is
   * true and must be omitted (or `0`) otherwise; the backend refuses a
   * mismatch at create.
   */
  readonly inheritedEventCount?: SessionLogOffset;
}
/**
 * Logical Session header paired with its exact inherited cut for body-bearing
 * storage operations. `isSeeded` marks fork lineage on the header; the
 * numeric cut travels beside it, never inside the replayable event log.
 */
interface SessionStorageMetadata {
  /** Validated immutable Session header. */
  readonly meta: SessionHeader;
  /** Number of leading events inherited from the Session's fork parent. */
  readonly inheritedEventCount: SessionLogOffset;
}
/** Immutable logical session read: storage metadata plus the complete validated event log. */
interface SessionInspection extends SessionStorageMetadata {
  /** Contiguous validated events from seq 0. */
  readonly events: readonly SessionEvent[];
}
/** Options for {@link SessionPersistence.open}. */
interface SessionPersistenceOpenOptions {
  /** Optional cancellation observed before backend work starts. */
  readonly signal?: AbortSignal;
}
/** Options for {@link SessionPersistence.stat}. */
interface SessionPersistenceStatOptions {
  /** Optional cancellation for backend metadata reads. */
  readonly signal?: AbortSignal;
}
/** Options for {@link SessionPersistence.list}. */
interface SessionPersistenceListOptions {
  /** Optional cancellation for backend listing work. */
  readonly signal?: AbortSignal;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionPersistence: SessionPersistence;
  }
}
/**
 * Durable append-only session storage addressed through per-session handles.
 *
 * Storage semantics shared by every backend: events are contiguous from seq 0
 * and never rewritten; a torn physical tail is never returned to a reader and
 * is truncated by the write path before its first append; reads validate
 * current-format records only and refuse unknown vocabulary fail-closed.
 * `append` persists best-effort; `flush` — per handle or service-wide — is
 * the durability barrier.
 *
 * Visibility: a created session is observable through `stat`/`list`/`open`
 * in this process from the moment `create` resolves, even while a backend
 * defers physical materialization (a pure optimization); other processes see
 * the session only once it materializes, and a session that never
 * materialized before a crash never existed. `SessionHandle.flush` forces
 * materialization.
 *
 * Freshness: once an `append` or `flush` resolves, reads started afterwards
 * on this backend instance observe at least that prefix.
 */
declare abstract class SessionPersistence extends Service {
  constructor(ctx: Context);
  /**
   * Create a new stored session and take its write ownership.
   * @param header - the immutable header (id, version, cwd, lineage) to store.
   * @param options - optional cancellation.
   * @returns a `write` handle owned by the caller; close it to release ownership.
   * @throws {SessionAlreadyExistsError} when the id already exists.
   */
  abstract create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle>;
  /**
   * Open an existing stored session.
   *
   * `read` never takes ownership and works while another handle (or process)
   * holds write ownership. `write` atomically claims single-writer ownership;
   * an existing active owner rejects.
   * @param id - the stored session to open.
   * @param access - `read` or `write`.
   * @param options - optional cancellation.
   * @returns the open handle.
   * @throws {SessionPersistenceNotFoundError} when the session does not exist.
   * @throws {SessionAlreadyOwnedError} for `write` when ownership is taken.
   */
  abstract open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle>;
  /**
   * Flush every active write handle owned by this service instance in one
   * durability barrier: each handle's routed live events drain durably and
   * its session materializes, exactly as that handle's own
   * `SessionHandle.flush` would. Read handles buffer nothing and are
   * untouched. A handle closed concurrently counts as flushed — close itself
   * drains durably.
   * @returns resolution once every write handle active at the call has flushed.
   * @throws {AggregateError} naming each session whose flush failed; the
   *   remaining handles still flush.
   */
  abstract flush(): Promise<void>;
  /**
   * Observe one stored session without reading its event log or taking
   * ownership.
   *
   * The snapshot's `revision` is an opaque change token comparable only
   * against revisions from the same service instance and session id: equal
   * revisions may be treated as an unchanged log; unequal revisions promise
   * nothing. Write-ownership churn does not change a revision. It exists for
   * derived read-model caches keyed off `stat`/`list`; it plays no part in
   * open, read, or resume.
   * @param id - the stored session to observe.
   * @param options - optional cancellation.
   * @returns the snapshot, or `undefined` when the session does not exist.
   */
  abstract stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined>;
  /**
   * List every stored session visible to this process, in no promised order.
   * @param options - optional cancellation.
   * @returns one snapshot per stored session.
   */
  abstract list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]>;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session-title@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2_@deepseek-ai+dsh-ag_8936cd7ae3cf91721c2fc38d26133392/node_modules/@deepseek-ai/dsh-session-title/lib/types/types.d.ts
/** Identifies one session-title provider registration. */
type SessionTitleProviderId$1 = Branded<'SessionTitleProviderId'>;
/** Exact auxiliary model route that produced a title. */
interface SessionTitleModelProvenance {
  /** Registered LLM provider route. */
  readonly provider: string;
  /** Provider model id. */
  readonly model: string;
}
/** Durable ownership record for an accepted session title. */
type SessionTitleSource = {
  readonly kind: 'fallback';
} | {
  readonly kind: 'provider';
  readonly provider: SessionTitleProviderId$1;
  readonly model?: SessionTitleModelProvenance;
} | {
  /** Explicit user rename: pins the title — automatic generation stops scheduling. */
  readonly kind: 'user';
};
/** Payload of the log-only `session/title` event. */
interface SessionTitleEventData {
  /** Normalized non-empty title text. */
  readonly title: string;
  /** Exact human `user/message` seqs used to derive this title; empty for an explicit user rename. */
  readonly messageSeqs: SessionSeq[];
  /** Whether the built-in fallback, a registered provider, or the user supplied the title. */
  readonly source: SessionTitleSource;
}
/** Latest folded title plus the title event's durable envelope facts. */
interface SessionTitleSnapshot extends SessionTitleEventData {
  /** Seq of the latest `session/title` event. */
  readonly eventSeq: SessionSeq;
  /** Timestamp of the latest `session/title` event. */
  readonly updatedAt: number;
}
/** One eligible human text message exposed to title providers. */
interface SessionTitleUserMessage {
  /** Source `user/message` event seq. */
  readonly seq: SessionSeq;
  /** Exact concatenated text-block content. */
  readonly text: string;
}
/** Eligible title input stored as a bounded aggregate. */
interface TitleInputState {
  /** The oldest eligible message, or null before any. */
  readonly first: SessionTitleUserMessage | null;
  /** Total eligible messages folded so far. */
  readonly count: number;
  /** Seq of the newest eligible message, or null before any. */
  readonly lastSeq: OptionalSessionSeq;
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Latest logged title text, or null. */
    title: string | null;
    /** Eligible human title input. */
    titleInput: TitleInputState;
  }
  interface SessionProjectionMap {
    /**
     * The session's current normalized title — the latest `session/title`
     * event's text (last-wins), or `null` before the first title lands. A
     * plain string: the shape the client list rows consume.
     */
    title: string | null;
  }
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session-title@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2_@deepseek-ai+dsh-ag_8936cd7ae3cf91721c2fc38d26133392/node_modules/@deepseek-ai/dsh-session-title/lib/types/index.d.ts
/** Identifies one session-title provider registration. */
type SessionTitleProviderId = Branded<'SessionTitleProviderId'>;
/**
 * Brand a raw provider id.
 * @param id - stable non-empty provider identifier supplied by a plugin.
 * @returns the same string with the session-title provider brand.
 */
declare function SessionTitleProviderId(id: string): SessionTitleProviderId;
/** Required deterministic fallback and accepted-title limits. */
interface Config$2 {
  /** Maximum whitespace-delimited words in the built-in fallback. */
  readonly fallbackMaxWords: number;
  /** Maximum UTF-8 bytes in the built-in fallback. */
  readonly fallbackMaxBytes: number;
  /** Maximum UTF-8 bytes in any accepted title. */
  readonly maxTitleBytes: number;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionTitle: SessionTitleService;
  }
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Latest-wins session title snapshot. Log-only: it never enters the model
     * surface or derived history.
     */
    'session/title': SessionTitleEventData;
  }
}
/** Automatic generation cadence owned by a registered provider. */
type SessionTitleAutomaticMode = 'first-prompt' | 'all-prompts';
/** Immutable input supplied to one title-provider call. */
interface SessionTitleProviderRequest {
  /** Live session being titled. */
  readonly session: Session;
  /** All eligible human messages through this generation revision. */
  readonly messages: readonly SessionTitleUserMessage[];
  /** Exact current logged main-request route, when one has been recorded. */
  readonly route?: SessionTitleModelProvenance;
  /** Cancellation for supersession, disposal, timeout composition, or the explicit caller. */
  readonly signal: AbortSignal;
}
/** Provider output before service-owned normalization and log acceptance. */
interface SessionTitleProviderResult {
  /** Proposed title text. */
  readonly title: string;
  /** Exact seqs from `request.messages` used by this result. */
  readonly messageSeqs: readonly SessionSeq[];
  /** Auxiliary LLM route, when generation used a model. */
  readonly model?: SessionTitleModelProvenance;
}
/** One optional asynchronous title implementation registered with the service. */
interface SessionTitleProvider {
  /** Stable id of the provider recorded with the title. */
  readonly id: SessionTitleProviderId;
  /** When new human prompts start automatic generation. */
  readonly automatic: SessionTitleAutomaticMode;
  /**
   * Produce one title revision.
   * @param request - message snapshot, current route, session, and cancellation.
   * @returns proposed title plus exact input seqs and the optional provider/model route used to generate it.
   */
  generate(request: SessionTitleProviderRequest): Promise<SessionTitleProviderResult>;
}
/** Log-backed title fold plus asynchronous fallback generation. */
declare class SessionTitleService extends Service {
  static inject: string[];
  static Config: Schema<Config$2>;
  private readonly config;
  private readonly ownerFiber;
  private registration;
  private readonly work;
  private readonly lifetime;
  private readonly inFlight;
  constructor(ctx: Context, config: Config$2);
  /**
   * Read the latest folded title from one live or replayed session.
   * @param session - session whose log is the title source of truth.
   * @returns latest title snapshot, or `undefined` before eligible input.
   */
  get(session: Session): SessionTitleSnapshot | undefined;
  /**
   * Accept an explicit user title. Appends a `session/title` event with the
   * `user` source, which pins the title: in-flight automatic generation is
   * superseded and later user messages schedule none (an explicit
   * {@link SessionTitleService.refresh} remains the deliberate unpin).
   * @param session - exact live session to rename.
   * @param title - raw user input; normalized before acceptance.
   * @returns the accepted title snapshot.
   * @throws {SessionTitleInvalidError} when the title normalizes to empty.
   * @throws {Error} when the session is not live or the service is disposed.
   */
  rename(session: Session, title: string): SessionTitleSnapshot;
  /**
   * Explicitly retry the registered provider, or materialize the built-in
   * fallback when no provider is registered.
   * @param session - exact live session to refresh.
   * @param signal - optional caller cancellation.
   * @returns latest accepted title, or `undefined` when no eligible text exists.
   */
  refresh(session: Session, signal?: AbortSignal): Promise<SessionTitleSnapshot | undefined>;
  /**
   * Register the sole optional title provider. Disposal aborts its pending and
   * active work before another provider may register.
   * @param provider - provider identity, cadence, and generation function.
   * @returns exact Cordis effect disposer, which settles after active calls quiesce.
   */
  register(provider: SessionTitleProvider): () => Promise<void>;
  /** Schedule fallback creation and any provider cadence for one eligible event. */
  private onUserMessage;
  /** Start pending automatic work only after its exact main-request route is logged. */
  private onRequestHeader;
  /** Start unchanged-route work from the marked loop request after its header fold is current. */
  private onMainRequest;
  /** Consume one pending revision and schedule its non-blocking provider call. */
  private startPending;
  /** Start one tracked provider call after publishing its active revision. */
  private startProvider;
  /** Execute and accept one current provider revision. */
  private runProvider;
  /** Validate and normalize provider output against the supplied message snapshot. */
  private validateResult;
  /** Fail a completion whose provider, revision, session, or signal is stale. */
  private assertCurrent;
  /** Create and publish an active provider call from one fixed revision. */
  private activate;
  /** Abort older active work and reserve the next session-local revision. */
  private supersede;
  /** Return mutable work state for one session. */
  private stateFor;
  private titleInputOf;
  /** Queue detached service work and retain it through service disposal. */
  private defer;
  /** Retain one promise until settlement for service and optional provider teardown. */
  private track;
  /** Await every current and settling promise in one lifecycle registry. */
  private drain;
  /** Whether the owning plugin fiber can still start or commit title work. */
  private serviceActive;
  /** Reject work once the owning plugin fiber has begun unloading. */
  private assertServiceActive;
  /** Reject malformed provider registrations before publishing an effect. */
  private validateProvider;
  /**
   * Derive and append the deterministic fallback title over whatever stands
   * (the refresh unpin path: overwriting a pinned user title is the point).
   * Synchronous on purpose — no await may separate derivation from append, so
   * it needs neither ensureFallback's in-flight dedup nor its liveness
   * re-check. An underivable fallback (empty after the caps) appends nothing.
   */
  private appendFallback;
  /** Create the first deterministic fallback if the session still lacks a title. */
  private ensureFallback;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session-query@0.1.5-rc.2_2014ad72456bc3b90c04c603b2bf92c4/node_modules/@deepseek-ai/dsh-session-query/lib/types/cursor.d.ts
/** Provider-owned opaque continuation token returned by session search. */
type SessionSearchCursor = Branded<'SessionSearchCursor'>;
/**
 * Brand an encoded provider cursor for the public search contract.
 * @param value - opaque encoded cursor value.
 * @returns the same runtime string with session-search cursor identity.
 */
declare function SessionSearchCursor(value: string): SessionSearchCursor;
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session-query@0.1.5-rc.2_2014ad72456bc3b90c04c603b2bf92c4/node_modules/@deepseek-ai/dsh-session-query/lib/types/types.d.ts
/** Whether an event is current model context, replaced context, or raw-log-only. */
type SessionEventSurface = 'current' | 'shadowed' | 'log-only';
/** Lightweight identity and source availability for one logical session. */
interface SessionRecord {
  /** Cloned session header selected from the live-preferred corpus. */
  header: SessionHeader;
  /** Whether the id currently exists in `ctx.sessions`. */
  live: boolean;
  /** Whether the active persistence backend currently lists the id, including a created-but-unmaterialized session it already observes. */
  persisted: boolean;
}
/** One atomic live-preferred observation of a session's current model surface. */
interface SessionSurfaceSnapshot {
  /** Cloned session header selected from the same corpus observation as `events`. */
  session: SessionHeader;
  /** Exact number of fork-inherited events in the observed log. */
  inheritedEventCount: SessionLogOffset;
  /** Highest raw-log seq included in the observation, or `null` for an empty log. */
  capturedThroughSeq: OptionalSessionSeq;
  /** Cloned current surface events in model-history order. */
  events: SurfaceEvent[];
}
/** One validated detached observation of a logical session's complete raw log. */
interface SessionLogSnapshot {
  /** Cloned session header selected from the same observation as `events`. */
  session: SessionHeader;
  /** Exact number of fork-inherited events in the observed log. */
  inheritedEventCount: SessionLogOffset;
  /** Cloned contiguous raw events after in-memory interrupted-turn balancing and replay validation. */
  events: SessionEvent[];
}
/** Lightweight metadata for one event within a logical session. */
interface SessionEventRecord {
  /** Session that owns the event. */
  sessionId: SessionId;
  /** Monotonic event seq within the session. */
  seq: SessionSeq;
  /** Discriminant of the session event. */
  type: SessionEventType;
  /** Event timestamp in Unix epoch milliseconds. */
  time: number;
  /** Event placement in the folded session surface. */
  surface: SessionEventSurface;
}
/** Recursive descendant node in a session-lineage trace. */
interface SessionLineageNode {
  /** Detached logical-corpus record for this descendant. */
  session: SessionRecord;
  /** Direct children, each carrying its own recursive descendants. */
  descendants: SessionLineageNode[];
}
/** Known ancestry and descendants for one logical session. */
type SessionLineageTrace = {
  /** Detached record for the session that was traced. */
  target: SessionRecord;
  /** Known parents from the immediate parent outward. */
  ancestors: SessionRecord[];
  /** Complete known descendant trees rooted at the target's direct children. */
  descendants: SessionLineageNode[];
} & ({
  /** The complete parent chain is present in the logical corpus. */
  complete: true;
  /** Detached record at the top of the complete lineage. */
  root: SessionRecord;
} | {
  /** The parent chain leaves the visible logical corpus. */
  complete: false;
  /** First parent id that is not present in the logical corpus. */
  unresolvedParentId: SessionId;
});
/** Request for direct surface replacements and relationships to cited source events around one event. */
interface SessionEventTraceRequest {
  /** Session that owns the target event. */
  sessionId: SessionId;
  /** Target event seq. */
  seq: SessionSeq;
}
/** Direct surface replacements and relationships to cited source events for one event. */
interface SessionEventTrace {
  /** Lightweight target record. */
  target: SessionEventRecord;
  /** Immediate positional replacement event, when the target was shadowed. */
  replacedBy?: SessionSeq;
  /** Positional replacers from the immediate replacement to the final replacement. */
  replacementChain: SessionSeq[];
  /** Surface nodes directly removed when the target itself performed a replacement. */
  replacedEventSeqs: SessionSeq[];
  /** Earlier events cited directly as sources, in their recorded order. */
  sourceEventSeqs: SessionSeq[];
  /** Later events that directly cite the target as a source, in log order. */
  derivedEventSeqs: SessionSeq[];
}
/** Event relationships bound to the same session-header observation. */
interface SessionEventTraceObservation extends SessionEventTrace {
  /** Cloned header selected with the event log used for the trace. */
  session: SessionHeader;
}
/** Request for one event plus raw neighboring log context. */
interface SessionEventReadRequest {
  /** Session that owns the target event. */
  sessionId: SessionId;
  /** Target event seq. */
  seq: SessionSeq;
  /** Number of preceding raw events to include. */
  before?: number;
  /** Number of following raw events to include. */
  after?: number;
}
/** Full target event and a bounded raw-log window. */
interface SessionEventWindow {
  /** Cloned header for the live-preferred source read. */
  session: SessionHeader;
  /** Exact number of fork-inherited events in the observed log. */
  inheritedEventCount: SessionLogOffset;
  /** Full cloned target event. */
  target: SessionEvent;
  /** Full cloned events from `startSeq` through `endSeq`. */
  events: SessionEvent[];
  /** First seq included in `events`. */
  startSeq: SessionSeq;
  /** Last seq included in `events`. */
  endSeq: SessionSeq;
}
/** Latest folded title bound to the same session-header observation. */
interface SessionTitleObservation {
  /** Cloned header selected with the event log used for the title fold. */
  session: SessionHeader;
  /** Latest title snapshot, absent when the observed log has no title. */
  title?: SessionTitleSnapshot;
}
/** One ordered result from a batch title observation. */
type SessionTitleObservationResult = {
  /** Requested session id. */
  sessionId: SessionId;
  /** Successful atomic header/title observation. */
  status: 'fulfilled';
  /** Header and optional latest title from one logical source. */
  value: SessionTitleObservation;
} | {
  /** Requested session id. */
  sessionId: SessionId;
  /** Operational failure isolated to this session. */
  status: 'rejected';
  /** Original failure from logical-source resolution or title folding. */
  reason: unknown;
};
/** Inclusive numeric interval used by time and sequence filters. */
interface SessionResultRange {
  /** Inclusive lower bound. */
  from?: number;
  /** Inclusive upper bound. */
  to?: number;
}
/** Source availability predicates understood by logical-session filters. */
type SessionAvailability = 'live' | 'persisted';
/**
 * One logical-session predicate. A filter array is ANDed; `values` within a
 * clause are ORed.
 */
type SessionResultFilter = {
  kind: 'id';
  values: readonly SessionId[];
} | {
  kind: 'cwd';
  values: readonly (string | null)[];
} | ({
  kind: 'created-at';
} & SessionResultRange) | {
  kind: 'parent';
  values: readonly (SessionId | null)[];
} | {
  kind: 'availability';
  values: readonly SessionAvailability[];
};
/**
 * One event predicate. A filter array is ANDed; list-valued clauses are ORed.
 * Text is a literal, case-insensitive, whitespace-flexible semantic-text scan.
 */
type SessionEventResultFilter = ({
  kind: 'seq';
} & SessionResultRange) | ({
  kind: 'time';
} & SessionResultRange) | {
  kind: 'type';
  values: readonly SessionEventType[];
} | {
  kind: 'surface';
  values: readonly SessionEventSurface[];
} | {
  kind: 'text';
  text: string;
};
/** Event predicates a full-text provider can apply before relevance ranking. */
type SessionEventMetadataFilter = Exclude<SessionEventResultFilter, {
  kind: 'text';
}>;
/** Searchable semantic document derived from one session event. */
interface SessionEventSearchDocument extends SessionEventRecord {
  /** First-party semantic text used by scan filters and full-text indexes. */
  text: string;
}
/** One cursor-paginated result page. */
interface SessionSearchPage<T> {
  /** Results for this page in contract-defined order. */
  items: readonly T[];
  /** Opaque continuation cursor, absent on the final page. */
  nextCursor?: SessionSearchCursor;
}
/** Event-search results bound to the indexed target-session observation. */
interface SessionEventSearchPage extends SessionSearchPage<SessionEventSearchHit> {
  /** Cloned target header from the same indexed generation as `items`. */
  session: SessionHeader;
}
/** Controls shared by cross-session and within-session search calls. */
interface SessionSearchExecContext {
  /** Abort caller waiting and interrupt provider work where supported. */
  signal?: AbortSignal;
}
/** Cross-session full-text search request. */
interface SessionSearchRequest {
  /** Full-text query interpreted as data, never executable FTS syntax. */
  query: string;
  /** Logical-session predicates applied before event ranking. */
  sessionFilters?: readonly SessionResultFilter[];
  /** Event predicates applied before event ranking. */
  eventFilters?: readonly SessionEventMetadataFilter[];
  /** Maximum sessions in this page. */
  limit?: number;
  /** Opaque cursor returned for the identical normalized request. */
  cursor?: SessionSearchCursor;
}
/** Within-session full-text search request. */
interface SessionEventSearchRequest {
  /** Session whose live-preferred logical log is searched. */
  sessionId: SessionId;
  /** Full-text query interpreted as data, never executable FTS syntax. */
  query: string;
  /** Event predicates applied before ranking. */
  filters?: readonly SessionEventMetadataFilter[];
  /** Maximum events in this page. */
  limit?: number;
  /** Opaque cursor returned for the identical normalized request. */
  cursor?: SessionSearchCursor;
}
/** One event full-text search hit with a bounded plain-text excerpt. */
interface SessionEventSearchHit extends SessionEventRecord {
  /** Plain text excerpt selected around the match. */
  snippet: string;
}
/** One grouped cross-session hit, ranked by its strongest matching event. */
interface SessionSearchHit extends SessionRecord {
  /** Strongest matching event for this session. */
  bestMatch: SessionEventSearchHit;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session-query@0.1.5-rc.2_2014ad72456bc3b90c04c603b2bf92c4/node_modules/@deepseek-ai/dsh-session-query/lib/types/config.d.ts
/** Backend-independent configuration inherited by every session-query implementation. */
interface Config$1 {
  /** Maximum accepted raw read context on either side. Defaults to 50. */
  readWindowMax?: number;
  /** Maximum concurrent persisted-log reads in one batch read. Defaults to 4. */
  persistedReadConcurrency?: number;
  /**
   * Maximum cold prepared-Session observations retained for reuse, keyed by
   * durable revision. Entries pinned by active observation leases do not count
   * against this bound until released. Defaults to 5.
   */
  preparedSessionCacheSize?: number;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session-projection@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2_@deepseek-ai+d_84cd66f454dbfc7490c4215f4e78e5dd/node_modules/@deepseek-ai/dsh-session-projection/lib/types/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionProjections: SessionProjectionRegistry;
  }
}
/**
 * One domain's state-driven computation unit: a pure synchronous fold plus
 * declarations and an optional client view — never an opaque getter. The framework drives
 * `apply` on every committed session event; the domain holds no
 * subscriptions and owns only the computation. All functions MUST be
 * synchronous (an async unit would tear the carriers' consistency cut), and
 * `state` MUST be plain JSON (the persisted-cache precondition).
 */
interface ProjectionDefinition<K extends keyof SessionProjectionStateMap, S extends SessionProjectionStateMap[K] = SessionProjectionStateMap[K]> {
  /** The projection key this unit owns (its `SessionProjectionStateMap` entry). */
  key: K;
  /** Validates persisted state before it seeds a fold. */
  stateSchema: ZodType<S>;
  /**
   * State for the empty log and its immutable Session metadata.
   * @param header - immutable metadata for the Session being projected.
   * @param inheritedEventCount - exact fork-inherited prefix length.
   * @returns the initial state.
   */
  init(header: SessionHeader, inheritedEventCount: SessionLogOffset): NoInfer<S>;
  /**
   * Pure transition: previous state + one committed event → next state. A
   * unit uninterested in an event MUST return the same state reference — an
   * unchanged reference (`Object.is`) produces zero downstream work.
   * @param state - the state covering all prior events.
   * @param event - the next committed session event.
   * @returns the next state (same reference when the event is not the unit's).
   */
  apply(state: NoInfer<S>, event: SessionEvent): NoInfer<S>;
  /** Client view. Omit for host-only units. */
  wire?: K extends keyof SessionProjectionMap ? {
    /** Validates the wire payload before it leaves the host. */
    viewSchema: ZodType<SessionProjectionMap[K]>;
    /**
     * State → wire payload (the read-side projection). The live drive keeps
     * the two latest raw results and compares them with `Object.is`; an
     * object-valued view must reuse its reference to suppress publication
     * across internal-only state changes.
     * @param state - the current state.
     * @returns the whole current value for this unit's key.
     */
    view(state: NoInfer<S>): SessionProjectionMap[K];
  } : never;
  /**
   * Persisted-cache invalidation version: bump whenever the serialized state fields or the
   * fold semantics change, so persisted `(sessionId, key, ver, seq, val)`
   * rows from an older unit are discarded instead of being forward-applied
   * into garbage. Non-negative integer.
   */
  stateVersion: number;
}
/**
 * Change-feed listener: one unit's raw `view` result changed by `Object.is`
 * for one session. `value` is the schema-validated output; `seq` is the
 * unit's watermark at emission (the seq of the event that caused the change).
 */
type ProjectionChangeListener = (session: Session, key: Extract<keyof SessionProjectionMap, string>, value: unknown, seq: SessionSeq) => void;
/**
 * One consistent read cut over every registered client-visible unit for one session.
 * `asOfSeq` is the shared watermark — the seq of the last event every value
 * reflects (`-1` for an empty log).
 */
interface ProjectionSnapshot {
  /** Seq of the last event the values reflect; -1 for an empty log. */
  asOfSeq: SessionSeqCursor;
  /** Whole current client value per registered key. */
  values: Partial<SessionProjectionMap>;
}
/**
 * One unit's checkpoint: its internal state (plain JSON by the unit
 * contract), the seq of the last event folded into it, and the unit
 * `stateVersion` that produced it — the persisted projection-cache row
 * `(sessionId, key, ver, seq, val)` minus the two outer keys. A row is
 * never authoritative, only a fold shortcut: `restore` discards it on a
 * version mismatch or when it claims events past the stored log end.
 */
interface ProjectionCheckpointRow {
  /** The registering unit's `stateVersion` at fold time. */
  ver: number;
  /** Seq of the last event folded into `val`; -1 for the empty log. */
  seq: SessionSeqCursor;
  /** The unit's internal state — plain JSON per the unit contract. */
  val: unknown;
}
/** Checkpoint rows keyed by projection key (one session's persisted cache value). */
type ProjectionCheckpoint = Record<string, ProjectionCheckpointRow>;
/**
 * `ctx.sessionProjections`: the projection unit table and its drive. The
 * service subscribes to `session/event` once; every committed event passes
 * every registered unit's `apply` (eager drive). A changed state reference
 * computes the next client view; the change feed is notified only when its
 * raw result changes by `Object.is`.
 * Cells build lazily — a unit registered after events flowed, or a session
 * older than the registry, folds `init` over the in-memory log on first
 * touch (event or read). Registration is an effect (disposer rides the
 * calling fiber): an unloaded domain plugin's key disappears from snapshots
 * and clients read it as capability absence. A host reader either declares
 * `sessionProjections` in its plugin `inject` or fails explicitly when the
 * registry or required key is absent. Contributors may preserve optional
 * registration through `ctx.inject(['sessionProjections'], ...)`. Registrants sharing a key
 * share one unit and are counted: the same tool package mounted in N agent
 * presets registers N times, and the key survives until the last one
 * unloads.
 */
declare class SessionProjectionRegistry extends Service {
  private readonly registrations;
  private readonly listeners;
  /**
   * Create and install the registry as `ctx.sessionProjections`.
   * @param ctx - Cordis context that owns the service.
   */
  constructor(ctx: Context);
  /**
   * Register one domain's unit. The registration is an effect on the calling
   * context's fiber: disposing the fiber (or calling the returned disposer)
   * removes the key — and the unit's cached cells — from subsequent drives
   * and snapshots.
   * @param definition - key, state schema, pure unit functions, and stateVersion.
   * @returns the exact disposer that unregisters this unit.
   */
  register<K extends keyof SessionProjectionMap, S extends SessionProjectionStateMap[K]>(definition: Omit<ProjectionDefinition<K, S>, 'wire'> & {
    wire: NonNullable<ProjectionDefinition<K, S>['wire']>;
  }): () => void;
  /**
   * Register one host-only unit. Its state is omitted from client snapshots
   * and always checkpointed like every other unit.
   * @param definition - key, state schema, pure unit functions, and stateVersion.
   * @returns the exact disposer that unregisters this unit.
   */
  register<K extends Exclude<keyof SessionProjectionStateMap, keyof SessionProjectionMap>, S extends SessionProjectionStateMap[K]>(definition: Omit<ProjectionDefinition<K, S>, 'wire'>): () => void;
  /**
   * Subscribe to the change feed. The registration is an effect on the
   * calling context's fiber.
   * @param listener - called once per client-visible unit whose raw view changed by `Object.is`, per committed event.
   * @returns the exact disposer that unsubscribes.
   */
  onChanged(listener: ProjectionChangeListener): () => void;
  /**
   * Read one unit's current host state after materializing every registered
   * unit at the Session cursor. Unrelated wire views are not produced.
   * The returned value is live; callers must not mutate it.
   * @param session - the session whose state is read.
   * @param key - the registered unit key.
   * @returns current state, or `undefined` when the key is not registered.
   */
  stateOf<K extends keyof SessionProjectionStateMap>(session: Session, key: K): SessionProjectionStateMap[K] | undefined;
  /**
   * One consistent cut over every registered client-visible unit for one session, read from
   * the watermark cache (missing cells fold lazily over the in-memory log).
   * Fully synchronous — every value and `asOfSeq` reflect the same log
   * position. Each value passes its unit's `viewSchema` before leaving.
   * @param session - the session whose projection values are read.
   * @param keys - optional client-visible outputs; state materialization remains complete.
   * @returns the snapshot; `values` is empty when no selected client-visible unit is registered.
   */
  snapshot(session: Session, keys?: readonly Extract<keyof SessionProjectionMap, string>[]): ProjectionSnapshot;
  /**
   * Read only already-materialized client-visible cells without folding history.
   * Values may trail the live Session and are therefore hints, not a complete
   * baseline. Missing cells are omitted.
   * @param session - attached Session whose cached cells are inspected.
   * @param keys - optional wire keys to view.
   * @returns the lowest common cached cut, or `undefined` when no wire cell exists.
   */
  cachedSnapshot(session: Session, keys?: readonly Extract<keyof SessionProjectionMap, string>[]): ProjectionSnapshot | undefined;
  /**
   * State-level checkpoint of every persisted unit for one session, read
   * from the watermark cache (missing cells fold lazily over the in-memory
   * log). This is the write side of the persisted projection cache: the
   * returned rows are the `(key → {ver, seq, val})` part of the durable
   * `(sessionId, key, ver, seq, val)`
   * rows. Every `val` is a DETACHED structured clone — never the live
   * cell reference: the watermark cache is this registry's authoritative
   * mutable state, and a caller reaching the live reference could corrupt
   * every subsequent snapshot and frame through it (plain JSON by the unit
   * contract, so the clone is total).
   * @param session - the session whose unit states are checkpointed.
   * @returns one row per registered key.
   */
  checkpoint(session: Session): ProjectionCheckpoint;
  /**
   * The stored seq a {@link restore} tail read over `checkpoint` must start
   * at: one event BELOW the lowest usable watermark (a row is usable when
   * its `ver` matches the live unit's `stateVersion`; an absent or mismatched row
   * pulls the floor to `0` — that key must refold the full log). The
   * one-below anchor is load-bearing: the tail then proves how far the
   * stored log still extends, so {@link restore} can detect a log that
   * shrank below a row's watermark (crash-repair truncation) instead of
   * serving the stale row as current — an empty tail read from the anchor
   * yields an end below every watermark and the restore rejects for a full
   * re-read.
   * @param checkpoint - persisted rows for one session (possibly stale or empty).
   * @returns the offset for the stored-log suffix read (`SessionHandle.read`),
   *   or `undefined` when no unit is registered (no read needed —
   *   {@link restore} would serve empty values regardless).
   */
  restoreFloor(checkpoint: ProjectionCheckpoint): SessionLogOffset | undefined;
  /**
   * View a checkpoint's rows without any log read: for every registered
   * client-visible unit whose row's `ver` matches, serve the schema-validated
   * `view` of the schema-validated stored state; mismatched, malformed, or absent rows leave their key
   * absent (a cold or listing consumer treats it as not-yet-available and a
   * fuller read path refolds it). The zero-I/O rung of the read ladder —
   * values are as stale as their rows, never wrong.
   * @param checkpoint - persisted rows for one session (possibly stale or empty).
   * @param keys - optional wire keys to view.
   * @returns whole values per key with a usable row; empty when none.
   */
  viewCheckpoint(checkpoint: ProjectionCheckpoint, keys?: readonly Extract<keyof SessionProjectionMap, string>[]): Partial<SessionProjectionMap>;
  /**
   * Cold read: fold every persisted unit over a stored log suffix, seeding
   * each from its checkpoint row when usable — the one read recipe (cached
   * state + forward tail replay + `view`) applied without a live `Session`.
   * Call with the stored events at or past `restoreFloor(checkpoint)` (a
   * `SessionHandle.read` slice) and that same floor as
   * `baseSeq`; the floor's one-below anchor makes the supplied end honest,
   * so a shrunk log is detected here. A row is usable iff its
   * `ver` matches the live unit's `stateVersion`, it does not predate `baseSeq`
   * (`seq >= baseSeq - 1`), and it does not claim events past the
   * supplied end (`seq <= endSeq`); an unusable row is discarded
   * and its key refolds from `init` — which is only sound over the full
   * log, so a discarded row with `baseSeq > 0` throws (the caller re-reads
   * from seq 0, e.g. after a crash-repair truncation shrank the log below
   * a row's watermark).
   * @param checkpoint - persisted rows for one session (possibly stale or empty).
   * @param events - the stored events with `seq >= baseSeq`, in seq order.
   * @param baseSeq - the seq `events` starts at (its first event's seq when non-empty).
   * @param header - immutable metadata for the Session being restored.
   * @param inheritedEventCount - exact fork-inherited prefix length supplied to unit initialization.
   * @returns the snapshot cut at the supplied log end (`asOfSeq` is the last
   *   supplied event's seq, `baseSeq - 1` for an empty tail) plus the
   *   refreshed checkpoint rows at that cut, ready for a durable write-back.
   */
  restore(checkpoint: ProjectionCheckpoint, events: readonly SessionEvent[], baseSeq: SessionLogOffset, header: SessionHeader, inheritedEventCount: SessionLogOffset): {
    snapshot: ProjectionSnapshot;
    checkpoint: ProjectionCheckpoint;
  };
  /**
   * Restore an exact cut and install its states on the supplied prepared Session.
   * A later publication reuses these cells; ordinary live reads and event drive
   * advance any constructor-owned suffix exactly once.
   * @param session - exact prepared Session that owns the restored log prefix.
   * @param checkpoint - persisted rows for this Session lifecycle.
   * @param events - exact events at the observation cut.
   * @param baseSeq - first supplied event sequence.
   * @returns all projection values at the supplied cut.
   */
  hydrate(session: Session, checkpoint: ProjectionCheckpoint, events: readonly SessionEvent[], baseSeq: SessionLogOffset): ProjectionSnapshot;
  /** Materialize every registered unit cell at the Session's current cursor. */
  private materializeCells;
  /** Fold one unit from init over `events`, producing a cell watermarked at the last folded event. */
  private buildCell;
  /** Read (or lazily build, folding the full in-memory log) one unit's cell. */
  private cellFor;
  /** Advance one existing cell through a contiguous Session prefix. */
  private advanceCell;
  /** Eager drive: pass one committed event through every unit; notify on changed raw view references. */
  private drive;
  /** Return one schema-validated wire value. */
  private viewCell;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session-query@0.1.5-rc.2_2014ad72456bc3b90c04c603b2bf92c4/node_modules/@deepseek-ai/dsh-session-query/lib/types/observation.d.ts
/** One exact immutable Session cut retained for the caller's read lifetime. */
interface SessionObservation extends Disposable {
  /** Whether the cut came from an attached Session or a retained preparation. */
  readonly source: 'live' | 'prepared';
  /** Immutable Session identity metadata. */
  readonly header: SessionHeader;
  /** Exact fork-inherited event count paired with {@link header}. */
  readonly inheritedEventCount: SessionLogOffset;
  /**
   * Immutable contiguous events at {@link cursor}. A live observation
   * materializes this array on first read, so a consumer that reads only the
   * header, cursor, or projections never copies the log.
   */
  readonly events: readonly SessionEvent[];
  /** Last observed event seq, or -1 for an empty log. */
  readonly cursor: SessionSeqCursor;
  /** Durable source revision for a cold prepared observation. */
  readonly revision?: SessionPersistenceRevision;
  /** Exact projection baseline at {@link cursor}, when the registry is mounted. */
  readonly projections?: ProjectionSnapshot;
  /**
   * Retain the same immutable cut for another Host owner.
   * @returns an independently disposable lease over this observation.
   */
  retain(): SessionObservation;
}
/** Projection work and cancellation requested for one exact observation. */
interface SessionObservationOptions {
  /** Optional cancellation while resolving a cold source. */
  readonly signal?: AbortSignal;
  /** Whether to compute every projection or leave projection state untouched. */
  readonly projectionMode?: 'all' | 'none';
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session-query@0.1.5-rc.2_2014ad72456bc3b90c04c603b2bf92c4/node_modules/@deepseek-ai/dsh-session-query/lib/types/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionQuery: SessionQueryEngine;
  }
}
/**
 * Unified live-preferred session query service.
 *
 * Exact reads, filters, and traces are backend-independent concrete behavior.
 * A backend implements full-text observation, reconciliation, ranking, cursor
 * generations, and query execution on the same `ctx.sessionQuery` service.
 */
declare abstract class SessionQueryEngine extends Service {
  static inject: string[];
  private readonly _readWindowMax;
  private readonly _corpus;
  private readonly _observations;
  constructor(ctx: Context, config?: Config$1);
  /**
   * Observe one exact live or prepared Session without a persistence listing preflight.
   * @param sessionId - logical Session identity.
   * @param options - cancellation and projection selection for this read.
   * @returns a caller-owned observation lease.
   */
  observeSession(sessionId: SessionId, options?: SessionObservationOptions): Promise<SessionObservation>;
  /**
   * Search the live-preferred logical corpus and group by session.
   * @param request - query text, metadata filters, page size, and cursor.
   * @param exec - optional cancellation control.
   * @returns session hits ranked by their strongest matching event.
   */
  abstract searchSessions(request: SessionSearchRequest, exec?: SessionSearchExecContext): Promise<SessionSearchPage<SessionSearchHit>>;
  /**
   * Search events within one live-preferred logical session.
   * @param request - target session, query text, filters, page size, and cursor.
   * @param exec - optional cancellation control.
   * @returns matching event hits and their target header from one indexed generation.
   */
  abstract searchEvents(request: SessionEventSearchRequest, exec?: SessionSearchExecContext): Promise<SessionEventSearchPage>;
  /**
   * List the complete logical corpus using live-preferred records.
   * @param signal - optional cancellation for persistence listing.
   * @returns deterministic newest-first cloned session records.
   */
  listSessions(signal?: AbortSignal): Promise<SessionRecord[]>;
  /**
   * Read and replay-validate one complete logical session log without making it live.
   * @param sessionId - live or persisted session id to read.
   * @returns cloned header and complete raw event log from one observation.
   * @throws when persistence, header compatibility, or replay validation fails.
   */
  readSession(sessionId: SessionId): Promise<SessionLogSnapshot>;
  /**
   * Filter the complete logical corpus with provider-independent predicates.
   * @param filters - ANDed session metadata and availability clauses.
   * @param signal - optional cancellation for persistence listing.
   * @returns matching cloned records in deterministic newest-first order.
   */
  filterSessions(filters: readonly SessionResultFilter[], signal?: AbortSignal): Promise<SessionRecord[]>;
  /**
   * Fold the latest log-backed title from one live-preferred logical session.
   * @param sessionId - live or persisted session id to read.
   * @param signal - optional cancellation for source resolution and title folding.
   * @returns latest title snapshot, or `undefined` when the log has no title event.
   */
  readTitle(sessionId: SessionId, signal?: AbortSignal): Promise<SessionTitleSnapshot | undefined>;
  /**
   * Fold the latest title and return its source header from one corpus observation.
   * @param sessionId - live or persisted session id to read.
   * @param signal - optional cancellation for source resolution and title folding.
   * @returns cloned source header and optional latest title snapshot.
   */
  readTitleSnapshot(sessionId: SessionId, signal?: AbortSignal): Promise<SessionTitleObservation>;
  /**
   * Fold titles for unique sessions from one cancellable corpus observation.
   *
   * Results preserve first-occurrence input order. Operational failures stay
   * isolated per session, while cancellation rejects the complete operation.
   * @param sessionIds - live or persisted session ids to observe.
   * @param signal - optional cancellation shared by all source reads.
   * @returns one fulfilled or rejected result per unique requested id.
   */
  readTitleSnapshots(sessionIds: readonly SessionId[], signal?: AbortSignal): Promise<SessionTitleObservationResult[]>;
  /**
   * List lightweight raw-log event records for one logical session.
   * @param sessionId - live-preferred session id to read.
   * @returns event records in ascending seq order.
   */
  listEvents(sessionId: SessionId): Promise<SessionEventRecord[]>;
  /**
   * Scan first-party semantic event documents with provider-independent filters.
   * @param sessionId - live-preferred session id to scan.
   * @param filters - ANDed metadata and literal-text predicates.
   * @returns matching semantic documents in ascending seq order.
   */
  filterEvents(sessionId: SessionId, filters: readonly SessionEventResultFilter[]): Promise<SessionEventSearchDocument[]>;
  private _filterSessions;
  private _filterEvents;
  /**
   * Read one session's complete current model surface from one corpus observation.
   * @param sessionId - live-preferred session id to read.
   * @returns cloned header, current surface, and the last sequence number included in the raw-log capture.
   * @throws when source resolution fails or the session surface is invalid.
   */
  readSurface(sessionId: SessionId): Promise<SessionSurfaceSnapshot>;
  /**
   * Trace known ancestry and descendants from one corpus observation.
   * @param sessionId - logical session id to trace.
   * @param signal - optional cancellation for persistence listing.
   * @returns a complete lineage or the first parent that could not be resolved.
   * @throws when corpus resolution fails, the target is absent, or its known ancestry cycles.
   */
  traceSession(sessionId: SessionId, signal?: AbortSignal): Promise<SessionLineageTrace>;
  /**
   * Trace one event's direct positional replacements and cited source events.
   * @param request - target session id and event seq.
   * @param signal - optional cancellation for persisted source resolution.
   * @returns source header, direct links, and the target's positional replacement chain.
   * @throws when source resolution fails, the target is absent, or surface/source-event validation fails.
   */
  traceEvent(request: SessionEventTraceRequest, signal?: AbortSignal): Promise<SessionEventTraceObservation>;
  /**
   * Read one full event plus a bounded raw-log context window.
   * @param request - target session/seq and context sizes.
   * @param signal - optional cancellation for persisted source resolution.
   * @returns cloned target and neighboring events.
   */
  readEvent(request: SessionEventReadRequest, signal?: AbortSignal): Promise<SessionEventWindow>;
  private _readEvent;
  private _readWindow;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-api-session-controller@0.1.5-rc.2_f6abae79571f790534db48922cafdc73/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/agent.d.ts
/** Failures produced while resolving one ordinary Session identity to its live Agent. */
type ApiSessionAgentError = RemoteError<'session/not-found' | 'session/agent-busy' | 'gateway/internal'>;
/** Result of resolving one ordinary Session identity to its live Agent. */
type ApiSessionAgentResult = {
  readonly agent: Agent;
} | {
  readonly error: ApiSessionAgentError;
};
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-file-reference@0.1.5-rc.2_@deepseek-ai+cordis@4.0.2_@deepseek-ai+dsh-a_a75a825149094c14f94307dc05d8221c/node_modules/@deepseek-ai/dsh-file-reference/lib/types/types.d.ts
/**
 * Public file-reference discovery records. This module contains types only so
 * generated Remote clients can consume it without Host runtime code.
 * @module @deepseek-ai/dsh-file-reference/types
 */
/** One path-only completion candidate inside the target session cwd. */
interface FileReferenceCandidate {
  /** User-facing path accepted by normal prompts and filesystem tools. */
  path: string;
  /** Directories keep completion open; files finish the mention. */
  kind: 'file' | 'directory';
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-api-session-controller@0.1.5-rc.2_f6abae79571f790534db48922cafdc73/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/file-references.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `fileReferences` Remote namespace. */
    sessionFileReferences: SessionFileReferences;
  }
}
/** Host Remote adapter over the composed file-reference provider. */
declare class SessionFileReferences extends TypertRemoteService {
  static inject: string[];
  /** @param ctx - Host context carrying the selected file-reference provider. */
  constructor(ctx: Context);
  /**
   * List file and directory candidates for one Agent's working directory.
   * @param agent - target Agent resolved from the Session identity on the wire.
   * @param query - path text following `@` or `@"`.
   * @param signal - caller cancellation.
   * @returns deterministic path-only candidates from the composed provider.
   */
  list(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]>;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-api-session-controller@0.1.5-rc.2_f6abae79571f790534db48922cafdc73/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/skill-catalog.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the Session-addressed `skills` Remote namespace. */
    sessionSkillCatalog: SessionSkillCatalog;
  }
}
/** Host service backing `ctx.remote.skills` without activating a cold Agent. */
declare class SessionSkillCatalog extends TypertRemoteService {
  static inject: string[];
  /** @param ctx - Host context carrying Session reads and optional skill/preset services. */
  constructor(ctx: Context);
  /**
   * List the user-invocable skills visible to one Session composition.
   * @param request - Session identity whose cwd and preset select the catalog view.
   * @param signal - caller lifetime carried by the Remote transport; admitted catalog reads retain their existing completion semantics.
   * @returns user-invocable skill metadata without loading skill bodies.
   * @throws RemoteError when the Session cannot be inspected or no registry can serve it.
   */
  list(request: SkillListRequest, signal: AbortSignal): Promise<SkillListValue>;
  /** Resolve a live or standing preset scope without creating an Agent. */
  private scopeFor;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-api-session-controller@0.1.5-rc.2_f6abae79571f790534db48922cafdc73/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Session business API and Remote namespace owner. */
    sessionController: SessionController;
  }
}
/** Session Controller deployment policy. */
interface Config {
  /** Override platform desktop-opener detection. */
  readonly nativeOpen?: boolean;
}
/** Host integrations replaceable by direct unit tests. */
interface SessionControllerInternals {
  /** Native default-application handoff. */
  readonly openPath?: (path: string, signal: AbortSignal) => Promise<void>;
  /** Native file-manager handoff. */
  readonly revealPath?: (path: string, signal: AbortSignal) => Promise<void>;
  /** Native handoff availability probe. */
  readonly canOpenPath?: () => boolean;
}
/** Host service backing the generated `ctx.remote.session` namespace. */
declare class SessionController extends TypertRemoteService {
  static inject: string[];
  static Config: Schema<Config>;
  private readonly agents;
  private readonly commands;
  private readonly controlState;
  private readonly history;
  private readonly listState;
  private readonly openPath;
  private readonly revealPath;
  private readonly canOpenPath;
  private readonly promotions;
  /**
   * @param ctx - Host context containing the Session capability assembly.
   * @param config - native-opener deployment policy.
   * @param internals - host integrations replaceable by direct unit tests.
   */
  constructor(ctx: Context, config: Config, internals?: SessionControllerInternals);
  private promote;
  /**
   * Resolve or resume one ordinary Session for another Host API domain.
   * @param sessionId - Session identity whose Agent owns the operation.
   * @returns the live Agent or the stable Session-domain failure.
   */
  resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult>;
  /**
   * Inspect one attached or persisted Session without activating its Agent.
   * @param sessionId - durable Session identity.
   * @param signal - optional caller cancellation for persistence reads.
   * @returns the current attached state or persisted header and event prefix.
   */
  inspect(sessionId: SessionId, signal?: AbortSignal): Promise<SessionInspection>;
  /**
   * Read all visible Session rows without resuming an Agent.
   * @param _request - reserved empty list request.
   * @param signal - cancellation for persistence reads.
   * @returns visible Session summaries ordered by activity.
   */
  list(_request: SessionListRequest, signal: AbortSignal): Promise<SessionListValue>;
  /**
   * Search visible Session content without resuming an Agent.
   * @param request - literal message-content query.
   * @param signal - cancellation for list and search reads.
   * @returns authorized bounded Session search results.
   */
  search(request: SessionSearchRequest$1, signal: AbortSignal): Promise<SessionSearchValue>;
  /**
   * Create or idempotently adopt one ordinary Session.
   * @param request - requested identity, location, and Agent preset.
   * @returns the Session identity and resolved preset when configured.
   */
  create(request: SessionCreateRequest): Promise<SessionCreateValue>;
  /**
   * Select one Session-local model after explicitly resuming the Session.
   * @param request - Session identity and requested model selection.
   * @returns the normalized selection installed for the Session.
   */
  selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue>;
  /**
   * Describe every currently routable model for Host-generation selectors.
   * @returns provider-grouped models, the deployment default, and isolated provider failures.
   */
  modelCatalog(): Promise<ModelCatalog>;
  /**
   * Report whether this deployment can hand a Session workspace path to a native desktop.
   * @returns true when the matching open operation is available.
   */
  canOpenWorkspacePath(): boolean;
  /**
   * Describe the serving desktop for authenticated file-action routes.
   * @returns Host name, configured availability, and platform-specific file-manager behavior.
   */
  workspaceDesktop(): {
    name: string;
    available: boolean;
    fileManager: 'finder' | 'explorer' | 'directory' | null;
  };
  /**
   * Open one path prepared by a Session-aware caller on the Host desktop.
   * @param request - path after best-effort Session workspace resolution.
   * @param signal - caller lifetime; abort terminates the native command.
   * @returns confirmation after the native opener accepts the path.
   * @throws RemoteError when the request is invalid, cancelled, or the opener fails.
   */
  openWorkspacePath(request: SessionOpenWorkspacePathRequest, signal: AbortSignal): Promise<SessionOpenWorkspacePathValue>;
  /**
   * Rename one Session after explicitly resuming it.
   * @param request - Session identity and proposed title.
   * @returns the accepted title and durable event sequence.
   */
  rename(request: SessionRenameRequest): Promise<SessionRenameValue>;
  /**
   * Fork one cold-readable completed-turn prefix into a new Session.
   * @param request - source Session and optional event anchor.
   * @returns the new Session identity.
   */
  fork(request: SessionForkRequest): Promise<SessionForkValue>;
  /**
   * Admit one prompt after explicitly resuming its Session.
   * @param request - Session identity, prompt content, source metadata, and delivery mode.
   * @param signal - caller cancellation before prompt admission begins.
   * @returns acknowledgement that the Agent accepted the prompt.
   */
  prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>;
  /**
   * Read one image proven reachable from the addressed Session log.
   * @param request - Session and attachment identities used for authorization.
   * @returns the durable attachment reference and base64-encoded bytes.
   */
  attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue>;
  /**
   * Mutate one still-pending queue occurrence on a live Agent.
   * @param request - Session, queue item, and requested mutation.
   * @returns acknowledgement that the queue mutation was applied.
   */
  updateQueue(request: SessionUpdateQueueRequest): SessionUpdateQueueValue;
  /**
   * Cancel one active Agent turn without dropping its pending inbox.
   * @param request - Session whose active Agent turn is cancelled.
   * @returns acknowledgement that cancellation was requested.
   */
  cancel(request: SessionCancelRequest): SessionCancelValue;
  /**
   * Read one cold-safe, message-aligned Session history page.
   * @param request - durable address, backward cursor, and page budget.
   * @param signal - cancellation for persistence reads.
   * @returns one chronological page.
   */
  page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage>;
  /**
   * Follow one Session log from its opening or resume cursor.
   * @param request - durable address and last committed sequence already held by the caller.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns a complete opening snapshot followed by gap-free durable event
   *   frames and optional cursorless assistant-stream frames.
   */
  follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame>;
  /**
   * Stream a complete live-control baseline followed by replacement frames.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns one complete baseline followed by live replacement frames.
   */
  control(signal: AbortSignal): AsyncIterable<SessionControlFrame>;
}
//#endregion
//#region src/bridge/rpc.d.ts
/** Shape the bridge history readers consume (pre-0.1.2 convention). */
interface BridgeHistory {
  events: HistoryEntry[];
  hasMore: boolean;
  projections?: SessionProjectionsBlock;
}
/**
 * The dsh 0.1.2 host API surface the bridge actually consumes. Each field is
 * the host-side Cordis service that owns the @Remote business methods; the
 * bridge calls them in-process (no gateway, no browser transport).
 */
interface BridgeApi {
  /** Router-installed durable address resolver for direct subagent history. */
  sessionAddress?: (sessionId: string) => SessionAddress;
  sessionController: Pick<SessionController, 'list' | 'search' | 'create' | 'selectModel' | 'modelCatalog' | 'rename' | 'fork' | 'prompt' | 'cancel' | 'page' | 'follow' | 'control' | 'resolveAgent'> & {
    /**
     * Optional bridge-level history contract used by unit fixtures. Real hosts
     * omit it; `call('session.history')` then reads through follow/page.
     */
    history?: (request: {
      sessionId?: string;
      maxMessages?: number;
      beforeSeq?: number;
    }, signal?: AbortSignal) => Promise<BridgeHistory>;
    /**
     * Optional bridge-level session-model read used by unit fixtures. Real
     * hosts omit it; `call('session.models')` then derives from modelCatalog.
     */
    models?: (request: {
      sessionId?: string;
    }) => Promise<{
      current: {
        provider: string;
        model: string;
        reasoningEffort?: string;
      };
    }>;
  };
  agentPresets: {
    list(): Promise<Array<{
      id: string;
      name?: string;
      description?: string;
      broken?: string;
    }>>;
    select(agent: Agent, agentPreset: string): Promise<string>;
    defaultId: string;
  };
  goals: {
    create(agent: Agent, request: unknown): Promise<unknown>;
    edit(agent: Agent, ref: unknown, request: unknown): Promise<unknown>;
    pause(agent: Agent, ref: unknown): Promise<unknown>;
    resume(agent: Agent, ref: unknown): Promise<unknown>;
    complete(agent: Agent, ref: unknown): Promise<unknown>;
    clear(agent: Agent, ref: unknown): Promise<unknown>;
  };
  sessionSkillCatalog: {
    list(request: unknown, signal?: AbortSignal): Promise<unknown>;
  };
  /**
   * dsh human-command registry (`ctx.commands`). Optional so unit fixtures and
   * older hosts without the registry still type-check; the oc profile always
   * mounts it through dsh-base.
   */
  commands?: BridgeCommands;
  /** Live agent registry (`ctx.agents`), used to address `/compact`. */
  agents?: BridgeAgents;
  /** Host object layers injected by dsh-base; kept for ABI validation. */
  sessions?: unknown;
  sessionProjections?: unknown;
}
/** Structural view of `@deepseek-ai/dsh-commands` CommandExecution. */
interface BridgeCommandExecution {
  commandId: unknown;
  result: {
    kind: 'success' | 'error';
    text?: string;
  };
}
interface BridgeCommands {
  execute(agent: unknown, line: string, images: readonly unknown[], signal: AbortSignal): Promise<BridgeCommandExecution | undefined>;
}
interface BridgeAgents {
  get(sessionId: string): unknown;
}
//#endregion
//#region src/bridge/convert/message.d.ts
interface V1MessageEntry {
  info: Message;
  parts: Part[];
}
//#endregion
//#region src/bridge/convert/permission.d.ts
interface PermissionEntry {
  opencodeId: string;
  rpcId: string;
  sessionId: string;
  approvalId: string;
  toolName: string;
  callId?: string;
  reason?: string;
}
//#endregion
//#region src/bridge/convert/question.d.ts
interface QuestionEntry {
  opencodeId: string;
  rpcId: string;
  sessionId: string;
  items: AskUserQuestionItem[];
}
//#endregion
//#region src/bridge/state.d.ts
/** A memory-scoped "always" grant for one session + tool. */
interface SavedPermission {
  sessionId: string;
  toolName: string;
  grantedAt: number;
}
/** One cached history page (tail or bounded by limit/beforeSeq). */
interface CachedHistory {
  events: HistoryEntry[];
  hasMore: boolean;
  projections?: SessionProjectionsBlock;
}
/** One user-visible message sitting in a dsh pending inbox queue. */
interface QueuedInboxMessage {
  id: string;
  rpcId?: string;
  /** dsh `UserMessage` content blocks (only text blocks are rendered). */
  content: readonly unknown[];
  source: {
    kind: string;
  };
  /** When the message entered the queue (splice event time). */
  enqueuedAt: number;
}
/** dsh inbox queue state mirrored by the bridge for opencode display. */
interface InboxProjection {
  nextTurn: QueuedInboxMessage[];
  nextStep: QueuedInboxMessage[];
}
interface InboxSpliceOutcome {
  added: QueuedInboxMessage[];
  removed: QueuedInboxMessage[];
}
/** One dsh delegation waiting for its session-backed child identity. */
interface SubagentCallRecord {
  parentSessionId: string;
  callId: string;
  toolName: string;
  arguments: string;
  messageId: string;
  description: string;
  prompt: string;
  subagentType: string;
  background?: boolean;
  turn?: number;
  step?: number;
  createdAt: number;
  childSessionId?: string;
  childMode?: 'one-shot' | 'continuable';
  /** Whether the parent Task part has already reached the SSE stream. */
  partEmitted?: boolean;
  /** Terminal result retained so a late child association cannot regress it. */
  resultStatus?: 'completed' | 'error';
  resultTime?: number;
  resultContent?: readonly unknown[];
  resultError?: {
    name?: string;
    code?: string;
  };
}
/** Durable/live facts learned for one dsh subagent child. */
interface SubagentChildRecord {
  sessionId: string;
  parentSessionId: string;
  label?: string;
  mode?: 'one-shot' | 'continuable';
  title?: string;
  agent?: string;
  cwd?: string;
  addedAt: number;
  /** Host lifecycle arrival may use parent-local FIFO before descriptor data. */
  allowFifo?: boolean;
}
/**
 * In-memory correlation maps between opencode-facing request ids and the dsh
 * rpcIds/approval ids that answer them. Populated from the mux stream; the
 * HTTP reply routes read it back.
 */
declare class InteractionState {
  readonly permissions: Map<string, PermissionEntry>;
  readonly questions: Map<string, QuestionEntry>;
  readonly byApprovalId: Map<string, string>;
  readonly byQuestionRpcId: Map<string, string>;
  readonly sessionDirectories: Map<string, string>;
  readonly sessionParents: Map<string, string>;
  readonly sessionAddressModes: Map<string, "continuable" | "one-shot">;
  /** Sessions whose durable origin is the dsh subagent seam. */
  readonly sessionOrigins: Set<string>;
  /** Pending/associated dsh delegation calls, keyed by parent + call id. */
  readonly subagentCalls: Map<string, SubagentCallRecord>;
  /** Child records learned from api-session/added, projection, or summaries. */
  readonly subagentChildren: Map<string, SubagentChildRecord>;
  /** Descriptor facts that can precede the host lifecycle summary. */
  readonly subagentDescriptorFacts: Map<string, Pick<SubagentChildRecord, "label" | "mode">>;
  /** Child additions that arrived before their parent tool/call was translated. */
  readonly pendingSubagentChildren: Map<string, SubagentChildRecord[]>;
  /** Authoritative live Agent state mirrored from dsh api-session/status. */
  readonly sessionRunning: Map<string, boolean>;
  /** Last status/activity observation used for reconnect diagnostics. */
  readonly sessionStatusUpdatedAt: Map<string, number>;
  /** Last realtime status edge broadcast to connected SSE clients. */
  private readonly sessionStatusBroadcast;
  readonly savedPermissions: Map<string, SavedPermission>;
  /** Last explicit model selection (with variant) per session, for self-heal. */
  readonly sessionModelSelections: Map<string, {
    providerID: string;
    modelID: string;
    variant?: string;
  }>;
  /** Real durable titles learned from history projections / title events. */
  readonly sessionTitles: Map<string, string>;
  /** Last known agent preset per session (survives title/projection updates). */
  private readonly sessionAgents;
  /** One stale editor-agent value to suppress after an explicit /preset switch. */
  private readonly stalePresetPrompts;
  /** Recent bridge-only command result cards retained for history hydration. */
  private readonly recentCommandResults;
  /** User shell executions currently owned by this bridge session. */
  private readonly shellControllers;
  /** In-flight shell maintenance promises, awaited during bridge teardown. */
  private readonly shellPromises;
  /** Sessions removed by the host while a shell callback is still draining. */
  private readonly clearedSessions;
  /** Mirror of each session's dsh pending inbox (next-turn / next-step). */
  readonly inboxProjections: Map<string, InboxProjection>;
  /** Message ids already surfaced to the TUI as queued user messages. */
  readonly presentQueuedIds: Set<string>;
  /** dsh user message ids already echoed by the prompt route (broadcast). */
  private readonly broadcastDshIds;
  /** TUI-generated `messageID`s from prompt submissions, FIFO per session. */
  private readonly promptMessageIds;
  /** Original optimistic-card timestamp, keyed by the TUI prompt id. */
  private readonly promptMessageTimes;
  /** dsh user message id -> TUI prompt id (kept so history echoes match). */
  private readonly dshPromptMessageIds;
  /** Bridge-generated assistant message ids keyed by user message id. */
  private readonly assistantIdsByUser;
  /** dsh assistant message id -> bridge assistant id (history echo match). */
  private readonly dshAssistantIds;
  /** Canonical live-card timestamp keyed by the bridge assistant id. */
  private readonly assistantMessageTimes;
  /** Assistant cards whose turn/tool step is still live. */
  private readonly pendingAssistantIds;
  sessionListCache?: {
    items: SessionSummary[];
    at: number;
  };
  /** In-flight session.list RPC shared by concurrent callers (incl. prefetch). */
  sessionListLoading?: Promise<SessionSummary[]>;
  private sessionListGeneration;
  /** One bounded cold seed for the status endpoint; never retry in a poll loop. */
  sessionStatusSeedAttempted: boolean;
  sessionStatusSeeded: boolean;
  sessionStatusLoading?: Promise<void>;
  /** Lightweight counters used to prove the status poll has no list storm. */
  sessionStatusRequests: number;
  sessionStatusSeeds: number;
  sessionListRpcCalls: number;
  /** Whether this bridge run accepted new user input (banner-bearing content). */
  newInputDuringRun: boolean;
  /** The session the TUI most recently created/resumed/opened. */
  currentSessionId?: string;
  /** Last agent preset selected during this run (inherited by new sessions). */
  lastAgentPreset?: string;
  readonly historyCache: Map<string, {
    value: CachedHistory;
    at: number;
  }>;
  private readonly historyLoading;
  private readonly historyGenerations;
  private static subagentCallKey;
  private static subagentChildMatchesCall;
  private attachSubagentChild;
  private matchPendingChildForCall;
  /** Register a parent tool call and attach any child that arrived first. */
  registerSubagentCall(call: SubagentCallRecord): SubagentCallRecord;
  /** Return a registered dsh delegation call, if any. */
  subagentCallFor(parentSessionId: string, callId: string): SubagentCallRecord | undefined;
  /** Return the child associated with one parent tool call, if known. */
  subagentChildForCall(parentSessionId: string, callId: string): SubagentChildRecord | undefined;
  /**
   * Bind a historical delegation to one unclaimed child from the same parent.
   * Labels are authoritative when present; otherwise durable child creation
   * order is the only stable local signal. Persisting the binding means v1
   * and v2 hydration (and repeated page reads) cannot reuse the first child.
   */
  bindSubagentCallForHistory(call: SubagentCallRecord): SubagentChildRecord | undefined;
  /**
   * Associate one host/session-added or projection-derived child. The child
   * may arrive before the parent's tool/call event reaches the translator.
   * Label equality wins; otherwise parent-local FIFO is deterministic.
   */
  associateSubagentChild(child: SubagentChildRecord): SubagentCallRecord | undefined;
  /** Enrich a previously associated child with descriptor/projection facts. */
  enrichSubagentChild(sessionId: string, update: Partial<Pick<SubagentChildRecord, 'label' | 'mode' | 'title' | 'agent' | 'cwd'>>): SubagentCallRecord | undefined;
  /** Store descriptor/projection identity even before host/session-added. */
  recordSubagentDescriptor(sessionId: string, update: Pick<SubagentChildRecord, 'label' | 'mode'>): SubagentCallRecord | undefined;
  /** Whether a session is a durable subagent child. */
  isSubagentSession(sessionId: string): boolean;
  recordCommandResult(sessionId: string, entry: V1MessageEntry): void;
  /** Insert or replace one bridge-only card (used by running shell history). */
  upsertCommandResult(sessionId: string, entry: V1MessageEntry): void;
  commandResultsFor(sessionId: string): readonly V1MessageEntry[];
  /** Register one shell cancellation controller and return its disposer. */
  trackShellController(sessionId: string, controller: AbortController): () => void;
  trackShellPromise(sessionId: string, promise: Promise<unknown>): () => void;
  /** Abort only shell executions owned by this exact session. */
  abortShell(sessionId: string): boolean;
  abortAllShells(): void;
  waitForShells(timeoutMs?: number): Promise<void>;
  markSessionPresent(sessionId: string): void;
  isSessionCleared(sessionId: string): boolean;
  getSessionListCache(ttlMs: number): SessionSummary[] | undefined;
  setSessionListCache(items: SessionSummary[]): void;
  getHistoryCache(key: string, ttlMs: number): CachedHistory | undefined;
  setHistoryCache(key: string, value: CachedHistory): void;
  getHistoryLoading(key: string): Promise<CachedHistory> | undefined;
  setHistoryLoading(key: string, promise: Promise<CachedHistory>): void;
  clearHistoryLoading(key: string, promise: Promise<CachedHistory>): void;
  historyGeneration(key: string): number;
  listGeneration(): number;
  setSessionRunning(sessionId: string, running: boolean, updatedAt?: number): void;
  sessionRunningFor(sessionId: string): boolean | undefined;
  sessionStatusUpdatedAtFor(sessionId: string): number | undefined;
  /**
   * Claim one live session.status edge for broadcast. dsh 0.1.2 reports the
   * same turn edge through both Session events and api-session/status; the
   * authoritative state guard also rejects an older opposite edge before it
   * can mark the session idle/busy incorrectly. SSE snapshots deliberately do
   * not use this method because every new client needs its own snapshot.
   */
  shouldBroadcastSessionStatus(sessionId: string, running: boolean): boolean;
  markSessionStatusSeeded(): void;
  markSessionActivity(sessionId: string, updatedAt: number): void;
  /** Drop list and (optionally per-session) history caches after any mutation. */
  invalidateSession(sessionId?: string): void;
  /** Drop only history pages (used by the live SSE feed). */
  invalidateHistory(sessionId?: string): void;
  private static savedKey;
  savePermission(sessionId: string, toolName: string): SavedPermission;
  savedPermissionFor(sessionId: string, toolName: string): SavedPermission | undefined;
  savedPermissionsList(): SavedPermission[];
  /** Wire id for `/api/permission/saved/{id}` (unique per session + tool). */
  savedPermissionId(saved: SavedPermission): string;
  /**
   * Remove one saved grant. Prefers the composite `sessionID:toolName` id;
   * a bare tool name is accepted for compatibility and removes the first
   * matching grant.
   */
  removeSavedPermission(id: string): boolean;
  setSessionModelSelection(sessionId: string, selection: {
    providerID: string;
    modelID: string;
    variant?: string;
  }): void;
  sessionModelSelectionFor(sessionId: string): {
    providerID: string;
    modelID: string;
    variant?: string;
  } | undefined;
  /** Per-session inbox projection, created on first touch. */
  inboxProjectionFor(sessionId: string): InboxProjection;
  private queuedKey;
  /** Whether a user message id was already surfaced as a queued card. */
  hasPresentedQueued(sessionId: string, messageId: string): boolean;
  /** Forget a presented queued id once the same message becomes durable. */
  clearPresentedQueued(sessionId: string, messageId: string): void;
  /** Remember a durable user message id already broadcast by the prompt route. */
  markBroadcastDshId(sessionId: string, dshId: string): void;
  /** Whether the durable user message was already broadcast at submission. */
  isBroadcastDshId(sessionId: string, dshId: string): boolean;
  /** Register a TUI-generated message id for the next user echo of a session. */
  registerPromptMessageId(sessionId: string, promptId: string, createdAt?: number): void;
  /** Timestamp used by the optimistic user card and its queue-state update. */
  promptMessageCreatedAt(sessionId: string, promptId: string): number | undefined;
  /** Oldest registered prompt id that has not been echoed yet, if any. */
  peekPromptMessageId(sessionId: string): string | undefined;
  /**
   * Consume the oldest prompt id for a session once its dsh user message
   * arrives; returns the surface id (prompt id when known, else the dsh id).
   */
  takePromptMessageId(sessionId: string, dshId: string): string;
  /** Map a durable dsh message id back to its TUI prompt id, if registered. */
  promptIdForDshId(sessionId: string, dshId: string): string | undefined;
  /** Reverse lookup: durable dsh id for a bridge/prompt id (user messages). */
  dshIdForPromptId(sessionId: string, promptId: string): string | undefined;
  /** Register the assistant id that will back a user turn's streamed reply. */
  registerAssistantIdForUser(sessionId: string, userId: string, assistantId: string): void;
  /** Assistant id registered for a user turn, if any. */
  assistantIdForUser(sessionId: string, userId: string): string | undefined;
  /** Timestamp that must be retained when history hydrates a live card. */
  assistantMessageCreatedAt(sessionId: string, assistantId: string): number | undefined;
  /** Record the timestamp chosen for a live assistant card. */
  setAssistantMessageCreatedAt(sessionId: string, assistantId: string, createdAt: number): void;
  markAssistantPending(sessionId: string, assistantId: string): void;
  markAssistantCompleted(sessionId: string, assistantId: string): void;
  isAssistantPending(sessionId: string, assistantId: string): boolean;
  clearPendingAssistants(sessionId: string): void;
  /** Record a dsh->bridge assistant id mapping after a streamed turn. */
  recordAssistantId(sessionId: string, dshId: string, bridgeId: string): void;
  /** Map a durable dsh assistant id back to its bridge id, if registered. */
  assistantIdForDshId(sessionId: string, dshId: string): string | undefined;
  /** Reverse lookup: durable dsh id for a bridge assistant id. */
  dshIdForAssistantId(sessionId: string, assistantId: string): string | undefined;
  /**
   * Apply one durable `agent/inbox/spliced` mutation to the mirrored queue.
   * `added` contains messages that were not yet surfaced to the TUI; `removed`
   * contains messages dropped from the queue (claim or cancellation).
   */
  applyInboxSplice(sessionId: string, target: 'next-turn' | 'next-step', start: number, removedCount: number, inserted: Array<{
    id: string;
    rpcId?: string;
    content: readonly unknown[];
    source?: {
      kind: string;
      rpcId?: string;
    };
  }>, enqueuedAt: number, outcome?: 'canceled'): InboxSpliceOutcome;
  /**
   * Initialize the inbox projection from the `session/queue` snapshot dsh
   * broadcasts when an SSE mux subscription starts. Later queue snapshots are
   * ignored: they cannot distinguish a claimed message from a cancelled one,
   * so incremental `agent/inbox/spliced` events own the live diff.
   * Returns only the messages that were not yet surfaced to the TUI.
   */
  initializeInboxProjection(sessionId: string, items: Array<{
    placement: 'queued' | 'steering' | 'context';
    rpcId?: string;
    message: {
      id: string;
      content: readonly unknown[];
      source?: {
        kind: string;
        rpcId?: string;
      };
    };
  }>, enqueuedAt: number, force?: boolean): InboxSpliceOutcome;
  setSessionTitle(sessionId: string, title: unknown): void;
  sessionTitleFor(sessionId: string): string | undefined;
  setSessionAgent(sessionId: string, agent: string): void;
  sessionAgentFor(sessionId: string): string | undefined;
  copyPresentationContextTo(target: InteractionState): void;
  markStalePresetPrompt(sessionId: string, from: string, to: string): void;
  /** Consume only the one prompt carrying the editor value from before /preset. */
  consumeStalePresetPrompt(sessionId: string, agent: string | undefined): boolean;
  /** Record that the user submitted new input during this run. */
  markInput(): void;
  setCurrentSession(sessionId: string): void;
  /** Agent-preset-lock notices already shown (dedupe per session + agent). */
  private readonly lockedAgentNotices;
  lockedAgentNoticeSeen(sessionId: string, agent: string): boolean;
  markLockedAgentNotice(sessionId: string, agent: string): void;
  private static lockedAgentKey;
  /** Pending approval decisions keyed by rpcId (answerer → HTTP reply). */
  readonly pendingApprovals: Map<string, (outcome: 'allowed-once' | 'rejected' | 'cancelled') => void>;
  /** Pending question decisions keyed by rpcId (answerer → HTTP reply). */
  readonly pendingQuestions: Map<string, (answer: unknown | undefined) => void>;
  registerApproval(entry: PermissionEntry): PermissionEntry;
  registerQuestion(entry: QuestionEntry): QuestionEntry;
  permissionByOpenCodeId(id: string): PermissionEntry | undefined;
  permissionByApprovalId(approvalId: string): PermissionEntry | undefined;
  permissionByRpcId(rpcId: string): PermissionEntry | undefined;
  questionByOpenCodeId(id: string): QuestionEntry | undefined;
  questionByRpcId(rpcId: string): QuestionEntry | undefined;
  removePermission(opencodeId: string): void;
  removeQuestion(opencodeId: string): void;
  /** Resolve and clear every in-flight answerer when the bridge stops. */
  clearPendingInteractions(): void;
  clearSession(sessionId: string): void;
  private removeSessionInteractions;
  permissionsForSession(sessionId: string): PermissionEntry[];
  questionsForSession(sessionId: string): QuestionEntry[];
}
//#endregion
//#region src/bridge/events-util.d.ts
/**
 * SSE event emitted to opencode. We deliberately carry the same payload under
 * both `properties` (the 1.18.18 TUI binary's expectation) and `data` (the
 * published `@opencode-ai/sdk@1.18.18` type), so either consumer can parse it.
 */
interface BridgeGlobalEvent {
  directory: string;
  project?: string;
  workspace?: string;
  payload: {
    id: string;
    type: string;
    properties: Record<string, unknown>;
    data: Record<string, unknown>;
  };
}
//#endregion
//#region src/bridge/events.d.ts
/**
 * dsh 0.1.5 keeps the in-flight assistant stream out of the durable log, so a
 * mid-turn history read finds no assistant at all. This snapshot exposes the
 * translator's live provisional message (id, created time, streamed blocks) so
 * the history route can merge it and keep the pre-0.1.5 contract: the last
 * assistant is present with `time.completed` unset while it streams.
 */
interface PendingAssistantSnapshot {
  id: string;
  created: number;
  parentID?: string;
  parts: Array<{
    type: 'text' | 'reasoning';
    id: string;
    text: string;
    start: number;
    end?: number;
  }>;
}
//#endregion
//#region src/bridge/sse.d.ts
interface SseClient {
  id: number;
  res: ServerResponse;
  controller: AbortController;
  closed: boolean;
  /** Optional per-connection session filter (attach `?sessionID=`). */
  filter?: (event: BridgeGlobalEvent) => boolean;
}
interface SseHubOptions {
  /** Maximum number of broadcast events retained for Last-Event-ID replay. */
  maxReplayEvents?: number;
  /** Maximum serialized wire bytes retained for Last-Event-ID replay. */
  maxReplayBytes?: number;
}
/** Registry of active SSE connections plus the encoder/cleanup logic. */
declare class SseHub {
  private log;
  private clients;
  /** Events enqueued before any client connected (raw replay mode). */
  private pending;
  private readonly replay;
  private replayBytes;
  private readonly maxReplayEvents;
  private readonly maxReplayBytes;
  private nextId;
  constructor(log: (message: string) => void, options?: SseHubOptions);
  add(res: ServerResponse, filter?: (event: BridgeGlobalEvent) => boolean): SseClient;
  remove(client: SseClient): void;
  send(client: SseClient, event: BridgeGlobalEvent): void;
  private encode;
  private sendWire;
  private remember;
  /** Replay events strictly after a known event id; return false when the id
   * is outside the bounded ring (or was never observed). */
  replayAfter(client: SseClient, lastEventId: string): boolean;
  /** Fan one event batch out to every connected SSE client. */
  broadcast(events: BridgeGlobalEvent[]): void;
  /**
   * Broadcast a batch while retaining it for the first client when the
   * bridge has not acquired an SSE subscriber yet.  Unlike calling
   * `enqueue()` followed by `broadcast()`, this remembers each event in the
   * Last-Event-ID ring exactly once.
   */
  broadcastAndBufferIfIdle(events: BridgeGlobalEvent[]): void;
  /** Broadcast now, or buffer until the first client connects. */
  enqueue(events: BridgeGlobalEvent[]): void;
  closeAll(): void;
  get size(): number;
}
//#endregion
//#region src/bridge/router.d.ts
interface BridgeRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}
interface BridgeRouteContext {
  api: BridgeApi;
  cwd: string;
  state: InteractionState;
  log(message: string): void;
  hub: SseHub;
  /**
   * dsh 0.1.5 keeps in-flight assistant chunks out of the durable log; history
   * routes call this to merge the translator's live provisional assistant so a
   * mid-turn read still exposes the streaming message (`time.completed` unset).
   */
  pendingAssistant?(sessionId: string): PendingAssistantSnapshot | undefined;
}
interface HandlerResult {
  status: number;
  body?: unknown;
  /** Raw (non-JSON) response body, written verbatim when present. */
  raw?: string | Buffer;
  headers?: Record<string, string>;
}
interface Route {
  method: string;
  pattern: string;
  kind: 'json' | 'sse';
  handler: (req: BridgeRequest, ctx: BridgeRouteContext) => Promise<HandlerResult>;
}
interface BridgeRouter {
  ctx: BridgeRouteContext;
  match(method: string, pathname: string): Route | undefined;
  startSse(req: BridgeRequest, res: ServerResponse): void;
  /** Feed one translated bridge frame to all SSE clients (host-side pump). */
  feed(frame: BridgeFrame): Promise<void>;
  /** Feed one host lifecycle frame to all SSE clients. */
  feedHostFrame(frame: BridgeHostFrame): void;
  /** Change the bridge working directory (e.g. from an attach `--dir`). */
  setCwd(directory: string): void;
  /** Warm the session-list cache in the background after startup. */
  prefetchSessionList(): void;
  /** Warm one session's tail history in the background. */
  prefetchSession(sessionId: string): void;
  /** Whether this bridge run accepted new user input. */
  hasNewActivity(): boolean;
  /** Whether the mini/full TUI exit banner is likely printed (needs a hint). */
  exitNoteNeeded(): Promise<boolean>;
}
interface RouterOptions {
  cwd?: string;
  log?: (message: string) => void;
  /** Initial SSE mux retry backoff (doubles up to 8s). */
  sseRetryBaseMs?: number;
  /** Maximum SSE mux re-subscription attempts before giving up. */
  sseRetryMaxAttempts?: number;
}
declare function createBridgeRouter(api: BridgeApi, options?: RouterOptions): BridgeRouter;
//#endregion
//#region src/bridge/http.d.ts
interface BridgeServerHandle {
  url: string;
  port: number;
  server: http.Server;
  close(): Promise<void>;
}
/**
 * Start the loopback HTTP server. `url`/`port` are available once the
 * returned promise resolves (after `listen` on 127.0.0.1:0).
 */
declare function startBridgeServer(router: BridgeRouter, options?: {
  host?: string;
}): Promise<BridgeServerHandle>;
//#endregion
export { type BridgeRouter, type BridgeServerHandle, createBridgeRouter, startBridgeServer };
//# sourceMappingURL=router-entry.d.ts.map
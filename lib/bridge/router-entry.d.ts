import { Context, Service } from "@deepseek-ai/cordis";
import http, { ServerResponse } from "node:http";
import { z } from "zod";
//#region node_modules/.pnpm/@deepseek-ai+dsh-brand@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-invariants_802f22b0cd5ecae261f195284703c30b/node_modules/@deepseek-ai/dsh-brand/lib/types/index.d.ts
/**
 * The `Branded<B>` nominal-typing primitive — a type-only utility (no runtime
 * code, no harness-package dependency) shared by every package that owns a
 * cross-boundary id.
 *
 * A brand makes structurally-identical strings non-interchangeable at the type
 * level: a `SessionId` cannot be passed where a `CallId` is expected, even
 * though both are plain strings at runtime. Construction goes through a per-id
 * factory in the OWNING package (a plain cast inside — zero runtime cost);
 * comparison, logging, and serialization all behave as ordinary strings.
 *
 * Policy: a package brands the ids it owns — `CallId` in dsh-llm (tool-call
 * correlation), the shared agent/session `SessionId` in dsh-session, and
 * `JobId` in dsh-jobs. Branding is for ids that cross package boundaries and
 * could plausibly be confused; not every string needs a brand.
 * This package owns ONLY the primitive — no concrete id, no runtime code beyond
 * the (erased) type — so the brand vocabulary stays dependency-free and a
 * package can brand its ids without depending on an unrelated capability
 * package.
 *
 * @module @deepseek-ai/dsh-brand
 */
declare const BRAND: unique symbol;
/** A string carrying a compile-time-only brand `B`. */
type Branded<B extends string> = string & {
  readonly [BRAND]: B;
};
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-attachment@0_7dd6ce73a1d47d070bd8315386fa797c/node_modules/@deepseek-ai/dsh-llm/lib/types/brand.d.ts
/** Stable identity carried by one message across inbox, log, and model-request boundaries. */
type MessageId = Branded<'MessageId'>;
/**
 * Brand a message identifier.
 * @param id - the opaque message identifier.
 * @returns the same string, branded; no validation is performed.
 */
declare function MessageId(id: string): MessageId;
/**
 * Correlates a model-issued tool call with its result. Provider-issued for
 * real adapters; synthesized by mocks/assembler fallbacks.
 */
type CallId = Branded<'CallId'>;
/**
 * Brand a string as a {@link CallId}.
 * @param id - the provider-issued (or synthesized) call id.
 * @returns the same string, branded; no validation is performed.
 */
declare function CallId(id: string): CallId;
/** Provider-issued request identifier retained for diagnostics across package boundaries. */
type ProviderRequestId = Branded<'ProviderRequestId'>;
/**
 * Brand a provider-issued request identifier.
 * @param id - the opaque provider-issued string.
 * @returns the same string, branded; no validation is performed.
 */
declare function ProviderRequestId(id: string): ProviderRequestId;
/** Adapter-owned identifier for one model's selectable reasoning effort. */
type ReasoningEffortId = Branded<'ReasoningEffortId'>;
/**
 * Brand an adapter-owned reasoning-effort identifier.
 * @param id - the opaque identifier exposed by one model capability.
 * @returns the same string, branded; no validation is performed.
 */
declare function ReasoningEffortId(id: string): ReasoningEffortId;
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-attachment@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-brand_cf2c8511ebf31e66fcfb36dac897539b/node_modules/@deepseek-ai/dsh-attachment/lib/types/brand.d.ts
/** Opaque content-addressed identifier for one immutable attachment object. */
type AttachmentId = Branded<'AttachmentId'>;
/**
 * Brand a validated storage identifier.
 * @param value - backend-produced opaque identifier.
 * @returns the branded identifier.
 */
declare function AttachmentId(value: string): AttachmentId;
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-attachment@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-brand_cf2c8511ebf31e66fcfb36dac897539b/node_modules/@deepseek-ai/dsh-attachment/lib/types/types.d.ts
/** Raster image formats accepted by the version-one attachment path. */
type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
/** Durable, serializable metadata for one immutable image object. */
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
}
/** Deployment-resolved limits used by upload admission and request buffering. */
interface ImageAttachmentLimits {
  maxImageBytes: number;
  maxImagesPerMessage: number;
  maxMessageImageBytes: number;
  maxImagePixels: number;
  mediaTypes: readonly ImageMediaType[];
}
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
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-attachment@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-brand_cf2c8511ebf31e66fcfb36dac897539b/node_modules/@deepseek-ai/dsh-attachment/lib/types/index.d.ts
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
   * Validate and durably commit one image before its owning session event is appended.
   * @param input - encoded bytes, declared media type, and optional display name.
   * @returns a durable content-addressed reference.
   */
  abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>;
  /**
   * Read one image and verify that bytes still match the recorded reference.
   * @param ref - durable reference from the session log.
   * @param signal - optional cancellation for backend read and verification work.
   * @returns the verified bytes and canonical reference.
   * @throws the signal reason when aborted, or a storage error when verification fails.
   */
  abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-attachment@0_7dd6ce73a1d47d070bd8315386fa797c/node_modules/@deepseek-ai/dsh-llm/lib/types/message.d.ts
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
  callId: CallId;
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
interface Message {
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
interface UserMessage extends Message {
  readonly role: 'user';
}
/** A model-produced assistant specialization of the shared message representation. */
interface AssistantMessage extends Message {
  readonly role: 'assistant';
  readonly source: ModelMessageSource;
}
/** A tool-result specialization whose model-facing block retains call correlation. */
interface ToolResultMessage extends Message {
  readonly role: 'user';
  readonly content: [ToolResultBlock];
  readonly source: ToolMessageSource;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-attachment@0_7dd6ce73a1d47d070bd8315386fa797c/node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts
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
 * so only user content carries images today.
 */
interface ImageBlock {
  type: 'image';
  /** Immutable bytes and intrinsic display metadata owned by the attachment service. */
  attachment: ImageAttachmentRef;
}
/** A tool invocation requested by the model. */
interface ToolCallBlock {
  type: 'tool-call';
  /** Provider-issued call id; correlates with the matching tool result. */
  id: CallId;
  name: string;
  /** Raw JSON string as produced by the model. */
  arguments: string;
}
/** The result of a tool invocation, sent back to the model. */
interface ToolResultBlock {
  type: 'tool-result';
  toolCallId: CallId;
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
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
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
  /** Caller cancellation; implementations must settle promptly after it aborts. */
  signal?: AbortSignal;
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
/** Exact-route model metadata resolved by its owning adapter. */
interface LlmResolvedModelInfo extends LlmModelInfo {
  /** Provider-owned context capacity when known. */
  context?: LlmModelContext;
  /** Adapter-configured per-request output cap materialized when callers omit one. */
  defaultMaxTokens?: number;
  /** Adapter-owned selectable reasoning levels when exposed. */
  reasoning?: LlmModelReasoningInfo;
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
  id: CallId;
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
  /** Adapter-private lossless-JSON state for replaying a successful response. */
  replayState?: unknown;
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
   * Ordered conversation messages, exactly as the provider sees them (after
   * the `system` slot). A loop-built request assembles them as
   * the derived history (dsh-agent-loop); a hand-built one-shot passes any list.
   */
  messages: Message[];
  /** System prompt text (adapters map to the provider's system slot). */
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
//#region node_modules/.pnpm/@deepseek-ai+cosmokit@1.8.2/node_modules/@deepseek-ai/cosmokit/lib/types/types.d.ts
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
//#region node_modules/.pnpm/@deepseek-ai+cosmokit@1.8.2/node_modules/@deepseek-ai/cosmokit/lib/types/misc.d.ts
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
//#region node_modules/.pnpm/@deepseek-ai+schemastery@3.18.1/node_modules/@deepseek-ai/schemastery/lib/types/index.d.ts
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
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-attachment@0_7dd6ce73a1d47d070bd8315386fa797c/node_modules/@deepseek-ai/dsh-llm/lib/types/retry-policy.d.ts
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
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-attachment@0_7dd6ce73a1d47d070bd8315386fa797c/node_modules/@deepseek-ai/dsh-llm/lib/types/call-config.d.ts
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
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-attachment@0_7dd6ce73a1d47d070bd8315386fa797c/node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts
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
declare class LlmRuntime extends Service {
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
   * @param discover - interrogates one endpoint; must honor `request.signal`.
   * @returns the disposer that withdraws the offer.
   */
  registerModelDiscovery(settingsNs: string, discover: (request: LlmModelDiscoveryRequest) => Promise<readonly LlmDiscoveredModel[]>): () => void;
  /**
   * Interrogate one provider endpoint for the models it advertises. The
   * request describes a draft, not a stored route, so nothing here reads or
   * writes settings or credentials — the caller owns both, and the reply is
   * candidate metadata a surface may offer for adoption.
   * @param settingsNs - namespace whose registered discovery serves this draft.
   * @param request - the endpoint, protocol, and one-shot credential to use.
   * @returns the advertised models, deduplicated in endpoint order.
   */
  discoverModels(settingsNs: string, request: LlmModelDiscoveryRequest): Promise<LlmDiscoveredModel[]>;
  /**
   * Resolve the retry policy captured when one provider route was registered.
   * @param provider - registered provider route to inspect.
   * @returns the provider-owned policy, with normal defaults already resolved.
   */
  providerRetryPolicy(provider: string): ResolvedRetryPolicy;
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
//#region node_modules/.pnpm/@deepseek-ai+dsh-session@0.1.0-rc.6_f235ac9f211331e710cb045f7d4315a5/node_modules/@deepseek-ai/dsh-session/lib/types/json.d.ts
/** Lossless-JSON validation and detached snapshots for durable session data. @module @deepseek-ai/dsh-session/json */
/**
 * A value that round-trips losslessly through JSON: `null`, a boolean, a finite
 * number other than negative zero, a string, an array of such values, or a
 * plain object whose values are such values. Arrays may carry only their dense
 * indexed elements; extra own properties would be discarded by JSON. TypeScript
 * cannot distinguish `-0` from `number`, so {@link isJsonValue} and
 * {@link snapshotJsonValue} enforce these details at runtime. Use this type for
 * a payload that must survive session-log persistence and replay byte-identically
 * — e.g. a tool's private presentation `meta`.
 */
type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session@0.1.0-rc.6_f235ac9f211331e710cb045f7d4315a5/node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts
/** Identifies one session in the store (and its persistence artifacts). */
type SessionId = Branded<'SessionId'>;
/**
 * Brand a string as a {@link SessionId}.
 * @param id - the raw session id string.
 * @returns the same string, branded (a compile-time cast — no runtime cost).
 */
declare function SessionId(id: string): SessionId;
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
   * A persistence backend closed a crash-orphaned turn on reload. The loop never
   * emits this marker, and the events recorded before the crash remain intact.
   */
  interrupted: {
    kind: 'interrupted';
  };
}
/** The union over {@link TurnEndReasonMap} — why a turn ended; plugins extend it by merging variants into the map. */
type TurnEndReason = TurnEndReasonMap[keyof TurnEndReasonMap];
/**
 * One entry in an agent's todo list — the unit of the `todo/write`
 * {@link SessionEventMap} event's whole-list snapshot.
 *
 * Deliberately minimal: a human-readable `content` line and a three-state
 * `status`. No id, priority, or `activeForm` — the list is replaced wholesale
 * on every write (last-write-wins), so entries need no stable identity. The
 * three statuses describe the complete portable lifecycle needed by model and
 * UI consumers.
 */
interface TodoItem {
  /** What this task is — a short imperative line shown in the UI. */
  content: string;
  /** Lifecycle state. `in_progress` marks a task being worked now; parallel work may mark several. */
  status: 'pending' | 'in_progress' | 'completed';
}
/**
 * Logged request state outside derived history: call config, system prompt, and
 * tools. The latest full `request/header` snapshot reconstructs it; canonical
 * empty optional fields are absent.
 */
interface EpochHeader {
  /** The conversation's call configuration (provider, model, reasoning effort, and sampling scalars). */
  config: LlmCallConfig;
  /** Effective config fields materialized from the exact adapter rather than proposed by a caller. */
  adapterDefaults?: LlmCallConfigAdapterDefaults;
  /** Rendered system prompt text; absent for a system-less request. */
  system?: string;
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
}
/**
 * Why a `request/header` snapshot was appended: `'initial'` — the log's first
 * header (a new conversation); `'resume'` — a loop instance's first request
 * over a log that already has header events (process restart, fork seed);
 * `'change'` — a later request used a different header.
 */
type RequestHeaderReason = 'initial' | 'resume' | 'change';
/**
 * The merge-extensible, append-only source of truth for an agent interaction.
 * Message history is derived from this log. Every event is lossless JSON and
 * sequence numbers stay contiguous, including raw chunks, so persistence can
 * store the canonical log verbatim.
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
  'user/message': UserMessage;
  /** Raw stream chunk — token-level replay fidelity. */
  'assistant/chunk': {
    turn: number;
    step: number;
    chunk: StreamChunk;
  };
  /**
   * Assembled assistant message for one step (derived history uses this).
   * Carries the step's `usage` when the adapter reported token accounting, so
   * the model output and its accounting travel together (there is no separate
   * usage record). `usage` is absent when the adapter reported none.
   */
  'assistant/message': {
    turn: number;
    step: number;
    message: AssistantMessage;
    usage?: TokenUsage;
  };
  /**
   * The model requested one tool invocation: `name` with the raw `arguments`
   * JSON string exactly as the model produced it (unparsed). `callId` pairs the
   * call with its `tool/result`.
   */
  'tool/call': {
    turn: number;
    step: number;
    callId: CallId;
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
    error?: {
      name: string;
      code: string;
    };
    meta?: JsonValue;
  };
  /** Whole-list snapshot; latest write wins on replay. Log-only UI state; never derived history. */
  'todo/write': {
    todos: TodoItem[];
  };
  /**
   * Full header for the next request, appended inside its step before dispatch.
   * It is log-only; the latest snapshot reconstructs the request header.
   */
  'request/header': {
    header: EpochHeader;
    reason: RequestHeaderReason;
  };
  /**
   * Route metadata for the next request, logged only when the route or capacity
   * changes. It does not participate in request reconstruction or header equality.
   */
  'request/context': RequestContext;
  /**
   * Marks the end of a constructor seed. Events before it have smaller seq
   * values and came from the seed (resume, fork, or replay); this lifecycle
   * produced none of them. This log-only event is the durable projection of
   * {@link Session.firstLiveSeq}. Its payload is empty — position and `time`
   * carry the meaning.
   *
   * Locate the LAST one in stored history. A seed already ending in one is not
   * re-marked, so reopening an untouched session does not grow its log per
   * pickup and the event need not be at the current `firstLiveSeq`.
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
  'session/end-seed': Record<string, never>;
}
/** The appendable event-type keys of {@link SessionEventMap}, plugin-merged extensions included. */
type SessionEventType = keyof SessionEventMap;
/**
 * The subset of {@link SessionEventType} values whose events produce LLM
 * messages and are eligible to appear on the ordered surface. Only these
 * event types may carry {@link SurfaceOp} and {@link SessionEvent.sourceEventSeqs}.
 */
type SurfaceEventType = 'user/message' | 'assistant/message' | 'tool/result';
/**
 * How a session event entered the ordered surface. Only valid on
 * {@link SurfaceEventType} events.
 *
 * - `'append'`: added to the tail — normal path for user/assistant/tool
 *   messages.
 * - `{ op: 'replace', start, end }`: replaces surface nodes from `start`
 *   (inclusive) through `end` (inclusive) with this node. Both must exist as
 *   surface nodes in the current surface. `start === end` replaces a single
 *   node. The node's {@link SessionEvent.sourceEventSeqs} must include every
 *   shadowed surface node. Used by compaction; any surface-replacing producer
 *   may use it.
 */
type SurfaceOp = 'append' | {
  op: 'replace';
  start: number;
  end: number;
};
/**
 * One immutable entry in the session log.
 *
 * A proper discriminated union over `type` (not independent `type`/`data`
 * unions), so `switch (event.type)` narrows `event.data` without casts.
 *
 * The {@link sourceEventSeqs} and {@link surfaceOp} fields are conditional:
 * they only exist on {@link SurfaceEventType} variants (`user/message`,
 * `assistant/message`, `tool/result`).
 * Non-surface events (boundary markers, chunks, usage, errors) never carry
 * surface metadata — the compiler enforces this at `Session.append()`
 * call sites.
 */
type SessionEvent<T extends SessionEventType = SessionEventType> = { [K in SessionEventType]: {
  type: K;
  /** Monotonic sequence number within the session. */
  seq: number;
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
} & (K extends SurfaceEventType ? {
  /**
   * Seq numbers of earlier events that this event cites as sources
   * (e.g. the `assistant/chunk` seqs that built an `assistant/message`,
   * or the surface nodes shadowed by a compaction replace node). An
   * `assistant/message` may carry a present empty array for a known empty
   * provider stream; when the field is absent, the event does not record which
   * earlier events produced the message.
   */
  sourceEventSeqs?: number[];
  /** How this event entered the surface; absent for non-surface events. */
  surfaceOp?: SurfaceOp;
} : object); }[T];
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session-projection@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+d_ce3609b9047395a5683eb03018b77293/node_modules/@deepseek-ai/dsh-session-projection/lib/types/types.d.ts
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
 * The single projection type table for the whole chain (host provider, wire
 * block, client cell, React hook). Domain packages merge their key here via
 * declaration merging; values are wire-JSON whole values. How a value is
 * rendered is the slot system's business, never this layer's.
 */
interface SessionProjectionMap {}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-host-apiproxy@0.1.0-rc.6_75a967487b33638129ad9d469d84f0d5/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api/rpc.d.ts
type ZodIssue = z.core.$ZodIssue;
/**
 * Message correlation id: the initiator mints it on a request; a response
 * echoes the matching request's rpcId and never mints a new one.
 */
type RpcId = Branded<'rpc-id'>;
/**
 * Brands a string as RpcId (same precedent as core `SessionId()`). Minted by the initiator:
 * client-request → client mints; server-request → host mints (answerable frames get a stable
 * logical id, pure pushes mint a fresh one each time).
 * @param id - Raw id string (implementations mint UUIDs; tests may pass fixtures).
 * @returns The same string, branded (compile-time cast, zero runtime cost).
 */
declare function RpcId(id: string): RpcId;
/** Error code → details type map (a second table isomorphic to RpcMethodMap). New code = one row here + one branch in the error schema. */
interface RpcErrorDetailsMap {
  'bad-request': {
    issues: ZodIssue[];
  };
  'cancelled': {};
  'session-not-found': {
    sessionId: SessionId;
  };
  'model-unavailable': {
    provider: string;
    model: string;
  };
  'session-conflict': {
    sessionId: SessionId;
    requestedCwd: string;
    existingCwd?: string;
  };
  'invalid-time-zone': {
    value: string;
  };
  'workspace-attach-failed': {
    sessionId: SessionId;
    workspaceId: string;
  };
  'workspace-not-found': {
    workspaceId: string;
  };
  'workspace-invalid-path': {
    path: string;
  };
  'workspace-name-conflict': {
    name: string;
  };
  'workspace-move-invalid': {
    workspaceId: string;
    sessionId: SessionId;
    beforeSessionId?: SessionId;
  };
  'directory-unreadable': {
    path: string;
  };
  'directory-exists': {
    path: string;
  };
  'directory-create-failed': {
    path: string;
  };
  'directory-picker-unavailable': {
    capability: string;
  };
  'agent-preset-read-only': {
    agentPreset: string;
    reason: string;
  };
  'agent-preset-locked': {
    sessionId: SessionId;
    agentPreset: string;
  };
  'agent-preset-conflict': {
    sessionId: SessionId;
    requestedPreset: string;
    existingPreset?: string;
  };
  'agent-preset-not-found': {
    agentPreset: string;
    available: string[];
  };
  'agent-preset-invalid': {
    agentPreset: string;
    reason: string;
  };
  'agent-busy': {
    reason: string;
  };
  'attachment-error': {
    reason: string;
  };
  'queue-item-not-found': {
    itemId: MessageId;
  };
  'steer-unavailable': {
    itemId: MessageId;
  };
  /** A known slash command reported a usage/state error; the message is the command's own text. */
  'command-error': {};
  /** A leading-/ prompt named no registered command; the message names the token. */
  'unknown-command': {};
  /**
   * A settings write was refused (schema validation, unknown namespace,
   * read-only provider, or storage failure); the message is the seam's text.
   */
  'settings-rejected': {
    ns: string;
  };
  /**
   * A settings namespace exists in the seam but is outside the configuration
   * plane's model-provider boundary, so this proxy neither reads nor writes
   * it; the message names the namespace.
   */
  'settings-not-exposed': {
    ns: string;
  };
  /**
   * A settings write carried an `expectedRevision` the namespace has already
   * moved past: another writer (tab, editor, or an external file edit) landed
   * first. The details carry both revisions so a client can re-read and retry.
   */
  'settings-conflict': {
    ns: string;
    expected: number;
    actual: number;
  };
  /** A credential write was refused (read-only shadowing layer or storage failure); the message is the seam's own text. */
  'credential-rejected': {
    ref: string;
  };
  /**
   * Interrogating a draft provider endpoint did not produce a model listing:
   * no adapter family serves the namespace, the protocol has no listing this
   * build can read, or the endpoint was unreachable, refused the credential,
   * or answered with something else. The message is the adapter's own text —
   * it is what the form shows before falling back to hand-entry — and the
   * details name the endpoint asked, never the credential offered.
   */
  'model-discovery-failed': {
    settingsNs: string;
    baseURL?: string;
  };
  'title-invalid': {
    sessionId: SessionId;
  };
  'fork-unavailable': {
    sessionId: SessionId;
  };
  'subagent-parent-unavailable': {
    parentSessionId: SessionId;
  };
  'subagent-not-found': {
    parentSessionId: SessionId;
    childSessionId: SessionId;
  };
  'subagent-catalog-diagnostic': {
    parentSessionId: SessionId;
    childSessionId: SessionId;
    reason: 'corrupt' | 'unsupported' | 'unavailable';
  };
  'subagent-not-resumable': {
    childSessionId: SessionId;
  };
  'subagent-unauthorized': {
    childSessionId: SessionId;
  };
  'subagent-delivery-unavailable': {
    childSessionId: SessionId;
  };
  'internal': {};
}
/** Closed error-code union (the keys of RpcErrorDetailsMap). */
type RpcErrorCode = keyof RpcErrorDetailsMap;
/**
 * Distributive union expanded from the map: code is the discriminant, so
 * `switch (error.code)` narrows details. details is required (internal uses an explicit {}).
 */
type RpcError = { [C in RpcErrorCode]: {
  code: C;
  message: string;
  details: RpcErrorDetailsMap[C];
}; }[RpcErrorCode];
/** Business success/failure result: the result slot of a unary response; methods never throw business errors. */
type RpcResult<T> = {
  ok: true;
  value: T;
} | {
  ok: false;
  error: RpcError;
};
/**
 * Signature-layer narrow form, request side (domain-interface view, shared by
 * both directions): rpcId is explicit in the signature, never mixed into the
 * business payload; the type tag and method are filled in by the carrier layer.
 */
interface RpcRequest<P> {
  rpcId: RpcId;
  payload: P;
}
/** Signature-layer narrow form, response side: rpcId always echoes the matching request. */
interface RpcResponse<T> {
  rpcId: RpcId;
  result: RpcResult<T>;
}
/** Response to a ServerRequest (wire carrier: POST /api/respond body); rpcId echoed, never minted anew. */
interface ClientResponse {
  type: 'client-response';
  rpcId: RpcId;
  result: RpcResult<unknown>;
}
/**
 * Carrier receipt (not an RpcMessage — it belongs to the carrier layer, same
 * discipline as "HTTP status describes only the carrier"): the HTTP response
 * body of the POST carrying a client-response. Late/duplicate responses yield not-pending.
 */
type RpcReceipt = {
  accepted: true;
} | {
  accepted: false;
  reason: 'not-pending' | 'bad-response';
};
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-user-questions@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-a_ba429e79a2cefb246385e60d206cdfef/node_modules/@deepseek-ai/dsh-user-questions/lib/types/types.d.ts
/**
 * Wire-safe question and answer types, free of cordis/service imports so browser
 * type chains (apiproxy api → client) can consume them without loading this
 * package's Context augmentation.
 * @module @deepseek-ai/dsh-user-questions/types
 */
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
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-user-approval@0.1.0-rc.6_67d77734ddb0cff591f2161d31a510cb/node_modules/@deepseek-ai/dsh-user-approval/lib/types/types.d.ts
/**
 * Pairs one `approval/asked` audit event with its `approval/decided`.
 * Service-issued (one fresh id per {@link ApprovalService.request} call).
 */
type ApprovalRequestId = Branded<'ApprovalRequestId'>;
/**
 * Brand a string as an {@link ApprovalRequestId}.
 * @param id - the raw id string to brand.
 * @returns the same string carrying the brand.
 */
declare function ApprovalRequestId(id: string): ApprovalRequestId;
/**
 * Closed approval outcomes: a one-shot grant, explicit rejection, withdrawn
 * request, or unavailable answerer. Callers fail closed on `unavailable`.
 */
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-tools@0.1.0-rc.6_986143ff0e0cd01f957bae4eeb45a538/node_modules/@deepseek-ai/dsh-tools/lib/types/presentation.d.ts
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
interface FileDiff {
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
  diffs: FileDiff[];
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
  diffs: FileDiff[];
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
//#region node_modules/.pnpm/@deepseek-ai+dsh-jobs@0.1.0-rc.6_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-agent@0.1.0_d1347a4d07b79141c4fa3c065b2ddf0b/node_modules/@deepseek-ai/dsh-jobs/lib/types/brand.d.ts
/**
 * Identifies a background job. The registry generates `<kind>-N`; predictable
 * ids rely on owner authorization rather than secrecy.
 */
type JobId = Branded<'JobId'>;
/**
 * Brand a string as a {@link JobId}.
 * @param id - the raw job-id string (the registry generates `<kind>-N`).
 * @returns the same string, branded; no validation is performed.
 */
declare function JobId(id: string): JobId;
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-host-apiproxy@0.1.0-rc.6_75a967487b33638129ad9d469d84f0d5/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api/jobs.d.ts
/**
 * One background job as the client sees it.
 *
 * Three registry fields are deliberately absent. `ownerSession` is redundant
 * beside the frame's own `sessionId`; `reported` is an internal notice-delivery
 * bit with no user meaning; `outputLimitBytes` is producer-owned model
 * presentation policy that never reaches a human surface.
 */
interface JobView {
  /** Registry-issued `<kind>-N` identity, stable for the task's whole life. */
  id: JobId;
  /**
   * Producer kind (`bash`, `pwsh`, `pty-send`, `subagent`, …). Kept as a bare
   * string because producer plugins extend the kind map by declaration merging,
   * so no client build can enumerate the closed set.
   */
  kind: string;
  /** Producer-supplied one-line label: the command, or the delegation description. */
  label: string;
  /** Current lifecycle state. */
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed';
  /** Kind-specific status detail ('exit code: 3'), present once the producer supplied one. */
  detail?: string;
  /** Epoch ms when the task was registered. */
  startedAt: number;
  /** Epoch ms when the task settled; absent while live. */
  finishedAt?: number;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-host-apiproxy@0.1.0-rc.6_75a967487b33638129ad9d469d84f0d5/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api/workspace.d.ts
/**
 * Wire-side workspace id brand. Deliberately re-declared here rather than
 * imported from dsh-workspace: api/ must stay browser-importable with zero
 * host-package dependencies, and the brand string matches, so both sides
 * agree structurally.
 */
type WorkspaceId = Branded<'WorkspaceId'>;
/** One workspace row: the record projection every workspace.* value carries. */
interface WorkspaceView {
  workspaceId: WorkspaceId;
  /** Canonical directory path (host-side realpath canon). */
  path: string;
  /** Display title (defaults to the path basename at create). */
  title: string;
  /**
   * Sessions accounted under this workspace, in manually owned order
   * (attach prepends, insertSessionBefore reorders; activity never does).
   */
  sessionIds: SessionId[];
  /** ISO-8601 creation instant. */
  createdAt: string;
  /** ISO-8601 last-mutation instant. */
  updatedAt: string;
}
/** Workspace-domain unary methods (the map keys workspace.* of RpcMethodMap). */
interface WorkspaceApi {
  /**
   * Lists all workspaces in the registry's durable display order, plus the
   * registry-global archive set (the reconnect baseline of
   * `host/archived-sessions-changed`). Archived sessions stay in their
   * workspace's `sessionIds` account; grouping surfaces hide them.
   */
  list(request: RpcRequest<{}>): Promise<RpcResponse<{
    items: WorkspaceView[];
    archivedSessionIds: SessionId[];
  }>>;
  /**
   * Creates (or idempotently resolves) a workspace over an EXISTING directory
   * (no mkdir — a missing or non-directory path fails with
   * `workspace-invalid-path`). A path resolving to a directory already owned
   * by a workspace returns that workspace (`created: false`). Adoption allows
   * distinct canonical paths whose basenames produce the same display title;
   * the registry's basename title default names the new workspace.
   */
  create(request: RpcRequest<{
    path: string;
  }>): Promise<RpcResponse<{
    workspace: WorkspaceView;
    created: boolean;
  }>>;
  /**
   * Renames a workspace. `title` is trimmed and must be non-empty
   * (schema-enforced). An unknown id fails with `workspace-not-found`; a
   * title equal to another workspace's fails with `workspace-name-conflict`.
   * Renaming to the current title is a no-op success (no durable write).
   */
  rename(request: RpcRequest<{
    workspaceId: WorkspaceId;
    title: string;
  }>): Promise<RpcResponse<{
    workspace: WorkspaceView;
  }>>;
  /**
   * Removes one Workspace registration. The directory, every user file, and
   * every session log remain untouched; those Sessions consequently become
   * ungrouped. An unknown id fails with `workspace-not-found`.
   */
  delete(request: RpcRequest<{
    workspaceId: WorkspaceId;
  }>): Promise<RpcResponse<{
    deleted: true;
  }>>;
  /**
   * Moves one Workspace within the registry display order,
   * DOM-insertBefore-like. An omitted anchor appends to the end.
   */
  insertBefore(request: RpcRequest<{
    workspaceId: WorkspaceId;
    beforeWorkspaceId?: WorkspaceId;
  }>): Promise<RpcResponse<{
    workspaceIds: WorkspaceId[];
  }>>;
  /**
   * Moves an accounted session within its workspace's manual order,
   * DOM-insertBefore-like: with `beforeSessionId` the session is inserted
   * before that anchor; omitted appends to the end. An unknown workspace
   * fails with `workspace-not-found`; a session or anchor not accounted by
   * the workspace fails with `workspace-move-invalid`. A move to the current
   * position is a no-op success.
   */
  insertSessionBefore(request: RpcRequest<{
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    beforeSessionId?: SessionId;
  }>): Promise<RpcResponse<{
    workspace: WorkspaceView;
  }>>;
  /**
   * Adds one session to the registry-global archive set: the session
   * disappears from every grouping surface but keeps its session log and its
   * workspace accounting slot (a future unarchive restores its position).
   * Idempotent for an already archived id. A session neither live nor in
   * session persistence fails with `session-not-found`. Returns the full
   * updated set (same snapshot the changed frame carries).
   */
  archiveSession(request: RpcRequest<{
    sessionId: SessionId;
  }>): Promise<RpcResponse<{
    archivedSessionIds: SessionId[];
  }>>;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-host-apiproxy@0.1.0-rc.6_75a967487b33638129ad9d469d84f0d5/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api/events.d.ts
/**
 * Host-computed render intent accompanying a `tool/call` or `tool/result`
 * event. A pure derivation of args/result through the presenter registered at
 * emission time — never persisted (the session log carries only the event), so
 * the same event may carry a different view (or none) on a later delivery.
 * `for` names which vocabulary applies without re-inspecting the event type.
 * An absent view means the client's documented default (generic JSON card).
 */
type ToolEventView = {
  for: 'call';
  view: ToolCallView;
} | {
  for: 'result';
  view: ToolResultView;
};
/** One pending inbox occurrence in the authoritative `session/queue` snapshot. */
interface QueuedInboxItem {
  /** Message identity used by inbox mutations. */
  id: MessageId;
  /** Agent-resolved FIFO placement; queued and steering items render on different surfaces, context items stay invisible until claimed. */
  placement: 'queued' | 'steering' | 'context';
  /** Complete pending message; it is not durable until the Agent claims it. */
  message: Message;
}
/** Streaming face of the contract: the two logical stream openers (mux + host). */
interface EventsApi {
  /**
   * All-session aggregated mux stream. On open, emits a subscribed control frame for every
   * attached session, then replays each session's still-pending approval/question requested
   * frames (rpcId reused verbatim — the refresh-recovery baseline). Session titles ride the
   * generic projection pair (history-tail projections block + session/projection frames).
   * since: resume hook, unimplemented in v1 (ignored if passed); reconnection = reopen the
   * stream + refetch history.
   */
  mux(request: RpcRequest<{
    since?: Record<SessionId, number>;
  }>, signal: AbortSignal): AsyncIterable<RpcRequest<MuxFrame>>;
  /**
   * Host-level info stream: session create/destroy, running-status flips, and
   * agent failures with no turn position. Empty payload uses `{}`.
   */
  host(request: RpcRequest<{}>, signal: AbortSignal): AsyncIterable<RpcRequest<HostFrame>>;
}
/**
 * Mux stream frames: raw session-event passthrough + control frames +
 * approval/question frames (requested = answerable server-request, the rest are pure pushes).
 */
type MuxFrame = {
  type: 'session/event';
  sessionId: SessionId;
  event: SessionEvent;
  view?: ToolEventView;
} | {
  type: 'session/subscribed';
  sessionId: SessionId;
  lastSeq: number;
} | {
  type: 'approval/requested';
  sessionId: SessionId;
  approvalId: ApprovalRequestId;
  toolName: string;
  callId?: CallId;
  reason?: string;
} | {
  type: 'approval/resolved';
  sessionId: SessionId;
  approvalId: ApprovalRequestId;
  outcome: ApprovalOutcome;
} | {
  type: 'question/requested';
  sessionId: SessionId;
  questions: AskUserQuestionItem[];
} | {
  type: 'question/resolved';
  sessionId: SessionId;
  questionRpcId: RpcId;
  outcome: 'answered' | 'cancelled';
} |
/**
 * Complete transient inbox state after every enqueue, mutation, claim, or
 * discard. Pending work is not model-visible and therefore has no durable
 * session event; the whole snapshot makes edit, deletion, cancel, and
 * reconnect converge through one authoritative signal. `session/queue`
 * covers both resolved placements: queued items render
 * in QueueDock, while pending steering renders at the conversation tail.
 */
{
  type: 'session/queue';
  sessionId: SessionId;
  items: QueuedInboxItem[];
} |
/**
 * Complete set of background jobs this session can see, after every registry
 * commit that changes it: registration, the stopping transition, settlement,
 * and owner-disposal removal. The registry is process-local and holds no
 * durable event, so — exactly like `session/queue` — the whole snapshot is
 * what makes a start, a kill, a reconnect, and a second tab converge on one
 * authoritative value.
 *
 * Sent as a subscription baseline only for a session that currently has
 * tasks; an absent key means an empty set. A change that empties the set
 * still sends `[]`, since that transition is the only one absence cannot
 * express.
 */
{
  type: 'session/jobs';
  sessionId: SessionId;
  jobs: JobView[];
} |
/**
 * One projection unit's finished value changed (session-projection RFC).
 * Live push state, never logged — replay recomputes on the host (the
 * tool-view posture). `value` is the unit's schema-validated view output;
 * `seq` is the unit's watermark at emission. Clients keep one generic
 * per-session value store under higher-seq-wins, seeded by the history
 * tail page's projections block.
 */
{
  type: 'session/projection';
  sessionId: SessionId;
  key: string;
  value: unknown;
  seq: number;
} | {
  type: 'stream/error';
  error: RpcError;
};
/**
 * Host stream frames. session-added carries the lineage anchor, product
 * origin, project cwd, and blank bit (the list-summary fields a client cannot
 * wait for a refresh to learn); the frame fires at session/created, so blank is
 * constantly true — clients flip it on the session's first
 * `host/session-status(running:true)` (a blank session never runs), and a
 * reconnecting client takes `session.list`'s summary.blank as authoritative.
 * agent-error is the only outlet for live failures with no turn position;
 * workspace-changed pushes the full new snapshot after every durable
 * workspace mutation (create/attach/order change — the client upserts, while
 * `workspace.list` provides the reconnect baseline); workspace-removed is the
 * committed registration-deletion increment and never implies directory or
 * session-log deletion; workspace-order-changed pushes the complete durable
 * registry order after a reorder; archived-sessions-changed pushes the full registry
 * archive set after every durable change (same full-snapshot posture as
 * workspace-changed — `workspace.list` re-baselines it on reconnect).
 */
type HostFrame = {
  type: 'host/session-added';
  sessionId: SessionId;
  blank: boolean;
  parentSessionId?: SessionId;
  origin?: 'subagent';
  cwd?: string;
  agentPreset?: string;
} | {
  type: 'host/session-removed';
  sessionId: SessionId;
} | {
  type: 'host/session-status';
  sessionId: SessionId;
  running: boolean;
} | {
  type: 'host/agent-error';
  sessionId: SessionId;
  message: string;
} | {
  type: 'host/workspace-changed';
  workspace: WorkspaceView;
} | {
  type: 'host/workspace-removed';
  workspaceId: WorkspaceView['workspaceId'];
} | {
  type: 'host/workspace-order-changed';
  workspaceIds: WorkspaceView['workspaceId'][];
} | {
  type: 'host/archived-sessions-changed';
  archivedSessionIds: SessionId[];
} |
/**
 * One allowlisted host cordis event forwarded verbatim. The allowlist is
 * owned by `@deepseek-ai/dsh-api-remotes` (`API_REMOTE_FORWARDED_EVENTS`),
 * which is also the only control point over what a consumer can receive.
 * `event` is the host's own event name and `args` its argument list: this
 * path applies no projection, no redaction, and no renaming, so the payload
 * contract is the owner package's cordis `Events` declaration rather than
 * anything stated here. Delivery lands on `ctx.remote.$on`, not on a
 * per-event frame variant.
 */
{
  type: 'host/remote-event';
  event: string;
  args: JsonValue[];
} | {
  type: 'stream/error';
  error: RpcError;
};
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-host-apiproxy@0.1.0-rc.6_75a967487b33638129ad9d469d84f0d5/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api/sessions.d.ts
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * Session-list hints persisted by the projection cache. `blank: false`
     * is monotonic and may suppress a cold-log probe; `blank: true` is only a
     * checkpoint-prefix fact and must not hide a cold Session without direct
     * verification. `lastPromptAt` is the latest human-authored prompt time.
     */
    sessionListMetadata: SessionListMetadata;
    /**
     * The deployment's image-intake limits: the attachments service's config
     * as this proxy enforces it at prompt admission, constant per host boot.
     * Clients pre-check count and bytes at intake and show the limits in
     * upload affordances. Key absence means no attachment service is
     * composed — clients skip the pre-check and let the host answer.
     */
    imageLimits: ImageAttachmentLimits;
  }
}
/** Persisted hints used to summarize a cold Session without reading a large log. */
interface SessionListMetadata {
  /** Whether the checkpoint prefix contains no turn/start event. */
  blank: boolean;
  /** Latest source.kind=user message time in the checkpoint prefix. */
  lastPromptAt: number | null;
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * The prompt's rpcId is passed through MessageSource into the `user/message` event
     * (the client uses it to reconcile the optimistically
     * echoed provisional message with the event stream). kind stays `'user'` — the model face
     * carries no transport vocabulary; rpcId and the optional Host-validated browser zone are
     * durable JSON fields passed back to the client with the event.
     */
    'user-rpc': {
      kind: 'user';
      rpcId: RpcId;
      clientTimeZone?: string;
    };
  }
}
/**
 * One history page entry: the raw event plus the optional host-computed render
 * intent (same semantics as the mux frame's `view` slot — a pagination-time
 * derivation, never persisted).
 */
interface HistoryEntry {
  event: SessionEvent;
  view?: ToolEventView;
}
/**
 * The projection baseline riding the history tail page: one synchronous cut
 * over every registered projection unit, read from the registry's watermark
 * cache. `asOfSeq` is the seq of the last committed event every value
 * reflects — the window tail event seq (`-1` for an empty log, mirroring
 * `session/subscribed.lastSeq`), directly comparable with
 * `session/projection` frame seqs under the client's higher-seq-wins rule. A
 * key absent from `values` means the capability is absent (its domain plugin
 * is unmounted).
 */
interface SessionProjectionsBlock {
  /** Seq of the last event the values reflect; -1 for an empty log. */
  asOfSeq: number;
  /** Whole current value per registered projection key. */
  values: Partial<SessionProjectionMap>;
}
/** Browser-submitted prompt content; the host promotes image bytes to durable references. */
type PromptContentPart = {
  type: 'text';
  text: string;
} | {
  type: 'image';
  mediaType: ImageMediaType;
  data: string;
  name?: string;
};
/** Complete model selection for one session. */
interface ModelSelection {
  /** Registered provider route. */
  provider: string;
  /** Provider-owned model id. */
  model: string;
  /** Adapter-owned reasoning effort; absence preserves adapter/provider default behavior. */
  reasoningEffort?: string;
}
/** One adapter-owned reasoning effort displayed for an exact model route. */
interface ModelReasoningEffort {
  /** Opaque value submitted back to the owning adapter. */
  id: string;
  /** Adapter-supplied display name. */
  name: string;
  /** Optional adapter-supplied description. */
  description?: string;
}
/** Selectable reasoning metadata for one exact model route. */
interface ModelReasoning {
  /** Efforts in adapter-preferred display order. */
  efforts: ModelReasoningEffort[];
  /** Adapter-configured default; absence preserves the provider default. */
  defaultEffort?: string;
}
/** One model displayed inside its provider group. */
interface ModelCatalogModel {
  /** Provider-owned model id. */
  id: string;
  /** Provider-supplied display name. */
  name: string;
  /** Optional provider-supplied description. */
  description?: string;
  /** Exact-route reasoning metadata when the adapter exposes it. */
  reasoning?: ModelReasoning;
}
/** One provider and the models it advertised successfully. */
interface ModelProviderGroup {
  /** Provider route id used for requests. */
  id: string;
  /** Provider display name. */
  name: string;
  /** Models in provider-preferred order. */
  models: ModelCatalogModel[];
}
/** A provider whose asynchronous catalog lookup failed. */
interface ModelCatalogFailure {
  /** Provider route id. */
  id: string;
  /** Provider display name. */
  name: string;
  /** Lookup failure diagnostic. */
  message: string;
}
/** Detached model-directory snapshot for one session. */
interface SessionModels {
  /** Model selection for the session's next assembled step. */
  current: ModelSelection;
  /**
   * Whether an adapter currently serves `current.provider`, and therefore
   * whether this session can start a turn at all. Deliberately NOT derivable
   * from `groups`: catalog membership is advisory, so a route serving a model
   * it stopped advertising is absent from the groups yet perfectly usable,
   * while a route whose adapter is gone can serve nothing. A surface that
   * blocks input must read this rather than the groups.
   */
  routable: boolean;
  /** Successfully loaded provider groups. */
  groups: ModelProviderGroup[];
  /** Provider-local failures; successful groups remain usable. */
  failures: ModelCatalogFailure[];
}
/** A client-requested mutation of one still-pending queue item. */
type QueueAction = {
  kind: 'edit';
  content: ContentBlock[];
} | {
  kind: 'remove';
} | {
  kind: 'steer';
};
/** One Session list entry. */
interface SessionSummary {
  sessionId: SessionId;
  /**
   * The later of creation and the latest human-authored prompt. Attached
   * Sessions fold their live log; cold Sessions use a projection-cache hint or
   * an exact small-artifact read, falling back to creation time.
   */
  updatedAt: number;
  /** Status of the attached agent; always false for cold (unattached) sessions. */
  running: boolean;
  /**
   * Derived conversation-not-started bit: true while no turn has run.
   * Standalone plugin events — command lifecycle
   * records, plan/mode, titles, goals — do not open a turn and therefore do
   * not clear it. Clients hide blank Sessions from lists and reuse them for
   * New Session on the same workspace. A cold Session is true only when a
   * small-artifact read verifies that no `turn/start` exists; unavailable
   * or oversized artifacts conservatively report false.
   */
  blank: boolean;
  /** fork/spawn lineage (session.header.parentSession passthrough); absent for root sessions. */
  parentSessionId?: SessionId;
  /** Coarse durable origin used by navigation surfaces; never proves resumability. */
  origin?: 'subagent';
  /** Session working directory (header.cwd passthrough); absent when unrecorded. */
  cwd?: string;
  /**
   * Agent preset this session's agent was composed from (header passthrough);
   * absent when the deployment composes no presets. A surface offering a
   * switch reads this to show what the session actually runs rather than what
   * the deployment currently defaults to.
   */
  agentPreset?: string;
  /**
   * Projection baseline for this row, with zero log loads: attached sessions
   * read the registry's live watermark cut; cold sessions read the persisted
   * projection cache's stored rows — as stale as that session's last durable
   * checkpoint (`asOfSeq` says exactly how stale), never wrong, and directly
   * seedable into the client's per-session value store under its
   * higher-seq-wins rule (a list baseline can never overwrite a newer push
   * frame). Absent when no value is available (no registry, no cache row for
   * a cold session, or a fail-soft cache read miss); a listing client treats
   * absence as "no title yet", exactly like a blank session.
   */
  projections?: SessionProjectionsBlock;
}
/** One session-content search result; display metadata stays owned by `session.list`. */
interface SessionSearchItem {
  sessionId: SessionId;
  /** Plain-text excerpt around the strongest matching visible message. */
  snippet: string;
}
/** Session-domain unary methods (the map keys session.* of RpcMethodMap). */
interface SessionsApi {
  /** Lists persisted sessions (updatedAt descending). v1 returns everything; cursor is a reserved seat, unimplemented. */
  list(request: RpcRequest<{
    cursor?: string;
  }>): Promise<RpcResponse<{
    items: SessionSummary[];
  }>>;
  /**
   * Searches the current user/assistant/steering message surface across
   * sessions visible to `list`. Results contain at most 20 sessions and carry
   * no continuation cursor; `hasMore` asks the client to refine the query.
   */
  search(request: RpcRequest<{
    query: string;
  }>, signal: AbortSignal): Promise<RpcResponse<{
    items: SessionSearchItem[];
    hasMore: boolean;
  }>>;
  /**
   * Creates a real session and its idle agent. At most one of `workspaceId` /
   * `cwd` is accepted; an omitted project uses the Host cwd. A caller may
   * preallocate `sessionId`: retries with the same id and cwd return the same
   * session, while a different cwd fails with `session-conflict`. Workspace
   * creation attaches the session after publication; an attach failure
   * returns `workspace-attach-failed` with the published session id.
   *
   * `agentPreset` names the composition the new session's agent is built
   * from; omitted, the effective default applies — the user's stored choice
   * where one exists, else the deployment's own. The resolved id is stored on
   * the session header, so a later resume rebuilds the same agent. An unknown
   * id fails with `agent-preset-not-found`, and a preset whose composition
   * cannot be mounted fails with `agent-preset-invalid`.
   */
  create(request: RpcRequest<{
    workspaceId?: WorkspaceId;
    cwd?: string;
    sessionId?: SessionId;
    agentPreset?: string;
  }>): Promise<RpcResponse<{
    sessionId: SessionId;
    agentPreset?: string;
  }>>;
  /**
   * Reads a window of history events; page boundaries align to append-origin message
   * boundaries: one page = all raw events owned by a whole number of such messages (including
   * their chunk / tool events), never cut mid-message. Model-only replacement copies consume no
   * `maxMessages`, so a compaction's `compaction/summary` record stays on the page of its replacement. The tail
   * page (beforeSeq absent) additionally carries the in-flight
   * partial — chunk events already emitted for the last unfinalized message.
   * Each entry pairs the raw SessionEvent with the host-computed view (tool events whose
   * presenter produced one, evaluated against the registry at pagination time); the client
   * rebuilds the surface from the events with the shared fold.
   * The tail page — and only the tail page — additionally carries `projections`
   * when the deployment mounts the session-projection registry: every moment
   * the client needs a fresh baseline already pulls the tail page, and
   * loadOlder (the only beforeSeq path) is the only path that never needs one.
   * A deployment without the registry serves histories without the block.
   * Reading history uses an attached Session or persistence inspection and
   * never resumes or publishes an Agent.
   */
  history(request: RpcRequest<{
    sessionId: SessionId;
    beforeSeq?: number;
    maxMessages?: number;
  }>): Promise<RpcResponse<{
    events: HistoryEntry[];
    hasMore: boolean;
    projections?: SessionProjectionsBlock;
  }>>;
  /**
   * Reads a fresh advisory model directory for an ordinary session. Provider
   * lookups run independently; subagents reject with `agent-busy`.
   */
  models(request: RpcRequest<{
    sessionId: SessionId;
  }>): Promise<RpcResponse<SessionModels>>;
  /**
   * Selects the complete model selection for this session. Exact model metadata
   * validates an optional reasoning effort, while catalog membership remains
   * advisory. Session-backed subagents reject with `agent-busy`.
   */
  selectModel(request: RpcRequest<{
    sessionId: SessionId;
    provider: string;
    model: string;
    reasoningEffort?: string;
  }>): Promise<RpcResponse<{
    selected: ModelSelection;
  }>>;
  /**
   * Renames a session: appends a `session/title` event with the `user`
   * source, which pins the title against automatic regeneration. The
   * normalized accepted title and the title event's seq return so the caller
   * can settle its projection cell without waiting for the push frame. A
   * title that normalizes to empty fails with `title-invalid`.
   * Session-backed subagents reject with `agent-busy`.
   */
  rename(request: RpcRequest<{
    sessionId: SessionId;
    title: string;
  }>): Promise<RpcResponse<{
    title: string;
    seq: number;
  }>>;
  /**
   * Sends a message. content is core's ContentBlock[] verbatim; mode maps 1:1 — queue→send, steer→steer.
   * A prompt whose content is exactly one text block starting with '/' is a slash command: the host
   * executes it through the command registry (mode-agnostic) and it is never sent to the model. A
   * successful command returns ok with the command slot (its success text, when the command produced
   * one — carried for future rendering; the state change is the feedback). A usage/state error is an
   * RPC error with code command-error; an unrecognized name is an RPC error with code unknown-command.
   */
  /**
   * Forks a new session from a completed-turn prefix of the source. `atSeq`
   * anchors the cut: the boundary is the first `turn/end` at or after it
   * (a message's fork button passes the message seq, so the fork includes
   * that whole turn); a boundary past the log end, or an omitted `atSeq`,
   * falls back to the source's last completed turn. An in-log anchor whose
   * turn is still open fails with `fork-unavailable` instead of clipping to
   * an earlier turn. The child inherits the source cwd, latest logged model
   * target and `parentSessionId` lineage; the seed prefix carries the source
   * title. Reading the source uses attached state or persistence inspection
   * without acquiring an Agent. Workspace attachment follows the source
   * directly, or the nearest workspace-owning ancestor when the source is a
   * subagent.
   */
  fork(request: RpcRequest<{
    sessionId: SessionId;
    atSeq?: number;
  }>): Promise<RpcResponse<{
    sessionId: SessionId;
  }>>;
  /**
   * Sends text and temporary image bytes to an ordinary session Agent after durable host admission.
   * Browser callers attach their current IANA zone;
   * the Host validates, canonicalizes, and records it on that exact user message. Omission remains
   * valid for non-browser callers. Session-backed subagents reject with `agent-busy` and use
   * `subagent.prompt`.
   */
  prompt(request: RpcRequest<{
    sessionId: SessionId;
    mode: 'queue' | 'steer';
    content: PromptContentPart[];
    clientTimeZone?: string;
  }>): Promise<RpcResponse<{
    accepted: true;
    command?: {
      kind: 'success';
      text?: string;
    };
  }>>;
  /** Reads one durable image after proving that this session's log references its id. */
  attachment(request: RpcRequest<{
    sessionId: SessionId;
    attachmentId: AttachmentId;
  }>): Promise<RpcResponse<{
    attachment: ImageAttachmentRef;
    data: string;
  }>>;
  /**
   * Edits, removes, or strictly steers one pending queued occurrence on an ordinary session.
   * Session-backed subagents reject with `agent-busy`.
   */
  updateQueue(request: RpcRequest<{
    sessionId: SessionId;
    itemId: MessageId;
    action: QueueAction;
  }>): Promise<RpcResponse<{
    accepted: true;
  }>>;
  /**
   * Stops an ordinary session's active turn, preserving pending inbox work
   * that resumes in FIFO order after cancellation settles. Session-backed
   * subagents reject with `agent-busy`.
   */
  cancel(request: RpcRequest<{
    sessionId: SessionId;
  }>): Promise<RpcResponse<{
    accepted: true;
  }>>;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-host-apiproxy@0.1.0-rc.6_75a967487b33638129ad9d469d84f0d5/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api/host.d.ts
/** One directory row of a listing: a child entry or a breadcrumb ancestor. */
interface DirectoryEntry {
  /** Base name shown in a browser row (a root crumb carries its full path). */
  name: string;
  /** Absolute host path — the client never joins path segments itself. */
  path: string;
  /** Hidden by the host platform's convention (dot-prefixed on POSIX); the client owns whether to show it. */
  hidden: boolean;
}
/** host.listDirectory response value: one directory level plus its ancestry. */
interface DirectoryListing {
  /** Absolute path of the listed directory. */
  path: string;
  /** The host account's home directory (breadcrumb "Home" rooting). */
  home: string;
  /**
   * Ancestor chain from the filesystem root to the listed directory
   * inclusive; every crumb is a jump target (crumb `hidden` is always false).
   */
  crumbs: DirectoryEntry[];
  /** Direct child directories, name-sorted; symlinks to directories included. */
  entries: DirectoryEntry[];
  /** True when the backend cut `entries` at its complete-result bound (the name-sorted tail is absent). */
  truncated: boolean;
}
/** Host-level unary methods. */
interface HostApi {
  /**
   * One-shot host snapshot. Empty payload uses the literal `{}` (extend in place when fields arrive).
   * version = the host app's (apps/cli) package.json version; cwd = the host process working
   * directory (root for session persistence and tool execution); provider/model = the defaults
   * applied when a new agent doesn't specify them explicitly, absent when the host configures
   * no explicit default (the adapter falls back internally);
   * attachedSessions = count of currently attached sessions (those with a live agent);
   * canOpenPath = whether this deployment can hand a path to a user-visible native desktop.
   */
  describe(request: RpcRequest<{}>): Promise<RpcResponse<{
    version: string;
    cwd: string;
    provider?: string;
    model?: string;
    attachedSessions: number;
    canOpenPath: boolean;
  }>>;
  /**
   * Open the operating system's single-directory picker; cancellation returns
   * null. Only served under the `native` capability.
   */
  pickDirectory(request: RpcRequest<{}>, signal: AbortSignal): Promise<RpcResponse<{
    path: string | null;
  }>>;
  /**
   * List one directory level for the in-app browser; an absent path lists the
   * host account's home directory. Only served under the `browse` capability;
   * unreadable or missing targets fail with `directory-unreadable`. The
   * carrier's request signal follows the caller, stopping the backend's scan
   * on disconnect or timeout.
   */
  listDirectory(request: RpcRequest<{
    path?: string;
  }>, signal: AbortSignal): Promise<RpcResponse<DirectoryListing>>;
  /**
   * Create one child directory under an existing parent (the browser's
   * "New folder"). Only served under the `browse` capability; an existing
   * child fails with `directory-exists`, every other filesystem failure with
   * `directory-create-failed`.
   */
  createDirectory(request: RpcRequest<{
    path: string;
    name: string;
  }>): Promise<RpcResponse<{
    path: string;
  }>>;
  /**
   * Open a filesystem path with the operating system's default application
   * (Finder / Explorer / xdg-open hand-off). The browser carrier's
   * prefix-wide trust fence covers this privileged method like every other
   * `/api` request.
   */
  openPath(request: RpcRequest<{
    path: string;
  }>, signal: AbortSignal): Promise<RpcResponse<{
    opened: true;
  }>>;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-host-apiproxy@0.1.0-rc.6_75a967487b33638129ad9d469d84f0d5/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api/agent-presets.d.ts
/** One preset the deployment can compose a session's agent from. */
interface AgentPresetEntry {
  /** Stable identifier, also the display name until presets carry metadata. */
  readonly id: string;
  /**
   * Whether the preset ships with the deployment or was authored locally.
   * A `user` preset is exactly as privileged as the plugins it names, so a
   * surface offering one should say so rather than present it as vetted.
   */
  readonly trust: 'system' | 'user';
  /** Whether a session that names no preset gets this one. */
  readonly isDefault: boolean;
  /**
   * Display name the preset published, absent when it published none. A
   * surface falls back to {@link id}; it is never a second identity, and it
   * never decides trust — a locally authored preset cannot name itself into
   * the shipped set.
   */
  readonly name?: string;
  /** One sentence on what the preset is for, when it published one. */
  readonly description?: string;
  /**
   * Why this preset cannot compose a session, absent when it can. A broken
   * preset stays listed — its directory still occupies the id, so a surface
   * must be able to show and delete it — but offering it for selection would
   * only defer this reason to a failed session start.
   */
  readonly broken?: string;
}
/** agent-preset-domain unary methods (the map key agentPreset.* of RpcMethodMap). */
interface AgentPresetsApi {
  /**
   * Lists every preset the deployment currently supplies, in root-precedence
   * order — the roots as configured, each root's own presets sorted by id,
   * and the first root to supply an id wins. The order is not globally
   * sorted: a user root's preset sits in that root's block, not among the
   * shipped ids.
   * An empty roster means the deployment composes no presets at all, and
   * every session shares the host composition. `authorable` reports whether
   * the deployment configures a root new presets can be written to, and
   * `hasDocument` whether `openDocument` can hand a preset directory to a
   * native opener — both deployment facts rather than per-preset ones, and
   * neither exposes a Host path.
   */
  list(request: RpcRequest<{}>): Promise<RpcResponse<{
    presets: readonly AgentPresetEntry[];
    authorable: boolean;
    hasDocument: boolean;
  }>>;
  /**
   * Recompose one session's agent from a different preset.
   *
   * Allowed only while the session is blank — no turn has run. Once a
   * conversation starts, its history was produced under that preset's tools,
   * and swapping them would leave logged tool calls the new composition cannot
   * make; the attempt answers `agent-preset-locked`.
   */
  select(request: RpcRequest<{
    sessionId: SessionId;
    agentPreset: string;
  }>): Promise<RpcResponse<{
    agentPreset: string;
  }>>;
  /**
   * Read one preset's composition text, for the read-only viewer.
   *
   * Privileged: a composition names the plugins a session runs, so reading
   * one is reconnaissance.
   */
  read(request: RpcRequest<{
    agentPreset: string;
  }>): Promise<RpcResponse<{
    agentPreset: string;
    trust: 'system' | 'user';
    content: string;
    name?: string;
    description?: string;
  }>>;
  /**
   * Create a locally authored preset by copying an existing one whole.
   *
   * The only authoring write. No composition text and no path crosses the
   * wire: `from` and `agentPreset` are ids the Host resolves against its own
   * roots, so a copy is exactly as loadable as its source and grants nothing
   * the roster did not already carry. The copy keeps the source's description
   * (the file is the author's to edit afterwards) but not its name — `name`
   * here or the id fallback is what distinguishes the rows.
   */
  copy(request: RpcRequest<{
    from: string;
    agentPreset: string;
    name?: string;
  }>): Promise<RpcResponse<{
    agentPreset: string;
  }>>;
  /**
   * Hand one locally authored preset's DIRECTORY to the platform opener, for
   * editing the files that are now the only composition editor. The request
   * carries an id, never a path — the Host resolves it — so no browser
   * payload can select an arbitrary filesystem target. Where the deployment
   * has no native opener (`hasDocument: false` on `list`), the reply carries
   * the resolved directory for the surface to show as text instead. Shipped
   * presets are refused: their install is not the user's to manage.
   */
  openDocument(request: RpcRequest<{
    agentPreset: string;
  }>, signal: AbortSignal): Promise<RpcResponse<{
    opened: true;
  } | {
    opened: false;
    path: string;
  }>>;
  /** Delete a locally authored preset. Shipped presets are refused. */
  remove(request: RpcRequest<{
    agentPreset: string;
  }>): Promise<RpcResponse<{}>>;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-host-apiproxy@0.1.0-rc.6_75a967487b33638129ad9d469d84f0d5/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api/skills.d.ts
/** Skill catalog row (wire projection of the host SkillSummary; provider/source vocabulary stays host-side). */
interface SkillEntry {
  /** Kebab-case identifier the user references as `/name` in the composer. */
  readonly name: string;
  /** Short routing description. */
  readonly description: string;
  /** Optional extra routing guidance. */
  readonly whenToUse?: string;
  /** False marks a user-only skill (`disable-model-invocation`): invocable here, absent from the model catalog. */
  readonly modelInvocable: boolean;
}
/**
 * Skill-domain unary methods (the map key skill.* of RpcMethodMap). Listing
 * is the domain's only RPC: invocation itself is a plain `session.prompt`
 * whose leading `/name` token the host recognizes at the pre-step boundary
 * (`dsh-tool-skill` injects the rendered body there), so every client shares
 * one deterministic path with no dedicated invocation wire.
 */
interface SkillsApi {
  /** Lists the user-invocable skill catalog for the session's project. */
  list(request: RpcRequest<{
    sessionId: SessionId;
  }>): Promise<RpcResponse<{
    skills: readonly SkillEntry[];
  }>>;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-host-apiproxy@0.1.0-rc.6_75a967487b33638129ad9d469d84f0d5/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api/subagents.d.ts
/** Complete durable direct-child catalog row. */
type SubagentListEntry = {
  kind: 'child';
  id: SessionId;
  /** Whether the child Agent driver is running at the Host sampling boundary. */
  activity: 'running' | 'inactive';
  /** Whether a direct descendant has durable `origin: 'subagent'`. */
  hasChildren: boolean;
} & ({
  mode: 'one-shot';
  label?: string;
} | {
  mode: 'continuable';
  label: string;
}) | {
  kind: 'diagnostic';
  id: SessionId;
  reason: 'corrupt' | 'unsupported' | 'unavailable';
};
/** Inbox identity returned once the continuation accepts one human message. */
interface SubagentPromptReceipt {
  messageId: MessageId;
}
/** Uniform acknowledgement that one interrupt request was admitted. */
interface SubagentInterruptReceipt {
  accepted: true;
}
/** Durable parent/child address that selects subagent transport in the client. */
type SubagentAddress = {
  parentSessionId: SessionId;
  childSessionId: SessionId;
} & ({
  mode: 'one-shot';
} | {
  mode: 'continuable';
});
/** Complete direct-child catalog plus the delivery-time parent availability hint. */
interface SubagentCatalog {
  entries: SubagentListEntry[];
  parentAvailable: boolean;
}
/** Subagent-domain unary methods. */
interface SubagentsApi {
  /**
   * Lists direct session-backed children without loading either side. Parent
   * availability is a hint; continuable prompt performs the authoritative
   * check.
   */
  list(request: RpcRequest<{
    parentSessionId: SessionId;
  }>, signal?: AbortSignal): Promise<RpcResponse<SubagentCatalog>>;
  /**
   * Reads one healthy catalog child's transcript — the in-memory snapshot of
   * a live child, the persisted log of a cold one — with ordinary
   * message-aligned pagination and render intents, without Agent activation.
   */
  history(request: RpcRequest<SubagentAddress & {
    beforeSeq?: number;
    maxMessages?: number;
  }>, signal?: AbortSignal): Promise<RpcResponse<{
    events: HistoryEntry[];
    hasMore: boolean;
    projections?: SessionProjectionsBlock;
  }>>;
  /**
   * Delivers human content to a continuable child through the exact live
   * parent's continuation owner. Success identifies the message accepted by
   * the child's FIFO inbox; later execution is independent of this request.
   * Optional browser-zone provenance is validated and logged on that message.
   */
  prompt(request: RpcRequest<Extract<SubagentAddress, {
    mode: 'continuable';
  }> & {
    content: ContentBlock[];
    /** Optional browser zone sampled for this exact human prompt. */
    clientTimeZone?: string;
  }>, signal: AbortSignal): Promise<RpcResponse<SubagentPromptReceipt>>;
  /**
   * Interrupts a live continuable child's current turn under the address's
   * durable direct-parent authority, without requiring a live parent Agent,
   * consulting the catalog, or resuming anything. Fire-and-return: `accepted`
   * acknowledges the admitted cancel signal, not target quiescence, so the
   * child may remain visibly running briefly. Unclaimed queued follow-ups are
   * kept and parked; an absent, idle, or already-completed target is likewise
   * `accepted`.
   */
  interrupt(request: RpcRequest<Extract<SubagentAddress, {
    mode: 'continuable';
  }>>): Promise<RpcResponse<SubagentInterruptReceipt>>;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-host-apiproxy@0.1.0-rc.6_75a967487b33638129ad9d469d84f0d5/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api/goals.d.ts
/** Identifies one goal across its durable revisions. */
type GoalId = Branded<'GoalId'>;
/** Compare-and-set identity for one exact goal revision. */
interface GoalRef {
  readonly id: GoalId;
  readonly revision: number;
}
/**
 * Goal-domain unary methods. Every mutation resolves an ordinary session's
 * Agent and applies one CAS-guarded verb; session-backed subagents reject with
 * `agent-busy`.
 */
interface GoalsApi {
  /** Create and arm a goal. */
  create(request: RpcRequest<{
    sessionId: SessionId;
    objective: string;
    maxGoalRounds?: number;
  }>): Promise<RpcResponse<{
    ref: GoalRef;
  }>>;
  /** Edit objective and/or round cap without changing phase. */
  edit(request: RpcRequest<{
    sessionId: SessionId;
    ref: GoalRef;
    objective?: string;
    maxGoalRounds?: number;
  }>): Promise<RpcResponse<{
    ref: GoalRef;
  }>>;
  /** Pause an active goal and disarm automatic continuation. */
  pause(request: RpcRequest<{
    sessionId: SessionId;
    ref: GoalRef;
  }>): Promise<RpcResponse<{
    ref: GoalRef;
  }>>;
  /** Resume and arm a stopped goal. */
  resume(request: RpcRequest<{
    sessionId: SessionId;
    ref: GoalRef;
  }>): Promise<RpcResponse<{
    ref: GoalRef;
  }>>;
  /** Mark a current non-complete goal complete and disarm it. */
  complete(request: RpcRequest<{
    sessionId: SessionId;
    ref: GoalRef;
  }>): Promise<RpcResponse<{
    ref: GoalRef;
  }>>;
  /** Clear the current goal while retaining a durable tombstone and history. */
  clear(request: RpcRequest<{
    sessionId: SessionId;
    ref: GoalRef;
  }>): Promise<RpcResponse<{
    cleared: true;
  }>>;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-host-apiproxy@0.1.0-rc.6_75a967487b33638129ad9d469d84f0d5/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api/settings.d.ts
/** One schema-declared secret slot inside a redacted namespace value. */
interface SettingsSecretView {
  /** Path from the section root to the removed field. */
  path: string[];
  /** Whether the slot currently holds a value (the value itself never rides). */
  set: boolean;
}
/** Wire view of one registered settings namespace. */
interface SettingsNamespaceView {
  /** Namespace key (`llm-deepseek`, `llm-pi-ai`, …). */
  ns: string;
  /** Serialized schemastery schema envelope (`schema.toJSON()`); rehydrate with `new Schema(json)`. */
  schema: unknown;
  /** Redacted resolved value (schema defaults → composition base → user layer). */
  value: unknown;
  /** Redacted composition base layer, when the registrant declared one. */
  base?: unknown;
  /** Redacted raw user section, when one exists; a field's presence here marks it user-overridden. */
  user?: unknown;
  /** When the owner applies changes. */
  applies: 'live' | 'restart';
  /** Every schema-declared secret slot with its configured state. */
  secrets: SettingsSecretView[];
  /**
   * Monotonic revision of the raw user section this view was read at. Send it
   * back as `expectedRevision` on a write so a stale editor is refused rather
   * than silently overwriting a concurrent change.
   */
  revision: number;
}
/**
 * One path-addressed edit carried by `settings.mutate`. `set` writes the
 * value at the path (creating intermediate objects); `unset` removes it. The
 * empty path addresses the section root.
 */
type SettingsPathOpView = {
  op: 'set';
  path: string[];
  value: unknown;
} | {
  op: 'unset';
  path: string[];
};
/** Settings-domain unary methods (the map keys settings.* of RpcMethodMap). */
interface SettingsApi {
  /**
   * Describe every registered namespace: redacted layered values plus the
   * serialized schema a client renders its form from. `hasDocument` reports
   * whether a file-backed provider owns a local document without exposing its
   * Host path. This method is loopback-only; `writable: false` (read-only
   * provider) tells the client to disable every write control.
   */
  describe(request: RpcRequest<{}>): Promise<RpcResponse<{
    writable: boolean;
    hasDocument: boolean;
    namespaces: SettingsNamespaceView[];
  }>>;
  /**
   * Materialize the configured local document when absent and ask the Host to
   * hand it to the platform text-document opener. macOS forces a text editor;
   * Linux and Windows use the desktop file association. The request carries
   * no path, so the browser cannot choose an arbitrary Host filesystem target.
   */
  openDocument(request: RpcRequest<{}>, signal: AbortSignal): Promise<RpcResponse<{
    opened: true;
  }>>;
  /**
   * Merge a patch into one namespace's user layer (validate → persist →
   * commit). Secret-role fields may be INCLUDED in the patch (write-only
   * direction); a form that leaves a secret untouched simply omits it and the
   * merge preserves the stored value. Responds with the namespace's new
   * redacted view; a schema or storage rejection is `settings-rejected`.
   */
  update(request: RpcRequest<{
    ns: string;
    patch: object;
    expectedRevision?: number;
  }>): Promise<RpcResponse<SettingsNamespaceView>>;
  /**
   * Replace one namespace's user section wholesale — the removal/reset path a
   * merge cannot express (`section: {}` resets to composition defaults). Keys
   * absent from `section` are dropped, secrets included: a client must first
   * fold the descriptor's `user` layer (and re-supply any secret it wants to
   * keep) or accept the reset.
   */
  replace(request: RpcRequest<{
    ns: string;
    section: object;
    expectedRevision?: number;
  }>): Promise<RpcResponse<SettingsNamespaceView>>;
  /**
   * Apply path-addressed edits to one namespace's user section, resolved
   * against the section as stored — NOT against whatever the caller last
   * read. This is the removal path for any client holding the redacted
   * descriptor: it names the field it means, so a secret the wire never
   * returned cannot be deleted as a side effect. `replace` remains the
   * deliberate wholesale reset.
   */
  mutate(request: RpcRequest<{
    ns: string;
    ops: SettingsPathOpView[];
    expectedRevision?: number;
  }>): Promise<RpcResponse<SettingsNamespaceView>>;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-host-apiproxy@0.1.0-rc.6_75a967487b33638129ad9d469d84f0d5/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api/credentials.d.ts
/** Wire view of one credential reference's state. */
interface CredentialView {
  /** Whether any layer currently supplies a non-empty value. */
  configured: boolean;
  /** Winning layer when configured (`env`, `file`, …); provider vocabulary. */
  source?: string;
  /** Whether `credentials.set`/`credentials.unset` can affect this reference. */
  writable: boolean;
}
/** Credentials-domain unary methods (the map keys credentials.* of RpcMethodMap). */
interface CredentialsApi {
  /**
   * Describe the named references (batch): configured state, winning source,
   * and writability — never values. An invalid reference name is a
   * `bad-request`; an unknown-but-valid one describes as unconfigured.
   */
  describe(request: RpcRequest<{
    refs: string[];
  }>): Promise<RpcResponse<{
    credentials: Record<string, CredentialView>;
  }>>;
  /**
   * Store one credential value in the writable layer. Rejected with
   * `credential-rejected` while a read-only layer (the live environment)
   * shadows the reference — the write would otherwise appear to succeed while
   * resolution keeps returning the shadowing value.
   */
  set(request: RpcRequest<{
    ref: string;
    value: string;
  }>): Promise<RpcResponse<{}>>;
  /**
   * Remove one credential from the writable layer; same shadowing rejection
   * as `set`. Unsetting an absent reference succeeds (idempotent).
   */
  unset(request: RpcRequest<{
    ref: string;
  }>): Promise<RpcResponse<{}>>;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-host-apiproxy@0.1.0-rc.6_75a967487b33638129ad9d469d84f0d5/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api/llm.d.ts
/** Wire view of one configurable provider. */
interface ConfigurableProviderView {
  /** Provider route key (`deepseek-official`, `openai`, …). */
  provider: string;
  /** Human-readable name for configuration surfaces. */
  displayName: string;
  /** Settings namespace whose section configures this provider. */
  settingsNs: string;
  /** Path from that section's root to the provider's profile object (empty = whole section). */
  settingsPath: string[];
  /** Whether the route is currently registered (its models are requestable). */
  active: boolean;
  /**
   * Whether the owning adapter knows this route only because configuration
   * declared it. Absent when the adapter draws no such distinction, so a
   * surface must treat absence as "unknown", not as "shipped".
   */
  declared?: boolean;
}
/** Llm-domain unary methods (the map keys llm.* of RpcMethodMap). */
interface LlmApi {
  /**
   * List every configurable provider with its live/dormant state, in
   * directory declaration order. Routes registered outside the directory
   * (an adapter that never declared configurability) are appended with their
   * registration identity and no settings address.
   */
  providers(request: RpcRequest<{}>): Promise<RpcResponse<{
    providers: ConfigurableProviderView[];
  }>>;
  /**
   * Host-scoped model catalog over every registered provider route: the
   * settings surface's models view, needing no session. Per-provider listing
   * failures ride `failures` without failing the sound groups.
   */
  models(request: RpcRequest<{}>): Promise<RpcResponse<{
    groups: ModelProviderGroup[];
    failures: ModelCatalogFailure[];
  }>>;
  /**
   * Interrogate a provider endpoint the configuration surface is still
   * drafting, and return the models it advertises for the user to adopt.
   *
   * The payload is the draft, not a stored route: `settingsNs` selects the
   * adapter family that answers, and the rest comes from the form. `provider`
   * names the route being edited when there is one — an adapter that already
   * describes that route answers from its own registry, with better metadata
   * and no network call, and needs no endpoint. A route it does not describe is
   * asked over the wire, which is what `baseURL`, `api`, and `apiKey` are for.
   *
   * Nothing is written — the reply is candidates, and only a later
   * `settings.mutate` decides what a route serves. `apiKey` is accepted here
   * but never stored or returned; a provider whose key is already stored omits
   * it and the endpoint answers unauthenticated or refuses.
   */
  discoverModels(request: RpcRequest<{
    settingsNs: string;
    provider?: string;
    baseURL?: string;
    api?: string;
    apiKey?: string;
  }>, signal?: AbortSignal): Promise<RpcResponse<{
    models: DiscoveredModelView[];
  }>>;
}
/** Wire view of one model an interrogated endpoint advertises. */
interface DiscoveredModelView {
  /** Model id the endpoint accepts. */
  id: string;
  /** Human-readable name when the endpoint supplies one. */
  name?: string;
  /** Maximum combined request and response context, when disclosed. */
  contextWindow?: number;
  /** Maximum output tokens, when disclosed. */
  maxTokens?: number;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-host-apiproxy@0.1.0-rc.6_75a967487b33638129ad9d469d84f0d5/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api/downloads.d.ts
/** Host-only download surfaces (no wire envelope; absent from IApiClient). */
interface DownloadsApi {
  /**
   * Stream one session-log ZIP — the root artifact verbatim plus each subagent
   * descendant's — as an attachment response. The carrier's GET route answers
   * this directly; the browser never calls it.
   * @param request - the root session id and whether to include descendants.
   * @param signal - cancellation for the underlying reads.
   * @returns the ZIP attachment response; missing services answer 500 and a
   * missing root session 404 before any byte is produced.
   */
  sessionLog(request: {
    sessionId: SessionId;
    includeDescendants?: boolean;
  }, signal: AbortSignal): Promise<Response>;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-host-apiproxy@0.1.0-rc.6_75a967487b33638129ad9d469d84f0d5/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api/index.d.ts
/** Root interface of the unified API. New client-request domain = one new file pair + one field here + one map row. */
interface ApiProxy {
  sessions: SessionsApi;
  subagents: SubagentsApi;
  host: HostApi;
  workspace: WorkspaceApi;
  skills: SkillsApi;
  agentPresets: AgentPresetsApi;
  events: EventsApi;
  goals: GoalsApi;
  settings: SettingsApi;
  credentials: CredentialsApi;
  llm: LlmApi;
  /** Host-only download surfaces (GET, no wire envelope); absent from IApiClient. */
  downloads: DownloadsApi;
  /**
   * Response entry for server requests; not a domain method.
   * @param message - Client response carrying the server request's rpcId.
   * @returns Transport receipt for the response delivery.
   */
  respond(message: ClientResponse): Promise<RpcReceipt>;
}
//#endregion
//#region src/bridge/rpc.d.ts
/** The dsh api surface the bridge actually consumes. */
interface BridgeApi {
  sessions: Pick<ApiProxy['sessions'], 'list' | 'search' | 'create' | 'fork' | 'history' | 'models' | 'rename' | 'prompt' | 'cancel' | 'selectModel'>;
  host: Pick<ApiProxy['host'], 'describe'>;
  llm: Pick<ApiProxy['llm'], 'models'>;
  agentPresets: Pick<ApiProxy['agentPresets'], 'list' | 'select'>;
  goals: Pick<ApiProxy['goals'], 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'clear'>;
  skills: Pick<ApiProxy['skills'], 'list'>;
  events: Pick<ApiProxy['events'], 'mux' | 'host'>;
  respond: ApiProxy['respond'];
  /**
   * dsh human-command registry (`ctx.commands`). Optional so unit fixtures and
   * older hosts without the registry still type-check; the oc profile always
   * mounts it through dsh-base.
   */
  commands?: BridgeCommands;
  /** Live agent registry (`ctx.agents`), used to address `/compact`. */
  agents?: BridgeAgents;
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
  execute(agent: unknown, line: string, signal: AbortSignal): Promise<BridgeCommandExecution | undefined>;
}
interface BridgeAgents {
  get(sessionId: string): unknown;
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
  /** Mirror of each session's dsh pending inbox (next-turn / next-step). */
  readonly inboxProjections: Map<string, InboxProjection>;
  /** Message ids already surfaced to the TUI as queued user messages. */
  readonly presentQueuedIds: Set<string>;
  /** dsh user message ids already echoed by the prompt route (broadcast). */
  private readonly broadcastDshIds;
  /** TUI-generated `messageID`s from prompt submissions, FIFO per session. */
  private readonly promptMessageIds;
  /** dsh user message id -> TUI prompt id (kept so history echoes match). */
  private readonly dshPromptMessageIds;
  /** Bridge-generated assistant message ids keyed by user message id. */
  private readonly assistantIdsByUser;
  /** dsh assistant message id -> bridge assistant id (history echo match). */
  private readonly dshAssistantIds;
  sessionListCache?: {
    items: SessionSummary[];
    at: number;
  };
  /** In-flight session.list RPC shared by concurrent callers (incl. prefetch). */
  sessionListLoading?: Promise<SessionSummary[]>;
  private sessionListGeneration;
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
  getSessionListCache(ttlMs: number): SessionSummary[] | undefined;
  setSessionListCache(items: SessionSummary[]): void;
  getHistoryCache(key: string, ttlMs: number): CachedHistory | undefined;
  setHistoryCache(key: string, value: CachedHistory): void;
  getHistoryLoading(key: string): Promise<CachedHistory> | undefined;
  setHistoryLoading(key: string, promise: Promise<CachedHistory>): void;
  clearHistoryLoading(key: string, promise: Promise<CachedHistory>): void;
  historyGeneration(key: string): number;
  listGeneration(): number;
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
  registerPromptMessageId(sessionId: string, promptId: string): void;
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
    content: readonly unknown[];
    source: {
      kind: string;
    };
  }>, enqueuedAt: number): InboxSpliceOutcome;
  /**
   * Initialize the inbox projection from the `session/queue` snapshot dsh
   * broadcasts when an SSE mux subscription starts. Later queue snapshots are
   * ignored: they cannot distinguish a claimed message from a cancelled one,
   * so incremental `agent/inbox/spliced` events own the live diff.
   * Returns only the messages that were not yet surfaced to the TUI.
   */
  initializeInboxProjection(sessionId: string, items: Array<{
    placement: 'queued' | 'steering' | 'context';
    message: {
      id: string;
      content: readonly unknown[];
      source: {
        kind: string;
      };
    };
  }>, enqueuedAt: number): InboxSpliceOutcome;
  setSessionTitle(sessionId: string, title: unknown): void;
  sessionTitleFor(sessionId: string): string | undefined;
  setSessionAgent(sessionId: string, agent: string): void;
  sessionAgentFor(sessionId: string): string | undefined;
  /** Record that the user submitted new input during this run. */
  markInput(): void;
  setCurrentSession(sessionId: string): void;
  /** Agent-preset-lock notices already shown (dedupe per session + agent). */
  private readonly lockedAgentNotices;
  lockedAgentNoticeSeen(sessionId: string, agent: string): boolean;
  markLockedAgentNotice(sessionId: string, agent: string): void;
  private static lockedAgentKey;
  registerApproval(entry: PermissionEntry): PermissionEntry;
  registerQuestion(entry: QuestionEntry): QuestionEntry;
  permissionByOpenCodeId(id: string): PermissionEntry | undefined;
  permissionByApprovalId(approvalId: string): PermissionEntry | undefined;
  questionByOpenCodeId(id: string): QuestionEntry | undefined;
  questionByRpcId(rpcId: string): QuestionEntry | undefined;
  removePermission(opencodeId: string): void;
  removeQuestion(opencodeId: string): void;
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
//#region src/bridge/sse.d.ts
interface SseClient {
  id: number;
  res: ServerResponse;
  controller: AbortController;
  closed: boolean;
}
/** Registry of active SSE connections plus the encoder/cleanup logic. */
declare class SseHub {
  private log;
  private clients;
  private nextId;
  constructor(log: (message: string) => void);
  add(res: ServerResponse): SseClient;
  remove(client: SseClient): void;
  send(client: SseClient, event: BridgeGlobalEvent): void;
  /** Fan one event batch out to every connected SSE client. */
  broadcast(events: BridgeGlobalEvent[]): void;
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
  body: unknown;
}
interface BridgeRouteContext {
  api: BridgeApi;
  cwd: string;
  state: InteractionState;
  log(message: string): void;
  hub: SseHub;
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
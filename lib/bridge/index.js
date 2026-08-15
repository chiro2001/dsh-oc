import { Service } from "@deepseek-ai/cordis";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
//#region src/bridge/rpc.ts
var RpcCallError = class extends Error {
	error;
	code;
	details;
	constructor(error) {
		super(error.message);
		this.error = error;
		this.name = "RpcCallError";
		this.code = error.code;
		this.details = error.details;
	}
};
const DOMAIN_ALIASES = { session: "sessions" };
function resolveMethod(api, method) {
	const dot = method.indexOf(".");
	const domain = dot === -1 ? method : method.slice(0, dot);
	const name = dot === -1 ? method : method.slice(dot + 1);
	const holder = api[DOMAIN_ALIASES[domain] ?? domain];
	const fn = holder?.[name];
	if (typeof fn !== "function") throw new Error(`unknown dsh rpc method "${method}"`);
	return fn.bind(holder);
}
function brandRpcId(value) {
	return value;
}
/**
* Call a dsh unary RPC with a freshly minted rpcId, unwrapping the
* `RpcResponse.result` envelope. A failed result becomes `RpcCallError`.
*/
async function call(api, method, payload, signal) {
	const request = {
		rpcId: brandRpcId(randomUUID()),
		payload
	};
	const fn = resolveMethod(api, method);
	const response = await (signal === void 0 ? fn(request) : fn(request, signal));
	if (!response.result.ok) throw new RpcCallError(response.result.error);
	return response.result.value;
}
/** Send a client-response for an approval request (echoing the mux rpcId). */
async function respondApproval(api, rpcId, sessionId, approvalId, outcome) {
	const value = {
		sessionId,
		approvalId,
		outcome
	};
	return api.respond(clientResponse(rpcId, {
		ok: true,
		value
	}));
}
/** Send a client-response answering a question batch. */
async function respondQuestion(api, rpcId, sessionId, answers) {
	const value = {
		sessionId,
		answer: { answers }
	};
	return api.respond(clientResponse(rpcId, {
		ok: true,
		value
	}));
}
/** Send a cancelled client-response (used by question reject). */
async function cancelQuestion(api, rpcId) {
	const message = clientResponse(rpcId, {
		ok: false,
		error: {
			code: "cancelled",
			message: "cancelled by user",
			details: {}
		}
	});
	return api.respond(message);
}
function clientResponse(rpcId, result) {
	return {
		type: "client-response",
		rpcId: brandRpcId(rpcId),
		result
	};
}
//#endregion
//#region src/bridge/errors.ts
var HttpError = class extends Error {
	status;
	body;
	constructor(status, body) {
		super(body.message);
		this.status = status;
		this.body = body;
		this.name = "HttpError";
	}
};
function envelope(name, message, data = {}) {
	return {
		name,
		message,
		data: {
			message,
			...data
		}
	};
}
function notFound(message, data) {
	return new HttpError(404, envelope("NotFoundError", message, data));
}
function notImplemented(message) {
	return new HttpError(501, envelope("NotFoundError", message));
}
function badRequest(message, data) {
	return new HttpError(400, envelope("BadRequest", message, data));
}
function conflict(message, data) {
	return new HttpError(409, envelope("ConflictError", message, data));
}
function internalError(message, data) {
	return new HttpError(500, envelope("InternalServerError", message, data));
}
/** Error codes the client can correct by re-issuing the request. */
const CLIENT_FIXABLE = /* @__PURE__ */ new Set([
	"bad-request",
	"title-invalid",
	"command-error",
	"unknown-command",
	"model-unavailable",
	"agent-preset-not-found",
	"agent-preset-invalid",
	"agent-preset-read-only",
	"agent-preset-locked",
	"agent-preset-conflict",
	"settings-rejected",
	"settings-not-exposed",
	"settings-conflict",
	"credential-rejected",
	"attachment-error",
	"directory-unreadable",
	"directory-exists",
	"directory-create-failed",
	"queue-item-not-found",
	"invalid-time-zone",
	"workspace-invalid-path",
	"workspace-name-conflict",
	"model-discovery-failed"
]);
/** Codes that mean the session/turn is currently owned by another actor. */
const CONFLICT_CODES = /* @__PURE__ */ new Set([
	"agent-busy",
	"fork-unavailable",
	"steer-unavailable",
	"session-conflict",
	"subagent-parent-unavailable",
	"subagent-not-found",
	"subagent-catalog-diagnostic",
	"subagent-not-resumable",
	"subagent-unauthorized",
	"subagent-delivery-unavailable"
]);
/**
* Map a dsh RPC error to an opencode-compatible HTTP error. The dsh `code`
* and `details` are preserved inside `data` so diagnostics never disappear.
*/
function rpcErrorToHttp(error) {
	const data = {
		code: error.code,
		details: error.details
	};
	if (error.code === "session-not-found") return notFound(error.message, data);
	if (CONFLICT_CODES.has(error.code)) return conflict(error.message, data);
	if (CLIENT_FIXABLE.has(error.code)) return badRequest(error.message, data);
	return internalError(error.message, data);
}
//#endregion
//#region src/bridge/convert/common.ts
const OPENCODE_VERSION = "1.18.18";
const DEFAULT_AGENT = "build";
/**
* External provider identity. dsh calls its official route
* `deepseek-official`; opencode expects `deepseek` with display name
* `DeepSeek`. Every other provider id passes through unchanged.
*/
function externalProviderId(providerId) {
	return providerId === "deepseek-official" ? "deepseek" : providerId;
}
function externalProviderName(providerId, displayName) {
	if (providerId === "deepseek-official") return "DeepSeek";
	return displayName ?? providerId;
}
/** Stable short hash used as the opencode project id. */
function projectIdFor(directory) {
	return createHash("sha256").update(directory).digest("hex").slice(0, 16);
}
function stableId(seed) {
	return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}
function safeJsonParse(raw) {
	try {
		const value = JSON.parse(raw);
		return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}
function textFromBlocks(content) {
	return content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}
//#endregion
//#region src/bridge/convert/session.ts
function sessionTitleFrom(summary) {
	const title = (summary.projections?.values)?.title;
	return typeof title === "string" ? title : "";
}
/**
* Convert a dsh `SessionSummary` into the opencode v2 `Session` shape
* (a structural superset of the v1 `Session`).
*/
function convertSessionSummary(summary, options) {
	const directory = summary.cwd ?? options.cwd;
	const createdAt = options.createdAt ?? summary.updatedAt;
	const title = sessionTitleFrom(summary);
	return {
		id: String(summary.sessionId),
		slug: String(summary.sessionId),
		projectID: projectIdFor(directory),
		directory,
		parentID: summary.parentSessionId === void 0 ? void 0 : String(summary.parentSessionId),
		title,
		agent: summary.agentPreset ?? "build",
		version: OPENCODE_VERSION,
		time: {
			created: createdAt,
			updated: summary.updatedAt
		}
	};
}
/** Convert a summary into the v2 `/api/session` `SessionV2Info` shape. */
function convertSessionSummaryV2(summary, options) {
	const directory = summary.cwd ?? options.cwd;
	const createdAt = options.createdAt ?? summary.updatedAt;
	return {
		id: String(summary.sessionId),
		parentID: summary.parentSessionId === void 0 ? void 0 : String(summary.parentSessionId),
		projectID: projectIdFor(directory),
		agent: summary.agentPreset ?? "build",
		cost: 0,
		tokens: {
			input: 0,
			output: 0,
			reasoning: 0,
			cache: {
				read: 0,
				write: 0
			}
		},
		time: {
			created: createdAt,
			updated: summary.updatedAt
		},
		title: sessionTitleFrom(summary),
		location: { directory }
	};
}
/** Minimal session view used by SSE when only the session id is known. */
function minimalSession(sessionId, options) {
	const directory = options.cwd;
	const created = options.createdAt ?? Date.now();
	return {
		id: sessionId,
		slug: sessionId,
		projectID: projectIdFor(directory),
		directory,
		title: options.title ?? "",
		agent: DEFAULT_AGENT,
		version: OPENCODE_VERSION,
		time: {
			created,
			updated: Date.now()
		}
	};
}
/** Minimal v2 session view used when only the session id is known. */
function minimalSessionV2(sessionId, options) {
	const directory = options.cwd;
	const created = options.createdAt ?? Date.now();
	return {
		id: sessionId,
		projectID: projectIdFor(directory),
		cost: 0,
		tokens: {
			input: 0,
			output: 0,
			reasoning: 0,
			cache: {
				read: 0,
				write: 0
			}
		},
		time: {
			created,
			updated: Date.now()
		},
		title: options.title ?? "",
		location: { directory }
	};
}
//#endregion
//#region src/bridge/convert/tool.ts
function resultText(content) {
	return textFromBlocks(content.flatMap((block) => block.type === "tool-result" ? block.content : [block]));
}
/** A `tool/call` event alone becomes a pending ToolPart. */
function pendingToolPart(call, options) {
	return {
		id: `tool:${call.callId}`,
		sessionID: options.sessionID,
		messageID: options.messageID,
		type: "tool",
		callID: call.callId,
		tool: call.name,
		state: {
			status: "pending",
			input: safeJsonParse(call.arguments),
			raw: call.arguments
		},
		metadata: { start: options.time }
	};
}
/** A `tool/result` success event becomes a completed ToolPart. */
function completedToolPart(call, result, options) {
	return {
		id: `tool:${call.callId}`,
		sessionID: options.sessionID,
		messageID: options.messageID,
		type: "tool",
		callID: call.callId,
		tool: call.name,
		state: {
			status: "completed",
			input: safeJsonParse(call.arguments),
			output: resultText(result.content),
			title: call.name,
			metadata: result.meta === void 0 ? {} : { meta: result.meta },
			time: {
				start: options.time,
				end: result.time
			}
		}
	};
}
/** A `tool/result` with an error becomes an error ToolPart. */
function errorToolPart(call, result, options) {
	const message = result.error?.name ?? result.error?.code ?? "tool failed";
	return {
		id: `tool:${call.callId}`,
		sessionID: options.sessionID,
		messageID: options.messageID,
		type: "tool",
		callID: call.callId,
		tool: call.name,
		state: {
			status: "error",
			input: safeJsonParse(call.arguments),
			error: message,
			time: {
				start: options.time,
				end: result.time
			}
		}
	};
}
//#endregion
//#region src/bridge/convert/message.ts
const ZERO_TOKENS = {
	input: 0,
	output: 0,
	reasoning: 0,
	cache: {
		read: 0,
		write: 0
	}
};
function usageTokens(usage) {
	if (!usage) return ZERO_TOKENS;
	return {
		input: usage.inputTokens,
		output: usage.outputTokens,
		reasoning: usage.reasoningTokens ?? 0,
		cache: {
			read: usage.cacheReadTokens ?? 0,
			write: usage.cacheWriteTokens ?? 0
		}
	};
}
function userMessageInfo(id, time, opts) {
	return {
		id,
		sessionID: opts.sessionId,
		role: "user",
		time: { created: time },
		agent: DEFAULT_AGENT,
		model: opts.defaultModel ?? {
			providerID: "deepseek",
			modelID: "deepseek-chat"
		}
	};
}
function assistantMessageInfo(message, time, parentID, opts, usage) {
	return {
		id: String(message.id),
		sessionID: opts.sessionId,
		role: "assistant",
		time: {
			created: time,
			completed: time
		},
		parentID,
		modelID: message.source.model,
		providerID: externalProviderId(message.source.provider),
		mode: DEFAULT_AGENT,
		path: {
			cwd: opts.cwd,
			root: opts.cwd
		},
		cost: 0,
		tokens: usageTokens(usage)
	};
}
function textPart(id, messageID, text, time, opts) {
	return {
		id,
		sessionID: opts.sessionId,
		messageID,
		type: "text",
		text,
		time: {
			start: time.start,
			end: time.end
		}
	};
}
/** Build the v1 text/reasoning/tool parts for one assistant message. */
function assistantPartsFromMessage(message, time, opts, blockStart) {
	const parts = [];
	const calls = /* @__PURE__ */ new Map();
	const messageID = String(message.id);
	message.content.forEach((block, index) => {
		const start = blockStart?.(index, block.type) ?? time;
		if (block.type === "text") parts.push(textPart(`${messageID}:${index}`, messageID, block.text, {
			start,
			end: time
		}, opts));
		else if (block.type === "reasoning") parts.push({
			id: `${messageID}:${index}`,
			sessionID: opts.sessionId,
			messageID,
			type: "reasoning",
			text: block.text,
			time: {
				start,
				end: time
			}
		});
		else if (block.type === "tool-call") {
			const call = {
				callId: String(block.id),
				name: block.name,
				arguments: block.arguments
			};
			calls.set(call.callId, call);
			parts.push(pendingToolPart(call, {
				sessionID: opts.sessionId,
				messageID,
				time
			}));
		} else opts.onSkip?.("assistant/message", `unhandled content block "${String(block.type)}"`);
	});
	return {
		parts,
		calls
	};
}
function userPartsFromMessage(messageId, content, time, opts) {
	const parts = [];
	content.forEach((block, index) => {
		if (block.type === "text") parts.push(textPart(`${messageId}:${index}`, messageId, block.text, {
			start: time,
			end: time
		}, opts));
		else if (block.type === "image") opts.onSkip?.("user/message", `image block skipped (${String(block.attachment.mediaType ?? "unknown")})`);
		else opts.onSkip?.("user/message", `unhandled content block "${String(block.type)}"`);
	});
	return parts;
}
function applyToolResultV1(entries, calls, event, opts) {
	const data = event.data;
	const callId = String(data.message.content[0]?.toolCallId ?? data.message.source.callId);
	const call = calls.get(callId);
	if (!call) {
		opts.onSkip?.("tool/result", `no matching tool/call for "${callId}"`);
		return;
	}
	const result = {
		callId,
		content: data.message.content,
		error: data.error,
		time: event.time,
		meta: data.meta
	};
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.info.role !== "assistant") continue;
		const index = entry.parts.findIndex((part) => part.type === "tool" && part.callID === callId);
		if (index === -1) continue;
		const replacement = data.error === void 0 ? completedToolPart(call, result, {
			sessionID: opts.sessionId,
			messageID: entry.info.id,
			time: event.time
		}) : errorToolPart(call, result, {
			sessionID: opts.sessionId,
			messageID: entry.info.id,
			time: event.time
		});
		entry.parts[index] = replacement;
		return;
	}
	opts.onSkip?.("tool/result", `no assistant message holds "${callId}"`);
}
/** Fold dsh history events into the v1 `{ info, parts }` message list. */
function convertMessagesV1(events, opts) {
	const entries = [];
	const calls = /* @__PURE__ */ new Map();
	const blockStarts = /* @__PURE__ */ new Map();
	let lastMessageId = "";
	for (const event of events) switch (event.type) {
		case "user/message": {
			const data = event.data;
			const id = String(data.id);
			entries.push({
				info: userMessageInfo(id, event.time, opts),
				parts: userPartsFromMessage(id, data.content, event.time, opts)
			});
			lastMessageId = id;
			break;
		}
		case "assistant/chunk": {
			const chunk = event.data.chunk;
			if (chunk.type === "block-start") blockStarts.set(`${event.data.turn}:${event.data.step}:${chunk.index}:${chunk.blockType}`, event.time);
			break;
		}
		case "assistant/message": {
			const data = event.data;
			const id = String(data.message.id);
			const { parts, calls: messageCalls } = assistantPartsFromMessage(data.message, event.time, opts, (index, blockType) => blockStarts.get(`${data.turn}:${data.step}:${index}:${blockType}`));
			for (const [callId, call] of messageCalls) calls.set(callId, call);
			entries.push({
				info: assistantMessageInfo(data.message, event.time, lastMessageId || id, opts, data.usage),
				parts
			});
			lastMessageId = id;
			break;
		}
		case "tool/call": {
			const data = event.data;
			calls.set(String(data.callId), {
				callId: String(data.callId),
				name: data.name,
				arguments: data.arguments
			});
			break;
		}
		case "tool/result": applyToolResultV1(entries, calls, event, opts);
	}
	return entries;
}
/** Single-event v1 conversion used by the SSE bridge. */
function userMessageFromEvent(event, opts) {
	const id = String(event.data.id);
	return {
		info: userMessageInfo(id, event.time, opts),
		parts: userPartsFromMessage(id, event.data.content, event.time, opts)
	};
}
/** Single-event v1 conversion used by the SSE bridge. */
function assistantMessageFromEvent(event, opts, blockStart) {
	const id = String(event.data.message.id);
	const { parts } = assistantPartsFromMessage(event.data.message, event.time, opts, blockStart);
	return {
		info: assistantMessageInfo(event.data.message, event.time, id, opts, event.data.usage),
		parts
	};
}
function toV2ModelRef(message) {
	return {
		id: message.source.model,
		providerID: externalProviderId(message.source.provider)
	};
}
function toV2Assistant(event, opts) {
	const data = event.data;
	const messageID = String(data.message.id);
	const content = [];
	const calls = /* @__PURE__ */ new Map();
	data.message.content.forEach((block, index) => {
		if (block.type === "text") {
			const part = {
				type: "text",
				id: `${messageID}:${index}`,
				text: block.text
			};
			content.push(part);
		} else if (block.type === "reasoning") content.push({
			type: "reasoning",
			id: `${messageID}:${index}`,
			text: block.text,
			time: {
				created: event.time,
				completed: event.time
			}
		});
		else if (block.type === "tool-call") {
			const call = {
				callId: String(block.id),
				name: block.name,
				arguments: block.arguments
			};
			calls.set(call.callId, call);
			const tool = {
				type: "tool",
				id: `tool:${call.callId}`,
				name: call.name,
				state: {
					status: "pending",
					input: call.arguments
				},
				time: { created: event.time }
			};
			content.push(tool);
		} else opts.onSkip?.("assistant/message", `unhandled v2 block "${String(block.type)}"`);
	});
	return {
		info: {
			id: messageID,
			time: {
				created: event.time,
				completed: event.time
			},
			type: "assistant",
			agent: DEFAULT_AGENT,
			model: toV2ModelRef(data.message),
			content,
			cost: 0,
			tokens: usageTokens(data.usage)
		},
		calls
	};
}
function applyToolResultV2(messages, state, calls, event, opts) {
	const data = event.data;
	const callId = String(data.message.content[0]?.toolCallId ?? data.message.source.callId);
	if (!calls.get(callId) || !state) {
		opts.onSkip?.("tool/result", `no matching v2 tool/call for "${callId}"`);
		return;
	}
	const text = textFromBlocks(data.message.content.flatMap((block) => block.type === "tool-result" ? block.content : [block]));
	const content = text.length === 0 ? [] : [{
		type: "text",
		text
	}];
	const tool = state.info.content.find((part) => part.type === "tool" && part.id === `tool:${callId}`);
	if (!tool) {
		opts.onSkip?.("tool/result", `no v2 tool part for "${callId}"`);
		return;
	}
	if (data.error !== void 0) tool.state = {
		status: "error",
		input: {},
		content: [],
		structured: {},
		error: {
			type: "unknown",
			message: data.error.name ?? data.error.code ?? "tool failed"
		}
	};
	else tool.state = {
		status: "completed",
		input: {},
		content,
		structured: {},
		result: void 0
	};
	tool.time = {
		...tool.time,
		completed: event.time
	};
}
/** Fold dsh history events into the v2 `SessionMessage[]` list. */
function convertMessagesV2(events, opts) {
	const messages = [];
	const calls = /* @__PURE__ */ new Map();
	let lastAssistant;
	for (const event of events) switch (event.type) {
		case "user/message": {
			const data = event.data;
			const message = {
				id: String(data.id),
				time: { created: event.time },
				text: textFromBlocks(data.content),
				type: "user"
			};
			messages.push(message);
			break;
		}
		case "assistant/message": {
			const state = toV2Assistant(event, opts);
			messages.push(state.info);
			for (const [callId, call] of state.calls) calls.set(callId, call);
			lastAssistant = state;
			break;
		}
		case "tool/call": {
			const data = event.data;
			calls.set(String(data.callId), {
				callId: String(data.callId),
				name: data.name,
				arguments: data.arguments
			});
			break;
		}
		case "tool/result": applyToolResultV2(messages, lastAssistant, calls, event, opts);
	}
	return messages;
}
//#endregion
//#region src/bridge/convert/model.ts
const DEFAULT_CONTEXT = 128e3;
const DEFAULT_OUTPUT = 8192;
/** Known dsh-official model capacities, matching dsh-llm-deepseek defaults. */
const DEEPSEEK_LIMITS = {
	"deepseek-v4-flash": {
		context: 1e6,
		output: 256e3
	},
	"deepseek-v4-pro": {
		context: 1e6,
		output: 256e3
	}
};
function limitFor(groupId, modelId) {
	if (groupId === "deepseek-official") {
		const known = DEEPSEEK_LIMITS[modelId];
		if (known) return known;
	}
	return {
		context: DEFAULT_CONTEXT,
		output: DEFAULT_OUTPUT
	};
}
/**
* Match opencode's DeepSeek naming for the official dsh route:
* `DeepSeek-V4-Flash` → `DeepSeek V4 Flash`.
*/
function modelNameFor(groupId, modelId, modelName) {
	if (groupId === "deepseek-official") return (modelName ?? modelId).replaceAll("-", " ");
	return modelName ?? modelId;
}
function v1Model(group, modelId, modelName) {
	const providerId = externalProviderId(group.id);
	const limit = limitFor(group.id, modelId);
	return {
		id: modelId,
		providerID: providerId,
		api: {
			id: providerId,
			url: "",
			npm: "@deepseek-ai/dsh"
		},
		name: modelNameFor(group.id, modelId, modelName),
		capabilities: {
			temperature: false,
			reasoning: true,
			attachment: false,
			toolcall: true,
			input: {
				text: true,
				audio: false,
				image: false,
				video: false,
				pdf: false
			},
			output: {
				text: true,
				audio: false,
				image: false,
				video: false,
				pdf: false
			}
		},
		cost: {
			input: 0,
			output: 0,
			cache: {
				read: 0,
				write: 0
			}
		},
		limit,
		status: "active",
		options: {},
		headers: {}
	};
}
/** `GET /config/providers` → `providers` array (v1 `Provider[]`). */
function convertToV1Providers(groups) {
	return groups.map((group) => {
		const models = {};
		for (const model of group.models) models[model.id] = v1Model(group, model.id, model.name);
		return {
			id: externalProviderId(group.id),
			name: externalProviderName(group.id, group.name),
			source: "api",
			env: [],
			options: {},
			models
		};
	});
}
/** `GET /provider` → the `{ all, default, connected }` catalog wrapper. */
function convertToProviderCatalog(groups) {
	return {
		all: groups.map((group) => {
			const providerId = externalProviderId(group.id);
			const models = {};
			for (const model of group.models) {
				const limit = limitFor(group.id, model.id);
				models[model.id] = {
					id: model.id,
					name: modelNameFor(group.id, model.id, model.name),
					release_date: "",
					attachment: false,
					reasoning: true,
					temperature: false,
					tool_call: true,
					limit,
					options: {},
					status: "active",
					provider: { npm: "@deepseek-ai/dsh" }
				};
			}
			return {
				api: "dsh",
				name: externalProviderName(group.id, group.name),
				env: [],
				id: providerId,
				npm: "@deepseek-ai/dsh",
				models
			};
		}),
		default: {},
		connected: groups.map((group) => externalProviderId(group.id))
	};
}
/** `GET /api/model` → `ModelV2Info[]`. */
function convertToV2Models(groups) {
	return groups.flatMap((group) => {
		const providerId = externalProviderId(group.id);
		return group.models.map((model) => {
			const limit = limitFor(group.id, model.id);
			return {
				id: model.id,
				providerID: providerId,
				name: modelNameFor(group.id, model.id, model.name),
				api: {
					id: providerId,
					type: "native",
					url: "",
					settings: {}
				},
				capabilities: {
					tools: true,
					input: ["text"],
					output: ["text"]
				},
				request: {
					headers: {},
					body: {}
				},
				variants: [],
				time: { released: 0 },
				cost: [{
					input: 0,
					output: 0,
					cache: {
						read: 0,
						write: 0
					}
				}],
				status: "active",
				enabled: true,
				limit
			};
		});
	});
}
/** `GET /api/provider` → `ProviderV2Info[]`. */
function convertToV2Providers(groups) {
	return groups.map((group) => ({
		id: externalProviderId(group.id),
		name: externalProviderName(group.id, group.name),
		api: {
			type: "native",
			url: "",
			settings: {}
		},
		request: {
			headers: {},
			body: {}
		}
	}));
}
//#endregion
//#region src/bridge/convert/permission.ts
/** Map a dsh tool name onto the opencode permission category. */
function permissionActionFromTool(toolName) {
	if (toolName === "bash" || toolName.endsWith(".bash") || toolName.endsWith("_bash")) return "bash";
	if (toolName === "edit" || toolName === "write" || toolName.endsWith(".edit") || toolName.includes("fs_")) return "edit";
	if (toolName === "read" || toolName.endsWith(".read")) return "read";
	if (toolName === "webfetch" || toolName.endsWith(".webfetch")) return "webfetch";
	if (toolName === "ask_user_question") return "unknown";
	return toolName;
}
/** Legacy `/permission` + `permission.asked` SSE shape. */
function toPermissionRequest(entry) {
	return {
		id: entry.opencodeId,
		sessionID: entry.sessionId,
		permission: permissionActionFromTool(entry.toolName),
		patterns: [],
		metadata: {
			toolName: entry.toolName,
			...entry.callId === void 0 ? {} : { callId: entry.callId },
			...entry.reason === void 0 ? {} : { reason: entry.reason }
		},
		always: [],
		...entry.callId === void 0 ? {} : { tool: {
			messageID: "",
			callID: entry.callId
		} }
	};
}
/** v2 `/api/session/{id}/permission` shape. */
function toPermissionV2(entry) {
	return {
		id: entry.opencodeId,
		sessionID: entry.sessionId,
		action: permissionActionFromTool(entry.toolName),
		resources: [],
		metadata: {
			toolName: entry.toolName,
			...entry.callId === void 0 ? {} : { callId: entry.callId },
			...entry.reason === void 0 ? {} : { reason: entry.reason }
		},
		...entry.callId === void 0 ? {} : { source: {
			type: "tool",
			messageID: "",
			callID: entry.callId
		} }
	};
}
//#endregion
//#region src/bridge/convert/question.ts
function toQuestionInfo(item) {
	return {
		question: item.question,
		header: item.header ?? "",
		options: (item.options ?? []).map((option) => ({
			label: option.label,
			description: option.description ?? ""
		})),
		...item.multiSelect === void 0 ? {} : { multiple: item.multiSelect }
	};
}
/** Legacy `/question` + `question.asked` SSE shape. */
function toQuestionRequest(entry) {
	return {
		id: entry.opencodeId,
		sessionID: entry.sessionId,
		questions: entry.items.map(toQuestionInfo)
	};
}
/** v2 `/api/session/{id}/question` shape. */
function toQuestionV2(entry) {
	return {
		id: entry.opencodeId,
		sessionID: entry.sessionId,
		questions: entry.items.map((item) => ({
			question: item.question,
			header: item.header ?? "",
			options: (item.options ?? []).map((option) => ({
				label: option.label,
				description: option.description ?? ""
			})),
			...item.multiSelect === void 0 ? {} : { multiple: item.multiSelect }
		}))
	};
}
/**
* Map opencode answers (labels in question order) back to dsh answer items.
* dsh asks one batch; opencode answers each question positionally.
*/
function answersToDsh(entry, answers) {
	return entry.items.map((item, index) => {
		const selected = answers[index] ?? [];
		return {
			id: item.id,
			selected
		};
	});
}
//#endregion
//#region src/bridge/convert/todo.ts
const PRIORITY = /* @__PURE__ */ new Set([
	"high",
	"medium",
	"low"
]);
/**
* Convert dsh todo projection/`todo/write` items into opencode `Todo[]`.
* dsh items carry no id or priority, so both get stable defaults.
*/
function convertTodos(value) {
	if (!Array.isArray(value)) return [];
	const todos = [];
	for (const raw of value) {
		if (raw === null || typeof raw !== "object") continue;
		const item = raw;
		if (typeof item.content !== "string") continue;
		const status = item.status === "pending" || item.status === "in_progress" || item.status === "completed" ? item.status : "pending";
		const priority = typeof item.priority === "string" && PRIORITY.has(item.priority) ? item.priority : "medium";
		todos.push({
			content: item.content,
			status,
			priority,
			id: typeof item.id === "string" ? item.id : stableId(`${item.content}\0${status}`)
		});
	}
	return todos;
}
//#endregion
//#region src/bridge/events.ts
function makeEvent(directory, type, properties, project) {
	return {
		directory,
		...project === void 0 ? {} : { project },
		payload: {
			id: randomUUID(),
			type,
			properties,
			data: properties
		}
	};
}
function directoryFor(sessionId, deps) {
	return deps.state.sessionDirectories.get(sessionId) ?? deps.cwd;
}
function messageOptions(sessionId, deps) {
	return {
		sessionId,
		cwd: deps.cwd,
		...deps.defaultModel === void 0 ? {} : { defaultModel: deps.defaultModel },
		onSkip: (eventType, reason) => deps.log(`[bridge/events] skip ${eventType}: ${reason}`)
	};
}
function messageEvents(sessionId, deps, build) {
	const directory = directoryFor(sessionId, deps);
	const project = projectIdFor(directory);
	const { info, parts } = build();
	const events = [makeEvent(directory, "message.updated", {
		sessionID: sessionId,
		info
	}, project)];
	for (const part of parts) events.push(makeEvent(directory, "message.part.updated", {
		sessionID: sessionId,
		part,
		time: Date.now()
	}, project));
	return events;
}
function toolCallId(resultEvent) {
	const block = resultEvent.data.message.content[0];
	return String(block?.toolCallId ?? resultEvent.data.message.source.callId);
}
/**
* Per-stream translator: converts one mux frame into zero or more opencode
* GlobalEvents. One instance is created per SSE client because tool/result
* pairing and current-message tracking are stream-ordered state.
*/
var MuxEventTranslator = class {
	deps;
	currentAssistant = /* @__PURE__ */ new Map();
	pendingCalls = /* @__PURE__ */ new Map();
	blockStarts = /* @__PURE__ */ new Map();
	constructor(deps) {
		this.deps = deps;
	}
	translate(frame) {
		const payload = frame.payload;
		switch (payload.type) {
			case "session/event": return this.translateSessionEvent(frame.rpcId, payload.sessionId, payload.event);
			case "approval/requested": {
				const entry = {
					rpcId: String(frame.rpcId),
					sessionId: String(payload.sessionId),
					approvalId: String(payload.approvalId),
					toolName: payload.toolName,
					callId: payload.callId === void 0 ? void 0 : String(payload.callId),
					reason: payload.reason
				};
				const registered = this.deps.state.registerApproval({
					opencodeId: randomUUID(),
					...entry
				});
				const directory = directoryFor(registered.sessionId, this.deps);
				return [makeEvent(directory, "permission.asked", toPermissionRequest(registered), projectIdFor(directory))];
			}
			case "approval/resolved": {
				const entry = this.deps.state.permissionByApprovalId(String(payload.approvalId));
				if (!entry) {
					this.deps.log(`[bridge/events] approval/resolved for unknown approval ${String(payload.approvalId)}`);
					return [];
				}
				const directory = directoryFor(entry.sessionId, this.deps);
				const reply = payload.outcome === "allowed-once" ? "once" : "reject";
				this.deps.state.removePermission(entry.opencodeId);
				return [makeEvent(directory, "permission.replied", {
					sessionID: entry.sessionId,
					requestID: entry.opencodeId,
					reply
				}, projectIdFor(directory))];
			}
			case "question/requested": {
				const entry = {
					rpcId: String(frame.rpcId),
					sessionId: String(payload.sessionId),
					items: payload.questions
				};
				const registered = this.deps.state.registerQuestion({
					opencodeId: randomUUID(),
					...entry
				});
				const directory = directoryFor(registered.sessionId, this.deps);
				return [makeEvent(directory, "question.asked", toQuestionRequest(registered), projectIdFor(directory))];
			}
			case "question/resolved": {
				const entry = this.deps.state.questionByRpcId(String(payload.questionRpcId));
				if (!entry) {
					this.deps.log(`[bridge/events] question/resolved for unknown rpcId ${String(payload.questionRpcId)}`);
					return [];
				}
				const directory = directoryFor(entry.sessionId, this.deps);
				const project = projectIdFor(directory);
				this.deps.state.removeQuestion(entry.opencodeId);
				if (payload.outcome === "answered") return [makeEvent(directory, "question.replied", {
					sessionID: entry.sessionId,
					requestID: entry.opencodeId,
					answers: []
				}, project)];
				return [makeEvent(directory, "question.rejected", {
					sessionID: entry.sessionId,
					requestID: entry.opencodeId
				}, project)];
			}
			case "session/projection": return this.translateProjection(payload.sessionId, payload.key, payload.value);
			case "session/subscribed":
			case "session/queue":
			case "session/jobs": return [];
			case "stream/error":
				this.deps.log(`[bridge/events] stream/error: ${payload.error.code} ${payload.error.message}`);
				return [];
			default:
				this.deps.log(`[bridge/events] unhandled mux frame ${String(payload.type)}`);
				return [];
		}
	}
	translateProjection(sessionId, key, value) {
		const directory = directoryFor(sessionId, this.deps);
		const project = projectIdFor(directory);
		if (key === "todos") return [makeEvent(directory, "todo.updated", {
			sessionID: sessionId,
			todos: convertTodos(value)
		}, project)];
		if (key === "produced-files") return [makeEvent(directory, "session.diff", {
			sessionID: sessionId,
			diff: convertProducedFiles(value)
		}, project)];
		if (key === "title") return [makeEvent(directory, "session.updated", {
			sessionID: sessionId,
			info: minimalSession(sessionId, {
				cwd: directory,
				title: typeof value === "string" ? value : ""
			})
		}, project)];
		return [];
	}
	translateSessionEvent(rpcId, sessionId, event) {
		const directory = directoryFor(sessionId, this.deps);
		const project = projectIdFor(directory);
		switch (event.type) {
			case "user/message": return messageEvents(sessionId, this.deps, () => {
				const entry = userMessageFromEvent(event, messageOptions(sessionId, this.deps));
				return {
					info: entry.info,
					parts: entry.parts
				};
			});
			case "assistant/chunk": {
				const chunk = event.data.chunk;
				if (chunk.type === "block-start") this.blockStarts.set(`${event.data.turn}:${event.data.step}:${chunk.index}:${chunk.blockType}`, event.time);
				return [];
			}
			case "assistant/message": {
				const events = messageEvents(sessionId, this.deps, () => {
					const entry = assistantMessageFromEvent(event, messageOptions(sessionId, this.deps), (index, blockType) => this.blockStarts.get(`${event.data.turn}:${event.data.step}:${index}:${blockType}`));
					return {
						info: entry.info,
						parts: entry.parts
					};
				});
				this.currentAssistant.set(sessionId, String(event.data.message.id));
				let calls = this.pendingCalls.get(sessionId);
				if (!calls) {
					calls = /* @__PURE__ */ new Map();
					this.pendingCalls.set(sessionId, calls);
				}
				for (const block of event.data.message.content) if (block.type === "tool-call") calls.set(String(block.id), {
					callId: String(block.id),
					name: block.name,
					arguments: block.arguments
				});
				return events;
			}
			case "turn/start": return [makeEvent(directory, "session.status", {
				sessionID: sessionId,
				status: { type: "busy" }
			}, project)];
			case "turn/end": return [makeEvent(directory, "session.status", {
				sessionID: sessionId,
				status: { type: "idle" }
			}, project), makeEvent(directory, "session.idle", { sessionID: sessionId }, project)];
			case "todo/write": return [makeEvent(directory, "todo.updated", {
				sessionID: sessionId,
				todos: convertTodos(event.data.todos)
			}, project)];
			case "tool/call": {
				const data = event.data;
				const call = {
					callId: String(data.callId),
					name: data.name,
					arguments: data.arguments
				};
				let calls = this.pendingCalls.get(sessionId);
				if (!calls) {
					calls = /* @__PURE__ */ new Map();
					this.pendingCalls.set(sessionId, calls);
				}
				calls.set(call.callId, call);
				return [makeEvent(directory, "message.part.updated", {
					sessionID: sessionId,
					part: pendingToolPart(call, {
						sessionID: sessionId,
						messageID: this.currentAssistant.get(sessionId) ?? `assistant:${data.turn}:${data.step}`,
						time: event.time
					}),
					time: event.time
				}, project)];
			}
			case "tool/result": {
				const data = event.data;
				const callId = toolCallId(event);
				const calls = this.pendingCalls.get(sessionId);
				const call = calls?.get(callId);
				if (!call) {
					this.deps.log(`[bridge/events] tool/result without tool/call for ${callId}`);
					return [];
				}
				const messageID = this.currentAssistant.get(sessionId) ?? `assistant:${data.turn}:${data.step}`;
				const part = data.error === void 0 ? completedToolPart(call, {
					callId,
					content: data.message.content,
					time: event.time,
					meta: data.meta
				}, {
					sessionID: sessionId,
					messageID,
					time: event.time
				}) : errorToolPart(call, {
					callId,
					content: data.message.content,
					error: data.error,
					time: event.time,
					meta: data.meta
				}, {
					sessionID: sessionId,
					messageID,
					time: event.time
				});
				calls?.delete(callId);
				return [makeEvent(directory, "message.part.updated", {
					sessionID: sessionId,
					part,
					time: event.time
				}, project)];
			}
			default: {
				const type = event.type;
				const data = event.data;
				if (type === "session/created") return [makeEvent(directory, "session.updated", {
					sessionID: sessionId,
					info: minimalSession(sessionId, {
						cwd: directory,
						createdAt: data.time
					})
				}, project)];
				if (type === "session/title") return [makeEvent(directory, "session.updated", {
					sessionID: sessionId,
					info: minimalSession(sessionId, {
						cwd: directory,
						title: typeof data.title === "string" ? data.title : typeof data.text === "string" ? data.text : "",
						createdAt: data.time
					})
				}, project)];
				this.deps.log(`[bridge/events] unhandled session event ${event.type} (rpcId ${rpcId})`);
				return [];
			}
		}
	}
};
/** Best-effort conversion of a produced-files projection to SnapshotFileDiff[]. */
function convertProducedFiles(value) {
	if (!Array.isArray(value)) return [];
	const result = [];
	for (const raw of value) {
		if (raw === null || typeof raw !== "object") continue;
		const item = raw;
		const additions = typeof item.additions === "number" ? item.additions : 0;
		const deletions = typeof item.deletions === "number" ? item.deletions : 0;
		const file = typeof item.file === "string" ? item.file : typeof item.path === "string" ? item.path : void 0;
		const status = item.status === "added" || item.status === "deleted" || item.status === "modified" ? item.status : void 0;
		result.push({
			...file === void 0 ? {} : { file },
			...typeof item.patch === "string" ? { patch: item.patch } : {},
			additions,
			deletions,
			...status === void 0 ? {} : { status }
		});
	}
	return result;
}
//#endregion
//#region src/bridge/state.ts
/**
* In-memory correlation maps between opencode-facing request ids and the dsh
* rpcIds/approval ids that answer them. Populated from the mux stream; the
* HTTP reply routes read it back.
*/
var InteractionState = class {
	permissions = /* @__PURE__ */ new Map();
	questions = /* @__PURE__ */ new Map();
	byApprovalId = /* @__PURE__ */ new Map();
	byQuestionRpcId = /* @__PURE__ */ new Map();
	sessionDirectories = /* @__PURE__ */ new Map();
	registerApproval(entry) {
		this.permissions.set(entry.opencodeId, entry);
		this.byApprovalId.set(entry.approvalId, entry.opencodeId);
		return entry;
	}
	registerQuestion(entry) {
		this.questions.set(entry.opencodeId, entry);
		this.byQuestionRpcId.set(entry.rpcId, entry.opencodeId);
		return entry;
	}
	permissionByOpenCodeId(id) {
		return this.permissions.get(id);
	}
	permissionByApprovalId(approvalId) {
		const opencodeId = this.byApprovalId.get(approvalId);
		return opencodeId === void 0 ? void 0 : this.permissions.get(opencodeId);
	}
	questionByOpenCodeId(id) {
		return this.questions.get(id);
	}
	questionByRpcId(rpcId) {
		const opencodeId = this.byQuestionRpcId.get(rpcId);
		return opencodeId === void 0 ? void 0 : this.questions.get(opencodeId);
	}
	removePermission(opencodeId) {
		const entry = this.permissions.get(opencodeId);
		if (entry) this.byApprovalId.delete(entry.approvalId);
		this.permissions.delete(opencodeId);
	}
	removeQuestion(opencodeId) {
		const entry = this.questions.get(opencodeId);
		if (entry) this.byQuestionRpcId.delete(entry.rpcId);
		this.questions.delete(opencodeId);
	}
	permissionsForSession(sessionId) {
		return [...this.permissions.values()].filter((entry) => entry.sessionId === sessionId);
	}
	questionsForSession(sessionId) {
		return [...this.questions.values()].filter((entry) => entry.sessionId === sessionId);
	}
};
//#endregion
//#region src/bridge/sse.ts
/** Registry of active SSE connections plus the encoder/cleanup logic. */
var SseHub = class {
	log;
	clients = /* @__PURE__ */ new Set();
	nextId = 1;
	constructor(log) {
		this.log = log;
	}
	add(res) {
		const client = {
			id: this.nextId++,
			res,
			controller: new AbortController(),
			closed: false
		};
		this.clients.add(client);
		res.on("close", () => this.remove(client));
		res.on("error", (error) => {
			this.log(`[bridge/sse] client ${client.id} error: ${error.message}`);
			this.remove(client);
		});
		return client;
	}
	remove(client) {
		if (client.closed) return;
		client.closed = true;
		this.clients.delete(client);
		client.controller.abort();
	}
	broadcast(event) {
		const data = JSON.stringify(event);
		for (const client of this.clients) {
			if (client.closed || client.res.destroyed) continue;
			try {
				client.res.write(`id: ${event.payload.id}\ndata: ${data}\n\n`);
			} catch (error) {
				this.log(`[bridge/sse] write to client ${client.id} failed: ${error instanceof Error ? error.message : String(error)}`);
				this.remove(client);
			}
		}
	}
	closeAll() {
		for (const client of [...this.clients]) this.remove(client);
	}
	get size() {
		return this.clients.size;
	}
};
//#endregion
//#region src/bridge/stubs.ts
/**
* Schema-valid stub routes: the TUI probes these at startup and must always
* receive 2xx JSON, even though dsh does not back the capability.
*/
const stubRoutes = [
	jsonRoute("GET", "/lsp", []),
	jsonRoute("GET", "/mcp", {}),
	jsonRoute("GET", "/formatter", []),
	jsonRoute("GET", "/experimental/resource", []),
	jsonRoute("GET", "/experimental/console", {
		consoleManagedProviders: [],
		switchableOrgCount: 0
	}),
	jsonRoute("GET", "/experimental/capabilities", { backgroundSubagents: false }),
	jsonRoute("GET", "/vcs", { branch: "" }),
	jsonRoute("GET", "/experimental/workspace", []),
	jsonRoute("GET", "/experimental/workspace/status", [])
];
function jsonRoute(method, pattern, body) {
	return {
		method,
		pattern,
		kind: "json",
		handler: async () => ({
			status: 200,
			body
		})
	};
}
//#endregion
//#region src/bridge/router.ts
function json(status, body) {
	return {
		status,
		body
	};
}
function sid(id) {
	return id;
}
async function rpc(ctx, method, payload, signal) {
	try {
		return await call(ctx.api, method, payload, signal);
	} catch (error) {
		if (error instanceof RpcCallError) throw rpcErrorToHttp(error.error);
		throw internalError(error instanceof Error ? error.message : String(error));
	}
}
function bodyAsRecord(body) {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return {};
	return body;
}
function locationInfo(ctx) {
	return {
		directory: ctx.cwd,
		project: {
			id: projectIdFor(ctx.cwd),
			directory: ctx.cwd
		}
	};
}
function v2LocationBody(ctx) {
	return {
		location: locationInfo(ctx),
		data: []
	};
}
async function sessionView(ctx, id) {
	const summary = (await rpc(ctx, "session.list", {})).items.find((item) => String(item.sessionId) === id);
	const history = await rpc(ctx, "session.history", { sessionId: sid(id) });
	if (summary?.cwd) ctx.state.sessionDirectories.set(id, summary.cwd);
	return {
		summary,
		events: history.events,
		createdAt: history.events[0]?.event.time
	};
}
function toV1Session(view, id, ctx) {
	if (view.summary) return convertSessionSummary(view.summary, {
		cwd: ctx.cwd,
		createdAt: view.createdAt
	});
	return minimalSession(id, {
		cwd: ctx.cwd,
		createdAt: view.createdAt
	});
}
function toV2Session(view, id, ctx) {
	if (view.summary) return convertSessionSummaryV2(view.summary, {
		cwd: ctx.cwd,
		createdAt: view.createdAt
	});
	return minimalSessionV2(id, {
		cwd: ctx.cwd,
		createdAt: view.createdAt
	});
}
async function modelGroups(ctx) {
	return (await rpc(ctx, "llm.models", {})).groups;
}
function parsePromptParts(raw) {
	if (!Array.isArray(raw)) throw badRequest("prompt body requires a parts array");
	const parts = [];
	for (const entry of raw) {
		if (entry === null || typeof entry !== "object") throw badRequest("invalid prompt part");
		const part = entry;
		if (part.type === "text") {
			if (typeof part.text !== "string") throw badRequest("text part requires a string text");
			parts.push({
				type: "text",
				text: part.text
			});
			continue;
		}
		if (part.type === "file") {
			if (typeof part.url !== "string" || typeof part.mime !== "string") throw badRequest("file part requires url and mime");
			const match = /^data:([^;,]+);base64,(.+)$/.exec(part.url);
			if (!match) throw badRequest("file part url must be a data URL (images only in first version)");
			const [, mediaType, data] = match;
			if (!mediaType || !data) throw badRequest("invalid file data URL");
			parts.push({
				type: "image",
				mediaType,
				data
			});
			continue;
		}
		throw badRequest(`unsupported prompt part type "${String(part.type)}"`);
	}
	return parts;
}
function pendingAssistantPlaceholder(sessionID, cwd) {
	return {
		info: {
			id: `pending:${randomUUID()}`,
			sessionID,
			role: "assistant",
			time: { created: Date.now() },
			parentID: `pending:${randomUUID()}`,
			modelID: "deepseek-chat",
			providerID: "deepseek",
			mode: "build",
			path: {
				cwd,
				root: cwd
			},
			cost: 0,
			tokens: {
				input: 0,
				output: 0,
				reasoning: 0,
				cache: {
					read: 0,
					write: 0
				}
			}
		},
		parts: []
	};
}
/** The dsh-oc bridge exposes one primary agent so the TUI prompt stays usable. */
const DEFAULT_AGENT_NAME = "build";
async function defaultAgents(ctx) {
	let providerID = "deepseek";
	let modelID = "deepseek-chat";
	try {
		const first = (await modelGroups(ctx))[0];
		const firstModel = first?.models[0];
		if (first !== void 0) providerID = externalProviderId(first.id);
		if (firstModel !== void 0) modelID = firstModel.id;
	} catch (error) {
		ctx.log(`[bridge] default agent model fallback: ${error instanceof Error ? error.message : String(error)}`);
	}
	return {
		providerID,
		modelID
	};
}
async function defaultModelRef(ctx) {
	return defaultAgents(ctx);
}
async function v1DefaultAgent(ctx) {
	const { providerID, modelID } = await defaultAgents(ctx);
	return {
		name: DEFAULT_AGENT_NAME,
		description: "dsh-oc default build agent",
		mode: "primary",
		permission: [],
		options: {},
		model: {
			providerID,
			modelID
		}
	};
}
async function v2DefaultAgent(ctx) {
	const { providerID, modelID } = await defaultAgents(ctx);
	return {
		id: DEFAULT_AGENT_NAME,
		mode: "primary",
		hidden: false,
		request: {
			headers: {},
			body: {}
		},
		permissions: [],
		model: {
			id: modelID,
			providerID
		},
		description: "dsh-oc default build agent"
	};
}
async function createSession(req, ctx, v2) {
	const body = bodyAsRecord(req.body);
	const parentID = typeof body.parentID === "string" ? body.parentID : void 0;
	const sessionIdInput = typeof body.id === "string" ? body.id : void 0;
	const title = typeof body.title === "string" ? body.title : void 0;
	let id;
	if (parentID) {
		const result = await rpc(ctx, "session.fork", { sessionId: sid(parentID) });
		id = String(result.sessionId);
	} else {
		const location = body.location;
		const result = await rpc(ctx, "session.create", {
			cwd: typeof location?.directory === "string" ? location.directory : ctx.cwd,
			...sessionIdInput === void 0 ? {} : { sessionId: sid(sessionIdInput) }
		});
		id = String(result.sessionId);
	}
	if (title) try {
		await rpc(ctx, "session.rename", {
			sessionId: sid(id),
			title
		});
	} catch (error) {
		ctx.log(`[bridge] rename of new session ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const view = await sessionView(ctx, id);
	return json(200, v2 ? { data: toV2Session(view, id, ctx) } : toV1Session(view, id, ctx));
}
async function permissionReply(ctx, requestID, body) {
	const entry = ctx.state.permissionByOpenCodeId(requestID);
	if (!entry) throw notFound("permission request not found", { requestID });
	const reply = bodyAsRecord(body).reply;
	let outcome;
	if (reply === "once") outcome = "allowed-once";
	else if (reply === "reject") outcome = "rejected";
	else if (reply === "always") {
		ctx.log("[bridge] permission \"always\" downgraded to \"allowed-once\" (dsh limitation)");
		outcome = "allowed-once";
	} else throw badRequest("invalid permission reply", { reply });
	const receipt = await respondApproval(ctx.api, entry.rpcId, entry.sessionId, entry.approvalId, outcome);
	if (!receipt.accepted) throw conflict("permission request is no longer pending", { reason: receipt.reason });
	ctx.state.removePermission(requestID);
}
async function questionReply(ctx, requestID, body) {
	const entry = ctx.state.questionByOpenCodeId(requestID);
	if (!entry) throw notFound("question request not found", { requestID });
	const answers = bodyAsRecord(body).answers;
	if (!Array.isArray(answers) || !answers.every((answer) => Array.isArray(answer) && answer.every((label) => typeof label === "string"))) throw badRequest("question reply requires answers: Array<Array<string>>");
	const mapped = answersToDsh(entry, answers);
	const receipt = await respondQuestion(ctx.api, entry.rpcId, entry.sessionId, mapped);
	if (!receipt.accepted) throw conflict("question request is no longer pending", { reason: receipt.reason });
	ctx.state.removeQuestion(requestID);
}
async function questionReject(ctx, requestID) {
	const entry = ctx.state.questionByOpenCodeId(requestID);
	if (!entry) throw notFound("question request not found", { requestID });
	const receipt = await cancelQuestion(ctx.api, entry.rpcId);
	if (!receipt.accepted) throw conflict("question request is no longer pending", { reason: receipt.reason });
	ctx.state.removeQuestion(requestID);
}
function producedFilesV1(value) {
	return convertProducedFiles(value).map((diff) => ({
		file: diff.file ?? "",
		before: "",
		after: "",
		additions: diff.additions,
		deletions: diff.deletions
	}));
}
function createBridgeRouter(api, options = {}) {
	const cwd = options.cwd ?? process.cwd();
	const log = options.log ?? (() => {});
	const state = new InteractionState();
	const hub = new SseHub(log);
	const ctx = {
		api,
		cwd,
		state,
		log,
		hub
	};
	const routes = [];
	const register = (method, pattern, kind, handler) => {
		routes.push({
			method,
			pattern,
			kind,
			handler
		});
	};
	register("GET", "/path", "json", async (_req, ctx) => {
		let directory = ctx.cwd;
		try {
			const describe = await rpc(ctx, "host.describe", {});
			if (describe.cwd) directory = describe.cwd;
		} catch (error) {
			ctx.log(`[bridge] host.describe unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
		return json(200, {
			home: directory,
			state: "ready",
			config: "",
			worktree: directory,
			directory,
			path: directory
		});
	});
	register("GET", "/project/current", "json", async (_req, ctx) => json(200, {
		id: projectIdFor(ctx.cwd),
		worktree: ctx.cwd,
		time: { created: 0 }
	}));
	register("GET", "/project/global/directories", "json", async (_req, ctx) => json(200, [{ directory: ctx.cwd }]));
	register("GET", "/config", "json", async () => json(200, {}));
	register("GET", "/config/providers", "json", async (_req, ctx) => {
		return json(200, {
			providers: convertToV1Providers(await modelGroups(ctx)),
			default: {}
		});
	});
	register("GET", "/provider", "json", async (_req, ctx) => {
		return json(200, convertToProviderCatalog(await modelGroups(ctx)));
	});
	register("GET", "/provider/auth", "json", async () => json(200, {}));
	register("GET", "/agent", "json", async (_req, ctx) => json(200, [await v1DefaultAgent(ctx)]));
	for (const bare of [
		"/command",
		"/skill",
		"/reference",
		"/integration"
	]) register("GET", bare, "json", async () => json(200, []));
	register("GET", "/api/location", "json", async (_req, ctx) => json(200, locationInfo(ctx)));
	register("GET", "/api/agent", "json", async (_req, ctx) => json(200, {
		location: locationInfo(ctx),
		data: [await v2DefaultAgent(ctx)]
	}));
	for (const bare of [
		"/api/command",
		"/api/skill",
		"/api/reference",
		"/api/integration"
	]) register("GET", bare, "json", async (_req, ctx) => json(200, v2LocationBody(ctx)));
	register("GET", "/api/model", "json", async (_req, ctx) => {
		const groups = await modelGroups(ctx);
		return json(200, {
			location: locationInfo(ctx),
			data: convertToV2Models(groups)
		});
	});
	register("GET", "/api/provider", "json", async (_req, ctx) => {
		const groups = await modelGroups(ctx);
		return json(200, {
			location: locationInfo(ctx),
			data: convertToV2Providers(groups)
		});
	});
	register("GET", "/api/permission/saved", "json", async () => json(200, { data: [] }));
	register("GET", "/session", "json", async (_req, ctx) => {
		const list = await rpc(ctx, "session.list", {});
		for (const item of list.items) if (item.cwd) state.sessionDirectories.set(String(item.sessionId), item.cwd);
		return json(200, list.items.map((item) => convertSessionSummary(item, { cwd })));
	});
	register("GET", "/session/status", "json", async (_req, ctx) => {
		const list = await rpc(ctx, "session.list", {});
		const status = {};
		for (const item of list.items) status[String(item.sessionId)] = item.running ? { type: "busy" } : { type: "idle" };
		return json(200, status);
	});
	register("POST", "/session", "json", (req, ctx) => createSession(req, ctx, false));
	register("GET", "/session/:id", "json", async (req, ctx) => {
		const id = req.params.id;
		return json(200, toV1Session(await sessionView(ctx, id), id, ctx));
	});
	register("PATCH", "/session/:id", "json", async (req, ctx) => {
		const id = req.params.id;
		const body = bodyAsRecord(req.body);
		if (typeof body.title !== "string") throw badRequest("session update requires a string title");
		await rpc(ctx, "session.rename", {
			sessionId: sid(id),
			title: body.title
		});
		return json(200, toV1Session(await sessionView(ctx, id), id, ctx));
	});
	register("GET", "/session/:id/message", "json", async (req, ctx) => {
		const id = req.params.id;
		const limitRaw = req.query.get("limit");
		const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 100, 500)) : 100;
		const history = await rpc(ctx, "session.history", {
			sessionId: sid(id),
			maxMessages: limit
		});
		const defaultModel = await defaultModelRef(ctx);
		return json(200, convertMessagesV1(history.events.map((entry) => entry.event), {
			sessionId: id,
			cwd,
			defaultModel,
			onSkip: (type, reason) => ctx.log(`[bridge/messages] ${type}: ${reason}`)
		}));
	});
	register("POST", "/session/:id/message", "json", async (req, ctx) => {
		const id = req.params.id;
		const content = parsePromptParts(bodyAsRecord(req.body).parts);
		await rpc(ctx, "session.prompt", {
			sessionId: sid(id),
			mode: "queue",
			content
		});
		return json(200, pendingAssistantPlaceholder(id, cwd));
	});
	register("POST", "/session/:id/prompt", "json", async (req, ctx) => {
		const id = req.params.id;
		const content = parsePromptParts(bodyAsRecord(req.body).parts);
		await rpc(ctx, "session.prompt", {
			sessionId: sid(id),
			mode: "queue",
			content
		});
		return json(200, pendingAssistantPlaceholder(id, cwd));
	});
	register("POST", "/session/:id/abort", "json", async (req, ctx) => {
		const id = req.params.id;
		await rpc(ctx, "session.cancel", { sessionId: sid(id) });
		return json(200, true);
	});
	register("GET", "/session/:id/todo", "json", async (req, ctx) => {
		const id = req.params.id;
		const history = await rpc(ctx, "session.history", { sessionId: sid(id) });
		let todos;
		for (let index = history.events.length - 1; index >= 0; index--) {
			const event = history.events[index].event;
			if (event.type === "todo/write") {
				todos = event.data.todos;
				break;
			}
		}
		if (todos === void 0 && history.projections) {
			const values = history.projections.values;
			if (values.todos !== void 0) todos = values.todos;
		}
		return json(200, convertTodos(todos ?? []));
	});
	register("GET", "/session/:id/diff", "json", async (req, ctx) => {
		const id = req.params.id;
		const values = (await rpc(ctx, "session.history", { sessionId: sid(id) })).projections?.values;
		return json(200, producedFilesV1(values?.["produced-files"]));
	});
	register("GET", "/permission", "json", async (_req, ctx) => json(200, [...ctx.state.permissions.values()].map(toPermissionRequest)));
	register("POST", "/permission/:requestID/reply", "json", async (req, ctx) => {
		const requestID = req.params.requestID;
		await permissionReply(ctx, requestID, req.body);
		return json(200, true);
	});
	register("GET", "/question", "json", async (_req, ctx) => json(200, [...ctx.state.questions.values()].map(toQuestionRequest)));
	register("POST", "/question/:requestID/reply", "json", async (req, ctx) => {
		const requestID = req.params.requestID;
		await questionReply(ctx, requestID, req.body);
		return json(200, true);
	});
	register("POST", "/question/:requestID/reject", "json", async (req, ctx) => {
		const requestID = req.params.requestID;
		await questionReject(ctx, requestID);
		return json(200, true);
	});
	register("GET", "/api/session", "json", async (_req, ctx) => {
		const list = await rpc(ctx, "session.list", {});
		for (const item of list.items) if (item.cwd) state.sessionDirectories.set(String(item.sessionId), item.cwd);
		return json(200, {
			data: list.items.map((item) => convertSessionSummaryV2(item, { cwd })),
			cursor: {}
		});
	});
	register("POST", "/api/session", "json", (req, ctx) => createSession(req, ctx, true));
	register("POST", "/api/session/:sessionID/prompt", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const content = parsePromptParts(bodyAsRecord(req.body).parts);
		await rpc(ctx, "session.prompt", {
			sessionId: sid(id),
			mode: "queue",
			content
		});
		return json(200, { data: {
			id: `msg_${randomUUID()}`,
			sessionID: id,
			prompt: { parts: content },
			delivery: "queue",
			timeCreated: Date.now(),
			admittedSeq: 0
		} });
	});
	register("GET", "/api/session/:sessionID", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		return json(200, { data: toV2Session(await sessionView(ctx, id), id, ctx) });
	});
	register("GET", "/api/session/:sessionID/message", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const history = await rpc(ctx, "session.history", { sessionId: sid(id) });
		const defaultModel = await defaultModelRef(ctx);
		return json(200, {
			data: convertMessagesV2(history.events.map((entry) => entry.event), {
				sessionId: id,
				cwd,
				defaultModel,
				onSkip: (type, reason) => ctx.log(`[bridge/messages-v2] ${type}: ${reason}`)
			}),
			cursor: {}
		});
	});
	register("GET", "/api/session/:sessionID/permission", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		return json(200, { data: ctx.state.permissionsForSession(id).map(toPermissionV2) });
	});
	register("POST", "/api/session/:sessionID/permission/:requestID/reply", "json", async (req, ctx) => {
		const requestID = req.params.requestID;
		await permissionReply(ctx, requestID, req.body);
		return json(204);
	});
	register("GET", "/api/session/:sessionID/question", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		return json(200, { data: ctx.state.questionsForSession(id).map(toQuestionV2) });
	});
	register("POST", "/api/session/:sessionID/question/:requestID/reply", "json", async (req, ctx) => {
		const requestID = req.params.requestID;
		await questionReply(ctx, requestID, req.body);
		return json(204);
	});
	register("POST", "/api/session/:sessionID/question/:requestID/reject", "json", async (req, ctx) => {
		const requestID = req.params.requestID;
		await questionReject(ctx, requestID);
		return json(204);
	});
	register("GET", "/global/event", "sse", async () => ({ status: 200 }));
	for (const route of stubRoutes) routes.push(route);
	function match(method, pathname) {
		return routes.find((route) => route.method === method && matchPattern(route.pattern, pathname));
	}
	function startSse(_req, res) {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"Access-Control-Allow-Origin": "*"
		});
		res.write("retry: 3000\n\n");
		const client = hub.add(res);
		const controller = client.controller;
		(async () => {
			try {
				const defaultModel = await defaultModelRef(ctx);
				const translator = new MuxEventTranslator({
					cwd,
					state,
					defaultModel,
					log
				});
				const stream = api.events.mux({
					rpcId: randomUUID(),
					payload: {}
				}, controller.signal);
				for await (const frame of stream) for (const event of translator.translate(frame)) hub.broadcast(event);
			} catch (error) {
				if (controller.signal.aborted) return;
				log(`[bridge/sse] mux stream ended: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				hub.remove(client);
			}
		})();
	}
	return {
		ctx,
		match,
		startSse
	};
}
function matchPattern(pattern, pathname) {
	const patternSegments = pattern.split("/");
	const pathSegments = pathname.split("/");
	if (patternSegments.length !== pathSegments.length) return false;
	return patternSegments.every((segment, index) => segment === pathSegments[index] || segment.startsWith(":"));
}
function extractParams(pattern, pathname) {
	const patternSegments = pattern.split("/");
	const pathSegments = pathname.split("/");
	const params = {};
	patternSegments.forEach((segment, index) => {
		if (segment.startsWith(":")) params[segment.slice(1)] = decodeURIComponent(pathSegments[index] ?? "");
	});
	return params;
}
//#endregion
//#region src/bridge/http.ts
const MAX_BODY_BYTES = 1048576;
const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
	"Access-Control-Max-Age": "86400"
};
/**
* Start the loopback HTTP server. `url`/`port` are available once the
* returned promise resolves (after `listen` on 127.0.0.1:0).
*/
async function startBridgeServer(router, options = {}) {
	const host = options.host ?? "127.0.0.1";
	const sockets = /* @__PURE__ */ new Set();
	const server = http.createServer((req, res) => {
		handleRequest(router, req, res).catch((error) => {
			sendError(res, error instanceof HttpError ? error : internalError(error instanceof Error ? error.message : String(error)));
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise((resolve, reject) => {
		const onError = (error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(0, host);
	});
	const port = server.address().port;
	return {
		url: `http://${host}:${port}`,
		port,
		server,
		close: async () => {
			router.ctx.hub.closeAll();
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
		}
	};
}
async function handleRequest(router, req, res) {
	const method = req.method ?? "GET";
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const pathname = url.pathname;
	res.setHeader("Access-Control-Allow-Origin", "*");
	if (method === "OPTIONS") {
		res.writeHead(204, CORS_HEADERS);
		res.end();
		return;
	}
	let body;
	if (method !== "GET" && method !== "HEAD") body = await readBody(req);
	const route = router.match(method, pathname);
	if (!route) throw notImplemented(`${method} ${pathname} is not implemented by oc-bridge`);
	const request = {
		method,
		pathname,
		query: url.searchParams,
		params: extractParams(route.pattern, pathname),
		body
	};
	if (route.kind === "sse") {
		req.socket.setTimeout(0);
		router.startSse(request, res);
		return;
	}
	const result = await route.handler(request, router.ctx);
	sendJson(res, result.status, result.body, result.headers);
}
async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw badRequest("request body exceeds 1 MiB limit");
		chunks.push(chunk);
	}
	if (chunks.length === 0) return void 0;
	const raw = Buffer.concat(chunks).toString("utf8");
	if (raw.length === 0) return void 0;
	try {
		return JSON.parse(raw);
	} catch {
		throw badRequest("invalid JSON body");
	}
}
function sendJson(res, status, body, headers) {
	if (status === 204 || status === 304 || body === void 0) {
		res.writeHead(status, {
			...CORS_HEADERS,
			...headers,
			"Content-Length": "0"
		});
		res.end();
		return;
	}
	const data = JSON.stringify(body);
	res.writeHead(status, {
		...CORS_HEADERS,
		...headers,
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(data)
	});
	res.end(data);
}
function sendError(res, error) {
	sendJson(res, error.status, error.body);
}
//#endregion
//#region src/bridge/index.ts
const name = "@deepseek-ai/dsh-oc/bridge";
const inject = ["apiProxy"];
/**
* oc-bridge cordis service: owns the loopback HTTP/SSE server and exposes
* `{ url, port }` once the listener is ready. `Service.init` starts the
* server before the service becomes injectable, and yields the teardown
* disposer so dispose never hangs.
*/
var OcBridgeService = class extends Service {
	url = "";
	port = 0;
	handle;
	logger;
	constructor(ctx) {
		super(ctx, "ocBridge");
		this.logger = makeLogger(ctx);
	}
	async *[Service.init]() {
		const api = this.ctx.apiProxy;
		const handle = await startBridgeServer(createBridgeRouter(api, { log: this.logger }));
		this.handle = handle;
		this.url = handle.url;
		this.port = handle.port;
		this.logger(`bridge listening on ${handle.url}`);
		yield () => this.stop();
	}
	async stop() {
		const handle = this.handle;
		this.handle = void 0;
		await handle?.close();
	}
};
function makeLogger(ctx) {
	const logger = ctx.logger?.("oc-bridge");
	return (message) => {
		if (logger) logger.warn(message);
		else console.warn(`[dsh-oc/bridge] ${message}`);
	};
}
//#endregion
export { OcBridgeService, OcBridgeService as default, inject, name };

//# sourceMappingURL=index.js.map
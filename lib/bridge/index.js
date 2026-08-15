import { n as ocHelp } from "../help-D7toDMtY.js";
import { Service } from "@deepseek-ai/cordis";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
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
const DOMAIN_ALIASES = {
	session: "sessions",
	agentPreset: "agentPresets",
	goal: "goals",
	skill: "skills"
};
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
	"subagent-delivery-unavailable",
	"agent-preset-locked"
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
/** Reverse of `externalProviderId`: opencode-facing id → dsh route id. */
function dshProviderId(providerId) {
	return providerId === "deepseek" ? "deepseek-official" : providerId;
}
/** Stable short hash used as the opencode project id. */
function projectIdFor(directory) {
	return createHash("sha256").update(directory).digest("hex").slice(0, 16);
}
/**
* Stable provisional assistant message id used by both the live SSE
* translator and history hydration. The TUI reconciles streamed messages with
* `GET /session/{id}/message`, so both surfaces must name the same message.
*/
function provisionalMessageId(sessionId, turn, step) {
	return `msg_pending:${sessionId}:${turn}:${step}`;
}
/**
* Stable provisional text/reasoning part id shared by live SSE events and
* history hydration.
*/
function provisionalPartId(sessionId, turn, step, blockType, index) {
	return `prt_stream:${sessionId}:${turn}:${step}:${blockType}:${index}`;
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
function sessionTitleFrom(summary, override) {
	const title = (summary.projections?.values)?.title;
	if (typeof title === "string" && title.length > 0) return title;
	if (override !== void 0 && override.length > 0) return override;
	if (summary.origin === "subagent") return "Subagent session";
	const cwd = summary.cwd;
	if (typeof cwd === "string" && cwd.length > 0) {
		const base = cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
		if (base.length > 0) return base;
	}
	return String(summary.sessionId);
}
/** Metadata marker opencode surfaces use to identify dsh subagent children. */
function sessionMetadataFrom(summary) {
	if (summary.origin !== "subagent") return void 0;
	return { origin: "subagent" };
}
/**
* Convert a dsh `SessionSummary` into the opencode v2 `Session` shape
* (a structural superset of the v1 `Session`).
*/
function convertSessionSummary(summary, options) {
	const directory = summary.cwd ?? options.cwd;
	const createdAt = options.createdAt ?? summary.updatedAt;
	const title = sessionTitleFrom(summary, options.title);
	return {
		id: String(summary.sessionId),
		slug: String(summary.sessionId),
		projectID: projectIdFor(directory),
		directory,
		...summary.origin === "subagent" && summary.parentSessionId !== void 0 ? { parentID: String(summary.parentSessionId) } : {},
		title,
		agent: summary.agentPreset ?? "build",
		...options.model === void 0 ? {} : { model: options.model },
		version: OPENCODE_VERSION,
		...sessionMetadataFrom(summary) === void 0 ? {} : { metadata: sessionMetadataFrom(summary) },
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
		...summary.origin === "subagent" && summary.parentSessionId !== void 0 ? { parentID: String(summary.parentSessionId) } : {},
		projectID: projectIdFor(directory),
		agent: summary.agentPreset ?? "build",
		...options.model === void 0 ? {} : { model: options.model },
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
		title: sessionTitleFrom(summary, options.title),
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
		agent: options.agent ?? "build",
		version: OPENCODE_VERSION,
		...options.parentID === void 0 ? {} : { parentID: options.parentID },
		...options.metadata === void 0 ? {} : { metadata: options.metadata },
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
		...options.parentID === void 0 ? {} : { parentID: options.parentID },
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
//#region src/bridge/convert/tool.ts
function record(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	return value;
}
function stringValue(value) {
	return typeof value === "string" ? value : void 0;
}
function callView(view) {
	if (view?.for !== "call") return void 0;
	return view.view;
}
function resultView(view) {
	if (view?.for !== "result") return void 0;
	return view.view;
}
function argsRecord(raw) {
	return safeJsonParse(raw);
}
function pathFromArgs(args) {
	return stringValue(args.file_path) ?? stringValue(args.path);
}
/**
* Map a dsh tool name to the opencode tool semantic used by the TUI.
* `str_replace_editor view` is a read card; every mutation command becomes
* the native edit card.
*/
function opencodeToolName(name, args) {
	switch (name) {
		case "bash":
		case "bash-persistent": return "bash";
		case "read":
		case "fs-read":
		case "read_image": return "read";
		case "write":
		case "fs-write": return "edit";
		case "edit":
		case "fs-edit": return "edit";
		case "str_replace_editor": return args.command === "view" ? "read" : "edit";
		default: return name;
	}
}
function normalizedInput(name, args) {
	const input = { ...args };
	if (name === "read" || name === "fs-read" || name === "read_image") {
		if (typeof args.file_path === "string") input.filePath = args.file_path;
		return input;
	}
	if (name === "write" || name === "fs-write" || name === "edit" || name === "fs-edit") {
		if (typeof args.file_path === "string") input.filePath = args.file_path;
		if (name === "edit" || name === "fs-edit") {
			if (typeof args.old_string === "string") input.oldString = args.old_string;
			if (typeof args.new_string === "string") input.newString = args.new_string;
			if (typeof args.replace_all === "boolean") input.replaceAll = args.replace_all;
		}
		return input;
	}
	if (name === "str_replace_editor") {
		if (typeof args.path === "string") input.filePath = args.path;
		if (typeof args.old_str === "string") input.oldString = args.old_str;
		if (typeof args.new_str === "string") input.newString = args.new_str;
		if (typeof args.insert_line === "number") input.insertLine = args.insert_line;
		if (typeof args.file_text === "string") input.content = args.file_text;
		return input;
	}
	return input;
}
function titleFromCall(name, args, view) {
	const present = callView(view);
	if (present?.title) return present.title;
	const path = pathFromArgs(args);
	switch (name) {
		case "bash":
		case "bash-persistent": return stringValue(args.command) ?? name;
		case "read":
		case "fs-read":
		case "read_image": return `Read ${path ?? ""}`.trim();
		case "write":
		case "fs-write": return `Write ${path ?? ""}`.trim();
		case "edit":
		case "fs-edit": return `Edit ${path ?? ""}`.trim();
		case "str_replace_editor": return `${stringValue(args.command) ?? name} ${path ?? ""}`.trim();
		default: return `${name} ${path ?? ""}`.trim();
	}
}
function diffListFromCall(view) {
	const present = callView(view);
	if (present?.card !== "diff" || !Array.isArray(present.diffs)) return [];
	return present.diffs.flatMap((raw) => {
		const diff = record(raw);
		if (!diff) return [];
		return [{
			path: stringValue(diff.path),
			oldText: diff.oldText === null ? null : stringValue(diff.oldText),
			newText: stringValue(diff.newText)
		}];
	});
}
function diffListFromResult(view) {
	const present = resultView(view);
	if (present?.card !== "diff" || !Array.isArray(present.diffs)) return [];
	return present.diffs.flatMap((raw) => {
		const diff = record(raw);
		if (!diff) return [];
		return [{
			path: stringValue(diff.path),
			oldText: diff.oldText === null ? null : stringValue(diff.oldText),
			newText: stringValue(diff.newText)
		}];
	});
}
function diffListFromMeta(meta) {
	const raw = record(meta)?.diffs;
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((entry) => {
		const diff = record(entry);
		if (!diff) return [];
		return [{
			path: stringValue(diff.path),
			oldText: diff.oldText === null ? null : stringValue(diff.oldText),
			newText: stringValue(diff.newText)
		}];
	});
}
function countPatch(patch) {
	let additions = 0;
	let deletions = 0;
	for (const line of patch.split("\n")) if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
	else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
	return {
		additions,
		deletions
	};
}
function relativePath(file) {
	return file.replace(/\\/g, "/").replace(/^\/+/, "");
}
/**
* Build a compact unified diff from dsh's oldText/newText presenter hunks.
* This is intentionally small: dsh already supplies the hunk-level texts and
* the TUI only needs a valid `---/+++` patch to render.
*/
function unifiedDiffForFile(file, oldText, newText) {
	const oldLines = (oldText ?? "").split("\n");
	const newLines = (newText ?? "").split("\n");
	if (oldLines.join("\n") === newLines.join("\n")) return "";
	let start = 0;
	while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
	let oldEnd = oldLines.length;
	let newEnd = newLines.length;
	while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
		oldEnd -= 1;
		newEnd -= 1;
	}
	const removed = oldLines.slice(start, oldEnd);
	const added = newLines.slice(start, newEnd);
	const removedCount = removed.length;
	const addedCount = added.length;
	const oldStart = removedCount === 0 ? start : start + 1;
	const newStart = addedCount === 0 ? start : start + 1;
	const header = `@@ -${oldStart}${removedCount === 0 ? "" : `,${removedCount}`} +${newStart}${addedCount === 0 ? "" : `,${addedCount}`} @@`;
	const body = [...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)];
	return [
		`--- a/${relativePath(file)}`,
		`+++ b/${relativePath(file)}`,
		header,
		...body
	].join("\n") + (body.length > 0 ? "\n" : "");
}
function statusForDiffs(diffs) {
	const allOldNull = diffs.every((diff) => diff.oldText === null || diff.oldText === "");
	const allNewEmpty = diffs.every((diff) => diff.newText === void 0 || diff.newText === "");
	if (allOldNull) return "added";
	if (allNewEmpty) return "deleted";
	return "modified";
}
function insertDiffFromArgs(args) {
	const path = pathFromArgs(args);
	if (!path || args.command !== "insert") return [];
	return [{
		path,
		oldText: "",
		newText: stringValue(args.new_str) ?? ""
	}];
}
/**
* Conservative fallback for shell commands that clearly write to a file.
* dsh does not persist a diff for bash results, so redirection targets are
* surfaced as best-effort file changes until a produced-files projection is
* available.
*/
function bashFileChangesFromArgs(args) {
	const command = stringValue(args.command);
	if (!command) return [];
	const paths = /* @__PURE__ */ new Set();
	for (const match of command.matchAll(/(?:>>|>)\s*["']?([^"'\s;&|]+)["']?/g)) {
		const path = match[1];
		if (path) paths.add(path.replace(/^["']|["']$/g, ""));
	}
	for (const match of command.matchAll(/(?:^|[;&|]\s*)tee\s+["']?([^"'\s;&|]+)["']?/g)) {
		const path = match[1];
		if (path) paths.add(path.replace(/^["']|["']$/g, ""));
	}
	return [...paths].map((file) => ({
		file,
		additions: 0,
		deletions: 0,
		status: "modified"
	}));
}
/**
* Extract opencode file changes from a completed dsh tool. The source of
* truth is result `meta` when the tool persisted contextual diffs (write/edit
* in dsh-tool-fs), then the live/replayed presenter result view, then the
* call-time diff card. `str_replace_editor insert` synthesizes an
* addition-only hunk from its arguments.
*/
function fileChangesFromToolResult(call, result) {
	const args = argsRecord(call.arguments);
	const metaDiffs = diffListFromMeta(result.meta);
	const resultDiffs = diffListFromResult(result.view);
	const callDiffs = diffListFromCall(result.callView ?? call.view);
	const diffs = metaDiffs.length > 0 ? metaDiffs : resultDiffs.length > 0 ? resultDiffs : callDiffs;
	if (diffs.length === 0 && call.name === "str_replace_editor") diffs.push(...insertDiffFromArgs(args));
	if (diffs.length === 0 && call.name === "bash") return bashFileChangesFromArgs(args);
	if (diffs.length === 0) return [];
	const byPath = /* @__PURE__ */ new Map();
	const fallbackPath = pathFromArgs(args);
	for (const diff of diffs) {
		const path = diff.path ?? fallbackPath;
		if (!path) continue;
		const list = byPath.get(path) ?? [];
		list.push(diff);
		byPath.set(path, list);
	}
	const changes = [];
	for (const [file, fileDiffs] of byPath) {
		const patch = fileDiffs.map((diff) => unifiedDiffForFile(file, diff.oldText ?? "", diff.newText ?? "")).filter(Boolean).join("\n");
		const { additions, deletions } = countPatch(patch);
		changes.push({
			file,
			...patch ? { patch } : {},
			additions,
			deletions,
			status: statusForDiffs(fileDiffs)
		});
	}
	return changes;
}
function descriptionForStrReplace(args) {
	const command = stringValue(args.command);
	const path = pathFromArgs(args);
	if (!command) return void 0;
	const label = {
		view: "View file",
		create: "Create file",
		str_replace: "Replace text in file",
		insert: "Insert lines into file",
		undo_edit: "Undo last edit to file"
	}[command];
	return label === void 0 ? void 0 : `${label} ${path ?? ""}`.trim();
}
function completedMetadata(call, result, tool, input) {
	const metadata = {};
	if (result.meta !== void 0) metadata.meta = result.meta;
	if (tool === "bash") {
		const present = resultView(result.view);
		if (present?.card === "terminal") {
			if (present.output !== void 0) metadata.output = present.output;
			if (present.exitCode !== void 0) metadata.exit = present.exitCode;
			if (present.signal !== void 0) metadata.signal = present.signal;
		} else metadata.output = resultText(result.content);
	}
	if (tool === "read") {
		const loaded = stringValue(record(result.meta)?.path) ?? stringValue(input.filePath);
		if (loaded) metadata.loaded = [loaded];
	}
	if (tool === "edit") {
		const changes = fileChangesFromToolResult(call, result);
		if (changes.length > 0) {
			metadata.files = changes.map((change) => change.file);
			metadata.filediff = changes[0];
			if (changes[0]?.patch) metadata.diff = changes[0].patch;
		}
	}
	if (call.name === "str_replace_editor") {
		metadata.command = stringValue(input.command) ?? "";
		metadata.mode = stringValue(input.command) ?? "";
		const description = descriptionForStrReplace(input);
		if (description) metadata.description = description;
	}
	return metadata;
}
function resultText(content) {
	return textFromBlocks(content.flatMap((block) => block.type === "tool-result" ? block.content : [block]));
}
/** Model-facing result text for one tool/result event (used by v2 events). */
function toolResultText(result) {
	return resultText(result.content);
}
/**
* Structured v2 progress payload derived from the dsh result view: terminal
* cards carry output/exitCode/signal; everything else is folded into a
* generic `output` field when content exists.
*/
function toolResultStructured(result) {
	const present = resultView(result.view);
	if (present?.card === "terminal") return {
		...present.output === void 0 ? {} : { output: present.output },
		...present.exitCode === void 0 ? {} : { exitCode: present.exitCode },
		...present.signal === void 0 ? {} : { signal: present.signal }
	};
	const text = resultText(result.content);
	return text.length > 0 ? { output: text } : {};
}
/** A `tool/call` event alone becomes a pending ToolPart. */
function pendingToolPart(call, options) {
	const input = safeJsonParse(call.arguments);
	const tool = opencodeToolName(call.name, input);
	return {
		id: `tool:${call.callId}`,
		sessionID: options.sessionID,
		messageID: options.messageID,
		type: "tool",
		callID: call.callId,
		tool,
		state: {
			status: "pending",
			input: normalizedInput(call.name, input),
			raw: call.arguments
		},
		metadata: { start: options.time }
	};
}
/**
* A partially-streamed tool call becomes a pending ToolPart whose `raw`
* input grows with every tool-call delta. The TUI upserts by part id, so
* repeated updates progressively reveal the command/arguments.
*/
function streamingToolPart(call, options) {
	const input = safeJsonParse(call.arguments ?? "");
	const name = call.name ?? "tool";
	const tool = opencodeToolName(name, input);
	return {
		id: `tool:${call.callId}`,
		sessionID: options.sessionID,
		messageID: options.messageID,
		type: "tool",
		callID: call.callId,
		tool,
		state: {
			status: "pending",
			input: normalizedInput(name, input),
			raw: call.arguments ?? ""
		},
		metadata: { start: options.time }
	};
}
/** A `tool/result` success event becomes a completed ToolPart. */
function completedToolPart(call, result, options) {
	const input = safeJsonParse(call.arguments);
	const tool = opencodeToolName(call.name, input);
	const metadata = completedMetadata(call, result, tool, input);
	return {
		id: `tool:${call.callId}`,
		sessionID: options.sessionID,
		messageID: options.messageID,
		type: "tool",
		callID: call.callId,
		tool,
		state: {
			status: "completed",
			input: normalizedInput(call.name, input),
			output: resultText(result.content),
			title: titleFromCall(call.name, input, call.view),
			metadata,
			time: {
				start: options.time,
				end: result.time
			}
		}
	};
}
/** A `tool/result` with an error becomes an error ToolPart. */
function errorToolPart(call, result, options) {
	const input = safeJsonParse(call.arguments);
	const tool = opencodeToolName(call.name, input);
	const message = result.error?.name ?? result.error?.code ?? "tool failed";
	return {
		id: `tool:${call.callId}`,
		sessionID: options.sessionID,
		messageID: options.messageID,
		type: "tool",
		callID: call.callId,
		tool,
		state: {
			status: "error",
			input: normalizedInput(call.name, input),
			error: message,
			time: {
				start: options.time,
				end: result.time
			}
		}
	};
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
//#region src/bridge/convert/goal.ts
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* Narrow the dsh goal vocabulary to the fields the bridge renders. Both the
* `goal` projection (`{ goal: GoalSnapshot, ... }`) and the raw snapshot on
* `goal/change` events are accepted so history folds and live mux frames
* share one converter.
*/
function goalSnapshotFrom(value) {
	if (!isRecord(value)) return void 0;
	if (isRecord(value.goal)) return value.goal;
	if (typeof value.objective === "string" || typeof value.phase === "string") return value;
}
/** Map a durable goal phase onto the opencode todo status vocabulary. */
function goalPhaseStatus(phase) {
	if (phase === "active") return "in_progress";
	if (phase === "paused" || phase === "blocked") return "pending";
	if (phase === "complete") return "completed";
}
/**
* Convert one goal snapshot/projection into the opencode todo shown first in
* the sidebar. Returns `undefined` when the value carries no renderable goal.
*/
function goalTodo(value) {
	const snapshot = goalSnapshotFrom(value);
	if (snapshot === void 0) return void 0;
	const objective = typeof snapshot.objective === "string" ? snapshot.objective.trim() : "";
	if (objective.length === 0) return void 0;
	const status = goalPhaseStatus(snapshot.phase);
	if (status === void 0) return void 0;
	return {
		id: `goal:${typeof snapshot.id === "string" && snapshot.id.length > 0 ? snapshot.id : stableId(`${objective}\0${String(snapshot.phase)}`)}`,
		content: `Goal: ${objective}`,
		status,
		priority: "high"
	};
}
/**
* Merge the current goal (first) with dsh todo items. The goal is additive:
* it never replaces or hides the todo projection.
*/
function convertGoalTodos(goalValue, todosValue) {
	const goal = goalTodo(goalValue);
	return [...goal === void 0 ? [] : [goal], ...convertTodos(todosValue)];
}
/**
* One-line human summary of a `goal/change` event for the history/message
* surface. Returns `undefined` for values that are not goal changes.
*/
function goalChangeText(value) {
	if (!isRecord(value)) return void 0;
	if (value.operation === "clear") return "Goal cleared";
	const snapshot = goalSnapshotFrom(value);
	if (snapshot === void 0) return void 0;
	const objective = typeof snapshot.objective === "string" ? snapshot.objective.trim() : "";
	if (objective.length === 0) return void 0;
	switch (value.operation) {
		case "create": return `Goal created: ${objective}`;
		case "edit": return `Goal updated: ${objective}`;
		case "pause": return `Goal paused: ${objective}`;
		case "resume": return `Goal resumed: ${objective}`;
		case "complete": return `Goal completed: ${objective}`;
		case "block": {
			const reason = snapshot.blockedReason;
			const reasonRecord = isRecord(reason) ? reason : void 0;
			const code = typeof reasonRecord?.code === "string" ? reasonRecord.code : "unknown";
			const message = typeof reasonRecord?.message === "string" ? reasonRecord.message : "";
			return `Goal blocked: ${objective} (${code}${message.length === 0 ? "" : `: ${message}`})`;
		}
		default: return;
	}
}
//#endregion
//#region src/bridge/convert/message.ts
/** Dsh checkpoint rows written by compaction have a plugin `compact` source. */
function isCompactCheckpoint(event) {
	const source = event.data.source;
	return source?.kind === "plugin" && source.plugin === "compact";
}
/** Manual `/compact` records a sourceCommandId; automatic compaction omits it. */
function isAutoCompactCheckpoint(event) {
	return event.data.source?.sourceCommandId === void 0;
}
function compactionPart(messageId, opts, auto) {
	return {
		id: `${messageId}:compaction`,
		sessionID: opts.sessionId,
		messageID: messageId,
		type: "compaction",
		auto
	};
}
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
function assistantMessageInfo(message, time, parentID, opts, usage, created, finish) {
	return {
		id: String(message.id),
		sessionID: opts.sessionId,
		role: "assistant",
		time: {
			created: created ?? time,
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
		tokens: usageTokens(usage),
		...finish === void 0 ? {} : { finish }
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
			...time.end === void 0 ? {} : { end: time.end }
		}
	};
}
/** Build the v1 text/reasoning/tool parts for one assistant message. */
function assistantPartsFromMessage(message, time, opts, blockStart, blockEnd, partIdFor) {
	const parts = [];
	const calls = /* @__PURE__ */ new Map();
	const messageID = String(message.id);
	message.content.forEach((block, index) => {
		const start = blockStart?.(index, block.type) ?? time;
		if (block.type === "text") parts.push(textPart(partIdFor?.(index, block.type) ?? `${messageID}:${index}`, messageID, block.text, {
			start,
			end: time
		}, opts));
		else if (block.type === "reasoning") parts.push({
			id: partIdFor?.(index, block.type) ?? `${messageID}:${index}`,
			sessionID: opts.sessionId,
			messageID,
			type: "reasoning",
			text: block.text,
			time: {
				start,
				end: blockEnd?.(index, "reasoning") ?? time
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
function earliestBlockStart$1(blockStarts, turn, step) {
	let earliest;
	for (const [key, value] of blockStarts) {
		const [keyTurn, keyStep] = key.split(":");
		if (Number(keyTurn) === turn && Number(keyStep) === step) {
			if (earliest === void 0 || value < earliest) earliest = value;
		}
	}
	return earliest;
}
function accumulateStreamBlock(blocksByStep, turn, step, index, blockType, text, start) {
	const stepKey = `${turn}:${step}`;
	let blocks = blocksByStep.get(stepKey);
	if (!blocks) {
		blocks = /* @__PURE__ */ new Map();
		blocksByStep.set(stepKey, blocks);
	}
	const blockKey = `${index}:${blockType}`;
	const existing = blocks.get(blockKey);
	if (existing) existing.text += text;
	else blocks.set(blockKey, {
		blockType,
		start,
		text
	});
}
function partialAssistantMessageInfo(id, created, parentID, opts) {
	const model = opts.defaultModel ?? {
		providerID: "deepseek",
		modelID: "deepseek-chat"
	};
	return {
		id,
		sessionID: opts.sessionId,
		role: "assistant",
		time: { created },
		parentID,
		modelID: model.modelID,
		providerID: model.providerID,
		mode: DEFAULT_AGENT,
		path: {
			cwd: opts.cwd,
			root: opts.cwd
		},
		cost: 0,
		tokens: ZERO_TOKENS
	};
}
function v1StreamPart(block, messageID, partId, opts) {
	if (block.blockType === "text") return textPart(partId, messageID, block.text, { start: block.start }, opts);
	return {
		id: partId,
		sessionID: opts.sessionId,
		messageID,
		type: "reasoning",
		text: block.text,
		time: { start: block.start }
	};
}
function upsertPartialV1(entries, pending, blocksByStep, pendingCallsByStep, opts, turn, step, created, parentID) {
	const stepKey = `${turn}:${step}`;
	let entry = pending.get(stepKey);
	if (!entry) {
		entry = {
			info: partialAssistantMessageInfo(provisionalMessageId(opts.sessionId, turn, step), created, parentID, opts),
			parts: []
		};
		pending.set(stepKey, entry);
		entries.push(entry);
	}
	const blocks = blocksByStep.get(stepKey);
	if (blocks) for (const [blockKey, block] of blocks) {
		const blockIndex = Number(blockKey.slice(0, blockKey.indexOf(":")));
		const partId = provisionalPartId(opts.sessionId, turn, step, block.blockType, blockIndex);
		const partIndex = entry.parts.findIndex((part) => part.id === partId);
		const replacement = v1StreamPart(block, entry.info.id, partId, opts);
		if (partIndex === -1) entry.parts.push(replacement);
		else entry.parts[partIndex] = replacement;
	}
	const calls = pendingCallsByStep.get(stepKey);
	if (calls) {
		for (const call of calls.values()) if (!entry.parts.some((part) => part.type === "tool" && part.callID === call.callId)) entry.parts.push(pendingToolPart(call, {
			sessionID: opts.sessionId,
			messageID: entry.info.id,
			time: created
		}));
	}
	return entry;
}
function applyToolResultV1(entries, calls, event, opts, view) {
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
		meta: data.meta,
		view,
		callView: call.view
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
function convertMessagesV1(events, opts, views) {
	const entries = [];
	const calls = /* @__PURE__ */ new Map();
	const blockStarts = /* @__PURE__ */ new Map();
	const turnStarts = /* @__PURE__ */ new Map();
	const finishReasons = /* @__PURE__ */ new Map();
	const blockEnds = /* @__PURE__ */ new Map();
	const blocksByStep = /* @__PURE__ */ new Map();
	const pending = /* @__PURE__ */ new Map();
	const pendingCallsByStep = /* @__PURE__ */ new Map();
	let lastMessageId = "";
	for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
		const event = events[eventIndex];
		const view = views?.[eventIndex];
		switch (event.type) {
			case "turn/start":
				turnStarts.set(event.data.turn, event.time);
				break;
			case "user/message": {
				const data = event.data;
				const id = String(data.id);
				const compact = isCompactCheckpoint(event);
				entries.push({
					info: userMessageInfo(id, event.time, opts),
					parts: compact ? [compactionPart(id, opts, isAutoCompactCheckpoint(event))] : userPartsFromMessage(id, data.content, event.time, opts)
				});
				lastMessageId = id;
				break;
			}
			case "assistant/chunk": {
				const data = event.data;
				const chunk = data.chunk;
				if (chunk.type === "block-start") blockStarts.set(`${data.turn}:${data.step}:${chunk.index}:${chunk.blockType}`, event.time);
				else if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
					const blockType = chunk.type === "text-delta" ? "text" : "reasoning";
					const key = `${data.turn}:${data.step}:${chunk.index}:${blockType}`;
					if (!blockStarts.has(key)) blockStarts.set(key, event.time);
					blockEnds.set(key, event.time);
					const start = blockStarts.get(key) ?? event.time;
					accumulateStreamBlock(blocksByStep, data.turn, data.step, chunk.index, blockType, chunk.text, start);
					upsertPartialV1(entries, pending, blocksByStep, pendingCallsByStep, opts, data.turn, data.step, earliestBlockStart$1(blockStarts, data.turn, data.step) ?? turnStarts.get(data.turn) ?? event.time, lastMessageId || `pending:${opts.sessionId}:user`);
				}
				break;
			}
			case "text-chunks":
			case "reasoning-chunks": {
				const chunk = event;
				const blockType = chunk.type === "text-chunks" ? "text" : "reasoning";
				const key = `${chunk.data.turn}:${chunk.data.step}:${chunk.data.index}:${blockType}`;
				const time0 = chunk.time0 ?? chunk.time;
				if (!blockStarts.has(key)) blockStarts.set(key, time0);
				blockEnds.set(key, event.time);
				const start = blockStarts.get(key) ?? time0;
				accumulateStreamBlock(blocksByStep, chunk.data.turn, chunk.data.step, chunk.data.index, blockType, chunk.data.texts.join(""), start);
				upsertPartialV1(entries, pending, blocksByStep, pendingCallsByStep, opts, chunk.data.turn, chunk.data.step, earliestBlockStart$1(blockStarts, chunk.data.turn, chunk.data.step) ?? turnStarts.get(chunk.data.turn) ?? time0, lastMessageId || `pending:${opts.sessionId}:user`);
				break;
			}
			case "assistant/message": {
				const data = event.data;
				const id = String(data.message.id);
				const stepKey = `${data.turn}:${data.step}`;
				const { parts, calls: messageCalls } = assistantPartsFromMessage(data.message, event.time, opts, (index, blockType) => blockStarts.get(`${data.turn}:${data.step}:${index}:${blockType}`), (index, blockType) => blockEnds.get(`${data.turn}:${data.step}:${index}:${blockType}`));
				for (const [callId, call] of messageCalls) calls.set(callId, call);
				const pendingEntry = pending.get(stepKey);
				const pendingIndex = pendingEntry === void 0 ? -1 : entries.findIndex((entry) => entry.info.id === pendingEntry.info.id);
				entries.push({
					info: assistantMessageInfo(data.message, event.time, lastMessageId || id, opts, data.usage, earliestBlockStart$1(blockStarts, data.turn, data.step) ?? turnStarts.get(data.turn) ?? event.time, finishReasons.get(`${data.turn}:${data.step}`) ?? "stop"),
					parts
				});
				if (pendingIndex !== -1) entries.splice(pendingIndex, 1);
				pending.delete(stepKey);
				pendingCallsByStep.delete(stepKey);
				lastMessageId = id;
				break;
			}
			case "tool/call": {
				const data = event.data;
				const call = {
					callId: String(data.callId),
					name: data.name,
					arguments: data.arguments,
					...view === void 0 ? {} : { view }
				};
				calls.set(call.callId, call);
				const stepKey = `${data.turn}:${data.step}`;
				let stepCalls = pendingCallsByStep.get(stepKey);
				if (!stepCalls) {
					stepCalls = /* @__PURE__ */ new Map();
					pendingCallsByStep.set(stepKey, stepCalls);
				}
				stepCalls.set(call.callId, call);
				const pendingEntry = pending.get(stepKey);
				if (pendingEntry && !pendingEntry.parts.some((part) => part.type === "tool" && part.callID === call.callId)) pendingEntry.parts.push(pendingToolPart(call, {
					sessionID: opts.sessionId,
					messageID: pendingEntry.info.id,
					time: event.time
				}));
				break;
			}
			case "tool/result":
				applyToolResultV1(entries, calls, event, opts, view);
				break;
			default: if (event.type === "goal/change") {
				const text = goalChangeText(event.data);
				if (text !== void 0) {
					const id = `goal:${event.seq}`;
					entries.push({
						info: partialAssistantMessageInfo(id, event.time, lastMessageId || `pending:${opts.sessionId}:user`, opts),
						parts: [textPart(`${id}:note`, id, text, {
							start: event.time,
							end: event.time
						}, opts)]
					});
				}
			}
		}
	}
	return entries;
}
/** Single-event v1 conversion used by the SSE bridge. */
function userMessageFromEvent(event, opts) {
	const id = String(event.data.id);
	return {
		info: userMessageInfo(id, event.time, opts),
		parts: isCompactCheckpoint(event) ? [compactionPart(id, opts, isAutoCompactCheckpoint(event))] : userPartsFromMessage(id, event.data.content, event.time, opts)
	};
}
/** Single-event v1 conversion used by the SSE bridge. */
function assistantMessageFromEvent(event, opts, blockStart, blockEnd, created, parentID, finish, partIdFor) {
	const id = String(event.data.message.id);
	const { parts } = assistantPartsFromMessage(event.data.message, event.time, opts, blockStart, blockEnd, partIdFor);
	return {
		info: assistantMessageInfo(event.data.message, event.time, parentID ?? id, opts, event.data.usage, created, finish),
		parts
	};
}
function partialV2Assistant(id, created, opts) {
	const model = opts.defaultModel ?? {
		providerID: "deepseek",
		modelID: "deepseek-chat"
	};
	return {
		id,
		time: { created },
		type: "assistant",
		agent: DEFAULT_AGENT,
		model: {
			id: model.modelID,
			providerID: model.providerID
		},
		content: [],
		cost: 0,
		tokens: ZERO_TOKENS
	};
}
function v2StreamPart(block, partId) {
	if (block.blockType === "text") return {
		type: "text",
		id: partId,
		text: block.text
	};
	return {
		type: "reasoning",
		id: partId,
		text: block.text,
		time: { created: block.start }
	};
}
function upsertPartialV2(messages, pending, blocksByStep, pendingCallsByStep, opts, turn, step, created) {
	const stepKey = `${turn}:${step}`;
	let info = pending.get(stepKey);
	if (!info) {
		info = partialV2Assistant(provisionalMessageId(opts.sessionId, turn, step), created, opts);
		pending.set(stepKey, info);
		messages.push(info);
	}
	const blocks = blocksByStep.get(stepKey);
	if (blocks) for (const [blockKey, block] of blocks) {
		const blockIndex = Number(blockKey.slice(0, blockKey.indexOf(":")));
		const partId = provisionalPartId(opts.sessionId, turn, step, block.blockType, blockIndex);
		const replacement = v2StreamPart(block, partId);
		const partIndex = info.content.findIndex((part) => part.id === partId);
		if (partIndex === -1) info.content.push(replacement);
		else info.content[partIndex] = replacement;
	}
	const calls = pendingCallsByStep.get(stepKey) ?? /* @__PURE__ */ new Map();
	for (const call of calls.values()) if (!info.content.some((part) => part.type === "tool" && part.id === `tool:${call.callId}`)) {
		const tool = {
			type: "tool",
			id: `tool:${call.callId}`,
			name: call.name,
			state: {
				status: "pending",
				input: call.arguments
			},
			time: { created }
		};
		info.content.push(tool);
	}
	return {
		info,
		calls
	};
}
function toV2ModelRef(message) {
	return {
		id: message.source.model,
		providerID: externalProviderId(message.source.provider)
	};
}
function toV2Assistant(event, opts, created, blockStart) {
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
		} else if (block.type === "reasoning") {
			const start = blockStart?.(index, block.type) ?? event.time;
			content.push({
				type: "reasoning",
				id: `${messageID}:${index}`,
				text: block.text,
				time: {
					created: start,
					completed: event.time
				}
			});
		} else if (block.type === "tool-call") {
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
				created: created ?? event.time,
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
function convertMessagesV2(events, opts, views) {
	const messages = [];
	const calls = /* @__PURE__ */ new Map();
	const blockStarts = /* @__PURE__ */ new Map();
	const turnStarts = /* @__PURE__ */ new Map();
	const blocksByStep = /* @__PURE__ */ new Map();
	const pending = /* @__PURE__ */ new Map();
	const pendingCallsByStep = /* @__PURE__ */ new Map();
	let lastAssistant;
	for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
		const event = events[eventIndex];
		const view = views?.[eventIndex];
		switch (event.type) {
			case "turn/start":
				turnStarts.set(event.data.turn, event.time);
				break;
			case "user/message": {
				const data = event.data;
				const compact = isCompactCheckpoint(event);
				const message = {
					id: String(data.id),
					time: { created: event.time },
					text: compact ? "" : textFromBlocks(data.content),
					type: "user"
				};
				messages.push(message);
				break;
			}
			case "assistant/chunk": {
				const data = event.data;
				const chunk = data.chunk;
				if (chunk.type === "block-start") blockStarts.set(`${data.turn}:${data.step}:${chunk.index}:${chunk.blockType}`, event.time);
				else if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
					const blockType = chunk.type === "text-delta" ? "text" : "reasoning";
					const key = `${data.turn}:${data.step}:${chunk.index}:${blockType}`;
					if (!blockStarts.has(key)) blockStarts.set(key, event.time);
					const start = blockStarts.get(key) ?? event.time;
					accumulateStreamBlock(blocksByStep, data.turn, data.step, chunk.index, blockType, chunk.text, start);
					lastAssistant = upsertPartialV2(messages, pending, blocksByStep, pendingCallsByStep, opts, data.turn, data.step, earliestBlockStart$1(blockStarts, data.turn, data.step) ?? turnStarts.get(data.turn) ?? event.time);
				}
				break;
			}
			case "text-chunks":
			case "reasoning-chunks": {
				const chunk = event;
				const blockType = chunk.type === "text-chunks" ? "text" : "reasoning";
				const key = `${chunk.data.turn}:${chunk.data.step}:${chunk.data.index}:${blockType}`;
				const time0 = chunk.time0 ?? chunk.time;
				if (!blockStarts.has(key)) blockStarts.set(key, time0);
				const start = blockStarts.get(key) ?? time0;
				accumulateStreamBlock(blocksByStep, chunk.data.turn, chunk.data.step, chunk.data.index, blockType, chunk.data.texts.join(""), start);
				lastAssistant = upsertPartialV2(messages, pending, blocksByStep, pendingCallsByStep, opts, chunk.data.turn, chunk.data.step, earliestBlockStart$1(blockStarts, chunk.data.turn, chunk.data.step) ?? turnStarts.get(chunk.data.turn) ?? time0);
				break;
			}
			case "assistant/message": {
				const data = event.data;
				const stepKey = `${data.turn}:${data.step}`;
				const state = toV2Assistant(event, opts, earliestBlockStart$1(blockStarts, data.turn, data.step) ?? turnStarts.get(data.turn) ?? event.time, (index, blockType) => blockStarts.get(`${data.turn}:${data.step}:${index}:${blockType}`));
				const pendingMessage = pending.get(stepKey);
				const pendingIndex = pendingMessage === void 0 ? -1 : messages.findIndex((message) => message.id === pendingMessage.id);
				messages.push(state.info);
				if (pendingIndex !== -1) messages.splice(pendingIndex, 1);
				pending.delete(stepKey);
				pendingCallsByStep.delete(stepKey);
				for (const [callId, call] of state.calls) calls.set(callId, call);
				lastAssistant = state;
				break;
			}
			case "tool/call": {
				const data = event.data;
				const call = {
					callId: String(data.callId),
					name: data.name,
					arguments: data.arguments,
					...view === void 0 ? {} : { view }
				};
				calls.set(call.callId, call);
				const stepKey = `${data.turn}:${data.step}`;
				let stepCalls = pendingCallsByStep.get(stepKey);
				if (!stepCalls) {
					stepCalls = /* @__PURE__ */ new Map();
					pendingCallsByStep.set(stepKey, stepCalls);
				}
				stepCalls.set(call.callId, call);
				const pendingMessage = pending.get(stepKey);
				if (pendingMessage && !pendingMessage.content.some((part) => part.type === "tool" && part.id === `tool:${call.callId}`)) pendingMessage.content.push({
					type: "tool",
					id: `tool:${call.callId}`,
					name: call.name,
					state: {
						status: "pending",
						input: call.arguments
					},
					time: { created: event.time }
				});
				if (pendingMessage) lastAssistant = {
					info: pendingMessage,
					calls: stepCalls
				};
				break;
			}
			case "tool/result":
				applyToolResultV2(messages, lastAssistant, calls, event, opts);
				break;
			default: if (event.type === "goal/change") {
				const text = goalChangeText(event.data);
				if (text !== void 0) {
					const id = `goal:${event.seq}`;
					const model = opts.defaultModel ?? {
						providerID: "deepseek",
						modelID: "deepseek-chat"
					};
					messages.push({
						id,
						time: {
							created: event.time,
							completed: event.time
						},
						type: "assistant",
						agent: DEFAULT_AGENT,
						model: {
							id: model.modelID,
							providerID: model.providerID
						},
						content: [{
							type: "text",
							id: `${id}:note`,
							text
						}],
						cost: 0,
						tokens: ZERO_TOKENS
					});
				}
			}
		}
	}
	return messages;
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
//#region src/bridge/git.ts
/**
* Keep only diffs whose path is inside `cwd` and is tracked by git. Calls
* `git ls-files --error-unmatch` through an argv array so paths can never be
* interpreted as shell syntax.
*/
function filterGitTrackedDiffs(cwd, diffs) {
	const root = resolve(cwd);
	return diffs.filter((diff) => {
		if (diff.file === void 0 || diff.file === "") return false;
		const resolved = resolve(root, diff.file);
		const rel = relative(root, resolved);
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
		return spawnSync("git", [
			"-C",
			root,
			"ls-files",
			"--error-unmatch",
			"--",
			rel
		], {
			stdio: [
				"ignore",
				"ignore",
				"pipe"
			],
			encoding: "utf8"
		}).status === 0;
	});
}
//#endregion
//#region src/bridge/events.ts
/**
* Build the opencode SSE events that make a server-side command result
* visible in the TUI: an optional session status change plus one synthetic
* assistant message with a text part. The message is intentionally
* ephemeral — dsh history is not touched, so no model turn is triggered.
*/
function commandResultEvents(deps, sessionId, text, options = {}) {
	const directory = directoryFor(sessionId, deps);
	const project = projectIdFor(directory);
	const events = [];
	if (options.status !== void 0) events.push(makeEvent(directory, "session.status", {
		sessionID: sessionId,
		status: { type: options.status }
	}, project));
	const id = `msg_cmd:${randomUUID()}`;
	const partId = `prt_cmd:${randomUUID()}`;
	const created = Date.now();
	const model = deps.defaultModel ?? {
		providerID: "deepseek",
		modelID: "deepseek-chat"
	};
	events.push(makeEvent(directory, "message.updated", {
		sessionID: sessionId,
		info: {
			id,
			sessionID: sessionId,
			role: "assistant",
			agent: DEFAULT_AGENT,
			time: { created },
			parentID: options.parentID ?? `pending:${sessionId}:user`,
			modelID: model.modelID,
			providerID: model.providerID,
			mode: DEFAULT_AGENT,
			path: {
				cwd: directory,
				root: directory
			},
			cost: 0,
			tokens: zeroTokens()
		}
	}, project));
	events.push(makeEvent(directory, "message.part.updated", {
		sessionID: sessionId,
		part: {
			id: partId,
			sessionID: sessionId,
			messageID: id,
			type: "text",
			text,
			time: { start: created }
		},
		time: created
	}, project));
	return events;
}
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
/** Best-effort structured progress label for a started tool call. */
function toolProgressStructured(call) {
	const present = call.view?.for === "call" ? call.view.view : void 0;
	return {
		title: typeof present?.title === "string" ? present.title : opencodeToolName(call.name, safeJsonParse(call.arguments)),
		...typeof present?.card === "string" ? { card: present.card } : {}
	};
}
function earliestBlockStart(blockStarts, turn, step) {
	let earliest;
	for (const [key, value] of blockStarts) {
		const [keyTurn, keyStep] = key.split(":");
		if (Number(keyTurn) === turn && Number(keyStep) === step) {
			if (earliest === void 0 || value < earliest) earliest = value;
		}
	}
	return earliest;
}
function zeroTokens() {
	return {
		input: 0,
		output: 0,
		reasoning: 0,
		cache: {
			read: 0,
			write: 0
		}
	};
}
function provisionalAssistantMessage(sessionId, deps, id, created, parentID) {
	const model = deps.defaultModel ?? {
		providerID: "deepseek",
		modelID: "deepseek-chat"
	};
	return {
		id,
		sessionID: sessionId,
		role: "assistant",
		agent: "build",
		time: { created },
		parentID,
		modelID: model.modelID,
		providerID: model.providerID,
		mode: "build",
		path: {
			cwd: deps.cwd,
			root: deps.cwd
		},
		cost: 0,
		tokens: zeroTokens()
	};
}
function streamPart(blockType, sessionId, messageId, partId, text, start, end) {
	return {
		id: partId,
		sessionID: sessionId,
		messageID: messageId,
		type: blockType,
		text,
		time: end === void 0 ? { start } : {
			start,
			end
		}
	};
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
	streams = /* @__PURE__ */ new Map();
	sessionGoals;
	sessionTodos;
	flushMs;
	setTimer;
	clearTimer;
	constructor(deps) {
		this.deps = deps;
		this.flushMs = deps.toolFlushMs ?? 32;
		this.setTimer = deps.setTimeoutImpl ?? ((callback, ms) => setTimeout(callback, ms));
		this.clearTimer = deps.clearTimeoutImpl ?? ((handle) => {
			if (handle !== void 0) clearTimeout(handle);
		});
		this.sessionGoals = deps.sharedState?.goals ?? /* @__PURE__ */ new Map();
		this.sessionTodos = deps.sharedState?.todos ?? /* @__PURE__ */ new Map();
	}
	streamState(sessionId) {
		let state = this.streams.get(sessionId);
		if (!state) {
			state = {
				provisionalMessageIds: /* @__PURE__ */ new Map(),
				blockStarts: /* @__PURE__ */ new Map(),
				blockEnds: /* @__PURE__ */ new Map(),
				finishReasons: /* @__PURE__ */ new Map(),
				blocks: /* @__PURE__ */ new Map(),
				compactions: /* @__PURE__ */ new Map(),
				toolInputs: /* @__PURE__ */ new Map()
			};
			this.streams.set(sessionId, state);
		}
		return state;
	}
	/** Emit the merged goal + todo list for one session. */
	todoUpdateEvents(sessionId, directory, project) {
		return [makeEvent(directory, "todo.updated", {
			sessionID: sessionId,
			todos: convertGoalTodos(this.sessionGoals.get(sessionId), this.sessionTodos.get(sessionId))
		}, project)];
	}
	toolKey(turn, step, index) {
		return `${turn}:${step}:${index}`;
	}
	assistantMessageId(sessionId, turn, step) {
		return this.currentAssistant.get(sessionId) ?? this.streamState(sessionId).provisionalMessageIds.get(`${turn}:${step}`) ?? `assistant:${turn}:${step}`;
	}
	findToolInput(sessionId, callId) {
		for (const state of this.streamState(sessionId).toolInputs.values()) if (state.callId === callId) return state;
	}
	/**
	* Register a streamed tool input on its first `tool-call-delta` and emit the
	* v2 `input.started` event plus a v1 running ToolPart placeholder.
	*/
	startToolInput(sessionId, turn, step, index, chunk, time, directory, project) {
		const key = this.toolKey(turn, step, index);
		const existing = this.streamState(sessionId).toolInputs.get(key);
		if (existing !== void 0) return {
			state: existing,
			events: []
		};
		const callId = String(chunk.id);
		const messageID = this.assistantMessageId(sessionId, turn, step);
		const state = {
			key,
			callId,
			name: chunk.name ?? "",
			messageID,
			text: "",
			pendingDelta: "",
			lastTime: time,
			ended: false
		};
		this.streamState(sessionId).toolInputs.set(key, state);
		return {
			state,
			events: [makeEvent(directory, "session.next.tool.input.started", {
				timestamp: time,
				sessionID: sessionId,
				assistantMessageID: messageID,
				callID: callId,
				name: state.name
			}, project), makeEvent(directory, "message.part.updated", {
				sessionID: sessionId,
				part: streamingToolPart({
					callId,
					name: state.name,
					arguments: ""
				}, {
					sessionID: sessionId,
					messageID,
					time
				}),
				time
			}, project)]
		};
	}
	/** Coalesce deltas for one tool input into a single pending flush. */
	queueToolDelta(sessionId, state, delta, time, directory, project) {
		state.pendingDelta += delta;
		state.lastTime = time;
		if (state.timer !== void 0) return;
		state.timer = this.setTimer(() => {
			state.timer = void 0;
			const events = this.flushToolDelta(sessionId, state, directory, project);
			if (events.length > 0) this.deps.onFlush?.(events);
		}, this.flushMs);
	}
	/** Flush one coalesced input delta as v2 delta + v1 running part update. */
	flushToolDelta(sessionId, state, directory, project) {
		if (state.timer !== void 0) {
			this.clearTimer(state.timer);
			state.timer = void 0;
		}
		if (state.ended || state.pendingDelta.length === 0) return [];
		const delta = state.pendingDelta;
		state.pendingDelta = "";
		return [makeEvent(directory, "session.next.tool.input.delta", {
			timestamp: state.lastTime,
			sessionID: sessionId,
			assistantMessageID: state.messageID,
			callID: state.callId,
			delta
		}, project), makeEvent(directory, "message.part.updated", {
			sessionID: sessionId,
			part: streamingToolPart({
				callId: state.callId,
				name: state.name,
				arguments: state.text
			}, {
				sessionID: sessionId,
				messageID: state.messageID,
				time: state.lastTime
			}),
			time: state.lastTime
		}, project)];
	}
	/**
	* Finish a streamed tool input: flush remaining deltas, emit `input.ended`
	* plus `called` with the full parsed input.
	*/
	endToolInput(sessionId, state, directory, project, time) {
		const events = this.flushToolDelta(sessionId, state, directory, project);
		if (state.ended) return events;
		state.ended = true;
		const input = safeJsonParse(state.text);
		events.push(makeEvent(directory, "session.next.tool.input.ended", {
			timestamp: time,
			sessionID: sessionId,
			assistantMessageID: state.messageID,
			callID: state.callId,
			text: state.text
		}, project), makeEvent(directory, "session.next.tool.called", {
			timestamp: time,
			sessionID: sessionId,
			assistantMessageID: state.messageID,
			callID: state.callId,
			tool: opencodeToolName(state.name, input),
			input,
			provider: { executed: false }
		}, project), makeEvent(directory, "session.next.tool.progress", {
			timestamp: time,
			sessionID: sessionId,
			assistantMessageID: state.messageID,
			callID: state.callId,
			structured: { title: opencodeToolName(state.name, safeJsonParse(state.text)) },
			content: []
		}, project));
		return events;
	}
	/** Non-streamed fallback: emit started/ended/called in one batch. */
	completeToolInputImmediately(sessionId, call, messageID, directory, project, time) {
		const input = safeJsonParse(call.arguments);
		return [
			makeEvent(directory, "session.next.tool.input.started", {
				timestamp: time,
				sessionID: sessionId,
				assistantMessageID: messageID,
				callID: call.callId,
				name: call.name
			}, project),
			makeEvent(directory, "session.next.tool.input.ended", {
				timestamp: time,
				sessionID: sessionId,
				assistantMessageID: messageID,
				callID: call.callId,
				text: call.arguments
			}, project),
			makeEvent(directory, "session.next.tool.called", {
				timestamp: time,
				sessionID: sessionId,
				assistantMessageID: messageID,
				callID: call.callId,
				tool: opencodeToolName(call.name, input),
				input,
				provider: { executed: false }
			}, project),
			makeEvent(directory, "session.next.tool.progress", {
				timestamp: time,
				sessionID: sessionId,
				assistantMessageID: messageID,
				callID: call.callId,
				structured: toolProgressStructured(call),
				content: []
			}, project)
		];
	}
	clearToolTimers(sessionId) {
		for (const state of this.streamState(sessionId).toolInputs.values()) if (state.timer !== void 0) {
			this.clearTimer(state.timer);
			state.timer = void 0;
		}
	}
	/** Clear any pending throttle timers; safe to call when the SSE ends. */
	dispose() {
		for (const sessionId of [...this.streams.keys()]) this.clearToolTimers(sessionId);
	}
	/**
	* Translate the dsh compaction lifecycle to the opencode
	* `session.next.compaction.*` family. The replacement checkpoint
	* `user/message` emits `session.next.compaction.ended` itself, so
	* `compaction/end` only emits when the checkpoint never appeared (e.g. a
	* failed summary) to avoid duplicate compaction entries in the TUI.
	*/
	translateCompactionEvent(sessionId, event, directory, project) {
		const key = typeof event.data.compactionId === "string" ? event.data.compactionId : String(event.data.compactionId ?? "");
		if (!key) return [];
		const state = this.streamState(sessionId);
		const reason = event.data.sourceCommandId === void 0 ? "auto" : "manual";
		switch (event.type) {
			case "compaction/start": {
				const messageID = `checkpoint:${key}`;
				state.compactions.set(key, {
					messageID,
					text: "",
					reason,
					ended: false
				});
				return [makeEvent(directory, "session.next.compaction.started", {
					timestamp: event.time,
					sessionID: sessionId,
					messageID,
					reason
				}, project)];
			}
			case "compaction/summary": {
				const pending = state.compactions.get(key);
				if (!pending) return [];
				pending.text = textFromBlocks(event.data.summary ?? []);
				return [makeEvent(directory, "session.next.compaction.delta", {
					timestamp: event.time,
					sessionID: sessionId,
					messageID: pending.messageID,
					text: pending.text
				}, project)];
			}
			case "compaction/end": {
				const pending = state.compactions.get(key);
				if (!pending || pending.ended) return [];
				pending.ended = true;
				state.compactions.delete(key);
				const text = pending.text || (typeof event.data.error === "string" && event.data.error ? `Compaction failed: ${event.data.error}` : "");
				return [makeEvent(directory, "session.next.compaction.ended", {
					timestamp: event.time,
					sessionID: sessionId,
					messageID: pending.messageID,
					reason: pending.reason,
					text,
					recent: ""
				}, project)];
			}
		}
	}
	translate(frame) {
		const payload = frame.payload;
		switch (payload.type) {
			case "session/event": return this.translateSessionEvent(frame.rpcId, payload.sessionId, payload.event, payload.view);
			case "approval/requested": {
				const approvalId = String(payload.approvalId);
				if (this.deps.replayGuard?.approvals.has(approvalId)) return [];
				this.deps.replayGuard?.approvals.add(approvalId);
				const entry = {
					rpcId: String(frame.rpcId),
					sessionId: String(payload.sessionId),
					approvalId,
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
				const questionKey = String(frame.rpcId);
				if (this.deps.replayGuard?.questions.has(questionKey)) return [];
				this.deps.replayGuard?.questions.add(questionKey);
				const entry = {
					rpcId: questionKey,
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
				return [makeEvent(this.deps.cwd, "session.error", { error: {
					code: payload.error.code,
					message: payload.error.message
				} }, projectIdFor(this.deps.cwd))];
			default:
				this.deps.log(`[bridge/events] unhandled mux frame ${String(payload.type)}`);
				return [];
		}
	}
	translateProjection(sessionId, key, value) {
		const directory = directoryFor(sessionId, this.deps);
		const project = projectIdFor(directory);
		if (key === "todos") {
			this.sessionTodos.set(sessionId, value);
			return this.todoUpdateEvents(sessionId, directory, project);
		}
		if (key === "goal") {
			this.sessionGoals.set(sessionId, value);
			return this.todoUpdateEvents(sessionId, directory, project);
		}
		if (key === "produced-files") return [makeEvent(directory, "session.diff", {
			sessionID: sessionId,
			diff: filterGitTrackedDiffs(directory, convertProducedFiles(value))
		}, project)];
		if (key === "title") {
			const title = typeof value === "string" ? value : "";
			this.deps.state.setSessionTitle(sessionId, title);
			return [makeEvent(directory, "session.updated", {
				sessionID: sessionId,
				info: minimalSession(sessionId, {
					cwd: directory,
					title
				})
			}, project)];
		}
		return [];
	}
	translateSessionEvent(rpcId, sessionId, event, view) {
		const directory = directoryFor(sessionId, this.deps);
		const project = projectIdFor(directory);
		switch (event.type) {
			case "user/message": {
				this.deps.state.markInput();
				const events = messageEvents(sessionId, this.deps, () => {
					const entry = userMessageFromEvent(event, messageOptions(sessionId, this.deps));
					return {
						info: entry.info,
						parts: entry.parts
					};
				});
				if (isCompactCheckpoint(event)) {
					const source = event.data.source;
					const key = typeof source.compactionId === "string" ? source.compactionId : void 0;
					if (key !== void 0) {
						const pending = this.streamState(sessionId).compactions.get(key);
						if (pending) {
							pending.messageID = String(event.data.id);
							pending.text = textFromBlocks(event.data.content);
							pending.reason = isAutoCompactCheckpoint(event) ? "auto" : "manual";
							pending.ended = true;
							this.streamState(sessionId).compactions.delete(key);
						}
					}
					events.push(makeEvent(directory, "session.next.compaction.ended", {
						timestamp: event.time,
						sessionID: sessionId,
						messageID: String(event.data.id),
						reason: isAutoCompactCheckpoint(event) ? "auto" : "manual",
						text: textFromBlocks(event.data.content),
						recent: ""
					}, project));
				}
				this.streamState(sessionId).lastUserMessageId = String(event.data.id);
				return events;
			}
			case "compaction/start":
			case "compaction/summary":
			case "compaction/end": return this.translateCompactionEvent(sessionId, event, directory, project);
			case "assistant/chunk": {
				const chunk = event.data.chunk;
				if (chunk.type === "block-start") {
					this.streamState(sessionId).blockStarts.set(`${event.data.turn}:${event.data.step}:${chunk.index}:${chunk.blockType}`, event.time);
					return [];
				}
				if (chunk.type === "finish") {
					this.streamState(sessionId).finishReasons.set(`${event.data.turn}:${event.data.step}`, chunk.reason.kind);
					return [];
				}
				if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") return this.translateStreamChunks(sessionId, {
					type: chunk.type === "text-delta" ? "text-chunks" : "reasoning-chunks",
					seq: event.seq,
					time: event.time,
					time0: event.time,
					data: {
						turn: event.data.turn,
						step: event.data.step,
						index: chunk.index,
						texts: [chunk.text]
					}
				}, directory, project);
				if (chunk.type === "tool-call-delta") {
					const { state, events } = this.startToolInput(sessionId, event.data.turn, event.data.step, chunk.index, {
						id: chunk.id,
						name: chunk.name
					}, event.time, directory, project);
					if (state.name === "" && chunk.name !== void 0) state.name = chunk.name;
					state.text += chunk.argumentsDelta;
					state.lastTime = event.time;
					this.queueToolDelta(sessionId, state, chunk.argumentsDelta, event.time, directory, project);
					return events;
				}
				return [];
			}
			case "text-chunks":
			case "reasoning-chunks": return this.translateStreamChunks(sessionId, event, directory, project);
			case "assistant/message": {
				const state = this.streamState(sessionId);
				const stepKey = `${event.data.turn}:${event.data.step}`;
				const provisionalId = state.provisionalMessageIds.get(stepKey);
				const streamed = provisionalId !== void 0;
				const messageID = streamed ? provisionalId : String(event.data.message.id);
				const created = earliestBlockStart(state.blockStarts, event.data.turn, event.data.step) ?? state.turnStartTime ?? event.time;
				const events = messageEvents(sessionId, this.deps, () => {
					const entry = assistantMessageFromEvent(event, messageOptions(sessionId, this.deps), (index, blockType) => state.blockStarts.get(`${event.data.turn}:${event.data.step}:${index}:${blockType}`), (index, blockType) => state.blockEnds.get(`${event.data.turn}:${event.data.step}:${index}:${blockType}`), created, state.lastUserMessageId, state.finishReasons.get(stepKey) ?? "stop", (index, blockType) => {
						const block = state.blocks.get(`${event.data.turn}:${event.data.step}:${index}`);
						return block !== void 0 && block.blockType === blockType ? block.partId : void 0;
					});
					return {
						info: {
							...entry.info,
							id: messageID
						},
						parts: entry.parts.map((part) => ({
							...part,
							messageID
						}))
					};
				});
				if (streamed) state.provisionalMessageIds.delete(stepKey);
				this.currentAssistant.set(sessionId, messageID);
				let calls = this.pendingCalls.get(sessionId);
				if (!calls) {
					calls = /* @__PURE__ */ new Map();
					this.pendingCalls.set(sessionId, calls);
				}
				for (const block of event.data.message.content) if (block.type === "tool-call") {
					calls.set(String(block.id), {
						callId: String(block.id),
						name: block.name,
						arguments: block.arguments
					});
					const inputState = this.findToolInput(sessionId, String(block.id));
					if (inputState !== void 0 && !inputState.ended) events.push(...this.endToolInput(sessionId, inputState, directory, project, event.time));
				}
				for (const key of [...state.blocks.keys()]) if (key.startsWith(`${stepKey}:`)) state.blocks.delete(key);
				return events;
			}
			case "turn/start":
				this.streamState(sessionId).turnStartTime = event.time;
				return [makeEvent(directory, "session.status", {
					sessionID: sessionId,
					status: { type: "busy" }
				}, project), makeEvent(directory, "turn.wait", { sessionID: sessionId }, project)];
			case "turn/end": {
				const state = this.streamState(sessionId);
				const events = [
					makeEvent(directory, "session.status", {
						sessionID: sessionId,
						status: { type: "idle" }
					}, project),
					makeEvent(directory, "session.idle", { sessionID: sessionId }, project),
					makeEvent(directory, "turn.idle", { sessionID: sessionId }, project)
				];
				for (const [key, candidate] of [...state.blocks]) if (candidate.blockType === "reasoning") {
					events.push(makeEvent(directory, "message.part.updated", {
						sessionID: sessionId,
						part: streamPart("reasoning", sessionId, candidate.messageId, candidate.partId, candidate.text, candidate.start, event.time),
						time: event.time
					}, project));
					state.blocks.delete(key);
				}
				this.currentAssistant.delete(sessionId);
				this.pendingCalls.delete(sessionId);
				this.clearToolTimers(sessionId);
				this.streams.delete(sessionId);
				return events;
			}
			case "todo/write":
				this.sessionTodos.set(sessionId, event.data.todos);
				return this.todoUpdateEvents(sessionId, directory, project);
			case "goal/change": {
				const data = event.data;
				if (data?.goal !== void 0) this.sessionGoals.set(sessionId, { goal: data.goal });
				else if (data?.cleared !== void 0) this.sessionGoals.set(sessionId, null);
				else return [];
				return this.todoUpdateEvents(sessionId, directory, project);
			}
			case "tool/call": {
				const data = event.data;
				const call = {
					callId: String(data.callId),
					name: data.name,
					arguments: data.arguments,
					...view === void 0 ? {} : { view }
				};
				let calls = this.pendingCalls.get(sessionId);
				if (!calls) {
					calls = /* @__PURE__ */ new Map();
					this.pendingCalls.set(sessionId, calls);
				}
				calls.set(call.callId, call);
				const messageID = this.currentAssistant.get(sessionId) ?? this.streamState(sessionId).provisionalMessageIds.get(`${data.turn}:${data.step}`) ?? `assistant:${data.turn}:${data.step}`;
				const inputState = this.findToolInput(sessionId, call.callId);
				return [...inputState === void 0 ? this.completeToolInputImmediately(sessionId, call, messageID, directory, project, event.time) : this.endToolInput(sessionId, inputState, directory, project, event.time), makeEvent(directory, "message.part.updated", {
					sessionID: sessionId,
					part: pendingToolPart(call, {
						sessionID: sessionId,
						messageID,
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
				const messageID = this.currentAssistant.get(sessionId) ?? this.streamState(sessionId).provisionalMessageIds.get(`${data.turn}:${data.step}`) ?? `assistant:${data.turn}:${data.step}`;
				const inputState = this.findToolInput(sessionId, callId);
				const inputEvents = inputState === void 0 ? this.completeToolInputImmediately(sessionId, call, messageID, directory, project, event.time) : this.endToolInput(sessionId, inputState, directory, project, event.time);
				const resultInfo = {
					callId,
					content: data.message.content,
					time: event.time,
					meta: data.meta,
					view,
					callView: call.view
				};
				const part = data.error === void 0 ? completedToolPart(call, { ...resultInfo }, {
					sessionID: sessionId,
					messageID,
					time: event.time
				}) : errorToolPart(call, {
					...resultInfo,
					error: data.error
				}, {
					sessionID: sessionId,
					messageID,
					time: event.time
				});
				calls?.delete(callId);
				const events = [makeEvent(directory, "message.part.updated", {
					sessionID: sessionId,
					part,
					time: event.time
				}, project)];
				const output = toolResultText(resultInfo);
				const tail = data.error === void 0 ? [makeEvent(directory, "session.next.tool.success", {
					timestamp: event.time,
					sessionID: sessionId,
					assistantMessageID: messageID,
					callID: callId,
					structured: toolResultStructured(resultInfo),
					content: [{
						type: "text",
						text: output
					}],
					provider: { executed: true }
				}, project)] : [makeEvent(directory, "session.next.tool.failed", {
					timestamp: event.time,
					sessionID: sessionId,
					assistantMessageID: messageID,
					callID: callId,
					error: {
						code: data.error.code,
						message: data.error.name
					},
					provider: { executed: true }
				}, project)];
				if (data.error === void 0) {
					const changes = fileChangesFromToolResult(call, resultInfo);
					if (changes.length > 0) events.push(...fileChangeEvents(sessionId, messageID, changes, project, directory, event.time));
				}
				return [
					...inputEvents,
					...events,
					...tail
				];
			}
			default: {
				const type = event.type;
				const data = event.data;
				if (type === "session") {
					const header = data;
					const childDirectory = header.cwd ?? this.deps.state.sessionDirectories.get(sessionId) ?? directory;
					const parentID = this.deps.state.sessionParents.get(sessionId);
					return [makeEvent(childDirectory, "session.updated", {
						sessionID: sessionId,
						info: minimalSession(sessionId, {
							cwd: childDirectory,
							title: header.title ?? "",
							createdAt: header.createdAt ?? Date.now(),
							...parentID === void 0 ? {} : { parentID }
						})
					}, projectIdFor(childDirectory))];
				}
				if (type === "session/created") {
					const parentID = this.deps.state.sessionParents.get(sessionId);
					return [makeEvent(directory, "session.updated", {
						sessionID: sessionId,
						info: minimalSession(sessionId, {
							cwd: directory,
							createdAt: data.time,
							...parentID === void 0 ? {} : { parentID }
						})
					}, project)];
				}
				if (type === "session/title") {
					const title = typeof data.title === "string" ? data.title : typeof data.text === "string" ? data.text : "";
					this.deps.state.setSessionTitle(sessionId, title);
					const parentID = this.deps.state.sessionParents.get(sessionId);
					return [makeEvent(directory, "session.updated", {
						sessionID: sessionId,
						info: minimalSession(sessionId, {
							cwd: directory,
							title,
							createdAt: data.time,
							...parentID === void 0 ? {} : { parentID }
						})
					}, project)];
				}
				this.deps.log(`[bridge/events] unhandled session event ${event.type} (rpcId ${rpcId})`);
				return [];
			}
		}
	}
	translateStreamChunks(sessionId, event, directory, project) {
		const state = this.streamState(sessionId);
		const blockType = event.type === "text-chunks" ? "text" : "reasoning";
		const blockKey = `${event.data.turn}:${event.data.step}:${event.data.index}`;
		const blockStartKey = `${blockKey}:${blockType}`;
		const time0 = event.time0 ?? event.time;
		let block = state.blocks.get(blockKey);
		if (block && block.blockType !== blockType) {
			this.deps.log(`[bridge/events] chunk block type changed for ${blockKey} (${block.blockType} -> ${blockType})`);
			return [];
		}
		const events = [];
		if (!block) {
			if (!state.blockStarts.has(blockStartKey)) state.blockStarts.set(blockStartKey, time0);
			if (blockType === "text") {
				for (const [key, candidate] of [...state.blocks]) if (candidate.blockType === "reasoning" && key.startsWith(`${event.data.turn}:${event.data.step}:`)) {
					events.push(makeEvent(directory, "message.part.updated", {
						sessionID: sessionId,
						part: streamPart("reasoning", sessionId, candidate.messageId, candidate.partId, candidate.text, candidate.start, time0),
						time: time0
					}, project));
					state.blocks.delete(key);
				}
			}
			const stepKey = `${event.data.turn}:${event.data.step}`;
			let provisionalId = state.provisionalMessageIds.get(stepKey);
			if (!provisionalId) {
				provisionalId = provisionalMessageId(sessionId, event.data.turn, event.data.step);
				state.provisionalMessageIds.set(stepKey, provisionalId);
				events.push(makeEvent(directory, "message.updated", {
					sessionID: sessionId,
					info: provisionalAssistantMessage(sessionId, this.deps, provisionalId, state.blockStarts.get(blockStartKey) ?? state.turnStartTime ?? time0, state.lastUserMessageId ?? `pending:${sessionId}:user`)
				}, project));
			}
			block = {
				blockType,
				partId: provisionalPartId(sessionId, event.data.turn, event.data.step, blockType, event.data.index),
				messageId: provisionalId,
				start: state.blockStarts.get(blockStartKey) ?? time0,
				text: "",
				sent: 0
			};
			state.blocks.set(blockKey, block);
		}
		const sent = block.sent;
		block.text += event.data.texts.join("");
		state.blockEnds.set(blockStartKey, event.time ?? time0);
		block.sent = block.text.length;
		if (sent === 0) events.push(makeEvent(directory, "message.part.updated", {
			sessionID: sessionId,
			part: streamPart(block.blockType, sessionId, block.messageId, block.partId, "", block.start),
			time: time0
		}, project));
		if (block.sent > sent) events.push(makeEvent(directory, "message.part.delta", {
			sessionID: sessionId,
			messageID: block.messageId,
			partID: block.partId,
			field: "text",
			delta: block.text.slice(sent),
			time: time0
		}, project));
		return events;
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
		const status = item.status === "added" || item.status === "deleted" || item.status === "modified" ? item.status : file === void 0 ? void 0 : "modified";
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
/** Convert bridge file changes to the opencode SnapshotFileDiff shape. */
function toSnapshotFileDiffs(changes) {
	return changes.map((change) => ({
		file: change.file,
		...change.patch === void 0 ? {} : { patch: change.patch },
		additions: change.additions,
		deletions: change.deletions,
		...change.status === void 0 ? {} : { status: change.status }
	}));
}
/**
* Emit the message parts and session diff that make a completed file-changing
* tool visible to the opencode TUI (sidebar "Modified Files" plus snapshot /
* patch parts for consumers that render them).
*/
function fileChangeEvents(sessionID, messageID, changes, project, directory, time) {
	if (changes.length === 0) return [];
	const trackedChanges = filterGitTrackedDiffs(directory, changes);
	if (trackedChanges.length === 0) return [];
	const patch = trackedChanges.map((change) => change.patch).filter((value) => value !== void 0).join("\n");
	const files = trackedChanges.map((change) => change.file);
	const hash = stableId(`${sessionID}:${messageID}:${files.join("\0")}:${patch}`);
	const events = [makeEvent(directory, "message.part.updated", {
		sessionID,
		part: {
			id: `patch:${hash}`,
			sessionID,
			messageID,
			type: "patch",
			hash,
			files
		},
		time
	}, project), makeEvent(directory, "session.diff", {
		sessionID,
		diff: toSnapshotFileDiffs(trackedChanges)
	}, project)];
	if (patch) events.unshift(makeEvent(directory, "message.part.updated", {
		sessionID,
		part: {
			id: `snapshot:${hash}`,
			sessionID,
			messageID,
			type: "snapshot",
			snapshot: hash
		},
		time
	}, project));
	return events;
}
/**
* Map a dsh `host/agent-error` frame to opencode events: the protocol
* `session.error` plus a visible assistant message so the TUI conversation
* shows the error text instead of swallowing it or rendering an object.
*/
function agentErrorEvents(sessionId, message, cwd) {
	const project = projectIdFor(cwd);
	const created = Date.now();
	const id = `msg_err:${randomUUID()}`;
	const partId = `${id}:0`;
	return [
		makeEvent(cwd, "session.error", {
			sessionID: sessionId,
			error: {
				code: "agent-error",
				message
			}
		}, project),
		makeEvent(cwd, "message.updated", {
			sessionID: sessionId,
			info: {
				id,
				sessionID: sessionId,
				role: "assistant",
				agent: DEFAULT_AGENT,
				time: { created },
				parentID: `pending:${sessionId}:user`,
				modelID: "deepseek-chat",
				providerID: "deepseek",
				mode: DEFAULT_AGENT,
				path: {
					cwd,
					root: cwd
				},
				cost: 0,
				tokens: zeroTokens()
			}
		}, project),
		makeEvent(cwd, "message.part.updated", {
			sessionID: sessionId,
			part: {
				id: partId,
				sessionID: sessionId,
				messageID: id,
				type: "text",
				text: `[错误] ${message}`,
				time: {
					start: created,
					end: created
				}
			},
			time: created
		}, project)
	];
}
//#endregion
//#region src/bridge/state.ts
/**
* In-memory correlation maps between opencode-facing request ids and the dsh
* rpcIds/approval ids that answer them. Populated from the mux stream; the
* HTTP reply routes read it back.
*/
var InteractionState = class InteractionState {
	permissions = /* @__PURE__ */ new Map();
	questions = /* @__PURE__ */ new Map();
	byApprovalId = /* @__PURE__ */ new Map();
	byQuestionRpcId = /* @__PURE__ */ new Map();
	sessionDirectories = /* @__PURE__ */ new Map();
	sessionParents = /* @__PURE__ */ new Map();
	savedPermissions = /* @__PURE__ */ new Map();
	/** Real durable titles learned from history projections / title events. */
	sessionTitles = /* @__PURE__ */ new Map();
	sessionListCache;
	/** In-flight session.list RPC shared by concurrent callers (incl. prefetch). */
	sessionListLoading;
	sessionListGeneration = 0;
	/** Whether this bridge run accepted new user input (banner-bearing content). */
	newInputDuringRun = false;
	/** The session the TUI most recently created/resumed/opened. */
	currentSessionId;
	/** Last agent preset selected during this run (inherited by new sessions). */
	lastAgentPreset;
	historyCache = /* @__PURE__ */ new Map();
	historyLoading = /* @__PURE__ */ new Map();
	historyGenerations = /* @__PURE__ */ new Map();
	getSessionListCache(ttlMs) {
		const cached = this.sessionListCache;
		if (cached !== void 0 && Date.now() - cached.at < ttlMs) return cached.items;
	}
	setSessionListCache(items) {
		this.sessionListCache = {
			items,
			at: Date.now()
		};
	}
	getHistoryCache(key, ttlMs) {
		const entry = this.historyCache.get(key);
		if (entry !== void 0 && Date.now() - entry.at < ttlMs) return entry.value;
	}
	setHistoryCache(key, value) {
		this.historyCache.set(key, {
			value,
			at: Date.now()
		});
	}
	getHistoryLoading(key) {
		return this.historyLoading.get(key);
	}
	setHistoryLoading(key, promise) {
		this.historyLoading.set(key, promise);
	}
	clearHistoryLoading(key, promise) {
		if (this.historyLoading.get(key) === promise) this.historyLoading.delete(key);
	}
	historyGeneration(key) {
		return this.historyGenerations.get(key) ?? 0;
	}
	listGeneration() {
		return this.sessionListGeneration;
	}
	/** Drop list and (optionally per-session) history caches after any mutation. */
	invalidateSession(sessionId) {
		this.sessionListCache = void 0;
		this.sessionListLoading = void 0;
		this.sessionListGeneration += 1;
		this.invalidateHistory(sessionId);
	}
	/** Drop only history pages (used by the live SSE feed). */
	invalidateHistory(sessionId) {
		const bump = (key) => {
			this.historyGenerations.set(key, (this.historyGenerations.get(key) ?? 0) + 1);
		};
		if (sessionId === void 0) {
			for (const key of [...this.historyCache.keys()]) bump(key);
			for (const key of [...this.historyLoading.keys()]) bump(key);
			this.historyCache.clear();
			this.historyLoading.clear();
			return;
		}
		for (const key of [...this.historyCache.keys()]) if (key === sessionId || key.startsWith(`${sessionId}:`)) {
			bump(key);
			this.historyCache.delete(key);
		}
		for (const key of [...this.historyLoading.keys()]) if (key === sessionId || key.startsWith(`${sessionId}:`)) {
			bump(key);
			this.historyLoading.delete(key);
		}
	}
	static savedKey(sessionId, toolName) {
		return `${sessionId}\u0000${toolName}`;
	}
	savePermission(sessionId, toolName) {
		const saved = {
			sessionId,
			toolName,
			grantedAt: Date.now()
		};
		this.savedPermissions.set(InteractionState.savedKey(sessionId, toolName), saved);
		return saved;
	}
	savedPermissionFor(sessionId, toolName) {
		return this.savedPermissions.get(InteractionState.savedKey(sessionId, toolName));
	}
	savedPermissionsList() {
		return [...this.savedPermissions.values()];
	}
	setSessionTitle(sessionId, title) {
		if (typeof title === "string" && title.length > 0) this.sessionTitles.set(sessionId, title);
	}
	sessionTitleFor(sessionId) {
		return this.sessionTitles.get(sessionId);
	}
	/** Record that the user submitted new input during this run. */
	markInput() {
		this.newInputDuringRun = true;
	}
	setCurrentSession(sessionId) {
		this.currentSessionId = sessionId;
	}
	/** Agent-preset-lock notices already shown (dedupe per session + agent). */
	lockedAgentNotices = /* @__PURE__ */ new Set();
	lockedAgentNoticeSeen(sessionId, agent) {
		return this.lockedAgentNotices.has(InteractionState.lockedAgentKey(sessionId, agent));
	}
	markLockedAgentNotice(sessionId, agent) {
		this.lockedAgentNotices.add(InteractionState.lockedAgentKey(sessionId, agent));
	}
	static lockedAgentKey(sessionId, agent) {
		return `${sessionId}\u0000${agent}`;
	}
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
function variantsFor(model) {
	const efforts = model.reasoning?.efforts;
	if (!efforts?.length) return void 0;
	return Object.fromEntries(efforts.map((effort) => [effort.id, {
		reasoningEffort: effort.id,
		name: effort.name
	}]));
}
function v2VariantsFor(model) {
	return (model.reasoning?.efforts ?? []).map((effort) => ({
		id: effort.id,
		headers: {},
		body: {
			reasoningEffort: effort.id,
			name: effort.name
		}
	}));
}
function v1Model(group, model) {
	const modelId = model.id;
	const providerId = externalProviderId(group.id);
	const limit = limitFor(group.id, model.id);
	return {
		id: modelId,
		providerID: providerId,
		api: {
			id: providerId,
			url: "",
			npm: "@deepseek-ai/dsh"
		},
		name: modelNameFor(group.id, model.id, model.name),
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
		headers: {},
		...variantsFor(model) === void 0 ? {} : { variants: variantsFor(model) }
	};
}
/** `GET /config/providers` → `providers` array (v1 `Provider[]`). */
function convertToV1Providers(groups) {
	return groups.map((group) => {
		const models = {};
		for (const model of group.models) models[model.id] = v1Model(group, model);
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
					provider: { npm: "@deepseek-ai/dsh" },
					...variantsFor(model) === void 0 ? {} : { variants: variantsFor(model) }
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
				variants: v2VariantsFor(model),
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
//#region src/bridge/routes/boot.ts
function registerBootRoutes(register) {
	register("GET", "/path", "json", async (_req, ctx) => {
		const directory = ctx.cwd;
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
	register("GET", "/config", "json", async () => json(200, { autoupdate: false }));
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
	register("GET", "/agent", "json", async (_req, ctx) => json(200, [await v1DefaultAgent(ctx), ...await dshPresetAgents(ctx)]));
	register("GET", "/command", "json", async (req, ctx) => json(200, [
		PRESET_COMMAND_V1,
		GOAL_COMMAND_V1,
		HELP_COMMAND_V1,
		...await skillCommandsV1(ctx, req.query.get("directory") ?? void 0)
	]));
	register("GET", "/skill", "json", async (req, ctx) => json(200, await skillList(ctx, req.query.get("directory") ?? void 0)));
	for (const bare of ["/reference", "/integration"]) register("GET", bare, "json", async () => json(200, []));
	register("GET", "/api/location", "json", async (_req, ctx) => json(200, locationInfo(ctx)));
	register("GET", "/api/agent", "json", async (_req, ctx) => json(200, {
		location: locationInfo(ctx),
		data: [await v2DefaultAgent(ctx), ...await dshPresetAgentsV2(ctx)]
	}));
	register("GET", "/api/command", "json", async (_req, ctx) => json(200, {
		location: locationInfo(ctx),
		data: [
			PRESET_COMMAND_V2,
			GOAL_COMMAND_V2,
			HELP_COMMAND_V2,
			...await skillCommandsV2(ctx, _req.query.get("directory") ?? void 0)
		]
	}));
	register("GET", "/api/skill", "json", async (req, ctx) => json(200, {
		location: locationInfo(ctx),
		data: await skillList(ctx, req.query.get("directory") ?? void 0)
	}));
	for (const bare of ["/api/reference", "/api/integration"]) register("GET", bare, "json", async (_req, ctx) => json(200, v2LocationBody(ctx)));
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
	register("GET", "/api/permission/saved", "json", async (_req, ctx) => json(200, { data: ctx.state.savedPermissionsList().map((saved) => ({
		id: saved.toolName,
		sessionID: saved.sessionId,
		grantedAt: saved.grantedAt
	})) }));
}
//#endregion
//#region src/bridge/routes/permission.ts
function registerPermissionRoutes(register) {
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
}
//#endregion
//#region src/bridge/routes/session-v1.ts
function registerSessionV1Routes(register) {
	register("GET", "/session", "json", async (_req, ctx) => {
		const items = filterSessionsByDirectory(await cachedSessionList(ctx), _req.query.get("directory") ?? void 0, ctx.cwd);
		recordSessionSummaries(ctx, items);
		await warmListTitles(ctx, items);
		return json(200, items.map((item) => convertSessionSummary(item, {
			cwd: ctx.state.sessionDirectories.get(String(item.sessionId)) ?? ctx.cwd,
			title: ctx.state.sessionTitleFor(String(item.sessionId))
		})));
	});
	register("GET", "/session/status", "json", async (_req, ctx) => {
		const list = await cachedSessionList(ctx);
		const status = {};
		for (const item of filterSessionsByDirectory(list, _req.query.get("directory") ?? void 0, ctx.cwd)) status[String(item.sessionId)] = item.running ? { type: "busy" } : { type: "idle" };
		return json(200, status);
	});
	register("POST", "/session", "json", (req, ctx) => createSession(req, ctx, false));
	register("POST", "/session/:id/fork", "json", (req, ctx) => forkSession(req, ctx, false));
	register("POST", "/session/:id/summarize", "json", async (req, ctx) => {
		const id = req.params.id;
		await runCompactCommand(ctx, id);
		return json(200, true);
	});
	register("POST", "/session/:id/compact", "json", async (req, ctx) => {
		const id = req.params.id;
		await runCompactCommand(ctx, id);
		return json(200, true);
	});
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
		ctx.state.setSessionTitle(id, body.title);
		ctx.state.invalidateSession();
		return json(200, toV1Session(await sessionView(ctx, id), id, ctx));
	});
	register("GET", "/session/:id/message", "json", async (req, ctx) => {
		const id = req.params.id;
		const limitRaw = req.query.get("limit");
		const history = await cachedSessionHistory(ctx, id, { maxMessages: limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 100, 500)) : 100 });
		const defaultModel = await defaultModelRef(ctx);
		const entries = history.events;
		return json(200, convertMessagesV1(entries.map((entry) => entry.event), {
			sessionId: id,
			cwd: ctx.cwd,
			defaultModel,
			onSkip: (type, reason) => ctx.log(`[bridge/messages] ${type}: ${reason}`)
		}, entries.map((entry) => entry.view)));
	});
	register("POST", "/session/:id/message", "json", async (req, ctx) => {
		const id = req.params.id;
		const content = parsePromptParts(bodyAsRecord(req.body).parts, ctx.cwd);
		const slash = slashPromptCapture(content);
		if (slash !== void 0) {
			const outcome = await runSlashCommand(ctx, id, slash);
			if (outcome.kind === "error") throw badRequest(outcome.text, { code: "command-error" });
			return json(200, pendingAssistantPlaceholder(id, ctx.cwd, outcome.text));
		}
		await applyAgentFromBody(ctx, id, req.body);
		await applyModelSelection(ctx, id, req.body);
		await rpc(ctx, "session.prompt", {
			sessionId: sid(id),
			mode: "queue",
			content
		});
		ctx.state.markInput();
		ctx.state.invalidateSession(id);
		return json(200, pendingAssistantPlaceholder(id, ctx.cwd));
	});
	register("POST", "/session/:id/prompt", "json", async (req, ctx) => {
		const id = req.params.id;
		const content = parsePromptParts(bodyAsRecord(req.body).parts, ctx.cwd);
		const slash = slashPromptCapture(content);
		if (slash !== void 0) {
			const outcome = await runSlashCommand(ctx, id, slash);
			if (outcome.kind === "error") throw badRequest(outcome.text, { code: "command-error" });
			return json(200, pendingAssistantPlaceholder(id, ctx.cwd, outcome.text));
		}
		await applyAgentFromBody(ctx, id, req.body);
		await applyModelSelection(ctx, id, req.body);
		await rpc(ctx, "session.prompt", {
			sessionId: sid(id),
			mode: "queue",
			content
		});
		ctx.state.markInput();
		ctx.state.invalidateSession(id);
		return json(200, pendingAssistantPlaceholder(id, ctx.cwd));
	});
	register("POST", "/session/:id/prompt_async", "json", async (req, ctx) => {
		const id = req.params.id;
		const body = bodyAsRecord(req.body);
		const content = parsePromptParts(body.parts, ctx.cwd);
		const slash = slashPromptCapture(content);
		if (slash !== void 0) {
			const outcome = await runSlashCommand(ctx, id, slash);
			if (outcome.kind === "error") throw badRequest(outcome.text, { code: "command-error" });
			return json(204);
		}
		await applyAgentFromBody(ctx, id, body);
		await applyModelSelection(ctx, id, body);
		await rpc(ctx, "session.prompt", {
			sessionId: sid(id),
			mode: "queue",
			content
		});
		ctx.state.markInput();
		ctx.state.invalidateSession(id);
		return json(204);
	});
	register("POST", "/session/:id/abort", "json", async (req, ctx) => {
		const id = req.params.id;
		await rpc(ctx, "session.cancel", { sessionId: sid(id) });
		return json(200, true);
	});
	register("POST", "/session/:id/command", "json", async (req, ctx) => {
		const id = req.params.id;
		const body = bodyAsRecord(req.body);
		const command = typeof body.command === "string" ? body.command : "";
		const argumentsRaw = typeof body.arguments === "string" ? body.arguments : "";
		const name = command.replace(/^\//, "");
		if (name === "preset") {
			const outcome = await runPresetCommand(ctx, id, argumentsRaw.trim());
			if (outcome.kind === "error") throw badRequest(outcome.text, { code: "command-error" });
			return json(200, pendingAssistantPlaceholder(id, ctx.cwd, outcome.text));
		}
		if (name === "goal") {
			const outcome = await runGoalCommand(ctx, id, argumentsRaw);
			if (outcome.kind === "error") throw badRequest(outcome.text, { code: "command-error" });
			return json(200, pendingAssistantPlaceholder(id, ctx.cwd, outcome.text));
		}
		if (name === "help") {
			const outcome = runHelpCommand(ctx, id, argumentsRaw);
			return json(200, pendingAssistantPlaceholder(id, ctx.cwd, outcome.text));
		}
		if ((await skillListForSession(ctx, id)).some((skill) => skill.name === name)) {
			const promptText = argumentsRaw.trim() === "" ? `/${name}` : `/${name} ${argumentsRaw.trim()}`;
			await rpc(ctx, "session.prompt", {
				sessionId: sid(id),
				mode: "queue",
				content: [{
					type: "text",
					text: promptText
				}]
			});
			ctx.state.invalidateSession(id);
			return json(200, pendingAssistantPlaceholder(id, ctx.cwd));
		}
		throw badRequest(`unsupported command "${command}"`);
	});
	register("GET", "/session/:id/todo", "json", async (req, ctx) => {
		const id = req.params.id;
		const history = await cachedSessionHistory(ctx, id);
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
		return json(200, convertGoalTodos(goalFromHistory(history), todos ?? []));
	});
	register("GET", "/session/:id/diff", "json", async (req, ctx) => {
		const id = req.params.id;
		const history = await cachedSessionHistory(ctx, id);
		return json(200, producedFilesV1(filterGitTrackedDiffs(ctx.cwd, historyFileDiffs(history))));
	});
}
//#endregion
//#region src/bridge/routes/session-v2.ts
function registerSessionV2Routes(register) {
	register("GET", "/api/session", "json", async (req, ctx) => {
		const search = req.query.get("search");
		let all;
		if (search !== null && search.length > 0) {
			const results = await rpc(ctx, "session.search", { query: search });
			const ids = new Set(results.items.map((item) => String(item.sessionId)));
			all = (await cachedSessionList(ctx)).filter((item) => ids.has(String(item.sessionId)));
		} else all = await cachedSessionList(ctx);
		const filtered = filterSessionsByDirectory(all, req.query.get("directory") ?? void 0, ctx.cwd);
		const limitRaw = req.query.get("limit");
		const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 100, 500)) : 100;
		const cursorRaw = req.query.get("cursor");
		const offset = cursorRaw === null ? 0 : decodeSessionCursor(cursorRaw);
		const page = (req.query.get("order") === "asc" ? [...filtered].reverse() : filtered).slice(offset, offset + limit);
		const nextOffset = offset + page.length;
		recordSessionSummaries(ctx, page);
		await warmListTitles(ctx, page);
		return json(200, {
			data: page.map((item) => convertSessionSummaryV2(item, {
				cwd: ctx.state.sessionDirectories.get(String(item.sessionId)) ?? ctx.cwd,
				title: ctx.state.sessionTitleFor(String(item.sessionId))
			})),
			cursor: {
				...nextOffset < filtered.length ? { next: encodeSessionCursor(nextOffset) } : {},
				...offset > 0 ? { previous: encodeSessionCursor(Math.max(0, offset - limit)) } : {}
			}
		});
	});
	register("POST", "/api/session", "json", (req, ctx) => createSession(req, ctx, true));
	register("POST", "/api/session/:sessionID/fork", "json", (req, ctx) => forkSession(req, ctx, true));
	register("POST", "/api/session/:sessionID/compact", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		await runCompactCommand(ctx, id);
		return json(204);
	});
	register("POST", "/api/session/:sessionID/prompt", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const content = parsePromptParts(bodyAsRecord(req.body).parts, ctx.cwd);
		const slash = slashPromptCapture(content);
		if (slash !== void 0) {
			const outcome = await runSlashCommand(ctx, id, slash);
			if (outcome.kind === "error") throw badRequest(outcome.text, { code: "command-error" });
			return json(200, { data: {
				id: `msg_${randomUUID()}`,
				sessionID: id,
				prompt: { parts: content },
				delivery: "queue",
				timeCreated: Date.now(),
				admittedSeq: 0
			} });
		}
		await applyAgentFromBody(ctx, id, req.body);
		await applyModelSelection(ctx, id, req.body);
		await rpc(ctx, "session.prompt", {
			sessionId: sid(id),
			mode: "queue",
			content
		});
		ctx.state.markInput();
		ctx.state.invalidateSession(id);
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
	register("POST", "/api/session/:sessionID/model", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		await applyModelSelection(ctx, id, req.body);
		return json(204);
	});
	register("POST", "/api/session/:sessionID/agent", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const agent = typeof bodyAsRecord(req.body).agent === "string" ? bodyAsRecord(req.body).agent : "";
		if (agent === "") throw badRequest("agent switch requires a string agent");
		await switchAgentPreset(ctx, id, agent);
		broadcastSessionAgent(ctx, id, agent);
		ctx.state.invalidateSession(id);
		return json(204);
	});
	register("GET", "/api/session/:sessionID/message", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const limitRaw = req.query.get("limit");
		const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 100, 500)) : void 0;
		const cursorRaw = req.query.get("cursor");
		const history = await cachedSessionHistory(ctx, id, {
			maxMessages: limit,
			beforeSeq: cursorRaw === null ? void 0 : decodeMessageCursor(cursorRaw)
		});
		const defaultModel = await defaultModelRef(ctx);
		const entries = history.events;
		const oldest = oldestSurfaceSeq(entries);
		const data = convertMessagesV2(entries.map((entry) => entry.event), {
			sessionId: id,
			cwd: ctx.cwd,
			defaultModel,
			onSkip: (type, reason) => ctx.log(`[bridge/messages-v2] ${type}: ${reason}`)
		}, entries.map((entry) => entry.view));
		return json(200, {
			data: req.query.get("order") === "desc" ? data.reverse() : data,
			cursor: { ...history.hasMore && oldest !== void 0 ? { previous: encodeMessageCursor(oldest) } : {} }
		});
	});
	register("GET", "/api/session/:sessionID/diff", "json", async (req, ctx) => {
		const id = req.params.sessionID;
		const history = await cachedSessionHistory(ctx, id);
		return json(200, filterGitTrackedDiffs(ctx.cwd, historyFileDiffs(history)));
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
}
//#endregion
//#region src/bridge/routes.ts
function registerRoutes(register) {
	registerBootRoutes(register);
	registerSessionV1Routes(register);
	registerPermissionRoutes(register);
	registerSessionV2Routes(register);
	register("GET", "/global/event", "sse", async () => ({ status: 200 }));
}
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
	send(client, event) {
		if (client.closed || client.res.destroyed) return;
		const data = JSON.stringify(event);
		try {
			client.res.write(`id: ${event.payload.id}\ndata: ${data}\n\n`);
		} catch (error) {
			this.log(`[bridge/sse] write to client ${client.id} failed: ${error instanceof Error ? error.message : String(error)}`);
			this.remove(client);
		}
	}
	/** Fan one event batch out to every connected SSE client. */
	broadcast(events) {
		for (const client of [...this.clients]) for (const event of events) this.send(client, event);
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
function sessionDirectoryFrom(items, summary, fallback) {
	if (summary?.cwd) return summary.cwd;
	if (summary?.parentSessionId !== void 0) {
		const parent = items.find((item) => String(item.sessionId) === String(summary.parentSessionId));
		if (parent?.cwd) return parent.cwd;
	}
	return fallback;
}
/**
* Record child cwd and parent lineage from a session list. A subagent child
* without its own cwd inherits the nearest parent's cwd so the TUI opens and
* filters its events in the same project directory.
*/
function recordSessionSummaries(ctx, items) {
	const directories = /* @__PURE__ */ new Map();
	for (const item of items) if (item.cwd) directories.set(String(item.sessionId), item.cwd);
	for (const item of items) {
		const id = String(item.sessionId);
		if (!directories.has(id)) {
			const parentId = item.parentSessionId === void 0 ? void 0 : String(item.parentSessionId);
			directories.set(id, (parentId === void 0 ? void 0 : directories.get(parentId)) ?? ctx.cwd);
		}
	}
	for (const item of items) {
		const id = String(item.sessionId);
		ctx.state.sessionDirectories.set(id, directories.get(id) ?? ctx.cwd);
		if (item.origin === "subagent" && item.parentSessionId !== void 0) ctx.state.sessionParents.set(id, String(item.parentSessionId));
	}
}
/** Filter dsh session summaries by a TUI-provided `directory` query. */
function filterSessionsByDirectory(items, directory, base) {
	if (directory === void 0 || directory.length === 0) return [...items];
	const normalized = resolve(base, directory);
	return items.filter((item) => {
		if (typeof item.cwd !== "string") return true;
		return resolve(base, item.cwd) === normalized;
	});
}
async function sessionView(ctx, id) {
	ctx.state.setCurrentSession(id);
	const list = await cachedSessionList(ctx);
	const summary = list.find((item) => String(item.sessionId) === id);
	recordSessionSummaries(ctx, list);
	const cwd = sessionDirectoryFrom(list, summary, ctx.cwd);
	const history = await cachedSessionHistory(ctx, id);
	let model;
	try {
		const selection = await rpc(ctx, "session.models", { sessionId: sid(id) });
		model = {
			id: selection.current.model,
			providerID: externalProviderId(selection.current.provider),
			...selection.current.reasoningEffort === void 0 ? {} : { variant: selection.current.reasoningEffort }
		};
	} catch (error) {
		ctx.log(`[bridge/session] model selection unavailable for ${id}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return {
		summary,
		events: history.events,
		createdAt: history.events[0]?.event.time,
		...model === void 0 ? {} : { model },
		cwd
	};
}
/** Encode an opaque v2 message cursor pointing before a surface event seq. */
function encodeMessageCursor(beforeSeq) {
	return Buffer.from(JSON.stringify({
		v: 1,
		beforeSeq
	}), "utf8").toString("base64url");
}
/** Decode an opaque v2 message cursor produced by {@link encodeMessageCursor}. */
function decodeMessageCursor(raw) {
	try {
		const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
		if (parsed.v === 1 && typeof parsed.beforeSeq === "number" && Number.isFinite(parsed.beforeSeq)) return parsed.beforeSeq;
	} catch {}
	throw badRequest("invalid message cursor");
}
/** Encode an opaque v2 session-list cursor for the next page offset. */
function encodeSessionCursor(offset) {
	return Buffer.from(JSON.stringify({
		v: 1,
		offset
	}), "utf8").toString("base64url");
}
/** Decode an opaque v2 session-list cursor produced by {@link encodeSessionCursor}. */
function decodeSessionCursor(raw) {
	try {
		const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
		if (parsed.v === 1 && typeof parsed.offset === "number" && Number.isFinite(parsed.offset) && parsed.offset >= 0) return parsed.offset;
	} catch {}
	throw badRequest("invalid session cursor");
}
/** Oldest surface-message seq in a history page (pagination anchor). */
function oldestSurfaceSeq(events) {
	let oldest;
	for (const entry of events) {
		const type = entry.event.type;
		if (type === "user/message" || type === "assistant/message" || type === "tool/result") {
			if (oldest === void 0 || entry.event.seq < oldest) oldest = entry.event.seq;
		}
	}
	return oldest;
}
const SESSION_LIST_CACHE_MS = 1e3;
function historyCacheKey(sessionId, maxMessages, beforeSeq) {
	return `${sessionId}:${maxMessages ?? "tail"}:${beforeSeq ?? "tail"}`;
}
/** Read session.list through a short-lived cache (invalidated by mutations/SSE). */
async function cachedSessionList(ctx) {
	const cached = ctx.state.getSessionListCache(SESSION_LIST_CACHE_MS);
	if (cached !== void 0) return cached;
	const existing = ctx.state.sessionListLoading;
	if (existing !== void 0) return existing;
	const generation = ctx.state.listGeneration();
	const promise = rpc(ctx, "session.list", {}).then((list) => list.items);
	ctx.state.sessionListLoading = promise;
	try {
		const items = await promise;
		if (ctx.state.listGeneration() === generation) ctx.state.setSessionListCache(items);
		return items;
	} finally {
		if (ctx.state.sessionListLoading === promise) ctx.state.sessionListLoading = void 0;
	}
}
/** Read a history page through a short-lived per-page cache. */
async function cachedSessionHistory(ctx, sessionId, options = {}) {
	const key = historyCacheKey(sessionId, options.maxMessages, options.beforeSeq);
	const cached = ctx.state.getHistoryCache(key, 500);
	if (cached !== void 0) return cached;
	const existing = ctx.state.getHistoryLoading(key);
	if (existing !== void 0) return existing;
	const generation = ctx.state.historyGeneration(key);
	const promise = rpc(ctx, "session.history", {
		sessionId: sid(sessionId),
		...options.maxMessages === void 0 ? {} : { maxMessages: options.maxMessages },
		...options.beforeSeq === void 0 ? {} : { beforeSeq: options.beforeSeq }
	}).then((history) => ({
		events: history.events,
		hasMore: history.hasMore,
		...history.projections === void 0 ? {} : { projections: history.projections }
	}));
	ctx.state.setHistoryLoading(key, promise);
	try {
		const value = await promise;
		if (ctx.state.historyGeneration(key) === generation) {
			ctx.state.setHistoryCache(key, value);
			const title = value.projections === void 0 ? void 0 : value.projections.values.title;
			ctx.state.setSessionTitle(sessionId, title);
			seedDerivedHistoryPage(ctx, sessionId, value, options);
		}
		return value;
	} finally {
		ctx.state.clearHistoryLoading(key, promise);
	}
}
/**
* dsh's `session.list` rows carry no projections, so real titles only come
* from each session's history tail. Warm the first few visible sessions
* (bounded, parallel) so the list shows durable titles instead of directory
* basenames; blank sessions have no title and are skipped.
*/
async function warmListTitles(ctx, items) {
	const missing = items.filter((item) => !item.blank && ctx.state.sessionTitleFor(String(item.sessionId)) === void 0);
	if (missing.length === 0) return;
	if (missing.length <= 40) {
		await warmTitles(ctx, missing);
		return;
	}
	warmTitles(ctx, missing.slice(0, 24));
}
/** Read the title-bearing history tail for candidates with bounded concurrency. */
async function warmTitles(ctx, candidates) {
	if (candidates.length === 0) return;
	let next = 0;
	const workers = Array.from({ length: Math.min(2, candidates.length) }, async () => {
		for (;;) {
			const index = next++;
			if (index >= candidates.length) return;
			const id = String(candidates[index].sessionId);
			try {
				await cachedSessionHistory(ctx, id, { maxMessages: 1 });
			} catch (error) {
				ctx.log(`[bridge/session-title] warm failed for ${id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	});
	await Promise.allSettled(workers);
}
/**
* The TUI opens a session through `/session/:id` (full tail) and then fetches
* `/session/:id/message` (default limit 100). Those are different cache keys,
* so without seeding the second read would repeat the same dsh history RPC.
* Seed the derived page when the loaded window provably covers it (and vice
* versa when a 100-message page is the whole history).
*/
function seedDerivedHistoryPage(ctx, sessionId, value, options) {
	if (options.beforeSeq !== void 0) return;
	if (options.maxMessages === void 0) {
		const pageKey = historyCacheKey(sessionId, 100, void 0);
		if (ctx.state.getHistoryCache(pageKey, 500) === void 0) ctx.state.setHistoryCache(pageKey, {
			events: value.events.slice(-100),
			hasMore: value.events.length > 100 || value.hasMore,
			...value.projections === void 0 ? {} : { projections: value.projections }
		});
	} else if (options.maxMessages === 100 && !value.hasMore) {
		const tailKey = historyCacheKey(sessionId, void 0, void 0);
		if (ctx.state.getHistoryCache(tailKey, 500) === void 0) ctx.state.setHistoryCache(tailKey, value);
	}
}
/** Pick a session for a directory query (or the most recent one). */
async function sessionForDirectory(ctx, directory) {
	const items = await cachedSessionList(ctx);
	if (directory !== void 0 && directory.length > 0) {
		const normalized = resolve(ctx.cwd, directory);
		return items.find((item) => typeof item.cwd === "string" && resolve(ctx.cwd, item.cwd) === normalized);
	}
	return items[0];
}
/** Resolve the dsh skill catalog for the session matching a directory query. */
async function skillList(ctx, directory) {
	const session = await sessionForDirectory(ctx, directory);
	const skills = [];
	if (session !== void 0) try {
		const result = await rpc(ctx, "skill.list", { sessionId: sid(String(session.sessionId)) });
		skills.push(...result.skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			...skill.whenToUse === void 0 ? {} : { whenToUse: skill.whenToUse }
		})));
	} catch (error) {
		ctx.log(`[bridge] skill.list failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	skills.push(...fakeSkillEntries());
	return skills;
}
/** dsh skills exposed as opencode v1 slash commands. */
async function skillCommandsV1(ctx, directory) {
	return (await skillList(ctx, directory)).map((skill) => ({
		name: skill.name,
		description: skill.description,
		template: skill.name
	}));
}
/** dsh skills exposed as opencode v2 slash commands. */
async function skillCommandsV2(ctx, directory) {
	return (await skillList(ctx, directory)).map((skill) => ({
		name: skill.name,
		template: skill.name,
		description: skill.description
	}));
}
/** Skill catalog for one specific session (used by the command route). */
async function skillListForSession(ctx, sessionId) {
	const skills = [];
	try {
		const result = await rpc(ctx, "skill.list", { sessionId: sid(sessionId) });
		skills.push(...result.skills.map((skill) => ({
			name: skill.name,
			description: skill.description
		})));
	} catch (error) {
		ctx.log(`[bridge] skill.list failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
	}
	skills.push(...fakeSkillEntries());
	return skills;
}
/** Test-only fake skills injected via `DSH_OC_E2E_FAKE_SKILLS=name1,name2`. */
function fakeSkillEntries() {
	const raw = process.env.DSH_OC_E2E_FAKE_SKILLS;
	if (raw === void 0 || raw.trim() === "") return [];
	return raw.split(",").map((item) => item.trim()).filter(Boolean).map((name) => ({
		name,
		description: `e2e fake skill ${name}`,
		whenToUse: `Use ${name} in e2e`
	}));
}
function toV1Session(view, id, ctx) {
	if (view.summary) return convertSessionSummary(view.summary, {
		cwd: view.cwd ?? ctx.cwd,
		createdAt: view.createdAt,
		...view.model === void 0 ? {} : { model: view.model }
	});
	return minimalSession(id, {
		cwd: view.cwd ?? ctx.cwd,
		createdAt: view.createdAt,
		...ctx.state.sessionParents.get(id) === void 0 ? {} : { parentID: ctx.state.sessionParents.get(id) }
	});
}
function toV2Session(view, id, ctx) {
	if (view.summary) return convertSessionSummaryV2(view.summary, {
		cwd: view.cwd ?? ctx.cwd,
		createdAt: view.createdAt,
		...view.model === void 0 ? {} : { model: view.model }
	});
	return minimalSessionV2(id, {
		cwd: view.cwd ?? ctx.cwd,
		createdAt: view.createdAt,
		...ctx.state.sessionParents.get(id) === void 0 ? {} : { parentID: ctx.state.sessionParents.get(id) }
	});
}
async function modelGroups(ctx) {
	return (await rpc(ctx, "llm.models", {})).groups;
}
const TEXT_MIME_PREFIXES = /* @__PURE__ */ new Set([
	"application/json",
	"application/xml",
	"application/javascript",
	"application/typescript",
	"application/x-yaml",
	"application/yaml",
	"application/toml",
	"application/x-toml",
	"application/x-sh",
	"application/x-python"
]);
const TEXT_EXTENSIONS = /* @__PURE__ */ new Set([
	".txt",
	".md",
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".json",
	".jsonc",
	".yaml",
	".yml",
	".toml",
	".sh",
	".py",
	".rs",
	".go",
	".c",
	".h",
	".cpp",
	".hpp",
	".java",
	".sql",
	".css",
	".html",
	".xml",
	".csv",
	".log"
]);
function isTextMime(mime) {
	const normalized = mime.toLowerCase().split(";")[0]?.trim() ?? "";
	return normalized.startsWith("text/") || TEXT_MIME_PREFIXES.has(normalized);
}
function isTextFile(path, mime) {
	return isTextMime(mime) || TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}
function filePartToContent(part, cwd) {
	const url = typeof part.url === "string" ? part.url : "";
	const mime = typeof part.mime === "string" ? part.mime : "";
	if (url.length === 0 || mime.length === 0) throw badRequest("file part requires url and mime");
	const dataMatch = /^data:([^;,]+);base64,(.+)$/.exec(url);
	if (dataMatch) {
		const [, mediaType, data] = dataMatch;
		if (!mediaType || !data) throw badRequest("invalid file data URL");
		if (mediaType.startsWith("image/")) return {
			type: "image",
			mediaType,
			data
		};
		if (isTextMime(mediaType)) return {
			type: "text",
			text: Buffer.from(data, "base64").toString("utf8")
		};
		throw badRequest(`unsupported file mime "${mediaType}" (dsh supports text and image parts)`);
	}
	let filePath;
	if (url.startsWith("file://")) try {
		filePath = fileURLToPath(url);
	} catch {
		throw badRequest(`invalid file part url: ${url}`);
	}
	else filePath = url;
	const resolved = resolve(cwd, filePath);
	const rel = relative(cwd, resolved);
	if (rel.startsWith("..") || isAbsolute(rel)) throw badRequest("file part path must be inside the session cwd");
	let stat;
	try {
		stat = statSync(resolved);
	} catch {
		throw badRequest(`file part path not readable: ${filePath}`);
	}
	if (!stat.isFile()) throw badRequest("file part path must be a file");
	const mediaType = mime.split(";")[0]?.trim() ?? "";
	if (mediaType.startsWith("image/")) return {
		type: "image",
		mediaType,
		data: readFileSync(resolved).toString("base64")
	};
	if (isTextFile(resolved, mediaType)) return {
		type: "text",
		text: readFileSync(resolved, "utf8")
	};
	throw badRequest(`unsupported file mime "${mediaType}" (dsh supports text and image parts)`);
}
function parsePromptParts(raw, cwd) {
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
			parts.push(filePartToContent(part, cwd));
			continue;
		}
		throw badRequest(`unsupported prompt part type "${String(part.type)}"`);
	}
	return parts;
}
function pendingAssistantPlaceholder(sessionID, cwd, text) {
	const info = {
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
	};
	return {
		info,
		parts: text === void 0 ? [] : [{
			id: `pending:${randomUUID()}`,
			sessionID,
			messageID: info.id,
			type: "text",
			text,
			time: { start: Date.now() }
		}]
	};
}
/** The dsh-oc bridge exposes one primary agent so the TUI prompt stays usable. */
const DEFAULT_AGENT_NAME = "build";
const PRESET_COMMAND_V1 = {
	name: "preset",
	description: "List or switch the session dsh agent preset",
	template: "preset"
};
const PRESET_COMMAND_V2 = {
	name: "preset",
	template: "preset",
	description: "List or switch the session dsh agent preset"
};
const GOAL_COMMAND_V1 = {
	name: "goal",
	description: "Set or view the goal for a long-running task",
	template: "goal"
};
const GOAL_COMMAND_V2 = {
	name: "goal",
	template: "goal",
	description: "Set or view the goal for a long-running task"
};
const HELP_COMMAND_V1 = {
	name: "help",
	description: "Show the dsh-oc capability summary and documentation entry points",
	template: "help"
};
const HELP_COMMAND_V2 = {
	name: "help",
	template: "help",
	description: "Show the dsh-oc capability summary and documentation entry points"
};
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
async function presetRoster(ctx) {
	return (await rpc(ctx, "agentPreset.list", {})).presets.filter((preset) => preset.broken === void 0);
}
async function defaultPresetId(ctx) {
	try {
		return (await presetRoster(ctx)).find((preset) => preset.isDefault)?.id;
	} catch (error) {
		ctx.log(`[bridge] agent preset roster unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
}
async function presetIdForAgent(ctx, agentName) {
	if (agentName === "build") return defaultPresetId(ctx);
	try {
		return (await presetRoster(ctx)).find((preset) => preset.id === agentName)?.id;
	} catch (error) {
		ctx.log(`[bridge] agent preset roster unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
}
async function switchAgentPreset(ctx, sessionId, agentName) {
	const presetId = await presetIdForAgent(ctx, agentName);
	if (presetId === void 0) {
		if (agentName === "build") return;
		throw badRequest(`agent "${agentName}" is not a switchable dsh preset`);
	}
	await rpc(ctx, "agentPreset.select", {
		sessionId: sid(sessionId),
		agentPreset: presetId
	});
	ctx.state.lastAgentPreset = agentName;
}
/** All text parts of a prompt body, joined the way the TUI renders them. */
function textFromPromptParts(content) {
	return content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}
/**
* A slash command typed with a trailing space (or after dismissing the slash
* popup) reaches the prompt routes as a plain prompt. Commands handled by the
* bridge are captured here so they never trigger a model turn.
*/
function slashPromptCapture(content) {
	const text = textFromPromptParts(content).trim();
	if (/^\/preset(?:\s|$)/.test(text)) return {
		name: "preset",
		argument: text.slice(7).trim()
	};
	if (/^\/goal(?:\s|$)/.test(text)) return {
		name: "goal",
		argument: text.slice(5).trim()
	};
	if (/^\/help(?:\s|$)/.test(text)) return {
		name: "help",
		argument: text.slice(5).trim()
	};
}
async function presetCommandOutcome(ctx, sessionId, argument) {
	try {
		if (argument === "") {
			const roster = await presetRoster(ctx);
			return {
				kind: "success",
				text: roster.length === 0 ? "No switchable dsh agent presets" : roster.map((preset) => `${preset.id}${preset.isDefault ? " (default)" : ""}`).join("\n")
			};
		}
		await switchAgentPreset(ctx, sessionId, argument);
		return {
			kind: "success",
			text: `Switched dsh agent preset to ${argument}`
		};
	} catch (error) {
		return {
			kind: "error",
			text: error instanceof Error ? error.message : String(error)
		};
	}
}
/** Broadcast one synthetic command-result message (with optional status). */
function broadcastCommandResult(ctx, sessionId, text, status) {
	ctx.hub.broadcast(commandResultEvents({
		cwd: ctx.cwd,
		state: ctx.state,
		log: ctx.log
	}, sessionId, text, status === void 0 ? {} : { status }));
}
/** Push a `session.updated` carrying the new agent so the TUI label refreshes. */
function broadcastSessionAgent(ctx, sessionId, agent) {
	const directory = ctx.state.sessionDirectories.get(sessionId) ?? ctx.cwd;
	const project = projectIdFor(directory);
	ctx.hub.broadcast([makeEvent(directory, "session.updated", {
		sessionID: sessionId,
		info: minimalSession(sessionId, {
			cwd: directory,
			title: ctx.state.sessionTitleFor(sessionId),
			agent
		})
	}, project)]);
}
/** Run a `/preset` list/switch with visible TUI progress and result. */
async function runPresetCommand(ctx, sessionId, argument) {
	broadcastCommandResult(ctx, sessionId, "Running /preset…", "busy");
	const outcome = await presetCommandOutcome(ctx, sessionId, argument);
	if (outcome.kind === "success" && argument.trim() !== "") broadcastSessionAgent(ctx, sessionId, argument.trim());
	ctx.state.invalidateSession(sessionId);
	broadcastCommandResult(ctx, sessionId, outcome.text, "idle");
	return outcome;
}
/**
* Run one dsh registered command (`/goal`, ...) through the live session
* agent with visible busy/idle progress in the TUI. Infra failures (missing
* agent/registry/command) throw; a command-level error becomes an outcome
* the caller can turn into a 400.
*/
async function runRegistryCommand(ctx, sessionId, commandLine, label) {
	broadcastCommandResult(ctx, sessionId, `Running ${label}…`, "busy");
	const agent = ctx.api.agents?.get(sessionId);
	if (agent === void 0) {
		const text = `${label} unavailable: session is not attached`;
		broadcastCommandResult(ctx, sessionId, text, "idle");
		throw conflict(text, { sessionId });
	}
	if (!ctx.api.commands) {
		const text = `${label} unavailable: dsh command registry is missing`;
		broadcastCommandResult(ctx, sessionId, text, "idle");
		throw internalError(text, { sessionId });
	}
	let execution;
	try {
		execution = await ctx.api.commands.execute(agent, commandLine, new AbortController().signal);
	} catch (error) {
		const text = `${label} failed: ${error instanceof Error ? error.message : String(error)}`;
		broadcastCommandResult(ctx, sessionId, text, "idle");
		throw internalError(text, { sessionId });
	}
	ctx.state.invalidateSession(sessionId);
	if (execution === void 0) {
		const text = `${label} failed: unknown command ${commandLine.split(/\s+/)[0] ?? commandLine}`;
		broadcastCommandResult(ctx, sessionId, text, "idle");
		throw badRequest(text, {
			code: "unknown-command",
			sessionId
		});
	}
	if (execution.result.kind === "error") {
		const text = execution.result.text ?? `${label} failed`;
		broadcastCommandResult(ctx, sessionId, text, "idle");
		return {
			kind: "error",
			text
		};
	}
	const text = execution.result.text ?? `${label} completed`;
	broadcastCommandResult(ctx, sessionId, text, "idle");
	ctx.log(`[bridge] ${commandLine}: ${text}`);
	return {
		kind: "success",
		text
	};
}
/** Run `/goal` with an optional argument through the dsh command registry. */
async function runGoalCommand(ctx, sessionId, argument) {
	const trimmed = argument.trim();
	if (trimmed === "complete") return completeGoalCommand(ctx, sessionId);
	const outcome = await runRegistryCommand(ctx, sessionId, trimmed === "" ? "/goal" : `/goal ${trimmed}`, "/goal");
	if (outcome.kind === "success" && outcome.text.includes("Commands:")) return {
		kind: "success",
		text: `${outcome.text}, /goal complete`
	};
	return outcome;
}
/**
* dsh's `/goal` command registry has no `complete` verb (completion is
* normally automatic), so the bridge implements it directly through the
* `goal.complete` RPC with the current projection ref.
*/
async function completeGoalCommand(ctx, sessionId) {
	broadcastCommandResult(ctx, sessionId, "Running /goal complete…", "busy");
	try {
		const current = goalFromHistory(await cachedSessionHistory(ctx, sessionId));
		const ref = current?.goal;
		if (current === void 0 || ref === void 0) {
			const text = current === null ? "No goal to complete." : "Goal state unavailable; run /goal to view the current goal.";
			broadcastCommandResult(ctx, sessionId, text, "idle");
			return {
				kind: "error",
				text
			};
		}
		await rpc(ctx, "goal.complete", {
			sessionId: sid(sessionId),
			ref: {
				id: ref.id,
				revision: ref.revision
			}
		});
		ctx.state.invalidateSession(sessionId);
		const text = "Goal completed";
		broadcastCommandResult(ctx, sessionId, text, "idle");
		return {
			kind: "success",
			text
		};
	} catch (error) {
		const text = `/goal complete failed: ${error instanceof Error ? error.message : String(error)}`;
		broadcastCommandResult(ctx, sessionId, text, "idle");
		return {
			kind: "error",
			text
		};
	}
}
/** Run `/help`: broadcast the shared capability summary without a model turn. */
function runHelpCommand(ctx, sessionId, _argument) {
	const text = ocHelp();
	broadcastCommandResult(ctx, sessionId, text);
	return {
		kind: "success",
		text
	};
}
/** Dispatch a captured slash command to its bridge-side implementation. */
async function runSlashCommand(ctx, sessionId, slash) {
	if (slash.name === "preset") return runPresetCommand(ctx, sessionId, slash.argument);
	if (slash.name === "goal") return runGoalCommand(ctx, sessionId, slash.argument);
	if (slash.name === "help") return runHelpCommand(ctx, sessionId, slash.argument);
	throw badRequest(`unsupported command /${slash.name}`);
}
async function dshPresetAgents(ctx) {
	try {
		return (await presetRoster(ctx)).filter((preset) => preset.id !== DEFAULT_AGENT_NAME).map((preset) => ({
			name: preset.id,
			description: preset.name ?? preset.description,
			mode: "primary",
			permission: [],
			options: {}
		}));
	} catch (error) {
		ctx.log(`[bridge] agent preset roster unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}
async function dshPresetAgentsV2(ctx) {
	try {
		return (await presetRoster(ctx)).filter((preset) => preset.id !== DEFAULT_AGENT_NAME).map((preset) => ({
			id: preset.id,
			description: preset.name ?? preset.description,
			mode: "primary",
			hidden: false,
			request: {
				headers: {},
				body: {}
			},
			permissions: []
		}));
	} catch (error) {
		ctx.log(`[bridge] agent preset roster unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}
function modelInputFromBody(body) {
	const record = bodyAsRecord(body);
	const input = bodyAsRecord(record.model !== void 0 && bodyAsRecord(record.model) ? record.model : body);
	const providerID = typeof input.providerID === "string" ? input.providerID : void 0;
	const modelID = typeof input.modelID === "string" ? input.modelID : typeof input.id === "string" ? input.id : void 0;
	if (providerID === void 0 || modelID === void 0) return void 0;
	const variant = typeof input.variant === "string" ? input.variant : void 0;
	return {
		providerID,
		modelID,
		...variant === void 0 || variant === "default" ? {} : { variant }
	};
}
async function applyModelSelection(ctx, sessionId, body) {
	const input = modelInputFromBody(body);
	if (input === void 0) return;
	await rpc(ctx, "session.selectModel", {
		sessionId: sid(sessionId),
		provider: dshProviderId(input.providerID),
		model: input.modelID,
		...input.variant === void 0 ? {} : { reasoningEffort: input.variant }
	});
}
/** Apply the agent carried in a prompt body (Tab/agent picker selection). */
async function applyAgentFromBody(ctx, sessionId, body) {
	const record = bodyAsRecord(body);
	const agent = typeof record.agent === "string" && record.agent.length > 0 ? record.agent : void 0;
	if (agent === void 0 || agent === "build") return;
	try {
		await switchAgentPreset(ctx, sessionId, agent);
		broadcastSessionAgent(ctx, sessionId, agent);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.log(`[bridge] prompt agent switch failed for ${sessionId}: ${message}`);
		const errorBody = error.body;
		if ((typeof errorBody?.data?.code === "string" ? errorBody.data.code : "") === "agent-preset-locked" && !ctx.state.lockedAgentNoticeSeen(sessionId, agent)) {
			ctx.state.markLockedAgentNotice(sessionId, agent);
			broadcastCommandResult(ctx, sessionId, `Agent switch locked: 该会话已产生回复，agent preset 已固定；请新建会话后切换（Tab 或 /preset ${agent}）`, "idle");
		}
	}
}
/**
* dsh `session.fork` anchors on a completed-turn boundary by event seq.
* opencode's fork payload names a message id, so translate it to the seq of
* that message's user/assistant event (dsh documents message-fork buttons as
* passing the message seq; the boundary then closes at the following
* turn/end, which includes the whole turn).
*/
async function atSeqForMessage(ctx, sessionId, messageId) {
	const history = await cachedSessionHistory(ctx, sessionId);
	for (const entry of history.events) {
		const event = entry.event;
		if ((event.type === "user/message" ? String(event.data.id) : event.type === "assistant/message" ? String(event.data.message.id) : void 0) === messageId) return event.seq;
	}
	throw badRequest("message not found for fork", {
		sessionId,
		messageId
	});
}
async function forkSession(req, ctx, v2) {
	const id = req.params.id ?? req.params.sessionID ?? "";
	const body = bodyAsRecord(req.body);
	const messageId = typeof body.messageID === "string" ? body.messageID : void 0;
	const childId = await forkFromSource(ctx, id, messageId === void 0 ? void 0 : await atSeqForMessage(ctx, id, messageId));
	ctx.state.setCurrentSession(childId);
	const view = await sessionView(ctx, childId);
	return json(200, v2 ? { data: toV2Session(view, childId, ctx) } : toV1Session(view, childId, ctx));
}
/**
* dsh forks are independent conversations, not subagent children. Derive a
* user-visible `(fork #N)` title from the source session and the number of
* existing non-subagent forks before calling `session.rename`.
*/
function forkChainBase(title) {
	let base = title;
	for (;;) {
		const match = /^(.*?)\s+\(fork #\d+\)$/.exec(base);
		if (!match?.[1]) return base;
		base = match[1];
	}
}
function forkNumberInTitle(title) {
	let max = 0;
	for (const match of title.matchAll(/\(fork #(\d+)\)/g)) {
		const value = Number(match[1]);
		if (Number.isFinite(value) && value > max) max = value;
	}
	return max;
}
async function forkTitleForSource(ctx, sourceId) {
	const list = await cachedSessionList(ctx);
	const source = list.find((item) => String(item.sessionId) === sourceId);
	const sourceTitle = source === void 0 ? "Session" : sessionTitleFrom(source) || "Session";
	const base = forkChainBase(sourceTitle);
	const sourceForkNumber = forkNumberInTitle(sourceTitle);
	if (sourceForkNumber > 0) return `${base} (fork #${sourceForkNumber + 1})`;
	return `${base} (fork #${list.filter((item) => String(item.sessionId) !== sourceId && String(item.parentSessionId) === sourceId && item.origin !== "subagent").length + 1})`;
}
async function forkFromSource(ctx, sourceId, atSeq) {
	const title = await forkTitleForSource(ctx, sourceId);
	const result = await rpc(ctx, "session.fork", {
		sessionId: sid(sourceId),
		...atSeq === void 0 ? {} : { atSeq }
	});
	const childId = String(result.sessionId);
	try {
		await rpc(ctx, "session.rename", {
			sessionId: sid(childId),
			title
		});
	} catch (error) {
		ctx.log(`[bridge] rename of forked session ${childId} failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	ctx.state.invalidateSession();
	return childId;
}
/**
* Run dsh's registered `/compact` command directly through the command
* registry. The opencode TUI's slash command is `session.summarize`, which
* posts `/session/{id}/summarize`; dsh owns the model-backed compaction
* inside command-compact, so we address the live session agent here rather
* than sending a slash prompt to the model. Every outcome is broadcast as a
* synthetic assistant message plus busy/idle status so the TUI visibly moves
* while the command runs, even when the mock LLM cannot produce a summary.
*/
async function runCompactCommand(ctx, sessionId) {
	broadcastCommandResult(ctx, sessionId, "Running /compact…", "busy");
	const agent = ctx.api.agents?.get(sessionId);
	if (agent === void 0) {
		broadcastCommandResult(ctx, sessionId, "Compaction unavailable: session is not attached", "idle");
		throw conflict("session is not attached; cannot compact", { sessionId });
	}
	if (!ctx.api.commands) {
		broadcastCommandResult(ctx, sessionId, "Compaction unavailable: dsh command registry is missing", "idle");
		throw internalError("dsh command registry is unavailable; cannot compact", { sessionId });
	}
	let execution;
	try {
		execution = await ctx.api.commands.execute(agent, "/compact", new AbortController().signal);
	} catch (error) {
		const text = `Compaction failed: ${error instanceof Error ? error.message : String(error)}`;
		broadcastCommandResult(ctx, sessionId, text, "idle");
		throw internalError(text, { sessionId });
	}
	if (execution === void 0) {
		broadcastCommandResult(ctx, sessionId, "Compaction failed: unknown command /compact", "idle");
		throw badRequest("unknown command /compact", {
			code: "unknown-command",
			sessionId
		});
	}
	if (execution.result.kind === "error") {
		const text = execution.result.text ?? "Compaction failed";
		broadcastCommandResult(ctx, sessionId, text, "idle");
		throw badRequest(text, {
			code: "command-error",
			sessionId
		});
	}
	const text = execution.result.text ?? "Compaction completed";
	ctx.state.invalidateSession(sessionId);
	broadcastCommandResult(ctx, sessionId, text, "idle");
	ctx.log(`[bridge] /compact: ${text}`);
}
async function createSession(req, ctx, v2) {
	const body = bodyAsRecord(req.body);
	const parentID = typeof body.parentID === "string" ? body.parentID : void 0;
	const sessionIdInput = typeof body.id === "string" ? body.id : void 0;
	const title = typeof body.title === "string" ? body.title : void 0;
	const agentName = typeof body.agent === "string" ? body.agent : void 0;
	const inheritedAgent = agentName ?? ctx.state.lastAgentPreset;
	const agentPreset = inheritedAgent === void 0 ? void 0 : await presetIdForAgent(ctx, inheritedAgent);
	let id;
	if (parentID) id = await forkFromSource(ctx, parentID);
	else {
		const location = body.location;
		const queryDirectory = req.query.get("directory");
		const result = await rpc(ctx, "session.create", {
			cwd: typeof location?.directory === "string" ? location.directory : queryDirectory ?? ctx.cwd,
			...sessionIdInput === void 0 ? {} : { sessionId: sid(sessionIdInput) },
			...agentPreset === void 0 ? {} : { agentPreset }
		});
		id = String(result.sessionId);
		if (title) try {
			await rpc(ctx, "session.rename", {
				sessionId: sid(id),
				title
			});
		} catch (error) {
			ctx.log(`[bridge] rename of new session ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (body.model !== void 0) await applyModelSelection(ctx, id, body);
	if (agentName !== void 0) ctx.state.lastAgentPreset = agentName;
	ctx.state.setCurrentSession(id);
	ctx.state.invalidateSession();
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
		ctx.state.savePermission(entry.sessionId, entry.toolName);
		ctx.log(`[bridge] permission "always" saved for ${entry.sessionId} ${entry.toolName} (memory scope)`);
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
function producedFilesV1(diffs) {
	return diffs.map((diff) => ({
		file: diff.file ?? "",
		before: "",
		after: "",
		additions: diff.additions,
		deletions: diff.deletions
	}));
}
function historyChanges(history) {
	const calls = /* @__PURE__ */ new Map();
	const changes = [];
	for (const entry of history.events) {
		const event = entry.event;
		if (event.type === "tool/call") calls.set(String(event.data.callId), {
			callId: String(event.data.callId),
			name: event.data.name,
			arguments: event.data.arguments,
			...entry.view?.for === "call" ? { view: entry.view } : {}
		});
		else if (event.type === "tool/result") {
			const block = event.data.message.content[0];
			const callId = String(block?.toolCallId ?? event.data.message.source.callId);
			const call = calls.get(callId);
			if (!call) continue;
			changes.push(...fileChangesFromToolResult(call, {
				callId,
				content: event.data.message.content,
				error: event.data.error,
				time: event.time,
				meta: event.data.meta,
				...entry.view?.for === "result" ? { view: entry.view } : {}
			}));
		}
	}
	return changes;
}
function historyFileDiffs(history) {
	const values = history.projections?.values;
	if (values?.["produced-files"] !== void 0) return convertProducedFiles(values["produced-files"]);
	return toSnapshotFileDiffs(historyChanges(history));
}
/**
* Current goal for one session: prefer the durable `goal` projection, then
* fold the latest `goal/change` event when the projection is unavailable.
* `null` (clear tombstone) means no goal is rendered.
*/
function goalFromHistory(history) {
	if (history.projections?.values?.goal !== void 0) return history.projections.values.goal;
	for (let index = history.events.length - 1; index >= 0; index--) {
		const event = history.events[index].event;
		if (event.type !== "goal/change") continue;
		const data = event.data;
		if (data?.goal !== void 0) return { goal: data.goal };
		if (data?.cleared !== void 0) return null;
		return;
	}
}
function createBridgeRouter(api, options = {}) {
	let cwd = options.cwd ?? process.cwd();
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
	registerRoutes(register);
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
			let translator;
			let listRefreshTimer;
			try {
				const defaultModel = await defaultModelRef(ctx);
				const replayGuard = {
					approvals: /* @__PURE__ */ new Set(),
					questions: /* @__PURE__ */ new Set()
				};
				const sharedState = {
					todos: /* @__PURE__ */ new Map(),
					goals: /* @__PURE__ */ new Map()
				};
				const makeTranslator = () => new MuxEventTranslator({
					cwd,
					state,
					defaultModel,
					log,
					replayGuard,
					sharedState,
					onFlush: (events) => {
						for (const event of events) hub.send(client, event);
					}
				});
				translator = makeTranslator();
				const retryBaseMs = options.sseRetryBaseMs ?? 250;
				const retryMaxAttempts = options.sseRetryMaxAttempts ?? 3;
				const scheduleListRefresh = () => {
					if (listRefreshTimer !== void 0) return;
					listRefreshTimer = setTimeout(() => {
						listRefreshTimer = void 0;
						(async () => {
							try {
								const list = await rpc(ctx, "session.list", {});
								ctx.state.setSessionListCache(list.items);
								recordSessionSummaries(ctx, list.items);
							} catch (error) {
								log(`[bridge/sse] session list refresh failed: ${error instanceof Error ? error.message : String(error)}`);
							}
						})();
					}, 250);
				};
				const consumeHost = async (stream) => {
					for await (const frame of stream) {
						const payload = frame.payload;
						if (payload.type === "host/agent-error") {
							const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
							const message = typeof payload.message === "string" ? payload.message : "agent error";
							if (sessionId) for (const event of agentErrorEvents(sessionId, message, cwd)) hub.send(client, event);
						}
						if (payload.type === "host/session-added" || payload.type === "host/session-removed") {
							ctx.state.invalidateSession();
							scheduleListRefresh();
						}
					}
				};
				const startHostLoop = async () => {
					let attempt = 0;
					let delay = retryBaseMs;
					while (!controller.signal.aborted) {
						attempt += 1;
						const stream = api.events.host({
							rpcId: randomUUID(),
							payload: {}
						}, controller.signal);
						try {
							await consumeHost(stream);
							return;
						} catch (error) {
							if (controller.signal.aborted) return;
							if (attempt >= retryMaxAttempts) {
								log(`[bridge/sse] host stream ended: ${error instanceof Error ? error.message : String(error)}`);
								return;
							}
							log(`[bridge/sse] host stream error, retry ${attempt}/${retryMaxAttempts} in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`);
							await new Promise((resolve) => setTimeout(resolve, delay));
							delay = Math.min(delay * 2, 8e3);
						}
					}
				};
				startHostLoop().catch((error) => {
					log(`[bridge/sse] host loop failed: ${error instanceof Error ? error.message : String(error)}`);
				});
				const consumeStream = async (stream) => {
					for await (const frame of stream) {
						if (frame.payload.type === "approval/requested") {
							const sessionId = String(frame.payload.sessionId);
							const toolName = frame.payload.toolName;
							if (ctx.state.savedPermissionFor(sessionId, toolName) !== void 0) {
								try {
									await respondApproval(api, String(frame.rpcId), sessionId, String(frame.payload.approvalId), "allowed-once");
								} catch (error) {
									log(`[bridge/sse] auto-approval failed: ${error instanceof Error ? error.message : String(error)}`);
								}
								continue;
							}
						}
						if (frame.payload.type === "session/event") {
							const sessionEvent = frame.payload.event;
							ctx.state.invalidateHistory(String(frame.payload.sessionId));
							if (sessionEvent.type === "session" || sessionEvent.type === "session/created" || sessionEvent.type === "session/title") {
								ctx.state.invalidateSession();
								scheduleListRefresh();
							}
						}
						for (const event of translator.translate(frame)) hub.send(client, event);
					}
				};
				let attempt = 0;
				let delay = retryBaseMs;
				while (true) {
					attempt += 1;
					const stream = api.events.mux({
						rpcId: randomUUID(),
						payload: {}
					}, controller.signal);
					try {
						await consumeStream(stream);
						break;
					} catch (error) {
						if (controller.signal.aborted) break;
						if (attempt >= retryMaxAttempts) throw error;
						log(`[bridge/sse] mux stream error, retry ${attempt}/${retryMaxAttempts} in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`);
						await new Promise((resolve) => setTimeout(resolve, delay));
						delay = Math.min(delay * 2, 8e3);
						translator?.dispose();
						translator = makeTranslator();
					}
				}
			} catch (error) {
				if (controller.signal.aborted) return;
				log(`[bridge/sse] mux stream ended: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				translator?.dispose();
				if (listRefreshTimer !== void 0) {
					clearTimeout(listRefreshTimer);
					listRefreshTimer = void 0;
				}
				hub.remove(client);
			}
		})();
	}
	return {
		ctx,
		match,
		startSse,
		setCwd(directory) {
			cwd = directory;
			ctx.cwd = directory;
		},
		prefetchSessionList() {
			(async () => {
				try {
					const items = await cachedSessionList(ctx);
					await Promise.allSettled(items.slice(0, 5).map((item) => cachedSessionHistory(ctx, String(item.sessionId), { maxMessages: 100 })));
				} catch (error) {
					log(`[bridge] session list prefetch failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			})();
		},
		prefetchSession(sessionId) {
			ctx.state.setCurrentSession(sessionId);
			cachedSessionHistory(ctx, sessionId, { maxMessages: 100 }).catch((error) => {
				log(`[bridge] session history prefetch failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		},
		hasNewActivity() {
			return ctx.state.newInputDuringRun;
		},
		async exitNoteNeeded() {
			if (ctx.state.newInputDuringRun) return true;
			const sessionId = ctx.state.currentSessionId;
			if (sessionId === void 0) return false;
			try {
				const history = await cachedSessionHistory(ctx, sessionId, { maxMessages: 100 });
				const title = history.projections === void 0 ? void 0 : history.projections.values.title;
				return typeof title === "string" && title.length > 0;
			} catch {
				return false;
			}
		}
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
const name = "@chiro2001/dsh-oc/bridge";
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
	router;
	logger;
	constructor(ctx) {
		super(ctx, "ocBridge");
		this.logger = makeLogger(ctx);
	}
	async *[Service.init]() {
		const apiProxy = this.ctx.apiProxy;
		const commands = this.ctx.get("commands");
		const agents = this.ctx.get("agents");
		const router = createBridgeRouter({
			...apiProxy,
			...commands === void 0 ? {} : { commands },
			...agents === void 0 ? {} : { agents }
		}, { log: this.logger });
		this.router = router;
		router.prefetchSessionList();
		const handle = await startBridgeServer(router);
		this.handle = handle;
		this.url = handle.url;
		this.port = handle.port;
		this.logger(`bridge listening on ${handle.url}`);
		yield () => this.stop();
	}
	setCwd(directory) {
		this.router?.setCwd(directory);
	}
	prefetchSession(sessionId) {
		this.router?.prefetchSession(sessionId);
	}
	hasNewActivity() {
		return this.router?.hasNewActivity() ?? false;
	}
	exitNoteNeeded() {
		return this.router?.exitNoteNeeded() ?? Promise.resolve(false);
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
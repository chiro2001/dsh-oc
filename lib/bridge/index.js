import { i as projectIdFor, n as createBridgeRouter, r as makeEvent, t as startBridgeServer } from "../http-DmZ2FxnL.js";
import { Service } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";
//#region src/bridge/index.ts
const name = "@chiro2001/dsh-oc/bridge";
const inject = [
	"sessionController",
	"agentPresets",
	"goals",
	"sessionSkillCatalog",
	"agents",
	"sessions",
	"sessionProjections"
];
/**
* Keep older profile plugins (notably dsh-dcp rc.6) source-compatible with
* dsh-session 0.1.2. The Session log was intentionally moved behind
* snapshotEvents(), but dsh-dcp rc.6 (whose peer range is still locked to
* dsh 0.1.1-rc.2) reads `session.events` while handling the first prompt.
* Install the compatibility getter on the actual host Session prototype seen
* by the event callback; this also works when the host and bridge resolve
* duplicate package copies. Remove this shim after dsh-dcp upgrades its peer
* and switches to snapshotEvents().
*/
function installSessionEventsCompat(session) {
	if (session === null || typeof session !== "object" && typeof session !== "function") return false;
	const prototype = Object.getPrototypeOf(session);
	if (prototype === null || typeof prototype.snapshotEvents !== "function") return false;
	const existing = Object.getOwnPropertyDescriptor(prototype, "events");
	if (existing !== void 0 && (existing.get !== void 0 || existing.value !== void 0)) return false;
	try {
		Object.defineProperty(prototype, "events", {
			configurable: true,
			enumerable: false,
			get() {
				return this.snapshotEvents();
			}
		});
		return true;
	} catch {
		return false;
	}
}
function installSessionEventsOnLiveSessions(sessions) {
	if (sessions === null || typeof sessions !== "object") return 0;
	const list = sessions.list;
	if (typeof list !== "function") return 0;
	let live;
	try {
		live = list.call(sessions);
	} catch {
		return 0;
	}
	if (!Array.isArray(live)) return 0;
	let installed = 0;
	for (const session of live) try {
		if (installSessionEventsCompat(session)) installed++;
	} catch {}
	return installed;
}
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
	controlAbort;
	controlPump;
	stopped = false;
	eventDisposers = [];
	constructor(ctx) {
		super(ctx, "ocBridge");
		this.logger = makeLogger(ctx);
	}
	async *[Service.init]() {
		this.stopped = false;
		const sessionController = this.ctx.get("sessionController");
		const agentPresets = this.ctx.get("agentPresets");
		const goals = this.ctx.get("goals");
		const sessionSkillCatalog = this.ctx.get("sessionSkillCatalog");
		const commands = this.ctx.get("commands");
		const agents = this.ctx.get("agents");
		const sessions = this.ctx.get("sessions");
		const sessionProjections = this.ctx.get("sessionProjections");
		if (sessionController === void 0 || agentPresets === void 0 || goals === void 0 || sessionSkillCatalog === void 0) throw new Error("oc-bridge: missing dsh 0.1.2 host services (sessionController/agentPresets/goals/sessionSkillCatalog)");
		const api = {
			sessionController,
			agentPresets,
			goals,
			sessionSkillCatalog,
			...commands === void 0 ? {} : { commands },
			...agents === void 0 ? {} : { agents },
			...sessions === void 0 ? {} : { sessions },
			...sessionProjections === void 0 ? {} : { sessionProjections }
		};
		installSessionEventsOnLiveSessions(sessions);
		const router = createBridgeRouter(api, { log: this.logger });
		this.router = router;
		router.prefetchSessionList();
		const handle = await startBridgeServer(router);
		this.handle = handle;
		this.url = handle.url;
		this.port = handle.port;
		this.logger(`bridge listening on ${handle.url}`);
		this.subscribeHostEvents(router, api);
		yield () => this.stop();
	}
	/**
	* Host-side event pump (dsh 0.1.2 has no mux/host stream): subscribe to
	* session events, lifecycle, approval/question answerer waterfalls, and the
	* session control stream, translating each into bridge frames for the SSE
	* hub. Registered once for the service's lifetime.
	*/
	subscribeHostEvents(router, api) {
		const ctx = this.ctx;
		const log = this.logger;
		this.eventDisposers.push(ctx.on("session/created", (session) => {
			installSessionEventsCompat(session);
		}, {
			global: true,
			prepend: true
		}));
		this.eventDisposers.push(ctx.on("session/event", (session, event) => {
			if (this.stopped) return;
			installSessionEventsCompat(session);
			router.feed({
				type: "session/event",
				sessionId: String(session.id),
				event
			}).catch((error) => {
				log(`[bridge] session event feed failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}, { global: true }));
		const liveAttempts = /* @__PURE__ */ new Map();
		this.eventDisposers.push(ctx.on("agent/assistant-stream", ({ agent, frame }) => {
			if (this.stopped) return;
			const sessionId = String(agent.session.id);
			const attemptKey = `${sessionId}:${String(frame.attemptId)}`;
			if (frame.type === "start") {
				liveAttempts.set(attemptKey, {
					turn: frame.turn,
					step: frame.step
				});
				return;
			}
			if (frame.type === "end") {
				liveAttempts.delete(attemptKey);
				return;
			}
			const attempt = liveAttempts.get(attemptKey);
			if (attempt === void 0) return;
			router.feed({
				type: "session/assistant-stream",
				sessionId,
				turn: attempt.turn,
				step: attempt.step,
				time: frame.time,
				attemptId: String(frame.attemptId),
				revision: frame.revision,
				index: frame.index,
				chunk: frame.chunk
			}).catch((error) => {
				log(`[bridge] assistant stream feed failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}, { global: true }));
		this.eventDisposers.push(ctx.on("api-session/added", (summary) => {
			if (this.stopped) return;
			router.feedHostFrame({
				type: "host/session-added",
				sessionId: String(summary.sessionId),
				summary
			});
		}, { global: true }));
		this.eventDisposers.push(ctx.on("api-session/removed", (sessionId) => {
			if (this.stopped) return;
			router.feedHostFrame({
				type: "host/session-removed",
				sessionId: String(sessionId)
			});
		}, { global: true }));
		this.eventDisposers.push(ctx.on("api-session/error", (sessionId, message) => {
			if (this.stopped) return;
			router.feedHostFrame({
				type: "host/agent-error",
				sessionId: String(sessionId),
				message: String(message)
			});
		}, { global: true }));
		this.eventDisposers.push(ctx.on("api-session/status", (sessionId, running) => {
			if (this.stopped) return;
			router.feedHostFrame({
				type: "host/session-status",
				sessionId: String(sessionId),
				running: Boolean(running),
				updatedAt: Date.now()
			});
		}, { global: true }));
		this.eventDisposers.push(ctx.on("api-session/activity", (sessionId, updatedAt) => {
			if (this.stopped) return;
			router.feedHostFrame({
				type: "host/session-activity",
				sessionId: String(sessionId),
				updatedAt: typeof updatedAt === "number" ? updatedAt : Date.now()
			});
		}, { global: true }));
		this.eventDisposers.push(ctx.on("approval/request", async (req, next) => {
			if (this.stopped) return await next();
			const sessionId = String(req.agent.id);
			const toolName = req.toolName;
			if (router.ctx.state.savedPermissionFor(sessionId, toolName) !== void 0) return "allowed-once";
			const rpcId = randomUUID();
			const decision = new Promise((resolve) => {
				router.ctx.state.pendingApprovals.set(rpcId, resolve);
			});
			const frame = {
				type: "approval/requested",
				rpcId,
				sessionId,
				approvalId: rpcId,
				toolName,
				...req.callId === void 0 ? {} : { callId: String(req.callId) },
				...req.reason === void 0 ? {} : { reason: req.reason }
			};
			try {
				await router.feed(frame);
			} catch (error) {
				log(`[bridge] approval frame feed failed: ${error instanceof Error ? error.message : String(error)}`);
				router.ctx.state.pendingApprovals.delete(rpcId);
				return await next();
			}
			try {
				return await Promise.race([decision, new Promise((resolve) => {
					if (req.signal?.aborted) resolve("cancelled");
					else req.signal?.addEventListener("abort", () => resolve("cancelled"), { once: true });
				})]);
			} finally {
				const entry = router.ctx.state.permissionByRpcId(rpcId);
				router.ctx.state.pendingApprovals.delete(rpcId);
				if (entry !== void 0 && req.signal?.aborted) {
					router.ctx.state.removePermission(entry.opencodeId);
					const directory = router.ctx.state.sessionDirectories.get(entry.sessionId) ?? router.ctx.cwd;
					router.ctx.hub.broadcast([makeEvent(directory, "permission.replied", {
						sessionID: entry.sessionId,
						requestID: entry.opencodeId,
						reply: "reject"
					}, projectIdFor(directory))]);
				}
			}
		}, { global: true }));
		this.eventDisposers.push(ctx.on("user-questions/request", async (request, next) => {
			if (this.stopped) return await next();
			const sessionId = request.agent === void 0 ? void 0 : String(request.agent.id);
			const rpcId = randomUUID();
			const decision = new Promise((resolve) => {
				router.ctx.state.pendingQuestions.set(rpcId, resolve);
			});
			const frame = {
				type: "question/requested",
				rpcId,
				sessionId: sessionId ?? "",
				questions: request.questions
			};
			try {
				await router.feed(frame);
			} catch (error) {
				log(`[bridge] question frame feed failed: ${error instanceof Error ? error.message : String(error)}`);
				router.ctx.state.pendingQuestions.delete(rpcId);
				return await next();
			}
			try {
				const answer = await Promise.race([decision, new Promise((resolve) => {
					if (request.signal?.aborted) resolve(void 0);
					else request.signal?.addEventListener("abort", () => resolve(void 0), { once: true });
				})]);
				if (answer === void 0) return await next();
				return answer !== void 0 && !Array.isArray(answer) ? answer : { answers: answer };
			} finally {
				const entry = router.ctx.state.questionByRpcId(rpcId);
				router.ctx.state.pendingQuestions.delete(rpcId);
				if (entry !== void 0 && request.signal?.aborted) {
					router.ctx.state.removeQuestion(entry.opencodeId);
					const directory = router.ctx.state.sessionDirectories.get(entry.sessionId) ?? router.ctx.cwd;
					router.ctx.hub.broadcast([makeEvent(directory, "question.rejected", {
						sessionID: entry.sessionId,
						requestID: entry.opencodeId
					}, projectIdFor(directory))]);
				}
			}
		}, { global: true }));
		const controlAbort = new AbortController();
		this.controlAbort = controlAbort;
		this.controlPump = (async () => {
			for await (const frame of api.sessionController.control(controlAbort.signal)) try {
				if (frame.type === "baseline") await router.feed({
					type: "control/baseline",
					value: frame.value
				});
				else if (frame.type === "queue") await router.feed({
					type: "session/queue",
					sessionId: String(frame.sessionId),
					items: frame.items.map((item) => ({
						placement: item.placement,
						rpcId: item.rpcId === void 0 ? void 0 : String(item.rpcId),
						message: item.message
					}))
				});
				else if (frame.type === "jobs") {} else if (frame.type === "projection") await router.feed({
					type: "session/projection",
					sessionId: String(frame.sessionId),
					key: frame.key,
					value: frame.value,
					seq: frame.seq
				});
			} catch (error) {
				log(`[bridge] control frame feed failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		})().catch((error) => {
			log(`[bridge] control stream ended: ${error instanceof Error ? error.message : String(error)}`);
		});
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
		this.stopped = true;
		const state = this.router?.ctx.state;
		state?.abortAllShells();
		await state?.waitForShells(4e3);
		this.controlAbort?.abort();
		this.controlAbort = void 0;
		this.broadcastPendingUiCleanup();
		this.ctxStateClearPending();
		for (const dispose of this.eventDisposers.splice(0)) try {
			dispose();
		} catch (error) {
			this.logger(`[bridge] event listener cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const controlPump = this.controlPump;
		this.controlPump = void 0;
		if (controlPump !== void 0) await Promise.race([controlPump, new Promise((resolve) => setTimeout(resolve, 1e3))]);
		const handle = this.handle;
		this.handle = void 0;
		await handle?.close();
	}
	ctxStateClearPending() {
		this.router?.ctx.state.clearPendingInteractions();
	}
	broadcastPendingUiCleanup() {
		const router = this.router;
		if (router === void 0) return;
		const state = router.ctx.state;
		for (const entry of state.permissions.values()) {
			const directory = state.sessionDirectories.get(entry.sessionId) ?? router.ctx.cwd;
			router.ctx.hub.broadcast([makeEvent(directory, "permission.replied", {
				sessionID: entry.sessionId,
				requestID: entry.opencodeId,
				reply: "reject"
			}, projectIdFor(directory))]);
		}
		for (const entry of state.questions.values()) {
			const directory = state.sessionDirectories.get(entry.sessionId) ?? router.ctx.cwd;
			router.ctx.hub.broadcast([makeEvent(directory, "question.rejected", {
				sessionID: entry.sessionId,
				requestID: entry.opencodeId
			}, projectIdFor(directory))]);
		}
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
export { OcBridgeService, OcBridgeService as default, inject, installSessionEventsCompat, installSessionEventsOnLiveSessions, name };

//# sourceMappingURL=index.js.map
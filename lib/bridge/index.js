import { n as createBridgeRouter, t as startBridgeServer } from "../http-D2qPllKB.js";
import { Service } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";
//#region src/bridge/index.ts
const name = "@chiro2001/dsh-oc/bridge";
const inject = [
	"sessionController",
	"agentPresets",
	"goals",
	"sessionSkillCatalog"
];
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
		const sessionController = this.ctx.get("sessionController");
		const agentPresets = this.ctx.get("agentPresets");
		const goals = this.ctx.get("goals");
		const sessionSkillCatalog = this.ctx.get("sessionSkillCatalog");
		const commands = this.ctx.get("commands");
		const agents = this.ctx.get("agents");
		if (sessionController === void 0 || agentPresets === void 0 || goals === void 0 || sessionSkillCatalog === void 0) throw new Error("oc-bridge: missing dsh 0.1.2 host services (sessionController/agentPresets/goals/sessionSkillCatalog)");
		const api = {
			sessionController,
			agentPresets,
			goals,
			sessionSkillCatalog,
			...commands === void 0 ? {} : { commands },
			...agents === void 0 ? {} : { agents }
		};
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
		ctx.on("session/event", (session, event) => {
			router.feed({
				type: "session/event",
				sessionId: String(session.id),
				event
			}).catch((error) => {
				log(`[bridge] session event feed failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}, { global: true });
		ctx.on("session/created", (session) => {
			router.feedHostFrame({
				type: "host/session-added",
				sessionId: String(session.id)
			});
		}, { global: true });
		ctx.on("session/disposed", (session) => {
			router.feedHostFrame({
				type: "host/session-removed",
				sessionId: String(session.id)
			});
		}, { global: true });
		ctx.on("approval/request", async (req, next) => {
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
			await router.feed(frame);
			try {
				return await Promise.race([decision, new Promise((resolve) => {
					req.signal?.addEventListener("abort", () => resolve("cancelled"), { once: true });
				})]);
			} finally {
				router.ctx.state.pendingApprovals.delete(rpcId);
			}
		}, { global: true });
		ctx.on("user-questions/request", async (request, next) => {
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
			await router.feed(frame);
			try {
				const answer = await Promise.race([decision, new Promise((resolve) => {
					request.signal?.addEventListener("abort", () => resolve(void 0), { once: true });
				})]);
				if (answer === void 0) return await next();
				return answer;
			} finally {
				router.ctx.state.pendingQuestions.delete(rpcId);
			}
		}, { global: true });
		(async () => {
			for await (const frame of api.sessionController.control(new AbortController().signal)) try {
				if (frame.type === "queue") router.feed({
					type: "session/queue",
					sessionId: String(frame.sessionId),
					items: frame.items.map((item) => ({
						placement: item.placement,
						message: item.message
					}))
				});
				else if (frame.type === "jobs") {} else if (frame.type === "projection") router.feed({
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
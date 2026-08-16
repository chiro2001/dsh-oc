import { n as createBridgeRouter, t as startBridgeServer } from "../http-AKaJp5Sy.js";
import { Service } from "@deepseek-ai/cordis";
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
		const api = {
			...apiProxy,
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
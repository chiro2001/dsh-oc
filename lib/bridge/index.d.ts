import { Context, Service } from "@deepseek-ai/cordis";
//#region src/bridge/index.d.ts
declare const name = "@deepseek-ai/dsh-oc/bridge";
declare const inject: readonly ['apiProxy'];
interface OcBridgeValue {
  url: string;
  port: number;
}
/**
 * oc-bridge cordis service: owns the loopback HTTP/SSE server and exposes
 * `{ url, port }` once the listener is ready. `Service.init` starts the
 * server before the service becomes injectable, and yields the teardown
 * disposer so dispose never hangs.
 */
declare class OcBridgeService extends Service implements OcBridgeValue {
  url: string;
  port: number;
  private handle;
  private readonly logger;
  constructor(ctx: Context);
  [Service.init](): AsyncGenerator<() => Promise<void>>;
  private stop;
}
//#endregion
export { OcBridgeService, OcBridgeService as default, OcBridgeValue, inject, name };
//# sourceMappingURL=index.d.ts.map
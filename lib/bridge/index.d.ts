import { Context, Service } from "@deepseek-ai/cordis";
//#region src/bridge/index.d.ts
declare const name = "@chiro2001/dsh-oc/bridge";
declare const inject: readonly ['sessionController', 'agentPresets', 'goals', 'sessionSkillCatalog', 'agents', 'sessions', 'sessionProjections'];
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
declare function installSessionEventsCompat(session: unknown): boolean;
declare function installSessionEventsOnLiveSessions(sessions: unknown): number;
interface OcBridgeValue {
  url: string;
  port: number;
  /** Change the bridge working directory (attach `--dir` support). */
  setCwd(directory: string): void;
  /** Warm one session's tail history (attach `--session` resume support). */
  prefetchSession(sessionId: string): void;
  /** Whether this run accepted new user input. */
  hasNewActivity(): boolean;
  /** Whether the TUI exit banner likely printed and needs the dsh hint. */
  exitNoteNeeded(): Promise<boolean>;
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
  private router;
  private readonly logger;
  private controlAbort?;
  private controlPump?;
  private stopped;
  private readonly eventDisposers;
  constructor(ctx: Context);
  [Service.init](): AsyncGenerator<() => Promise<void>>;
  /**
   * Host-side event pump (dsh 0.1.2 has no mux/host stream): subscribe to
   * session events, lifecycle, approval/question answerer waterfalls, and the
   * session control stream, translating each into bridge frames for the SSE
   * hub. Registered once for the service's lifetime.
   */
  private subscribeHostEvents;
  setCwd(directory: string): void;
  prefetchSession(sessionId: string): void;
  hasNewActivity(): boolean;
  exitNoteNeeded(): Promise<boolean>;
  private stop;
  private ctxStateClearPending;
  private broadcastPendingUiCleanup;
}
//#endregion
export { OcBridgeService, OcBridgeService as default, OcBridgeValue, inject, installSessionEventsCompat, installSessionEventsOnLiveSessions, name };
//# sourceMappingURL=index.d.ts.map
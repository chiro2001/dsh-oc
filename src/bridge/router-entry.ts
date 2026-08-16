// Tooling entry: expose the bridge router/server constructors for external
// harnesses (minimal OpenCode server, scripted repro, future tests).
export { createBridgeRouter, type BridgeRouter } from './router.js'
export { startBridgeServer, type BridgeServerHandle } from './http.js'

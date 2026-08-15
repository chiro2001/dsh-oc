import type { Route } from './router.js'

/**
 * Schema-valid stub routes: the TUI probes these at startup and must always
 * receive 2xx JSON, even though dsh does not back the capability.
 */
export const stubRoutes: Route[] = [
  jsonRoute('GET', '/lsp', []),
  jsonRoute('GET', '/mcp', {}),
  jsonRoute('GET', '/formatter', []),
  jsonRoute('GET', '/experimental/resource', []),
  jsonRoute('GET', '/experimental/console', {
    consoleManagedProviders: [],
    switchableOrgCount: 0,
  }),
  jsonRoute('GET', '/experimental/capabilities', {
    backgroundSubagents: true,
  }),
  jsonRoute('GET', '/vcs', { branch: '' }),
  jsonRoute('GET', '/experimental/workspace', []),
  jsonRoute('GET', '/experimental/workspace/status', []),
]

function jsonRoute(
  method: string,
  pattern: string,
  body: unknown,
): Route {
  return {
    method,
    pattern,
    kind: 'json',
    handler: async () => ({ status: 200, body }),
  }
}

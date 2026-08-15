import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  extractParams,
  type BridgeRequest,
  type BridgeRouter,
} from './router.js'
import {
  badRequest,
  internalError,
  notImplemented,
  HttpError,
  type OpenCodeErrorBody,
} from './errors.js'

export interface BridgeServerHandle {
  url: string
  port: number
  server: http.Server
  close(): Promise<void>
}

const MAX_BODY_BYTES = 1024 * 1024

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
}

/**
 * Start the loopback HTTP server. `url`/`port` are available once the
 * returned promise resolves (after `listen` on 127.0.0.1:0).
 */
export async function startBridgeServer(
  router: BridgeRouter,
  options: { host?: string } = {},
): Promise<BridgeServerHandle> {
  const host = options.host ?? '127.0.0.1'
  const sockets = new Set<import('node:net').Socket>()
  const server = http.createServer((req, res) => {
    void handleRequest(router, req, res).catch((error: unknown) => {
      sendError(res, error instanceof HttpError
        ? error
        : internalError(error instanceof Error ? error.message : String(error)))
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, host)
  })
  const address = server.address() as AddressInfo
  const port = address.port

  return {
    url: `http://${host}:${port}`,
    port,
    server,
    close: async () => {
      router.ctx.hub.closeAll()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}

async function handleRequest(
  router: BridgeRouter,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const pathname = url.pathname
  res.setHeader('Access-Control-Allow-Origin', '*')

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }

  let body: unknown
  if (method !== 'GET' && method !== 'HEAD') {
    body = await readBody(req)
  }

  const route = router.match(method, pathname)
  if (!route) {
    throw notImplemented(`${method} ${pathname} is not implemented by oc-bridge`)
  }

  const request: BridgeRequest = {
    method,
    pathname,
    query: url.searchParams,
    params: extractParams(route.pattern, pathname),
    body,
  }

  if (route.kind === 'sse') {
    req.socket.setTimeout(0)
    router.startSse(request, res)
    return
  }

  const result = await route.handler(request, router.ctx)
  sendResult(res, result.status, result.body, result.raw, result.headers)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      throw badRequest('request body exceeds 1 MiB limit')
    }
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return undefined
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.length === 0) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw badRequest('invalid JSON body')
  }
}

function sendResult(
  res: ServerResponse,
  status: number,
  body?: unknown,
  raw?: string | Buffer,
  headers?: Record<string, string>,
): void {
  if (raw !== undefined) {
    const data = typeof raw === 'string' ? raw : raw.toString('utf8')
    res.writeHead(status, {
      ...CORS_HEADERS,
      ...headers,
      'Content-Type': headers?.['Content-Type'] ?? 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
    })
    res.end(data)
    return
  }
  if (status === 204 || status === 304 || body === undefined) {
    res.writeHead(status, { ...CORS_HEADERS, ...headers, 'Content-Length': '0' })
    res.end()
    return
  }
  const data = JSON.stringify(body)
  res.writeHead(status, {
    ...CORS_HEADERS,
    ...headers,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  })
  res.end(data)
}

function sendError(res: ServerResponse, error: HttpError): void {
  sendResult(res, error.status, error.body as OpenCodeErrorBody)
}

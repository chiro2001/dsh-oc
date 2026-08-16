import type { ServerResponse } from 'node:http'
import type { BridgeGlobalEvent } from './events.js'

interface SseClient {
  id: number
  res: ServerResponse
  controller: AbortController
  closed: boolean
}

/** Registry of active SSE connections plus the encoder/cleanup logic. */
export class SseHub {
  private clients = new Set<SseClient>()
  /** Events enqueued before any client connected (raw replay mode). */
  private pending: BridgeGlobalEvent[] = []
  private nextId = 1

  constructor(private log: (message: string) => void) {}

  add(res: ServerResponse): SseClient {
    const client: SseClient = {
      id: this.nextId++,
      res,
      controller: new AbortController(),
      closed: false,
    }
    this.clients.add(client)
    // A client that connects late must still receive events queued before
    // it subscribed (raw replay / recorded traces).
    if (this.pending.length > 0) {
      const queued = this.pending.splice(0)
      for (const event of queued) this.send(client, event)
    }
    res.on('close', () => this.remove(client))
    res.on('error', (error) => {
      this.log(`[bridge/sse] client ${client.id} error: ${error.message}`)
      this.remove(client)
    })
    return client
  }

  remove(client: SseClient): void {
    if (client.closed) return
    client.closed = true
    this.clients.delete(client)
    client.controller.abort()
  }

  send(client: SseClient, event: BridgeGlobalEvent): void {
    if (client.closed || client.res.destroyed) return
    const data = JSON.stringify(event)
    try {
      client.res.write(`id: ${event.payload.id}\ndata: ${data}\n\n`)
    } catch (error) {
      this.log(`[bridge/sse] write to client ${client.id} failed: ${error instanceof Error ? error.message : String(error)}`)
      this.remove(client)
    }
  }

  /** Fan one event batch out to every connected SSE client. */
  broadcast(events: BridgeGlobalEvent[]): void {
    for (const client of [...this.clients]) {
      for (const event of events) this.send(client, event)
    }
  }

  /** Broadcast now, or buffer until the first client connects. */
  enqueue(events: BridgeGlobalEvent[]): void {
    if (this.clients.size === 0) {
      this.pending.push(...events)
      return
    }
    this.broadcast(events)
  }

  closeAll(): void {
    for (const client of [...this.clients]) {
      this.remove(client)
    }
  }

  get size(): number {
    return this.clients.size
  }
}

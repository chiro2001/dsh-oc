import type { ServerResponse } from 'node:http'
import type { BridgeGlobalEvent } from './events.js'

export interface SseClient {
  id: number
  res: ServerResponse
  controller: AbortController
  closed: boolean
  /** Optional per-connection session filter (attach `?sessionID=`). */
  filter?: (event: BridgeGlobalEvent) => boolean
}

export interface SseHubOptions {
  /** Maximum number of broadcast events retained for Last-Event-ID replay. */
  maxReplayEvents?: number
  /** Maximum serialized wire bytes retained for Last-Event-ID replay. */
  maxReplayBytes?: number
}

interface ReplayEntry {
  event: BridgeGlobalEvent
  wire: string
  bytes: number
}

/** Registry of active SSE connections plus the encoder/cleanup logic. */
export class SseHub {
  private clients = new Set<SseClient>()
  /** Events enqueued before any client connected (raw replay mode). */
  private pending: BridgeGlobalEvent[] = []
  private readonly replay: ReplayEntry[] = []
  private replayBytes = 0
  private readonly maxReplayEvents: number
  private readonly maxReplayBytes: number
  private nextId = 1

  constructor(
    private log: (message: string) => void,
    options: SseHubOptions = {},
  ) {
    this.maxReplayEvents = Math.max(1, Math.floor(options.maxReplayEvents ?? 512))
    this.maxReplayBytes = Math.max(1, Math.floor(options.maxReplayBytes ?? 4 * 1024 * 1024))
  }

  add(res: ServerResponse, filter?: (event: BridgeGlobalEvent) => boolean): SseClient {
    const client: SseClient = {
      id: this.nextId++,
      res,
      controller: new AbortController(),
      closed: false,
      filter,
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
    if (client.filter !== undefined && !client.filter(event)) return
    this.sendWire(client, this.encode(event))
  }

  private encode(event: BridgeGlobalEvent): ReplayEntry {
    const data = JSON.stringify(event)
    const wire = `id: ${event.payload.id}\ndata: ${data}\n\n`
    return { event, wire, bytes: Buffer.byteLength(wire) }
  }

  private sendWire(client: SseClient, entry: ReplayEntry): void {
    if (client.closed || client.res.destroyed) return
    try {
      client.res.write(entry.wire)
    } catch (error) {
      this.log(`[bridge/sse] write to client ${client.id} failed: ${error instanceof Error ? error.message : String(error)}`)
      this.remove(client)
    }
  }

  private remember(event: BridgeGlobalEvent): ReplayEntry {
    const entry = this.encode(event)
    this.replay.push(entry)
    this.replayBytes += entry.bytes
    while (this.replay.length > this.maxReplayEvents || this.replayBytes > this.maxReplayBytes) {
      const removed = this.replay.shift()
      if (removed === undefined) break
      this.replayBytes -= removed.bytes
    }
    return entry
  }

  /** Replay events strictly after a known event id; return false when the id
   * is outside the bounded ring (or was never observed). */
  replayAfter(client: SseClient, lastEventId: string): boolean {
    const index = this.replay.findIndex((entry) => entry.event.payload.id === lastEventId)
    if (index === -1) return false
    for (const entry of this.replay.slice(index + 1)) {
      if (client.filter !== undefined && !client.filter(entry.event)) continue
      this.sendWire(client, entry)
    }
    return true
  }

  /** Fan one event batch out to every connected SSE client. */
  broadcast(events: BridgeGlobalEvent[]): void {
    const entries = events.map((event) => this.remember(event))
    for (const client of [...this.clients]) {
      for (const entry of entries) {
        if (client.filter !== undefined && !client.filter(entry.event)) continue
        this.sendWire(client, entry)
      }
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

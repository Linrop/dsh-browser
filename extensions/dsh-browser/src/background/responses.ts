import type { ServerFrame } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'

type ResponseReceipt = Extract<ServerFrame, { t: 'respond.result' }>

/** Minimal panel-port surface needed for targeted interaction receipts. */
export interface ResponsePort {
  postMessage(message: unknown): void
}

interface PendingResponse {
  port: ResponsePort
  timer: ReturnType<typeof setTimeout>
}

/** Most receipts kept for a panel that is not currently connected. */
export const MAX_PENDING_RESPONSES = 8
/** Byte budget of the receipt buffer; an older receipt is evicted first. */
export const MAX_PENDING_RESPONSE_BYTES = 16 * 1024 * 1024
/** A receipt older than this no longer describes a live interaction. */
export const PENDING_RESPONSE_TTL_MS = 120_000

interface BufferedResponse {
  message: unknown
  bytes: number
  at: number
}

/**
 * Bounded FIFO of receipts whose panel port was gone when they arrived.
 *
 * Three limits keep a detached panel from pinning memory: at most
 * {@link MAX_PENDING_RESPONSES} entries, at most
 * {@link MAX_PENDING_RESPONSE_BYTES} of serialized bytes (oldest evicted
 * first), and {@link PENDING_RESPONSE_TTL_MS} of freshness. Every eviction is
 * counted so diagnostics can tell "nothing was pending" from "payload dropped".
 */
export class PendingResponseBuffer {
  private entries: BufferedResponse[] = []
  private byteLength = 0
  private droppedEntries = 0

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Receipts evicted by any limit. */
  get dropped(): number {
    return this.droppedEntries
  }

  /** Receipts currently held. */
  get size(): number {
    return this.entries.length
  }

  /** Serialized bytes currently held. */
  get bytes(): number {
    return this.byteLength
  }

  /** Store one receipt, evicting the oldest entries that break a limit. */
  push(message: unknown): void {
    let bytes = 0
    try {
      const serialized = JSON.stringify(message)
      bytes = serialized === undefined ? 0 : serialized.length
    } catch {
      // An unserializable receipt cannot be delivered later either; count it
      // as dropped instead of storing a value that will throw on every drain.
      this.droppedEntries += 1
      return
    }
    this.sweepExpired()
    // A single oversized receipt would evict everything for nothing.
    if (bytes > MAX_PENDING_RESPONSE_BYTES) {
      this.droppedEntries += 1
      return
    }
    this.entries.push({ message, bytes, at: this.now() })
    this.byteLength += bytes
    while (this.entries.length > MAX_PENDING_RESPONSES
      || this.byteLength > MAX_PENDING_RESPONSE_BYTES) {
      const evicted = this.entries.shift()
      if (evicted === undefined) break
      this.byteLength -= evicted.bytes
      this.droppedEntries += 1
    }
  }

  /** Deliver every live receipt to one port, oldest first; clear on success. */
  drain(port: ResponsePort): void {
    this.sweepExpired()
    const entries = this.entries
    this.entries = []
    this.byteLength = 0
    for (const entry of entries) {
      try {
        port.postMessage(entry.message)
      } catch {
        // The port died mid-drain: stop and keep the rest for the next panel.
        this.push(entry.message)
      }
    }
  }

  private sweepExpired(): void {
    const cutoff = this.now() - PENDING_RESPONSE_TTL_MS
    while (this.entries.length > 0 && (this.entries[0]?.at ?? 0) < cutoff) {
      const expired = this.entries.shift()
      if (expired === undefined) break
      this.byteLength -= expired.bytes
      this.droppedEntries += 1
    }
  }
}

/**
 * Correlates one interaction response with the panel that sent it. Receipts
 * must never be broadcast: separate side panels can answer at the same time.
 */
export class InteractionResponseRouter {
  private readonly pending = new Map<string, PendingResponse>()

  constructor(
    private readonly timeoutMs = 30_000,
    private readonly buffer = new PendingResponseBuffer(),
  ) {}

  /** Receipts dropped by the buffer's limits, for diagnostics. */
  get droppedResponses(): number {
    return this.buffer.dropped
  }

  /**
   * Replay receipts that arrived while no panel was connected.
   * @param port - the freshly connected panel port.
   */
  flush(port: ResponsePort): void {
    this.buffer.drain(port)
  }

  begin(
    port: ResponsePort,
    id: string,
    dispatch: () => boolean,
    messages: { unavailable: string; timeout: string; duplicate: string },
  ): void {
    if (this.pending.has(id)) {
      this.postError(port, id, 'duplicate-id', messages.duplicate)
      return
    }
    const timer = setTimeout(() => {
      const entry = this.take(id)
      if (entry !== undefined) this.postError(entry.port, id, 'timeout', messages.timeout)
    }, this.timeoutMs)
    this.pending.set(id, { port, timer })
    if (!dispatch()) {
      const entry = this.take(id)
      if (entry !== undefined) this.postError(entry.port, id, 'bridge-unavailable', messages.unavailable)
    }
  }

  route(receipt: ResponseReceipt): void {
    const entry = this.take(receipt.id)
    if (entry === undefined) return
    this.deliver(entry.port, receipt.ok
      ? { type: 'respond.result', id: receipt.id, ok: true, result: receipt.result }
      : { type: 'respond.result', id: receipt.id, ok: false, error: receipt.error })
  }

  failAll(message: string): void {
    for (const id of [...this.pending.keys()]) {
      const entry = this.take(id)
      if (entry !== undefined) this.postError(entry.port, id, 'bridge-disconnected', message)
    }
  }

  removePort(port: ResponsePort): void {
    for (const [id, entry] of this.pending) {
      if (entry.port !== port) continue
      clearTimeout(entry.timer)
      this.pending.delete(id)
    }
  }

  private take(id: string): PendingResponse | undefined {
    const entry = this.pending.get(id)
    if (entry === undefined) return undefined
    clearTimeout(entry.timer)
    this.pending.delete(id)
    return entry
  }

  private postError(port: ResponsePort, id: string, code: string, message: string): void {
    this.deliver(port, { type: 'respond.result', id, ok: false, error: { code, message } })
  }

  /** Deliver one receipt, holding it for the next panel when the port is gone. */
  private deliver(port: ResponsePort, message: unknown): void {
    try {
      port.postMessage(message)
    } catch {
      this.buffer.push(message)
    }
  }
}

/**
 * Bridge WebSocket client (background side): connects to the dsh bridge,
 * authenticates with the bearer token, keeps the connection alive with
 * exponential-backoff reconnects, and answers protocol pings.
 *
 * The reconnect policy mirrors the dsh GUI's own ConnectionController: base
 * 500ms, ×2 per attempt, capped at 10s, jittered 0.5–1×.
 *
 * Liveness is owned by two deadlines rather than by hope: a socket that has
 * not completed the `hello` handshake within {@link CONNECT_TIMEOUT_MS} is
 * declared dead, and a connected socket that shows no inbound traffic for
 * {@link IDLE_TIMEOUT_MS} is closed so the reconnect loop rebuilds it. Every
 * lifecycle decision is logged under `bridge_browser.bridge.*` so a field
 * report can be reconstructed from the service worker console alone.
 *
 * @module
 */

import type { BridgeCaps, ClientFrame, ServerFrame } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import {
  DEFAULT_SNAPSHOT_MAX_CHARS,
  isServerFrame,
  parseBridgeFrame,
} from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { bumpEvent } from './events.ts'

/** Coarse connection state for the UI. */
export type BridgeState = 'connecting' | 'connected' | 'reconnecting' | 'stopped'

/** Frame/state sinks owned by the background assembly. */
export interface BridgeSinks {
  onStateChange(state: BridgeState): void
  onFrame(frame: ServerFrame): void
  onHelloOk(caps: BridgeCaps): void
}

/** Resolve whether opening a WebSocket is expected to succeed. */
type BridgeProbe = (url: string) => Promise<boolean>

const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 10_000

/** Deadline for socket open + `hello.ok`; a socket past it is treated as dead. */
export const CONNECT_TIMEOUT_MS = 30_000
/** Inbound silence after which a connected socket is rebuilt. */
export const IDLE_TIMEOUT_MS = 90_000
/** How often the idle deadline is evaluated. */
export const WATCHDOG_INTERVAL_MS = 5_000
/** Namespace prefix of every lifecycle log line. */
export const BRIDGE_LOG_NAMESPACE = 'bridge_browser.bridge'

/** Emit one namespaced lifecycle line (local console only; no telemetry). */
function logEvent(event: string, detail?: Record<string, unknown>, level: 'info' | 'warn' = 'info'): void {
  const suffix = detail === undefined ? '' : ` ${JSON.stringify(detail)}`
  const line = `[${BRIDGE_LOG_NAMESPACE}.${event}]${suffix}`
  if (level === 'warn') console.warn(line)
  else console.info(line)
}

/**
 * Owns one WebSocket connection generation and the reconnect loop.
 */
export class BridgeClient {
  private ws: WebSocket | null = null
  private attempt = 0
  private running = false
  /** Per-start generation token: a new start() invalidates any in-flight loop. */
  private generation = 0
  private url = ''
  private token = ''
  private connectTimer: ReturnType<typeof setTimeout> | undefined
  private watchdog: ReturnType<typeof setInterval> | undefined
  /** Last inbound frame, which is what proves the peer is alive. */
  private lastActivityAt = 0
  /** Last successful outbound write; diagnostics only, never an idle deadline input. */
  private lastSendAt = 0

  constructor(
    readonly sinks: BridgeSinks,
    private readonly probe: BridgeProbe = async () => true,
    /** Whether a disconnected client still has an active user-owned lease. */
    private readonly shouldReconnect: () => boolean = () => true,
  ) {}

  /** Current coarse state (mirrors the last emitted sink value). */
  state: BridgeState = 'stopped'

  /**
   * Connect (or reconnect) to the bridge. Idempotent: calling again with the
   * same url/token restarts the loop from attempt 0.
   * @param url - bridge WebSocket URL (e.g. ws://127.0.0.1:3080/ext/bridge).
   * @param token - bearer token from settings.
   */
  start(url: string, token: string): void {
    this.stop()
    this.url = url
    this.token = token
    this.running = true
    this.attempt = 0
    this.lastActivityAt = Date.now()
    this.generation += 1
    logEvent('connect.start', { attempt: this.attempt })
    this.startWatchdog()
    void this.loop(this.generation)
  }

  /** Stop the loop and close the current socket. */
  stop(): void {
    this.running = false
    this.clearConnectTimer()
    this.stopWatchdog()
    this.ws?.close()
    this.ws = null
    this.emitState('stopped')
  }

  /**
   * Drop an in-progress reconnect when its UI lease disappears, while keeping
   * an authenticated socket alive for background approvals already enabled by
   * the user. A later socket loss will still consult shouldReconnect().
   */
  suspendReconnect(): void {
    if (this.state === 'connected') return
    this.stop()
  }

  /** Whether a frame can be sent right now. */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  /** Timestamp of the last successful outbound write (diagnostics only). */
  get lastOutboundAt(): number {
    return this.lastSendAt
  }

  /**
   * Send one client frame.
   * @param frame - frame to send.
   * @returns false when no live socket exists.
   */
  send(frame: ClientFrame): boolean {
    const socket = this.ws
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false
    try {
      socket.send(JSON.stringify(frame))
      // Outbound traffic proves nothing about the peer: only an inbound frame
      // refreshes the idle deadline, so a peer that stopped reading is still
      // detected. This timestamp exists for diagnostics only.
      this.lastSendAt = Date.now()
      return true
    } catch (error: unknown) {
      logEvent('send.failed', {
        frame: frame.t,
        error: error instanceof Error ? error.message : String(error),
      }, 'warn')
      return false
    }
  }

  private async loop(generation: number): Promise<void> {
    while (this.running && generation === this.generation) {
      if (!this.retryAllowed()) return
      const reachable = await this.probe(this.url).catch(() => false)
      if (!this.running || generation !== this.generation) return
      if (!this.retryAllowed()) return
      if (!reachable) {
        this.emitState('reconnecting')
        await this.waitBeforeRetry()
        continue
      }

      const socket = new WebSocket(this.url)
      this.ws = socket
      this.armConnectTimeout(socket)
      // A replacement is an ownership handoff, not a transient transport
      // failure. Yield permanently so two open profiles cannot reconnect in a
      // tight loop and repeatedly evict one another.
      socket.addEventListener('close', (event) => {
        if (event.code !== 4000 || this.ws !== socket || !this.running) return
        this.running = false
        this.clearConnectTimer()
        this.ws = null
        logEvent('replaced', { code: event.code }, 'warn')
        this.emitState('stopped')
      }, { once: true })
      this.emitState('connecting')

      await new Promise<void>((resolve) => {
        socket.addEventListener('open', () => { resolve() }, { once: true })
        socket.addEventListener('close', () => { resolve() }, { once: true })
        socket.addEventListener('error', () => { resolve() }, { once: true })
      })
      if (!this.running || generation !== this.generation) {
        socket.close()
        return
      }
      if (socket.readyState !== WebSocket.OPEN) {
        await this.fail(socket)
        continue
      }

      // Authenticate: hello must be accepted before any other traffic.
      socket.send(JSON.stringify({
        t: 'hello',
        token: this.token,
        caps: { textOnly: true, snapshotMaxChars: DEFAULT_SNAPSHOT_MAX_CHARS, maxInteractiveItems: 60 },
      } satisfies ClientFrame))

      let authed = false
      const accepted = await new Promise<boolean>((resolve) => {
        const onMessage = (event: MessageEvent): void => {
          const frame = parseBridgeFrame(String(event.data))
          if (frame === undefined) return
          this.lastActivityAt = Date.now()
          if (!authed) {
            if (frame.t === 'hello.ok') {
              authed = true
              this.clearConnectTimer()
              logEvent('hello.ok', { snapshotMaxChars: frame.caps.snapshotMaxChars })
              resolve(true)
              this.sinks.onHelloOk(frame.caps)
            } else if (frame.t === 'error' || frame.t === 'rpc.result' || frame.t === 'event') {
              this.sinks.onFrame(frame)
            }
            return
          }
          if (frame.t === 'ping') {
            socket.send(JSON.stringify({ t: 'pong' } satisfies ClientFrame))
            return
          }
          if (isServerFrame(frame)) this.sinks.onFrame(frame)
        }
        socket.addEventListener('message', onMessage)
        socket.addEventListener('close', () => {
          this.clearConnectTimer()
          resolve(false)
        }, { once: true })
      })
      if (!accepted || !this.running || generation !== this.generation) {
        await this.fail(socket)
        continue
      }

      this.attempt = 0
      this.lastActivityAt = Date.now()
      bumpEvent('bridge.connected')
      this.emitState('connected')

      await new Promise<void>((resolve) => {
        socket.addEventListener('close', () => resolve(), { once: true })
        socket.addEventListener('error', () => resolve(), { once: true })
      })
      if (!this.running || generation !== this.generation) {
        socket.close()
        return
      }
      await this.fail(socket)
    }
  }

  private async fail(socket: WebSocket): Promise<void> {
    if (this.ws === socket) this.ws = null
    this.clearConnectTimer()
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close()
    }
    if (!this.running) return
    if (!this.retryAllowed()) return
    logEvent('reconnect.scheduled', { attempt: this.attempt + 1 }, 'warn')
    this.emitState('reconnecting')
    await this.waitBeforeRetry()
  }

  private retryAllowed(): boolean {
    if (this.shouldReconnect()) return true
    this.running = false
    this.emitState('stopped')
    return false
  }

  private async waitBeforeRetry(): Promise<void> {
    this.attempt += 1
    const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, this.attempt - 1))
    const delay = cap / 2 + Math.random() * (cap / 2)
    await new Promise<void>((resolve) => { setTimeout(resolve, delay) })
  }

  /** Start the handshake deadline for one socket generation. */
  private armConnectTimeout(socket: WebSocket): void {
    this.clearConnectTimer()
    this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined
      bumpEvent('bridge.connect_timeout')
      logEvent('connect.timeout', { deadlineMs: CONNECT_TIMEOUT_MS }, 'warn')
      // Closing resolves the handshake promise; the loop's fail() path then
      // schedules the bounded reconnect instead of leaving a half-open socket.
      socket.close(4008, 'connect timeout')
    }, CONNECT_TIMEOUT_MS)
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== undefined) {
      clearTimeout(this.connectTimer)
      this.connectTimer = undefined
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog()
    this.watchdog = setInterval(() => { this.checkIdle() }, WATCHDOG_INTERVAL_MS)
  }

  private stopWatchdog(): void {
    if (this.watchdog !== undefined) {
      clearInterval(this.watchdog)
      this.watchdog = undefined
    }
  }

  /** Close a connected socket that has shown no inbound traffic within the deadline. */
  private checkIdle(): void {
    if (this.state !== 'connected' || this.ws === null) return
    const idleMs = Date.now() - this.lastActivityAt
    if (idleMs < IDLE_TIMEOUT_MS) return
    bumpEvent('bridge.stale_reconnect')
    logEvent('idle.timeout', { idleMs, deadlineMs: IDLE_TIMEOUT_MS }, 'warn')
    this.clearConnectTimer()
    this.ws.close(4009, 'idle timeout')
  }

  private emitState(state: BridgeState): void {
    this.state = state
    this.sinks.onStateChange(state)
  }
}

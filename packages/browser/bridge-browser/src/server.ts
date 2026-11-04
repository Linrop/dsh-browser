/**
 * Bridge WebSocket carrier: token-authenticated connection registry, gateway
 * RPC dispatch, per-connection event pump, and tool-call dispatch to the
 * connected browser extension.
 *
 * The route this server mounts (`/ext/bridge`) lives OUTSIDE the /api trust
 * fence (which only guards the client-connection routes), so the bridge brings
 * its own authentication: a bearer token presented in the `hello` frame within
 * HELLO_TIMEOUT_MS. Host calls terminate at the bridge-owned Host adapter.
 * Methods the /api carrier pins to loopback (`PRIVILEGED_METHODS`)
 * stay loopback-only here regardless of the token, defense in depth for
 * `--host 0.0.0.0` deployments.
 *
 * One active connection at a time: a new authenticated socket replaces the
 * previous one (the old socket is closed and its in-flight tool calls settle
 * as `bridge-closed`).
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { BrowserHostApi } from './host-api.ts'
import {
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  BRIDGE_SESSION_PURGE_METHOD,
  HELLO_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  MAX_INFLIGHT_SENDS,
  PING_INTERVAL_MS,
  parseBridgeFrame,
  type BridgeFrame,
  type BridgeCaps,
  type ClientFrame,
  type ServerFrame,
  type ToolErrorCode,
} from './protocol.ts'
import { SessionPurgeError } from './session-purge.ts'
import { verifyToken } from './token.ts'

/**
 * Gateway methods the /api carrier pins to loopback (mirror of
 * client-connection's PRIVILEGED_METHODS; kept verbatim so the two fences
 * cannot drift). The bridge rejects these for non-loopback remotes even with
 * a valid token.
 */
const PRIVILEGED_METHODS = new Set([
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
])

/** Session mutations whose WebSocket arrival order is behaviorally significant. */
const ORDERED_SESSION_METHODS = new Set([
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  'session.prompt',
  'session.cancel',
])

/** Loopback IPv4/IPv6 literals (IPv4-mapped included). Exported for tests and reuse. */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Error thrown by requestTool; the tool registry turns it into an isError result. */
export class BridgeToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BridgeToolError'
  }
}

/** Dependencies the bridge needs from the host. */
export interface BridgeServerDeps {
  /** Bearer token the extension must present in `hello`. */
  token: string
  /** Active dsh Host adapter used for unary calls, events, and waterfalls. */
  api: BrowserHostApi
  /** Default per-tool-call timeout in ms. */
  toolTimeoutMs: number
  /** Capabilities to echo in `hello.ok` (negotiated snapshot budgets). */
  caps: BridgeCaps
  /** Seed a followed-page snapshot into a live or deferred Agent session. */
  injectBrowserSnapshot: (sessionId: string, snapshot: string) => void | Promise<void>
  /**
   * Permanently delete one session's durable storage. Callers archive the
   * session through the gateway first; this only removes files.
   */
  purgeSession: (sessionId: string) => Promise<void>
  /**
   * Test seam: force the remote address seen by the privilege gate. The
   * sandbox cannot bind arbitrary loopback literals, so the non-loopback
   * branch is exercised through this override; production never sets it.
   */
  remoteAddressOverride?: string
  /** Seconds a fresh socket may present `hello`; defaults to HELLO_TIMEOUT_MS. */
  helloTimeoutMs?: number
  /** Server ping cadence; defaults to PING_INTERVAL_MS. */
  pingIntervalMs?: number
  /** Test seam: the outbound budget of one connection; production uses the protocol constants. */
  sendLimits?: SendGateLimits
  /**
   * Test seam: build a connection's send gate. Production uses the default
   * gate; tests use it to exercise write-failure handling deterministically.
   */
  sendGateFactory?: (ws: WebSocket, onWriteFailed: (message: string) => void) => SendGate
}

/** One in-flight tool call awaiting the extension's `tool.result`. */
interface PendingTool {
  resolve: (result: unknown) => void
  reject: (error: BridgeToolError) => void
  timer: NodeJS.Timeout
}

/** A socket that passed authentication and owns the single active slot. */
interface ReadyConnection {
  ws: WebSocket
  /** Remote address captured at upgrade time (loopback gate for privileged methods). */
  remoteAddress: string | undefined
  abort: AbortController
  pump: Promise<void>
  ping: NodeJS.Timeout
  /** Bounded outbound writer shared by every frame sent on this connection. */
  sender: SendGate
}

/** Unbounded direct write used only for pre-auth refusals (no gate exists yet). */
function sendFrameDirect(ws: WebSocket, frame: ServerFrame): void {
  /* v8 ignore next -- teardown race: the socket can die between a check and this write */
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify(frame))
}

/** Socket surface the send gate needs; `ws` sockets satisfy it directly. */
export interface SendSocket {
  readonly readyState: number
  /** `ws` calls the callback with `null` on success and an `Error` on failure. */
  send(data: string, callback?: (error?: Error | null) => void): void
}

/** Outbound budget of one connection. Unset fields fall back to the protocol constants. */
export interface SendGateLimits {
  /** Pending socket writes before further frames queue. */
  maxInflight?: number
  /** Largest single JSON frame in UTF-8 bytes. */
  maxFrameBytes?: number
  /** Queued frames awaiting a write slot; one more than this is refused. */
  maxQueued?: number
}

/** Counters exposed for diagnostics, logging, and tests. */
export interface SendStats {
  sent: number
  inflight: number
  queued: number
  droppedOversize: number
  droppedOverflow: number
  failures: number
}

/** The tool-call id a refused frame names, if it is a `tool.call`. */
function refusedToolCallId(frame: ServerFrame): string | undefined {
  return frame.t === 'tool.call' ? frame.id : undefined
}

/** Queue depth allowed behind the in-flight writes. */
const MAX_QUEUED_SENDS = 64

/**
 * Bounded outbound writer for one authenticated connection.
 *
 * Writes run at most {@link MAX_INFLIGHT_SENDS} at a time; further frames wait
 * in a bounded FIFO, an oversized frame is refused before it reaches the
 * socket, and every refusal or write failure reports `send_failed` back to the
 * extension so the peer learns why an answer never arrived.
 */
export class SendGate {
  private inflight = 0
  private readonly queue: string[] = []
  private idleWaiters: Array<() => void> = []
  private readonly counters = { sent: 0, droppedOversize: 0, droppedOverflow: 0, failures: 0 }

  constructor(
    private readonly socket: SendSocket,
    private readonly limits: SendGateLimits = {},
    /**
     * Called once per failed socket write. The connection layer settles every
     * pending tool call here: the extension may never learn about a write that
     * failed, so waiting for its answer would hang until the per-call timeout.
     */
    private readonly onWriteFailed?: (message: string) => void,
  ) {}

  /**
   * Serialize and enqueue one frame.
   * @param frame - frame to write.
   * @returns false when the frame was refused (socket closed, too large, or queue full).
   */
  send(frame: ServerFrame): boolean {
    if (this.socket.readyState !== WebSocket.OPEN) return false
    const text = JSON.stringify(frame)
    const bytes = Buffer.byteLength(text, 'utf8')
    const maxFrameBytes = this.limits.maxFrameBytes ?? MAX_FRAME_BYTES
    if (bytes > maxFrameBytes) {
      this.counters.droppedOversize += 1
      this.notifySendFailed(
        `frame of ${bytes} bytes exceeds the ${maxFrameBytes} byte cap`,
        refusedToolCallId(frame),
      )
      return false
    }
    if (this.inflight >= (this.limits.maxInflight ?? MAX_INFLIGHT_SENDS)) {
      if (this.queue.length >= (this.limits.maxQueued ?? MAX_QUEUED_SENDS)) {
        this.counters.droppedOverflow += 1
        this.notifySendFailed('too many pending bridge writes; frame dropped', refusedToolCallId(frame))
        return false
      }
      this.queue.push(text)
      return true
    }
    this.transmit(text)
    return true
  }

  /** Snapshot of the counters plus current backlog. */
  stats(): SendStats {
    return { ...this.counters, inflight: this.inflight, queued: this.queue.length }
  }

  /** Resolve once every accepted frame has been written or failed. */
  whenIdle(): Promise<void> {
    if (this.inflight === 0 && this.queue.length === 0) return Promise.resolve()
    return new Promise<void>((resolve) => { this.idleWaiters.push(resolve) })
  }

  /** Drop queued frames (connection teardown) and release idle waiters. */
  dispose(): void {
    this.queue.length = 0
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  private transmit(text: string): void {
    this.inflight += 1
    this.counters.sent += 1
    try {
      this.socket.send(text, (error?: Error | null) => {
        this.inflight -= 1
        // ws reports success as `callback(null)`; only a non-null argument is
        // a failure, and its message is read defensively.
        if (error != null) {
          this.counters.failures += 1
          const message = `socket write failed: ${error instanceof Error ? error.message : String(error)}`
          this.notifySendFailed(message)
          this.onWriteFailed?.(message)
        }
        this.pump()
      })
    } catch (error: unknown) {
      this.inflight -= 1
      this.counters.failures += 1
      const message = `socket write failed: ${error instanceof Error ? error.message : String(error)}`
      this.notifySendFailed(message)
      this.onWriteFailed?.(message)
      this.pump()
    }
  }

  private pump(): void {
    const maxInflight = this.limits.maxInflight ?? MAX_INFLIGHT_SENDS
    while (this.inflight < maxInflight && this.queue.length > 0) {
      const next = this.queue.shift()
      if (next === undefined) break
      this.transmit(next)
    }
    if (this.inflight === 0 && this.queue.length === 0) {
      for (const resolve of this.idleWaiters.splice(0)) resolve()
    }
  }

  /**
   * Report a refused write without counting it against the concurrency budget.
   * @param message - why the frame was refused.
   * @param toolCallId - the refused `tool.call` id, so the extension settles
   *   exactly that call instead of aborting every in-flight tool.
   */
  private notifySendFailed(message: string, toolCallId?: string): void {
    if (this.socket.readyState !== WebSocket.OPEN) return
    const frame = {
      t: 'error',
      code: 'send_failed',
      message,
      ...(toolCallId === undefined ? {} : { id: toolCallId }),
    } satisfies ServerFrame
    try {
      this.socket.send(JSON.stringify(frame))
    } catch {
      /* the socket died while reporting the refusal; the connection teardown owns cleanup */
    }
  }
}

/**
 * Decode one ws message payload to text. Exported so all three delivery
 * shapes (fragmented buffer list, Buffer, ArrayBuffer) are unit-testable
 * directly — node ws only ever delivers Buffers in practice.
 * @param data - ws message payload.
 * @returns the decoded UTF-8 text.
 */
export function messageToText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Token-authenticated bridge server. Construct once per plugin instance;
 * dispose with {@link close}.
 */
export class BridgeServer {
  private readonly wss = new WebSocketServer({ noServer: true })
  private current: ReadyConnection | null = null
  private readonly pendingTools = new Map<string, PendingTool>()
  private readonly orderedSessionRpcs = new Map<string, Promise<void>>()
  private closed = false

  constructor(private readonly deps: BridgeServerDeps) {}

  /**
   * Handle one HTTP upgrade for the bridge path.
   * @param req - upgrade request (carries the client's remote address).
   * @param socket - raw socket transferred by the HTTP server.
   * @param head - bytes already read after the upgrade headers.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const remote = this.deps.remoteAddressOverride ?? req.socket.remoteAddress
    const origin = req.headers.origin
    this.wss.handleUpgrade(req, socket, head, (ws) => { this.attach(ws, remote, origin) })
  }

  /**
   * Request one browser action from the connected extension.
   * @param name - tool name (also the wire action name).
   * @param args - validated tool arguments.
   * @param signal - caller cancellation (abort settles the call as cancelled).
   * @param timeoutMs - per-call budget; defaults to the plugin config value.
   * @param sessionId - optional owning Agent session for approval continuity.
   * @returns the extension's action result.
   * @throws BridgeToolError when no extension is connected, the call times
   *   out, is cancelled, or the extension reports a failure.
   */
  requestTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs: number = this.deps.toolTimeoutMs,
    sessionId?: string,
  ): Promise<unknown> {
    const conn = this.current
    if (conn === null) {
      throw new BridgeToolError('bridge-closed', 'no browser extension is connected to the bridge')
    }
    // A caller that already aborted must not dispatch: the abort listener
    // below does not replay for pre-aborted signals, so the call would be
    // sent to the extension and executed despite the cancellation.
    if (signal.aborted) {
      throw new BridgeToolError('bridge-closed', 'tool call cancelled before dispatch')
    }
    const id = randomUUID()
    const expiresAt = Date.now() + timeoutMs
    return new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout
      const settle = (error: BridgeToolError): void => {
        clearTimeout(timer)
        this.pendingTools.delete(id)
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
      const cancel = (error: BridgeToolError): void => {
        // The extension may be paused on a user approval after the caller has
        // stopped waiting. Withdraw that approval before settling locally so
        // a late click cannot execute an expired action.
        conn.sender.send({ t: 'tool.cancel', id })
        settle(error)
      }
      const onAbort = (): void => {
        cancel(new BridgeToolError('bridge-closed', 'tool call cancelled before the extension answered'))
      }
      timer = setTimeout(() => {
        cancel(new BridgeToolError('timeout', `browser action "${name}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      this.pendingTools.set(id, { resolve, reject, timer })
      // The largest outbound frame goes through the same gate as every other
      // frame: an oversized or over-budget tool.call is reported as
      // send_failed instead of being written unthrottled.
      const accepted = conn.sender.send({
        t: 'tool.call',
        id,
        name,
        args,
        expiresAt,
        ...(sessionId === undefined ? {} : { sessionId }),
      })
      if (!accepted) {
        settle(new BridgeToolError('send_failed', `browser action "${name}" could not be delivered to the extension`))
      }
    })
  }

  /**
   * Terminate the server: close the acceptor, drop all sockets, reject all
   * in-flight tool calls.
   * @returns a promise resolving after the acceptor and all pumps stop.
   */
  async close(): Promise<void> {
    // Idempotent: a second close must not touch the acceptor (ws throws
    // "The server is not running" when closing an already-closed server).
    if (this.closed) return
    this.closed = true
    // Capture the live pump BEFORE replaceConnection nulls the connection.
    const pumps = this.current === null ? [] : [this.current.pump]
    this.replaceConnection()
    for (const socket of this.wss.clients) socket.terminate()
    this.current = null
    await new Promise<void>((resolve, reject) => {
      this.wss.close((error) => {
        /* v8 ignore next -- acceptor close cannot fail: close() is idempotent
        and the noServer acceptor only reports teardown of already-terminated clients */
        if (error === undefined) resolve()
        /* v8 ignore next -- same unreachable arm */
        else reject(error)
      })
    })
    await Promise.all(pumps)
  }

  /** @returns whether an authenticated extension is currently connected. */
  hasConnection(): boolean {
    return this.current !== null
  }

  private attach(ws: WebSocket, remoteAddress: string | undefined, origin: string | undefined): void {
    let helloTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      ws.close(4001, 'hello timeout')
    }, this.deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS)
    /** One `bad-request` notice per connection; later malformed frames are ignored. */
    let badFrameNoticeSent = false

    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]): void => {
      const text = messageToText(data)
      // Symmetry with the outbound gate: an oversized inbound frame is refused
      // before parsing, without dropping the connection.
      const bytes = Buffer.byteLength(text, 'utf8')
      if (bytes > MAX_FRAME_BYTES) {
        if (!badFrameNoticeSent) {
          badFrameNoticeSent = true
          sendFrameDirect(ws, {
            t: 'error',
            code: 'bad-request',
            message: `frame of ${bytes} bytes exceeds the ${MAX_FRAME_BYTES} byte cap`,
          })
        }
        return
      }
      const frame = parseBridgeFrame(text)
      if (frame === undefined) {
        // Unknown or malformed frames are a peer-versioning event, not a
        // transport fault: answer once, keep the socket usable, and ignore
        // further malformed frames so a broken peer cannot flood the channel.
        if (!badFrameNoticeSent) {
          badFrameNoticeSent = true
          sendFrameDirect(ws, { t: 'error', code: 'bad-request', message: 'frame is not a valid bridge frame' })
        }
        return
      }
      if (helloTimer !== undefined) {
        // Pending state: only `hello` is legal.
        if (frame.t !== 'hello') {
          ws.close(1008, 'hello first')
          return
        }
        // Zero-config local mode: loopback sockets skip the token (the
        // extension auto-discovers the bridge and connects without setup).
        // WebSockets have no same-origin policy, so a malicious page could
        // open a cross-origin socket to 127.0.0.1 with a loopback remote —
        // the loopback shortcut therefore requires a chrome-extension://
        // Origin (only extension contexts can present one; pages cannot
        // forge the header). Firefox moz-extension:// origins contain a
        // per-install UUID rather than the manifest's stable Gecko ID, so
        // they are not an identity boundary and must present the bearer token.
        // Non-loopback remotes must also present the bearer token.
        const loopbackNoToken = isLoopbackAddress(remoteAddress)
          && typeof origin === 'string'
          && origin.startsWith('chrome-extension://')
        if (!loopbackNoToken && !verifyToken(this.deps.token, frame.token)) {
          ws.close(4002, 'bad token')
          return
        }
        clearTimeout(helloTimer)
        helloTimer = undefined
        this.promote(ws, remoteAddress)
        return
      }
      this.handleReadyFrame(frame)
    }
    const onClose = (): void => {
      if (helloTimer !== undefined) clearTimeout(helloTimer)
      if (this.current !== null && this.current.ws === ws) this.replaceConnection()
    }
    ws.on('message', onMessage)
    ws.once('close', onClose)
    ws.once('error', onClose)
  }

  /** Promote an authenticated socket to the single active slot. */
  private promote(ws: WebSocket, remoteAddress: string | undefined): void {
    this.replaceConnection()
    const abort = new AbortController()
    const onWriteFailed = (message: string): void => {
      this.failPendingTools('send_failed', `bridge could not deliver a tool call: ${message}`)
    }
    const sender = this.deps.sendGateFactory?.(ws, onWriteFailed)
      ?? new SendGate(ws, this.deps.sendLimits, onWriteFailed)
    const ping = setInterval(() => { sender.send({ t: 'ping' }) }, this.deps.pingIntervalMs ?? PING_INTERVAL_MS)
    const pump = (async () => {
      try {
        for await (const frame of this.deps.api.events(abort.signal)) {
          if (ws.readyState !== WebSocket.OPEN) break
          sender.send({
            t: 'event',
            frame,
          })
        }
      } catch (error: unknown) {
        if (!abort.signal.aborted && ws.readyState === WebSocket.OPEN) {
          sender.send({ t: 'error', code: 'stream-failed', message: String(error) })
          // An authenticated socket without its Remote streams is unusable but
          // otherwise appears healthy to the extension. Closing the generation
          // activates its bounded reconnect loop and rebuilds every follower.
          ws.close(1011, 'event stream failed')
        }
      }
    })()
    this.current = { ws, remoteAddress, abort, pump, ping, sender }
    sender.send({ t: 'hello.ok', caps: this.deps.caps })
    ws.once('close', () => {
      clearInterval(ping)
      abort.abort()
    })
  }

  private handleReadyFrame(frame: BridgeFrame): void {
    switch (frame.t) {
      case 'rpc':
        this.routeRpc(frame)
        break
      case 'respond':
        void this.handleRespond(frame)
        break
      case 'tool.result':
        this.settleTool(frame.id, frame.ok, frame.ok ? frame.result : frame.error)
        break
      case 'pong':
      case 'hello':
      case 'hello.ok':
      case 'rpc.result':
      case 'respond.result':
      case 'event':
      case 'tool.call':
      case 'tool.cancel':
      case 'ping':
      case 'error':
        // Protocol violations and unsolicited server-side shapes are ignored;
        // the extension is the only sender on this channel.
        break
    }
  }

  /**
   * Preserve prompt/cancel arrival order per session. In particular, the
   * first prompt may still be materializing a provisional session; its cancel
   * must not reach the gateway until that admission has completed.
   */
  private routeRpc(frame: Extract<ClientFrame, { t: 'rpc' }>): void {
    const sessionId = orderedSessionId(frame)
    if (sessionId === undefined) {
      void this.handleRpc(frame)
      return
    }
    const previous = this.orderedSessionRpcs.get(sessionId) ?? Promise.resolve()
    const task = previous.then(
      () => this.handleRpc(frame),
      () => this.handleRpc(frame),
    )
    this.orderedSessionRpcs.set(sessionId, task)
    const clear = (): void => {
      if (this.orderedSessionRpcs.get(sessionId) === task) this.orderedSessionRpcs.delete(sessionId)
    }
    void task.then(clear, clear)
  }

  private async handleRpc(frame: Extract<ClientFrame, { t: 'rpc' }>): Promise<void> {
    const conn = this.current
    /* v8 ignore next -- replacement race: a frame can land between a socket
    replacement and the next promotion; the re-check keeps the handler total */
    if (conn === null) return
    const forbidden = PRIVILEGED_METHODS.has(frame.method) && !isLoopbackAddress(conn.remoteAddress)
    if (forbidden) {
      conn.sender.send({ t: 'rpc.result', id: frame.id, ok: false, error: { code: 'forbidden', message: 'method is loopback-only' } })
      return
    }
    if (frame.method === BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD) {
      const payload = browserSnapshotPayload(frame.payload)
      if (payload === undefined) {
        conn.sender.send({
          t: 'rpc.result',
          id: frame.id,
          ok: false,
          error: { code: 'bad-request', message: 'sessionId and snapshot must be non-empty strings' },
        })
        return
      }
      try {
        await this.deps.injectBrowserSnapshot(payload.sessionId, payload.snapshot)
        conn.sender.send({ t: 'rpc.result', id: frame.id, ok: true, result: { accepted: true } })
      } catch (error: unknown) {
        conn.sender.send({
          t: 'rpc.result',
          id: frame.id,
          ok: false,
          error: { code: 'internal', message: String(error) },
        })
      }
      return
    }
    if (frame.method === BRIDGE_SESSION_PURGE_METHOD) {
      const sessionId = purgeSessionPayload(frame.payload)
      if (sessionId === undefined) {
        conn.sender.send({
          t: 'rpc.result',
          id: frame.id,
          ok: false,
          error: { code: 'bad-request', message: 'sessionId must be a non-empty string' },
        })
        return
      }
      try {
        await this.deps.purgeSession(sessionId)
        conn.sender.send({ t: 'rpc.result', id: frame.id, ok: true, result: { purged: true } })
      } catch (error: unknown) {
        const code = error instanceof SessionPurgeError ? error.code : 'internal'
        const message = error instanceof Error ? error.message : String(error)
        conn.sender.send({ t: 'rpc.result', id: frame.id, ok: false, error: { code, message } })
      }
      return
    }
    try {
      const result = await this.deps.api.call({
        rpcId: frame.id,
        method: frame.method,
        payload: frame.payload,
        signal: conn.abort.signal,
      })
      conn.sender.send({
        t: 'rpc.result',
        id: frame.id,
        ok: true,
        result: { type: 'server-response', rpcId: frame.id, result },
      })
    } catch (error: unknown) {
      conn.sender.send({ t: 'rpc.result', id: frame.id, ok: false, error: { code: 'internal', message: String(error) } })
    }
  }

  /** Relay a pending Host waterfall response through the active adapter. */
  private async handleRespond(frame: Extract<ClientFrame, { t: 'respond' }>): Promise<void> {
    const conn = this.current
    /* v8 ignore next -- replacement race; a closed socket simply drops the receipt */
    if (conn === null) return
    try {
      const result = await this.deps.api.respond(frame.rpcId, frame.result, conn.abort.signal)
      conn.sender.send({ t: 'respond.result', id: frame.id, ok: true, result })
    } catch (error: unknown) {
      conn.sender.send({ t: 'respond.result', id: frame.id, ok: false, error: { code: 'internal', message: String(error) } })
    }
  }

  /**
   * Settle every pending tool call with one transport failure.
   * @param code - wire error code recorded on each call.
   * @param message - human-readable explanation for the model.
   */
  private failPendingTools(code: ToolErrorCode, message: string): void {
    for (const [id, pending] of [...this.pendingTools]) {
      clearTimeout(pending.timer)
      this.pendingTools.delete(id)
      pending.reject(new BridgeToolError(code, message))
    }
  }

  private settleTool(id: string, ok: boolean, payload: unknown): void {
    const pending = this.pendingTools.get(id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pendingTools.delete(id)
    if (ok) pending.resolve(payload)
    else pending.reject(new BridgeToolError(payloadCode(payload), payloadMessage(payload)))
  }

  /** Close the current connection (if any) and settle its in-flight calls. */
  private replaceConnection(): void {
    const conn = this.current
    if (conn === null) return
    this.current = null
    clearInterval(conn.ping)
    conn.abort.abort()
    conn.sender.dispose()
    if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
      conn.ws.close(4000, 'replaced')
    }
    for (const [id, pending] of this.pendingTools) {
      clearTimeout(pending.timer)
      this.pendingTools.delete(id)
      pending.reject(new BridgeToolError('bridge-closed', 'the extension connection was replaced'))
    }
  }
}

function browserSnapshotPayload(payload: unknown): { sessionId: string; snapshot: string } | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const { sessionId, snapshot } = payload as Record<string, unknown>
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return undefined
  if (typeof snapshot !== 'string' || snapshot.trim() === '') return undefined
  return { sessionId, snapshot }
}

function purgeSessionPayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const { sessionId } = payload as Record<string, unknown>
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return undefined
  return sessionId
}

function orderedSessionId(frame: Extract<ClientFrame, { t: 'rpc' }>): string | undefined {
  if (!ORDERED_SESSION_METHODS.has(frame.method)) return undefined
  if (typeof frame.payload !== 'object' || frame.payload === null || Array.isArray(frame.payload)) return undefined
  const sessionId = (frame.payload as Record<string, unknown>).sessionId
  return typeof sessionId === 'string' ? sessionId : undefined
}

/**
 * Tool error payload → stable code. The wire parser enforces string fields,
 * so the fallback branches are parser-gated; exported so the fallback
 * contract is unit-testable directly.
 * @param payload - extension-reported error payload.
 * @returns the stable error code.
 */
export function payloadCode(payload: unknown): ToolErrorCode {
  if (typeof payload === 'object' && payload !== null) {
    const code = (payload as { code?: unknown }).code
    if (typeof code === 'string') return code as ToolErrorCode
    return 'internal'
  }
  return 'internal'
}

/**
 * Tool error payload → message. The wire parser enforces string fields, so
 * the fallback branches are parser-gated; exported so the fallback contract
 * is unit-testable directly.
 * @param payload - extension-reported error payload.
 * @returns the human-readable message.
 */
export function payloadMessage(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const message = (payload as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
    return 'browser action failed'
  }
  return 'browser action failed'
}

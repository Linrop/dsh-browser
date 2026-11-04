/**
 * Backward compatibility with the shipped 0.1.4 extension.
 *
 * Provenance and limits: the fixtures are derived from the **0.1.4
 * `src/protocol.ts` type definitions** recovered from the 2026-11-04 backup
 * tarball. They are shape-derived, not frames recorded from a running 0.1.4
 * bundle, so this suite proves the wire *contract* (field names, required vs
 * optional fields, parser acceptance, server paths) and cannot prove how a
 * real 0.1.4 build populated those fields in practice. Stronger evidence would
 * require keeping a recorded 0.1.4 frame capture; if one exists, add it here
 * and drive the same assertions from it.
 *
 * What it does check: every frame an old peer sends parses to exactly the same
 * object, every frame this Host sends uses only fields the old parser knows,
 * the old `tool.result` / `respond` paths still drive the live server, and
 * codes added after 0.1.4 stay unknown-but-opaque as the old open-set comment
 * promised.
 */

import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { BridgeServer, BridgeToolError, payloadCode } from '../src/server.ts'
import { parseBridgeFrame, type BridgeFrame } from '../src/protocol.ts'

interface CompatFixture {
  version: string
  caps: { textOnly: true; snapshotMaxChars: number; maxInteractiveItems: number }
  clientFrames: BridgeFrame[]
  hostFrames: BridgeFrame[]
  legacyToolErrorCodes: string[]
  addedToolErrorCodes: string[]
}

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/compat-0.1.4.json', import.meta.url), 'utf8'),
) as CompatFixture

const TOKEN = 'compat-0-1-4-token'
const servers: Array<{ bridge: BridgeServer; server: Server }> = []

afterEach(async () => {
  for (const entry of servers.splice(0)) {
    await entry.bridge.close()
    await new Promise<void>((resolve) => { entry.server.close(() => resolve()) })
  }
})

async function startBridge(): Promise<{ bridge: BridgeServer; url: string }> {
  const bridge = new BridgeServer({
    token: TOKEN,
    api: {
      call: async () => ({ ok: true, value: { sessions: [] } }),
      respond: async () => ({ accepted: true }),
      async *events() { /* the 0.1.4 client ignores events until it asks for a session */ },
    },
    toolTimeoutMs: 1_000,
    caps: FIXTURE.caps,
    injectBrowserSnapshot: async () => {},
    purgeSession: async () => {},
  })
  const server = createServer()
  server.on('upgrade', (req, socket, head) => { bridge.handleUpgrade(req, socket, head) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  servers.push({ bridge, server })
  const port = (server.address() as AddressInfo).port
  return { bridge, url: `ws://127.0.0.1:${port}/ext/bridge` }
}

interface Cabinet {
  ws: WebSocket
  frames: BridgeFrame[]
  done: Promise<void>
}

function connect(url: string): Promise<Cabinet> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const frames: BridgeFrame[] = []
    ws.on('message', (data) => { frames.push(JSON.parse(data.toString()) as BridgeFrame) })
    const done = new Promise<void>((doneResolve) => { ws.on('close', () => doneResolve()) })
    ws.on('open', () => resolve({ ws, frames, done }))
    ws.on('error', reject)
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not reached within the timeout')
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
}

/** Handshake as the 0.1.4 extension does, then return the live cabinet. */
async function connectV014(url: string): Promise<Cabinet> {
  const cabinet = await connect(url)
  cabinet.ws.send(JSON.stringify({ t: 'hello', token: TOKEN, caps: FIXTURE.caps }))
  await waitFor(() => cabinet.frames.some((frame) => frame.t === 'hello.ok'))
  return cabinet
}

describe('0.1.4 wire compatibility', () => {
  it('parses every captured 0.1.4 client frame to the identical object', () => {
    for (const frame of FIXTURE.clientFrames) {
      expect(parseBridgeFrame(JSON.stringify(frame))).toEqual(frame)
    }
  })

  it('parses every captured 0.1.4 host frame to the identical object', () => {
    for (const frame of FIXTURE.hostFrames) {
      expect(parseBridgeFrame(JSON.stringify(frame))).toEqual(frame)
    }
  })

  it('keeps the negotiated caps byte-identical', () => {
    const hello = parseBridgeFrame(JSON.stringify({ t: 'hello', token: TOKEN, caps: FIXTURE.caps }))
    expect(hello).toEqual({ t: 'hello', token: TOKEN, caps: FIXTURE.caps })
    const helloOk = parseBridgeFrame(JSON.stringify({ t: 'hello.ok', caps: FIXTURE.caps }))
    expect(helloOk).toEqual({ t: 'hello.ok', caps: FIXTURE.caps })
  })

  it('treats every post-0.1.4 code as an opaque code on the host side', () => {
    for (const code of [...FIXTURE.legacyToolErrorCodes, ...FIXTURE.addedToolErrorCodes]) {
      expect(payloadCode({ code, message: 'm' })).toBe(code)
    }
  })
})

describe('0.1.4 end-to-end paths on the live server', () => {
  it('serves the old handshake and rpc round-trip without extra required fields', async () => {
    const { url } = await startBridge()
    const { ws, frames, done } = await connectV014(url)

    const helloOk = frames.find((frame) => frame.t === 'hello.ok')
    expect(helloOk).toEqual({ t: 'hello.ok', caps: FIXTURE.caps })
    const fixtureHello = FIXTURE.hostFrames.find((frame) => frame.t === 'hello.ok')
    expect(new Set(Object.keys(helloOk ?? {}))).toEqual(new Set(Object.keys(fixtureHello ?? {})))

    ws.send(JSON.stringify({ t: 'rpc', id: 'r1', method: 'session.list', payload: {} }))
    await waitFor(() => frames.some((frame) => frame.t === 'rpc.result'))
    const result = frames.find((frame) => frame.t === 'rpc.result')
    expect(result).toMatchObject({
      t: 'rpc.result',
      id: 'r1',
      ok: true,
      result: { type: 'server-response', rpcId: 'r1' },
    })

    ws.close()
    await done
  })

  it('settles a pending tool call from the old tool.result shape', async () => {
    const { bridge, url } = await startBridge()
    const { ws, frames, done } = await connectV014(url)

    const pending = bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 2_000)
    // Observe the rejection immediately so a fast failure never surfaces as an
    // unhandled rejection while the assertion is still setting up.
    const settled = pending.catch((error: unknown) => error)
    await waitFor(() => frames.some((frame) => frame.t === 'tool.call'))
    const call = frames.find((frame) => frame.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>

    // The 0.1.4 shape: no extra fields, an old code and a plain message.
    ws.send(JSON.stringify({
      t: 'tool.result',
      id: call.id,
      ok: false,
      error: { code: 'action-failed', message: 'boom' },
    }))

    const error = await settled
    expect(error).toBeInstanceOf(BridgeToolError)
    expect(error).toMatchObject({ code: 'action-failed', message: 'boom' })

    ws.close()
    await done
  })

  it('relays an old respond frame through the host waterfall', async () => {
    const { url } = await startBridge()
    const { ws, frames, done } = await connectV014(url)

    const frame = FIXTURE.clientFrames.find((entry) => entry.t === 'respond')
    ws.send(JSON.stringify(frame))
    await waitFor(() => frames.some((entry) => entry.t === 'respond.result'))
    expect(frames.find((entry) => entry.t === 'respond.result'))
      .toMatchObject({ t: 'respond.result', id: 'q1', ok: true, result: { accepted: true } })

    ws.close()
    await done
  })

  it('answers an unknown frame with one bad-request and keeps the connection usable', async () => {
    const { url } = await startBridge()
    const { ws, frames, done } = await connectV014(url)

    ws.send(JSON.stringify({ t: 'frame-from-a-newer-extension', id: 'x' }))
    await waitFor(() => frames.some((frame) => frame.t === 'error'))
    expect(frames.filter((frame) => frame.t === 'error')).toHaveLength(1)

    // The socket survived: a normal rpc still works afterwards.
    ws.send(JSON.stringify({ t: 'rpc', id: 'r2', method: 'session.list', payload: {} }))
    await waitFor(() => frames.some((frame) => frame.t === 'rpc.result'))
    expect(frames.find((frame) => frame.t === 'rpc.result')).toMatchObject({ t: 'rpc.result', id: 'r2', ok: true })

    ws.close()
    await done
  })
})

/**
 * Offscreen document: MV3 keepalive plus the recording encoder.
 *
 * MV3 stops an idle service worker after roughly 30 s without events. A side
 * panel port keeps the worker alive only while the panel is open; approvals
 * and bridge reconnects can outlive that lease. This document therefore
 * messages the service worker on a fixed cadence, which is enough to reset the
 * worker's idle timer without touching any page.
 *
 * The same document owns GIF encoding for recordings, because a service
 * worker cannot hold an <img>/canvas decode pipeline and a Worker may not be
 * created from it. Frames arrive as base64 PNG captures, the worker quantizes
 * and encodes them off the main thread, and the service worker is told the
 * resulting file name. The blob URL is revoked once the download settles, so a
 * recording never leaves a live object URL behind.
 *
 * The document is created by the background entry (`chrome.offscreen`) and is
 * absent on Firefox, where the half-minute `alarms` entry remains the only
 * keepalive and recordings report that export is unavailable.
 *
 * @module
 */

/** Message type the background entry answers. */
export const SW_KEEPALIVE_MESSAGE = 'SW_KEEPALIVE' as const

/** Cadence: well inside the worker's ~30 s idle window. */
export const SW_KEEPALIVE_INTERVAL_MS = 20_000

import { OFFSCREEN_GIF_MESSAGE, OFFSCREEN_GIF_SWEPT_MESSAGE } from '../content/recorder.ts'

export { OFFSCREEN_GIF_MESSAGE, OFFSCREEN_GIF_SWEPT_MESSAGE }

/** How long a finished download keeps its blob URL before the fallback revoke. */
const BLOB_URL_GRACE_MS = 120_000

/** One captured frame as the background sends it. */
export interface OffscreenGifFrame {
  /** PNG bytes as base64, no data URL prefix. */
  base64: string
  /** Display duration in milliseconds. */
  delayMs: number
}

/** Result of one encode+download request. */
export interface OffscreenGifResult {
  ok: boolean
  /** Downloaded file name; present when the download started. */
  filename?: string
  /** Human-readable failure reason. */
  error?: string
}

/** Send one keepalive; failures are expected while the worker is starting. */
export function sendSwKeepAlive(): void {
  void chrome.runtime.sendMessage({ type: SW_KEEPALIVE_MESSAGE }).catch(() => {
    /* The worker may be mid-restart; the next tick retries. */
  })
}

/** Background → offscreen: stop the heartbeat before the document closes. */
export const SW_KEEPALIVE_STOP_MESSAGE = 'SW_KEEPALIVE_STOP' as const

/** Disposer of the running heartbeat loop; replaced by each start. */
let stopSwKeepAlive: () => void = () => {}

/**
 * Start the keepalive loop (one immediate tick, then the fixed cadence).
 *
 * The loop never outlives the document: the background creates this document
 * only while a panel, a recording, an in-flight tool call, or a live connection
 * holds the lease, and closes it (or sends {@link SW_KEEPALIVE_STOP_MESSAGE})
 * when that lease ends.
 *
 * @param intervalMs - override for tests; production uses {@link SW_KEEPALIVE_INTERVAL_MS}.
 * @returns a disposer that stops the loop.
 */
export function startSwKeepAlive(intervalMs: number = SW_KEEPALIVE_INTERVAL_MS): () => void {
  stopSwKeepAlive()
  sendSwKeepAlive()
  const timer = setInterval(sendSwKeepAlive, intervalMs)
  stopSwKeepAlive = () => { clearInterval(timer); stopSwKeepAlive = () => {} }
  return stopSwKeepAlive
}

/** One in-flight worker request. */
interface PendingEncode {
  resolve: (bytes: Uint8Array) => void
  reject: (error: Error) => void
}

let worker: Worker | null = null
let nextRequestId = 1
const pendingEncodes = new Map<number, PendingEncode>()

/** Lazily create the encoder worker; a failure surfaces on the first export. */
function ensureWorker(): Worker {
  if (worker !== null) return worker
  const created = new Worker(new URL('./gif-worker.ts', import.meta.url), { type: 'module' })
  created.addEventListener('message', (event: MessageEvent) => {
    const reply = event.data as { id?: unknown; ok?: unknown; bytes?: unknown; error?: unknown }
    if (typeof reply?.id !== 'number') return
    const entry = pendingEncodes.get(reply.id)
    if (entry === undefined) return
    pendingEncodes.delete(reply.id)
    if (reply.ok === true && reply.bytes instanceof ArrayBuffer) {
      entry.resolve(new Uint8Array(reply.bytes))
    } else {
      entry.reject(new Error(typeof reply.error === 'string' ? reply.error : 'GIF encoding failed'))
    }
  })
  created.addEventListener('error', () => {
    for (const entry of pendingEncodes.values()) entry.reject(new Error('The GIF encoder worker stopped'))
    pendingEncodes.clear()
    worker = null
  })
  worker = created
  return created
}

/**
 * Encode frames into GIF bytes in the worker.
 * @param frames - captured frames in playback order.
 * @returns the encoded GIF bytes.
 */
export function encodeRecording(frames: readonly OffscreenGifFrame[]): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const id = nextRequestId
    nextRequestId += 1
    pendingEncodes.set(id, { resolve, reject })
    try {
      ensureWorker().postMessage({ id, frames })
    } catch (cause) {
      pendingEncodes.delete(id)
      reject(cause instanceof Error ? cause : new Error(String(cause)))
    }
  })
}

/** File name for one export: ISO timestamp with filesystem-unsafe characters removed. */
export function recordingFilename(at: Date): string {
  return `dsh-recording-${at.toISOString().replace(/[:.]/g, '-')}.gif`
}

/** Start the download and resolve once Chrome accepted it. */
async function startDownload(bytes: Uint8Array, filename: string): Promise<void> {
  const buffer = bytes.buffer
  const body: ArrayBuffer = buffer instanceof ArrayBuffer
    ? buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    : new Uint8Array(bytes).buffer as ArrayBuffer
  const url = URL.createObjectURL(new Blob([body], { type: 'image/gif' }))
  let settled = false
  const revoke = (): void => {
    if (settled) return
    settled = true
    URL.revokeObjectURL(url)
    void chrome.runtime.sendMessage({ type: OFFSCREEN_GIF_SWEPT_MESSAGE, filename }).catch(() => {
      /* The worker may be gone; the counter is diagnostics only. */
    })
  }
  const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
    if (delta.id !== downloadId) return
    if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') revoke()
  }
  let downloadId: number
  try {
    downloadId = await new Promise<number>((resolve, reject) => {
      chrome.downloads.download({ url, filename, saveAs: false }, (id) => {
        const failure = chrome.runtime.lastError
        if (failure !== undefined) reject(new Error(failure.message ?? 'The download could not start'))
        else resolve(id)
      })
    })
  } catch (cause) {
    revoke()
    throw cause
  }
  chrome.downloads.onChanged.addListener(onChanged)
  // A download that never reports a state (browser closed mid-write, listener
  // lost with the document) must not pin the blob forever.
  setTimeout(() => {
    chrome.downloads.onChanged.removeListener(onChanged)
    revoke()
  }, BLOB_URL_GRACE_MS)
}

/**
 * Encode one recording and download it as a GIF.
 * @param frames - captured frames in playback order.
 * @returns the download outcome; failures are returned, not thrown.
 */
export async function exportRecording(frames: readonly OffscreenGifFrame[]): Promise<OffscreenGifResult> {
  if (frames.length === 0) return { ok: false, error: 'No frames were captured' }
  try {
    const bytes = await encodeRecording(frames)
    const filename = recordingFilename(new Date())
    await startDownload(bytes, filename)
    return { ok: true, filename }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== 'object' || message === null) return
  // The background releases the lease explicitly before closing the document;
  // stopping first keeps a final tick from racing the teardown.
  if ((message as { type?: unknown }).type === SW_KEEPALIVE_STOP_MESSAGE) {
    stopSwKeepAlive()
    sendResponse({ ok: true })
    return
  }
  if ((message as { type?: unknown }).type !== OFFSCREEN_GIF_MESSAGE) return
  const frames = (message as { frames?: unknown }).frames
  if (!Array.isArray(frames)) {
    sendResponse({ ok: false, error: 'No frames were captured' } satisfies OffscreenGifResult)
    return
  }
  const parsed: OffscreenGifFrame[] = []
  for (const frame of frames) {
    const value = frame as { base64?: unknown; delayMs?: unknown }
    if (typeof value.base64 !== 'string') continue
    parsed.push({ base64: value.base64, delayMs: typeof value.delayMs === 'number' ? value.delayMs : 0 })
  }
  void exportRecording(parsed).then(sendResponse)
  return true
})

startSwKeepAlive()

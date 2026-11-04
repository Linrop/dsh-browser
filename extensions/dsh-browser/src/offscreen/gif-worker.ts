/**
 * GIF encoder worker: decode captured PNG frames, quantize them to the shared
 * palette, and return one animated GIF.
 *
 * Encoding runs here so a long recording cannot stall the offscreen document
 * (and, through it, the keepalive cadence). The worker owns no state between
 * requests: every message decodes, quantizes, encodes, and replies.
 *
 * @module
 */

import { encodeGif, quantizeFrame, type GifFrameInput } from './gif-encoder.ts'

/** One captured frame as it arrives from the offscreen document. */
export interface WorkerGifFrame {
  /** PNG bytes as base64, no data URL prefix. */
  base64: string
  /** Display duration in milliseconds. */
  delayMs: number
}

/** Request handled by the worker. */
export interface WorkerGifRequest {
  id: number
  frames: readonly WorkerGifFrame[]
}

/** Reply for one request; `bytes` is transferred, never copied. */
export interface WorkerGifResponse {
  id: number
  ok: boolean
  bytes?: ArrayBuffer
  error?: string
}

/** Decode one base64 PNG into RGBA pixels. */
async function decodeFrame(base64: string): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  const binary = atob(base64)
  const png = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) png[index] = binary.charCodeAt(index)
  const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }))
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) throw new Error('This browser cannot decode recorded frames')
    context.drawImage(bitmap, 0, 0)
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height)
    return { rgba: image.data, width: bitmap.width, height: bitmap.height }
  } finally {
    bitmap.close()
  }
}

/**
 * Encode a whole recording.
 * @param frames - captured PNG frames in playback order.
 * @returns the GIF bytes.
 */
export async function encodeRecordingFrames(frames: readonly WorkerGifFrame[]): Promise<Uint8Array> {
  const encoded: GifFrameInput[] = []
  for (const frame of frames) {
    const decoded = await decodeFrame(frame.base64)
    encoded.push({
      indices: quantizeFrame(decoded.rgba, decoded.width, decoded.height),
      width: decoded.width,
      height: decoded.height,
      delayMs: frame.delayMs,
    })
  }
  return encodeGif(encoded)
}

const workerScope = self as typeof self & {
  postMessage(message: unknown, transfer?: Transferable[]): void
}

workerScope.onmessage = (event: MessageEvent) => {
  const request = event.data as Partial<WorkerGifRequest> | null
  if (request === null || typeof request.id !== 'number' || !Array.isArray(request.frames)) return
  const id = request.id
  void encodeRecordingFrames(request.frames).then(
    (bytes) => {
      const response: WorkerGifResponse = { id, ok: true, bytes: bytes.buffer as ArrayBuffer }
      workerScope.postMessage(response, [bytes.buffer as ArrayBuffer])
    },
    (cause: unknown) => {
      const response: WorkerGifResponse = {
        id,
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }
      workerScope.postMessage(response)
    },
  )
}

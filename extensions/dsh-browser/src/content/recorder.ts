/**
 * In-memory frame capture for recording a browser interaction as a GIF.
 *
 * A recording is bounded on three independent axes so a forgotten recording
 * cannot grow without limit inside the service worker: frame count, total
 * base64 bytes, and age. When a limit is crossed the oldest frames are
 * dropped and counted, which the panel surfaces as "dropped" so the user can
 * tell a truncated recording from a complete one.
 *
 * Frames carry no pixels until they reach the offscreen encoder: the content
 * side stores the same base64 payload Chrome's tab capture returns, plus the
 * viewport metrics needed to describe the frame in the status UI.
 *
 * @module
 */

/** Background → offscreen: encode and download one recording. */
export const OFFSCREEN_GIF_MESSAGE = 'DSH_OFFSCREEN_GIF' as const

/** Offscreen → background: the downloaded blob URL was released. */
export const OFFSCREEN_GIF_SWEPT_MESSAGE = 'DSH_OFFSCREEN_GIF_SWEPT' as const

/** One captured frame, in the order it was recorded. */
export interface RecordingFrame {
  /** `data:image/png;base64,…` payload with the data URL prefix stripped. */
  base64: string
  /** What produced the frame: a tool action name or `timer`. */
  action: string
  /** Milliseconds this frame stays on screen (time since the previous one). */
  delay: number
  viewportWidth: number
  viewportHeight: number
  devicePixelRatio: number
}

/** A frame before its display duration is known. */
export type RecordingFrameInput = Omit<RecordingFrame, 'delay'> & { delay?: number }

/** Retention limits for one recording. */
export interface RecordingLimits {
  /** Newest frames kept; older ones are dropped first. */
  maxFrames: number
  /** Total base64 payload bytes kept across frames. */
  maxBytes: number
  /** Age after which a frame is no longer eligible for export. */
  ttlMs: number
}

/** Defaults sized for a short demo clip: at 1 fps this is two minutes. */
export const DEFAULT_RECORDING_LIMITS: RecordingLimits = {
  maxFrames: 120,
  maxBytes: 32 * 1024 * 1024,
  ttlMs: 300_000,
}

/** What one `push` had to discard to stay inside the limits. */
export interface RecordingPushResult {
  dropped: number
  expired: number
}

/** Live recording totals for the panel. */
export interface RecordingStats {
  frames: number
  bytes: number
  dropped: number
  expired: number
}

/** Panel-facing recording state. */
export interface RecordingStatus extends RecordingStats {
  active: boolean
  /** True while the offscreen document is encoding and downloading. */
  exporting?: boolean
  /** Set when an export finished and the frames were released. */
  clearedAt?: number
  /** File name of the last completed export. */
  filename?: string
}

interface StoredFrame {
  frame: RecordingFrame
  bytes: number
  at: number
}

/** ASCII byte count of a base64 payload; the string length is its byte count. */
export function base64ByteLength(base64: string): number {
  return base64.length
}

/**
 * Bounded FIFO of captured frames.
 *
 * The clock is injectable so age limits are testable without waiting.
 */
export class RecordingBuffer {
  private readonly limits: RecordingLimits
  private readonly now: () => number
  private readonly entries: StoredFrame[] = []
  private byteLength = 0
  private droppedCount = 0
  private expiredCount = 0
  private lastCapturedAt: number | undefined

  constructor(limits: Partial<RecordingLimits> = {}, now: () => number = () => Date.now()) {
    this.limits = { ...DEFAULT_RECORDING_LIMITS, ...limits }
    this.now = now
  }

  /** Frames currently retained, oldest first. */
  frames(): RecordingFrame[] {
    return this.entries.map((entry) => ({ ...entry.frame }))
  }

  /** Current totals, including frames discarded so far. */
  get stats(): RecordingStats {
    return {
      frames: this.entries.length,
      bytes: this.byteLength,
      dropped: this.droppedCount,
      expired: this.expiredCount,
    }
  }

  /**
   * Append one frame.
   * @param input - capture payload; `delay` defaults to the gap since the previous frame.
   * @param at - capture time (defaults to the injected clock).
   * @returns how many frames this call discarded.
   */
  push(input: RecordingFrameInput, at: number = this.now()): RecordingPushResult {
    const delay = input.delay ?? (this.lastCapturedAt === undefined ? 0 : Math.max(0, at - this.lastCapturedAt))
    const frame: RecordingFrame = { ...input, delay }
    const bytes = base64ByteLength(frame.base64)
    this.lastCapturedAt = at
    this.entries.push({ frame, bytes, at })
    this.byteLength += bytes
    const expired = this.expire(at)
    const dropped = this.enforceLimits()
    return { dropped, expired }
  }

  /** Drop every frame and reset the discarded counters. */
  clear(): void {
    this.entries.length = 0
    this.byteLength = 0
    this.droppedCount = 0
    this.expiredCount = 0
    this.lastCapturedAt = undefined
  }

  /** Drop frames older than the TTL, counting them as expired. */
  private expire(now: number): number {
    const cutoff = now - this.limits.ttlMs
    let expired = 0
    while (this.entries.length > 0 && (this.entries[0]?.at ?? 0) < cutoff) {
      const removed = this.entries.shift()
      if (removed === undefined) break
      this.byteLength -= removed.bytes
      expired += 1
    }
    this.expiredCount += expired
    return expired
  }

  /** Drop oldest frames until both the count and byte budgets hold. */
  private enforceLimits(): number {
    let dropped = 0
    while (
      this.entries.length > this.limits.maxFrames
      || this.byteLength > this.limits.maxBytes
    ) {
      const removed = this.entries.shift()
      if (removed === undefined) break
      this.byteLength -= removed.bytes
      dropped += 1
    }
    this.droppedCount += dropped
    return dropped
  }
}

/**
 * Build the panel-facing status for a recording.
 * @param active - whether capture is running.
 * @param stats - totals from the buffer.
 * @param extra - optional export outcome attached after the frames are released.
 * @returns a serializable status payload.
 */
export function recordingStatus(
  active: boolean,
  stats: RecordingStats,
  extra: Pick<RecordingStatus, 'clearedAt' | 'filename'> = {},
): RecordingStatus {
  return { active, ...stats, ...extra }
}

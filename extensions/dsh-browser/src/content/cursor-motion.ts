/**
 * Cursor path planning for the visible phantom cursor.
 *
 * The plan is pure arithmetic: distance is converted to a logarithmic "bits"
 * count (the same measure pointer acceleration uses), each bit costs a fixed
 * budget, and the result is clamped between a floor and a ceiling. The path
 * overshoots the target by a small fraction and returns, so a click looks
 * aimed rather than teleported. Nothing here touches the DOM.
 *
 * @module
 */

/** One viewport position in CSS pixels. */
export interface Point {
  x: number
  y: number
}

/** Timing and shape of one pointer move. */
export interface CursorMotionOptions {
  /** Fixed latency every move pays before distance is counted. */
  baseMs: number
  /** Milliseconds per distance bit. */
  perBitMs: number
  /** Fastest permitted move. */
  minMs: number
  /** Slowest permitted move. */
  maxMs: number
  /** Fraction of the distance travelled past the target before settling. */
  overshoot: number
  /** Number of positions in the returned path, including the endpoint. */
  steps: number
}

/** Defaults tuned for a visible, non-distracting assistive pointer. */
export const DEFAULT_CURSOR_MOTION: Readonly<CursorMotionOptions> = Object.freeze({
  baseMs: 80,
  perBitMs: 70,
  minMs: 140,
  maxMs: 380,
  overshoot: 0.03,
  steps: 16,
})

/** Pixels that count as one distance bit; keeps short moves from costing a bit. */
const PIXELS_PER_BIT = 8

/** A planned move: the visible path plus its duration and distance. */
export interface CursorMotionPlan {
  from: Point
  to: Point
  /** Furthest point along the path (the target plus overshoot). */
  overshoot: Point
  /** Positions from just after `from` through the settling endpoint. */
  points: Point[]
  /** Distance in CSS pixels between `from` and `to`. */
  distance: number
  /** Transition duration for the whole move. */
  durationMs: number
}

/** Euclidean distance between two viewport points. */
export function pointDistance(from: Point, to: Point): number {
  return Math.hypot(to.x - from.x, to.y - from.y)
}

/**
 * Duration one move may take.
 * @param distance - pixels between start and target.
 * @param options - timing options; defaults to {@link DEFAULT_CURSOR_MOTION}.
 * @returns a duration between `minMs` and `maxMs`.
 */
export function cursorMotionDuration(
  distance: number,
  options: CursorMotionOptions = DEFAULT_CURSOR_MOTION,
): number {
  const safeDistance = Number.isFinite(distance) ? Math.max(0, distance) : 0
  const bits = Math.log2(1 + safeDistance / PIXELS_PER_BIT)
  const raw = options.baseMs + options.perBitMs * bits
  return Math.round(Math.min(options.maxMs, Math.max(options.minMs, raw)))
}

/**
 * Plan one pointer move from `from` to `to`.
 *
 * A zero-distance move still returns `steps` positions at the same point so
 * callers never have to special-case a no-op target.
 * @param from - current pointer position.
 * @param to - target position.
 * @param options - timing and shape options; defaults to {@link DEFAULT_CURSOR_MOTION}.
 * @returns the path, overshoot point, distance, and duration.
 */
export function planCursorMotion(
  from: Point,
  to: Point,
  options: CursorMotionOptions = DEFAULT_CURSOR_MOTION,
): CursorMotionPlan {
  const start = { x: finite(from.x), y: finite(from.y) }
  const end = { x: finite(to.x), y: finite(to.y) }
  const distance = pointDistance(start, end)
  const dx = end.x - start.x
  const dy = end.y - start.y
  const overshoot = {
    x: end.x + dx * options.overshoot,
    y: end.y + dy * options.overshoot,
  }
  const steps = Math.max(2, Math.floor(options.steps))
  const points: Point[] = []
  // The first 90% of the steps approach the overshoot point; the remainder
  // settle back onto the target, which reads as a correction rather than a stop.
  const approachSteps = Math.max(1, Math.round(steps * 0.9))
  for (let index = 1; index <= approachSteps; index += 1) {
    const t = index / approachSteps
    points.push({ x: start.x + (overshoot.x - start.x) * t, y: start.y + (overshoot.y - start.y) * t })
  }
  const settleSteps = Math.max(1, steps - approachSteps)
  for (let index = 1; index <= settleSteps; index += 1) {
    const t = index / settleSteps
    points.push({ x: overshoot.x + (end.x - overshoot.x) * t, y: overshoot.y + (end.y - overshoot.y) * t })
  }
  return {
    from: start,
    to: end,
    overshoot,
    points,
    distance,
    durationMs: cursorMotionDuration(distance, options),
  }
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0
}

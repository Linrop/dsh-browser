// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INDICATOR_ELEMENT_ID, PhantomCursorIndicator } from '../src/content/indicator.ts'
import {
  DEFAULT_CURSOR_MOTION,
  cursorMotionDuration,
  planCursorMotion,
  pointDistance,
} from '../src/content/cursor-motion.ts'

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('cursor motion plan', () => {
  it('clamps duration between the floor and ceiling', () => {
    expect(cursorMotionDuration(0)).toBe(DEFAULT_CURSOR_MOTION.minMs)
    expect(cursorMotionDuration(2_000_000)).toBe(DEFAULT_CURSOR_MOTION.maxMs)
    const shortMove = cursorMotionDuration(120)
    const longMove = cursorMotionDuration(2_400)
    expect(shortMove).toBeGreaterThanOrEqual(DEFAULT_CURSOR_MOTION.minMs)
    expect(shortMove).toBeLessThanOrEqual(DEFAULT_CURSOR_MOTION.maxMs)
    expect(longMove).toBeGreaterThan(shortMove)
  })

  it('overshoots by the configured fraction and settles exactly on the target', () => {
    const plan = planCursorMotion({ x: 100, y: 100 }, { x: 400, y: 300 })

    expect(plan.distance).toBeCloseTo(pointDistance({ x: 100, y: 100 }, { x: 400, y: 300 }))
    expect(plan.overshoot.x).toBeCloseTo(400 + 300 * 0.03)
    expect(plan.overshoot.y).toBeCloseTo(300 + 200 * 0.03)
    expect(plan.points).toHaveLength(DEFAULT_CURSOR_MOTION.steps)
    expect(plan.points.at(-1)).toEqual({ x: 400, y: 300 })
    expect(plan.durationMs).toBe(cursorMotionDuration(plan.distance))
  })

  it('keeps a zero-distance move inside the step and duration bounds', () => {
    const plan = planCursorMotion({ x: 50, y: 50 }, { x: 50, y: 50 })

    expect(plan.distance).toBe(0)
    expect(plan.points).toHaveLength(DEFAULT_CURSOR_MOTION.steps)
    expect(plan.points.every((point) => point.x === 50 && point.y === 50)).toBe(true)
    expect(plan.durationMs).toBe(DEFAULT_CURSOR_MOTION.minMs)
  })

  it('normalizes non-finite input instead of producing NaN coordinates', () => {
    const plan = planCursorMotion({ x: Number.NaN, y: 10 }, { x: 20, y: Number.POSITIVE_INFINITY })

    expect(plan.from).toEqual({ x: 0, y: 10 })
    expect(plan.to).toEqual({ x: 20, y: 0 })
    expect(Number.isFinite(plan.durationMs)).toBe(true)
  })
})

describe('PhantomCursorIndicator', () => {
  function dot(): HTMLElement | null {
    return document.getElementById(INDICATOR_ELEMENT_ID)
  }

  it('debounces state changes and applies only the last requested state', () => {
    const indicator = new PhantomCursorIndicator()

    indicator.setState('static')
    vi.advanceTimersByTime(40)
    indicator.setState('pulsing')
    vi.advanceTimersByTime(40)
    indicator.setState('static')
    // Nothing visible yet: the burst has not settled.
    expect(dot()).toBeNull()
    expect(indicator.state).toBe('off')

    vi.advanceTimersByTime(100)
    expect(dot()?.dataset.dshState).toBe('static')
    expect(indicator.state).toBe('static')
  })

  it('switches the dot to the pulsing state and paints only brand tokens', () => {
    const indicator = new PhantomCursorIndicator()

    indicator.setState('pulsing')
    vi.advanceTimersByTime(100)

    const element = dot()
    expect(element?.dataset.dshState).toBe('pulsing')
    expect(element?.getAttribute('aria-hidden')).toBe('true')
    const style = document.getElementById('dsh-phantom-cursor-style')?.textContent ?? ''
    expect(style).toContain('#4d6bfe')
    expect(style).toContain('--blue-soft')
    expect(style).toContain('position: fixed')
    expect(style).toContain('pointer-events: none')
    expect(style).toContain('z-index: 2147483646')
    expect(style).toContain('transition: transform 180ms')
  })

  it('moves the dot to the planned target and removes it when switched off', () => {
    const indicator = new PhantomCursorIndicator()
    indicator.setState('static')
    vi.advanceTimersByTime(100)

    const plan = indicator.moveTo({ x: 240, y: 120 })
    expect(plan.distance).toBeCloseTo(Math.hypot(240, 120))
    expect(dot()?.style.transform).toBe('translate(240px, 120px)')
    expect(dot()?.style.transitionDuration).toBe(`${plan.durationMs}ms`)

    indicator.setState('off')
    vi.advanceTimersByTime(100)
    expect(dot()).toBeNull()
    expect(document.getElementById('dsh-phantom-cursor-style')).toBeNull()
    expect(indicator.state).toBe('off')
  })
})

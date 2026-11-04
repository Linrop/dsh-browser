/**
 * Visible working indicator injected into the assisted page.
 *
 * The extension draws one fixed-position dot at `#dsh-phantom-cursor`. It has
 * exactly two visual states: `static` (bound but idle) and `pulsing` (a tool
 * call is running). State changes are debounced so a burst of tool calls never
 * flashes the ring, and the element is removed entirely when the session ends.
 *
 * Only the brand tokens are used: `#4d6bfe` for the dot and the `--blue-soft`
 * custom property for its ring, with a literal fallback so a page that defines
 * nothing still renders the ring.
 *
 * @module
 */

import { planCursorMotion, type CursorMotionOptions, type Point } from './cursor-motion.ts'

/** Element id the page can observe; stable across content-script reloads. */
export const INDICATOR_ELEMENT_ID = 'dsh-phantom-cursor'

/** Debounce for visual state changes, in milliseconds. */
export const INDICATOR_DEBOUNCE_MS = 100

/** The two live appearances plus the removed state. */
export type IndicatorState = 'static' | 'pulsing' | 'off'

const BRAND_COLOR = '#4d6bfe'
const RING_COLOR = 'var(--blue-soft, rgba(77, 107, 254, 0.28))'
const STYLE_ELEMENT_ID = 'dsh-phantom-cursor-style'
const PULSE_ANIMATION = 'dsh-phantom-pulse'
const TRANSITION_MS = 180
const DOT_SIZE_PX = 10

const INDICATOR_CSS = `
#${INDICATOR_ELEMENT_ID} {
  position: fixed;
  top: 0;
  left: 0;
  width: ${DOT_SIZE_PX}px;
  height: ${DOT_SIZE_PX}px;
  margin: -${DOT_SIZE_PX / 2}px 0 0 -${DOT_SIZE_PX / 2}px;
  border-radius: 50%;
  background: ${BRAND_COLOR};
  box-shadow: 0 0 0 6px ${RING_COLOR};
  pointer-events: none;
  z-index: 2147483646;
  transition: transform ${TRANSITION_MS}ms ease-out, opacity ${TRANSITION_MS}ms ease-out;
  opacity: 0.75;
  will-change: transform, opacity;
}
#${INDICATOR_ELEMENT_ID}[data-dsh-state='pulsing'] {
  opacity: 1;
  animation: ${PULSE_ANIMATION} 900ms ease-in-out infinite;
}
@keyframes ${PULSE_ANIMATION} {
  0%, 100% { box-shadow: 0 0 0 6px ${RING_COLOR}; }
  50% { box-shadow: 0 0 0 11px ${RING_COLOR}; }
}
@media (prefers-reduced-motion: reduce) {
  #${INDICATOR_ELEMENT_ID} { transition: none; animation: none !important; }
}
`

/**
 * One dot per document.
 *
 * All methods are safe to call before the element exists; `setState` creates it
 * on the first live state and `dispose` removes element, style, and timers.
 */
export class PhantomCursorIndicator {
  private element: HTMLElement | undefined
  private styleElement: HTMLStyleElement | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: IndicatorState | undefined
  private applied: IndicatorState = 'off'
  private position: Point = { x: 0, y: 0 }

  /**
   * @param doc - document that receives the element (injectable for tests).
   * @param debounceMs - visual debounce; defaults to {@link INDICATOR_DEBOUNCE_MS}.
   */
  constructor(
    private readonly doc: Document = document,
    private readonly debounceMs: number = INDICATOR_DEBOUNCE_MS,
  ) {}

  /** Current applied state (the debounced value, not the pending one). */
  get state(): IndicatorState {
    return this.applied
  }

  /** The injected element, when the indicator is mounted. */
  get mountedElement(): HTMLElement | undefined {
    return this.element
  }

  /**
   * Request one visual state; consecutive requests within the debounce window
   * collapse into the last one.
   * @param state - desired state.
   */
  setState(state: IndicatorState): void {
    if (state === this.pending || (this.pending === undefined && state === this.applied)) return
    this.pending = state
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.flush() }, this.debounceMs)
  }

  /**
   * Move the dot to a viewport position using the shared motion plan.
   * @param point - target position in CSS pixels.
   * @param options - motion options; defaults to the shared defaults.
   * @returns the planned move, so callers can assert on it in tests.
   */
  moveTo(point: Point, options?: CursorMotionOptions): ReturnType<typeof planCursorMotion> {
    const plan = planCursorMotion(this.position, point, options)
    this.position = { ...plan.to }
    const element = this.ensureElement()
    if (element === undefined) return plan
    element.style.transitionDuration = `${plan.durationMs}ms`
    element.style.transform = `translate(${round(plan.to.x)}px, ${round(plan.to.y)}px)`
    return plan
  }

  /** Remove the element, its stylesheet, and any pending change. */
  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.pending = undefined
    this.applied = 'off'
    this.element?.remove()
    this.element = undefined
    this.styleElement?.remove()
    this.styleElement = undefined
  }

  private flush(): void {
    this.timer = undefined
    const next = this.pending ?? this.applied
    this.pending = undefined
    if (next === 'off') {
      this.element?.remove()
      this.element = undefined
      this.styleElement?.remove()
      this.styleElement = undefined
      this.applied = 'off'
      return
    }
    const element = this.ensureElement()
    if (element === undefined) return
    element.dataset.dshState = next
    this.applied = next
  }

  private ensureElement(): HTMLElement | undefined {
    if (this.element !== undefined) return this.element
    if (this.doc.body === null) return undefined
    if (this.styleElement === undefined) {
      // A reloaded content script inherits the previous instance's stylesheet;
      // reuse it instead of stacking one per injection.
      const existing = this.doc.getElementById(STYLE_ELEMENT_ID)
      if (existing !== null) {
        this.styleElement = existing as HTMLStyleElement
      } else {
        const style = this.doc.createElement('style')
        style.id = STYLE_ELEMENT_ID
        style.textContent = INDICATOR_CSS
        ;(this.doc.head ?? this.doc.documentElement).appendChild(style)
        this.styleElement = style
      }
    }
    const reused = this.doc.getElementById(INDICATOR_ELEMENT_ID)
    const element = reused ?? this.doc.createElement('div')
    if (reused === null) {
      element.id = INDICATOR_ELEMENT_ID
      element.setAttribute('aria-hidden', 'true')
      this.doc.body.appendChild(element)
    }
    element.dataset.dshState = this.applied === 'off' ? 'static' : this.applied
    element.style.transform = `translate(${round(this.position.x)}px, ${round(this.position.y)}px)`
    this.element = element
    return element
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Pointer page actions: `browser_hover` and `browser_drag` degraded paths.
 *
 * These run when the background could not drive the browser's input pipeline
 * over CDP. They synthesize the DOM events a real pointer would produce, so
 * page handlers (menus, drag-and-drop widgets) still observe the interaction.
 * Coordinates are viewport CSS pixels.
 *
 * @module
 */

import { ActionError, elementOrThrow, numberArg } from './action-support.ts'
import type { ElementIds } from './ids.ts'

/** A viewport point in CSS pixels. */
interface Point {
  x: number
  y: number
}

/** Number of interpolated moves between a drag's start and end. */
const DRAG_STEPS = 5

/** Round a point to whole CSS pixels (dispatch and status line agree). */
function roundPoint(point: Point): Point {
  return { x: Math.round(point.x), y: Math.round(point.y) }
}

/** The centre of an element's border box. */
function centreOf(el: Element): Point {
  const rect = el.getBoundingClientRect()
  return roundPoint({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
}

/** The topmost element at a viewport point, when the environment supports it. */
function elementAt(point: Point): Element | null {
  if (typeof document.elementFromPoint !== 'function') return null
  try {
    return document.elementFromPoint(point.x, point.y)
  } catch {
    // Out-of-viewport coordinates make some engines throw; treat as no target.
    return null
  }
}

/** Build a pointer event, falling back to `MouseEvent` where `PointerEvent` is absent. */
function pointerEvent(type: string, point: Point, extra: { buttons?: number; button?: number; detail?: number } = {}): MouseEvent {
  const init: PointerEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: point.x,
    clientY: point.y,
    screenX: point.x,
    screenY: point.y,
    button: extra.button ?? 0,
    buttons: extra.buttons ?? 0,
    detail: extra.detail ?? 0,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
  }
  return typeof PointerEvent === 'function'
    ? new PointerEvent(type, init)
    : new MouseEvent(type, init)
}

/** Build a drag event carrying a shared `DataTransfer`. */
function dragEvent(type: string, point: Point, dataTransfer: DataTransfer | null): Event {
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: point.x,
    clientY: point.y,
    screenX: point.x,
    screenY: point.y,
    button: 0,
    buttons: 1,
    detail: 1,
  }
  const event = typeof DragEvent === 'function'
    ? new DragEvent(type, { ...init, dataTransfer })
    : new MouseEvent(type, init)
  // `MouseEvent` ignores an unknown init key, so a synthetic dragstart under a
  // reduced event surface still carries the transfer handlers read.
  if (dataTransfer !== null) Object.defineProperty(event, 'dataTransfer', { configurable: true, value: dataTransfer })
  return event
}

/** Create the transfer shared by all events of one drag, when available. */
function makeDataTransfer(): DataTransfer | null {
  if (typeof DataTransfer !== 'function') return null
  try {
    return new DataTransfer()
  } catch {
    // Some engines only expose DataTransfer while a native drag is in flight;
    // the events still fire, just without payload.
    return null
  }
}

/** Read a `[x, y]` coordinate pair argument. */
function pairArg(args: Record<string, unknown>, name: string): Point {
  const value = args[name]
  if (!Array.isArray(value) || value.length !== 2
    || typeof value[0] !== 'number' || typeof value[1] !== 'number'
    || !Number.isFinite(value[0]) || !Number.isFinite(value[1])) {
    throw new ActionError('bad-args', `${name} must be a [x, y] viewport coordinate pair; received ${JSON.stringify(value)}. Call browser_snapshot to read the page, then retry browser_drag.`)
  }
  return roundPoint({ x: value[0], y: value[1] })
}

/**
 * Resolve the hover target: either a snapshot index's centre or explicit
 * viewport coordinates.
 */
function hoverTarget(args: Record<string, unknown>, ids: ElementIds): { point: Point; target: Element; index?: number } {
  const hasIndex = args.index !== undefined
  const hasCoordinates = args.x !== undefined || args.y !== undefined
  if (hasIndex && hasCoordinates) {
    throw new ActionError('bad-args', 'Provide either index or x/y, not both. Call browser_snapshot to pick a target, then retry browser_hover.')
  }
  if (!hasIndex && !hasCoordinates) {
    throw new ActionError('bad-args', 'Provide index, or both x and y, to hover. Call browser_snapshot to pick a target, then retry browser_hover.')
  }
  if (hasIndex) {
    const index = numberArg(args, 'index')
    const target = elementOrThrow(ids, index)
    return { point: centreOf(target), target, index }
  }
  if (typeof args.x !== 'number' || typeof args.y !== 'number'
    || !Number.isFinite(args.x) || !Number.isFinite(args.y)) {
    throw new ActionError('bad-args', `x and y must be finite numbers; received x=${String(args.x)}, y=${String(args.y)}. Retry browser_hover with both coordinates.`)
  }
  const point = roundPoint({ x: args.x, y: args.y })
  return { point, target: elementAt(point) ?? document.body ?? document.documentElement }
}

/** Viewport geometry of one pointer target, in CSS pixels. */
export interface PointerRect {
  x: number
  y: number
  width: number
  height: number
  /** False when the centre lies outside the visible viewport. */
  visible: boolean
}

/**
 * Scroll one element to the viewport centre and return its centre point.
 * @param el - element to bring into view.
 * @returns the centre of its border box after scrolling.
 */
function scrollAndCentre(el: Element): Point {
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  return centreOf(el)
}

function inViewport(point: Point): boolean {
  return point.x >= 0 && point.y >= 0
    && point.x < (window.innerWidth || 0)
    && point.y < (window.innerHeight || 0)
}

function rectOf(el: Element, point: Point): PointerRect {
  const rect = el.getBoundingClientRect()
  return {
    ...roundPoint(point),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    visible: inViewport(point),
  }
}

function coordinateArg(args: Record<string, unknown>): Point {
  if (typeof args.x !== 'number' || typeof args.y !== 'number'
    || !Number.isFinite(args.x) || !Number.isFinite(args.y)) {
    throw new ActionError('bad-args', `x and y must be finite numbers; received x=${String(args.x)}, y=${String(args.y)}.`)
  }
  return roundPoint({ x: args.x, y: args.y })
}

/**
 * Resolve where a real input event must be dispatched for `browser_hover`.
 *
 * Scrolls an element target to the viewport centre first, because the caller
 * sends the returned point through the browser's own input pipeline.
 * @param args - `index`, or `x`/`y`.
 * @param ids - stable element id registry.
 * @returns viewport geometry of the target.
 */
export function pointerRectAction(args: Record<string, unknown>, ids: ElementIds): PointerRect {
  const hasIndex = args.index !== undefined
  const hasCoordinates = args.x !== undefined || args.y !== undefined
  if (hasIndex === hasCoordinates) {
    throw new ActionError('bad-args', 'Provide either index or x/y, not both.')
  }
  if (hasIndex) {
    const el = elementOrThrow(ids, numberArg(args, 'index'))
    return rectOf(el, scrollAndCentre(el))
  }
  const point = coordinateArg(args)
  return { ...point, width: 0, height: 0, visible: inViewport(point) }
}

/**
 * Resolve both endpoints of a real drag.
 *
 * Each endpoint is scrolled into view in turn; the start point is re-measured
 * afterwards so a scroll caused by the second look-up cannot leave stale
 * coordinates. The caller falls back to synthesized events when an endpoint is
 * no longer visible.
 * @param args - from_index/to_index or from/to.
 * @param ids - stable element id registry.
 * @returns viewport geometry for the start and end points.
 */
export function dragRectsAction(args: Record<string, unknown>, ids: ElementIds): { from: PointerRect; to: PointerRect } {
  const hasIndexes = args.from_index !== undefined || args.to_index !== undefined
  const hasPairs = args.from !== undefined || args.to !== undefined
  if (hasIndexes === hasPairs) {
    throw new ActionError('bad-args', 'Provide either from_index/to_index or from/to, not both.')
  }
  if (hasIndexes) {
    const fromElement = elementOrThrow(ids, numberArg(args, 'from_index'))
    const toElement = elementOrThrow(ids, numberArg(args, 'to_index'))
    scrollAndCentre(fromElement)
    const toPoint = scrollAndCentre(toElement)
    return {
      from: rectOf(fromElement, centreOf(fromElement)),
      to: rectOf(toElement, toPoint),
    }
  }
  const from = pairArg(args, 'from')
  const to = pairArg(args, 'to')
  return {
    from: { ...from, width: 0, height: 0, visible: inViewport(from) },
    to: { ...to, width: 0, height: 0, visible: inViewport(to) },
  }
}

/**
 * Move the pointer over an element or a viewport point by dispatching the
 * mouse/pointer event sequence pages listen to.
 *
 * @param args - `index`, or `x`/`y`.
 * @param ids - stable element id registry.
 * @returns a status line naming the hovered target.
 */
export function hoverAction(args: Record<string, unknown>, ids: ElementIds): string {
  const { point, target, index } = hoverTarget(args, ids)
  for (const type of ['pointerover', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
    target.dispatchEvent(pointerEvent(type, point))
  }
  return index === undefined
    ? `Hovered at (${point.x}, ${point.y}).`
    : `Hovered over [${index}] at (${point.x}, ${point.y}).`
}

/** One drag endpoint: the event target and the point events are dispatched at. */
interface DragEndpoint {
  point: Point
  target: Element
}

/** Interpolate between two points, rounding to the pixel grid. */
function pointBetween(from: Point, to: Point, fraction: number): Point {
  return roundPoint({ x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction })
}

/**
 * Resolve both drag endpoints, enforcing one complete addressing form.
 */
function dragEndpoints(args: Record<string, unknown>, ids: ElementIds): { from: DragEndpoint; to: DragEndpoint } {
  const hasIndexes = args.from_index !== undefined || args.to_index !== undefined
  const hasPairs = args.from !== undefined || args.to !== undefined
  if (hasIndexes && hasPairs) {
    throw new ActionError('bad-args', 'Provide either from_index/to_index or from/to, not both. Call browser_snapshot to pick the endpoints, then retry browser_drag.')
  }
  if (!hasIndexes && !hasPairs) {
    throw new ActionError('bad-args', 'Provide from_index and to_index, or from and to coordinate pairs. Call browser_snapshot to pick the endpoints, then retry browser_drag.')
  }
  if (hasIndexes) {
    const fromIndex = numberArg(args, 'from_index')
    const toIndex = numberArg(args, 'to_index')
    const fromElement = elementOrThrow(ids, fromIndex)
    const toElement = elementOrThrow(ids, toIndex)
    return {
      from: { point: centreOf(fromElement), target: fromElement },
      to: { point: centreOf(toElement), target: toElement },
    }
  }
  const fromPoint = pairArg(args, 'from')
  const toPoint = pairArg(args, 'to')
  return {
    from: { point: fromPoint, target: elementAt(fromPoint) ?? document.body ?? document.documentElement },
    to: { point: toPoint, target: elementAt(toPoint) ?? document.body ?? document.documentElement },
  }
}

/**
 * Drag between two endpoints by synthesizing the pointer, drag, and drop
 * events of a native drag.
 *
 * @param args - from_index/to_index or from/to.
 * @param ids - stable element id registry.
 * @returns a status line naming both endpoints.
 */
export function dragAction(args: Record<string, unknown>, ids: ElementIds): string {
  const { from, to } = dragEndpoints(args, ids)
  const transfer = makeDataTransfer()
  from.target.dispatchEvent(pointerEvent('pointerdown', from.point, { buttons: 1, button: 0, detail: 1 }))
  from.target.dispatchEvent(pointerEvent('mousedown', from.point, { buttons: 1, button: 0, detail: 1 }))
  from.target.dispatchEvent(dragEvent('dragstart', from.point, transfer))
  for (let step = 1; step <= DRAG_STEPS; step += 1) {
    const point = pointBetween(from.point, to.point, step / DRAG_STEPS)
    const target = elementAt(point) ?? to.target
    target.dispatchEvent(dragEvent('dragover', point, transfer))
    target.dispatchEvent(pointerEvent('mousemove', point, { buttons: 1, detail: 0 }))
  }
  const endTarget = elementAt(to.point) ?? to.target
  endTarget.dispatchEvent(dragEvent('drop', to.point, transfer))
  endTarget.dispatchEvent(pointerEvent('pointerup', to.point, { buttons: 0, detail: 1 }))
  endTarget.dispatchEvent(pointerEvent('mouseup', to.point, { buttons: 0, detail: 1 }))
  return `Dragged from (${from.point.x}, ${from.point.y}) to (${to.point.x}, ${to.point.y}).`
}

/**
 * Shared primitives for page actions: the stable wire error, element resolution
 * by snapshot index, numeric argument parsing, and short element descriptions
 * for actionable error messages.
 *
 * @module
 */

import type { ElementIds } from './ids.ts'

/** Error carrying a stable wire code. */
export class ActionError extends Error {
  constructor(
    readonly code: 'action-failed' | 'bad-args',
    message: string,
  ) {
    super(message)
    this.name = 'ActionError'
  }
}

/**
 * Resolve a snapshot index to its inventoried element.
 *
 * @param ids - stable element id registry.
 * @param index - snapshot index addressed by the model.
 * @returns the addressed element.
 */
export function elementOrThrow(ids: ElementIds, index: number): Element {
  const el = ids.elementByIndex(index)
  if (el === undefined) {
    throw new ActionError('action-failed', `Element [${index}] does not exist; the page may have changed. Call browser_snapshot again to get current indices.`)
  }
  return el
}

/**
 * Read a non-negative integer argument.
 *
 * @param args - action arguments.
 * @param name - argument name.
 * @returns the parsed integer.
 */
export function numberArg(args: Record<string, unknown>, name: string): number {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ActionError('bad-args', `${name} must be a non-negative integer; received ${String(value)}. Call browser_snapshot to read the current indices.`)
  }
  return value
}

/**
 * A short element description for error messages (`button`, `input[type=file]`).
 *
 * @param el - element that failed an action's type check.
 * @returns a tag-like description.
 */
export function describeElement(el: Element): string {
  if (el instanceof HTMLInputElement) return `input[type=${el.type || 'text'}]`
  return el.tagName.toLowerCase()
}

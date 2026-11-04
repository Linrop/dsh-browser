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

/** A snapshot reference resolved to its live element. */
export interface ResolvedElement {
  element: Element
  /** Selector that re-located a vanished node; absent for a live registry hit. */
  relocatedBy?: string
}

/**
 * Re-location notices per registry, drained by the action that produced them.
 *
 * The notice belongs to one action's result text, not to the registry, so it is
 * kept beside it instead of growing the public element-registry contract.
 */
const relocationNotes = new WeakMap<ElementIds, string[]>()

/**
 * Take the re-location notices produced by the current action.
 * @param ids - the registry the action addressed.
 * @returns notice sentences in resolution order.
 */
export function takeRelocationNotes(ids: ElementIds): string[] {
  const notes = relocationNotes.get(ids)
  if (notes === undefined) return []
  relocationNotes.delete(ids)
  return notes
}

/**
 * Resolve a snapshot index to its live element, re-locating a re-rendered one.
 *
 * A single-page app can replace an inventoried node without replacing the
 * document, so the registry's node reference goes stale while the selector
 * recorded beside it still addresses the control the model read. Resolution
 * counts matches instead of trusting that selector: zero and several are both
 * reported with the reference and the selector, because neither can be
 * silently resolved to a guess.
 *
 * @param ids - stable element id registry.
 * @param index - snapshot index addressed by the model.
 * @returns the live element and, when it was re-located, the selector used.
 * @throws ActionError when no selector was recorded, nothing matches, or the
 *   selector matches more than one element.
 */
export function resolveElement(ids: ElementIds, index: number): ResolvedElement {
  const el = ids.elementByIndex(index)
  // A registry without a recorded selector (a test double, or a build that
  // never rendered the number) has no re-location basis, so its node is the
  // only answer it can give.
  const selector = typeof ids.selectorFor === 'function' ? ids.selectorFor(index) : undefined
  if (el !== undefined && (el.isConnected || selector === undefined)) return { element: el }
  if (selector === undefined || selector === '') {
    throw new ActionError(
      'action-failed',
      `The element at ref ${index} no longer exists (no selector was recorded for it). Call browser_snapshot and retry.`,
    )
  }
  const matches = [...document.querySelectorAll(selector)]
  if (matches.length === 0) {
    throw new ActionError(
      'action-failed',
      `The element at ref ${index} no longer exists (selector: ${selector}). Call browser_snapshot and retry.`,
    )
  }
  if (matches.length > 1) {
    throw new ActionError(
      'action-failed',
      `The element at ref ${index} is ambiguous: selector ${selector} now matches ${matches.length} elements. Call browser_snapshot and retry.`,
    )
  }
  const replacement = matches[0]!
  ids.rebind(index, replacement)
  const notes = relocationNotes.get(ids) ?? []
  notes.push(`The element at ref ${index} was re-located by selector ${selector} after the page changed.`)
  relocationNotes.set(ids, notes)
  return { element: replacement, relocatedBy: selector }
}

/**
 * Resolve a snapshot index to its live element.
 *
 * @param ids - stable element id registry.
 * @param index - snapshot index addressed by the model.
 * @returns the addressed element.
 */
export function elementOrThrow(ids: ElementIds, index: number): Element {
  return resolveElement(ids, index).element
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

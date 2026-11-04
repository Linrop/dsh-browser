/**
 * Whether Chrome will deliver protocol input events to a tab.
 *
 * `Input.dispatchMouseEvent` is a no-op for a tab that is not the active tab
 * of a focused window, so the tool layer must know before it dispatches:
 * reporting real input that never reached the page is worse than falling back
 * to events synthesized inside the page. The decision stays a pure function of
 * the tab and window values so every combination is unit-testable.
 *
 * @module
 */

/** Browser-owned facts that decide whether real input reaches a tab. */
export interface RealInputState {
  /** `active` from `chrome.tabs.get(tabId)`, undefined when the tab is unreadable. */
  tabActive: boolean | undefined
  /** Whether this browser build exposes `chrome.windows`. */
  windowApiAvailable: boolean
  /** `focused` from `chrome.windows.get(windowId)`, undefined when unreadable. */
  windowFocused: boolean | undefined
}

/** Why real input would not reach the tab. */
export type RealInputUnavailableReason =
  | 'tab-not-active'
  | 'window-api-unavailable'
  | 'window-not-focused'

/** The verdict for one tab. */
export type RealInputVerdict =
  | { usable: true }
  | { usable: false; reason: RealInputUnavailableReason }

/**
 * Decide whether the browser input pipeline can reach a tab.
 *
 * A tab only receives dispatched input when it is active in its window and
 * that window has focus. A browser build without `chrome.windows`, or one
 * whose focus state cannot be read, is treated as unable to receive input.
 * @param state - tab and window facts read from the browser.
 * @returns whether real input is usable, with the blocking reason otherwise.
 */
export function realInputVerdict(state: RealInputState): RealInputVerdict {
  if (state.tabActive !== true) return { usable: false, reason: 'tab-not-active' }
  if (!state.windowApiAvailable) return { usable: false, reason: 'window-api-unavailable' }
  if (state.windowFocused !== true) return { usable: false, reason: 'window-not-focused' }
  return { usable: true }
}

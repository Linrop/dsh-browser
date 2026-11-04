/**
 * Normalizes arbitrary extension-side failures into the bridge's stable tool
 * error vocabulary.
 *
 * Tool dispatch can fail in places that never see the wire contract: browser
 * APIs throw `Error`s, content scripts answer with free-form text, and page
 * evaluation can return values that cannot cross a messaging boundary. This
 * module owns the one mapping from those raw failures to a `ToolErrorCode`, so
 * every transport path reports the same code for the same cause.
 *
 * The wire code set is open: a code the bridge already understands passes
 * through unchanged, and only unmapped text falls back to `action-failed` with
 * its original message preserved.
 *
 * @module
 */

import type { ToolErrorCode } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'

/** Stable failure after normalization. */
export interface NormalizedToolError {
  code: ToolErrorCode
  message: string
}

/**
 * Codes specific enough to trust as-is. The catch-all codes (`internal`,
 * `action-failed`) are deliberately absent: their text still names the real
 * cause, so they are re-mapped rather than passed through.
 */
const PASSTHROUGH_CODES = new Set<string>([
  'no-active-tab',
  'content-unavailable',
  'timeout',
  'bridge-closed',
  'bad-args',
  'tab_outside',
  'protected-page',
  'js-result-not-serializable',
  'debugger-unavailable',
  'send_failed',
])

interface ErrorRule {
  readonly code: ToolErrorCode
  readonly test: RegExp
}

/**
 * Ordered textual rules. Browser-owned surfaces are matched first: their error
 * text often also mentions the content script that could not be injected, and
 * the protected-page cause is the actionable one.
 */
const ERROR_RULES: readonly ErrorRule[] = [
  {
    code: 'protected-page',
    test: /chrome:\/\/|chrome-extension:\/\/|edge:\/\/|about:|view-source:|devtools:\/\/|protected page|protected by the browser|Cannot access (?:a )?chrome/i,
  },
  {
    code: 'debugger-unavailable',
    test: /another debugger|debugger is already attached|debugger.*not (?:available|attached)|cannot attach|attach(?:ing)? (?:to )?(?:the )?target failed/i,
  },
  {
    code: 'js-result-not-serializable',
    test: /object reference chain is too long|not serializable|could not (?:be )?serializ|serializ\w* (?:failed|error)|json\.stringify/i,
  },
  {
    code: 'timeout',
    test: /timed out|timeout|etimedout|did not respond in time/i,
  },
  {
    code: 'content-unavailable',
    test: /content script|no content|received no response|not available on this page|frame .* does not exist/i,
  },
]

/** Extract human-readable text from anything a dispatch path can reject with. */
function errorText(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw
  if (raw instanceof Error) return raw.message
  if (typeof raw === 'object' && raw !== null) {
    const message = (raw as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return undefined
}

/** Extract a wire code from an already-structured failure, if it has one. */
function structuredCode(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const code = (raw as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Map one raw dispatch failure to a stable code and message.
 * @param raw - `Error`, string, `{ code, message }`, or anything else a dispatch path threw.
 * @returns the normalized failure; the message is never dropped.
 */
export function normalizeToolError(raw: unknown): NormalizedToolError {
  const message = errorText(raw) ?? 'browser action failed'
  const declared = structuredCode(raw)
  if (declared !== undefined && PASSTHROUGH_CODES.has(declared)) {
    return { code: declared as ToolErrorCode, message }
  }
  for (const rule of ERROR_RULES) {
    if (rule.test.test(message)) return { code: rule.code, message }
  }
  return { code: 'action-failed', message }
}

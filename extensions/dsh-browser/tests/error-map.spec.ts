// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { normalizeToolError } from '../src/background/error-map.ts'

describe('normalizeToolError', () => {
  it('maps browser-owned surfaces to protected-page', () => {
    expect(normalizeToolError(new Error('Cannot access a chrome:// URL')).code).toBe('protected-page')
    expect(normalizeToolError(new Error('Cannot access contents of the page chrome-extension://abc/panel.html')).code)
      .toBe('protected-page')
    expect(normalizeToolError('The current page DOM is protected by the browser.').code).toBe('protected-page')
  })

  it('maps a competing debugger session to debugger-unavailable', () => {
    expect(normalizeToolError(new Error('Another debugger is already attached to the target')).code)
      .toBe('debugger-unavailable')
    expect(normalizeToolError('Cannot attach to target').code).toBe('debugger-unavailable')
  })

  it('maps unserializable page results to js-result-not-serializable', () => {
    expect(normalizeToolError(new Error('Object reference chain is too long')).code)
      .toBe('js-result-not-serializable')
    expect(normalizeToolError({ code: 'internal', message: 'Could not serialize the response' }).code)
      .toBe('js-result-not-serializable')
  })

  it('maps deadlines to timeout', () => {
    expect(normalizeToolError(new Error('browser action "browser_click" timed out after 90000ms')).code).toBe('timeout')
    expect(normalizeToolError({ message: 'The content script did not respond in time' }).code).toBe('timeout')
  })

  it('maps missing page content to content-unavailable', () => {
    expect(normalizeToolError('The content script could not be loaded on this page').code).toBe('content-unavailable')
    expect(normalizeToolError(new Error('The page content script returned an invalid response.')).code)
      .toBe('content-unavailable')
  })

  it('falls back to action-failed and keeps the original message', () => {
    const normalized = normalizeToolError(new Error('Something entirely unexpected happened'))
    expect(normalized).toEqual({ code: 'action-failed', message: 'Something entirely unexpected happened' })
    expect(normalizeToolError(undefined)).toEqual({ code: 'action-failed', message: 'browser action failed' })
    expect(normalizeToolError(42)).toEqual({ code: 'action-failed', message: 'browser action failed' })
  })

  it('passes an already-structured known code through unchanged', () => {
    expect(normalizeToolError({ code: 'timeout', message: 'still text' }))
      .toEqual({ code: 'timeout', message: 'still text' })
    expect(normalizeToolError({ code: 'tab_outside', message: 'tab not controlled' }))
      .toEqual({ code: 'tab_outside', message: 'tab not controlled' })
    expect(normalizeToolError({ code: 'send_failed', message: 'frame dropped' }))
      .toEqual({ code: 'send_failed', message: 'frame dropped' })
  })

  it('prefers a specific declared code over textual rules', () => {
    // A specific code wins even when the text would match a different rule.
    expect(normalizeToolError({ code: 'timeout', message: 'Cannot access a chrome:// URL' }))
      .toEqual({ code: 'timeout', message: 'Cannot access a chrome:// URL' })
  })

  it('re-maps the catch-all codes from their message', () => {
    expect(normalizeToolError({ code: 'internal', message: 'Cannot access a chrome:// URL' }))
      .toEqual({ code: 'protected-page', message: 'Cannot access a chrome:// URL' })
    expect(normalizeToolError({ code: 'action-failed', message: 'Object reference chain is too long' }))
      .toEqual({ code: 'js-result-not-serializable', message: 'Object reference chain is too long' })
  })

  it('keeps an unknown declared code out of the wire vocabulary', () => {
    expect(normalizeToolError({ code: 'made-up-code', message: 'boom' }))
      .toEqual({ code: 'action-failed', message: 'boom' })
  })
})

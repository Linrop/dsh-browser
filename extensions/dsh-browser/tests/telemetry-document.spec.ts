// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  forgetTab,
  handleDebuggerEvent,
  noteTabNavigation,
  readConsoleMessages,
  readNetworkRequests,
} from '../src/background/cdp.ts'

function consoleEntry(tabId: number, text: string, timestamp: number): void {
  handleDebuggerEvent(tabId, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: text }], timestamp })
}

function networkRequest(tabId: number, requestId: string, url: string): void {
  handleDebuggerEvent(tabId, 'Network.requestWillBeSent', {
    requestId,
    request: { url, method: 'GET' },
    timestamp: 1,
  })
}

describe('telemetry buffers follow the main document', () => {
  it('clears both buffers when the same URL is reloaded into a new document', () => {
    const tabId = 9001
    noteTabNavigation(tabId, 'https://example.com/page', 'doc-a')
    consoleEntry(tabId, 'before reload', 1)
    networkRequest(tabId, 'r1', 'https://example.com/app.js')
    expect(readConsoleMessages(tabId).total).toBe(1)
    noteTabNavigation(tabId, 'https://example.com/page', 'doc-b')
    expect(readConsoleMessages(tabId).total).toBe(0)
    expect(readNetworkRequests(tabId).total).toBe(0)
    forgetTab(tabId)
  })

  it('clears across a cross-document navigation', () => {
    const tabId = 9002
    noteTabNavigation(tabId, 'https://example.com/page', 'doc-a')
    consoleEntry(tabId, 'old document', 1)
    networkRequest(tabId, 'r1', 'https://example.com/app.js')
    noteTabNavigation(tabId, 'https://other.example.org/page', 'doc-b')
    expect(readConsoleMessages(tabId).total).toBe(0)
    expect(readNetworkRequests(tabId).total).toBe(0)
    forgetTab(tabId)
  })

  it('keeps the buffers for a same-document hash change', () => {
    const tabId = 9003
    noteTabNavigation(tabId, 'https://example.com/page', 'doc-a')
    consoleEntry(tabId, 'kept', 1)
    networkRequest(tabId, 'r1', 'https://example.com/app.js')
    noteTabNavigation(tabId, 'https://example.com/page#section', 'doc-a')
    expect(readConsoleMessages(tabId).messages.map((message) => message.text)).toEqual(['kept'])
    expect(readNetworkRequests(tabId).total).toBe(1)
    forgetTab(tabId)
  })

  it('does not resurrect a cleared console entry when the protocol replays it', () => {
    const tabId = 9004
    consoleEntry(tabId, 'replayed', 5)
    expect(readConsoleMessages(tabId, { clear: true }).total).toBe(1)
    consoleEntry(tabId, 'replayed', 5)
    expect(readConsoleMessages(tabId).total).toBe(0)
    forgetTab(tabId)
  })

  it('does not resurrect a cleared network request when the protocol replays it', () => {
    const tabId = 9005
    networkRequest(tabId, 'r1', 'https://example.com/app.js')
    expect(readNetworkRequests(tabId, { clear: true }).total).toBe(1)
    networkRequest(tabId, 'r1', 'https://example.com/app.js')
    expect(readNetworkRequests(tabId).total).toBe(0)
    forgetTab(tabId)
  })
})

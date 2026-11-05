// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchToolCall, type TabManagementContext, type ToolCall } from '../src/background/tools.ts'
import { recordInstrumentEntry } from '../src/background/cdp.ts'

interface ChromeState {
  tab: Partial<chrome.tabs.Tab>
  frames?: Array<{ frameId: number; parentFrameId: number; documentId?: string; url: string }>
  debuggerApi?: {
    attach: ReturnType<typeof vi.fn>
    detach: ReturnType<typeof vi.fn>
    sendCommand: ReturnType<typeof vi.fn>
    onDetach: { addListener: (listener: () => void) => void }
    onEvent: { addListener: (listener: () => void) => void }
  }
  executeScriptResult?: unknown
  executeScriptError?: Error
}

let tabSequence = 200

function nextTabId(): number {
  tabSequence += 1
  return tabSequence
}

function mockChrome(state: ChromeState): {
  sendMessage: ReturnType<typeof vi.fn>
  executeScript: ReturnType<typeof vi.fn>
  windowsUpdate: ReturnType<typeof vi.fn>
  captureVisibleTab: ReturnType<typeof vi.fn>
} {
  const tab = {
    id: nextTabId(),
    windowId: 2,
    index: 0,
    active: true,
    highlighted: false,
    pinned: false,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    url: 'https://example.com/',
    title: 'Example',
    ...state.tab,
  } as chrome.tabs.Tab
  const sendMessage = vi.fn(async () => {
    throw new Error('Could not establish connection. Receiving end does not exist.')
  })
  const executeScript = state.executeScriptError === undefined
    ? vi.fn(async () => [{ frameId: 0, result: state.executeScriptResult }])
    : vi.fn(async () => { throw state.executeScriptError })
  const windowsUpdate = vi.fn(async () => ({ id: tab.windowId }))
  const captureVisibleTab = vi.fn(async () => 'data:image/jpeg;base64,QUJD')
  const frames = state.frames ?? [{ frameId: 0, parentFrameId: -1, documentId: `doc-${tab.id}`, url: tab.url ?? '' }]
  vi.stubGlobal('chrome', {
    ...(state.debuggerApi === undefined ? {} : { debugger: state.debuggerApi }),
    tabs: {
      query: vi.fn(async () => [tab]),
      get: vi.fn(async (tabId: number) => (tabId === tab.id ? tab : (() => { throw new Error(`No tab with id: ${tabId}`) })())),
      sendMessage,
      captureVisibleTab,
    },
    webNavigation: { getAllFrames: vi.fn(async () => frames) },
    scripting: { executeScript },
    windows: { update: windowsUpdate },
    runtime: { id: 'test-extension' },
  })
  return { sendMessage, executeScript, windowsUpdate, captureVisibleTab }
}

function call(name: string, args: Record<string, unknown>, id = name): ToolCall {
  return { id, name, args }
}

const UNRESTRICTED: TabManagementContext = { unrestrictedAccess: true }

async function dispatch(call_: ToolCall, share: 'ask' | 'auto' | 'off' = 'auto') {
  return dispatchToolCall(call_, share, undefined, undefined, undefined, undefined, undefined, UNRESTRICTED)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('privacy gate covers every page reader', () => {
  it.each([
    'browser_snapshot',
    'browser_get_text',
    'browser_find',
    'browser_console',
    'browser_network',
    'browser_evaluate',
    'browser_screenshot',
    'browser_pdf',
  ])('refuses %s while page content sharing is off', async (name) => {
    mockChrome({ tab: {} })
    const answer = await dispatchToolCall(call(name, { code: '1', query: 'x' }), 'off', undefined, undefined, undefined, undefined, undefined, {
      unrestrictedAccess: false,
    })
    expect(answer).toMatchObject({
      ok: false,
      error: { code: 'action-failed', message: expect.stringContaining('Page content sharing is disabled') },
    })
  })

  it('lets writes through while reads are off', async () => {
    const chromeMock = mockChrome({ tab: { url: 'chrome://settings' } })
    const answer = await dispatchToolCall(call('browser_resize', { width: 900, height: 700 }), 'off', undefined, undefined, undefined, undefined, undefined, UNRESTRICTED)
    expect(answer.ok).toBe(true)
    expect(chromeMock.windowsUpdate).toHaveBeenCalledWith(2, { width: 900, height: 700 })
  })
})

describe('browser_evaluate dispatch', () => {
  it('refuses chrome:// pages with protected-page', async () => {
    mockChrome({ tab: { url: 'chrome://settings' } })
    const answer = await dispatch(call('browser_evaluate', { code: '1 + 1' }))
    expect(answer).toMatchObject({ ok: false, error: { code: 'protected-page' } })
    expect((answer.error as { message: string }).message).toContain('HTTP(S)')
  })

  it('falls back to MAIN-world executeScript and labels the result', async () => {
    const chromeMock = mockChrome({ tab: {}, executeScriptResult: 7 })
    const answer = await dispatch(call('browser_evaluate', { code: 'return 7' }))
    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toBe('(evaluated without REPL semantics: add an explicit return)\n(evaluated without the browser debugger: this path always awaits the result, so await=false has no effect)\nResult: 7')
    expect(chromeMock.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { frameIds: [0], tabId: expect.any(Number) },
      world: 'MAIN',
      args: ['return 7'],
      func: expect.any(Function),
    }))
  })

  it('labels the dropped await=false on the debugger-free path', async () => {
    mockChrome({ tab: {}, executeScriptResult: 7 })
    const answer = await dispatch(call('browser_evaluate', { code: 'return 7', await: false }))
    expect((answer.result as { text: string }).text).toContain('this path always awaits the result, so await=false has no effect')
  })

  it('truncates long results at max_chars', async () => {
    mockChrome({ tab: {}, executeScriptResult: 'x'.repeat(100) })
    const answer = await dispatch(call('browser_evaluate', { code: 'return "x".repeat(100)', max_chars: 10 }))
    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toContain('[OUTPUT TRUNCATED: exceeded 10 characters]')
  })

  it('reports debugger-unavailable when neither path can run', async () => {
    mockChrome({ tab: {}, executeScriptError: new Error('Cannot access contents of the page') })
    const answer = await dispatch(call('browser_evaluate', { code: '1' }))
    expect(answer).toMatchObject({ ok: false, error: { code: 'debugger-unavailable' } })
  })

  it('uses CDP when the debugger is available', async () => {
    const sendCommand = vi.fn(async (_target: unknown, method: string) => {
      if (method === 'Runtime.evaluate') return { result: { value: { answer: 42 } } }
      return {}
    })
    const chromeMock = mockChrome({
      tab: {},
      debuggerApi: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        sendCommand,
        onDetach: { addListener: () => undefined },
        onEvent: { addListener: () => undefined },
      },
    })
    const answer = await dispatch(call('browser_evaluate', { code: '({answer: 42})' }))
    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toContain('"answer": 42')
    expect(chromeMock.executeScript).not.toHaveBeenCalled()
  })
})

describe('browser_resize dispatch', () => {
  it('resizes the window with floored dimensions', async () => {
    const chromeMock = mockChrome({ tab: {} })
    const answer = await dispatch(call('browser_resize', { width: 800.9, height: 600.2 }))
    expect(answer).toMatchObject({
      ok: true,
      result: { text: expect.stringContaining('Resized the window holding tab') },
    })
    expect(chromeMock.windowsUpdate).toHaveBeenCalledWith(2, { width: 800, height: 600 })
  })

  it('rejects out-of-range dimensions with bad-args', async () => {
    mockChrome({ tab: {} })
    const answer = await dispatch(call('browser_resize', { width: 0, height: 600 }))
    expect(answer).toMatchObject({ ok: false, error: { code: 'bad-args' } })
  })
})

describe('browser_viewport dispatch', () => {
  /** Drive the Emulation domain and record the methods the handler sends. */
  function mockEmulation(): ReturnType<typeof vi.fn> {
    const sendCommand = vi.fn(async (_target: { tabId: number }, _method: string, _params?: unknown) => ({}))
    mockChrome({
      tab: {},
      debuggerApi: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        sendCommand,
        onDetach: { addListener: () => undefined },
        onEvent: { addListener: () => undefined },
      },
    })
    return sendCommand
  }

  /** Methods one dispatch sent, in order, so an extra `*.enable` cannot hide. */
  function methods(sendCommand: ReturnType<typeof vi.fn>): unknown[] {
    return sendCommand.mock.calls.map((call) => call[1])
  }

  it('applies a mobile viewport override without enabling the Emulation domain', async () => {
    const sendCommand = mockEmulation()
    const answer = await dispatch(call('browser_viewport', { width: 390.9, height: 844, device_scale_factor: 3, mobile: true }))
    expect(answer.ok).toBe(true)
    // Emulation exposes no `enable` command; any such call fails on a real browser.
    expect(methods(sendCommand)).toEqual(['Emulation.setDeviceMetricsOverride'])
    expect(sendCommand).toHaveBeenCalledWith(
      expect.anything(),
      'Emulation.setDeviceMetricsOverride',
      { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
    )
    expect((answer.result as { text: string }).text).toContain('390x844 mobile viewport')
  })

  it('emulates a desktop viewport by default and keeps the page scale when omitted', async () => {
    const sendCommand = mockEmulation()
    await dispatch(call('browser_viewport', { width: 1280, height: 800 }))
    expect(sendCommand).toHaveBeenCalledWith(
      expect.anything(),
      'Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 800, deviceScaleFactor: 0, mobile: false },
    )
  })

  it('reports nothing to clear when no debugger session was attached', async () => {
    const sendCommand = mockEmulation()
    const answer = await dispatch(call('browser_viewport', { reset: true }))
    expect(answer.ok).toBe(true)
    // Clearing must not attach a debugger (and show its infobar) just to undo nothing.
    expect(methods(sendCommand)).toEqual([])
    expect((answer.result as { text: string }).text).toContain('nothing changed')
  })

  it('clears an applied override with reset', async () => {
    const sendCommand = mockEmulation()
    await dispatch(call('browser_viewport', { width: 800, height: 600 }))
    sendCommand.mockClear()
    const answer = await dispatch(call('browser_viewport', { reset: true }))
    expect(answer.ok).toBe(true)
    expect(methods(sendCommand)).toEqual(['Emulation.clearDeviceMetricsOverride'])
    expect(sendCommand).toHaveBeenCalledWith(expect.anything(), 'Emulation.clearDeviceMetricsOverride', {})
  })

  it('rejects reset combined with a size', async () => {
    const sendCommand = mockEmulation()
    const answer = await dispatch(call('browser_viewport', { reset: true, width: 800, height: 600 }))
    expect(answer).toMatchObject({ ok: false, error: { code: 'bad-args' } })
    expect(sendCommand).not.toHaveBeenCalled()
  })

  it('rejects out-of-range sizes and scales before touching the debugger', async () => {
    const sendCommand = mockEmulation()
    expect(await dispatch(call('browser_viewport', { width: 0, height: 800 })))
      .toMatchObject({ ok: false, error: { code: 'bad-args' } })
    expect(await dispatch(call('browser_viewport', { width: 800, height: 600, device_scale_factor: 9 })))
      .toMatchObject({ ok: false, error: { code: 'bad-args' } })
    expect(sendCommand).not.toHaveBeenCalled()
  })
})

describe('browser_pdf dispatch', () => {
  it('returns the printed bytes to the bridge', async () => {
    const sendCommand = vi.fn(async (_target: { tabId: number }, method: string) => (
      method === 'Page.printToPDF' ? { data: 'JVBERi0xLjQK' } : {}
    ))
    mockChrome({
      tab: {},
      debuggerApi: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        sendCommand,
        onDetach: { addListener: () => undefined },
        onEvent: { addListener: () => undefined },
      },
    })
    const answer = await dispatch(call('browser_pdf', { landscape: true }))
    expect(answer.ok).toBe(true)
    const result = answer.result as { text: string; pdf: { base64: string } }
    expect(result.pdf.base64).toBe('JVBERi0xLjQK')
    expect(result.text).toContain('landscape')
    expect(sendCommand).toHaveBeenCalledWith(
      expect.anything(),
      'Page.printToPDF',
      expect.objectContaining({ landscape: true, printBackground: true, preferCSSPageSize: true }),
    )
  })

  it('treats an empty print result as an action failure, not a debugger problem', async () => {
    const sendCommand = vi.fn(async (_target: { tabId: number }, method: string) => (
      method === 'Page.printToPDF' ? {} : {}
    ))
    mockChrome({
      tab: {},
      debuggerApi: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        sendCommand,
        onDetach: { addListener: () => undefined },
        onEvent: { addListener: () => undefined },
      },
    })
    const answer = await dispatch(call('browser_pdf', {}))
    expect(answer).toMatchObject({ ok: false, error: { code: 'action-failed' } })
    expect((answer.error as { message: string }).message).toMatch(/empty PDF/)
  })

  it('refuses a print above the wire budget', async () => {
    const oversized = 'A'.repeat(8 * 1024 * 1024 + 4)
    const sendCommand = vi.fn(async (_target: { tabId: number }, method: string) => (
      method === 'Page.printToPDF' ? { data: oversized } : {}
    ))
    mockChrome({
      tab: {},
      debuggerApi: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        sendCommand,
        onDetach: { addListener: () => undefined },
        onEvent: { addListener: () => undefined },
      },
    })
    const answer = await dispatch(call('browser_pdf', {}))
    expect(answer).toMatchObject({ ok: false, error: { code: 'action-failed' } })
    expect((answer.error as { message: string }).message).toMatch(/wire budget/)
  })

  it('reports debugger-unavailable without a debugger', async () => {
    mockChrome({ tab: {} })
    const answer = await dispatch(call('browser_pdf', {}))
    expect(answer).toMatchObject({ ok: false, error: { code: 'debugger-unavailable' } })
  })
})

describe('browser_screenshot dispatch', () => {
  it('reports debugger-unavailable for an inactive tab in the fallback path', async () => {
    mockChrome({ tab: { active: false } })
    const answer = await dispatch(call('browser_screenshot', {}))
    expect(answer).toMatchObject({ ok: false, error: { code: 'debugger-unavailable' } })
    expect((answer.error as { message: string }).message).toMatch(/active tab/i)
  })

  it('rejects an invalid region with bad-args', async () => {
    mockChrome({ tab: {} })
    const answer = await dispatch(call('browser_screenshot', { region: [10, 10, 10, 30] }))
    expect(answer).toMatchObject({ ok: false, error: { code: 'bad-args' } })
  })

  /** Drive the CDP screenshot path with a fixed viewport and payload. */
  function mockCdpScreenshot(): ReturnType<typeof vi.fn> {
    const sendCommand = vi.fn(async (_target: { tabId: number }, method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: JSON.stringify({ viewportWidth: 800, viewportHeight: 600, scrollX: 0, scrollY: 0, dpr: 1 }) } }
      }
      if (method === 'Page.captureScreenshot') return { data: 'QUJD' }
      return {}
    })
    mockChrome({
      tab: {},
      debuggerApi: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        sendCommand,
        onDetach: { addListener: () => undefined },
        onEvent: { addListener: () => undefined },
      },
    })
    return sendCommand
  }

  it('returns the image bytes by default', async () => {
    mockCdpScreenshot()
    const answer = await dispatch(call('browser_screenshot', {}))
    expect(answer.ok).toBe(true)
    const result = answer.result as { image: Record<string, unknown>; text: string }
    expect(result.image).toEqual({ base64: 'QUJD', mimeType: 'image/jpeg', width: 800, height: 600 })
    expect(result.text).toContain('JPEG quality 80 (requested)')
    expect(result.text).not.toContain('Not saved')
  })

  it('measures without transferring image bytes when save=false', async () => {
    mockCdpScreenshot()
    const answer = await dispatch(call('browser_screenshot', { save: false }))
    expect(answer.ok).toBe(true)
    const result = answer.result as { image: Record<string, unknown>; text: string; frame: { dpr: number } }
    expect(result.image).toEqual({ mimeType: 'image/jpeg', width: 800, height: 600 })
    expect(result.image).not.toHaveProperty('base64')
    expect(result.frame.dpr).toBe(1)
    expect(result.text).toContain('Not saved (save=false)')
  })
})

describe('browser_evaluate policy attribution', () => {
  it('reports a CSP refusal as action-failed rather than debugger-unavailable', async () => {
    mockChrome({
      tab: {},
      executeScriptError: new Error(`Refused to evaluate a string as JavaScript because this document requires Content Security Policy directive: "script-src 'self'".`),
    })
    const answer = await dispatch(call('browser_evaluate', { code: '1 + 1' }))
    expect(answer).toMatchObject({ ok: false, error: { code: 'action-failed' } })
    expect((answer.error as { message: string }).message).toMatch(/security policy/i)
    expect((answer.error as { message: string }).message).toMatch(/browser_snapshot/)
  })

  it('keeps debugger-unavailable for a missing debugger with an unrelated fallback failure', async () => {
    mockChrome({ tab: {}, executeScriptError: new Error('The tab was closed.') })
    const answer = await dispatch(call('browser_evaluate', { code: '1 + 1' }))
    expect(answer).toMatchObject({ ok: false, error: { code: 'debugger-unavailable' } })
  })
})

describe('browser_console and browser_network fallbacks', () => {
  it('injects the page hook on demand and labels the captured stream', async () => {
    const chromeMock = mockChrome({ tab: {} })
    const consoleAnswer = await dispatch(call('browser_console', {}))
    expect(consoleAnswer.ok).toBe(true)
    expect((consoleAnswer.result as { text: string }).text).toContain('(captured by page-side hook')
    expect(chromeMock.executeScript).toHaveBeenCalledWith(expect.objectContaining({ world: 'MAIN' }))

    const networkAnswer = await dispatch(call('browser_network', {}))
    expect(networkAnswer.ok).toBe(true)
    expect((networkAnswer.result as { text: string }).text).toContain('(captured by page-side hook')
  })

  it('uses CDP telemetry when the debugger is available', async () => {
    const sendCommand = vi.fn(async () => ({}))
    const chromeMock = mockChrome({
      tab: {},
      debuggerApi: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        sendCommand,
        onDetach: { addListener: () => undefined },
        onEvent: { addListener: () => undefined },
      },
    })
    const answer = await dispatch(call('browser_console', {}))
    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).not.toContain('page-side hook')
    expect(chromeMock.executeScript).not.toHaveBeenCalled()
  })

  it('reports a zero clear when the buffer is already empty', async () => {
    mockChrome({ tab: {} })
    const answer = await dispatch(call('browser_console', { clear: true }))
    expect((answer.result as { text: string }).text).toBe('Cleared 0 console message(s) for this tab.')
  })

  it('returns the messages it read before discarding them on clear', async () => {
    mockChrome({ tab: {} })
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab.id === undefined) throw new Error('mock tab has no id')
    recordInstrumentEntry(tab.id, { kind: 'console', type: 'error', text: 'before clear', url: 'https://example.com/', timestamp: 5 })

    const answer = await dispatch(call('browser_console', { clear: true }))
    const text = (answer.result as { text: string }).text
    expect(text).toContain('before clear')
    expect(text).toContain('returned 1 of 1 matching, then cleared all 1 buffered message(s)')
    const after = await dispatch(call('browser_console', {}))
    expect((after.result as { text: string }).text).toContain('No console messages found')
  })

  it('reports how many matching messages a limited clear returned', async () => {
    mockChrome({ tab: {} })
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab.id === undefined) throw new Error('mock tab has no id')
    recordInstrumentEntry(tab.id, { kind: 'console', type: 'log', text: 'first matching', url: 'https://example.com/', timestamp: 5 })
    recordInstrumentEntry(tab.id, { kind: 'console', type: 'log', text: 'second matching', url: 'https://example.com/', timestamp: 6 })

    const answer = await dispatch(call('browser_console', { clear: true, limit: 1 }))
    const text = (answer.result as { text: string }).text
    expect(text).toContain('second matching')
    expect(text).toContain('returned 1 of 2 matching, then cleared all 2 buffered message(s)')
  })

  it('names a filter that matched nothing while still clearing', async () => {
    mockChrome({ tab: {} })
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab.id === undefined) throw new Error('mock tab has no id')
    recordInstrumentEntry(tab.id, { kind: 'console', type: 'log', text: 'unrelated', url: 'https://example.com/', timestamp: 5 })

    const answer = await dispatch(call('browser_console', { clear: true, pattern: 'needle' }))
    expect((answer.result as { text: string }).text).toContain('Cleared 0 matching console message(s); returned 0 of 0 matching, then cleared all 1 buffered message(s)')
    const after = await dispatch(call('browser_console', {}))
    expect((after.result as { text: string }).text).toContain('No console messages found')
  })

  it('returns the requests it read before discarding them on clear', async () => {
    mockChrome({ tab: {} })
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab.id === undefined) throw new Error('mock tab has no id')
    recordInstrumentEntry(tab.id, { kind: 'network', url: 'https://example.com/api', method: 'GET', status: 200, timestamp: 5 })

    const answer = await dispatch(call('browser_network', { clear: true }))
    const text = (answer.result as { text: string }).text
    expect(text).toContain('https://example.com/api')
    expect(text).toContain('returned 1 of 1 matching, then cleared all 1 buffered request(s)')
    const after = await dispatch(call('browser_network', {}))
    expect((after.result as { text: string }).text).toContain('No network requests found')
  })
})

describe('element-addressed tools require a snapshot baseline', () => {
  it('refuses browser_select without a current snapshot', async () => {
    const chromeMock = mockChrome({ tab: {} })
    const answer = await dispatch(call('browser_select', { index: 3, value: 'a' }))
    expect(answer).toMatchObject({ ok: false, error: { code: 'content-unavailable' } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('refuses browser_hover addressed by index without a current snapshot', async () => {
    const chromeMock = mockChrome({ tab: {} })
    const answer = await dispatch(call('browser_hover', { index: 4 }))
    expect(answer).toMatchObject({ ok: false, error: { code: 'content-unavailable' } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('allows coordinate-addressed hover without a snapshot', async () => {
    const fill = mockFillResponse({ ok: true, result: { text: 'Hovered at (5, 6).' } })
    const answer = await dispatch(call('browser_hover', { x: 5, y: 6 }))
    expect(answer.ok).toBe(true)
    expect(fill.sendMessage).toHaveBeenCalledOnce()
  })
})

/** Mock a successful content-script answer for element tools. */
function mockFillResponse(answer: unknown): { sendMessage: ReturnType<typeof vi.fn> } {
  const tab = {
    id: nextTabId(),
    windowId: 2,
    active: true,
    url: 'https://example.com/form',
    title: 'Form',
  } as chrome.tabs.Tab
  const sendMessage = vi.fn(async () => answer)
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => [tab]),
      get: vi.fn(async () => tab),
      sendMessage,
    },
    webNavigation: {
      getAllFrames: vi.fn(async () => [{ frameId: 0, parentFrameId: -1, documentId: 'doc', url: tab.url }]),
    },
    scripting: { executeScript: vi.fn(async () => [{ frameId: 0, result: undefined }]) },
    runtime: { id: 'test-extension' },
  })
  return { sendMessage }
}

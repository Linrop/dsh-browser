// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CDP_DRAG_STEPS,
  DEBUGGER_PROTOCOL_VERSION,
  DebuggerUnavailableError,
  IDLE_DETACH_MS,
  JsResultNotSerializableError,
  MAX_ARRAY_ITEMS,
  MAX_LOGS_PER_TAB,
  MAX_REQUESTS_PER_TAB,
  MAX_SCREENSHOT_BASE64,
  NativeDragUnavailableError,
  ScreenshotTooLargeError,
  captureScreenshot,
  captureVisibleTabScreenshot,
  clickPointer,
  detachTab,
  dragPointer,
  ensureAttached,
  modifierMask,
  movePointer,
  evaluateInPage,
  forgetTab,
  formatConsoleMessages,
  formatEvaluationResult,
  formatNetworkRequests,
  handleDebuggerEvent,
  installPageInstrumentation,
  isDebuggerAvailable,
  noteTabNavigation,
  parseKeyStroke,
  pressKey,
  pushConsoleEntry,
  readConsoleMessages,
  readNetworkRequests,
  recordInstrumentEntry,
  redactHeaders,
  redactModelText,
  redactUrlForModel,
  seedTelemetryDomain,
  startConsoleCapture,
  type CapturedNetworkRequest,
  type ScreenshotOptions,
} from '../src/background/cdp.ts'

type DetachListener = (source: { tabId?: number }, reason: string) => void
type EventListener = (source: { tabId?: number }, method: string, params?: object) => void

const detachListeners: DetachListener[] = []
const eventListeners: EventListener[] = []
let attachBehavior: (() => Promise<void>) | undefined
let sendCommandBehavior: ((method: string, params?: object) => Promise<object>) | undefined

const debuggerApi = {
  attach: vi.fn(async () => {
    if (attachBehavior !== undefined) await attachBehavior()
  }),
  detach: vi.fn(async () => undefined),
  sendCommand: vi.fn(async (_target: { tabId: number }, method: string, params?: object) => {
    if (sendCommandBehavior !== undefined) return await sendCommandBehavior(method, params)
    return {}
  }),
  onDetach: {
    addListener: (listener: DetachListener) => { detachListeners.push(listener) },
  },
  onEvent: {
    addListener: (listener: EventListener) => { eventListeners.push(listener) },
  },
}

const DEFAULT_OPTIONS: ScreenshotOptions = { scale: 1, format: 'jpeg', quality: 80 }

let nextTabId = 100

function tabId(): number {
  nextTabId += 1
  return nextTabId
}

function stubChrome(overrides: { tabs?: Record<string, unknown>; scripting?: Record<string, unknown> } = {}): void {
  vi.stubGlobal('chrome', {
    debugger: debuggerApi,
    tabs: {
      get: vi.fn(async (id: number) => ({ id, windowId: 1, active: true })),
      captureVisibleTab: vi.fn(async () => 'data:image/jpeg;base64,AAAA'),
      ...overrides.tabs,
    },
    scripting: {
      executeScript: vi.fn(async () => [{ frameId: 0, result: undefined }]),
      ...overrides.scripting,
    },
  })
}

beforeEach(() => {
  attachBehavior = undefined
  sendCommandBehavior = undefined
  debuggerApi.attach.mockClear()
  debuggerApi.detach.mockClear()
  debuggerApi.sendCommand.mockClear()
  stubChrome()
})

afterEach(async () => {
  await detachTab(nextTabId)
  vi.unstubAllGlobals()
})

describe('debugger capability and attachment', () => {
  it('reports unavailable without chrome.debugger instead of throwing', async () => {
    vi.stubGlobal('chrome', {})
    expect(isDebuggerAvailable()).toBe(false)
    await expect(ensureAttached(tabId())).rejects.toBeInstanceOf(DebuggerUnavailableError)
  })

  it('attaches lazily once per tab at protocol 1.3', async () => {
    const id = tabId()
    expect(isDebuggerAvailable()).toBe(true)
    await ensureAttached(id)
    await ensureAttached(id)
    expect(debuggerApi.attach).toHaveBeenCalledTimes(1)
    expect(debuggerApi.attach).toHaveBeenCalledWith({ tabId: id }, DEBUGGER_PROTOCOL_VERSION)
    await detachTab(id)
  })

  it('maps an occupied target to debugger-unavailable', async () => {
    const error = new Error('Another debugger is already attached to the tab with id: 7.')
    debuggerApi.attach.mockRejectedValueOnce(error)
    const failure = ensureAttached(tabId())
    await expect(failure).rejects.toBeInstanceOf(DebuggerUnavailableError)
    await expect(failure).rejects.toThrow(/already attached/i)
  })

  it('clears state on user cancellation and refuses to reattach that document', async () => {
    const id = tabId()
    await ensureAttached(id)
    expect(detachListeners.length).toBeGreaterThan(0)
    for (const listener of detachListeners) listener({ tabId: id }, 'canceled_by_user')
    await expect(ensureAttached(id)).rejects.toBeInstanceOf(DebuggerUnavailableError)
    // A committed navigation is a new document, where the notice may be offered again.
    noteTabNavigation(id, 'https://example.com/next')
    await ensureAttached(id)
    await detachTab(id)
  })

  it('keeps a cancelled tab readable through the fallback buffers after detach', () => {
    const id = tabId()
    seedTelemetryDomain(id, 'https://example.com/')
    recordInstrumentEntry(id, { kind: 'console', type: 'log', text: 'before detach', url: 'https://example.com/', timestamp: 1 })
    for (const listener of eventListeners) listener({ tabId: id }, 'Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ value: 'from cdp' }],
      timestamp: 2,
    })
    expect(readConsoleMessages(id).messages.map((message) => message.text)).toEqual(['before detach', 'from cdp'])
    forgetTab(id)
  })

  it('routes protocol events into the telemetry buffers', () => {
    const id = tabId()
    handleDebuggerEvent(id, 'Runtime.consoleAPICalled', { type: 'warn', args: [{ value: 'careful' }], timestamp: 1 })
    expect(readConsoleMessages(id).messages[0]).toMatchObject({ type: 'warn', text: 'careful' })
    forgetTab(id)
  })
})

describe('browser_evaluate over CDP', () => {
  it('retries an illegal top-level return as an async IIFE', async () => {
    const calls: Array<{ expression: string; replMode: boolean }> = []
    sendCommandBehavior = async (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      const record = params as { expression: string; replMode: boolean }
      calls.push(record)
      if (calls.length === 1) {
        return {
          exceptionDetails: {
            text: 'Uncaught SyntaxError',
            exception: { description: 'SyntaxError: Illegal return statement' },
          },
        }
      }
      return { result: { value: 42 } }
    }
    const outcome = await evaluateInPage(tabId(), 'return 21 * 2', true)
    expect(outcome).toEqual({ value: 42 })
    expect(calls[1]?.expression).toContain('(async () => {')
    expect(calls[1]?.replMode).toBe(false)
  })

  it('renders thrown exceptions and execution timeouts as model text', async () => {
    sendCommandBehavior = async (method) => {
      if (method !== 'Runtime.evaluate') return {}
      return { exceptionDetails: { exception: { description: 'ReferenceError: nope is not defined' } } }
    }
    expect(await evaluateInPage(tabId(), 'nope', true)).toEqual({ exception: 'JavaScript execution error: ReferenceError: nope is not defined' })

    sendCommandBehavior = async (method) => {
      if (method !== 'Runtime.evaluate') return {}
      return { exceptionDetails: { text: 'Execution timed out' } }
    }
    expect(await evaluateInPage(tabId(), 'while (true) {}', true)).toEqual({
      exception: 'Execution timeout: code exceeded 30-second limit',
    })
  })

  it('maps a serialization failure to js-result-not-serializable', async () => {
    sendCommandBehavior = async (method) => {
      if (method !== 'Runtime.evaluate') return {}
      throw new Error('Object reference chain is too long')
    }
    await expect(evaluateInPage(tabId(), 'return window', true)).rejects.toBeInstanceOf(JsResultNotSerializableError)
  })

  it('enables Runtime before evaluating', async () => {
    const methods: string[] = []
    sendCommandBehavior = async (method) => {
      methods.push(method)
      if (method === 'Runtime.evaluate') return { result: { value: 1 } }
      return {}
    }
    await evaluateInPage(tabId(), '1', false)
    expect(methods).toContain('Runtime.enable')
    expect(methods).toContain('Runtime.evaluate')
  })
})

describe('evaluate credential redaction', () => {
  it('blocks sensitive keys, cookies, query strings, and token shapes', () => {
    const circular: Record<string, unknown> = { note: 'ok' }
    circular.self = circular
    const output = formatEvaluationResult({
      value: {
        password: 'hunter2',
        Cookie: 'a=b; c=d',
        nested: { api_key: 'secret', private_key: 'k', sessionId: 's' },
        query: 'a=1&b=2',
        jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
        base64: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqaw==',
        hex: 'ab12cd34ef56ab78cd90ef12ab34cd56',
        long: 'word '.repeat(250),
        circular,
      },
    })
    expect(output).toContain('[BLOCKED: Sensitive key]')
    expect(output).toContain('[BLOCKED: Cookie access]')
    expect(output).toContain('[BLOCKED: Cookie/query string data]')
    expect(output).toContain('[BLOCKED: jwt data]')
    expect(output).toContain('[BLOCKED: base64 data]')
    expect(output).toContain('[BLOCKED: hex data]')
    expect(output).toContain('…[truncated]')
    expect(output).toContain('[Circular]')
    expect(output).not.toContain('hunter2')
  })

  it('caps array length and traversal depth', () => {
    const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } }
    const output = formatEvaluationResult({ value: { items: Array.from({ length: MAX_ARRAY_ITEMS + 10 }, (_, index) => index), deep } })
    expect(output).toContain(`[TRUNCATED: 10 more items]`)
    expect(output).toContain('[TRUNCATED: max depth]')
  })

  it('renders undefined and function descriptions', () => {
    expect(formatEvaluationResult({ value: undefined })).toBe('Result: "undefined"')
    expect(formatEvaluationResult({ description: 'function demo() {}' })).toBe('Result: "function demo() {}"')
  })

  it('shares the text rule with console output', () => {
    expect(redactModelText('token=abc123&user=1')).toBe('[BLOCKED: Cookie/query string data]')
    const output = formatConsoleMessages([{ type: 'log', text: 'auth=Bearer x; y', timestamp: 0 }])
    expect(output).toContain('[BLOCKED: Cookie/query string data]')
  })
})

describe('console buffer', () => {
  it('records console calls, exceptions, and log entries', () => {
    const id = tabId()
    handleDebuggerEvent(id, 'Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ value: 'hello' }, { description: 'Object' }],
      stackTrace: { callFrames: [{ functionName: 'go', url: 'https://example.com/app.js', lineNumber: 2, columnNumber: 4 }] },
      timestamp: 1_000,
    })
    handleDebuggerEvent(id, 'Runtime.exceptionThrown', {
      exceptionDetails: {
        text: 'Uncaught',
        exception: { description: 'Error: boom' },
        stackTrace: { callFrames: [{ functionName: 'explode', url: 'https://example.com/app.js', lineNumber: 9, columnNumber: 1 }] },
      },
      timestamp: 2_000,
    })
    handleDebuggerEvent(id, 'Log.entryAdded', {
      entry: { level: 'error', text: 'network down', url: 'https://example.com/net', lineNumber: 12, timestamp: 3_000 },
    })
    const { messages, total } = readConsoleMessages(id)
    expect(total).toBe(3)
    expect(messages[0]).toMatchObject({ type: 'log', text: 'hello Object', url: 'https://example.com/app.js', line: 3, column: 5 })
    expect(messages[1]?.type).toBe('exception')
    expect(messages[1]?.text).toContain('Error: boom')
    expect(messages[1]?.text).toContain('    at explode (https://example.com/app.js:10:2)')
    expect(messages[2]).toMatchObject({ type: 'error', text: 'network down' })
    const text = formatConsoleMessages(messages)
    expect(text).toContain('Found 3 console messages:')
    expect(text).toContain('[ERROR]')
    forgetTab(id)
  })

  it('keeps console history across an idle detach and reattach', async () => {
    vi.useFakeTimers()
    try {
      const id = tabId()
      await startConsoleCapture(id, 'https://example.com/')
      handleDebuggerEvent(id, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'page load' }], timestamp: 1 })
      handleDebuggerEvent(id, 'Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com/app.js', method: 'GET' },
        timestamp: 2,
      })
      await vi.advanceTimersByTimeAsync(IDLE_DETACH_MS)
      expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: id })
      await ensureAttached(id)
      expect(readConsoleMessages(id).messages.map((message) => message.text)).toEqual(['page load'])
      expect(readNetworkRequests(id).requests.map((request) => request.url)).toEqual(['https://example.com/app.js'])
      await detachTab(id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats our own detach reported as canceled_by_user as no dismissal', async () => {
    const id = tabId()
    await startConsoleCapture(id, 'https://example.com/')
    handleDebuggerEvent(id, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'kept' }], timestamp: 1 })
    await detachTab(id)
    // Chrome reports an extension-initiated detach as canceled_by_user too.
    for (const listener of detachListeners) listener({ tabId: id }, 'canceled_by_user')
    expect(readConsoleMessages(id).messages.map((message) => message.text)).toEqual(['kept'])
    // The tab is still attachable, so the next console call keeps using CDP.
    await ensureAttached(id)
    await detachTab(id)
  })

  it('clears console and network history when the tab closes', () => {
    const id = tabId()
    seedTelemetryDomain(id, 'https://example.com/')
    handleDebuggerEvent(id, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'gone' }], timestamp: 1 })
    handleDebuggerEvent(id, 'Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://example.com/a', method: 'GET' },
      timestamp: 2,
    })
    forgetTab(id)
    expect(readConsoleMessages(id).total).toBe(0)
    expect(readNetworkRequests(id).total).toBe(0)
  })

  it('clears on a domain change but keeps the same domain across reloads', () => {
    const id = tabId()
    seedTelemetryDomain(id, 'https://example.com/page')
    handleDebuggerEvent(id, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'first' }], timestamp: 1 })
    noteTabNavigation(id, 'https://example.com/reload')
    expect(readConsoleMessages(id).total).toBe(1)
    noteTabNavigation(id, 'https://other.example.org/page')
    expect(readConsoleMessages(id).total).toBe(0)
    forgetTab(id)
  })

  it('filters by only_errors and pattern with a literal fallback', () => {
    const id = tabId()
    handleDebuggerEvent(id, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'plain note' }], timestamp: 1 })
    handleDebuggerEvent(id, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'Boom happened' }], timestamp: 2 })
    handleDebuggerEvent(id, 'Runtime.exceptionThrown', { exceptionDetails: { exception: { description: 'Error: thrown' } }, timestamp: 3 })
    expect(readConsoleMessages(id, { onlyErrors: true }).total).toBe(2)
    expect(readConsoleMessages(id, { pattern: 'boom' }).total).toBe(1)
    expect(readConsoleMessages(id, { pattern: '(' }).total).toBe(0)
    forgetTab(id)
  })

  it('caps the buffer at MAX_LOGS_PER_TAB from the head', () => {
    const id = tabId()
    for (let index = 0; index <= MAX_LOGS_PER_TAB; index += 1) {
      handleDebuggerEvent(id, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: `m${index}` }], timestamp: index })
    }
    const read = readConsoleMessages(id, { limit: 1 })
    expect(read.total).toBe(MAX_LOGS_PER_TAB)
    expect(read.messages[0]?.text).toBe(`m${MAX_LOGS_PER_TAB}`)
    forgetTab(id)
  })

  it('does not duplicate Log history replayed by a reattach', async () => {
    const id = tabId()
    const history = [
      { level: 'error', text: 'first replayed entry', url: 'https://example.com/a.js', lineNumber: 3, timestamp: 10 },
      { level: 'warning', text: 'second replayed entry', url: 'https://example.com/a.js', lineNumber: 7, timestamp: 11 },
    ]
    await startConsoleCapture(id, 'https://example.com/')
    for (const entry of history) handleDebuggerEvent(id, 'Log.entryAdded', { entry })
    expect(readConsoleMessages(id).total).toBe(2)
    // An idle detach followed by a reattach re-enables Log, which replays the
    // same history with its original timestamps.
    await detachTab(id)
    await startConsoleCapture(id, 'https://example.com/')
    for (const entry of history) handleDebuggerEvent(id, 'Log.entryAdded', { entry })
    expect(readConsoleMessages(id).messages.map((message) => message.text))
      .toEqual(['first replayed entry', 'second replayed entry'])
    await detachTab(id)
  })

  it('adds only the new entry when a replayed history arrives with one new line', async () => {
    const id = tabId()
    const replayed = { level: 'error', text: 'history line', url: 'https://example.com/a.js', lineNumber: 3, timestamp: 10 }
    handleDebuggerEvent(id, 'Log.entryAdded', { entry: replayed })
    handleDebuggerEvent(id, 'Log.entryAdded', { entry: replayed })
    handleDebuggerEvent(id, 'Log.entryAdded', {
      entry: { level: 'error', text: 'fresh line', url: 'https://example.com/a.js', lineNumber: 4, timestamp: 12 },
    })
    expect(readConsoleMessages(id).messages.map((message) => message.text)).toEqual(['history line', 'fresh line'])
    forgetTab(id)
  })

  it('does not duplicate Runtime console history replayed by a reattach', () => {
    const id = tabId()
    const replayed = { type: 'log', args: [{ value: 'runtime history' }], timestamp: 42 }
    handleDebuggerEvent(id, 'Runtime.consoleAPICalled', replayed)
    handleDebuggerEvent(id, 'Runtime.consoleAPICalled', replayed)
    expect(readConsoleMessages(id).total).toBe(1)
    forgetTab(id)
  })

  it('accepts a later genuine occurrence of the same text at a new timestamp', () => {
    const id = tabId()
    handleDebuggerEvent(id, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'tick' }], timestamp: 1 })
    handleDebuggerEvent(id, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'tick' }], timestamp: 2 })
    expect(readConsoleMessages(id).total).toBe(2)
    forgetTab(id)
  })

  it('dedupes an unreplayed entry that carries no timestamp', () => {
    const id = tabId()
    const entry = { level: 'error', text: 'timestampless', url: 'https://example.com/a.js' }
    expect(pushConsoleEntry(id, { type: 'error', text: 'timestampless', url: 'https://example.com/a.js' })).toBe(true)
    expect(pushConsoleEntry(id, { type: 'error', text: 'timestampless', url: 'https://example.com/a.js' })).toBe(false)
    handleDebuggerEvent(id, 'Log.entryAdded', { entry })
    expect(readConsoleMessages(id).total).toBe(1)
    forgetTab(id)
  })

  it('bounds the dedupe identities so the oldest identity can be replayed again', () => {
    const id = tabId()
    const entry = (text: string, timestamp: number) => ({ type: 'log', text, url: 'https://example.com/', timestamp })
    expect(pushConsoleEntry(id, entry('one', 1), 2)).toBe(true)
    expect(pushConsoleEntry(id, entry('two', 2), 2)).toBe(true)
    expect(pushConsoleEntry(id, entry('three', 3), 2)).toBe(true)
    expect(pushConsoleEntry(id, entry('three', 3), 2)).toBe(false)
    // The identity of the oldest entry was evicted, so its replay buffers again.
    expect(pushConsoleEntry(id, entry('one', 1), 2)).toBe(true)
    expect(readConsoleMessages(id).total).toBe(4)
    forgetTab(id)
  })

  it('does not duplicate network requests when the same events are replayed', () => {
    const id = tabId()
    const request = { requestId: 'r1', request: { url: 'https://example.com/app.js', method: 'GET' }, timestamp: 1 }
    const response = { requestId: 'r1', response: { url: 'https://example.com/app.js', status: 200 }, timestamp: 2 }
    handleDebuggerEvent(id, 'Network.requestWillBeSent', request)
    handleDebuggerEvent(id, 'Network.responseReceived', response)
    handleDebuggerEvent(id, 'Network.requestWillBeSent', request)
    handleDebuggerEvent(id, 'Network.responseReceived', response)
    const read = readNetworkRequests(id)
    expect(read.total).toBe(1)
    expect(read.requests[0]).toMatchObject({ url: 'https://example.com/app.js', status: 200 })
    forgetTab(id)
  })

  it('reads and then clears, returning the messages it read', () => {
    const id = tabId()
    handleDebuggerEvent(id, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'a' }], timestamp: 1 })
    const read = readConsoleMessages(id, { clear: true })
    expect(read).toMatchObject({ total: 1, bufferTotal: 1, cleared: true })
    expect(read.messages.map((message) => message.text)).toEqual(['a'])
    expect(readConsoleMessages(id).total).toBe(0)
    forgetTab(id)
  })

  it('records the fallback instrumentation entries', () => {
    const id = tabId()
    recordInstrumentEntry(id, { kind: 'console', type: 'error', text: 'hook error', url: 'https://example.com/', timestamp: 5 })
    expect(readConsoleMessages(id, { onlyErrors: true }).messages[0]).toMatchObject({ type: 'error', text: 'hook error' })
    forgetTab(id)
  })
})

describe('network buffer', () => {
  function requestFor(requests: { requests: CapturedNetworkRequest[] }): CapturedNetworkRequest {
    return requests.requests[0]!
  }

  it('records method, status, and redacted headers without the post body', () => {
    const id = tabId()
    handleDebuggerEvent(id, 'Network.requestWillBeSent', {
      requestId: 'r1',
      request: {
        url: 'https://user:pass@example.com/a?token=planted&x=1',
        method: 'POST',
        headers: { Authorization: 'Bearer abc', cookie: 'sid=1', 'X-Custom': 'keep' },
        postData: '{"password":"hunter2"}',
      },
      timestamp: 10,
    })
    handleDebuggerEvent(id, 'Network.responseReceived', {
      requestId: 'r1',
      response: {
        status: 201,
        url: 'https://user:pass@example.com/a?token=planted&x=1',
        headers: { 'Set-Cookie': 'sid=2', 'Content-Type': 'application/json' },
      },
    })
    const request = requestFor(readNetworkRequests(id))
    expect(request.url).toBe('https://***:***@example.com/a?token=***&x=1')
    expect(request.method).toBe('POST')
    expect(request.status).toBe(201)
    expect(request.requestHeaders).toMatchObject({ Authorization: '***', cookie: '***', 'X-Custom': 'keep' })
    expect(request.responseHeaders).toMatchObject({ 'Set-Cookie': '***', 'Content-Type': 'application/json' })
    expect(request.postDataBytes).toBe(22)
    expect(JSON.stringify(request)).not.toContain('hunter2')
    expect(readNetworkRequests(id, { urlPattern: 'token=***' }).total).toBe(1)
    forgetTab(id)
  })

  it('marks failed requests as 503 but ignores aborted ones', () => {
    const id = tabId()
    handleDebuggerEvent(id, 'Network.requestWillBeSent', { requestId: 'a', request: { url: 'https://example.com/fail', method: 'GET' }, timestamp: 1 })
    handleDebuggerEvent(id, 'Network.loadingFailed', { requestId: 'a', errorText: 'net::ERR_FAILED', timestamp: 2 })
    handleDebuggerEvent(id, 'Network.requestWillBeSent', { requestId: 'b', request: { url: 'https://example.com/abort', method: 'GET' }, timestamp: 3 })
    handleDebuggerEvent(id, 'Network.loadingFailed', { requestId: 'b', errorText: 'net::ERR_ABORTED', canceled: true, timestamp: 4 })
    const { requests } = readNetworkRequests(id)
    expect(requests[0]).toMatchObject({ status: 503, errorText: 'net::ERR_FAILED' })
    expect(requests[1]).toMatchObject({ status: 0 })
    expect(requests[1]?.errorText).toBeUndefined()
    expect(formatNetworkRequests(requests)).toContain('   error: net::ERR_FAILED')
    forgetTab(id)
  })

  it('clears on a domain change and caps retained requests', () => {
    const id = tabId()
    seedTelemetryDomain(id, 'https://example.com/')
    for (let index = 0; index <= MAX_REQUESTS_PER_TAB; index += 1) {
      handleDebuggerEvent(id, 'Network.requestWillBeSent', {
        requestId: `r${index}`,
        request: { url: `https://example.com/${index}`, method: 'GET' },
        timestamp: index,
      })
    }
    expect(readNetworkRequests(id).total).toBe(MAX_REQUESTS_PER_TAB)
    noteTabNavigation(id, 'https://other.example/')
    expect(readNetworkRequests(id).total).toBe(0)
    forgetTab(id)
  })

  it('records instrumented fetch requests without bodies', () => {
    const id = tabId()
    recordInstrumentEntry(id, { kind: 'network', url: 'https://example.com/api?key=abc', method: 'GET', status: 200, timestamp: 1 })
    expect(requestFor(readNetworkRequests(id)).url).toBe('https://example.com/api?key=***')
    forgetTab(id)
  })

  it('renders redacted request lines', () => {
    const text = formatNetworkRequests([{ url: 'https://***:***@example.com/x', method: 'GET', status: 200, timestamp: 0 }])
    expect(text).toContain('Found 1 network request(s):')
    expect(text).toContain('1. url: https://***:***@example.com/x')
    expect(text).toContain('   statusCode: 200')
  })
})

describe('URL and header redaction helpers', () => {
  it('redacts userinfo and sensitive query parameters', () => {
    expect(redactUrlForModel('https://a:b@example.com/p?session=abc&ok=1')).toBe('https://***:***@example.com/p?session=***&ok=1')
    expect(redactUrlForModel('not a url')).toBe('not a url')
  })

  it('replaces credential header values only, matching name substrings', () => {
    expect(redactHeaders({
      Authorization: 'x',
      COOKIE: 'y',
      'proxy-authorization': 'z',
      'Set-Cookie': 'a',
      'x-goog-api-key': 'b',
      'x-auth-token': 'c',
      'x-csrf-token': 'd',
      'X-Custom-API-Key': 'e',
      'x-client-apikey': 'f',
      Accept: 'text/html',
      'content-type': 'application/json',
    })).toEqual({
      Authorization: '***',
      COOKIE: '***',
      'proxy-authorization': '***',
      'Set-Cookie': '***',
      'x-goog-api-key': '***',
      'x-auth-token': '***',
      'x-csrf-token': '***',
      'X-Custom-API-Key': '***',
      'x-client-apikey': '***',
      Accept: 'text/html',
      'content-type': 'application/json',
    })
  })
})

describe('screenshot capture', () => {
  const metrics = { viewportWidth: 800, viewportHeight: 600, scrollX: 10, scrollY: 20, dpr: 2 }

  function mockScreenshot(handler: (params: Record<string, unknown>) => string): void {
    sendCommandBehavior = async (method, params) => {
      if (method === 'Runtime.evaluate') return { result: { value: JSON.stringify(metrics) } }
      if (method === 'Page.captureScreenshot') return { data: handler(params as Record<string, unknown>) }
      return {}
    }
  }

  it('captures the viewport with a scroll-aware clip and reports the frame', async () => {
    const captured: Record<string, unknown>[] = []
    mockScreenshot((params) => {
      captured.push(params)
      return 'QUJD'
    })
    const result = await captureScreenshot(tabId(), DEFAULT_OPTIONS)
    expect(captured[0]).toMatchObject({
      format: 'jpeg',
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 10, y: 20, width: 800, height: 600, scale: 1 },
    })
    expect(result.image).toMatchObject({ base64: 'QUJD', mimeType: 'image/jpeg', width: 1_600, height: 1_200 })
    expect(result.frame).toEqual({
      viewportWidth: 800,
      viewportHeight: 600,
      screenshotWidth: 1_600,
      screenshotHeight: 1_200,
      dpr: 2,
    })
    expect(result.quality).toEqual({ requested: 80, effective: 80, reduced: false })
  })

  it('places a region clip in page coordinates and applies scale', async () => {
    const captured: Record<string, unknown>[] = []
    mockScreenshot((params) => {
      captured.push(params)
      return 'QUJD'
    })
    const result = await captureScreenshot(tabId(), { ...DEFAULT_OPTIONS, region: [100, 50, 300, 150], scale: 0.5 })
    expect(captured[0]?.clip).toEqual({ x: 110, y: 70, width: 200, height: 100, scale: 0.5 })
    expect(result.frame.screenshotWidth).toBe(200)
    expect(result.frame.screenshotHeight).toBe(100)
  })

  it('drops to lower JPEG quality when the payload exceeds the wire budget', async () => {
    const qualities: Array<number | undefined> = []
    mockScreenshot((params) => {
      qualities.push(typeof params.quality === 'number' ? params.quality : undefined)
      if (params.format === 'jpeg' && params.quality === 80) return 'A'.repeat(MAX_SCREENSHOT_BASE64 + 1)
      return 'SMALL'
    })
    const result = await captureScreenshot(tabId(), DEFAULT_OPTIONS)
    expect(qualities).toContain(70)
    expect(result.image.base64).toBe('SMALL')
    expect(result.quality).toEqual({ requested: 80, effective: 70, reduced: true })
  })

  it('fails with action-failed when even the lowest quality is too large', async () => {
    mockScreenshot(() => 'A'.repeat(MAX_SCREENSHOT_BASE64 + 1))
    await expect(captureScreenshot(tabId(), DEFAULT_OPTIONS)).rejects.toBeInstanceOf(ScreenshotTooLargeError)
  })

  it('refuses a background tab in the visible-tab fallback', async () => {
    vi.stubGlobal('chrome', {
      debugger: debuggerApi,
      tabs: { get: vi.fn(async (id: number) => ({ id, windowId: 1, active: false })) },
      scripting: { executeScript: vi.fn(async () => []) },
    })
    await expect(captureVisibleTabScreenshot(tabId(), 1, DEFAULT_OPTIONS)).rejects.toBeInstanceOf(DebuggerUnavailableError)
  })

  it('wraps a captureVisibleTab failure as debugger-unavailable', async () => {
    vi.stubGlobal('chrome', {
      debugger: debuggerApi,
      tabs: {
        get: vi.fn(async (id: number) => ({ id, windowId: 1, active: true })),
        captureVisibleTab: vi.fn(async () => { throw new Error('No active window') }),
      },
      scripting: { executeScript: vi.fn(async () => []) },
    })
    const failure = captureVisibleTabScreenshot(tabId(), 1, DEFAULT_OPTIONS)
    await expect(failure).rejects.toBeInstanceOf(DebuggerUnavailableError)
    await expect(failure).rejects.toThrow(/The visible tab could not be captured: No active window/)
  })
})

describe('visible-tab screenshot fallback', () => {
  const metrics = { viewportWidth: 400, viewportHeight: 300, scrollX: 0, scrollY: 0, dpr: 2 }

  interface PipelineOptions {
    decoded: { width: number; height: number }
    metrics?: typeof metrics | undefined
    png?: boolean
  }

  function stubVisibleTab(options: PipelineOptions): {
    captureVisibleTab: ReturnType<typeof vi.fn>
    drawCalls: unknown[][]
    outputTypes: string[]
  } {
    const drawCalls: unknown[][] = []
    const outputTypes: string[] = []
    class FakeOffscreenCanvas {
      constructor(readonly width: number, readonly height: number) {}
      getContext(): { drawImage: (...args: unknown[]) => void } {
        return { drawImage: (...args: unknown[]) => { drawCalls.push(args) } }
      }
      async convertToBlob(blobOptions: { type: string }): Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }> {
        outputTypes.push(blobOptions.type)
        return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }
      }
    }
    const captureVisibleTab = vi.fn(async () => `data:image/${options.png === true ? 'png' : 'jpeg'};base64,QUJD`)
    const executeScript = vi.fn(async () => {
      if (options.metrics === undefined) throw new Error('Scripting is not available')
      return [{ result: JSON.stringify(options.metrics) }]
    })
    vi.stubGlobal('chrome', {
      debugger: debuggerApi,
      tabs: {
        get: vi.fn(async (id: number) => ({ id, windowId: 1, active: true })),
        captureVisibleTab,
      },
      scripting: { executeScript },
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob() })))
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: options.decoded.width, height: options.decoded.height, close: vi.fn() })))
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    return { captureVisibleTab, drawCalls, outputTypes }
  }

  it('decodes the active visible tab and reports the device-pixel frame', async () => {
    const { captureVisibleTab, drawCalls } = stubVisibleTab({ decoded: { width: 800, height: 600 }, metrics })
    const result = await captureVisibleTabScreenshot(tabId(), 1, DEFAULT_OPTIONS)
    expect(captureVisibleTab).toHaveBeenCalledWith(1, { format: 'jpeg', quality: 80 })
    expect(drawCalls).toEqual([])
    expect(result.image).toEqual({ base64: 'QUJD', mimeType: 'image/jpeg', width: 800, height: 600 })
    expect(result.frame).toEqual({
      viewportWidth: 400,
      viewportHeight: 300,
      screenshotWidth: 800,
      screenshotHeight: 600,
      dpr: 2,
    })
    expect(result.quality).toEqual({ requested: 80, effective: 80, reduced: false })
    expect(result.notes).toBeUndefined()
  })

  it('crops a region in device pixels, applies scale, and encodes png', async () => {
    const { captureVisibleTab, drawCalls, outputTypes } = stubVisibleTab({ decoded: { width: 800, height: 600 }, metrics, png: true })
    const result = await captureVisibleTabScreenshot(tabId(), 1, {
      region: [100, 50, 300, 150],
      scale: 0.5,
      format: 'png',
      quality: 80,
    })
    expect(captureVisibleTab).toHaveBeenCalledWith(1, { format: 'png' })
    expect(drawCalls[0]?.slice(1)).toEqual([200, 100, 400, 200, 0, 0, 200, 100])
    expect(outputTypes).toEqual(['image/png'])
    // The rendered canvas payload replaces the captured bytes.
    expect(result.image).toEqual({ base64: 'AQID', mimeType: 'image/png', width: 200, height: 100 })
    expect(result.frame.screenshotWidth).toBe(200)
  })

  it('notes the assumed device pixel ratio when the page cannot be measured', async () => {
    stubVisibleTab({ decoded: { width: 800, height: 600 }, metrics: undefined })
    const result = await captureVisibleTabScreenshot(tabId(), 1, DEFAULT_OPTIONS)
    expect(result.frame.dpr).toBe(1)
    expect(result.notes?.join(' ')).toMatch(/assumes devicePixelRatio 1/)
  })

  it('notes the ignored scale when the browser cannot re-encode the capture', async () => {
    stubVisibleTab({ decoded: { width: 800, height: 600 }, metrics })
    vi.stubGlobal('OffscreenCanvas', undefined)
    const result = await captureVisibleTabScreenshot(tabId(), 1, { ...DEFAULT_OPTIONS, scale: 0.5 })
    expect(result.image).toMatchObject({ width: 800, height: 600 })
    expect(result.notes?.join(' ')).toMatch(/ignores scale/)
  })
})

describe('capture entry points', () => {
  it('enables Runtime and Log for console capture and seeds the domain', async () => {
    const methods: string[] = []
    sendCommandBehavior = async (method) => {
      methods.push(method)
      return {}
    }
    const id = tabId()
    await startConsoleCapture(id, 'https://example.com/page')
    expect(methods).toEqual(expect.arrayContaining(['Runtime.enable', 'Log.enable']))
    handleDebuggerEvent(id, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'kept' }], timestamp: 1 })
    noteTabNavigation(id, 'https://example.com/again')
    expect(readConsoleMessages(id).total).toBe(1)
  })

  it('injects the MAIN-world hook through chrome.scripting only on demand', async () => {
    const executeScript = vi.fn(async () => [{ frameId: 0, result: undefined }])
    stubChrome({ scripting: { executeScript } })
    const id = tabId()
    await installPageInstrumentation(id, 'channel-123')
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: id, frameIds: [0] },
      world: 'MAIN',
      func: expect.any(Function),
      args: ['channel-123'],
    }))
  })
})

describe('debugger lifecycle races', () => {
  it('detaches a tab after the idle window without another tool call', async () => {
    vi.useFakeTimers()
    try {
      const id = tabId()
      await ensureAttached(id)
      expect(debuggerApi.detach).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(IDLE_DETACH_MS)
      expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: id })
      // The session was forgotten, so a later need attaches again.
      debuggerApi.attach.mockClear()
      await ensureAttached(id)
      expect(debuggerApi.attach).toHaveBeenCalledTimes(1)
      await detachTab(id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('discards an attach that finishes after a detach request', async () => {
    const id = tabId()
    let releaseAttach: (() => void) | undefined
    attachBehavior = () => new Promise<void>((resolve) => { releaseAttach = resolve })
    const pending = ensureAttached(id)
    let failure: unknown
    const settled = pending.catch((error: unknown) => { failure = error })
    // Let the attach start, then request a detach while it is still pending.
    await Promise.resolve()
    await detachTab(id)
    releaseAttach?.()
    await settled
    expect(failure).toBeInstanceOf(DebuggerUnavailableError)
    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: id })
  })
})

describe('real input through the Input domain', () => {
  function recordCommands(): Array<{ method: string; params: Record<string, unknown> }> {
    const commands: Array<{ method: string; params: Record<string, unknown> }> = []
    sendCommandBehavior = async (method, params) => {
      commands.push({ method, params: (params ?? {}) as Record<string, unknown> })
      return {}
    }
    return commands
  }

  it('maps modifier names to protocol bits', () => {
    expect(modifierMask(undefined)).toBe(0)
    expect(modifierMask('ctrl+shift')).toBe(2 | 8)
    expect(modifierMask('alt, cmd')).toBe(1 | 4)
    expect(modifierMask('hyper')).toBeUndefined()
  })

  it('moves the pointer with the modifier mask', async () => {
    const commands = recordCommands()
    const id = tabId()
    await movePointer(id, { x: 11, y: 22 }, modifierMask('alt')!)
    expect(commands).toContainEqual({
      method: 'Input.dispatchMouseEvent',
      params: expect.objectContaining({ type: 'mouseMoved', x: 11, y: 22, button: 'none', buttons: 0, modifiers: 1 }),
    })
    await detachTab(id)
  })

  it('clicks with the requested button and repeats with the click count', async () => {
    const commands = recordCommands()
    const id = tabId()
    await clickPointer(id, { x: 5, y: 6 }, { button: 'right', count: 2, modifiers: 0 })
    const pressed = commands.filter((command) => command.method === 'Input.dispatchMouseEvent' && command.params.type === 'mousePressed')
    expect(pressed.map((command) => command.params.clickCount)).toEqual([1, 2])
    expect(pressed[0]?.params).toMatchObject({ button: 'right', buttons: 2 })
    expect(commands.filter((command) => command.params.type === 'mouseReleased')).toHaveLength(2)
    await detachTab(id)
  })

  it('drags through five interpolated moves and releases at the destination', async () => {
    const commands = recordCommands()
    const id = tabId()
    expect(await dragPointer(id, { x: 0, y: 0 }, { x: 100, y: 50 })).toBe('mouse')
    const moves = commands.filter((command) => command.method === 'Input.dispatchMouseEvent' && command.params.type === 'mouseMoved')
    const draggedMoves = moves.filter((command) => command.params.buttons === 1)
    expect(draggedMoves).toHaveLength(CDP_DRAG_STEPS)
    expect(draggedMoves.at(-1)?.params).toMatchObject({ x: 100, y: 50 })
    const released = commands.at(-1)
    expect(released?.params).toMatchObject({ type: 'mouseReleased', x: 100, y: 50, button: 'left', buttons: 0 })
    await detachTab(id)
  })

  it('drags a native DnD target with press, dragEnter, dragOver, drop, and release', async () => {
    const commands = recordCommands()
    const id = tabId()
    expect(await dragPointer(id, { x: 0, y: 0 }, { x: 100, y: 50 }, { nativeDrag: true })).toBe('native')
    const dragEvents = commands.filter((command) => command.method === 'Input.dispatchDragEvent')
    expect(dragEvents.map((command) => command.params.type)).toEqual([
      'dragEnter',
      ...Array.from({ length: CDP_DRAG_STEPS }, () => 'dragOver'),
      'drop',
    ])
    expect(dragEvents[0]?.params).toMatchObject({ x: 0, y: 0 })
    expect(dragEvents.at(-1)?.params).toMatchObject({ type: 'drop', x: 100, y: 50 })
    // Every event carries payload the page reads through getData('text/plain').
    for (const event of dragEvents) {
      const data = event.params.data as { items: Array<{ mimeType: string; data: string }>; dragOperationsMask: number }
      expect(data.items).toEqual([{ mimeType: 'text/plain', data: expect.any(String) }])
      expect(data.items[0]?.data).not.toBe('')
      expect(data.dragOperationsMask).toBe(1)
    }
    const pressed = commands.findIndex((command) => command.method === 'Input.dispatchMouseEvent' && command.params.type === 'mousePressed')
    const firstDrag = commands.findIndex((command) => command.method === 'Input.dispatchDragEvent')
    expect(pressed).toBeGreaterThanOrEqual(0)
    expect(pressed).toBeLessThan(firstDrag)
    expect(commands.at(-1)?.params).toMatchObject({ type: 'mouseReleased', x: 100, y: 50 })
    await detachTab(id)
  })

  it('reports native drag events as unavailable when the protocol refuses them', async () => {
    sendCommandBehavior = async (method) => {
      if (method === 'Input.dispatchDragEvent') throw new Error("'Input.dispatchDragEvent' wasn't found")
      return {}
    }
    const id = tabId()
    await expect(dragPointer(id, { x: 1, y: 2 }, { x: 3, y: 4 }, { nativeDrag: true }))
      .rejects.toBeInstanceOf(NativeDragUnavailableError)
    await detachTab(id)
  })
})

describe('real key injection', () => {
  it('dispatches keyDown, char, and keyUp for a character', async () => {
    const commands: Array<{ method: string; params?: object }> = []
    sendCommandBehavior = async (method, params) => {
      commands.push({ method, params })
      return {}
    }
    const id = tabId()
    await pressKey(id, parseKeyStroke('a')!)
    const keyEvents = commands.filter((command) => command.method === 'Input.dispatchKeyEvent')
    expect(keyEvents.map((command) => (command.params as { type: string }).type)).toEqual(['keyDown', 'char', 'keyUp'])
    expect(keyEvents[0]?.params).toMatchObject({
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
    })
    expect(keyEvents[1]?.params).toMatchObject({ text: 'a', unmodifiedText: 'a' })
    await detachTab(id)
  })

  it('maps Tab to a keyDown and keyUp with its code and key code', async () => {
    const commands: Array<{ method: string; params?: object }> = []
    sendCommandBehavior = async (method, params) => {
      commands.push({ method, params })
      return {}
    }
    const id = tabId()
    await pressKey(id, parseKeyStroke('Tab')!)
    const keyEvents = commands.filter((command) => command.method === 'Input.dispatchKeyEvent')
    expect(keyEvents.map((command) => (command.params as { type: string }).type)).toEqual(['keyDown', 'keyUp'])
    expect(keyEvents[0]?.params).toMatchObject({
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    })
    await detachTab(id)
  })

  it('refuses empty and unnamed multi-character keys', () => {
    expect(parseKeyStroke('')).toBeUndefined()
    expect(parseKeyStroke('F13')).toBeUndefined()
    expect(parseKeyStroke('Tab')).toMatchObject({ key: 'Tab', code: 'Tab' })
  })
})

describe('evaluate exception redaction', () => {
  it('masks API keys and bearer tokens in a thrown error message', async () => {
    const token = 'sk-live-abcdefghijklmnop'
    const bearer = 'Bearer abcdefghijklmnop'
    sendCommandBehavior = async (method) => {
      if (method !== 'Runtime.evaluate') return {}
      return {
        exceptionDetails: {
          exception: { description: `Error: request failed with ${token}\n    at send (${bearer})` },
        },
      }
    }
    const outcome = await evaluateInPage(tabId(), 'throw new Error("boom")', true)
    expect(outcome.exception).toContain('[BLOCKED: api key]')
    expect(outcome.exception).toContain('[BLOCKED: bearer token]')
    expect(outcome.exception).not.toContain(token)
    expect(outcome.exception).not.toContain(bearer)
    expect(formatEvaluationResult({ exception: outcome.exception! })).not.toContain(token)
  })

  it('masks credentials in a formatted exception outcome', () => {
    const token = 'sk-proj-abcdefghijklmnop'
    const output = formatEvaluationResult({ exception: `JavaScript execution error: ${token}` })
    expect(output).toContain('[BLOCKED: api key]')
    expect(output).not.toContain(token)
  })
})

describe('redaction hardening', () => {
  it('masks prefixed and embedded credential query names', () => {
    const redacted = redactUrlForModel('https://example.com/p?sessionId=a&csrf_token=b&x-amz-signature=c&jwt=d&access_token=e&q=1')
    expect(redacted).not.toContain('sessionId=a')
    expect(redacted).not.toContain('csrf_token=b')
    expect(redacted).not.toContain('x-amz-signature=c')
    expect(redacted).not.toContain('jwt=d')
    expect(redacted).not.toContain('access_token=e')
    expect(redacted).toContain('q=1')
  })

  it('still masks pairs and userinfo when the URL does not parse', () => {
    expect(redactUrlForModel('//user:secret@example.com/p?token=abc&keep=1'))
      .toBe('//***:***@example.com/p?token=***&keep=1')
    expect(redactUrlForModel('http://[broken?api_key=abc')).toBe('http://[broken?api_key=***')
  })

  it('redacts credential shapes in a description result', () => {
    const tokenShape = ['eyJhbGciOiJub25lIn0', 'eyJzdWIiOiJ4In0', 'c2lnbmF0dXJl'].join('.')
    expect(formatEvaluationResult({ description: tokenShape })).toContain('[BLOCKED: jwt data]')
  })
})

describe('network body size accounting', () => {
  it('prefers the declared Content-Length over the recorded body', () => {
    const id = tabId()
    handleDebuggerEvent(id, 'Network.requestWillBeSent', {
      requestId: 'sized',
      request: {
        url: 'https://example.com/upload',
        method: 'POST',
        headers: { 'Content-Length': '4096' },
        postData: '{"truncated":true}',
      },
      timestamp: 1,
    })
    const request = readNetworkRequests(id).requests[0]!
    expect(request.postDataBytes).toBe(4096)
    expect(request.postDataBytesTruncated).toBeUndefined()
    forgetTab(id)
  })

  it('marks a truncated-body estimate as a lower bound', () => {
    const id = tabId()
    handleDebuggerEvent(id, 'Network.requestWillBeSent', {
      requestId: 'cut',
      request: { url: 'https://example.com/upload', method: 'POST', postData: '{"cut":1}' },
      timestamp: 1,
    })
    const request = readNetworkRequests(id).requests[0]!
    expect(request.postDataBytes).toBe(9)
    expect(request.postDataBytesTruncated).toBe(true)
    expect(formatNetworkRequests([request])).toContain('requestBodyBytes: 9 (at least;')
    forgetTab(id)
  })
})

describe('console pattern budget', () => {
  it('abandons an expensive pattern after its time budget', () => {
    const id = tabId()
    for (let index = 0; index < 400; index += 1) {
      handleDebuggerEvent(id, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: `line ${index}` }], timestamp: index })
    }
    const now = vi.spyOn(Date, 'now')
    let clock = 0
    now.mockImplementation(() => { clock += 10; return clock })
    const read = readConsoleMessages(id, { pattern: 'line' })
    now.mockRestore()
    expect(read.patternAbandoned).toBe(true)
    expect(read.total).toBeLessThan(400)
    forgetTab(id)
  })

  it('keeps matching when the budget is not exhausted', () => {
    const id = tabId()
    handleDebuggerEvent(id, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'alpha' }], timestamp: 1 })
    handleDebuggerEvent(id, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'beta' }], timestamp: 2 })
    const read = readConsoleMessages(id, { pattern: 'ALPHA' })
    expect(read.patternAbandoned).toBeUndefined()
    expect(read.total).toBe(1)
    forgetTab(id)
  })

  it('degrades an overlong pattern to a case-insensitive substring test', () => {
    const id = tabId()
    const needle = `needle${'.'.repeat(200)}`
    handleDebuggerEvent(id, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: `head ${needle} tail` }], timestamp: 1 })
    handleDebuggerEvent(id, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'unrelated' }], timestamp: 2 })
    const read = readConsoleMessages(id, { pattern: `NEEDLE${'.'.repeat(200)}` })
    expect(read.patternDegraded).toBe(true)
    expect(read.total).toBe(1)
    forgetTab(id)
  })

  it('degrades an uncompilable pattern to a substring test', () => {
    const id = tabId()
    handleDebuggerEvent(id, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'value (broken' }], timestamp: 1 })
    const read = readConsoleMessages(id, { pattern: '(' })
    expect(read.patternDegraded).toBe(true)
    expect(read.total).toBe(1)
    forgetTab(id)
  })

  it('tests only the first 512 characters of each message', () => {
    const id = tabId()
    const early = `${'x '.repeat(100)}needle`
    const late = `${'x '.repeat(520)}needle`
    handleDebuggerEvent(id, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: early }], timestamp: 1 })
    handleDebuggerEvent(id, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: late }], timestamp: 2 })
    const read = readConsoleMessages(id, { pattern: 'needle' })
    expect(read.total).toBe(1)
    expect(read.messages[0]?.text).toBe(early)
    expect(read.patternDegraded).toBeUndefined()
    forgetTab(id)
  })
})

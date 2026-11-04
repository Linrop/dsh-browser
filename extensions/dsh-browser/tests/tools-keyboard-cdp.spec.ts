// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchToolCall, type TabManagementContext, type ToolCall } from '../src/background/tools.ts'

interface ChromeState {
  tab?: Partial<chrome.tabs.Tab>
  withDebugger?: boolean
  /** Omit `chrome.windows` entirely, as a browser build without the API does. */
  withoutWindowsApi?: boolean
  /** `chrome.windows.get(windowId).focused`; defaults to a focused window. */
  windowFocused?: boolean
}

interface RecordedEvent {
  method: string
  params: Record<string, unknown>
}

let tabSequence = 700

function nextTabId(): number {
  tabSequence += 1
  return tabSequence
}

function mockChrome(state: ChromeState): {
  sendMessage: ReturnType<typeof vi.fn>
  inputEvents: RecordedEvent[]
} {
  const tab = {
    id: nextTabId(),
    windowId: 2,
    index: 0,
    active: true,
    url: 'https://example.com/',
    title: 'Example',
    ...state.tab,
  } as chrome.tabs.Tab
  const frames = [{ frameId: 0, parentFrameId: -1, documentId: `doc-${tab.id}`, url: tab.url ?? '' }]
  const inputEvents: RecordedEvent[] = []
  const sendMessage = vi.fn(async (_tabId: number, message: { action?: string }) => {
    if (message.action === 'browser_press') {
      return { ok: true, result: { text: 'Sent key "Tab".' } }
    }
    return { ok: true, result: { text: `${message.action ?? 'action'} answered` } }
  })
  const debuggerApi = {
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    sendCommand: vi.fn(async (_target: { tabId: number }, method: string, params?: object) => {
      inputEvents.push({ method, params: (params ?? {}) as Record<string, unknown> })
      return {}
    }),
    onDetach: { addListener: () => undefined },
    onEvent: { addListener: () => undefined },
  }
  vi.stubGlobal('chrome', {
    ...(state.withDebugger === true ? { debugger: debuggerApi } : {}),
    tabs: {
      query: vi.fn(async () => [tab]),
      get: vi.fn(async (tabId: number) => {
        if (tabId !== tab.id) throw new Error(`No tab with id: ${tabId}`)
        return tab
      }),
      sendMessage,
    },
    ...(state.withoutWindowsApi === true
      ? {}
      : { windows: { get: vi.fn(async (windowId: number) => ({ id: windowId, focused: state.windowFocused ?? true })) } }),
    webNavigation: { getAllFrames: vi.fn(async () => frames) },
    scripting: { executeScript: vi.fn(async () => [{ frameId: 0, result: undefined }]) },
    runtime: { id: 'test-extension', onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  })
  return { sendMessage, inputEvents }
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: name, name, args }
}

const UNRESTRICTED: TabManagementContext = { unrestrictedAccess: true }

async function dispatch(call_: ToolCall, share: 'ask' | 'auto' = 'auto') {
  return dispatchToolCall(call_, share, undefined, undefined, undefined, undefined, undefined, UNRESTRICTED)
}

function textOf(answer: { result?: unknown }): string {
  return ((answer.result as { text?: string } | undefined)?.text) ?? ''
}

function keyEventsOf(events: RecordedEvent[]): RecordedEvent[] {
  return events.filter((event) => event.method === 'Input.dispatchKeyEvent')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('browser_press real key events', () => {
  it('sends Tab through Input.dispatchKeyEvent with its code and key code', async () => {
    const chromeMock = mockChrome({ withDebugger: true })
    const answer = await dispatch(call('browser_press', { key: 'Tab' }))
    expect(answer.ok).toBe(true)
    expect(textOf(answer)).toBe('Sent key "Tab" with real key events.')
    const events = keyEventsOf(chromeMock.inputEvents)
    expect(events.map((event) => event.params.type)).toEqual(['keyDown', 'keyUp'])
    expect(events[0]?.params).toMatchObject({
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('falls back to synthesized events and explains why when the window is not focused', async () => {
    const chromeMock = mockChrome({ withDebugger: true, windowFocused: false })
    const answer = await dispatch(call('browser_press', { key: 'Tab' }))
    expect(answer.ok).toBe(true)
    expect(textOf(answer)).toContain('Sent key "Tab" with synthesized key events (')
    expect(textOf(answer)).toContain('the controlled tab is not focused')
    expect(keyEventsOf(chromeMock.inputEvents)).toHaveLength(0)
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ action: 'browser_press' }),
      expect.any(Object),
    )
  })

  it('rejects an unsupported multi-character key as bad-args', async () => {
    const chromeMock = mockChrome({ withDebugger: true })
    const answer = await dispatch(call('browser_press', { key: 'F13' }))
    expect(answer.ok).toBe(false)
    expect(answer.error).toMatchObject({ code: 'bad-args' })
    expect(answer.error?.message).toContain('Unsupported key')
    expect(keyEventsOf(chromeMock.inputEvents)).toHaveLength(0)
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })
})

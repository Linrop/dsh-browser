// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchToolCall, type TabManagementContext, type ToolCall } from '../src/background/tools.ts'

interface ChromeState {
  tab?: Partial<chrome.tabs.Tab>
  frames?: Array<{ frameId: number; parentFrameId: number; documentId?: string; url: string }>
  withDebugger?: boolean
  pointerRect?: unknown
  pageContent?: string
  dragEventsUnavailable?: boolean
  /** Omit `chrome.windows` entirely, as a browser build without the API does. */
  withoutWindowsApi?: boolean
  /** `chrome.windows.get(windowId).focused`; defaults to a focused window. */
  windowFocused?: boolean
}

interface RecordedEvent {
  method: string
  params: Record<string, unknown>
}

let tabSequence = 400

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
  const frames = state.frames ?? [{ frameId: 0, parentFrameId: -1, documentId: `doc-${tab.id}`, url: tab.url ?? '' }]
  const inputEvents: RecordedEvent[] = []
  const pointerRect = state.pointerRect ?? { x: 12, y: 34, width: 10, height: 10, visible: true }
  const sendMessage = vi.fn(async (_tabId: number, message: { action?: string }) => {
    if (message.action === 'browser_pointer_rect') {
      return {
        ok: true,
        result: { text: JSON.stringify(pointerRect), ...(state.pageContent === undefined ? {} : { pageContent: state.pageContent }) },
      }
    }
    if (message.action === 'browser_snapshot') return { ok: true, result: { text: 'snapshot text' } }
    return { ok: true, result: { text: `${message.action ?? 'action'} answered` } }
  })
  const debuggerApi = {
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    sendCommand: vi.fn(async (_target: { tabId: number }, method: string, params?: object) => {
      if (state.dragEventsUnavailable === true && method === 'Input.dispatchDragEvent') {
        throw new Error("'Input.dispatchDragEvent' wasn't found")
      }
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

function inputEventsOf(events: RecordedEvent[]): RecordedEvent[] {
  return events.filter((event) => event.method === 'Input.dispatchMouseEvent')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('browser_click real-input opt-in', () => {
  it('keeps a plain left click on the content-script path', async () => {
    const chromeMock = mockChrome({ withDebugger: true })
    await dispatch(call('browser_snapshot', {}))
    const answer = await dispatch(call('browser_click', { index: 1 }))
    expect(answer.ok).toBe(true)
    expect(inputEventsOf(chromeMock.inputEvents)).toHaveLength(0)
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ action: 'browser_click' }),
      expect.anything(),
    )
  })

  it('uses CDP press/release when button and count are supplied', async () => {
    const chromeMock = mockChrome({ withDebugger: true, tab: {} })
    await dispatch(call('browser_snapshot', {}))
    const answer = await dispatch(call('browser_click', { index: 1, button: 'right', count: 2 }))
    expect(answer.ok).toBe(true)
    expect(textOf(answer)).toContain('Clicked [1]')
    const pressed = inputEventsOf(chromeMock.inputEvents).filter((event) => event.params.type === 'mousePressed')
    expect(pressed.map((event) => event.params.clickCount)).toEqual([1, 2])
    expect(pressed[0]?.params).toMatchObject({ button: 'right', x: 12, y: 34 })
    const actions = chromeMock.sendMessage.mock.calls
      .map(([, message]) => (message as { action?: string }).action)
      .filter((action) => action !== 'browser_pointer_rect')
    expect(actions).not.toContain('browser_click')
  })

  it('rejects an unknown button or modifier before dispatching anything', async () => {
    const chromeMock = mockChrome({ withDebugger: true })
    const badButton = await dispatch(call('browser_click', { index: 1, button: 'thumb' }))
    expect(badButton).toMatchObject({ ok: false, error: { code: 'bad-args' } })
    const badModifiers = await dispatch(call('browser_click', { index: 1, modifiers: 'hyper' }))
    expect(badModifiers).toMatchObject({ ok: false, error: { code: 'bad-args' } })
    expect(inputEventsOf(chromeMock.inputEvents)).toHaveLength(0)
  })
})

describe('browser_hover and browser_drag real input', () => {
  it('hovers at coordinates through the Input domain', async () => {
    const chromeMock = mockChrome({ withDebugger: true, pointerRect: { x: 5, y: 6, width: 0, height: 0, visible: true } })
    const answer = await dispatch(call('browser_hover', { x: 5, y: 6 }))
    expect(answer.ok).toBe(true)
    expect(textOf(answer)).toContain('real mouse events')
    expect(inputEventsOf(chromeMock.inputEvents)[0]?.params).toMatchObject({ type: 'mouseMoved', x: 5, y: 6, buttons: 0 })
  })

  it('drags through interpolated CDP moves', async () => {
    const chromeMock = mockChrome({
      withDebugger: true,
      pointerRect: {
        from: { x: 1, y: 2, width: 0, height: 0, visible: true },
        to: { x: 40, y: 50, width: 0, height: 0, visible: true },
      },
    })
    const answer = await dispatch(call('browser_drag', { from: [1, 2], to: [40, 50] }))
    expect(answer.ok).toBe(true)
    expect(textOf(answer)).toContain('Dragged from (1, 2) to (40, 50)')
    const moves = inputEventsOf(chromeMock.inputEvents).filter((event) => event.params.type === 'mouseMoved' && event.params.buttons === 1)
    expect(moves).toHaveLength(5)
    expect(inputEventsOf(chromeMock.inputEvents).at(-1)?.params).toMatchObject({ type: 'mouseReleased', x: 40, y: 50 })
  })

  it('dispatches native drag events when the endpoints report native DnD semantics', async () => {
    const chromeMock = mockChrome({
      withDebugger: true,
      pointerRect: {
        from: { x: 1, y: 2, width: 0, height: 0, visible: true },
        to: { x: 40, y: 50, width: 0, height: 0, visible: true },
        nativeDrag: true,
      },
    })
    const answer = await dispatch(call('browser_drag', { from: [1, 2], to: [40, 50] }))
    expect(answer.ok).toBe(true)
    expect(textOf(answer)).toContain('native drag events')
    const dragEvents = chromeMock.inputEvents.filter((event) => event.method === 'Input.dispatchDragEvent')
    expect(dragEvents.map((event) => event.params.type)).toContain('drop')
    const actions = chromeMock.sendMessage.mock.calls
      .map(([, message]) => (message as { action?: string }).action)
    expect(actions).not.toContain('browser_drag')
  })

  it('dispatches native drag events for index-addressed endpoints too', async () => {
    const chromeMock = mockChrome({
      withDebugger: true,
      pointerRect: {
        from: { x: 1, y: 2, width: 10, height: 10, visible: true },
        to: { x: 40, y: 50, width: 20, height: 20, visible: true },
        nativeDrag: true,
      },
    })
    await dispatch(call('browser_snapshot', {}))
    const answer = await dispatch(call('browser_drag', { from_index: 1, to_index: 2 }))
    expect(answer.ok).toBe(true)
    expect(textOf(answer)).toContain('native drag events')
    const dragEvents = chromeMock.inputEvents.filter((event) => event.method === 'Input.dispatchDragEvent')
    expect(dragEvents.map((event) => event.params.type)).toEqual([
      'dragEnter', 'dragOver', 'dragOver', 'dragOver', 'dragOver', 'dragOver', 'drop',
    ])
  })

  it('falls back to synthesized drag events when the protocol has no dispatchDragEvent', async () => {
    const chromeMock = mockChrome({
      withDebugger: true,
      dragEventsUnavailable: true,
      pointerRect: {
        from: { x: 1, y: 2, width: 0, height: 0, visible: true },
        to: { x: 40, y: 50, width: 0, height: 0, visible: true },
        nativeDrag: true,
      },
    })
    const answer = await dispatch(call('browser_drag', { from: [1, 2], to: [40, 50] }))
    expect(answer.ok).toBe(true)
    expect(textOf(answer)).toContain('synthesized drag events')
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ action: 'browser_drag' }),
      expect.anything(),
    )
  })

  it('synthesizes instead of dispatching CDP input for a background tab', async () => {
    const chromeMock = mockChrome({ withDebugger: true, tab: { active: false } })
    const answer = await dispatch(call('browser_hover', { x: 5, y: 6 }))
    expect(answer.ok).toBe(true)
    expect(textOf(answer)).toContain('synthesized events')
    expect(textOf(answer)).toContain('real input would not reach the page')
    expect(inputEventsOf(chromeMock.inputEvents)).toHaveLength(0)
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ action: 'browser_hover' }),
      expect.anything(),
    )
  })

  it('synthesizes a button-carrying click when the window is not focused', async () => {
    const chromeMock = mockChrome({ withDebugger: true, windowFocused: false })
    await dispatch(call('browser_snapshot', {}))
    const answer = await dispatch(call('browser_click', { index: 1, button: 'right' }))
    expect(answer.ok).toBe(true)
    expect(textOf(answer)).toContain('synthesized events')
    expect(textOf(answer)).toContain('button, click count, and modifiers were simulated')
    expect(inputEventsOf(chromeMock.inputEvents)).toHaveLength(0)
  })

  it('synthesizes when the browser build has no chrome.windows', async () => {
    const chromeMock = mockChrome({ withDebugger: true, withoutWindowsApi: true })
    const answer = await dispatch(call('browser_hover', { x: 5, y: 6 }))
    expect(answer.ok).toBe(true)
    expect(textOf(answer)).toContain('synthesized events')
    expect(inputEventsOf(chromeMock.inputEvents)).toHaveLength(0)
  })

  it('falls back to synthesized events with a disclosure when the debugger is unavailable', async () => {
    const chromeMock = mockChrome({ withDebugger: false })
    const answer = await dispatch(call('browser_hover', { x: 5, y: 6 }))
    expect(answer.ok).toBe(true)
    expect(textOf(answer)).toContain('synthesized as DOM events')
    expect(inputEventsOf(chromeMock.inputEvents)).toHaveLength(0)
  })

  it('discloses simulated button semantics when an option-carrying click falls back', async () => {
    mockChrome({ withDebugger: false })
    await dispatch(call('browser_snapshot', {}))
    const answer = await dispatch(call('browser_click', { index: 1, button: 'right', count: 2, modifiers: 'ctrl' }))
    expect(answer.ok).toBe(true)
    expect(textOf(answer)).toContain('synthesized as DOM events')
    expect(textOf(answer)).toContain('button, click count, and modifiers were simulated')
  })

  it('keeps iframe targets on the synthesized path', async () => {
    const chromeMock = mockChrome({
      withDebugger: true,
      frames: [
        { frameId: 0, parentFrameId: -1, documentId: 'doc-0', url: 'https://example.com/' },
        { frameId: 1, parentFrameId: 0, documentId: 'doc-1', url: 'https://frame.example/' },
      ],
    })
    const answer = await dispatch(call('browser_hover', { x: 5, y: 6, frame: 1 }))
    expect(answer.ok).toBe(true)
    expect(textOf(answer)).toContain('iframe')
    expect(inputEventsOf(chromeMock.inputEvents)).toHaveLength(0)
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ action: 'browser_hover' }),
      expect.anything(),
    )
  })

  it('returns the automatic page delta after real input when a snapshot baseline exists', async () => {
    mockChrome({
      withDebugger: true,
      pageContent: '- button "new"',
    })
    await dispatch(call('browser_snapshot', {}))
    const answer = await dispatch(call('browser_hover', { x: 5, y: 6 }))
    expect(textOf(answer)).toContain('- button "new"')
  })
})

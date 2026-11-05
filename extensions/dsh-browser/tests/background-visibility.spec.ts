// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  readonly sent: unknown[] = []

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(value: string): void {
    this.sent.push(JSON.parse(value))
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(frame: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code, reason }))
  }
}

function chromeEvent<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>()
  return {
    addListener: vi.fn((listener: (...args: T) => void) => { listeners.add(listener) }),
    emit: (...args: T) => { for (const listener of listeners) listener(...args) },
  }
}

function panelPort() {
  const onMessage = chromeEvent<[unknown]>()
  const onDisconnect = chromeEvent<[]>()
  const postMessage = vi.fn()
  const port = { name: 'dsh-panel', postMessage, onMessage, onDisconnect } as unknown as chrome.runtime.Port
  return { onDisconnect, onMessage, port, postMessage }
}

interface StubOptions {
  settings?: Record<string, unknown>
  url?: string
}

function mockChrome(options: StubOptions = {}) {
  const url = options.url ?? 'https://app.example/page'
  const tab = {
    id: 1,
    windowId: 1,
    index: 0,
    active: true,
    groupId: -1,
    title: 'Page',
    url,
  } as chrome.tabs.Tab
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const onAlarm = chromeEvent<[chrome.alarms.Alarm]>()
  const action = {
    setBadgeText: vi.fn(async () => undefined),
    setBadgeBackgroundColor: vi.fn(async () => undefined),
    setBadgeTextColor: vi.fn(async () => undefined),
  }
  const tabGroupsUpdate = vi.fn(async (_groupId: number, _props: unknown) => undefined)
  const tabGroupsQuery = vi.fn(async (_filter: unknown): Promise<unknown[]> => [])
  const tabGroups = { update: tabGroupsUpdate, query: tabGroupsQuery }
  const tabsQuery = vi.fn(async (_query: unknown): Promise<unknown[]> => [tab])
  const tabsGroup = vi.fn(async (_options: unknown): Promise<number> => 41)
  const tabsUngroup = vi.fn(async (_tabIds: number[]): Promise<void> => undefined)
  const sessionData: Record<string, unknown> = {}
  vi.stubGlobal('chrome', {
    action,
    alarms: { create: vi.fn(), clear: vi.fn(async () => true), onAlarm },
    notifications: {
      create: vi.fn(async () => ''),
      clear: vi.fn(async () => true),
      onClicked: chromeEvent<[string]>(),
    },
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onConnect,
      onMessage: chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>(),
    },
    sidePanel: { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) },
    storage: {
      local: {
        get: vi.fn(async () => ({
          dshSettings: { bridgeUrl: 'wss://bridge.example/ext/bridge', ...options.settings },
        })),
        set: vi.fn(async () => {}),
      },
      session: {
        get: vi.fn(async (key: string) => ({ [key]: sessionData[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(sessionData, items) }),
        remove: vi.fn(async (key: string) => { delete sessionData[key] }),
      },
    },
    tabGroups,
    tabs: {
      get: vi.fn(async () => tab),
      query: tabsQuery,
      remove: vi.fn(async () => undefined),
      group: tabsGroup,
      ungroup: tabsUngroup,
      sendMessage: vi.fn(async () => ({ ok: true, result: { text: 'page' } })),
      onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
      onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
      onReplaced: chromeEvent<[number, number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
    webNavigation: {
      getAllFrames: vi.fn(async () => [{
        tabId: 1,
        frameId: 0,
        parentFrameId: -1,
        documentId: 'document-1',
        url,
      }]),
      onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>(),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: vi.fn(async () => [{ id: 1 }]),
      getLastFocused: vi.fn(async () => ({ id: 1 })),
      onFocusChanged: chromeEvent<[number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
  } as unknown as typeof chrome)
  return { action, onConnect, sessionData, tabGroups, tabGroupsQuery, tabGroupsUpdate, tabs: chrome.tabs, tabsGroup, tabsQuery, tabsUngroup }
}

/** Open a panel, connect the socket, and bind the session to the active tab. */
async function connectWithSession(chromeMock: ReturnType<typeof mockChrome>, sessionId = 'session-1') {
  const panel = panelPort()
  chromeMock.onConnect.emit(panel.port)
  await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
  const socket = FakeWebSocket.instances[0]!
  socket.open()
  await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'hello' })) })
  socket.receive({ t: 'hello.ok', caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } })
  panel.onMessage.emit({ type: 'session.active', sessionId, isNew: true })
  // Binding is asynchronous: wait for the persisted affinity record so the next
  // tool call resolves a controlled tab instead of failing closed.
  await vi.waitFor(() => {
    expect(JSON.stringify(chromeMock.sessionData.dshTabAffinity ?? {})).toContain(sessionId)
  })
  return { panel, socket, sessionId }
}

function indicatorStates(mock: ReturnType<typeof mockChrome>): unknown[] {
  return vi.mocked(mock.tabs.sendMessage).mock.calls
    .map((call) => call[1] as { type?: string; state?: unknown })
    .filter((message) => message.type === 'DSH_INDICATOR')
    .map((message) => message.state)
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('visible work indicator', () => {
  it('shows the brand badge and the in-page dot while a tool call runs', async () => {
    const chromeMock = mockChrome({ settings: { trustedActionOrigins: ['https://app.example'] } })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const { socket, sessionId } = await connectWithSession(chromeMock)
    vi.mocked(chromeMock.action.setBadgeText).mockClear()

    socket.receive({
      t: 'tool.call',
      id: 'call-1',
      name: 'browser_click',
      args: { index: 1 },
      expiresAt: Date.now() + 10_000,
      sessionId,
    })
    await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'call-1' })) })

    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: '●' })
    expect(chromeMock.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#4d6bfe' })
    expect(chromeMock.action.setBadgeTextColor).toHaveBeenCalledWith({ color: '#ffffff' })
    expect(chromeMock.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' })
    // A tool call pulses the dot, then leaves it static while the binding lasts.
    expect(indicatorStates(chromeMock)).toEqual(['pulsing', 'static'])
  })

  it('labels the worked tab group and drives the in-page dot in overlay mode', async () => {
    const chromeMock = mockChrome({
      settings: { trustedActionOrigins: ['https://app.example'], indicatorMode: 'badge-overlay' },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const { socket, sessionId } = await connectWithSession(chromeMock)

    socket.receive({
      t: 'tool.call',
      id: 'call-2',
      name: 'browser_click',
      args: { index: 1 },
      expiresAt: Date.now() + 10_000,
      sessionId,
    })
    await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'call-2' })) })

    expect(chromeMock.tabsGroup).toHaveBeenCalledWith({ tabIds: [1] })
    expect(chromeMock.tabGroupsUpdate).toHaveBeenCalledWith(41, { title: 'DSH', color: 'blue' })
    expect(indicatorStates(chromeMock)).toEqual(['pulsing', 'static'])
  })

  it('joins the group this extension already owns instead of opening a second one', async () => {
    const chromeMock = mockChrome({
      settings: { trustedActionOrigins: ['https://app.example'], indicatorMode: 'badge-overlay' },
    })
    chromeMock.tabGroupsQuery.mockResolvedValue([{ id: 7, title: 'DSH', color: 'blue', windowId: 1 }])
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const { socket, sessionId } = await connectWithSession(chromeMock)

    socket.receive({
      t: 'tool.call',
      id: 'call-join',
      name: 'browser_click',
      args: { index: 1 },
      expiresAt: Date.now() + 10_000,
      sessionId,
    })
    await vi.waitFor(() => { expect(chromeMock.tabsGroup).toHaveBeenCalledWith({ tabIds: [1], groupId: 7 }) })
    expect(chromeMock.tabGroupsUpdate).toHaveBeenCalledWith(7, { title: 'DSH', color: 'blue' })
  })

  it('folds a group left by the older title into the current one', async () => {
    const chromeMock = mockChrome({
      settings: { trustedActionOrigins: ['https://app.example'], indicatorMode: 'badge-overlay' },
    })
    const older = { id: 3, title: 'DSH Browser', color: 'blue', windowId: 1 }
    const newer = { id: 7, title: 'DSH', color: 'blue', windowId: 1 }
    chromeMock.tabGroupsQuery.mockImplementation(async (filter) => (
      (filter as { title?: string }).title === 'DSH' ? [newer] : [older]
    ))
    chromeMock.tabsQuery.mockImplementation(async (query) => (
      (query as { groupId?: number }).groupId === 7 ? [{ id: 9, windowId: 1 }] : [{ id: 1, windowId: 1 }]
    ))
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const { socket, sessionId } = await connectWithSession(chromeMock)

    socket.receive({
      t: 'tool.call',
      id: 'call-merge',
      name: 'browser_click',
      args: { index: 1 },
      expiresAt: Date.now() + 10_000,
      sessionId,
    })
    await vi.waitFor(() => { expect(chromeMock.tabsGroup).toHaveBeenCalledWith({ tabIds: [9], groupId: 3 }) })
    expect(chromeMock.tabGroupsUpdate).toHaveBeenCalledWith(3, { title: 'DSH', color: 'blue' })
  })

  it('keeps every surface silent when the indicator mode is off', async () => {
    const chromeMock = mockChrome({
      settings: { trustedActionOrigins: ['https://app.example'], indicatorMode: 'off' },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const { socket, sessionId } = await connectWithSession(chromeMock)
    vi.mocked(chromeMock.action.setBadgeText).mockClear()

    socket.receive({
      t: 'tool.call',
      id: 'call-3',
      name: 'browser_click',
      args: { index: 1 },
      expiresAt: Date.now() + 10_000,
      sessionId,
    })
    await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'call-3' })) })

    expect(chromeMock.action.setBadgeText).not.toHaveBeenCalledWith({ text: '●' })
    expect(chromeMock.tabsGroup).not.toHaveBeenCalled()
    expect(indicatorStates(chromeMock)).toEqual([])
  })

  it('hides the indicator and drops ownership when the bridge disconnects', async () => {
    const chromeMock = mockChrome({
      settings: { trustedActionOrigins: ['https://app.example'], indicatorMode: 'badge-overlay' },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const { socket, sessionId } = await connectWithSession(chromeMock)

    socket.receive({
      t: 'tool.call',
      id: 'call-4',
      name: 'browser_click',
      args: { index: 1 },
      expiresAt: Date.now() + 10_000,
      sessionId,
    })
    await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'call-4' })) })
    vi.mocked(chromeMock.tabs.sendMessage).mockClear()

    // 4000 is the replacement code: the bridge stops instead of reconnecting,
    // which is the one transition that ends this session's owned tabs.
    socket.close(4000, 'replaced')

    await vi.waitFor(() => { expect(indicatorStates(chromeMock)).toContain('off') })
    expect(chromeMock.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' })
    // Releasing the tab is what removes the group; a bare empty title would
    // leave a colour chip in the tab strip.
    await vi.waitFor(() => { expect(chromeMock.tabsUngroup).toHaveBeenCalledWith([1]) })
  })

  it('releases a group it created in an earlier worker run, identified by its title', async () => {
    const chromeMock = mockChrome({
      settings: { trustedActionOrigins: ['https://app.example'], indicatorMode: 'badge-overlay' },
    })
    // No in-memory tracking survives a worker restart; the title is the only
    // durable marker, and every member of that group belongs to the release.
    chromeMock.tabGroupsQuery.mockImplementation(async (filter) => (
      (filter as { title?: string }).title === 'DSH'
        ? [{ id: 41, title: 'DSH', color: 'blue', windowId: 1 }]
        : []
    ))
    chromeMock.tabsQuery.mockImplementation(async (query) => (
      (query as { groupId?: number }).groupId === 41
        ? [{ id: 7, windowId: 1 }, { id: 8, windowId: 1 }]
        : [{ id: 1, windowId: 1, index: 0, active: true, groupId: -1, title: 'Page', url: 'https://app.example/page' }]
    ))
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const { socket, sessionId } = await connectWithSession(chromeMock)

    socket.receive({
      t: 'tool.call',
      id: 'call-title-group',
      name: 'browser_click',
      args: { index: 1 },
      expiresAt: Date.now() + 10_000,
      sessionId,
    })
    await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'call-title-group' })) })

    socket.close(4000, 'replaced')

    await vi.waitFor(() => { expect(chromeMock.tabsUngroup).toHaveBeenCalledWith([1, 7, 8]) })
  })

  it('releases an owned tab left in an untitled group by an older build', async () => {
    const chromeMock = mockChrome({
      settings: { trustedActionOrigins: ['https://app.example'], indicatorMode: 'badge-overlay' },
    })
    // The old build blanked the title instead of releasing the tab, so the group
    // is invisible to title matching; the tab being owned is what identifies it.
    chromeMock.tabGroupsQuery.mockImplementation(async () => [])
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const { socket, sessionId } = await connectWithSession(chromeMock)

    socket.receive({
      t: 'tool.call',
      id: 'call-legacy-group',
      name: 'browser_click',
      args: { index: 1 },
      expiresAt: Date.now() + 10_000,
      sessionId,
    })
    await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'call-legacy-group' })) })

    socket.close(4000, 'replaced')

    await vi.waitFor(() => { expect(chromeMock.tabsUngroup).toHaveBeenCalledWith([1]) })
  })

  it('never auto-approves a cross-origin navigation even when both origins are trusted', async () => {
    const chromeMock = mockChrome({
      settings: {
        trustedActionOrigins: ['https://app.example', 'https://bank.example'],
        tabIsolation: false,
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const { panel, socket, sessionId } = await connectWithSession(chromeMock)

    socket.receive({
      t: 'tool.call',
      id: 'cross-origin',
      name: 'browser_navigate',
      args: { url: 'https://bank.example/transfer' },
      expiresAt: Date.now() + 10_000,
      sessionId,
    })

    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.request' }))
    })
    const request = vi.mocked(panel.postMessage).mock.calls
      .map((call) => call[0] as { type?: string; request?: { summary?: string; crossOrigin?: boolean; fromOrigin?: string; toOrigin?: string } })
      .find((message) => message.type === 'approval.request')?.request
    expect(request?.crossOrigin).toBe(true)
    expect(request?.fromOrigin).toBe('https://app.example')
    expect(request?.toOrigin).toBe('https://bank.example')
    expect(request?.summary).toContain('app.example → bank.example')
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalledWith(1, expect.objectContaining({ action: 'browser_navigate' }))
  })
})

describe('session state across connection generations', () => {
  it('keeps an owned tab operable after a transient reconnect', async () => {
    const chromeMock = mockChrome({
      settings: { unrestrictedBrowserAccess: true, indicatorMode: 'badge-overlay' },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const { socket, sessionId } = await connectWithSession(chromeMock)

    socket.receive({
      t: 'tool.call',
      id: 'call-before-drop',
      name: 'browser_click',
      args: { index: 1 },
      expiresAt: Date.now() + 10_000,
      sessionId,
    })
    await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'call-before-drop' })) })
    vi.mocked(chromeMock.tabs.sendMessage).mockClear()

    // A plain close is transient: the bridge reconnects instead of stopping.
    socket.close(1006, 'network blip')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    const reconnected = FakeWebSocket.instances[1]!
    reconnected.open()
    await vi.waitFor(() => { expect(reconnected.sent).toContainEqual(expect.objectContaining({ t: 'hello' })) })
    reconnected.receive({ t: 'hello.ok', caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } })

    // The in-page dot is not torn down by a transient generation either.
    expect(indicatorStates(chromeMock)).not.toContain('off')

    reconnected.receive({
      t: 'tool.call',
      id: 'close-after-reconnect',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
      sessionId,
    })

    await vi.waitFor(() => {
      expect(reconnected.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'close-after-reconnect', ok: true }))
    })
    expect(chromeMock.tabs.remove).toHaveBeenCalledWith(1)
  })
})

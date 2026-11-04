// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchToolCall,
  isNavigationCandidateTool,
  type ToolAnswer,
  type ToolCall,
} from '../src/background/tools.ts'

const CALL: ToolCall = { id: 'tool-1', name: 'browser_snapshot', args: {} }
const OK: ToolAnswer = { ok: true, result: { text: 'page' } }

function managedTab(tabId: number, overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: tabId,
    windowId: 1,
    index: tabId,
    active: false,
    highlighted: false,
    pinned: false,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    url: `https://example.com/${tabId}`,
    title: `Tab ${tabId}`,
    ...overrides,
  }
}

function mockChrome(options: {
  tab?: Partial<chrome.tabs.Tab>
  tabs?: chrome.tabs.Tab[]
  responses?: Array<unknown>
  injectionError?: Error
  frames?: Array<{ frameId: number; parentFrameId: number; documentId?: string; url: string }>
  respond?: (message: unknown, frameId: number) => unknown
}) {
  const responses = [...(options.responses ?? [OK])]
  const runtimeListeners = new Set<(message: unknown, sender: chrome.runtime.MessageSender) => void>()
  const currentFrames = () => options.frames ?? (options.tab?.id === undefined ? [] : [{
    frameId: 0,
    parentFrameId: -1,
    documentId: `document-${options.tab.id}`,
    url: options.tab.url ?? '',
  }])
  // Chrome resubscribes documents by id across a frame-tree omission, so a
  // document addressed by a document that getAllFrames no longer reports must
  // still resolve to its frame.
  const frameIdsByDocument = new Map<string, number>()
  const sendMessage = vi.fn(async (
    _tabId: number,
    message: unknown,
    target?: { frameId?: number; documentId?: string },
  ) => {
    for (const frame of currentFrames()) {
      if (typeof frame.frameId === 'number' && frame.documentId !== undefined) {
        frameIdsByDocument.set(frame.documentId, frame.frameId)
      }
    }
    const targetFrameId = target?.frameId
      ?? (target?.documentId === undefined ? undefined : frameIdsByDocument.get(target.documentId))
      ?? 0
    const response = options.respond?.(message, targetFrameId) ?? responses.shift()
    if (response instanceof Error) throw response
    return response
  })
  const executeScript = options.injectionError === undefined
    ? vi.fn(async () => [{ frameId: 0, result: undefined }])
    : vi.fn(async () => { throw options.injectionError })
  const allTabs = () => options.tabs ?? (options.tab === undefined ? [] : [options.tab as chrome.tabs.Tab])
  const query = vi.fn(async (queryInfo?: chrome.tabs.QueryInfo) => Object.keys(queryInfo ?? {}).length === 0
    ? allTabs()
    : (options.tab === undefined ? [] : [options.tab]))
  const get = vi.fn(async (tabId: number) => {
    const found = allTabs().find((tab) => tab.id === tabId)
    if (found === undefined) throw new Error(`No tab with id: ${tabId}`)
    return { ...found }
  })
  const update = vi.fn(async (_tabId: number, changes: chrome.tabs.UpdateProperties) => ({ ...options.tab, ...changes }))
  const goBack = vi.fn(async () => undefined)
  const goForward = vi.fn(async () => undefined)
  const reload = vi.fn(async () => undefined)
  const remove = vi.fn(async () => undefined)
  const getAllFrames = vi.fn(async () => currentFrames())
  vi.stubGlobal('chrome', {
    tabs: { query, get, sendMessage, update, goBack, goForward, reload, remove },
    scripting: { executeScript },
    webNavigation: { getAllFrames },
    runtime: {
      onMessage: {
        addListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
          runtimeListeners.add(listener)
        },
        removeListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
          runtimeListeners.delete(listener)
        },
      },
    },
  })
  const emitContentReady = (tabId: number, frameId: number, documentId: string): void => {
    for (const listener of runtimeListeners) {
      listener({ type: 'DSH_CONTENT_READY' }, { tab: { id: tabId }, frameId, documentId } as chrome.runtime.MessageSender)
    }
  }
  return { emitContentReady, executeScript, get, getAllFrames, goBack, goForward, query, reload, remove, sendMessage, update }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('isNavigationCandidateTool', () => {
  it('classifies only tools that may change the page checkpoint', () => {
    expect(isNavigationCandidateTool('browser_click')).toBe(true)
    expect(isNavigationCandidateTool('browser_navigate')).toBe(true)
    expect(isNavigationCandidateTool('browser_open_tab')).toBe(true)
    expect(isNavigationCandidateTool('browser_snapshot')).toBe(false)
    expect(isNavigationCandidateTool('browser_type')).toBe(false)
  })
})

describe('dispatchToolCall', () => {
  it('uses an already-loaded content script without injecting', async () => {
    const chromeMock = mockChrome({ tab: { id: 7, url: 'https://example.com' } })

    const answer = await dispatchToolCall(CALL, 'auto')
    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toContain('page')
    expect((answer.result as { text: string }).text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(1)
    expect(chromeMock.executeScript).not.toHaveBeenCalled()
  })

  it('injects content.js and retries for a page opened before extension load', async () => {
    const budget = { maxItems: 80, maxChars: 16_000 }
    const chromeMock = mockChrome({
      tab: { id: 7, url: 'https://example.com/already-open' },
      responses: [new Error('Could not establish connection. Receiving end does not exist.'), OK],
    })

    const answer = await dispatchToolCall(CALL, 'auto', budget)
    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toContain('page')
    expect(chromeMock.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, allFrames: true },
      files: ['content.js'],
    })
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(2)
    expect(chromeMock.sendMessage).toHaveBeenLastCalledWith(7, {
      type: 'DSH_ACTION',
      action: 'browser_snapshot',
      args: { delta: false },
      budget,
    }, { documentId: 'document-7' })
  })

  it('does not retry or roll back a dispatched action when its response port closes', async () => {
    const chromeMock = mockChrome({
      tab: { id: 7, url: 'https://example.com/form' },
      responses: [new Error('The message port closed before a response was received.')],
    })
    const commitAction = vi.fn()
    const rollbackActionCommit = vi.fn()

    const answer = await dispatchToolCall(
      { id: 'port-closed', name: 'browser_press', args: { key: 'Enter' } },
      'auto',
      undefined,
      async () => 'approved',
      undefined,
      undefined,
      undefined,
      { unrestrictedAccess: true, commitAction, rollbackActionCommit },
    )

    expect(answer).toMatchObject({
      ok: false,
      error: { code: 'content-unavailable', message: expect.stringContaining('operation was dispatched') },
    })
    expect(commitAction).toHaveBeenCalledOnce()
    expect(rollbackActionCommit).not.toHaveBeenCalled()
    expect(chromeMock.sendMessage).toHaveBeenCalledOnce()
    expect(chromeMock.executeScript).not.toHaveBeenCalled()
  })

  it('returns browser-level metadata without injecting into Chrome internal pages', async () => {
    const chromeMock = mockChrome({
      tab: { id: 8, windowId: 3, title: 'Extensions', url: 'chrome://extensions' },
      responses: [new Error('no receiver')],
    })

    const answer = await dispatchToolCall(CALL, 'auto')
    expect(answer).toMatchObject({ ok: true })
    expect((answer.result as { text: string }).text).toContain('browser-level controls')
    expect((answer.result as { text: string }).text).toContain('chrome://extensions')
    expect((answer.result as { text: string }).text).toContain('Title: Extensions')
    expect((answer.result as { text: string }).text).toContain('Window ID: 3')
    expect((answer.result as { text: string }).text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
    expect(chromeMock.executeScript).not.toHaveBeenCalled()
  })

  it('falls back to browser-level metadata when recovery injection is blocked', async () => {
    mockChrome({
      tab: { id: 9, url: 'https://chromewebstore.google.com/detail/example' },
      responses: [new Error('Could not establish connection. Receiving end does not exist.')],
      injectionError: new Error('Cannot access contents of the page'),
    })

    const answer = await dispatchToolCall(CALL, 'auto')
    expect(answer).toMatchObject({ ok: true })
    expect((answer.result as { text: string }).text).toContain('browser-level controls')
    expect((answer.result as { text: string }).text).toContain('chromewebstore.google.com')
  })

  it('uses browser-level navigation, history, and reload on protected pages', async () => {
    const chromeMock = mockChrome({ tab: { id: 8, url: 'chrome://newtab/' } })
    const commitAction = vi.fn()
    await expect(dispatchToolCall(
      { id: 'navigate-protected', name: 'browser_navigate', args: { url: 'https://example.com/path' } },
      'auto',
      undefined,
      async () => 'approved',
      undefined,
      undefined,
      undefined,
      { unrestrictedAccess: false, commitAction },
    )).resolves.toMatchObject({ ok: true })
    expect(chromeMock.update).toHaveBeenCalledWith(8, { url: 'https://example.com/path' })

    for (const [name, operation] of [
      ['browser_back', chromeMock.goBack],
      ['browser_forward', chromeMock.goForward],
      ['browser_reload', chromeMock.reload],
    ] as const) {
      await expect(dispatchToolCall(
        { id: name, name, args: {} },
        'auto',
        undefined,
        async () => 'approved',
        undefined,
        undefined,
        undefined,
        { unrestrictedAccess: false, commitAction },
      )).resolves.toMatchObject({ ok: true })
      expect(operation).toHaveBeenCalledWith(8)
    }
    expect(commitAction).toHaveBeenCalledTimes(4)
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('refuses DOM actions on browser-owned pages with protected-page', async () => {
    const chromeMock = mockChrome({ tab: { id: 8, url: 'about:config' } })
    const authorize = vi.fn(async () => 'approved' as const)

    await expect(dispatchToolCall(
      { id: 'click-protected', name: 'browser_click', args: { index: 1 } },
      'auto', undefined, authorize,
    )).resolves.toMatchObject({
      ok: false,
      error: { code: 'protected-page', message: expect.stringContaining('This page cannot be assisted here: about:') },
    })
    expect(authorize).not.toHaveBeenCalled()
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('lists, follows, and closes selected tabs without activating them', async () => {
    const tabs = [
      managedTab(11, { active: true, title: 'Inbox', url: 'https://mail.example/inbox' }),
      managedTab(12, { windowId: 2, title: 'Docs', url: 'https://docs.example/guide' }),
    ]
    const chromeMock = mockChrome({ tabs })
    const authorize = vi.fn(async () => 'approved' as const)
    const followTab = vi.fn(async () => undefined)
    const commitAction = vi.fn()
    const context = { unrestrictedAccess: false, controlledTabId: 11, followTab, commitAction }

    const listed = await dispatchToolCall(
      { id: 'list-tabs', name: 'browser_list_tabs', args: {} },
      'auto', undefined, authorize, undefined, undefined, undefined, context,
    )
    expect((listed.result as { text: string }).text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect((listed.result as { text: string }).text).toContain('https://docs.example/guide')
    expect((listed.result as { text: string }).text).toContain('"controlled": true')

    await expect(dispatchToolCall(
      { id: 'follow-tab', name: 'browser_follow_tab', args: { tabId: 12 } },
      'auto', undefined, authorize, undefined, undefined, undefined, context,
    )).resolves.toMatchObject({ ok: true })
    expect(followTab).toHaveBeenCalledWith(expect.objectContaining({ id: 12 }))
    expect(chromeMock.update).not.toHaveBeenCalled()

    await expect(dispatchToolCall(
      { id: 'close-tab', name: 'browser_close_tab', args: { tabId: 12 } },
      'auto', undefined, authorize, undefined, undefined, undefined, context,
    )).resolves.toMatchObject({ ok: true })
    expect(chromeMock.get).toHaveBeenCalledTimes(4)
    expect(chromeMock.remove).toHaveBeenCalledWith(12)
    expect(commitAction).toHaveBeenCalledTimes(2)
  })

  it('skips sharing blocks and approval prompts only in unrestricted mode', async () => {
    const authorize = vi.fn(async () => 'denied' as const)
    mockChrome({ tab: { id: 8, url: 'https://example.com/' }, tabs: [managedTab(8)] })

    await expect(dispatchToolCall(
      CALL, 'off', undefined, authorize, undefined, undefined, undefined,
      { unrestrictedAccess: true },
    )).resolves.toMatchObject({ ok: true })
    await expect(dispatchToolCall(
      { id: 'list-unrestricted', name: 'browser_list_tabs', args: {} },
      'ask', undefined, authorize, undefined, undefined, undefined,
      { unrestrictedAccess: true },
    )).resolves.toMatchObject({ ok: true })
    await expect(dispatchToolCall(
      { id: 'navigate-unrestricted', name: 'browser_navigate', args: { url: 'https://docs.example/' } },
      'ask', undefined, authorize, undefined,
      { id: 9, url: 'chrome://newtab/' }, undefined,
      { unrestrictedAccess: true },
    )).resolves.toMatchObject({ ok: true })
    expect(authorize).not.toHaveBeenCalled()
  })

  it('does not follow a tab that navigates while approval is pending', async () => {
    const target = managedTab(12, { url: 'https://docs.example/guide' })
    const followTab = vi.fn(async () => undefined)
    mockChrome({ tabs: [target] })

    await expect(dispatchToolCall(
      { id: 'follow-navigated', name: 'browser_follow_tab', args: { tabId: 12 } },
      'auto', undefined, async () => {
        target.url = 'https://bank.example/transfer'
        return 'approved'
      }, undefined, undefined, undefined,
      { unrestrictedAccess: false, followTab },
    )).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('navigated while approval was pending') },
    })
    expect(followTab).not.toHaveBeenCalled()
  })

  it('keeps the page-sharing privacy boundary ahead of tab access', async () => {
    const chromeMock = mockChrome({ tab: { id: 7, url: 'https://example.com' } })

    await expect(dispatchToolCall(CALL, 'off')).resolves.toMatchObject({
      ok: false,
      error: { code: 'action-failed' },
    })
    expect(chromeMock.query).not.toHaveBeenCalled()
  })

  it('dispatches to an explicitly bound background tab without querying the active tab', async () => {
    const chromeMock = mockChrome({
      tab: { id: 7, url: 'https://active.example/' },
      frames: [{ frameId: 0, parentFrameId: -1, documentId: 'bound-doc', url: 'https://bound.example/' }],
    })

    const answer = await dispatchToolCall(
      CALL,
      'auto',
      undefined,
      undefined,
      undefined,
      { id: 88, url: 'https://bound.example/' },
    )

    expect(answer.ok).toBe(true)
    expect(chromeMock.query).not.toHaveBeenCalled()
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(88, expect.any(Object), { documentId: 'bound-doc' })
  })

  it('aggregates top-level and cross-origin iframe snapshots', async () => {
    const chromeMock = mockChrome({
      tab: { id: 21, url: 'https://app.example/' },
      frames: [
        { frameId: 0, parentFrameId: -1, documentId: 'top-doc', url: 'https://app.example/' },
        { frameId: 4, parentFrameId: 0, documentId: 'child-doc', url: 'https://login.example.net/form' },
      ],
      respond: (_message, frameId) => ({ ok: true, result: { text: frameId === 0 ? 'TOP SNAPSHOT' : 'IFRAME SNAPSHOT' } }),
    })

    const answer = await dispatchToolCall(CALL, 'auto', { maxItems: 10, maxChars: 2_000 })

    expect(answer).toMatchObject({ ok: true })
    const text = (answer.result as { text: string }).text
    expect(text).toContain('TOP SNAPSHOT')
    expect(text).toContain('iframe frame=4 parent=0 origin=https://login.example.net')
    expect(text).toContain('IFRAME SNAPSHOT')
    expect(chromeMock.sendMessage.mock.calls.map((call) => call[2])).toEqual([
      { documentId: 'top-doc' },
      { documentId: 'child-doc' },
    ])
  })

  it('routes an element action to the requested frame and removes routing metadata', async () => {
    const call: ToolCall = { id: 'tool-frame', name: 'browser_click', args: { frame: 8, index: 3 } }
    const chromeMock = mockChrome({
      tab: { id: 22, url: 'https://app.example/' },
      frames: [
        { frameId: 0, parentFrameId: -1, documentId: 'top-doc', url: 'https://app.example/' },
        { frameId: 8, parentFrameId: 0, documentId: 'child-doc', url: 'https://widget.example/' },
      ],
      respond: (message, frameId) => {
        const action = (message as { action?: string }).action
        if (action === 'browser_snapshot') return { ok: true, result: { text: `frame ${frameId}` } }
        return OK
      },
    })

    await dispatchToolCall(CALL, 'auto')
    chromeMock.sendMessage.mockClear()
    await expect(dispatchToolCall(call, 'auto', undefined, async () => 'approved')).resolves.toEqual(OK)
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(22, {
      type: 'DSH_ACTION',
      action: 'browser_click',
      args: { index: 3 },
      budget: expect.objectContaining({ maxItems: 60 }),
      includePageDelta: true,
    }, { documentId: 'child-doc' })
  })

  it('returns automatic action deltas inside a fresh untrusted-content boundary', async () => {
    const call: ToolCall = { id: 'tool-delta', name: 'browser_click', args: { index: 3 } }
    const budget = { maxItems: 10, maxChars: 1_000 }
    const chromeMock = mockChrome({
      tab: { id: 33, url: 'https://app.example/' },
      respond: (message) => (message as { action?: string }).action === 'browser_snapshot'
        ? { ok: true, result: { text: 'Initial page' } }
        : {
            ok: true,
            result: {
              text: 'Clicked [3].',
              pageContent: 'Page change v2\nChanged main content:\nOrder complete',
            },
          },
    })
    await dispatchToolCall(CALL, 'auto', budget)
    chromeMock.sendMessage.mockClear()

    const answer = await dispatchToolCall(call, 'auto', budget, async () => 'approved')

    expect(answer.ok).toBe(true)
    const result = answer.result as { text: string; pageContent?: string }
    expect(result.text).toContain('Clicked [3].')
    expect(result.text).toContain('Continue from this state')
    expect(result.text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(result.text).toContain('Order complete')
    expect(result.text.length).toBeLessThanOrEqual(budget.maxChars)
    expect(result.pageContent).toBeUndefined()
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(33, {
      type: 'DSH_ACTION',
      action: 'browser_click',
      args: { index: 3 },
      budget,
      includePageDelta: true,
    }, { documentId: 'document-33' })
  })

  it('does not extract or forward an action delta when reads require approval', async () => {
    const call: ToolCall = { id: 'tool-private-delta', name: 'browser_click', args: { index: 2 } }
    const chromeMock = mockChrome({
      tab: { id: 34, url: 'https://private.example/' },
      respond: (message) => (message as { action?: string }).action === 'browser_snapshot'
        ? { ok: true, result: { text: 'Initial private page' } }
        : {
            ok: true,
            result: {
              text: 'Clicked [2].',
              pageContent: 'This content must not cross the sharing boundary',
            },
          },
    })
    await dispatchToolCall(CALL, 'auto')
    chromeMock.sendMessage.mockClear()

    const commitAction = vi.fn()
    const answer = await dispatchToolCall(
      call,
      'ask',
      undefined,
      async () => 'approved',
      undefined,
      undefined,
      undefined,
      { unrestrictedAccess: false, commitAction },
    )

    expect(answer).toEqual({ ok: true, result: { text: 'Clicked [2].' } })
    expect(commitAction).toHaveBeenCalledOnce()
    expect(chromeMock.sendMessage).toHaveBeenCalledWith(34, {
      type: 'DSH_ACTION',
      action: 'browser_click',
      args: { index: 2 },
    }, { documentId: 'document-34' })
  })

  it('returns the replacement page snapshot in the same navigation tool call', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'document-before', url: 'https://app.example/start' },
    ]
    const budget = { maxItems: 10, maxChars: 2_000 }
    const chromeMock = mockChrome({
      tab: { id: 35, url: 'https://app.example/start' },
      frames,
      respond: (message) => (message as { action?: string }).action === 'browser_navigate'
        ? {
            ok: true,
            result: {
              text: 'Navigating to https://app.example/next. Call browser_snapshot again after the page loads.',
              navigationPending: true,
            },
          }
        : { ok: true, result: { text: 'Title: Next page\nURL: https://app.example/next' } },
    })

    const pending = dispatchToolCall(
      { id: 'tool-navigation', name: 'browser_navigate', args: { url: 'https://app.example/next' } },
      'auto',
      budget,
      async () => 'approved',
    )
    await vi.waitFor(() => { expect(chromeMock.sendMessage).toHaveBeenCalledTimes(1) })
    frames[0] = {
      frameId: 0,
      parentFrameId: -1,
      documentId: 'document-after',
      url: 'https://app.example/next',
    }
    chromeMock.emitContentReady(35, 0, 'document-after')

    const answer = await pending
    const text = (answer.result as { text: string }).text
    expect(text).toContain('Navigation completed')
    expect(text).toContain('Title: Next page')
    expect(text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(text).not.toContain('Call browser_snapshot again')
    expect(text.length).toBeLessThanOrEqual(budget.maxChars)
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(2)
    expect(chromeMock.sendMessage).toHaveBeenLastCalledWith(35, expect.objectContaining({
      action: 'browser_snapshot',
      args: { delta: false },
      budget: expect.objectContaining({ maxChars: expect.any(Number) }),
    }), { documentId: 'document-after' })
  })

  it('reports a dispatched click as success when the page navigated before answering', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'document-before', url: 'https://app.example/start' },
    ]
    let snapshotText = 'Title: Start page'
    const chromeMock = mockChrome({
      tab: { id: 61, url: 'https://app.example/start' },
      frames,
      respond: (message) => (message as { action?: string }).action === 'browser_click'
        ? new Error('The message port closed before a response was received.')
        : { ok: true, result: { text: snapshotText } },
    })
    await dispatchToolCall(CALL, 'auto', { maxItems: 10, maxChars: 2_000 }, async () => 'approved')
    chromeMock.sendMessage.mockClear()
    snapshotText = 'Title: Next page'

    const pending = dispatchToolCall(
      { id: 'js-nav-click', name: 'browser_click', args: { index: 8 } },
      'auto',
      { maxItems: 10, maxChars: 2_000 },
      async () => 'approved',
    )
    await vi.waitFor(() => { expect(chromeMock.sendMessage).toHaveBeenCalledTimes(1) })
    frames[0] = { frameId: 0, parentFrameId: -1, documentId: 'document-after', url: 'https://app.example/next' }
    chromeMock.emitContentReady(61, 0, 'document-after')

    const answer = await pending
    expect(answer).toMatchObject({ ok: true })
    const text = (answer.result as { text: string }).text
    expect(text).toContain('Clicked [8]. The page navigated; the current page snapshot is included below.')
    expect(text).toContain('Use it directly instead of taking an immediate duplicate snapshot.')
    expect(text).toContain('Title: Next page')
    expect(text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(2)
    expect(chromeMock.sendMessage).toHaveBeenLastCalledWith(61, expect.objectContaining({
      action: 'browser_snapshot',
    }), { documentId: 'document-after' })
  })

  it('reports success when the receiver vanished because the page navigated', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'document-before', url: 'https://app.example/start' },
    ]
    const chromeMock = mockChrome({
      tab: { id: 66, url: 'https://app.example/start' },
      frames,
      respond: (message) => (message as { action?: string }).action === 'browser_click'
        ? new Error('Could not establish connection. Receiving end does not exist.')
        : { ok: true, result: { text: 'Title: Next page' } },
    })
    await dispatchToolCall(CALL, 'auto', { maxItems: 10, maxChars: 2_000 }, async () => 'approved')
    chromeMock.sendMessage.mockClear()

    const pending = dispatchToolCall(
      { id: 'receiver-gone-click', name: 'browser_click', args: { index: 2 } },
      'auto',
      { maxItems: 10, maxChars: 2_000 },
      async () => 'approved',
    )
    await vi.waitFor(() => { expect(chromeMock.sendMessage).toHaveBeenCalledTimes(1) })
    frames[0] = { frameId: 0, parentFrameId: -1, documentId: 'document-after', url: 'https://app.example/next' }
    chromeMock.emitContentReady(66, 0, 'document-after')

    const answer = await pending
    expect(answer).toMatchObject({ ok: true })
    expect((answer.result as { text: string }).text)
      .toContain('Clicked [2]. The page navigated; the current page snapshot is included below.')
    expect(chromeMock.executeScript).not.toHaveBeenCalled()
  })

  it('keeps the delivery error when a lost response did not navigate', async () => {
    vi.useFakeTimers()
    try {
      const chromeMock = mockChrome({
        tab: { id: 62, url: 'https://app.example/form' },
        respond: (message) => (message as { action?: string }).action === 'browser_click'
          ? new Error('The message port closed before a response was received.')
          : { ok: true, result: { text: 'Title: Form' } },
      })
      await dispatchToolCall(CALL, 'auto', { maxItems: 10, maxChars: 2_000 }, async () => 'approved')
      chromeMock.sendMessage.mockClear()
      const pending = dispatchToolCall(
        { id: 'lost-response', name: 'browser_click', args: { index: 3 } },
        'auto',
        { maxItems: 10, maxChars: 2_000 },
        async () => 'approved',
      )
      await vi.advanceTimersByTimeAsync(9_000)
      const answer = await pending
      expect(answer).toMatchObject({
        ok: false,
        error: { code: 'content-unavailable', message: expect.stringContaining('operation was dispatched') },
      })
      expect(chromeMock.executeScript).not.toHaveBeenCalled()
      expect(chromeMock.sendMessage).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a restored iframe in the snapshot when getAllFrames omits it', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'top-doc', url: 'https://app.example/' },
      { frameId: 636, parentFrameId: 0, documentId: 'child-doc', url: 'https://embed.example.net/' },
    ]
    const chromeMock = mockChrome({
      tab: { id: 63, url: 'https://app.example/' },
      frames,
      respond: (_message, frameId) => ({ ok: true, result: { text: frameId === 0 ? 'TOP SNAPSHOT' : 'IFRAME SNAPSHOT' } }),
    })

    const first = await dispatchToolCall(CALL, 'auto', { maxItems: 10, maxChars: 2_000 })
    expect((first.result as { text: string }).text).toContain('iframe frame=636')

    // History restore: Chrome lists only the main frame, with the same document id.
    frames.splice(1, 1)
    const second = await dispatchToolCall(CALL, 'auto', { maxItems: 10, maxChars: 2_000 })
    const text = (second.result as { text: string }).text
    expect(text).toContain('iframe frame=636 parent=0 origin=https://embed.example.net')
    expect(text).toContain('IFRAME SNAPSHOT')
    expect(chromeMock.sendMessage.mock.calls.map((entry) => entry[2])).toContainEqual({ documentId: 'child-doc' })
  })

  it('still includes the iframe when the frame tree returns an unaddressable entry', async () => {
    const frames: Array<{ frameId: number; parentFrameId: number; documentId?: string; url: string }> = [
      { frameId: 0, parentFrameId: -1, documentId: 'top-doc', url: 'https://app.example/' },
      { frameId: 636, parentFrameId: 0, documentId: 'child-doc', url: 'https://embed.example.net/' },
    ]
    mockChrome({
      tab: { id: 64, url: 'https://app.example/' },
      frames,
      respond: (_message, frameId) => ({ ok: true, result: { text: frameId === 0 ? 'TOP SNAPSHOT' : 'IFRAME SNAPSHOT' } }),
    })
    await dispatchToolCall(CALL, 'auto', { maxItems: 10, maxChars: 2_000 })

    const stale = [
      { frameId: 0, parentFrameId: -1, documentId: 'top-doc', url: 'https://app.example/' },
      { frameId: undefined, parentFrameId: 0, documentId: 'child-doc', url: 'https://embed.example.net/' },
    ] as unknown as typeof frames
    frames.splice(0, frames.length, ...stale)
    const answer = await dispatchToolCall(CALL, 'auto', { maxItems: 10, maxChars: 2_000 })
    const text = (answer.result as { text: string }).text
    expect(text).toContain('iframe frame=636')
    expect(text).toContain('IFRAME SNAPSHOT')
  })

  it('does not resurrect a remembered iframe in a different main document', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'top-doc', url: 'https://app.example/' },
      { frameId: 636, parentFrameId: 0, documentId: 'child-doc', url: 'https://embed.example.net/' },
    ]
    mockChrome({
      tab: { id: 65, url: 'https://app.example/' },
      frames,
      respond: (_message, frameId) => ({ ok: true, result: { text: frameId === 0 ? 'TOP SNAPSHOT' : 'IFRAME SNAPSHOT' } }),
    })
    await dispatchToolCall(CALL, 'auto', { maxItems: 10, maxChars: 2_000 })

    frames.splice(0, frames.length, {
      frameId: 0, parentFrameId: -1, documentId: 'top-doc-2', url: 'https://app.example/next',
    })
    const answer = await dispatchToolCall(CALL, 'auto', { maxItems: 10, maxChars: 2_000 })
    expect((answer.result as { text: string }).text).not.toContain('iframe frame=636')
  })

  it('does not wait for or return navigation page content when reads are not automatic', async () => {
    const chromeMock = mockChrome({
      tab: { id: 36, url: 'https://app.example/start' },
      respond: () => ({
        ok: true,
        result: {
          text: 'Navigating to https://app.example/next. Call browser_snapshot again after the page loads.',
          navigationPending: true,
        },
      }),
    })

    const answer = await dispatchToolCall(
      { id: 'tool-private-navigation', name: 'browser_navigate', args: { url: 'https://app.example/next' } },
      'ask',
      undefined,
      async () => 'approved',
    )

    expect(answer).toEqual({
      ok: true,
      result: { text: expect.stringContaining('Call browser_snapshot again') },
    })
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('wraps browser_get_text output in the same untrusted-content boundary', async () => {
    const call: ToolCall = { id: 'tool-text', name: 'browser_get_text', args: {} }
    mockChrome({ tab: { id: 24, url: 'https://app.example/' }, responses: [{ ok: true, result: { text: 'page text' } }] })

    const answer = await dispatchToolCall(call, 'auto', { maxItems: 10, maxChars: 1_000 })

    const text = (answer.result as { text: string }).text
    expect(text).toContain('page text')
    expect(text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(text.length).toBeLessThanOrEqual(1_000)
  })

  it('returns the explicit user denial before reading', async () => {
    const authorize = vi.fn(async () => 'denied' as const)
    const chromeMock = mockChrome({
      tab: { id: 25, url: 'https://app.example/' },
      frames: [
        { frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://app.example/' },
        { frameId: 2, parentFrameId: 0, documentId: 'child', url: 'https://embed.example.net/' },
      ],
    })

    const answer = await dispatchToolCall(CALL, 'ask', undefined, authorize)

    expect(answer).toEqual({
      ok: false,
      error: {
        code: 'action-failed',
        message: 'The user denied the browser approval request for "browser_snapshot".',
      },
    })
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'read',
      origins: ['https://app.example', 'https://embed.example.net'],
    }))
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('reports when no side panel can receive a state-changing approval', async () => {
    const call: ToolCall = { id: 'tool-denied', name: 'browser_press', args: { key: 'Enter' } }
    const chromeMock = mockChrome({ tab: { id: 26, url: 'https://app.example/' } })

    const answer = await dispatchToolCall(call, 'auto')

    expect(answer).toEqual({
      ok: false,
      error: {
        code: 'action-failed',
        message: 'No browser side panel was available to receive or complete the approval request for "browser_press".',
      },
    })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('returns an approval timeout without treating it as a user denial', async () => {
    const call: ToolCall = { id: 'tool-timeout', name: 'browser_press', args: { key: 'Enter' } }
    const chromeMock = mockChrome({ tab: { id: 27, url: 'https://app.example/' } })

    const answer = await dispatchToolCall(call, 'auto', undefined, async () => 'timed-out')

    expect(answer).toEqual({
      ok: false,
      error: {
        code: 'timeout',
        message: 'The browser approval request for "browser_press" timed out before the user responded.',
      },
    })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('does not dispatch an action after its bridge call is cancelled during approval', async () => {
    const call: ToolCall = { id: 'tool-cancelled', name: 'browser_press', args: { key: 'Enter' } }
    const controller = new AbortController()
    const chromeMock = mockChrome({ tab: { id: 27, url: 'https://app.example/' } })
    const authorize = vi.fn(async () => {
      controller.abort()
      return 'approved' as const
    })

    const answer = await dispatchToolCall(call, 'auto', undefined, authorize, controller.signal)

    expect(answer).toMatchObject({ ok: false, error: { code: 'bridge-closed' } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('does not dispatch an approved action after tab affinity changes', async () => {
    const call: ToolCall = { id: 'tool-switched', name: 'browser_press', args: { key: 'Enter' } }
    let targetAllowed = true
    const chromeMock = mockChrome({ tab: { id: 28, url: 'https://app.example/' } })
    const authorize = vi.fn(async () => {
      targetAllowed = false
      return 'approved' as const
    })

    const answer = await dispatchToolCall(
      call,
      'auto',
      undefined,
      authorize,
      undefined,
      { id: 28, url: 'https://app.example/' },
      () => targetAllowed,
    )

    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('controlled tab') } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects an element reference after its frame document reloads', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'top-doc', url: 'https://app.example/' },
      { frameId: 3, parentFrameId: 0, documentId: 'child-v1', url: 'https://widget.example/form' },
    ]
    const chromeMock = mockChrome({
      tab: { id: 30, url: 'https://app.example/' },
      frames,
      respond: (_message, frameId) => ({ ok: true, result: { text: `frame ${frameId}` } }),
    })
    await dispatchToolCall(CALL, 'auto')
    chromeMock.sendMessage.mockClear()
    frames[1] = { ...frames[1]!, documentId: 'child-v2' }

    const answer = await dispatchToolCall(
      { id: 'stale-click', name: 'browser_click', args: { frame: 3, index: 4 } },
      'auto',
      undefined,
      async () => 'approved',
    )

    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('Call browser_snapshot again') } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('defers a URL-keyed frame reference to the content script so it can re-resolve the ref', async () => {
    const frames = [{ frameId: 0, parentFrameId: -1, url: 'https://app.example/list' }]
    const chromeMock = mockChrome({
      tab: { id: 34, url: 'https://app.example/list' },
      frames,
      respond: () => ({ ok: true, result: { text: 'ok' } }),
    })
    await dispatchToolCall({ id: 'snap-url', name: 'browser_snapshot', args: {} }, 'auto')
    chromeMock.sendMessage.mockClear()
    // Browser builds without document ids report a frame by URL, so a client-side
    // route change is indistinguishable from a document replacement here.
    frames[0] = { ...frames[0]!, url: 'https://app.example/list?page=2' }

    const answer = await dispatchToolCall(
      { id: 'url-rebind', name: 'browser_click', args: { index: 2 } },
      'auto',
      undefined,
      async () => 'approved',
    )

    expect(answer.ok).toBe(true)
    expect(chromeMock.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('rejects an action when its target origin changes during approval', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'top-v1', url: 'https://app.example/' },
    ]
    const chromeMock = mockChrome({ tab: { id: 31, url: 'https://app.example/' }, frames })
    const authorize = vi.fn(async () => {
      frames[0] = { ...frames[0]!, documentId: 'top-v2', url: 'https://evil.example/' }
      return 'approved' as const
    })

    const answer = await dispatchToolCall(
      { id: 'changed-origin', name: 'browser_press', args: { key: 'Enter' } },
      'auto',
      undefined,
      authorize,
    )

    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('page changed while approval was pending') } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('rejects an action when the same-origin document changes during approval', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'top-v1', url: 'https://app.example/one' },
    ]
    const chromeMock = mockChrome({ tab: { id: 32, url: 'https://app.example/one' }, frames })
    const authorize = vi.fn(async () => {
      frames[0] = { ...frames[0]!, documentId: 'top-v2', url: 'https://app.example/two' }
      return 'approved' as const
    })

    const answer = await dispatchToolCall(
      { id: 'changed-document', name: 'browser_press', args: { key: 'Enter' } },
      'auto',
      undefined,
      authorize,
    )

    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('page changed while approval was pending') } })
    expect(chromeMock.sendMessage).not.toHaveBeenCalled()
  })

  it('forces a full snapshot for a newly navigated frame before resuming deltas', async () => {
    const frames = [
      { frameId: 0, parentFrameId: -1, documentId: 'top-doc', url: 'https://app.example/' },
      { frameId: 6, parentFrameId: 0, documentId: 'child-v1', url: 'https://widget.example/one' },
    ]
    const seen: Array<{ frameId: number; delta: unknown }> = []
    const chromeMock = mockChrome({
      tab: { id: 23, url: 'https://app.example/' },
      frames,
      respond: (message, frameId) => {
        seen.push({ frameId, delta: (message as { args?: { delta?: unknown } }).args?.delta })
        return { ok: true, result: { text: `frame ${frameId}` } }
      },
    })
    const deltaCall: ToolCall = { ...CALL, id: 'delta', args: { delta: true } }

    await dispatchToolCall(deltaCall, 'auto')
    expect(seen.splice(0)).toEqual([{ frameId: 0, delta: false }, { frameId: 6, delta: false }])

    await dispatchToolCall(deltaCall, 'auto')
    expect(seen.splice(0)).toEqual([{ frameId: 0, delta: true }, { frameId: 6, delta: true }])

    frames[1] = { ...frames[1]!, documentId: 'child-v2', url: 'https://widget.example/two' }
    await dispatchToolCall(deltaCall, 'auto')
    expect(seen).toEqual([{ frameId: 0, delta: true }, { frameId: 6, delta: false }])
    expect(chromeMock.getAllFrames).toHaveBeenCalledTimes(3)
  })
})

describe('dispatchOpenTab', () => {
  it('creates a blank tab, navigates after arming readiness, rebinds, and snapshots', async () => {
    const { dispatchOpenTab } = await import('../src/background/tools.ts')
    const runtimeListeners = new Set<(message: unknown, sender: chrome.runtime.MessageSender) => void>()
    const create = vi.fn(async () => ({ id: 42, windowId: 9, url: '' }))
    const update = vi.fn(async () => ({ id: 42, windowId: 9, url: 'https://docs.example/' }))
    const remove = vi.fn(async () => undefined)
    const sendMessage = vi.fn(async () => ({ ok: true, result: { text: 'new page' } }))
    const getAllFrames = vi.fn(async () => [{
      frameId: 0, parentFrameId: -1, documentId: 'doc-42', url: 'https://docs.example/',
    }])
    vi.stubGlobal('chrome', {
      tabs: { create, update, remove, sendMessage, query: vi.fn(async () => []) },
      scripting: { executeScript: vi.fn(async () => [{ frameId: 0, result: undefined }]) },
      webNavigation: { getAllFrames },
      runtime: {
        onMessage: {
          addListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
            runtimeListeners.add(listener)
          },
          removeListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
            runtimeListeners.delete(listener)
          },
        },
      },
    })

    const bindCreatedTab = vi.fn(() => true)
    const commitAction = vi.fn()
    const open = dispatchOpenTab(
      { id: 'open-1', name: 'browser_open_tab', args: { url: 'https://docs.example/' } },
      9,
      'auto',
      { maxItems: 60, maxChars: 12_000 },
      async () => 'approved',
      undefined,
      bindCreatedTab,
      () => true,
      commitAction,
    )
    await vi.waitFor(() => { expect(runtimeListeners.size).toBe(1) })
    expect(create).toHaveBeenCalledWith({ active: true, windowId: 9 })
    expect(update).toHaveBeenCalledWith(42, { url: 'https://docs.example/' })
    for (const listener of runtimeListeners) {
      listener(
        { type: 'DSH_CONTENT_READY' },
        {
          tab: { id: 42 }, frameId: 0, documentId: 'blank-doc', url: 'about:blank',
        } as chrome.runtime.MessageSender,
      )
    }
    await Promise.resolve()
    expect(bindCreatedTab).not.toHaveBeenCalled()
    for (const listener of runtimeListeners) {
      listener(
        { type: 'DSH_CONTENT_READY' },
        {
          tab: { id: 42 }, frameId: 0, documentId: 'doc-42', url: 'https://docs.example/',
        } as chrome.runtime.MessageSender,
      )
    }
    const answer = await open
    expect(bindCreatedTab).toHaveBeenCalledOnce()
    expect(commitAction).toHaveBeenCalledOnce()
    expect(remove).not.toHaveBeenCalled()
    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toContain('Opened a new tab')
    expect((answer.result as { text: string }).text).toContain('new page')
  })

  it('opens a background tab when active is false', async () => {
    const { dispatchOpenTab } = await import('../src/background/tools.ts')
    const { bindOpenedTabAffinity } = await import('../src/background/open-tab-binding.ts')
    const { TabAffinityController } = await import('../src/background/tab-affinity.ts')
    const affinity = new TabAffinityController()
    affinity.observeActive({
      tabId: 1,
      windowId: 9,
      title: 'Current',
      url: 'https://current.example/',
    })
    affinity.bindInitial({
      tabId: 1,
      windowId: 9,
      title: 'Current',
      url: 'https://current.example/',
    }, 'session-bg')

    const runtimeListeners = new Set<(message: unknown, sender: chrome.runtime.MessageSender) => void>()
    const create = vi.fn(async () => ({ id: 42, windowId: 9, url: '' }))
    const update = vi.fn(async () => ({ id: 42, windowId: 9, url: 'https://docs.example/' }))
    const remove = vi.fn(async () => undefined)
    const sendMessage = vi.fn(async () => ({
      type: 'DSH_RESULT',
      text: 'new page',
    }))
    const getAllFrames = vi.fn(async () => [{
      frameId: 0, parentFrameId: -1, documentId: 'doc-42', url: 'https://docs.example/',
    }])
    vi.stubGlobal('chrome', {
      tabs: { create, update, remove, sendMessage, query: vi.fn(async () => []) },
      scripting: { executeScript: vi.fn(async () => [{ frameId: 0, result: undefined }]) },
      webNavigation: { getAllFrames },
      runtime: {
        onMessage: {
          addListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
            runtimeListeners.add(listener)
          },
          removeListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
            runtimeListeners.delete(listener)
          },
        },
      },
    })

    const bindCreatedTab = (chromeTab: chrome.tabs.Tab) => {
      if (chromeTab.id === undefined) return false
      return bindOpenedTabAffinity(affinity, {
        tabId: chromeTab.id,
        windowId: chromeTab.windowId,
        title: chromeTab.title ?? '',
        url: chromeTab.url ?? '',
      }, { active: false, sessionId: 'session-bg' })
    }
    const open = dispatchOpenTab(
      { id: 'open-bg', name: 'browser_open_tab', args: { url: 'https://docs.example/', active: false } },
      9,
      'auto',
      { maxItems: 60, maxChars: 12_000 },
      async () => 'approved',
      undefined,
      bindCreatedTab,
      () => true,
    )
    await vi.waitFor(() => { expect(runtimeListeners.size).toBe(1) })
    expect(create).toHaveBeenCalledWith({ active: false, windowId: 9 })
    for (const listener of runtimeListeners) {
      listener(
        { type: 'DSH_CONTENT_READY' },
        {
          tab: { id: 42 }, frameId: 0, documentId: 'blank-doc', url: 'about:blank',
        } as chrome.runtime.MessageSender,
      )
    }
    await Promise.resolve()
    for (const listener of runtimeListeners) {
      listener(
        { type: 'DSH_CONTENT_READY' },
        {
          tab: { id: 42 }, frameId: 0, documentId: 'doc-42', url: 'https://docs.example/',
        } as chrome.runtime.MessageSender,
      )
    }
    const answer = await open
    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toContain('Opened a new background tab')
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      active: { tabId: 1 },
      controlled: { tabId: 42 },
    })
    expect(affinity.resolveTarget('session-bg')).toMatchObject({
      kind: 'target',
      tab: { tabId: 42 },
    })
    expect(affinity.allowsTarget(42)).toBe(true)
    expect(affinity.allowsTarget(1)).toBe(false)
  })

  it('rejects non-http URLs before creating a tab', async () => {
    const { dispatchOpenTab } = await import('../src/background/tools.ts')
    const create = vi.fn()
    vi.stubGlobal('chrome', { tabs: { create } })
    const answer = await dispatchOpenTab(
      { id: 'open-bad', name: 'browser_open_tab', args: { url: 'javascript:alert(1)' } },
      1,
      'auto',
      undefined,
      async () => 'approved',
      undefined,
      () => true,
      () => true,
    )
    expect(answer).toEqual({
      ok: false,
      error: { code: 'action-failed', message: 'url must be a complete http or https URL.' },
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('rolls back an unbound tab when cancelled before affinity bind', async () => {
    const { dispatchOpenTab } = await import('../src/background/tools.ts')
    const controller = new AbortController()
    const runtimeListeners = new Set<(message: unknown, sender: chrome.runtime.MessageSender) => void>()
    const create = vi.fn(async () => ({ id: 55, windowId: 2, url: '' }))
    const update = vi.fn(async () => ({ id: 55, windowId: 2, url: 'https://docs.example/' }))
    const remove = vi.fn(async () => undefined)
    vi.stubGlobal('chrome', {
      tabs: { create, update, remove, sendMessage: vi.fn(), query: vi.fn(async () => []) },
      scripting: { executeScript: vi.fn(async () => []) },
      webNavigation: { getAllFrames: vi.fn(async () => []) },
      runtime: {
        onMessage: {
          addListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
            runtimeListeners.add(listener)
          },
          removeListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
            runtimeListeners.delete(listener)
          },
        },
      },
    })
    const bindCreatedTab = vi.fn(() => true)
    const open = dispatchOpenTab(
      { id: 'open-cancel', name: 'browser_open_tab', args: { url: 'https://docs.example/' } },
      2,
      'auto',
      undefined,
      async () => 'approved',
      controller.signal,
      bindCreatedTab,
      () => true,
    )
    await vi.waitFor(() => { expect(runtimeListeners.size).toBe(1) })
    controller.abort()
    await expect(open).resolves.toMatchObject({
      ok: false,
      error: { code: 'bridge-closed' },
    })
    expect(remove).toHaveBeenCalledWith(55)
    expect(bindCreatedTab).not.toHaveBeenCalled()
  })

  it('reports a committed open instead of cancellation after affinity bind', async () => {
    const { dispatchOpenTab } = await import('../src/background/tools.ts')
    const controller = new AbortController()
    const runtimeListeners = new Set<(message: unknown, sender: chrome.runtime.MessageSender) => void>()
    const create = vi.fn(async () => ({ id: 77, windowId: 3, url: '' }))
    const update = vi.fn(async () => ({ id: 77, windowId: 3, url: 'https://docs.example/' }))
    const remove = vi.fn(async () => undefined)
    const sendMessage = vi.fn(async () => ({ ok: true, result: { text: 'late page' } }))
    const getAllFrames = vi.fn(async () => [{
      frameId: 0, parentFrameId: -1, documentId: 'doc-77', url: 'https://docs.example/',
    }])
    vi.stubGlobal('chrome', {
      tabs: { create, update, remove, sendMessage, query: vi.fn(async () => []) },
      scripting: { executeScript: vi.fn(async () => [{ frameId: 0, result: undefined }]) },
      webNavigation: { getAllFrames },
      runtime: {
        onMessage: {
          addListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
            runtimeListeners.add(listener)
          },
          removeListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
            runtimeListeners.delete(listener)
          },
        },
      },
    })
    const bindCreatedTab = vi.fn(() => {
      controller.abort()
      return true
    })
    const open = dispatchOpenTab(
      { id: 'open-committed', name: 'browser_open_tab', args: { url: 'https://docs.example/' } },
      3,
      'auto',
      { maxItems: 60, maxChars: 12_000 },
      async () => 'approved',
      controller.signal,
      bindCreatedTab,
      () => true,
    )
    await vi.waitFor(() => { expect(runtimeListeners.size).toBe(1) })
    for (const listener of runtimeListeners) {
      listener(
        { type: 'DSH_CONTENT_READY' },
        {
          tab: { id: 77 }, frameId: 0, documentId: 'doc-77', url: 'https://docs.example/',
        } as chrome.runtime.MessageSender,
      )
    }
    const answer = await open
    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toContain('Opened a new tab')
    expect((answer.result as { text: string }).text).toContain('Call browser_snapshot again')
    expect(remove).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })
})

describe('browser_close', () => {
  /**
   * Chrome stub that can create one tab through the real browser_open_tab path,
   * so browser_close reads the same created-tab ledger production uses.
   */
  function createdTabChrome(createdId: number, existing: chrome.tabs.Tab[] = []) {
    const runtimeListeners = new Set<(message: unknown, sender: chrome.runtime.MessageSender) => void>()
    const tabs = new Map<number, chrome.tabs.Tab>()
    for (const tab of existing) if (tab.id !== undefined) tabs.set(tab.id, tab)
    const create = vi.fn(async () => {
      const tab = managedTab(createdId, { url: 'about:blank', index: existing.length })
      tabs.set(createdId, tab)
      return { ...tab }
    })
    const update = vi.fn(async (tabId: number, changes: chrome.tabs.UpdateProperties) => {
      const current = tabs.get(tabId) ?? managedTab(tabId)
      const next = { ...current, ...changes }
      tabs.set(tabId, next)
      return { ...next }
    })
    const get = vi.fn(async (tabId: number) => {
      const tab = tabs.get(tabId)
      if (tab === undefined) throw new Error(`No tab with id: ${tabId}`)
      return { ...tab }
    })
    const remove = vi.fn(async (tabId: number) => {
      tabs.delete(tabId)
    })
    const query = vi.fn(async () => [...tabs.values()])
    const sendMessage = vi.fn(async () => ({ ok: true, result: { text: 'new page' } }))
    const createAllFrames = (): unknown[] => [{
      frameId: 0,
      parentFrameId: -1,
      documentId: `doc-${createdId}`,
      url: tabs.get(createdId)?.url ?? '',
    }]
    const getAllFrames = vi.fn(async () => createAllFrames())
    vi.stubGlobal('chrome', {
      tabs: { create, update, remove, get, query, sendMessage },
      scripting: { executeScript: vi.fn(async () => [{ frameId: 0, result: undefined }]) },
      webNavigation: { getAllFrames },
      runtime: {
        onMessage: {
          addListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
            runtimeListeners.add(listener)
          },
          removeListener: (listener: (message: unknown, sender: chrome.runtime.MessageSender) => void) => {
            runtimeListeners.delete(listener)
          },
        },
      },
    })
    return { create, get, getAllFrames, query, remove, runtimeListeners, tabs }
  }

  /** Open one tab through the same path browser_open_tab uses. */
  async function openCreatedTab(chromeMock: ReturnType<typeof createdTabChrome>, createdId: number): Promise<void> {
    const { dispatchOpenTab } = await import('../src/background/tools.ts')
    const open = dispatchOpenTab(
      { id: 'open-close', name: 'browser_open_tab', args: { url: 'https://docs.example/new' } },
      1,
      'auto',
      { maxItems: 60, maxChars: 12_000 },
      async () => 'approved',
      undefined,
      () => true,
      () => true,
    )
    await vi.waitFor(() => { expect(chromeMock.runtimeListeners.size).toBe(1) })
    for (const listener of chromeMock.runtimeListeners) {
      listener(
        { type: 'DSH_CONTENT_READY' },
        {
          tab: { id: createdId }, frameId: 0, documentId: `doc-${createdId}`, url: 'https://docs.example/new',
        } as chrome.runtime.MessageSender,
      )
    }
    await expect(open).resolves.toMatchObject({ ok: true })
  }

  it('lists created versus adopted tabs, then closes only the tabs this session opened', async () => {
    const chromeMock = createdTabChrome(91, [managedTab(12, { windowId: 1, index: 0 })])
    await openCreatedTab(chromeMock, 91)
    const context = {
      unrestrictedAccess: true,
      ownsTab: (tabId: number) => tabId === 91,
      commitAction: vi.fn(),
    }

    const listed = await dispatchToolCall(
      { id: 'list-origin', name: 'browser_list_tabs', args: {} },
      'auto', undefined, undefined, undefined, undefined, undefined, context,
    )
    const text = (listed.result as { text: string }).text
    const body = /<UNTRUSTED_PAGE_CONTENT nonce="[^"]+">\n([\s\S]*)\n<\/UNTRUSTED_PAGE_CONTENT/.exec(text)![1]!
    const rows = (JSON.parse(body) as {
      tabs: { tabId: number; origin: string; owned: boolean }[]
    }).tabs
    expect(rows.find((row) => row.tabId === 91)).toMatchObject({ origin: 'created', owned: true })
    expect(rows.find((row) => row.tabId === 12)).toMatchObject({ origin: 'adopted', owned: false })

    const closed = await dispatchToolCall(
      { id: 'close-own', name: 'browser_close', args: {} },
      'auto', undefined, undefined, undefined, undefined, undefined, context,
    )
    expect(closed).toMatchObject({ ok: true })
    expect((closed.result as { text: string }).text).toContain('Closed 1 tab(s) opened by this session: [91].')
    expect(chromeMock.remove).toHaveBeenCalledTimes(1)
    expect(chromeMock.remove).toHaveBeenCalledWith(91)
  })

  it('closes nothing and succeeds when the session has not opened a tab', async () => {
    mockChrome({ tabs: [managedTab(5)] })
    const context = { unrestrictedAccess: true, ownsTab: () => false, commitAction: vi.fn() }

    const answer = await dispatchToolCall(
      { id: 'close-none', name: 'browser_close', args: {} },
      'auto', undefined, undefined, undefined, undefined, undefined, context,
    )

    expect(answer).toMatchObject({ ok: true })
    expect((answer.result as { text: string }).text).toBe(
      'Closed no tabs: this session has not opened any tab (closed: []).',
    )
  })

  it('refuses a named tab this session neither opened nor followed, while browser_close_tab keeps its semantics', async () => {
    const chromeMock = mockChrome({ tabs: [managedTab(5)] })
    const context = { unrestrictedAccess: true, ownsTab: () => false, commitAction: vi.fn() }

    await expect(dispatchToolCall(
      { id: 'close-foreign', name: 'browser_close', args: { tabId: 5 } },
      'auto', undefined, undefined, undefined, undefined, undefined, context,
    )).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'tab_outside',
        message: expect.stringContaining("it is not this session's to close"),
      },
    })
    expect(chromeMock.remove).not.toHaveBeenCalled()

    // The legacy tool keeps its original contract: with tab isolation off it
    // closes whatever tab it is pointed at, without an ownership check.
    await expect(dispatchToolCall(
      { id: 'close-legacy', name: 'browser_close_tab', args: { tabId: 5 } },
      'auto', undefined, undefined, undefined, undefined, undefined, context,
    )).resolves.toMatchObject({ ok: true })
    expect(chromeMock.remove).toHaveBeenCalledWith(5)
  })
})

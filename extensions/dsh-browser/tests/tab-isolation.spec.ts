// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TabAffinityController, type AffinityTab } from '../src/background/tab-affinity.ts'
import { dispatchToolCall, resolveTargetTab, type ToolCall } from '../src/background/tools.ts'

function affinityTab(tabId: number, url = `https://example.com/${tabId}`): AffinityTab {
  return { tabId, windowId: 1, title: `Tab ${tabId}`, url }
}

function chromeTab(tabId: number, url = `https://example.com/${tabId}`): chrome.tabs.Tab {
  return {
    id: tabId,
    windowId: 1,
    index: 0,
    active: true,
    highlighted: true,
    pinned: false,
    incognito: false,
    selected: true,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    url,
    title: `Tab ${tabId}`,
  }
}

function stubChrome(tabs: chrome.tabs.Tab[], options: { sendMessage?: ReturnType<typeof vi.fn> } = {}) {
  const sendMessage = options.sendMessage ?? vi.fn(async () => ({ ok: true, result: { text: 'page' } }))
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => tabs),
      get: vi.fn(async (tabId: number) => {
        const found = tabs.find((tab) => tab.id === tabId)
        if (found === undefined) throw new Error(`No tab with id: ${tabId}`)
        return found
      }),
      sendMessage,
      remove: vi.fn(async () => undefined),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    webNavigation: {
      getAllFrames: vi.fn(async () => [{
        tabId: tabs[0]?.id ?? 1,
        frameId: 0,
        parentFrameId: -1,
        documentId: 'document-1',
        url: tabs[0]?.url ?? 'https://example.com/',
      }]),
    },
    runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  })
  return { sendMessage }
}

const SNAPSHOT: ToolCall = { id: 'call', name: 'browser_snapshot', args: {} }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('TabAffinityController tab ownership', () => {
  it('claims the tab a session binds to and reports its origin', () => {
    const affinity = new TabAffinityController()
    expect(affinity.bindInitial(affinityTab(4), 'session-1')).toBe(true)

    expect(affinity.ownsTab(4)).toBe(true)
    expect(affinity.ownedTabOrigins()).toEqual([{ tabId: 4, origin: 'bound' }])
  })

  it('records opened and followed tabs with their claiming decision', () => {
    const affinity = new TabAffinityController()
    affinity.claimTab(7, 'opened')
    affinity.claimTab(9, 'followed')

    expect(affinity.ownsTab(7)).toBe(true)
    expect(affinity.ownsTab(9)).toBe(true)
    expect(affinity.ownedTabOrigins()).toEqual([
      { tabId: 7, origin: 'opened' },
      { tabId: 9, origin: 'followed' },
    ])
  })

  it('drops a closed tab and transfers ownership when Chrome replaces a tab', () => {
    const affinity = new TabAffinityController()
    affinity.bindInitial(affinityTab(4), 'session-1')
    affinity.claimTab(11, 'opened')

    expect(affinity.removeTab(11)).toBe(true)
    expect(affinity.ownsTab(11)).toBe(false)

    expect(affinity.replaceTab(4, 5)).toBe(true)
    expect(affinity.ownsTab(4)).toBe(false)
    expect(affinity.ownsTab(5)).toBe(true)
  })

  it('clears every claim when the session ends', () => {
    const affinity = new TabAffinityController()
    affinity.claimTab(3, 'bound')
    affinity.claimTab(4, 'opened')

    affinity.clearOwnedTabs()

    expect(affinity.ownsTab(3)).toBe(false)
    expect(affinity.ownedTabOrigins()).toEqual([])
  })
})

describe('resolveTargetTab', () => {
  it('refuses a tab outside the owned set with tab_outside', () => {
    expect(resolveTargetTab(12, { tabIsolation: true, ownsTab: () => false })).toMatchObject({
      ok: false,
      error: { code: 'tab_outside', message: expect.stringContaining('outside this session') },
    })
  })

  it('accepts an owned tab and stays permissive when isolation is off', () => {
    expect(resolveTargetTab(12, { tabIsolation: true, ownsTab: (tabId) => tabId === 12 })).toBeUndefined()
    expect(resolveTargetTab(12, { tabIsolation: false, ownsTab: () => false })).toBeUndefined()
  })
})

describe('dispatchToolCall under tab isolation', () => {
  it('refuses a page tool aimed outside the owned set before any dispatch', async () => {
    const stub = stubChrome([chromeTab(5)])

    const answer = await dispatchToolCall(
      SNAPSHOT, 'auto', undefined, undefined, undefined, chromeTab(5), undefined,
      { unrestrictedAccess: true, tabIsolation: true, ownsTab: () => false },
    )

    expect(answer).toMatchObject({ ok: false, error: { code: 'tab_outside' } })
    expect(stub.sendMessage).not.toHaveBeenCalled()
  })

  it('lets browser_follow_tab name an unowned tab and claims it through the callback', async () => {
    stubChrome([chromeTab(5)])
    const followTab = vi.fn(async () => undefined)

    const answer = await dispatchToolCall(
      { id: 'follow', name: 'browser_follow_tab', args: { tabId: 5 } },
      'auto', undefined, undefined, undefined, undefined, undefined,
      { unrestrictedAccess: true, tabIsolation: true, ownsTab: () => false, followTab },
    )

    expect(answer.ok).toBe(true)
    expect(followTab).toHaveBeenCalledOnce()
  })

  it('refuses browser_close_tab for an unowned tab', async () => {
    stubChrome([chromeTab(5)])

    const answer = await dispatchToolCall(
      { id: 'close', name: 'browser_close_tab', args: { tabId: 5 } },
      'auto', undefined, undefined, undefined, undefined, undefined,
      { unrestrictedAccess: true, tabIsolation: true, ownsTab: () => false },
    )

    expect(answer).toMatchObject({ ok: false, error: { code: 'tab_outside' } })
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
  })
})

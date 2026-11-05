// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { BridgeState } from '../src/background/bridge.ts'
import type { PanelApi } from '../src/panel/api.ts'

let panelApi: PanelApi

vi.mock('../src/panel/api.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/panel/api.ts')>(),
  connectPanel: (): PanelApi => panelApi,
}))

import { App } from '../src/panel/App.tsx'

const CATALOG = {
  commands: [
    { name: 'goal', description: 'Set or view the long-term goal' },
    { name: 'compact', description: 'Compact the conversation' },
  ],
}

describe('composer slash commands', () => {
  let root: Root
  let onStatus: ((state: BridgeState, caps: null) => void) | undefined
  let onResumeHint: ((sessionId: string | null) => void) | undefined
  let rpc: Mock<(method: string, payload?: unknown) => Promise<unknown>>
  let executeResult: unknown

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    HTMLElement.prototype.scrollTo = vi.fn()
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({ dshSettings: { autoResumeSession: false } })) } },
      windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
    })

    executeResult = { execution: { commandId: 'cmd-1', name: 'goal', result: { kind: 'success' } } }
    rpc = vi.fn(async (method: string) => {
      if (method === 'session.create') return { sessionId: 'session-current' }
      if (method === 'session.history') return { events: [] }
      if (method === 'session.models') return { models: [] }
      if (method === 'session.prompt') return {}
      if (method === 'speech.catalog') return { providers: [] }
      if (method === 'commands.list') return CATALOG
      if (method === 'commands.execute') return executeResult
      throw new Error(`unexpected RPC: ${method}`)
    })
    const unsubscribe = (): void => {}
    panelApi = {
      rpc: async <T = unknown>(method: string, payload?: unknown): Promise<T> => await rpc(method, payload) as T,
      respond: vi.fn(async () => undefined),
      onStatus: vi.fn((callback) => { onStatus = callback; return unsubscribe }),
      onEvent: vi.fn(() => unsubscribe),
      onApprovalRequest: vi.fn(() => unsubscribe),
      onApprovalResolved: vi.fn(() => unsubscribe),
      onTabAffinity: vi.fn(() => unsubscribe),
      onSelection: vi.fn(() => unsubscribe),
      onSessionResumeHint: vi.fn((callback) => { onResumeHint = callback; return unsubscribe }),
      respondToApproval: vi.fn(async () => {}),
      resolveTabAffinity: vi.fn(async () => {}),
      rebindTabAffinity: vi.fn(async () => {}),
      clearSelection: vi.fn(async () => {}),
      registerWindow: vi.fn(async () => {}),
      setActiveSession: vi.fn(async () => {}),
      updateSettings: vi.fn(async () => {}),
      requestStatus: vi.fn(async () => {}),
      onRecording: vi.fn(() => unsubscribe),
      onDiagnostics: vi.fn(() => unsubscribe),
      onLiveView: vi.fn(() => unsubscribe),
      onLiveFrame: vi.fn(() => unsubscribe),
      setLiveView: vi.fn(async () => {}),
      startRecording: vi.fn(async () => {}),
      exportRecording: vi.fn(async () => {}),
      clearRecording: vi.fn(async () => {}),
    }
    root = createRoot(document.querySelector('#root')!)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function startPanel(): Promise<void> {
    await act(async () => { root.render(createElement(App)) })
    await act(async () => {
      onStatus?.('connected', null)
      onResumeHint?.(null)
    })
    await vi.waitFor(() => { expect(rpc).toHaveBeenCalledWith('session.create', {}) })
  }

  async function type(value: string): Promise<void> {
    const composer = document.querySelector<HTMLTextAreaElement>('.composer textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(composer, value)
      composer.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  async function press(key: string): Promise<void> {
    const composer = document.querySelector<HTMLTextAreaElement>('.composer textarea')!
    await act(async () => {
      composer.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
  }

  it('opens the menu from the Host catalogue and completes the picked name', async () => {
    await startPanel()
    await type('/')
    await vi.waitFor(() => { expect(rpc).toHaveBeenCalledWith('commands.list', { sessionId: 'session-current' }) })
    await vi.waitFor(() => {
      expect([...document.querySelectorAll('.command-menu [role="option"]')].map((row) => row.textContent))
        .toEqual([expect.stringContaining('goal'), expect.stringContaining('compact')])
    })

    await press('ArrowDown')
    await press('Enter')
    await act(async () => {})

    const composer = document.querySelector<HTMLTextAreaElement>('.composer textarea')!
    expect(composer.value).toBe('/compact ')
    expect(document.querySelector('.command-menu')).toBeNull()
    // Picking only completes the draft; it must not run anything yet.
    expect(rpc).not.toHaveBeenCalledWith('commands.execute', expect.anything())
  })

  it('runs a known command through the Host instead of prompting', async () => {
    await startPanel()
    await type('/goal')
    await vi.waitFor(() => { expect(document.querySelector('.command-menu [role="option"]')).not.toBeNull() })
    await press('Enter')
    await act(async () => {})
    expect(document.querySelector<HTMLTextAreaElement>('.composer textarea')!.value).toBe('/goal ')

    rpc.mockClear()
    await press('Enter')
    await vi.waitFor(() => {
      expect(rpc).toHaveBeenCalledWith('commands.execute', { sessionId: 'session-current', line: '/goal' })
    })
    expect(rpc).not.toHaveBeenCalledWith('session.prompt', expect.anything())
  })

  it('falls back to a prompt when the Host does not claim the line', async () => {
    await startPanel()
    executeResult = { execution: null }
    await type('/goal')
    await vi.waitFor(() => { expect(document.querySelector('.command-menu [role="option"]')).not.toBeNull() })

    await press('Enter')
    await act(async () => {})
    rpc.mockClear()
    await press('Enter')
    await vi.waitFor(() => {
      expect(rpc).toHaveBeenCalledWith('commands.execute', { sessionId: 'session-current', line: '/goal' })
    })
    await vi.waitFor(() => {
      expect(rpc).toHaveBeenCalledWith('session.prompt', expect.objectContaining({ sessionId: 'session-current' }))
    })
  })

  it('shows a failed command result and keeps the draft for a retry', async () => {
    await startPanel()
    executeResult = { execution: { commandId: 'cmd-2', name: 'goal', result: { kind: 'error', text: 'goal needs an argument' } } }
    await type('/goal')
    await vi.waitFor(() => { expect(document.querySelector('.command-menu [role="option"]')).not.toBeNull() })
    await press('Enter')
    await act(async () => {})
    await press('Enter')
    await vi.waitFor(() => {
      expect(document.querySelector('.composer-error, .error, [role="alert"]')?.textContent ?? document.body.textContent)
        .toContain('goal needs an argument')
    })
    expect(document.querySelector<HTMLTextAreaElement>('.composer textarea')!.value).toBe('/goal')
  })

  it('offers the same commands from the plus menu and completes the draft', async () => {
    await startPanel()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button.plus-menu-trigger')!.click()
    })
    await vi.waitFor(() => { expect(rpc).toHaveBeenCalledWith('commands.list', { sessionId: 'session-current' }) })
    await vi.waitFor(() => {
      expect([...document.querySelectorAll('.plus-menu-command')].map((row) => row.textContent))
        .toEqual([expect.stringContaining('goal'), expect.stringContaining('compact')])
    })
    await act(async () => {
      document.querySelectorAll<HTMLButtonElement>('.plus-menu-command')[1]!.click()
    })
    expect(document.querySelector<HTMLTextAreaElement>('.composer textarea')!.value).toBe('/compact ')
    expect(document.querySelector('.plus-menu')).toBeNull()
  })

  it('offers the first-party list while the conversation is provisional', async () => {
    await startPanel()
    rpc.mockImplementation(async (method: string, payload?: unknown) => {
      if (method === 'commands.list') {
        const sessionId = (payload as { sessionId?: string } | undefined)?.sessionId
        throw new Error(`session "${sessionId}" not found`)
      }
      if (method === 'session.prompt') return {}
      return {}
    })
    await type('/')
    await vi.waitFor(() => {
      expect([...document.querySelectorAll('.command-menu [role="option"]')].map((row) => row.textContent))
        .toEqual(expect.arrayContaining([expect.stringContaining('goal'), expect.stringContaining('compact')]))
    })
    // A provisional chat is normal, not an error worth a banner.
    expect(document.body.textContent).not.toContain('Could not load commands')
  })

  it('surfaces other catalogue failures instead of looking empty', async () => {
    await startPanel()
    rpc.mockImplementation(async (method: string) => {
      if (method === 'commands.list') throw new Error('gateway/invocation-unavailable')
      return {}
    })
    await type('/')
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Could not load commands')
    })
    expect(document.body.textContent).toContain('gateway/invocation-unavailable')
  })

  it('keeps an unknown slash line as plain text', async () => {
    await startPanel()
    await type('/not-a-command')
    await press('Enter')
    await vi.waitFor(() => {
      expect(rpc).toHaveBeenCalledWith('session.prompt', expect.objectContaining({ sessionId: 'session-current' }))
    })
    expect(rpc).not.toHaveBeenCalledWith('commands.execute', expect.anything())
  })
})

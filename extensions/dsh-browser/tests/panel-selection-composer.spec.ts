// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { BridgeState } from '../src/background/bridge.ts'
import type { PanelApi } from '../src/panel/api.ts'
import type { PageSelection } from '../src/selection.ts'

let panelApi: PanelApi

// Keep the real module's exports: the panel's error mapping uses PanelRpcError.
vi.mock('../src/panel/api.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/panel/api.ts')>(),
  connectPanel: (): PanelApi => panelApi,
}))

import { App } from '../src/panel/App.tsx'

const selection: PageSelection = {
  text: 'dsh plugin: Chrome sidebar extension',
  truncated: false,
  title: 'Lum1104/dsh-browser',
  url: 'https://github.com/Lum1104/dsh-browser',
  capturedAt: 1_000,
}

describe('attaching a page selection in the composer', () => {
  let root: Root
  let onStatus: ((state: BridgeState, caps: null) => void) | undefined
  let onResumeHint: ((sessionId: string | null) => void) | undefined
  let onSelection: ((selection: PageSelection | null) => void) | undefined
  let rpc: Mock<(method: string, payload?: unknown) => Promise<unknown>>

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    HTMLElement.prototype.scrollTo = vi.fn()
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({ dshSettings: { autoResumeSession: false } })) } },
      windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
    })

    rpc = vi.fn(async (method: string) => {
      if (method === 'session.create') return { sessionId: 'session-current' }
      if (method === 'session.history') return { events: [] }
      if (method === 'session.prompt') return {}
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
      onSelection: vi.fn((callback) => { onSelection = callback; return unsubscribe }),
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

  it('shows the captured quote and sends it with the typed message', async () => {
    await startPanel()
    await act(async () => { onSelection?.(selection) })

    expect(document.querySelector('.composer-box .page-selection-quote')?.textContent).toContain(selection.text)
    expect(document.querySelector('.composer-box .page-selection-source')?.textContent).toBe(selection.title)

    const composer = document.querySelector<HTMLTextAreaElement>('.composer textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(composer, 'summarize this')
      composer.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { document.querySelector<HTMLButtonElement>('.composer-actions > button')!.click() })

    const prompt = rpc.mock.calls.find(([method]) => method === 'session.prompt')?.[1] as {
      content: { type: string; text: string }[]
    }
    expect(prompt.content[0]?.text).toContain('<UNTRUSTED_PAGE_CONTENT nonce="')
    expect(prompt.content[0]?.text).toContain(selection.text)
    expect(prompt.content[0]?.text.endsWith('summarize this')).toBe(true)

    // Sending consumes the quote here and in every other open panel.
    await vi.waitFor(() => { expect(document.querySelector('.composer-box .page-selection')).toBeNull() })
    expect(panelApi.clearSelection).toHaveBeenCalledWith(selection)
  })

  it('sends a selection that carries no typed message', async () => {
    await startPanel()
    await act(async () => { onSelection?.(selection) })

    const send = document.querySelector<HTMLButtonElement>('.composer-actions > button')!
    expect(send.disabled).toBe(false)
    await act(async () => { send.click() })

    expect(rpc).toHaveBeenCalledWith('session.prompt', expect.objectContaining({ sessionId: 'session-current' }))
  })

  it('drops the quote when the user dismisses it', async () => {
    await startPanel()
    await act(async () => { onSelection?.(selection) })

    const remove = document.querySelector<HTMLButtonElement>('.page-selection-chip button')!
    await act(async () => { remove.click() })

    expect(document.querySelector('.composer-box .page-selection')).toBeNull()
    expect(panelApi.clearSelection).toHaveBeenCalled()
    expect(document.querySelector<HTMLButtonElement>('.composer-actions > button')?.disabled).toBe(true)
  })

  it('restores the quote when the prompt is rejected', async () => {
    await startPanel()
    await act(async () => { onSelection?.(selection) })
    rpc.mockImplementation(async (method: string) => {
      if (method === 'session.prompt') throw new Error('bridge unavailable')
      return {}
    })

    await act(async () => { document.querySelector<HTMLButtonElement>('.composer-actions > button')!.click() })

    await vi.waitFor(() => {
      expect(document.querySelector('.composer-box .page-selection-quote')?.textContent).toContain(selection.text)
    })
    expect(document.querySelector('.error')?.textContent).toContain('bridge unavailable')
    expect(panelApi.clearSelection).not.toHaveBeenCalled()
  })

  it('does not consume a newer highlight when an earlier send succeeds', async () => {
    await startPanel()
    await act(async () => { onSelection?.(selection) })
    let acceptPrompt: (() => void) | undefined
    rpc.mockImplementation(async (method: string) => {
      if (method === 'session.prompt') {
        await new Promise<void>((resolve) => { acceptPrompt = resolve })
        return {}
      }
      return {}
    })

    await act(async () => { document.querySelector<HTMLButtonElement>('.composer-actions > button')!.click() })
    await vi.waitFor(() => { expect(acceptPrompt).toBeDefined() })
    const newer = { ...selection, text: 'newer highlight', capturedAt: 2_000 }
    await act(async () => { onSelection?.(newer) })
    await act(async () => { acceptPrompt?.() })

    await vi.waitFor(() => { expect(panelApi.clearSelection).toHaveBeenCalledWith(selection) })
    expect(document.querySelector('.composer-box .page-selection-quote')?.textContent).toContain(newer.text)
  })

  it('preserves a highlight captured while automatic restoration loads history', async () => {
    const storageGet = chrome.storage.local.get as unknown as Mock
    storageGet.mockResolvedValue({ dshSettings: { autoResumeSession: true } })
    let finishHistory: ((value: { events: never[] }) => void) | undefined
    rpc.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        return { items: [{ sessionId: 'session-saved', updatedAt: 1, running: false, blank: false }] }
      }
      if (method === 'session.history') {
        return await new Promise<{ events: never[] }>((resolve) => { finishHistory = resolve })
      }
      return {}
    })

    await act(async () => { root.render(createElement(App)) })
    await act(async () => {
      onStatus?.('connected', null)
      onResumeHint?.('session-saved')
    })
    await vi.waitFor(() => { expect(finishHistory).toBeDefined() })
    await act(async () => { onSelection?.(selection) })
    await act(async () => { finishHistory?.({ events: [] }) })

    await vi.waitFor(() => {
      expect(document.querySelector('.composer-box .page-selection-quote')?.textContent).toContain(selection.text)
    })
    expect(panelApi.clearSelection).not.toHaveBeenCalled()
  })

  it('clears the attachment when the user explicitly starts a new session', async () => {
    await startPanel()
    await act(async () => { onSelection?.(selection) })

    await act(async () => { document.querySelector<HTMLButtonElement>('.new-session-trigger')!.click() })

    await vi.waitFor(() => { expect(panelApi.clearSelection).toHaveBeenCalledWith() })
    expect(document.querySelector('.composer-box .page-selection')).toBeNull()
  })

  describe('pasting clipboard files into the composer', () => {
    const IMAGE_LIMITS = {
      maxImageBytes: 1024,
      maxImagesPerMessage: 2,
      maxMessageImageBytes: 1536,
      maxImagePixels: 1_000_000,
      maxImageDimension: 1200,
      mediaTypes: ['image/png', 'image/jpeg'],
    }

    beforeEach(() => {
      vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4, height: 4, close: (): void => {} })))
      rpc.mockImplementation(async (method: string) => {
        if (method === 'session.create') return { sessionId: 'session-current' }
        if (method === 'session.history') {
          return { events: [], projections: { asOfSeq: 0, values: { imageLimits: IMAGE_LIMITS } } }
        }
        if (method === 'session.prompt') return {}
        throw new Error(`unexpected RPC: ${method}`)
      })
    })

    function pasteEvent(files: File[] | null): Event {
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: files === null ? null : { files } })
      return event
    }

    async function startWithImageLimits(): Promise<HTMLTextAreaElement> {
      await startPanel()
      await vi.waitFor(() => {
        expect(document.querySelector<HTMLInputElement>('.image-file-input')?.accept).toBe('image/png,image/jpeg')
      })
      return document.querySelector<HTMLTextAreaElement>('.composer textarea')!
    }

    it('ingests a pasted image file through the picker path', async () => {
      const composer = await startWithImageLimits()
      const event = pasteEvent([new File([new Uint8Array([1, 2, 3])], 'clip.png', { type: 'image/png' })])

      await act(async () => {
        composer.dispatchEvent(event)
        // 文件读取在事件之后异步完成，把状态更新留在 act 内。
        await new Promise((resolve) => setTimeout(resolve, 20))
      })

      expect(event.defaultPrevented).toBe(true)
      expect(document.querySelector('.draft-images .draft-image img')?.getAttribute('alt')).toBe('clip.png')
    })

    it('leaves a plain text paste to native textarea behavior', async () => {
      const composer = await startWithImageLimits()
      const event = pasteEvent(null)

      await act(async () => { composer.dispatchEvent(event) })

      expect(event.defaultPrevented).toBe(false)
      expect(document.querySelector('.draft-images')).toBeNull()
      expect(document.querySelector('.error')).toBeNull()
    })

    it('routes a pasted unsupported file through the existing error path', async () => {
      const composer = await startWithImageLimits()
      const event = pasteEvent([new File(['x'], 'note.txt', { type: 'text/plain' })])

      await act(async () => {
        composer.dispatchEvent(event)
        await new Promise((resolve) => setTimeout(resolve, 20))
      })

      expect(event.defaultPrevented).toBe(true)
      expect(document.querySelector('.error')?.textContent).toContain('note.txt')
      expect(document.querySelector('.draft-images')).toBeNull()
    })
  })
})

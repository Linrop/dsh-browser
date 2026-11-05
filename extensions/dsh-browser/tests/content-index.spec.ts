// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

const LISTENER_KEY = '__dshBrowserContentScriptListener__'
const WATCHER_KEY = '__dshBrowserSelectionWatcher__'
const FORWARDER_KEY = '__dshBrowserInstrumentForwarder__'

afterEach(() => {
  Reflect.deleteProperty(navigator, 'userActivation')
  // A debounced selection change outlives the test that dispatched it; if the
  // timer fires after this file's environment is torn down it reads `document`
  // from nothing and fails the suite as an unhandled error.
  ;(globalThis as unknown as Record<string, { dispose?: () => void } | undefined>)[WATCHER_KEY]?.dispose?.()
  delete (globalThis as Record<string, unknown>)[LISTENER_KEY]
  delete (globalThis as Record<string, unknown>)[WATCHER_KEY]
  delete (globalThis as Record<string, unknown>)[FORWARDER_KEY]
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('content script registration', () => {
  it('replaces a stale listener when content.js is injected again', async () => {
    const addListener = vi.fn()
    const removeListener = vi.fn()
    const sendMessage = vi.fn(async () => undefined)
    vi.stubGlobal('chrome', {
      runtime: { onMessage: { addListener, removeListener }, sendMessage },
    })

    await import('../src/content/index.ts')
    expect(addListener).toHaveBeenCalledTimes(1)
    expect(removeListener).not.toHaveBeenCalled()
    const firstListener = addListener.mock.calls[0]?.[0]

    vi.resetModules()
    await import('../src/content/index.ts')

    expect(removeListener).toHaveBeenCalledWith(firstListener)
    expect(addListener).toHaveBeenCalledTimes(2)
    expect(addListener.mock.calls[1]?.[0]).not.toBe(firstListener)
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage).toHaveBeenLastCalledWith({ type: 'DSH_CONTENT_READY' })
  })
})

describe('selection watch arming', () => {
  function stubChrome(readyResponse: unknown) {
    // An event-driven capture requires the user's own transient activation.
    Object.defineProperty(navigator, 'userActivation', {
      configurable: true,
      value: { isActive: true, hasBeenActive: true },
    })
    const sendMessage = vi.fn(async (message: { type: string }) =>
      message.type === 'DSH_CONTENT_READY' ? readyResponse : undefined)
    vi.stubGlobal('chrome', {
      runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() }, sendMessage },
    })
    // Each import starts without a pre-existing highlight unless the test
    // explicitly installs one. Other tests replace this writable JSDOM method.
    window.getSelection = () => null
    return sendMessage
  }

  it('does not report selections until the service worker asks for them', async () => {
    const sendMessage = stubChrome({ selectionWatch: false })
    await import('../src/content/index.ts')
    await vi.waitFor(() => { expect(sendMessage).toHaveBeenCalledTimes(1) })

    window.getSelection = () => ({ toString: () => 'quoted text' }) as unknown as Selection
    document.dispatchEvent(new Event('selectionchange'))
    await new Promise((resolve) => { setTimeout(resolve, 400) })

    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('reports a settled selection once a panel has armed the document', async () => {
    const sendMessage = stubChrome({ selectionWatch: true })
    await import('../src/content/index.ts')
    await vi.waitFor(() => { expect(sendMessage).toHaveBeenCalledTimes(1) })

    window.getSelection = () => ({ toString: () => 'quoted text' }) as unknown as Selection
    document.dispatchEvent(new Event('selectionchange'))

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'DSH_SELECTION',
        selection: expect.objectContaining({ text: 'quoted text' }),
      })
    }, { timeout: 2_000 })
  })
})

describe('in-page work dot', () => {
  function stubIndicatorChrome(): (message: unknown) => unknown {
    const addListener = vi.fn()
    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: { addListener, removeListener: vi.fn() },
        sendMessage: vi.fn(async () => undefined),
      },
    })
    return (message: unknown) => {
      const listener = addListener.mock.calls[0]?.[0] as
        | ((message: unknown, sender: chrome.runtime.MessageSender, respond: (response: unknown) => void) => unknown)
        | undefined
      return listener?.({ ...(message as Record<string, unknown>) }, {} as chrome.runtime.MessageSender, () => {})
    }
  }

  it('moves the dot onto the element a click addresses', async () => {
    vi.useFakeTimers()
    const dispatch = stubIndicatorChrome()
    await import('../src/content/index.ts')

    dispatch({ type: 'DSH_INDICATOR', state: 'static' })
    vi.advanceTimersByTime(100)
    const dot = document.getElementById('dsh-phantom-cursor')
    expect(dot?.dataset.dshState).toBe('static')

    const button = document.createElement('button')
    button.setAttribute('data-dsh-el', '3')
    document.body.appendChild(button)
    dispatch({ type: 'DSH_ACTION', action: 'browser_click', args: { index: 3 } })

    // The jsdom stub reports a 200x40 rect at the origin, so the centre is (100, 20).
    expect(document.getElementById('dsh-phantom-cursor')?.style.transform).toBe('translate(100px, 20px)')
    vi.useRealTimers()
  })

  it('aims the dot at hover, select, upload and coordinate actions', async () => {
    vi.useFakeTimers()
    const dispatch = stubIndicatorChrome()
    await import('../src/content/index.ts')

    dispatch({ type: 'DSH_INDICATOR', state: 'static' })
    vi.advanceTimersByTime(100)
    const dot = () => document.getElementById('dsh-phantom-cursor')?.style.transform

    const select = document.createElement('select')
    select.setAttribute('data-dsh-el', '4')
    document.body.appendChild(select)
    dispatch({ type: 'DSH_ACTION', action: 'browser_select', args: { index: 4 } })
    expect(dot()).toBe('translate(100px, 20px)')

    dispatch({ type: 'DSH_ACTION', action: 'browser_hover', args: { x: 42, y: 24 } })
    expect(dot()).toBe('translate(42px, 24px)')

    dispatch({ type: 'DSH_ACTION', action: 'browser_drag', args: { from: [10, 12], to: [30, 40] } })
    expect(dot()).toBe('translate(10px, 12px)')
    vi.useRealTimers()
  })
})

describe('instrument channel forwarding', () => {
  function instrumentEnvelope() {
    return {
      __dshBrowserInstrument: true,
      entry: { kind: 'console', type: 'log', text: 'from hook', url: 'https://example.com/', timestamp: 1 },
    }
  }

  async function loadContent(): Promise<{
    sendMessage: ReturnType<typeof vi.fn>
    dispatch: (message: unknown) => void
  }> {
    const addListener = vi.fn()
    const sendMessage = vi.fn(async () => undefined)
    vi.stubGlobal('chrome', {
      runtime: { onMessage: { addListener, removeListener: vi.fn() }, sendMessage },
    })
    await import('../src/content/index.ts')
    const listener = addListener.mock.calls[0]?.[0] as (message: unknown) => void
    return { sendMessage, dispatch: (message: unknown) => { listener(message) } }
  }

  it('forwards only events delivered on the installed channel', async () => {
    const { sendMessage, dispatch } = await loadContent()
    sendMessage.mockClear()
    dispatch({ type: 'DSH_INSTRUMENT_CHANNEL', channel: 'secret-channel' })

    // No channel name at all: a page-posted `message` event is refused.
    window.dispatchEvent(new MessageEvent('message', { data: instrumentEnvelope(), source: window }))
    // Wrong channel name: a forged custom event is refused.
    window.dispatchEvent(new CustomEvent('forged-channel', { detail: instrumentEnvelope() }))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(sendMessage).not.toHaveBeenCalled()

    window.dispatchEvent(new CustomEvent('secret-channel', { detail: instrumentEnvelope() }))
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'DSH_INSTRUMENT_EVENT',
        entry: expect.objectContaining({ kind: 'console', text: 'from hook' }),
      })
    })
  })

  it('forwards nothing before the background installs a channel', async () => {
    const { sendMessage } = await loadContent()
    sendMessage.mockClear()
    window.dispatchEvent(new CustomEvent('any-channel', { detail: instrumentEnvelope() }))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('replaces the previous channel listener when the background rotates it', async () => {
    const { sendMessage, dispatch } = await loadContent()
    dispatch({ type: 'DSH_INSTRUMENT_CHANNEL', channel: 'first-channel' })
    dispatch({ type: 'DSH_INSTRUMENT_CHANNEL', channel: 'second-channel' })
    sendMessage.mockClear()

    window.dispatchEvent(new CustomEvent('first-channel', { detail: instrumentEnvelope() }))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(sendMessage).not.toHaveBeenCalled()

    window.dispatchEvent(new CustomEvent('second-channel', { detail: instrumentEnvelope() }))
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'DSH_INSTRUMENT_EVENT',
        entry: expect.objectContaining({ kind: 'console', text: 'from hook' }),
      })
    })
  })
})

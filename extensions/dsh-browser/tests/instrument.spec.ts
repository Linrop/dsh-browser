// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  INSTRUMENT_GLOBAL_FLAG,
  INSTRUMENT_MESSAGE_MARKER,
  installInstrument,
  instrumentMessageFromEvent,
  isInstrumentEntry,
  isInstrumentMessage,
  type InstrumentEntry,
  type InstrumentMessage,
} from '../src/content/instrument.ts'

const CHANNEL = 'test-channel'

let dispatchEvent: ReturnType<typeof vi.spyOn>
let addListener: ReturnType<typeof vi.spyOn>
let fetchMock: ReturnType<typeof vi.fn>

/** Every hook envelope dispatched on the channel, oldest first. */
function posted(): InstrumentMessage[] {
  return dispatchEvent.mock.calls
    .map(([event]: unknown[]) => event as Event)
    .filter((event: Event): event is CustomEvent => event instanceof CustomEvent && event.type === CHANNEL)
    .map((event: CustomEvent) => event.detail as InstrumentMessage)
    .filter((detail: unknown) => typeof detail === 'object' && detail !== null && Reflect.get(detail, INSTRUMENT_MESSAGE_MARKER) === true)
}

/** Listener registrations the hook owns on `window`, ignoring unrelated ones. */
function hookListenerTypes(): string[] {
  return addListener.mock.calls
    .map((registration: unknown[]) => registration[0] as string)
    .filter((type: string) => type === 'error' || type === 'unhandledrejection')
}

beforeAll(() => {
  // The hook captures fetch when it installs, so the page stand-in must exist
  // before the first injection.
  fetchMock = vi.fn(async () => ({ status: 201 }))
  Object.defineProperty(window, 'fetch', { configurable: true, writable: true, value: fetchMock })
  dispatchEvent = vi.spyOn(window, 'dispatchEvent')
  addListener = vi.spyOn(window, 'addEventListener')
  installInstrument(CHANNEL)
})

describe('MAIN-world instrumentation hook', () => {
  it('marks the document and installs the listeners so repeated injections stay no-ops', () => {
    expect(Reflect.get(window, INSTRUMENT_GLOBAL_FLAG)).toBe(true)
    expect(hookListenerTypes()).toEqual(['error', 'unhandledrejection'])
    const fetchBefore = window.fetch
    const warnBefore = console.warn
    const callsBefore = addListener.mock.calls.length

    installInstrument(CHANNEL)

    expect(Reflect.get(window, INSTRUMENT_GLOBAL_FLAG)).toBe(true)
    expect(hookListenerTypes()).toEqual(['error', 'unhandledrejection'])
    expect(addListener.mock.calls.length).toBe(callsBefore)
    expect(window.fetch).toBe(fetchBefore)
    expect(console.warn).toBe(warnBefore)
  })

  it('reports console calls while preserving console output', () => {
    const original = console.warn
    console.warn('careful', { code: 7 })
    expect(console.warn).toBe(original)
    expect(posted().at(-1)?.entry).toMatchObject({ kind: 'console', type: 'warn', text: 'careful {"code":7}' })
  })

  it('reports fetch completions and failures', async () => {
    const response = await window.fetch('https://example.com/api?a=1', { method: 'post' })
    expect(response.status).toBe(201)
    expect(posted().at(-1)?.entry).toMatchObject({ kind: 'network', url: 'https://example.com/api?a=1', method: 'POST', status: 201 })

    fetchMock.mockRejectedValueOnce(new Error('network down'))
    await expect(window.fetch('https://example.com/fail')).rejects.toThrow('network down')
    expect(posted().at(-1)?.entry).toMatchObject({ kind: 'network', status: 0, errorText: 'network down' })
  })

  it('reports uncaught errors as exception entries', () => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'kaboom', filename: 'https://example.com/app.js', lineno: 4, colno: 2 }))
    expect(posted().at(-1)?.entry).toMatchObject({
      kind: 'console',
      type: 'exception',
      text: 'Uncaught kaboom',
      url: 'https://example.com/app.js',
      line: 4,
      column: 2,
    })
  })

  it('keeps the channel out of the envelope', () => {
    console.log('channel check')
    const last = posted().at(-1)
    expect(last).toBeDefined()
    expect(Object.keys(last!).sort()).toEqual(['__dshBrowserInstrument', 'entry'])
    expect(JSON.stringify(last)).not.toContain(CHANNEL)
  })
})

describe('instrument message guards', () => {
  const entry: InstrumentEntry = { kind: 'console', type: 'log', text: 'x', url: '', timestamp: 1 }

  it('accepts only marked envelopes with a known entry kind', () => {
    expect(isInstrumentMessage({ [INSTRUMENT_MESSAGE_MARKER]: true, entry })).toBe(true)
    expect(isInstrumentMessage({ [INSTRUMENT_MESSAGE_MARKER]: true, entry: { kind: 'other' } })).toBe(false)
    expect(isInstrumentMessage({ entry })).toBe(false)
    expect(isInstrumentMessage('nope')).toBe(false)
  })

  it('forwards only events delivered on the installed channel', () => {
    const envelope = { [INSTRUMENT_MESSAGE_MARKER]: true, entry }
    const onChannel = new CustomEvent(CHANNEL, { detail: envelope })
    expect(instrumentMessageFromEvent(onChannel, CHANNEL)).toMatchObject({ entry: { kind: 'console' } })

    // A forged custom event with the wrong channel name is refused.
    expect(instrumentMessageFromEvent(new CustomEvent('other-channel', { detail: envelope }), CHANNEL)).toBeUndefined()
    // A plain `message` event carries no channel name at all and is refused.
    const message = new MessageEvent('message', { data: envelope })
    expect(instrumentMessageFromEvent(message, CHANNEL)).toBeUndefined()
    // The right event type without a valid envelope is refused too.
    expect(instrumentMessageFromEvent(new CustomEvent(CHANNEL, { detail: { entry } }), CHANNEL)).toBeUndefined()
    expect(instrumentMessageFromEvent(onChannel, '')).toBeUndefined()
  })

  it('validates background-side entries', () => {
    expect(isInstrumentEntry({ kind: 'network', url: 'u', method: 'GET', status: 200, timestamp: 1 })).toBe(true)
    expect(isInstrumentEntry({ kind: 'network', url: 'u', method: 'GET', status: '200', timestamp: 1 })).toBe(false)
    expect(isInstrumentEntry({ kind: 'console', type: 'log', text: 'x', url: '', timestamp: 1 })).toBe(true)
  })
})

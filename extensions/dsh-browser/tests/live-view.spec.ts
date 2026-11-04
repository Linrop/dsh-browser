// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  LIVE_VIEW_MAX_HEIGHT,
  LIVE_VIEW_MAX_WIDTH,
  LIVE_VIEW_QUALITY,
  LiveViewController,
  type LiveViewDeps,
  type LiveViewFrame,
  type LiveViewState,
} from '../src/background/live-view.ts'

/** Build a controller with recording fakes and per-test overrides. */
function harness(overrides: Partial<LiveViewDeps> = {}): {
  controller: LiveViewController
  states: LiveViewState[]
  frames: LiveViewFrame[]
  events: string[]
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  ack: ReturnType<typeof vi.fn>
  controllerRef: LiveViewController
} {
  const events: string[] = []
  const states: LiveViewState[] = []
  const frames: LiveViewFrame[] = []
  const start = vi.fn(async () => { events.push('start') })
  const stop = vi.fn(async () => { events.push('stop') })
  const ack = vi.fn(async () => { events.push('ack') })
  const deps: LiveViewDeps = {
    isDebuggerAvailable: () => true,
    isOwnPage: async () => false,
    isTabActive: async () => true,
    startScreencast: start,
    stopScreencast: stop,
    ackFrame: ack,
    onState: (state) => { states.push(state) },
    onFrame: (frame) => {
      events.push('frame')
      frames.push(frame)
    },
    viewport: () => ({ width: 100, height: 50 }),
    ...overrides,
  }
  const controller = new LiveViewController(deps)
  return { controller, states, frames, events, start, stop, ack, controllerRef: controller }
}

describe('live view lifecycle', () => {
  it('starts the screencast for the controlled tab and reports streaming', async () => {
    const h = harness()
    await h.controller.setWatching(true)
    expect(h.start).not.toHaveBeenCalled()
    await h.controller.setTarget(7)
    expect(h.start).toHaveBeenCalledWith(7, {
      quality: LIVE_VIEW_QUALITY,
      maxWidth: LIVE_VIEW_MAX_WIDTH,
      maxHeight: LIVE_VIEW_MAX_HEIGHT,
    })
    expect(h.states.at(-1)).toEqual({ status: 'streaming', tabId: 7 })
    expect(h.controller.state()).toEqual({ status: 'streaming', tabId: 7 })
  })

  it('turns off immediately, stops the screencast, and ignores later frames', async () => {
    const h = harness()
    await h.controller.setWatching(true)
    await h.controller.setTarget(7)
    h.controller.handleFrame(7, { sessionId: 1, data: 'AAA', metadata: { deviceWidth: 10, deviceHeight: 5 } })
    expect(h.frames).toHaveLength(1)
    await h.controller.setWatching(false)
    expect(h.stop).toHaveBeenCalledWith(7)
    expect(h.states.at(-1)).toEqual({ status: 'off' })
    h.ack.mockClear()
    h.controller.handleFrame(7, { sessionId: 2, data: 'BBB', metadata: { deviceWidth: 10, deviceHeight: 5 } })
    expect(h.ack).not.toHaveBeenCalled()
    expect(h.frames).toHaveLength(1)
  })

  it('acknowledges each frame before forwarding it and keeps seq rising', async () => {
    const h = harness()
    await h.controller.setWatching(true)
    await h.controller.setTarget(7)
    h.events.length = 0
    h.controller.handleFrame(7, { sessionId: 11, data: 'AAA', metadata: { deviceWidth: 300, deviceHeight: 200 } })
    h.controller.handleFrame(7, { sessionId: 12, data: 'BBB', metadata: {} })
    expect(h.events).toEqual(['ack', 'frame', 'ack', 'frame'])
    expect(h.ack).toHaveBeenNthCalledWith(1, 7, 11)
    expect(h.frames).toHaveLength(2)
    expect(h.frames[1]!.seq).toBeGreaterThan(h.frames[0]!.seq)
    expect(h.frames[0]).toMatchObject({ width: 300, height: 200 })
    expect(h.frames[1]).toMatchObject({ width: 100, height: 50 })
  })

  it('reports no-debugger without trying to start', async () => {
    const h = harness({ isDebuggerAvailable: () => false })
    await h.controller.setWatching(true)
    await h.controller.setTarget(7)
    expect(h.start).not.toHaveBeenCalled()
    expect(h.states.at(-1)).toEqual({ status: 'unavailable', code: 'no-debugger', tabId: 7 })
  })

  it('refuses to stream the panel\'s own page, which would show the panel in the panel', async () => {
    const h = harness({ isOwnPage: async () => true })
    await h.controller.setWatching(true)
    await h.controller.setTarget(7)
    expect(h.start).not.toHaveBeenCalled()
    expect(h.states.at(-1)).toMatchObject({ status: 'unavailable', code: 'own-page', tabId: 7 })
  })

  it('reports a background tab as unavailable instead of pretending to stream', async () => {
    const h = harness({ isTabActive: async () => false })
    await h.controller.setWatching(true)
    await h.controller.setTarget(7)
    expect(h.start).not.toHaveBeenCalled()
    expect(h.states.at(-1)).toEqual({ status: 'unavailable', code: 'tab-not-active', tabId: 7 })
  })

  it('reports a missing controlled tab without starting', async () => {
    const h = harness()
    await h.controller.setWatching(true)
    expect(h.start).not.toHaveBeenCalled()
    expect(h.states.at(-1)).toEqual({ status: 'unavailable', code: 'no-controlled-tab' })
  })

  it('reports an attach failure with its detail', async () => {
    const h = harness({ startScreencast: async () => { throw new Error('DevTools is open') } })
    await h.controller.setWatching(true)
    await h.controller.setTarget(7)
    expect(h.states.at(-1)).toMatchObject({ status: 'unavailable', code: 'attach-failed', detail: 'DevTools is open' })
  })

  it('reports a browser detach instead of keeping the last picture', async () => {
    const h = harness()
    await h.controller.setWatching(true)
    await h.controller.setTarget(7)
    h.controller.handleDetach(7)
    expect(h.states.at(-1)).toEqual({ status: 'unavailable', code: 'debugger-detached', tabId: 7 })
    h.ack.mockClear()
    h.controller.handleFrame(7, { sessionId: 5, data: 'AAA', metadata: {} })
    expect(h.ack).not.toHaveBeenCalled()
    expect(h.frames).toHaveLength(0)
  })

  it('stops the previous tab when the target changes', async () => {
    const h = harness()
    await h.controller.setWatching(true)
    await h.controller.setTarget(7)
    await h.controller.setTarget(8)
    expect(h.stop).toHaveBeenCalledWith(7)
    expect(h.start).toHaveBeenLastCalledWith(8, expect.any(Object))
    expect(h.states.at(-1)).toEqual({ status: 'streaming', tabId: 8 })
  })
})

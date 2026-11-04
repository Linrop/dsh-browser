/**
 * Low-frame-rate live view of the controlled tab.
 *
 * The controller owns the panel toggle, the CDP screencast lifecycle, the frame
 * sequence, and the honest unavailable states. Chrome itself decides when to
 * emit a frame (only when the compositor changes), so the host adds no timer or
 * throttle; the panel discards stale frames by sequence instead.
 *
 * A frame is acknowledged before it is processed: without
 * `Page.screencastFrameAck` Chrome stops producing frames for the target.
 *
 * @module
 */

/** JPEG quality requested for the screencast. */
export const LIVE_VIEW_QUALITY = 40

/** Largest frame width requested from the compositor. */
export const LIVE_VIEW_MAX_WIDTH = 1_280

/** Largest frame height requested from the compositor. */
export const LIVE_VIEW_MAX_HEIGHT = 800

/** Why the panel cannot show a picture even though the toggle is on. */
export type LiveViewUnavailableCode =
  | 'no-controlled-tab'
  | 'no-debugger'
  | 'tab-not-active'
  | 'own-page'
  | 'attach-failed'
  | 'debugger-detached'

/** Panel-facing state of the live view. */
export interface LiveViewState {
  status: 'off' | 'starting' | 'streaming' | 'unavailable'
  /** Set when `status` is `unavailable`. */
  code?: LiveViewUnavailableCode
  /** Technical detail for `attach-failed`; page-supplied text, not instructions. */
  detail?: string
  /** Tab the state describes, when one is selected. */
  tabId?: number
}

/** One JPEG frame ready for the panel's `<img>`. */
export interface LiveViewFrame {
  tabId: number
  /** Monotonic across frames and tabs; the panel drops any frame at or below the last seen value. */
  seq: number
  /** Frame width in device pixels; `metadata.deviceWidth` or the fallback viewport. */
  width: number
  /** Frame height in device pixels; `metadata.deviceHeight` or the fallback viewport. */
  height: number
  /** base64 JPEG payload without a `data:` prefix. */
  data: string
}

/** CDP capabilities the controller needs. */
export interface LiveViewDeps {
  /** Whether this browser build exposes `chrome.debugger`. */
  isDebuggerAvailable(): boolean
  /** Whether the tab shows one of this extension's own pages. */
  isOwnPage(tabId: number): Promise<boolean>
  /** Whether the tab is the visible tab of its window. */
  isTabActive(tabId: number): Promise<boolean>
  /** Start the JPEG screencast and keep the debugger attached. */
  startScreencast(tabId: number, options: { quality: number; maxWidth: number; maxHeight: number }): Promise<void>
  /** Stop the screencast and reset the detach timer. */
  stopScreencast(tabId: number): Promise<void>
  /** Acknowledge one screencast frame before it is processed. */
  ackFrame(tabId: number, sessionId: number): Promise<void>
  /** Publish a state change to every panel. */
  onState(state: LiveViewState): void
  /** Publish one fresh frame to every panel. */
  onFrame(frame: LiveViewFrame): void
  /** Viewport used when `metadata` omits the frame size. */
  viewport(): { width: number; height: number }
}

/**
 * Owns one screencast for the currently controlled tab.
 *
 * `setWatching` is the panel toggle and `setTarget` is the affinity update;
 * both are idempotent, and every asynchronous start carries a generation so a
 * start that loses a race cannot install a stream for a tab the panel no
 * longer wants.
 */
export class LiveViewController {
  private watched = false
  private targetTabId: number | undefined
  private runningTabId: number | undefined
  /** Tab whose screencast command is in flight; its early frames still need an ack. */
  private startingTabId: number | undefined
  private current: LiveViewState = { status: 'off' }
  private seq = 0
  private generation = 0
  private readonly deps: LiveViewDeps

  constructor(deps: LiveViewDeps) {
    this.deps = deps
  }

  /** The last published state. */
  state(): LiveViewState {
    return { ...this.current }
  }

  /**
   * Turn the panel's live view on or off.
   * @param watched - true when at least one panel wants frames.
   */
  async setWatching(watched: boolean): Promise<void> {
    if (this.watched === watched) {
      if (watched) await this.evaluate()
      return
    }
    this.watched = watched
    if (!watched) {
      await this.stopStream()
      this.publish({ status: 'off' })
      return
    }
    await this.evaluate()
  }

  /**
   * Point the live view at the controlled tab.
   * @param tabId - the controlled tab, or undefined when no tab is controlled.
   */
  async setTarget(tabId: number | undefined): Promise<void> {
    if (tabId === this.targetTabId) {
      if (this.watched) await this.evaluate()
      return
    }
    this.targetTabId = tabId
    await this.stopStream()
    if (this.watched) await this.evaluate()
  }

  /**
   * Report that the browser detached the debugger from the streaming tab.
   *
   * Chrome ends the screencast when DevTools opens or the user dismisses the
   * debugging notice; the panel must stop showing the last picture rather than
   * pretend the stream is still live.
   * @param tabId - tab whose debugger session ended.
   */
  handleDetach(tabId: number): void {
    if (this.startingTabId === tabId) this.startingTabId = undefined
    if (this.runningTabId !== tabId) return
    this.runningTabId = undefined
    this.publish({ status: 'unavailable', code: 'debugger-detached', tabId })
  }

  /**
   * Process one `Page.screencastFrame` event.
   *
   * The ack is dispatched before the frame is read or forwarded. Frames for a
   * tab that is not the running target are ignored without an ack, so a stale
   * event cannot keep a stopped target awake.
   * @param tabId - tab the protocol event belongs to.
   * @param params - raw `Page.screencastFrame` payload.
   */
  handleFrame(tabId: number, params: Record<string, unknown>): void {
    if (!this.watched) return
    // Chrome waits for the ack before sending the next frame. A frame can land
    // between the screencast command's reply and the awaited continuation, so
    // acknowledge while the start is in flight even though it is not forwarded.
    const starting = this.startingTabId === tabId
    if (this.runningTabId !== tabId && !starting) return
    const sessionId = params.sessionId
    if (typeof sessionId === 'number' && Number.isFinite(sessionId)) {
      void this.deps.ackFrame(tabId, sessionId).catch(() => {
        // A lost ack means the target is gone; the next state refresh stops it.
      })
    }
    if (starting) return
    const data = params.data
    if (typeof data !== 'string' || data === '') return
    const metadata = typeof params.metadata === 'object' && params.metadata !== null
      ? params.metadata as Record<string, unknown>
      : {}
    const fallback = this.deps.viewport()
    const width = typeof metadata.deviceWidth === 'number'
      ? Math.max(1, Math.round(metadata.deviceWidth))
      : fallback.width
    const height = typeof metadata.deviceHeight === 'number'
      ? Math.max(1, Math.round(metadata.deviceHeight))
      : fallback.height
    this.seq += 1
    this.deps.onFrame({ tabId, seq: this.seq, width, height, data })
  }

  /** Stop the running screencast, if any, and forget its tab. */
  private async stopStream(): Promise<void> {
    this.startingTabId = undefined
    const tabId = this.runningTabId
    if (tabId === undefined) return
    this.runningTabId = undefined
    try {
      await this.deps.stopScreencast(tabId)
    } catch {
      // The target may already be gone; clearing our state is what matters.
    }
  }

  /** Publish a state once. */
  private publish(state: LiveViewState): void {
    this.current = state
    this.deps.onState({ ...state })
  }

  /** Decide whether the current target can stream and act on the answer. */
  private async evaluate(): Promise<void> {
    const generation = (this.generation += 1)
    if (!this.watched) {
      await this.stopStream()
      this.publish({ status: 'off' })
      return
    }
    if (this.targetTabId === undefined) {
      await this.stopStream()
      this.publish({ status: 'unavailable', code: 'no-controlled-tab' })
      return
    }
    const tabId = this.targetTabId
    if (!this.deps.isDebuggerAvailable()) {
      await this.stopStream()
      this.publish({ status: 'unavailable', code: 'no-debugger', tabId })
      return
    }
    // Showing the panel inside the panel is a feedback loop, not a preview.
    let ownPage = false
    try {
      ownPage = await this.deps.isOwnPage(tabId)
    } catch {
      ownPage = false
    }
    if (generation !== this.generation) return
    if (ownPage) {
      await this.stopStream()
      this.publish({ status: 'unavailable', code: 'own-page', tabId })
      return
    }
    let active = false
    try {
      active = await this.deps.isTabActive(tabId)
    } catch {
      active = false
    }
    if (generation !== this.generation) return
    if (!active) {
      await this.stopStream()
      this.publish({ status: 'unavailable', code: 'tab-not-active', tabId })
      return
    }
    if (this.runningTabId === tabId) {
      this.publish({ status: 'streaming', tabId })
      return
    }
    await this.stopStream()
    if (generation !== this.generation || !this.watched || this.targetTabId !== tabId) return
    this.startingTabId = tabId
    this.publish({ status: 'starting', tabId })
    try {
      await this.deps.startScreencast(tabId, {
        quality: LIVE_VIEW_QUALITY,
        maxWidth: LIVE_VIEW_MAX_WIDTH,
        maxHeight: LIVE_VIEW_MAX_HEIGHT,
      })
    } catch (error: unknown) {
      this.startingTabId = undefined
      if (generation !== this.generation) return
      this.publish({
        status: 'unavailable',
        code: 'attach-failed',
        tabId,
        detail: error instanceof Error ? error.message : String(error),
      })
      return
    }
    this.startingTabId = undefined
    if (generation !== this.generation || !this.watched || this.targetTabId !== tabId) {
      // A newer decision won the race; do not leave this target streaming.
      try {
        await this.deps.stopScreencast(tabId)
      } catch {
        // The target may already be gone.
      }
      return
    }
    this.runningTabId = tabId
    this.publish({ status: 'streaming', tabId })
  }
}

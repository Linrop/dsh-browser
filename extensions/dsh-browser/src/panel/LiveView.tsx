/**
 * Panel surface for the controlled tab's live view.
 *
 * The toggle lives in the top bar; the panel renders only while the user has
 * turned it on, so an unused feature adds no chrome. A frame is rendered
 * directly from its base64 JPEG payload through an `<img>`; the panel never
 * decodes or re-encodes pixels.
 *
 * @module
 */

import type { LiveViewFrame, LiveViewState } from '../background/live-view.ts'
import type { PanelCopy } from './strings.ts'

function MonitorIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="3" y="4.5" width="14" height="9.5" rx="1.6" />
      <path d="M7.5 16.5h5M10 14v2.5" />
    </svg>
  )
}

/**
 * Whether a frame is newer than the last one accepted for its tab.
 * @param previous - highest sequence already accepted for that tab.
 * @param seq - sequence of the incoming frame.
 * @returns true when the frame should replace the picture.
 */
export function isNewerLiveFrame(previous: number | undefined, seq: number): boolean {
  return previous === undefined || seq > previous
}

/**
 * Top-bar button that turns this panel's live view on or off.
 * @param props - localized copy, current toggle state, and the change handler.
 * @returns the toggle button.
 */
export function LiveViewToggle({
  copy,
  enabled,
  onToggle,
}: {
  copy: PanelCopy
  enabled: boolean
  onToggle: (enabled: boolean) => void
}): React.JSX.Element {
  const label = enabled ? copy.app.liveView.disable : copy.app.liveView.enable
  return (
    <button className={`icon-button live-view-trigger${enabled ? ' active' : ''}`}
      type="button"
      aria-pressed={enabled}
      aria-label={label}
      title={label}
      onClick={() => { onToggle(!enabled) }}>
      <MonitorIcon />
    </button>
  )
}

/**
 * Live picture of the controlled tab, or an honest reason it is unavailable.
 *
 * A stale frame is never shown: the frame only renders while the background
 * reports the same tab as streaming, and the panel clears the picture as soon
 * as the tab changes or the stream stops.
 * @param props - localized copy, the toggle state, the latest state, and the latest frame.
 * @returns the live-view section, or null while the toggle is off.
 */
export function LiveViewPanel({
  copy,
  enabled,
  state,
  frame,
}: {
  copy: PanelCopy
  enabled: boolean
  state: LiveViewState
  frame: LiveViewFrame | null
}): React.JSX.Element | null {
  if (!enabled) return null
  const active = state
  const currentFrame = active.status === 'streaming'
    && active.tabId !== undefined
    && frame !== null
    && frame.tabId === active.tabId
    ? frame
    : null
  const notice = active.status === 'unavailable' && active.code !== undefined
    ? copy.app.liveView.unavailableWithReason(copy.app.liveView.reasons[active.code])
    : copy.app.liveView.starting
  return (
    <section className="live-view" aria-label={copy.app.liveView.title}>
      <div className="live-view-head">
        <strong>{copy.app.liveView.title}</strong>
        <span className="live-view-status">{active.status === 'streaming'
          ? copy.app.liveView.title
          : active.status === 'unavailable'
            ? copy.app.liveView.unavailable
            : copy.app.liveView.starting}</span>
      </div>
      {currentFrame !== null
        ? (
          <img
            className="live-view-frame"
            src={`data:image/jpeg;base64,${currentFrame.data}`}
            width={currentFrame.width}
            height={currentFrame.height}
            alt={copy.app.liveView.title}
          />
        )
        : <p className="live-view-notice" title={active.detail}>{notice}</p>}
    </section>
  )
}

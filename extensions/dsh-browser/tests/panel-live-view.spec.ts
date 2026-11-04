// @vitest-environment jsdom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { LiveViewFrame, LiveViewState } from '../src/background/live-view.ts'
import { isNewerLiveFrame, LiveViewPanel } from '../src/panel/LiveView.tsx'
import { PANEL_COPY } from '../src/panel/strings.ts'

const copy = PANEL_COPY.en

function render(enabled: boolean, state: LiveViewState, frame: LiveViewFrame | null): string {
  return renderToStaticMarkup(createElement(LiveViewPanel, { copy, enabled, state, frame }))
}

const frame: LiveViewFrame = { tabId: 7, seq: 3, width: 640, height: 400, data: 'QUJD' }

describe('live view panel', () => {
  it('renders no picture while the toggle is off', () => {
    const html = render(false, { status: 'streaming', tabId: 7 }, frame)
    expect(html).toBe('')
    expect(html).not.toContain('<img')
  })

  it('renders the latest frame as a JPEG data URL while streaming', () => {
    const html = render(true, { status: 'streaming', tabId: 7 }, frame)
    expect(html).toContain('src="data:image/jpeg;base64,QUJD"')
    expect(html).toContain('width="640"')
    expect(html).toContain('height="400"')
  })

  it('shows the unavailable reason instead of a stale picture', () => {
    const html = render(true, { status: 'unavailable', code: 'no-debugger', tabId: 7 }, frame)
    expect(html).not.toContain('<img')
    expect(html).toContain('Live view unavailable (this browser build has no debugger API).')
  })

  it('never shows a frame that belongs to another tab', () => {
    const html = render(true, { status: 'streaming', tabId: 9 }, frame)
    expect(html).not.toContain('<img')
    expect(html).toContain('Starting the live view')
  })

  it('drops frames at or below the last accepted sequence', () => {
    expect(isNewerLiveFrame(undefined, 1)).toBe(true)
    expect(isNewerLiveFrame(3, 4)).toBe(true)
    expect(isNewerLiveFrame(3, 3)).toBe(false)
    expect(isNewerLiveFrame(3, 2)).toBe(false)
  })
})

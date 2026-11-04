// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { realInputVerdict, type RealInputState } from '../src/background/real-input.ts'

function state(overrides: Partial<RealInputState>): RealInputState {
  return { tabActive: true, windowApiAvailable: true, windowFocused: true, ...overrides }
}

describe('realInputVerdict', () => {
  it('uses real input when the tab is active in a focused window', () => {
    expect(realInputVerdict(state({}))).toEqual({ usable: true })
  })

  it('rejects a background tab', () => {
    expect(realInputVerdict(state({ tabActive: false }))).toEqual({ usable: false, reason: 'tab-not-active' })
  })

  it('rejects a tab whose window is not focused', () => {
    expect(realInputVerdict(state({ windowFocused: false }))).toEqual({ usable: false, reason: 'window-not-focused' })
  })

  it('rejects a browser build without chrome.windows', () => {
    expect(realInputVerdict(state({ windowApiAvailable: false, windowFocused: undefined })))
      .toEqual({ usable: false, reason: 'window-api-unavailable' })
  })

  it('rejects a tab whose state could not be read', () => {
    expect(realInputVerdict(state({ tabActive: undefined }))).toEqual({ usable: false, reason: 'tab-not-active' })
    expect(realInputVerdict(state({ windowFocused: undefined })))
      .toEqual({ usable: false, reason: 'window-not-focused' })
  })
})

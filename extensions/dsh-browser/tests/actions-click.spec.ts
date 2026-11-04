// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import type { ElementIds } from '../src/content/ids.ts'

/**
 * `browser_click` with explicit pointer options is the degraded (no-CDP) path:
 * the content script must synthesize the requested button, click count, and
 * modifiers instead of collapsing them into a primary click.
 */

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 2_000 }

interface SeenEvent {
  type: string
  button: number
  buttons: number
  detail: number
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

const CLICK_EVENT_TYPES = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'contextmenu'] as const

function idsFor(element: Element): ElementIds {
  return { elementByIndex: vi.fn(() => element) } as unknown as ElementIds
}

function recordClicks(): SeenEvent[] {
  const seen: SeenEvent[] = []
  for (const type of CLICK_EVENT_TYPES) {
    document.addEventListener(type, (event) => {
      const mouse = event as MouseEvent
      seen.push({
        type,
        button: mouse.button,
        buttons: mouse.buttons,
        detail: mouse.detail,
        altKey: mouse.altKey,
        ctrlKey: mouse.ctrlKey,
        metaKey: mouse.metaKey,
        shiftKey: mouse.shiftKey,
      })
    })
  }
  return seen
}

async function click(args: Record<string, unknown>): Promise<{ text: string; seen: SeenEvent[] }> {
  document.body.innerHTML = '<button id="go">Go</button>'
  const button = document.querySelector('#go') as HTMLButtonElement
  button.scrollIntoView = vi.fn()
  const seen = recordClicks()
  const pending = runAction('browser_click', { index: 2, ...args }, { ids: idsFor(button), budget: BUDGET })
  await vi.advanceTimersByTimeAsync(100)
  const result = await pending
  return { text: result.text, seen }
}

function ofType(seen: SeenEvent[], type: string): SeenEvent[] {
  return seen.filter((event) => event.type === type)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('browser_click synthesized button semantics', () => {
  it('dispatches a left-button press, release, and click', async () => {
    const { text, seen } = await click({ button: 'left' })
    expect(ofType(seen, 'mousedown')[0]).toMatchObject({ button: 0, buttons: 1, detail: 1 })
    expect(ofType(seen, 'mouseup')[0]).toMatchObject({ button: 0, buttons: 0, detail: 1 })
    expect(ofType(seen, 'click')).toHaveLength(1)
    expect(ofType(seen, 'contextmenu')).toHaveLength(0)
    expect(text).toContain('synthesized left-button events')
  })

  it('dispatches a right-button press, contextmenu, and auxclick', async () => {
    const { text, seen } = await click({ button: 'right' })
    expect(ofType(seen, 'mousedown')[0]).toMatchObject({ button: 2, buttons: 2, detail: 1 })
    expect(ofType(seen, 'mouseup')[0]).toMatchObject({ button: 2, buttons: 0 })
    expect(ofType(seen, 'contextmenu')[0]).toMatchObject({ button: 2, detail: 1 })
    expect(ofType(seen, 'auxclick')).toHaveLength(1)
    expect(ofType(seen, 'click')).toHaveLength(0)
    expect(text).toContain('synthesized right-button events')
  })

  it('dispatches a middle-button press and auxclick', async () => {
    const { text, seen } = await click({ button: 'middle' })
    expect(ofType(seen, 'mousedown')[0]).toMatchObject({ button: 1, buttons: 4, detail: 1 })
    expect(ofType(seen, 'auxclick')).toHaveLength(1)
    expect(ofType(seen, 'contextmenu')).toHaveLength(0)
    expect(ofType(seen, 'click')).toHaveLength(0)
    expect(text).toContain('synthesized middle-button events')
  })
})

describe('browser_click synthesized click count', () => {
  it('dispatches two clicks with increasing detail', async () => {
    const { text, seen } = await click({ count: 2 })
    expect(ofType(seen, 'mousedown').map((event) => event.detail)).toEqual([1, 2])
    expect(ofType(seen, 'mouseup').map((event) => event.detail)).toEqual([1, 2])
    expect(ofType(seen, 'click').map((event) => event.detail)).toEqual([1, 2])
    expect(text).toContain('(2 clicks)')
  })

  it('dispatches three clicks with increasing detail', async () => {
    const { text, seen } = await click({ count: 3 })
    expect(ofType(seen, 'mousedown').map((event) => event.detail)).toEqual([1, 2, 3])
    expect(ofType(seen, 'click').map((event) => event.detail)).toEqual([1, 2, 3])
    expect(text).toContain('(3 clicks)')
  })
})

describe('browser_click synthesized modifiers', () => {
  it('sets the ctrl modifier boolean on every synthesized event', async () => {
    const { text, seen } = await click({ modifiers: 'ctrl' })
    expect(seen.every((event) => event.ctrlKey === true)).toBe(true)
    expect(seen.some((event) => event.altKey || event.metaKey || event.shiftKey)).toBe(false)
    expect(text).toContain('modifiers: ctrl')
  })

  it('rejects an unknown modifier and an out-of-range count', async () => {
    document.body.innerHTML = '<button id="go">Go</button>'
    const button = document.querySelector('#go') as HTMLButtonElement
    const ids = idsFor(button)
    await expect(runAction('browser_click', { index: 0, modifiers: 'hyper' }, { ids, budget: BUDGET }))
      .rejects.toMatchObject({ code: 'bad-args' })
    await expect(runAction('browser_click', { index: 0, count: 4 }, { ids, budget: BUDGET }))
      .rejects.toMatchObject({ code: 'bad-args' })
  })
})

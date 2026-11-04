// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import type { ElementIds } from '../src/content/ids.ts'

/**
 * `browser_hover` is the degraded (no-CDP) path: it dispatches the pointer and
 * mouse sequence page hover handlers listen to, with viewport coordinates.
 */

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 2_000 }
const SEQUENCE = ['pointerover', 'mouseover', 'mouseenter', 'pointermove', 'mousemove'] as const

function idsFor(element: Element): ElementIds {
  return { elementByIndex: vi.fn(() => element) } as unknown as ElementIds
}

interface SeenEvent {
  type: string
  x: number
  y: number
  bubbles: boolean
  composed: boolean
}

function record(root: Element | Document): SeenEvent[] {
  const seen: SeenEvent[] = []
  for (const type of SEQUENCE) {
    root.addEventListener(type, (event) => {
      const mouse = event as MouseEvent
      seen.push({ type, x: mouse.clientX, y: mouse.clientY, bubbles: event.bubbles, composed: event.composed })
    })
  }
  return seen
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('browser_hover', () => {
  it('dispatches the hover sequence at the addressed element centre', async () => {
    document.body.innerHTML = '<button id="go">Go</button>'
    const button = document.querySelector('#go') as HTMLButtonElement
    const seen = record(document)

    const result = await runAction('browser_hover', { index: 4 }, { ids: idsFor(button), budget: BUDGET })

    expect(result.text).toBe('Hovered over [4] at (100, 20).')
    expect(seen.map((event) => event.type)).toEqual([...SEQUENCE])
    expect(seen.every((event) => event.x === 100 && event.y === 20)).toBe(true)
    expect(seen.every((event) => event.bubbles && event.composed)).toBe(true)
  })

  it('dispatches at explicit viewport coordinates', async () => {
    const seen = record(document.body)

    const result = await runAction('browser_hover', { x: 42, y: 7 }, { ids: { elementByIndex: vi.fn() } as unknown as ElementIds, budget: BUDGET })

    expect(result.text).toBe('Hovered at (42, 7).')
    expect(seen.map((event) => event.type)).toEqual([...SEQUENCE])
    expect(seen.every((event) => event.x === 42 && event.y === 7)).toBe(true)
  })

  it('rejects ambiguous or missing addressing forms', async () => {
    const button = document.createElement('button')
    document.body.append(button)
    const ctx = { ids: idsFor(button), budget: BUDGET }

    await expect(runAction('browser_hover', { index: 1, x: 5, y: 5 }, ctx))
      .rejects.toMatchObject({ code: 'bad-args', message: expect.stringContaining('not both') })
    await expect(runAction('browser_hover', {}, ctx))
      .rejects.toMatchObject({ code: 'bad-args', message: expect.stringContaining('Provide index') })
  })
})

describe('browser_pointer_rect internal action', () => {
  it('returns the viewport centre of an indexed element', async () => {
    document.body.innerHTML = '<button id="go">Go</button>'
    const button = document.querySelector('#go') as HTMLButtonElement
    const result = await runAction('browser_pointer_rect', { index: 2 }, { ids: idsFor(button), budget: BUDGET })
    const rect = JSON.parse(result.text) as { x: number; y: number; visible: boolean }
    expect(rect).toEqual({ x: 100, y: 20, width: 200, height: 40, visible: true })
    expect(result.pageContent).toBeUndefined()
  })

  it('returns explicit coordinates and both drag endpoints', async () => {
    document.body.innerHTML = '<p id="from">a</p><p id="to">b</p>'
    const from = document.querySelector('#from') as HTMLElement
    const to = document.querySelector('#to') as HTMLElement
    const ids = {
      elementByIndex: vi.fn((index: number) => (index === 0 ? from : to)),
    } as unknown as ElementIds

    const point = await runAction('browser_pointer_rect', { x: 7, y: 9 }, { ids, budget: BUDGET })
    expect(JSON.parse(point.text)).toMatchObject({ x: 7, y: 9, width: 0, height: 0, visible: true })

    const drag = await runAction('browser_pointer_rect', { from_index: 0, to_index: 1 }, { ids, budget: BUDGET })
    expect(JSON.parse(drag.text)).toMatchObject({
      from: { x: 100, y: 20, visible: true },
      to: { x: 100, y: 20, visible: true },
      nativeDrag: false,
    })
  })

  it('marks a draggable source as a native drag target', async () => {
    document.body.innerHTML = '<div id="from" draggable="true">card</div><div id="to">drop zone</div>'
    const from = document.querySelector('#from') as HTMLElement
    const to = document.querySelector('#to') as HTMLElement
    const ids = {
      elementByIndex: vi.fn((index: number) => (index === 0 ? from : to)),
    } as unknown as ElementIds

    const drag = await runAction('browser_pointer_rect', { from_index: 0, to_index: 1 }, { ids, budget: BUDGET })
    expect(JSON.parse(drag.text)).toMatchObject({ nativeDrag: true })
  })

  it('marks an inline drop handler as a native drag target', async () => {
    document.body.innerHTML = '<div id="from">card</div><div id="to" ondragover="return false" ondrop="return false">drop zone</div>'
    const from = document.querySelector('#from') as HTMLElement
    const to = document.querySelector('#to') as HTMLElement
    const ids = {
      elementByIndex: vi.fn((index: number) => (index === 0 ? from : to)),
    } as unknown as ElementIds

    const drag = await runAction('browser_pointer_rect', { from_index: 0, to_index: 1 }, { ids, budget: BUDGET })
    expect(JSON.parse(drag.text)).toMatchObject({ nativeDrag: true })
  })
})

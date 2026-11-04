// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import type { ElementIds } from '../src/content/ids.ts'

/**
 * `browser_drag` is the degraded (no-CDP) path: it synthesizes the
 * pointerdown/mousedown → dragstart → 5×dragover/mousemove → drop →
 * pointerup/mouseup sequence, sharing one `DataTransfer` across drag events.
 */

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 2_000 }
const DRAG_SEQUENCE = [
  'pointerdown', 'mousedown', 'dragstart',
  'dragover', 'mousemove', 'dragover', 'mousemove', 'dragover', 'mousemove',
  'dragover', 'mousemove', 'dragover', 'mousemove',
  'drop', 'pointerup', 'mouseup',
]

// jsdom has no DataTransfer; this stands in for the browser class the action
// constructs so drag payloads are observable.
class FakeDataTransfer {
  private readonly data = new Map<string, string>()

  setData(type: string, value: string): void {
    this.data.set(type, value)
  }

  getData(type: string): string {
    return this.data.get(type) ?? ''
  }
}

interface SeenEvent {
  type: string
  x: number
  y: number
  event: Event
}

function record(): SeenEvent[] {
  const seen: SeenEvent[] = []
  for (const type of new Set(DRAG_SEQUENCE)) {
    document.addEventListener(type, (event) => {
      const mouse = event as MouseEvent
      seen.push({ type, x: mouse.clientX, y: mouse.clientY, event })
    })
  }
  return seen
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'DataTransfer', { configurable: true, writable: true, value: FakeDataTransfer })
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'DataTransfer')
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('browser_drag', () => {
  it('drags between two indices with the full degraded event sequence', async () => {
    document.body.innerHTML = '<button id="source">Card</button><div id="target">Drop here</div>'
    const source = document.querySelector('#source') as HTMLButtonElement
    const target = document.querySelector('#target') as HTMLDivElement
    const ids = { elementByIndex: vi.fn((index: number) => index === 1 ? source : target) } as unknown as ElementIds
    const seen = record()

    const result = await runAction('browser_drag', { from_index: 1, to_index: 2 }, { ids, budget: BUDGET })

    expect(result.text).toBe('Dragged from (100, 20) to (100, 20).')
    expect(seen.map((event) => event.type)).toEqual(DRAG_SEQUENCE)
    const dragstart = seen.find((event) => event.type === 'dragstart')
    const drop = seen.find((event) => event.type === 'drop')
    const dragstartTransfer = (dragstart?.event as DragEvent).dataTransfer
    expect(dragstartTransfer).toBeInstanceOf(FakeDataTransfer)
    expect((drop?.event as DragEvent).dataTransfer).toBe(dragstartTransfer)
  })

  it('drags between coordinate pairs and interpolates five moves', async () => {
    const seen = record()

    const result = await runAction('browser_drag', { from: [10, 10], to: [90, 50] }, {
      ids: { elementByIndex: vi.fn() } as unknown as ElementIds,
      budget: BUDGET,
    })

    expect(result.text).toBe('Dragged from (10, 10) to (90, 50).')
    expect(seen.map((event) => event.type)).toEqual(DRAG_SEQUENCE)
    const moves = seen.filter((event) => event.type === 'mousemove')
    expect(moves.map((event) => [event.x, event.y])).toEqual([[26, 18], [42, 26], [58, 34], [74, 42], [90, 50]])
  })

  it('rejects mixed or missing addressing forms', async () => {
    const ctx = { ids: { elementByIndex: vi.fn() } as unknown as ElementIds, budget: BUDGET }

    await expect(runAction('browser_drag', { from_index: 1, from: [0, 0], to: [9, 9] }, ctx))
      .rejects.toMatchObject({ code: 'bad-args', message: expect.stringContaining('not both') })
    await expect(runAction('browser_drag', {}, ctx))
      .rejects.toMatchObject({ code: 'bad-args', message: expect.stringContaining('Provide from_index') })
  })
})

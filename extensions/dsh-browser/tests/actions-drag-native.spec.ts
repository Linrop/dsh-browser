// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dragRectsAction } from '../src/content/pointer-actions.ts'
import type { ElementIds } from '../src/content/ids.ts'

/**
 * Native drag-and-drop detection reads only markers the isolated world can
 * observe: a `draggable` attribute on an endpoint or an ancestor, and inline
 * drag handlers on the element, document, document element, or window.
 */

const IDS = { elementByIndex: vi.fn() } as unknown as ElementIds

function idsFor(from: Element, to: Element): ElementIds {
  return { elementByIndex: vi.fn((index: number) => index === 1 ? from : to) } as unknown as ElementIds
}

afterEach(() => {
  document.body.innerHTML = ''
  const doc = document as Document & { ondrop?: ((event: Event) => void) | null }
  doc.ondrop = null
  const root = document.documentElement as HTMLElement & { ondrop?: ((event: Event) => void) | null }
  root.ondrop = null
  vi.restoreAllMocks()
})

describe('native drag semantics detection', () => {
  it('treats an endpoint inside an ancestor draggable as a native DnD target', () => {
    document.body.innerHTML = '<div draggable="true"><span id="child">card</span></div><div id="target">drop</div>'
    const child = document.querySelector('#child')!
    const target = document.querySelector('#target')!

    const rects = dragRectsAction({ from_index: 1, to_index: 2 }, idsFor(child, target))

    expect(rects.nativeDrag).toBe(true)
  })

  it('treats a document-level inline drop handler as a native DnD target', () => {
    const doc = document as Document & { ondrop?: ((event: Event) => void) | null }
    doc.ondrop = () => undefined

    const rects = dragRectsAction({ from: [10, 10], to: [20, 20] }, IDS)

    expect(rects.nativeDrag).toBe(true)
  })

  it('treats a document element inline drop handler as a native DnD target', () => {
    const root = document.documentElement as HTMLElement & { ondrop?: ((event: Event) => void) | null }
    root.ondrop = () => undefined

    const rects = dragRectsAction({ from: [10, 10], to: [20, 20] }, IDS)

    expect(rects.nativeDrag).toBe(true)
  })

  it('does not infer native DnD from addEventListener-only listeners', () => {
    document.body.innerHTML = '<div id="source">card</div><div id="target">drop</div>'
    const source = document.querySelector('#source')!
    const target = document.querySelector('#target')!
    source.addEventListener('dragstart', () => undefined)
    target.addEventListener('drop', () => undefined)

    const rects = dragRectsAction({ from_index: 1, to_index: 2 }, idsFor(source, target))

    expect(rects.nativeDrag).toBe(false)
  })
})

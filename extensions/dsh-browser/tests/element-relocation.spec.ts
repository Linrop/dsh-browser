// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'
import { buildSnapshot, type SnapshotBudget } from '../src/content/snapshot.ts'

/**
 * A snapshot number addresses the node the snapshot rendered. A single-page
 * app can replace that node without replacing the document, so an action must
 * re-resolve the control through the selector recorded with the number, and
 * report an actionable failure when it cannot.
 */

const BUDGET: SnapshotBudget = { maxItems: 20, maxForms: 10, maxChars: 2_000 }

function snapshot(ids: ElementIds): ReturnType<typeof buildSnapshot> {
  return buildSnapshot(ids, { budget: BUDGET }, null)
}

/**
 * Let the action's settle observer finish under fake timers.
 *
 * The rejection handler is attached before the timer advance: an action that
 * fails immediately rejects during the advance, which would otherwise be
 * reported as an unhandled rejection.
 */
async function settled<T>(work: Promise<T>): Promise<T> {
  work.catch(() => {})
  await vi.advanceTimersByTimeAsync(300)
  return work
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
  // jsdom implements no layout, so there is nothing to scroll.
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
  document.body.innerHTML = ''
})

describe('snapshot reference re-resolution', () => {
  it('re-locates a re-rendered button through its recorded selector and says so', async () => {
    document.body.innerHTML = '<div id="app"><button>Submit</button></div>'
    const ids = new ElementIds()
    const view = snapshot(ids)
    const target = view.items.find((item) => item.role === 'button')!
    expect(ids.selectorFor(target.index)).toBe('div#app > button')

    // The app re-renders the node: same markup, different DOM node.
    document.body.innerHTML = '<div id="app"><button>Submit</button></div>'
    const replacement = document.querySelector('button')!
    const clicks = vi.fn()
    replacement.addEventListener('click', clicks)

    const result = await settled(runAction('browser_click', { index: target.index }, { ids, budget: BUDGET }))

    expect(clicks).toHaveBeenCalledOnce()
    expect(result.text).toContain('Clicked [' + target.index + ']')
    expect(result.text).toContain(
      'The element at ref ' + target.index + ' was re-located by selector div#app > button after the page changed.',
    )
  })

  it('re-locates a re-rendered input before typing into it', async () => {
    document.body.innerHTML = '<div id="app"><input id="email" type="email"></div>'
    const ids = new ElementIds()
    const view = snapshot(ids)
    const field = view.forms.find((form) => form.kind === 'email')!
    expect(ids.selectorFor(field.index)).toBe('input#email')

    document.body.innerHTML = '<div id="app"><input id="email" type="email"></div>'
    const replacement = document.querySelector<HTMLInputElement>('input')!

    const result = await settled(runAction('browser_type', { index: field.index, text: 'hi' }, { ids, budget: BUDGET }))

    expect(replacement.value).toBe('hi')
    expect(result.text).toContain('Entered 2 characters into [' + field.index + ']')
    expect(result.text).toContain('was re-located by selector')
  })

  it('leaves a live element alone and adds no re-location note', async () => {
    document.body.innerHTML = '<div id="app"><button>Submit</button></div>'
    const ids = new ElementIds()
    const view = snapshot(ids)
    const target = view.items.find((item) => item.role === 'button')!

    const result = await settled(runAction('browser_click', { index: target.index }, { ids, budget: BUDGET }))

    expect(result.text).toContain('Clicked [' + target.index + ']')
    expect(result.text).not.toContain('was re-located')
  })

  it('reports the selector when the element no longer exists', async () => {
    document.body.innerHTML = '<div id="app"><button>Submit</button></div>'
    const ids = new ElementIds()
    const view = snapshot(ids)
    const target = view.items.find((item) => item.role === 'button')!
    document.body.innerHTML = '<div id="app"></div>'

    await expect(settled(runAction('browser_click', { index: target.index }, { ids, budget: BUDGET })))
      .rejects.toMatchObject({
        message: 'The element at ref ' + target.index
          + ' no longer exists (selector: div#app > button). Call browser_snapshot and retry.',
      })
  })

  it('reports ambiguity with the match count when the selector matches several elements', async () => {
    document.body.innerHTML = '<div id="app"><button>Submit</button></div>'
    const ids = new ElementIds()
    const view = snapshot(ids)
    const target = view.items.find((item) => item.role === 'button')!
    document.body.innerHTML = '<div id="app"><button>One</button><button>Two</button></div>'

    await expect(settled(runAction('browser_type', { index: target.index, text: 'x' }, { ids, budget: BUDGET })))
      .rejects.toMatchObject({
        message: 'The element at ref ' + target.index
          + ' is ambiguous: selector div#app > button now matches 2 elements. Call browser_snapshot and retry.',
      })
  })

  it('reports a missing selector when the number was never snapshotted', async () => {
    const ids = new ElementIds()
    await expect(settled(runAction('browser_click', { index: 99 }, { ids, budget: BUDGET })))
      .rejects.toMatchObject({
        message: 'The element at ref 99 no longer exists (no selector was recorded for it). Call browser_snapshot and retry.',
      })
  })
})

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import type { ElementIds } from '../src/content/ids.ts'

/**
 * `browser_select` addresses one option by value, visible label, or option
 * index, dispatches change/input, and names the available options when the
 * request misses.
 */

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 2_000 }

function idsFor(element: Element): ElementIds {
  return { elementByIndex: vi.fn(() => element) } as unknown as ElementIds
}

function select(): HTMLSelectElement {
  document.body.innerHTML = `
    <select id="pick">
      <option value="">Choose one</option>
      <option value="a">Alpha</option>
      <option value="b">Beta</option>
    </select>`
  return document.querySelector('#pick') as HTMLSelectElement
}

function recordedEvents(el: Element): string[] {
  const seen: string[] = []
  for (const type of ['change', 'input']) el.addEventListener(type, () => seen.push(type))
  return seen
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('browser_select', () => {
  it('selects by value and reports the option it chose', async () => {
    const el = select()
    const seen = recordedEvents(el)

    const result = await runAction('browser_select', { index: 2, value: 'b' }, { ids: idsFor(el), budget: BUDGET })

    expect(result.text).toBe('Selected option "Beta" (value: "b") in [2].')
    expect(el.value).toBe('b')
    expect(el.selectedIndex).toBe(2)
    expect(seen).toEqual(['change', 'input'])
  })

  it('selects by visible label and by option index', async () => {
    const el = select()
    const ctx = { ids: idsFor(el), budget: BUDGET }

    await runAction('browser_select', { index: 2, label: 'Alpha' }, ctx)
    expect(el.value).toBe('a')

    await runAction('browser_select', { index: 2, option_index: 2 }, ctx)
    expect(el.value).toBe('b')
  })

  it('lists the available options when the value is missing', async () => {
    const el = select()

    await expect(runAction('browser_select', { index: 2, value: 'missing' }, { ids: idsFor(el), budget: BUDGET }))
      .rejects.toMatchObject({ code: 'bad-args', message: expect.stringContaining('"Alpha" (value: "a")') })
  })

  it('rejects an option index past the last option', async () => {
    const el = select()

    await expect(runAction('browser_select', { index: 2, option_index: 9 }, { ids: idsFor(el), budget: BUDGET }))
      .rejects.toMatchObject({ code: 'bad-args', message: expect.stringContaining('Option index 9 not found') })
  })

  it('requires exactly one of value, label, and option_index', async () => {
    const el = select()

    await expect(runAction('browser_select', { index: 2, value: 'a', label: 'Alpha' }, { ids: idsFor(el), budget: BUDGET }))
      .rejects.toMatchObject({ code: 'bad-args' })
  })

  it('refuses an element that is not a select', async () => {
    const button = document.createElement('button')
    document.body.append(button)

    await expect(runAction('browser_select', { index: 1, value: 'a' }, { ids: idsFor(button), budget: BUDGET }))
      .rejects.toMatchObject({ code: 'action-failed', message: expect.stringContaining('is not a <select>') })
  })
})

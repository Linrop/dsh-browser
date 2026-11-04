// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'
import { buildSnapshot, renderSnapshot, type SnapshotBudget } from '../src/content/snapshot.ts'

/**
 * `browser_find` searches the inventory `browser_snapshot` renders: hits keep
 * the snapshot's element numbers, so a found element can be clicked directly.
 */

const BUDGET: SnapshotBudget = { maxItems: 20, maxForms: 10, maxChars: 4_000 }

function ctx(ids = new ElementIds()): { ids: ElementIds; budget: SnapshotBudget } {
  return { ids, budget: BUDGET }
}

function pushDown(el: Element): void {
  el.getBoundingClientRect = () => ({
    x: 0,
    y: -1_000,
    top: -1_000,
    left: 0,
    right: 200,
    bottom: -960,
    width: 200,
    height: 40,
    toJSON: () => ({}),
  })
}

afterEach(() => {
  document.body.innerHTML = ''
  document.title = ''
})

describe('browser_find', () => {
  it('ranks name matches above off-screen duplicates and keeps snapshot indices', async () => {
    document.body.innerHTML = `
      <button id="visible">Checkout</button>
      <button id="offscreen">Checkout</button>
      <a href="/cart">Continue</a>`
    pushDown(document.querySelector('#offscreen')!)
    const session = ctx()

    const result = await runAction('browser_find', { query: 'checkout' }, session)

    expect(result.text).toBe('2 elements share words with the query:\n[1] button "Checkout"\n[2] button "Checkout"')
    const view = buildSnapshot(session.ids, { budget: BUDGET }, null)
    expect(renderSnapshot(view, false)).toContain('[1] button "Checkout"')
    expect(renderSnapshot(view, false)).toContain('[2] button "Checkout"')
  })

  it('ranks a name match above an identity-only match', async () => {
    document.body.innerHTML = `
      <button>Checkout</button>
      <a id="checkout" href="/cart">Continue</a>`
    const session = ctx()

    const result = await runAction('browser_find', { query: 'checkout' }, session)

    expect(result.text).toBe('2 elements share words with the query:\n[1] button "Checkout"\n[2] link "Continue"')
  })

  it('filters structural roles unless filter is all, and applies the limit', async () => {
    document.body.innerHTML = `
      <button>Save</button>
      <button role="presentation">Save ghost</button>`
    const session = ctx()

    const interactive = await runAction('browser_find', { query: 'save' }, session)
    expect(interactive.text).toBe('1 elements share words with the query:\n[1] button "Save"')

    const all = await runAction('browser_find', { query: 'save', filter: 'all' }, session)
    expect(all.text).toBe('2 elements share words with the query:\n[1] button "Save"\n[2] presentation "Save ghost"')

    const limited = await runAction('browser_find', { query: 'save', filter: 'all', limit: 1 }, session)
    expect(limited.text).toBe('1 elements share words with the query:\n[1] button "Save"')
  })

  it('treats a query made only of role words as a role filter', async () => {
    document.body.innerHTML = `
      <button>Submit</button>
      <a href="/btn-docs">btn docs</a>`
    const session = ctx()

    const result = await runAction('browser_find', { query: 'btn' }, session)

    expect(result.text).toBe('1 elements share words with the query:\n[1] button "Submit"')
  })

  it('reports no matches with the next-step hint', async () => {
    document.body.innerHTML = '<button>Save</button>'

    const result = await runAction('browser_find', { query: 'zzz' }, ctx())

    expect(result.text).toBe('No matching elements found. Try words that appear on the page, or use browser_snapshot to list it.')
  })

  it('rejects an empty query and an unknown filter', async () => {
    document.body.innerHTML = '<button>Save</button>'

    await expect(runAction('browser_find', { query: '   ' }, ctx()))
      .rejects.toMatchObject({ code: 'bad-args', message: expect.stringContaining('query must be a non-empty string') })
    await expect(runAction('browser_find', { query: 'save', filter: 'inputs' }, ctx()))
      .rejects.toMatchObject({ code: 'bad-args', message: expect.stringContaining('filter must be interactive or all') })
  })
})

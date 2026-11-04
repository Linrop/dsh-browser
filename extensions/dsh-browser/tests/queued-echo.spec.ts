// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { addQueuedEcho, pruneQueuedEchoes, type QueuedEcho } from '../src/panel/queued-echo.ts'

const echo = (text: string, sinceSeq = 0): QueuedEcho => ({ key: `${text}-${sinceSeq}`, text, sinceSeq })

describe('queued prompt echo', () => {
  it('keeps one echo per distinct message', () => {
    const first = addQueuedEcho([], echo('one'))
    expect(addQueuedEcho(first, echo('two')).map((item) => item.text)).toEqual(['one', 'two'])
    expect(addQueuedEcho(first, echo('one'))).toHaveLength(1)
  })

  it('drops an echo once its durable user row arrives', () => {
    const waiting = [echo('older message', 2), echo('queued message', 2)]
    const rows = [
      { kind: 'user', text: 'older message', seq: 1 },
      { kind: 'user', text: 'queued message', seq: 3 },
    ]
    expect(pruneQueuedEchoes(waiting, rows).map((item) => item.text)).toEqual(['older message'])
  })

  it('keeps the echo while only assistant rows move', () => {
    const waiting = [echo('queued message', 4)]
    const rows = [{ kind: 'assistant', text: 'queued message', seq: 5 }]
    expect(pruneQueuedEchoes(waiting, rows)).toHaveLength(1)
  })

  it('ignores a user row that repeats the text but predates the echo', () => {
    const waiting = [echo('same text', 7)]
    expect(pruneQueuedEchoes(waiting, [{ kind: 'user', text: 'same text', seq: 6 }])).toHaveLength(1)
  })

  it('returns an empty list without work when nothing is queued', () => {
    expect(pruneQueuedEchoes([], [])).toEqual([])
  })
})

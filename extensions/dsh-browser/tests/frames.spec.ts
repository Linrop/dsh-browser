// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  allocateFrameBudgets,
  forgetTabFrames,
  listTabFrames,
  sortTabFrames,
  type TabFrame,
} from '../src/background/frames.ts'

function frames(count: number): TabFrame[] {
  return Array.from({ length: count }, (_, frameId) => ({
    frameId,
    parentFrameId: frameId === 0 ? -1 : 0,
    url: `https://frame-${frameId}.example/`,
  }))
}

describe('allocateFrameBudgets', () => {
  it('gives a single main frame the complete negotiated budget', () => {
    expect(allocateFrameBudgets(frames(1), { maxItems: 60, maxChars: 12_000 }).get(0))
      .toEqual({ maxItems: 60, maxChars: 12_000 })
  })

  it('reserves 80% for the main frame and divides the exact remainder', () => {
    const allocated = allocateFrameBudgets(frames(3), { maxItems: 10, maxChars: 100 })

    expect(allocated.get(0)).toEqual({ maxItems: 8, maxChars: 80 })
    expect(allocated.get(1)).toEqual({ maxItems: 1, maxChars: 10 })
    expect(allocated.get(2)).toEqual({ maxItems: 1, maxChars: 10 })
  })

  it('uses zero-item child allocations when the negotiated cap is exhausted', () => {
    const allocated = allocateFrameBudgets(frames(6), { maxItems: 1, maxChars: 3 })

    expect(allocated.get(0)).toEqual({ maxItems: 1, maxChars: 2 })
    expect([...allocated.values()].slice(1).map((entry) => entry.maxItems)).toEqual([0, 0, 0, 0, 0])
    expect([...allocated.values()].reduce((sum, entry) => sum + entry.maxItems, 0)).toBe(1)
    expect([...allocated.values()].reduce((sum, entry) => sum + entry.maxChars, 0)).toBe(3)
  })

  it('never exceeds either cap across iframe-heavy pages', () => {
    for (const frameCount of [2, 3, 25, 100]) {
      for (const maxItems of [1, 2, 10, 60]) {
        const budget = { maxItems, maxChars: maxItems * 7 }
        const allocated = [...allocateFrameBudgets(frames(frameCount), budget).values()]
        expect(allocated.reduce((sum, entry) => sum + entry.maxItems, 0)).toBeLessThanOrEqual(budget.maxItems)
        expect(allocated.reduce((sum, entry) => sum + entry.maxChars, 0)).toBeLessThanOrEqual(budget.maxChars)
      }
    }
  })
})

describe('sortTabFrames', () => {
  it('orders parents before nested descendants without mutating the input', () => {
    const input: TabFrame[] = [
      { frameId: 9, parentFrameId: 4, url: 'https://deep.example/' },
      { frameId: 4, parentFrameId: 0, url: 'https://child.example/' },
      { frameId: 0, parentFrameId: -1, url: 'https://top.example/' },
      { frameId: 2, parentFrameId: 0, url: 'https://sibling.example/' },
    ]

    expect(sortTabFrames(input).map((frame) => frame.frameId)).toEqual([0, 2, 4, 9])
    expect(input.map((frame) => frame.frameId)).toEqual([9, 4, 0, 2])
  })
})

function stubFrameTree(initial: chrome.webNavigation.GetAllFrameResultDetails[]): {
  set: (frames: chrome.webNavigation.GetAllFrameResultDetails[]) => void
} {
  let current = initial
  vi.stubGlobal('chrome', {
    webNavigation: { getAllFrames: vi.fn(async () => current) },
  })
  return { set: (frames) => { current = frames } }
}

function frame(frameId: number, documentId: string, url: string): chrome.webNavigation.GetAllFrameResultDetails {
  return {
    frameId,
    parentFrameId: frameId === 0 ? -1 : 0,
    documentId,
    url,
    processId: 1,
    frameType: frameId === 0 ? 'outermost_frame' : 'sub_frame',
    documentLifecycle: 'active',
    errorOccurred: false,
  } as chrome.webNavigation.GetAllFrameResultDetails
}

afterEach(() => {
  vi.unstubAllGlobals()
  forgetTabFrames(71)
  forgetTabFrames(72)
})

describe('listTabFrames', () => {
  it('re-adds the subframes Chrome omits for a restored document', async () => {
    const tree = stubFrameTree([
      frame(0, 'top-document', 'https://top.example/'),
      frame(636, 'child-document', 'https://embed.example.net/'),
    ])
    expect((await listTabFrames(71, 'https://top.example/')).map((entry) => entry.frameId)).toEqual([0, 636])

    // History restore: same main document id, subframe gone from the frame tree.
    tree.set([frame(0, 'top-document', 'https://top.example/')])
    const restored = await listTabFrames(71, 'https://top.example/')
    expect(restored.map((entry) => entry.frameId)).toEqual([0, 636])
    expect(restored[1]).toMatchObject({
      frameId: 636,
      parentFrameId: 0,
      documentId: 'child-document',
      recovered: true,
    })
  })

  it('drops a stale frame entry that has no usable frame id', async () => {
    stubFrameTree([
      frame(0, 'top-document', 'https://top.example/'),
      frame(636, 'child-document', 'https://embed.example.net/'),
    ])
    await listTabFrames(72, 'https://top.example/')

    const stale = [
      frame(0, 'top-document', 'https://top.example/'),
      { ...frame(0, 'child-document', 'https://embed.example.net/'), frameId: undefined },
    ] as unknown as chrome.webNavigation.GetAllFrameResultDetails[]
    vi.stubGlobal('chrome', { webNavigation: { getAllFrames: vi.fn(async () => stale) } })
    const frames = await listTabFrames(72, 'https://top.example/')
    expect(frames.map((entry) => entry.frameId)).toEqual([0, 636])
  })

  it('forgets subframes once the main document is replaced', async () => {
    const tree = stubFrameTree([
      frame(0, 'top-document', 'https://top.example/'),
      frame(636, 'child-document', 'https://embed.example.net/'),
    ])
    await listTabFrames(72, 'https://top.example/')
    tree.set([frame(0, 'next-document', 'https://top.example/next')])
    expect((await listTabFrames(72, 'https://top.example/next')).map((entry) => entry.frameId)).toEqual([0])
  })
})

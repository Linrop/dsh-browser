// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  base64ByteLength,
  DEFAULT_RECORDING_LIMITS,
  RecordingBuffer,
  recordingStatus,
  type RecordingFrameInput,
} from '../src/content/recorder.ts'

function frame(base64: string, action = 'timer'): RecordingFrameInput {
  return { base64, action, viewportWidth: 1280, viewportHeight: 800, devicePixelRatio: 2 }
}

/** A clock the test advances explicitly. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let value = start
  return { now: () => value, advance: (ms: number) => { value += ms } }
}

describe('recording buffer', () => {
  it('bounds a recording on frame count, bytes, and age by default', () => {
    expect(DEFAULT_RECORDING_LIMITS.maxFrames).toBe(120)
    expect(DEFAULT_RECORDING_LIMITS.maxBytes).toBe(32 * 1024 * 1024)
    expect(DEFAULT_RECORDING_LIMITS.ttlMs).toBe(300_000)
  })

  it('derives each frame delay from the gap since the previous capture', () => {
    const time = clock()
    const buffer = new RecordingBuffer({}, time.now)
    buffer.push(frame('a'), time.now())
    time.advance(120)
    buffer.push(frame('b'), time.now())
    time.advance(480)
    buffer.push(frame('c'), time.now())

    expect(buffer.frames().map((entry) => entry.delay)).toEqual([0, 120, 480])
  })

  it('honours an explicit delay and keeps the capture payload intact', () => {
    const buffer = new RecordingBuffer()
    buffer.push({ ...frame('abc', 'browser_click'), delay: 250 })
    const [stored] = buffer.frames()
    expect(stored).toEqual({
      base64: 'abc',
      action: 'browser_click',
      delay: 250,
      viewportWidth: 1280,
      viewportHeight: 800,
      devicePixelRatio: 2,
    })
  })

  it('drops the oldest frames past the frame budget and counts them', () => {
    const buffer = new RecordingBuffer({ maxFrames: 3 })
    for (let index = 0; index < 5; index += 1) buffer.push(frame(`f${index}`))

    expect(buffer.frames().map((entry) => entry.base64)).toEqual(['f2', 'f3', 'f4'])
    expect(buffer.stats).toMatchObject({ frames: 3, dropped: 2, expired: 0 })
  })

  it('drops the oldest frames past the byte budget and counts them', () => {
    const buffer = new RecordingBuffer({ maxBytes: 10 })
    buffer.push(frame('12345'))
    buffer.push(frame('67890'))
    expect(buffer.stats.bytes).toBe(10)
    buffer.push(frame('abcde'))
    // Two frames of 5 bytes still fit; the third evicts only the first.
    expect(buffer.frames().map((entry) => entry.base64)).toEqual(['67890', 'abcde'])
    expect(buffer.stats).toMatchObject({ frames: 2, bytes: 10, dropped: 1 })

    buffer.push(frame('fghij'))
    expect(buffer.stats).toMatchObject({ frames: 2, bytes: 10, dropped: 2 })
    expect(buffer.frames()).toHaveLength(2)
  })

  it('expires frames older than the TTL before enforcing the budgets', () => {
    const time = clock()
    const buffer = new RecordingBuffer({ ttlMs: 1_000 }, time.now)
    buffer.push(frame('old'), time.now())
    time.advance(500)
    buffer.push(frame('fresh'), time.now())
    time.advance(700)
    buffer.push(frame('newest'), time.now())

    // At t=2200 the first frame is 1200 ms old: expired, not "dropped".
    expect(buffer.frames().map((entry) => entry.base64)).toEqual(['fresh', 'newest'])
    expect(buffer.stats).toMatchObject({ frames: 2, expired: 1, dropped: 0 })
  })

  it('counts a frame that is both too old and over budget once', () => {
    const time = clock()
    const buffer = new RecordingBuffer({ maxFrames: 1, ttlMs: 10_000 }, time.now)
    buffer.push(frame('a'), time.now())
    buffer.push(frame('b'), time.now())
    expect(buffer.stats).toMatchObject({ frames: 1, dropped: 1, expired: 0 })
  })

  it('clears frames and the discarded counters', () => {
    const buffer = new RecordingBuffer({ maxFrames: 1 })
    buffer.push(frame('a'))
    buffer.push(frame('b'))
    expect(buffer.stats.dropped).toBe(1)

    buffer.clear()
    expect(buffer.frames()).toEqual([])
    expect(buffer.stats).toEqual({ frames: 0, bytes: 0, dropped: 0, expired: 0 })
  })

  it('hands out copies so callers cannot mutate stored frames', () => {
    const buffer = new RecordingBuffer()
    buffer.push(frame('a'))
    const [stored] = buffer.frames()
    stored!.base64 = 'tampered'
    stored!.delay = 999
    expect(buffer.frames()[0]).toMatchObject({ base64: 'a', delay: 0 })
  })

  it('counts base64 payload bytes as the string length', () => {
    expect(base64ByteLength('')).toBe(0)
    expect(base64ByteLength('iVBORw0KGgo=')).toBe(12)
  })
})

describe('recording status', () => {
  it('merges buffer totals with capture and export state', () => {
    expect(recordingStatus(true, { frames: 4, bytes: 40, dropped: 1, expired: 2 })).toEqual({
      active: true,
      frames: 4,
      bytes: 40,
      dropped: 1,
      expired: 2,
    })

    expect(recordingStatus(false, { frames: 0, bytes: 0, dropped: 0, expired: 0 }, {
      clearedAt: 1_700_000_000_000,
      filename: 'dsh-recording-2026-11-04T00-00-00-000Z.gif',
    })).toEqual({
      active: false,
      frames: 0,
      bytes: 0,
      dropped: 0,
      expired: 0,
      clearedAt: 1_700_000_000_000,
      filename: 'dsh-recording-2026-11-04T00-00-00-000Z.gif',
    })
  })
})

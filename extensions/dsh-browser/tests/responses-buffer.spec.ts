// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import {
  MAX_PENDING_RESPONSES,
  MAX_PENDING_RESPONSE_BYTES,
  PENDING_RESPONSE_TTL_MS,
  PendingResponseBuffer,
} from '../src/background/responses.ts'

describe('PendingResponseBuffer', () => {
  it('shifts the oldest receipt out when the entry count overflows', () => {
    const buffer = new PendingResponseBuffer(() => 0)
    for (let i = 0; i < MAX_PENDING_RESPONSES + 2; i += 1) {
      buffer.push({ type: 'respond.result', id: `r${i}` })
    }
    expect(buffer.size).toBe(MAX_PENDING_RESPONSES)
    expect(buffer.dropped).toBe(2)

    const delivered: unknown[] = []
    buffer.drain({ postMessage: (message) => { delivered.push(message) } })
    // The two oldest were evicted; the rest arrive in insertion order.
    expect(delivered).toHaveLength(MAX_PENDING_RESPONSES)
    expect(delivered[0]).toMatchObject({ id: 'r2' })
    expect(delivered.at(-1)).toMatchObject({ id: `r${MAX_PENDING_RESPONSES + 1}` })
  })

  it('evicts the oldest receipt when the byte budget would overflow', () => {
    const buffer = new PendingResponseBuffer(() => 0)
    const half = 'x'.repeat(MAX_PENDING_RESPONSE_BYTES / 2 + 1024)
    buffer.push({ type: 'respond.result', id: 'first', payload: half })
    buffer.push({ type: 'respond.result', id: 'second', payload: half })
    expect(buffer.size).toBe(1)
    expect(buffer.dropped).toBe(1)
    expect(buffer.bytes).toBeLessThanOrEqual(MAX_PENDING_RESPONSE_BYTES)

    const delivered: Array<{ id?: string }> = []
    buffer.drain({ postMessage: (message) => { delivered.push(message as { id?: string }) } })
    expect(delivered).toEqual([{ type: 'respond.result', id: 'second', payload: half }])
  })

  it('refuses a single receipt larger than the whole budget', () => {
    const buffer = new PendingResponseBuffer(() => 0)
    buffer.push({ payload: 'x'.repeat(MAX_PENDING_RESPONSE_BYTES + 1) })
    expect(buffer.size).toBe(0)
    expect(buffer.dropped).toBe(1)
  })

  it('drops receipts older than the TTL', () => {
    let now = 1_000
    const buffer = new PendingResponseBuffer(() => now)
    buffer.push({ id: 'stale' })
    now += PENDING_RESPONSE_TTL_MS + 1
    buffer.push({ id: 'fresh' })

    const delivered: unknown[] = []
    buffer.drain({ postMessage: (message) => { delivered.push(message) } })
    expect(delivered).toEqual([{ id: 'fresh' }])
    expect(buffer.dropped).toBe(1)
  })

  it('replays buffered receipts to the next panel exactly once', () => {
    const buffer = new PendingResponseBuffer(() => 0)
    buffer.push({ id: 'a' })
    buffer.push({ id: 'b' })
    const port = { postMessage: vi.fn() }
    buffer.drain(port)
    expect(port.postMessage.mock.calls.map((call) => call[0])).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(buffer.size).toBe(0)

    buffer.drain(port)
    expect(port.postMessage).toHaveBeenCalledTimes(2)
  })

  it('keeps a receipt whose replay port failed', () => {
    const buffer = new PendingResponseBuffer(() => 0)
    buffer.push({ id: 'a' })
    buffer.drain({ postMessage: () => { throw new Error('port closed') } })
    expect(buffer.size).toBe(1)
  })

  it('counts unserializable receipts as dropped instead of storing them', () => {
    const buffer = new PendingResponseBuffer(() => 0)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    buffer.push(circular)
    expect(buffer.size).toBe(0)
    expect(buffer.dropped).toBe(1)
  })
})

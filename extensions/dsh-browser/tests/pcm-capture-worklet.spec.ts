// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

/**
 * Loads the shipped worklet source into a stub audio-thread context.
 *
 * The worklet is plain JavaScript served from `public/`, so Node cannot import
 * it as a module; evaluating it with the two globals the audio thread provides
 * exercises exactly the code the browser runs.
 */
function loadProcessor(): {
  posted: { block: Float32Array; transferred: unknown[] }[]
  process: (inputs: Float32Array[][]) => boolean
} {
  const source = readFileSync(`${process.cwd()}/public/pcm-capture.worklet.js`, 'utf8')
  const posted: { block: Float32Array; transferred: unknown[] }[] = []
  let registered: (new () => { process: (inputs: Float32Array[][]) => boolean }) | undefined
  class AudioWorkletProcessorStub {
    readonly port = {
      postMessage: (block: Float32Array, transferred: unknown[]): void => {
        posted.push({ block, transferred })
      },
    }
  }
  runInNewContext(source, {
    AudioWorkletProcessor: AudioWorkletProcessorStub,
    registerProcessor: (name: string, ctor: new () => { process: (inputs: Float32Array[][]) => boolean }): void => {
      expect(name).toBe('pcm-capture')
      registered = ctor
    },
    Float32Array,
  })
  if (registered === undefined) throw new Error('the worklet did not register a processor')
  const instance = new registered()
  return { posted, process: (inputs) => instance.process(inputs) }
}

describe('pcm-capture worklet', () => {
  it('posts a transferred copy of each render quantum and keeps running', () => {
    const { posted, process } = loadProcessor()
    const quantum = Float32Array.from([0.1, -0.2, 0.3])
    expect(process([[quantum]])).toBe(true)
    expect(posted).toHaveLength(1)
    // Float32 rounding is expected; compare against the same source values.
    expect(Array.from(posted[0]!.block)).toEqual(Array.from(Float32Array.from([0.1, -0.2, 0.3])))
    // The copy is transferred, so the render buffer is never aliased.
    expect(posted[0]!.block).not.toBe(quantum)
    expect(posted[0]!.transferred).toEqual([posted[0]!.block.buffer])
  })

  it('stays silent on an empty input instead of posting a zero-length block', () => {
    const { posted, process } = loadProcessor()
    expect(process([])).toBe(true)
    expect(process([[]])).toBe(true)
    expect(process([[new Float32Array(0)]])).toBe(true)
    expect(posted).toEqual([])
  })
})

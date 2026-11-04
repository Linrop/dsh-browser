// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  delayCentiseconds,
  encodeGif,
  GIF_PALETTE,
  quantizeFrame,
  type GifFrameInput,
} from '../src/offscreen/gif-encoder.ts'

/** Byte offset of the first image block for the single-frame fixture below. */
const FIRST_IMAGE_OFFSET = 6 + 7 + 768 + 19

function bytes(offset: number, length: number, gif: Uint8Array): number[] {
  return Array.from(gif.slice(offset, offset + length))
}

function readU16(gif: Uint8Array, offset: number): number {
  return gif[offset]! | (gif[offset + 1]! << 8)
}

/** Minimal GIF reader used to verify the encoder byte-for-byte. */
function decodeGif(gif: Uint8Array): { width: number; height: number; frames: { indices: number[]; delay: number }[] } {
  expect(String.fromCharCode(...gif.slice(0, 6))).toBe('GIF89a')
  const width = readU16(gif, 6)
  const height = readU16(gif, 8)
  const packed = gif[10]!
  expect(packed & 0x80).toBe(0x80)
  const tableSize = 3 * (1 << ((packed & 0x07) + 1))
  let offset = 13 + tableSize
  const frames: { indices: number[]; delay: number }[] = []
  let pendingDelay = 0
  while (offset < gif.length) {
    const block = gif[offset]!
    if (block === 0x3b) break
    if (block === 0x21) {
      const label = gif[offset + 1]!
      if (label === 0xf9) {
        pendingDelay = readU16(gif, offset + 4)
        offset += 8
        continue
      }
      // Application/comment extension: skip the fixed header then sub-blocks.
      offset += 2
      const size = gif[offset]!
      offset += 1 + size
      while (gif[offset] !== 0) offset += 1 + gif[offset]!
      offset += 1
      continue
    }
    expect(block).toBe(0x2c)
    const frameWidth = readU16(gif, offset + 5)
    const frameHeight = readU16(gif, offset + 7)
    expect(frameWidth).toBe(width)
    expect(frameHeight).toBe(height)
    offset += 10
    const minCodeSize = gif[offset]!
    offset += 1
    const chunks: number[] = []
    while (gif[offset] !== 0) {
      const size = gif[offset]!
      chunks.push(...gif.slice(offset + 1, offset + 1 + size))
      offset += 1 + size
    }
    offset += 1
    frames.push({ indices: decodeLzw(Uint8Array.from(chunks), minCodeSize), delay: pendingDelay })
  }
  return { width, height, frames }
}

function decodeLzw(data: Uint8Array, minCodeSize: number): number[] {
  const clearCode = 1 << minCodeSize
  const endCode = clearCode + 1
  let codeSize = minCodeSize + 1
  let dictionary: number[][] = []
  const reset = (): void => {
    dictionary = []
    for (let index = 0; index < clearCode; index += 1) dictionary.push([index])
    dictionary.push([], [])
    codeSize = minCodeSize + 1
  }
  reset()
  const out: number[] = []
  let bitBuffer = 0
  let bitCount = 0
  let position = 0
  let previous: number[] | null = null
  const nextCode = (): number => {
    while (bitCount < codeSize) {
      bitBuffer |= (data[position] ?? 0) << bitCount
      position += 1
      bitCount += 8
    }
    const code = bitBuffer & ((1 << codeSize) - 1)
    bitBuffer >>= codeSize
    bitCount -= codeSize
    return code
  }
  for (;;) {
    const code = nextCode()
    if (code === clearCode) {
      reset()
      previous = null
      continue
    }
    if (code === endCode) break
    let entry: number[]
    if (code < dictionary.length) entry = dictionary[code]!
    else if (previous !== null) entry = [...previous, previous[0]!]
    else throw new Error(`bad LZW code ${code}`)
    out.push(...entry)
    if (previous !== null) {
      dictionary.push([...previous, entry[0]!])
      if (dictionary.length === 1 << codeSize && codeSize < 12) codeSize += 1
    }
    previous = entry
  }
  return out
}

function singleFrame(indices: Uint8Array, width: number, height: number, delayMs = 100): GifFrameInput {
  return { indices, width, height, delayMs }
}

describe('GIF encoding', () => {
  it('writes the header, logical screen, global palette, loop block, and trailer', () => {
    const gif = encodeGif([singleFrame(Uint8Array.of(0), 1, 1)])

    expect(String.fromCharCode(...gif.slice(0, 6))).toBe('GIF89a')
    expect(readU16(gif, 6)).toBe(1)
    expect(readU16(gif, 8)).toBe(1)
    // GCT present, 8-bit color resolution, 256-entry table, no background/aspect surprises.
    expect(bytes(10, 3, gif)).toEqual([0xf7, 0x00, 0x00])
    expect(GIF_PALETTE).toHaveLength(256)
    expect(bytes(13, 3, gif)).toEqual([0, 0, 0])
    expect(bytes(13 + 255 * 3, 3, gif)).toEqual([255, 255, 255])

    const netscape = FIRST_IMAGE_OFFSET - 19
    expect(bytes(netscape, 3, gif)).toEqual([0x21, 0xff, 0x0b])
    expect(String.fromCharCode(...gif.slice(netscape + 3, netscape + 14))).toBe('NETSCAPE2.0')
    expect(bytes(netscape + 14, 5, gif)).toEqual([0x03, 0x01, 0x00, 0x00, 0x00])
    expect(gif[gif.length - 1]).toBe(0x3b)
  })

  it('encodes one 1×1 single-color frame to the minimal LZW stream', () => {
    const gif = encodeGif([singleFrame(Uint8Array.of(0), 1, 1)], { loop: 3 })

    // Graphic control extension: disposal 1, delay 10 centiseconds, no transparency.
    expect(bytes(FIRST_IMAGE_OFFSET, 8, gif)).toEqual([0x21, 0xf9, 0x04, 0x04, 0x0a, 0x00, 0x00, 0x00])
    // Image descriptor: full-frame, no local color table.
    expect(bytes(FIRST_IMAGE_OFFSET + 8, 10, gif)).toEqual([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00])
    // 8-bit codes: clear(0x100), pixel 0, end(0x101) → 00 01 04 04.
    expect(bytes(FIRST_IMAGE_OFFSET + 18, gif.length - 18 - FIRST_IMAGE_OFFSET - 1, gif))
      .toEqual([8, 4, 0x00, 0x01, 0x04, 0x04, 0x00])
    expect(gif[gif.length - 1]).toBe(0x3b)
  })

  it('writes the loop count from options', () => {
    const infinite = encodeGif([singleFrame(Uint8Array.of(0), 1, 1)])
    const thrice = encodeGif([singleFrame(Uint8Array.of(0), 1, 1)], { loop: 3 })
    // Same length; only the NETSCAPE repeat field differs.
    expect(thrice.length).toBe(infinite.length)
    const loopOffset = FIRST_IMAGE_OFFSET - 19 + 16
    expect(readU16(infinite, loopOffset)).toBe(0)
    expect(readU16(thrice, loopOffset)).toBe(3)
  })

  it('rejects frames whose sizes differ', () => {
    const frames = [
      singleFrame(new Uint8Array(4), 2, 2),
      { ...singleFrame(new Uint8Array(9), 3, 3) },
    ]
    expect(() => encodeGif(frames)).toThrow(/share one size/)
  })

  it('rejects an index count that does not match the frame size', () => {
    expect(() => encodeGif([singleFrame(new Uint8Array(3), 2, 2)])).toThrow(/indices/)
  })

  it('rejects an empty recording and invalid sizes', () => {
    expect(() => encodeGif([])).toThrow(/at least one frame/)
    expect(() => encodeGif([singleFrame(new Uint8Array(0), 0, 4)])).toThrow(/Invalid frame size/)
  })

  it('rounds display delays to hundredths of a second', () => {
    expect(delayCentiseconds(0)).toBe(0)
    expect(delayCentiseconds(-5)).toBe(0)
    expect(delayCentiseconds(4)).toBe(0)
    expect(delayCentiseconds(5)).toBe(1)
    expect(delayCentiseconds(99)).toBe(10)
    expect(delayCentiseconds(100)).toBe(10)
    expect(delayCentiseconds(1234)).toBe(123)
    expect(delayCentiseconds(Number.POSITIVE_INFINITY)).toBe(0)
    expect(delayCentiseconds(1e9)).toBe(0xffff)

    const gif = encodeGif([singleFrame(Uint8Array.of(0), 1, 1, 123)], { loop: 0 })
    expect(readU16(gif, FIRST_IMAGE_OFFSET + 4)).toBe(12)
  })

  it('keeps one graphic control extension per frame with its own delay', () => {
    const gif = encodeGif([
      singleFrame(Uint8Array.of(0, 0, 0, 0), 2, 2, 40),
      singleFrame(Uint8Array.of(1, 1, 1, 1), 2, 2, 250),
    ])
    const decoded = decodeGif(gif)
    expect(decoded.frames).toHaveLength(2)
    expect(decoded.frames.map((frame) => frame.delay)).toEqual([4, 25])
    expect(decoded.frames[0]!.indices).toEqual([0, 0, 0, 0])
    expect(decoded.frames[1]!.indices).toEqual([1, 1, 1, 1])
  })

  it('round-trips a frame that grows the LZW code width', () => {
    const width = 96
    const height = 64
    const indices = new Uint8Array(width * height)
    // Deterministic pseudo-random pattern with long repeats: exercises dictionary
    // growth, a full table, and code-width bumps in one pass.
    let state = 7
    for (let index = 0; index < indices.length; index += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff
      indices[index] = ((state >> 16) & 0xff) & (index % 17 === 0 ? 0x0f : 0xff)
    }
    const gif = encodeGif([singleFrame(indices, width, height)])
    const decoded = decodeGif(gif)
    expect(decoded.width).toBe(width)
    expect(decoded.height).toBe(height)
    expect(decoded.frames[0]!.indices).toEqual(Array.from(indices))
  })
})

describe('palette quantization', () => {
  it('maps the color cube corners and grayscale ramp to fixed indices', () => {
    expect(GIF_PALETTE).toHaveLength(256)
    expect(quantizeFrame(Uint8Array.of(0, 0, 0, 255), 1, 1)[0]).toBe(0)
    expect(quantizeFrame(Uint8Array.of(255, 0, 0, 255), 1, 1)[0]).toBe(180)
    expect(quantizeFrame(Uint8Array.of(0, 255, 0, 255), 1, 1)[0]).toBe(30)
    expect(quantizeFrame(Uint8Array.of(0, 0, 255, 255), 1, 1)[0]).toBe(5)
    expect(quantizeFrame(Uint8Array.of(255, 255, 255, 255), 1, 1)[0]).toBe(215)
  })

  it('keeps every index inside the 256-entry palette', () => {
    const rgba = new Uint8Array(4 * 256)
    for (let pixel = 0; pixel < 256; pixel += 1) {
      rgba[pixel * 4] = pixel
      rgba[pixel * 4 + 1] = 255 - pixel
      rgba[pixel * 4 + 2] = (pixel * 7) & 0xff
      rgba[pixel * 4 + 3] = 255
    }
    const indices = quantizeFrame(rgba, 16, 16)
    expect(indices).toHaveLength(256)
    for (const index of indices) {
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(GIF_PALETTE.length)
    }
  })

  it('composites translucent pixels over white before quantizing', () => {
    // 50% black over white is mid gray, so it must pick a gray, not pure black.
    const [index] = quantizeFrame(Uint8Array.of(0, 0, 0, 128), 1, 1)
    const color = GIF_PALETTE[index!]!
    expect(color[0]).toBeGreaterThan(100)
    expect(color[0]).toBeLessThan(160)
    expect(color[0]).toBe(color[1])
  })

  it('rejects a buffer that does not hold the declared pixels', () => {
    expect(() => quantizeFrame(new Uint8Array(3), 2, 2)).toThrow(/RGBA buffer/)
  })
})

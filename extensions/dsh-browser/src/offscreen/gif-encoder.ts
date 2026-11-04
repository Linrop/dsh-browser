/**
 * Minimal GIF89a encoder for recorded browser frames.
 *
 * The encoder is dependency-free and pure: callers hand it RGBA pixels (or
 * already-quantized indices) and receive the bytes of one animated GIF. The
 * palette is fixed and shared by every frame, so an animation never pays for a
 * local color table and playback never flickers between palettes.
 *
 * Palette (256 entries): a 6×6×6 color cube (216 entries, levels
 * 0/51/102/153/204/255 for each channel) followed by a 40-step grayscale ramp.
 * The cube keeps chroma roughly uniform, and the ramp prevents photographic
 * frames from banding into the nearest cube corners.
 *
 * GIF has no alpha channel, so translucent pixels are composited over white
 * before quantization. Frames must share one size; a mismatch is a caller bug
 * (the recorder captures a fixed viewport) and throws instead of silently
 * cropping.
 *
 * @module
 */

/** One RGB palette entry. */
export type GifColor = readonly [red: number, green: number, blue: number]

/** Color-cube levels: six evenly spaced values per channel. */
const CUBE_LEVELS = [0, 51, 102, 153, 204, 255] as const
/** Grayscale steps appended after the cube; 216 + 40 = 256. */
const GRAY_STEPS = 40

/** The fixed 256-entry palette shared by every frame. */
export const GIF_PALETTE: readonly GifColor[] = buildPalette()

function buildPalette(): GifColor[] {
  const palette: GifColor[] = []
  for (const red of CUBE_LEVELS) {
    for (const green of CUBE_LEVELS) {
      for (const blue of CUBE_LEVELS) palette.push([red, green, blue] as const)
    }
  }
  for (let step = 0; step < GRAY_STEPS; step += 1) {
    const level = Math.round((step * 255) / (GRAY_STEPS - 1))
    palette.push([level, level, level] as const)
  }
  /* 216 cube entries plus 40 grays is exactly the 256 a GCT can hold. */
  if (palette.length !== 256) throw new Error(`GIF palette has ${palette.length} entries, expected 256`)
  return palette
}

/** One frame ready for encoding. */
export interface GifFrameInput {
  /** One palette index per pixel, row-major. */
  indices: Uint8Array
  width: number
  height: number
  /** Display duration in milliseconds; GIF stores hundredths of a second. */
  delayMs: number
}

/** Playback options for {@link encodeGif}. */
export interface GifEncodeOptions {
  /**
   * NETSCAPE loop count: `0` repeats forever (the default), `n` plays `n`
   * extra times after the first pass.
   */
  loop?: number
}

const HEADER = 'GIF89a'
/** GCT present, color resolution 8 bit, GCT size 2^8 = 256. */
const LOGICAL_SCREEN_PACKED = 0xf7
const EXTENSION_INTRODUCER = 0x21
const GRAPHIC_CONTROL_LABEL = 0xf9
const APPLICATION_LABEL = 0xff
const IMAGE_SEPARATOR = 0x2c
const TRAILER = 0x3b
/** Disposal method 1 ("do not dispose") with no transparency. */
const GRAPHIC_CONTROL_PACKED = 0x04
/** 8-bit indices: LZW minimum code size for a 256-entry palette. */
const LZW_MIN_CODE_SIZE = 8
const MAX_DIMENSION = 0xffff

/** Round a duration to the GIF's 1/100 s unit, clamped to the wire field. */
export function delayCentiseconds(delayMs: number): number {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 0
  return Math.min(0xffff, Math.round(delayMs / 10))
}

/** Reusable nearest-color cache: one slot per 5-bit-per-channel bucket. */
let nearestCache: Int16Array | null = null

function nearestPaletteIndex(red: number, green: number, blue: number): number {
  const cache = nearestCache ?? (nearestCache = new Int16Array(32 * 32 * 32).fill(-1))
  const key = ((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3)
  const cached = cache[key]!
  if (cached >= 0) return cached
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < GIF_PALETTE.length; index += 1) {
    const color = GIF_PALETTE[index]!
    const dr = color[0] - red
    const dg = color[1] - green
    const db = color[2] - blue
    const distance = dr * dr + dg * dg + db * db
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
      if (distance === 0) break
    }
  }
  cache[key] = best
  return best
}

/**
 * Quantize one RGBA frame to palette indices.
 * @param rgba - `width * height * 4` bytes, alpha composited over white.
 * @param width - frame width in pixels.
 * @param height - frame height in pixels.
 * @returns one index per pixel, row-major.
 */
export function quantizeFrame(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  assertDimensions(width, height)
  const pixels = width * height
  if (rgba.length < pixels * 4) {
    throw new Error(`RGBA buffer holds ${rgba.length} bytes, expected ${pixels * 4}`)
  }
  const indices = new Uint8Array(pixels)
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const offset = pixel * 4
    const alpha = rgba[offset + 3]! / 255
    const red = Math.round(rgba[offset]! * alpha + 255 * (1 - alpha))
    const green = Math.round(rgba[offset + 1]! * alpha + 255 * (1 - alpha))
    const blue = Math.round(rgba[offset + 2]! * alpha + 255 * (1 - alpha))
    indices[pixel] = nearestPaletteIndex(red, green, blue)
  }
  return indices
}

/**
 * Encode frames into one animated GIF89a.
 * @param frames - frames in playback order; every frame shares one size.
 * @param options - loop count (default: loop forever).
 * @returns the complete GIF file bytes.
 */
export function encodeGif(frames: readonly GifFrameInput[], options: GifEncodeOptions = {}): Uint8Array {
  if (frames.length === 0) throw new Error('A GIF needs at least one frame')
  const first = frames[0]!
  assertDimensions(first.width, first.height)
  for (const frame of frames) {
    if (frame.width !== first.width || frame.height !== first.height) {
      throw new Error(`All frames must share one size: ${frame.width}×${frame.height} differs from ${first.width}×${first.height}`)
    }
    if (frame.indices.length !== frame.width * frame.height) {
      throw new Error(`Frame has ${frame.indices.length} indices for ${frame.width}×${frame.height} pixels`)
    }
  }

  const parts: Uint8Array[] = []
  parts.push(ascii(HEADER))
  parts.push(logicalScreenDescriptor(first.width, first.height))
  parts.push(globalColorTable())
  parts.push(netscapeLoop(options.loop ?? 0))
  for (const frame of frames) {
    parts.push(graphicControlExtension(frame.delayMs))
    parts.push(imageDescriptor(frame.width, frame.height))
    parts.push(lzwImageData(frame.indices))
  }
  parts.push(Uint8Array.of(TRAILER))
  return concat(parts)
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid frame size ${width}×${height}`)
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(`Frame size ${width}×${height} exceeds the GIF limit of ${MAX_DIMENSION}`)
  }
}

function ascii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index)
  return bytes
}

function u16(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >> 8) & 0xff)
}

function logicalScreenDescriptor(width: number, height: number): Uint8Array {
  return concat([u16(width), u16(height), Uint8Array.of(LOGICAL_SCREEN_PACKED, 0, 0)])
}

function globalColorTable(): Uint8Array {
  const table = new Uint8Array(768)
  for (let index = 0; index < 256; index += 1) {
    const color = GIF_PALETTE[index]!
    table[index * 3] = color[0]
    table[index * 3 + 1] = color[1]
    table[index * 3 + 2] = color[2]
  }
  return table
}

/** NETSCAPE2.0 application extension: repeat count for the whole animation. */
function netscapeLoop(loop: number): Uint8Array {
  const count = Math.max(0, Math.min(0xffff, Math.trunc(loop)))
  return concat([
    Uint8Array.of(EXTENSION_INTRODUCER, APPLICATION_LABEL, 0x0b),
    ascii('NETSCAPE2.0'),
    Uint8Array.of(0x03, 0x01),
    u16(count),
    Uint8Array.of(0x00),
  ])
}

function graphicControlExtension(delayMs: number): Uint8Array {
  const delay = delayCentiseconds(delayMs)
  return concat([
    Uint8Array.of(EXTENSION_INTRODUCER, GRAPHIC_CONTROL_LABEL, 0x04, GRAPHIC_CONTROL_PACKED),
    u16(delay),
    Uint8Array.of(0x00, 0x00),
  ])
}

function imageDescriptor(width: number, height: number): Uint8Array {
  return concat([
    Uint8Array.of(IMAGE_SEPARATOR),
    u16(0),
    u16(0),
    u16(width),
    u16(height),
    Uint8Array.of(0x00),
  ])
}

/** LZW-compressed pixel indices, wrapped in GIF data sub-blocks. */
function lzwImageData(indices: Uint8Array): Uint8Array {
  const codes = lzwEncode(indices)
  const blocks: Uint8Array[] = [Uint8Array.of(LZW_MIN_CODE_SIZE)]
  for (let offset = 0; offset < codes.length; offset += 255) {
    const chunk = codes.subarray(offset, Math.min(offset + 255, codes.length))
    blocks.push(Uint8Array.of(chunk.length), chunk)
  }
  blocks.push(Uint8Array.of(0x00))
  return concat(blocks)
}

/**
 * GIF LZW with a 9-bit starting code width.
 *
 * Codes are emitted least-significant bit first. A full dictionary (4096
 * entries) emits a clear code and restarts, which keeps long flat runs finite
 * and is what every decoder expects.
 */
function lzwEncode(indices: Uint8Array): Uint8Array {
  const clearCode = 1 << LZW_MIN_CODE_SIZE
  const endCode = clearCode + 1
  /** Key: `(prefixCode << 8) | nextIndex`. */
  const dictionary = new Map<number, number>()
  const bytes: number[] = []
  let bitBuffer = 0
  let bitCount = 0
  let codeSize = LZW_MIN_CODE_SIZE + 1
  let nextCode = endCode + 1

  const writeCode = (code: number): void => {
    bitBuffer |= code << bitCount
    bitCount += codeSize
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 0xff)
      bitBuffer >>= 8
      bitCount -= 8
    }
  }

  writeCode(clearCode)
  if (indices.length === 0) {
    writeCode(endCode)
  } else {
    let prefix = indices[0]!
    for (let position = 1; position < indices.length; position += 1) {
      const next = indices[position]!
      const key = (prefix << 8) | next
      const known = dictionary.get(key)
      if (known !== undefined) {
        prefix = known
        continue
      }
      writeCode(prefix)
      if (nextCode < 4096) {
        dictionary.set(key, nextCode)
        nextCode += 1
        // A decoder installs the same entry one emitted code later, so the
        // width grows one code after the table would otherwise demand it.
        if (nextCode === (1 << codeSize) + 1 && codeSize < 12) codeSize += 1
      } else {
        writeCode(clearCode)
        dictionary.clear()
        nextCode = endCode + 1
        codeSize = LZW_MIN_CODE_SIZE + 1
      }
      prefix = next
    }
    writeCode(prefix)
    writeCode(endCode)
  }
  if (bitCount > 0) bytes.push(bitBuffer & 0xff)
  return Uint8Array.from(bytes)
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

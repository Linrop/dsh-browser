// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  ScreenshotPlanError,
  SCREENSHOT_MAX_OUTPUT_PIXELS,
  SCREENSHOT_MAX_SIDE,
  planScreenshot,
  type ScreenshotViewport,
} from '../src/background/screenshot-plan.ts'

const viewport: ScreenshotViewport = {
  width: 1024,
  height: 768,
  dpr: 2,
  scrollX: 10,
  scrollY: 20,
}

function failure(call: () => unknown): ScreenshotPlanError {
  try {
    call()
  } catch (error: unknown) {
    if (error instanceof ScreenshotPlanError) return error
    throw error
  }
  throw new Error('the plan was expected to fail')
}

describe('screenshot planning', () => {
  it('defaults a clip to scale 2 and rounds it to whole pixels', () => {
    const plan = planScreenshot(viewport, {
      format: 'jpeg',
      clip: { x: 10.4, y: 20.6, width: 99.5, height: 49.5 },
      quality: 80,
    })
    expect(plan.scale).toBe(2)
    expect(plan.clip).toEqual({ x: 10, y: 21, width: 100, height: 50 })
    expect(plan.params.clip).toEqual({ x: 20, y: 41, width: 100, height: 50, scale: 2 })
    expect(plan.width).toBe(400)
    expect(plan.height).toBe(200)
    expect(plan.params).toMatchObject({ format: 'jpeg', captureBeyondViewport: false, fromSurface: true })
  })

  it('rejects a negative origin with the rejected rectangle', () => {
    const error = failure(() => planScreenshot(viewport, {
      format: 'jpeg',
      clip: { x: -1, y: 0, width: 10, height: 10 },
      quality: 80,
    }))
    expect(error.code).toBe('bad-args')
    expect(error.message).toContain('must not start outside the viewport')
    expect(error.message).toContain('10x10 at (-1, 0)')
  })

  it('rejects a zero or negative extent', () => {
    const error = failure(() => planScreenshot(viewport, {
      format: 'jpeg',
      clip: { x: 10, y: 10, width: 0, height: 10 },
      quality: 80,
    }))
    expect(error.message).toContain('must be at least 1x1 pixel')
  })

  it('rejects a clip past the real viewport and echoes its size', () => {
    const error = failure(() => planScreenshot(viewport, {
      format: 'jpeg',
      clip: { x: 1000, y: 0, width: 100, height: 100 },
      quality: 80,
    }))
    expect(error.message).toContain('must stay inside the 1024x768 viewport')
    expect(error.message).toContain('100x100 at (1000, 0)')
    expect(error.message).toContain('right 1100')
  })

  it('rejects a side above the 8192-pixel limit with the actual size', () => {
    const wide: ScreenshotViewport = { ...viewport, width: 9000, height: 100 }
    const error = failure(() => planScreenshot(wide, { format: 'png', quality: 80 }))
    expect(error.message).toContain(`over the ${SCREENSHOT_MAX_SIDE}-pixel side limit`)
    expect(error.message).toContain('would be 9000x100 pixels')
  })

  it('rejects a total above the 4,194,304-pixel limit with the actual size', () => {
    const large: ScreenshotViewport = { ...viewport, width: 3000, height: 2000 }
    const error = failure(() => planScreenshot(large, { format: 'png', quality: 80 }))
    expect(SCREENSHOT_MAX_OUTPUT_PIXELS).toBe(4_194_304)
    expect(error.message).toContain('would be 6000000 pixels')
    expect(error.message).toContain('over the 4194304-pixel output limit')
  })

  it('rejects a scale outside 1, 2, or 3', () => {
    for (const scale of [0, 1.5, 4]) {
      const error = failure(() => planScreenshot(viewport, { format: 'jpeg', scale, quality: 80 }))
      expect(error.message).toContain('scale must be 1, 2, or 3')
      expect(error.message).toContain(String(scale))
    }
  })

  it('scales the whole viewport when asked without a clip', () => {
    const plan = planScreenshot(viewport, { format: 'png', scale: 2, quality: 80 })
    expect(plan.params.clip).toEqual({ x: 10, y: 20, width: 1024, height: 768, scale: 2 })
    expect(plan.width).toBe(4096)
    expect(plan.height).toBe(3072)
  })
})

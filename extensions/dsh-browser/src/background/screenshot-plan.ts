/**
 * Screenshot planning: the one place that turns a `browser_screenshot`
 * request into `Page.captureScreenshot` parameters and the encoded pixel size.
 *
 * The clip is rounded to whole CSS pixels, checked against the real viewport,
 * and bounded before anything is encoded: an out-of-range request reports the
 * viewport it missed instead of being silently clamped to a different image.
 * The output limits apply to the CSS-pixel render (clip size times scale), so a
 * full-viewport capture at scale 1 stays valid on a high-DPI display; the
 * reported image size additionally includes the device pixel ratio.
 *
 * @module
 */

/** Encoded image formats the tool can request from CDP. */
export type ScreenshotFormat = 'jpeg' | 'png'

/** Longest encoded side CDP renders in one capture, in CSS pixels before DPR. */
export const SCREENSHOT_MAX_SIDE = 8_192

/** Matches the bridge's own normalized-image budget: 2048 * 2048 pixels. */
export const SCREENSHOT_MAX_OUTPUT_PIXELS = 2048 * 2048

/** Scale a clip-only request renders at: a crop is a detail view. */
export const SCREENSHOT_DEFAULT_CLIP_SCALE = 2

/** A rectangular crop in viewport CSS pixels. */
export interface ScreenshotClip {
  x: number
  y: number
  width: number
  height: number
}

/** The current page viewport, in CSS pixels, plus its device pixel ratio. */
export interface ScreenshotViewport {
  width: number
  height: number
  dpr: number
  scrollX: number
  scrollY: number
}

/** A screenshot request before planning. */
export interface ScreenshotRequest {
  format: ScreenshotFormat
  clip?: ScreenshotClip
  scale?: number
  /** JPEG quality, 1-100; ignored for PNG. */
  quality: number
}

/** One planned capture: protocol parameters plus the size of the encoded image. */
export interface ScreenshotPlan {
  /** Parameters for `Page.captureScreenshot`, including the scroll offset. */
  params: Record<string, unknown>
  mimeType: 'image/jpeg' | 'image/png'
  /** Encoded width in device pixels. */
  width: number
  /** Encoded height in device pixels. */
  height: number
  /** Scale the capture renders at. */
  scale: number
  /** Viewport region the plan rendered, already rounded to whole pixels. */
  clip?: ScreenshotClip
}

/** A screenshot request the current viewport cannot honour. */
export class ScreenshotPlanError extends Error {
  readonly code = 'bad-args'

  constructor(message: string) {
    super(message)
    this.name = 'ScreenshotPlanError'
  }
}

/** Describe one rectangle the way the request supplied it. */
function describeClip(clip: ScreenshotClip): string {
  return `${clip.width}x${clip.height} at (${clip.x}, ${clip.y})`
}

/** Round every edge to a whole CSS pixel. */
function roundClip(clip: ScreenshotClip): ScreenshotClip {
  return {
    x: Math.round(clip.x),
    y: Math.round(clip.y),
    width: Math.round(clip.width),
    height: Math.round(clip.height),
  }
}

/**
 * Reject a scale outside the three supported render multiples.
 * @param scale - the requested scale.
 */
function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 1 || scale > 3) {
    throw new ScreenshotPlanError(`screenshot scale must be 1, 2, or 3; received ${scale}`)
  }
}

/**
 * Reject a clip CDP could not honour: an origin outside the viewport or an
 * extent below one pixel.
 * @param clip - the rounded clip.
 */
function assertClip(clip: ScreenshotClip): void {
  if (clip.x < 0 || clip.y < 0) {
    throw new ScreenshotPlanError(`screenshot clip must not start outside the viewport; received ${describeClip(clip)}`)
  }
  if (clip.width < 1 || clip.height < 1) {
    throw new ScreenshotPlanError(`screenshot clip must be at least 1x1 pixel; received ${describeClip(clip)}`)
  }
}

/**
 * Reject a clip that reaches past the viewport.
 *
 * The message names the real viewport and the rejected rectangle, so a caller
 * can correct the request without another round trip to measure the page.
 * @param clip - the rounded clip.
 * @param viewport - the viewport the capture renders.
 */
function assertInside(clip: ScreenshotClip, viewport: ScreenshotViewport): void {
  const right = clip.x + clip.width
  const bottom = clip.y + clip.height
  if (right > viewport.width || bottom > viewport.height) {
    throw new ScreenshotPlanError(
      `screenshot clip must stay inside the ${viewport.width}x${viewport.height} viewport; received ${describeClip(clip)} (right ${right}, bottom ${bottom})`,
    )
  }
}

/**
 * Reject a capture whose rendered CSS size would be unusable.
 * @param width - base width in CSS pixels before scaling.
 * @param height - base height in CSS pixels before scaling.
 * @param scale - render multiple.
 */
function assertOutputSize(width: number, height: number, scale: number): void {
  const renderedWidth = width * scale
  const renderedHeight = height * scale
  if (renderedWidth > SCREENSHOT_MAX_SIDE || renderedHeight > SCREENSHOT_MAX_SIDE) {
    throw new ScreenshotPlanError(
      `a ${width}x${height} screenshot at scale ${scale} would be ${renderedWidth}x${renderedHeight} pixels, over the ${SCREENSHOT_MAX_SIDE}-pixel side limit; lower the scale or shrink the clip`,
    )
  }
  const pixels = renderedWidth * renderedHeight
  if (pixels > SCREENSHOT_MAX_OUTPUT_PIXELS) {
    throw new ScreenshotPlanError(
      `a ${width}x${height} screenshot at scale ${scale} would be ${pixels} pixels, over the ${SCREENSHOT_MAX_OUTPUT_PIXELS}-pixel output limit; lower the scale or shrink the clip`,
    )
  }
}

/**
 * Plan one screenshot capture. Pure: the same viewport and request always
 * produce the same plan, and nothing here reads configuration or the clock.
 * @param viewport - the page's CSS-pixel viewport, scroll offset, and DPR.
 * @param request - format, optional clip, optional scale, and JPEG quality.
 * @returns the CDP parameters, media type, and encoded pixel size.
 * @throws ScreenshotPlanError when the clip, scale, or resulting size cannot be honoured.
 */
export function planScreenshot(viewport: ScreenshotViewport, request: ScreenshotRequest): ScreenshotPlan {
  const clip = request.clip === undefined ? undefined : roundClip(request.clip)
  if (clip !== undefined) assertClip(clip)
  if (request.scale !== undefined) assertScale(request.scale)
  const scale = request.scale ?? (clip === undefined ? 1 : SCREENSHOT_DEFAULT_CLIP_SCALE)
  if (clip !== undefined) assertInside(clip, viewport)
  const baseWidth = clip === undefined ? viewport.width : clip.width
  const baseHeight = clip === undefined ? viewport.height : clip.height
  assertOutputSize(baseWidth, baseHeight, scale)

  const dpr = Number.isFinite(viewport.dpr) && viewport.dpr > 0 ? viewport.dpr : 1
  const params: Record<string, unknown> = {
    format: request.format,
    fromSurface: true,
    captureBeyondViewport: false,
  }
  if (request.format === 'jpeg') params.quality = request.quality
  // Always clip to the visible viewport: the scroll offset keeps the capture
  // aligned with what the page shows, and `captureBeyondViewport` stays false.
  params.clip = clip === undefined
    ? { x: viewport.scrollX, y: viewport.scrollY, width: viewport.width, height: viewport.height, scale }
    : {
        x: viewport.scrollX + clip.x,
        y: viewport.scrollY + clip.y,
        width: clip.width,
        height: clip.height,
        scale,
      }
  return {
    params,
    mimeType: request.format === 'png' ? 'image/png' : 'image/jpeg',
    width: Math.max(1, Math.round(baseWidth * scale * dpr)),
    height: Math.max(1, Math.round(baseHeight * scale * dpr)),
    scale,
    ...(clip === undefined ? {} : { clip }),
  }
}

/**
 * Round and validate a clip's own geometry, without a viewport.
 *
 * Callers use this before any capture work so an empty rectangle or an origin
 * outside the page fails as `bad-args` at the earliest point.
 * @param clip - the requested rectangle in viewport CSS pixels.
 * @returns the rounded clip.
 * @throws ScreenshotPlanError when the origin is negative or an extent is below one pixel.
 */
export function validateScreenshotClip(clip: ScreenshotClip): ScreenshotClip {
  const rounded = roundClip(clip)
  assertClip(rounded)
  return rounded
}

/**
 * Turn the tool's `region` argument into a clip.
 * @param region - `[x0, y0, x1, y1]` in viewport CSS pixels.
 * @returns the clip; edges may be fractional and are rounded by the plan.
 */
export function clipFromRegion(region: readonly [number, number, number, number]): ScreenshotClip {
  const [x0, y0, x1, y1] = region
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

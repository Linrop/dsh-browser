/**
 * Write a screenshot captured by the extension into the artifact workspace.
 *
 * The extension returns the image inline (`image.base64`) because the bridge is
 * text-only. The host decodes it once and stores it under
 * `<workspaceRoot>/screenshots/`, so the model receives a path it can pass to
 * `read_image` instead of an image block. The directory is the same artifact
 * root the retention sweep owns: every file written here carries an extension
 * from {@link ARTIFACT_EXTENSIONS}, and the resolved root must pass
 * {@link assertArtifactRoot} before anything is created.
 *
 * @module @yuxianglin/dsh-bridge-browser/src/screenshot-artifact
 */

import { randomBytes } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ARTIFACT_EXTENSIONS, assertArtifactRoot, assertArtifactRootCandidate, isArtifactPath } from './artifact-budget.ts'

/** Subdirectory of the artifact workspace that owns screenshot files. */
export const SCREENSHOT_DIRECTORY = 'screenshots'

/** File extension per accepted screenshot MIME type; every entry is an artifact extension. */
const MIME_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
])

/** Image bytes the extension captured, as the wire result carries them. */
export interface ScreenshotImage {
  /** Base64 (not a data URL) of the encoded image. */
  base64: string
  /** `image/jpeg` or `image/png`. */
  mimeType: string
  /** Encoded pixel width. */
  width: number
  /** Encoded pixel height. */
  height: number
}

/** Where and how one screenshot is stored. */
export interface ScreenshotSaveOptions {
  /** Artifact workspace root; `screenshots/` is created below it. */
  workspaceRoot: string
  /** Deletion boundary used by the sweep; empty falls back to the workspace root. */
  boundary?: string
  /** Capture timestamp recorded in the file name; defaults to `Date.now()`. */
  now?: number
}

/** One stored screenshot. */
export interface SavedScreenshot {
  /** Absolute path of the written file. */
  path: string
  /** Bytes written. */
  byteLength: number
  /** Format derived from the MIME type. */
  format: 'jpg' | 'png'
}

/**
 * Decode one screenshot and write it below `<workspaceRoot>/screenshots/`.
 *
 * The configuration is proven safe before anything is created, so a refused
 * root leaves no empty directory behind: the candidate is resolved through its
 * existing ancestors and checked against the boundary first, then created, then
 * proven again with {@link assertArtifactRoot}. The `screenshots` directory is
 * resolved and must still sit inside the root, so a pre-existing symlink cannot
 * redirect the write outside it. Names are `shot-<epochMs>-<6 hex>.<ext>` with
 * `wx` create semantics, so a captured image never overwrites an earlier one.
 *
 * @param image - image bytes and dimensions reported by the extension.
 * @param options - workspace root, optional boundary, capture time.
 * @returns the absolute path, byte count, and format of the stored file.
 * @throws Error when the root, MIME type, payload, or directory resolution is unusable.
 */
export async function saveScreenshotImage(
  image: ScreenshotImage,
  options: ScreenshotSaveOptions,
): Promise<SavedScreenshot> {
  const extension = MIME_EXTENSIONS.get(image.mimeType.trim().toLowerCase())
  if (extension === undefined) {
    throw new Error(
      `browser_screenshot: unsupported image type "${image.mimeType}" (expected image/jpeg or image/png)`,
    )
  }
  if (options.workspaceRoot.trim() === '') {
    throw new Error(
      'browser_screenshot: no screenshot directory is configured (set sessionWorkspacePath or artifactRoot)',
    )
  }
  const bytes = Buffer.from(image.base64, 'base64')
  if (bytes.byteLength === 0) {
    throw new Error('browser_screenshot: the extension returned an empty image payload')
  }
  // Writing owns no deletion, so an unconfigured boundary falls back to the
  // workspace root itself; the sweep keeps its stricter refusal.
  const boundary = options.boundary !== undefined && options.boundary.trim() !== ''
    ? options.boundary
    : options.workspaceRoot
  const candidate = await assertArtifactRootCandidate(options.workspaceRoot, boundary)
  await mkdir(candidate, { recursive: true })
  const root = await assertArtifactRoot(options.workspaceRoot, boundary)
  const directory = path.join(root, SCREENSHOT_DIRECTORY)
  await mkdir(directory, { recursive: true })
  const resolvedDirectory = await realpath(directory)
  if (resolvedDirectory !== directory && !resolvedDirectory.startsWith(`${root}${path.sep}`)) {
    throw new Error(
      `browser_screenshot: screenshot directory "${resolvedDirectory}" escapes the artifact root "${root}"`,
    )
  }
  const name = `shot-${Math.floor(options.now ?? Date.now())}-${randomBytes(3).toString('hex')}${extension}`
  const file = path.join(resolvedDirectory, name)
  if (!isArtifactPath(file) || !ARTIFACT_EXTENSIONS.has(extension)) {
    throw new Error(`browser_screenshot: refusing to write "${file}" outside the artifact extension set`)
  }
  await writeFile(file, bytes, { flag: 'wx' })
  return { path: file, byteLength: bytes.byteLength, format: extension === '.png' ? 'png' : 'jpg' }
}

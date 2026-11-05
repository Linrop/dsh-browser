/**
 * Store a printed page as a PDF in the artifact workspace.
 *
 * The extension returns the printed document inline (`pdf.base64`) because the
 * bridge is text-only. The host decodes it once and writes it below
 * `<artifactRoot>/pdf/`, so the model receives a path it can hand to a reader
 * instead of megabytes of base64 inside the conversation. The write follows the
 * same rules as screenshots: the root is proven before anything is created, the
 * `pdf` directory must resolve inside it, and names are created with `wx` so a
 * print never overwrites an earlier one.
 *
 * @module @yuxianglin/dsh-bridge-browser/src/pdf-artifact
 */

import { randomBytes } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { assertArtifactRoot, assertArtifactRootCandidate, isArtifactPath } from './artifact-budget.ts'

/** Subdirectory of the artifact workspace that owns printed pages. */
export const PDF_DIRECTORY = 'pdf'

/** Extension every printed page carries; must stay inside the artifact set. */
const PDF_EXTENSION = '.pdf'

/**
 * Decoded byte budget for one print. The extension caps its base64 payload at
 * 8 MiB; checking the decoded bytes here keeps a stale or third-party extension
 * from writing an unbounded file through a newer bridge.
 */
export const MAX_PDF_BYTES = 8 * 1024 * 1024

/** Where and when one print is stored. */
export interface PdfSaveOptions {
  /** Artifact workspace root; `pdf/` is created below it. */
  workspaceRoot: string
  /** Deletion boundary used by the sweep; empty falls back to the workspace root. */
  boundary?: string
  /** Print timestamp recorded in the file name; defaults to `Date.now()`. */
  now?: number
}

/** One stored printed page. */
export interface SavedPdf {
  /** Absolute path of the written file. */
  path: string
  /** Bytes written. */
  byteLength: number
}

/**
 * Decode one printed page and write it below `<artifactRoot>/pdf/`.
 *
 * @param base64 - PDF bytes as base64, exactly as the extension sent them.
 * @param options - artifact root, optional boundary, print time.
 * @returns the absolute path and byte count of the stored file.
 * @throws Error when the root, payload, or directory resolution is unusable.
 */
export async function savePdf(base64: string, options: PdfSaveOptions): Promise<SavedPdf> {
  if (typeof base64 !== 'string' || base64.trim() === '') {
    throw new Error('browser_pdf: the extension returned an empty PDF payload')
  }
  if (options.workspaceRoot.trim() === '') {
    throw new Error('browser_pdf: no artifact directory is configured (set sessionWorkspacePath or artifactRoot)')
  }
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.byteLength === 0) {
    throw new Error('browser_pdf: the extension returned an empty PDF payload')
  }
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new Error(
      `browser_pdf: the printed PDF is ${bytes.byteLength} bytes, above the ${MAX_PDF_BYTES} byte PDF budget`,
    )
  }
  // Writing owns no deletion, so an unconfigured boundary falls back to the
  // workspace root itself; the sweep keeps its stricter refusal.
  const boundary = options.boundary !== undefined && options.boundary.trim() !== ''
    ? options.boundary
    : options.workspaceRoot
  const candidate = await assertArtifactRootCandidate(options.workspaceRoot, boundary)
  await mkdir(candidate, { recursive: true })
  const root = await assertArtifactRoot(options.workspaceRoot, boundary)
  const directory = path.join(root, PDF_DIRECTORY)
  await mkdir(directory, { recursive: true })
  const resolvedDirectory = await realpath(directory)
  if (resolvedDirectory !== directory && !resolvedDirectory.startsWith(`${root}${path.sep}`)) {
    throw new Error(`browser_pdf: print directory "${resolvedDirectory}" escapes the artifact root "${root}"`)
  }
  const name = `page-${Math.floor(options.now ?? Date.now())}-${randomBytes(3).toString('hex')}${PDF_EXTENSION}`
  const file = path.join(resolvedDirectory, name)
  if (!isArtifactPath(file)) {
    throw new Error(`browser_pdf: refusing to write "${file}" outside the artifact extension set`)
  }
  await writeFile(file, bytes, { flag: 'wx' })
  return { path: file, byteLength: bytes.byteLength }
}

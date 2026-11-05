import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PDF_DIRECTORY, savePdf } from '../src/pdf-artifact.ts'

const PDF_BYTES = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')

describe('savePdf', () => {
  it('rejects an empty payload and an unconfigured workspace', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bridge-pdf-artifact-'))
    try {
      await expect(savePdf('', { workspaceRoot: root, boundary: root }))
        .rejects.toThrow(/empty PDF payload/)
      await expect(savePdf('   ', { workspaceRoot: root, boundary: root }))
        .rejects.toThrow(/empty PDF payload/)
      await expect(savePdf(PDF_BYTES.toString('base64'), { workspaceRoot: '', boundary: root }))
        .rejects.toThrow(/no artifact directory is configured/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a payload above the decoded byte budget', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bridge-pdf-artifact-'))
    try {
      const oversized = Buffer.alloc(9 * 1024 * 1024, 1).toString('base64')
      await expect(savePdf(oversized, { workspaceRoot: root, boundary: root }))
        .rejects.toThrow(/above the .* PDF budget/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a root outside the boundary without creating any directory', async () => {
    const boundaryRoot = await mkdtemp(path.join(tmpdir(), 'bridge-pdf-boundary-'))
    const targetParent = await mkdtemp(path.join(tmpdir(), 'bridge-pdf-target-'))
    try {
      const workspaceRoot = path.join(targetParent, 'nested', 'pdf-workspace')
      await expect(savePdf(PDF_BYTES.toString('base64'), { workspaceRoot, boundary: boundaryRoot }))
        .rejects.toThrow(/is outside the artifact boundary/)
      // Validation runs before `mkdir`, so the refused configuration leaves no residue.
      await expect(realpath(workspaceRoot)).rejects.toThrow()
      await expect(realpath(path.join(targetParent, 'nested'))).rejects.toThrow()
    } finally {
      await rm(boundaryRoot, { recursive: true, force: true })
      await rm(targetParent, { recursive: true, force: true })
    }
  })

  it('writes inside the resolved pdf directory and never overwrites', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bridge-pdf-artifact-'))
    try {
      const resolvedRoot = await realpath(root)
      const first = await savePdf(PDF_BYTES.toString('base64'), { workspaceRoot: root, boundary: root, now: 2_000 })
      const second = await savePdf(PDF_BYTES.toString('base64'), { workspaceRoot: root, boundary: root, now: 2_000 })
      expect(first.path.startsWith(path.join(resolvedRoot, PDF_DIRECTORY) + path.sep)).toBe(true)
      expect(first.path).toMatch(/page-2000-[0-9a-f]{6}\.pdf$/)
      expect(second.path).not.toBe(first.path)
      expect(first.byteLength).toBe(PDF_BYTES.byteLength)
      expect(await readFile(first.path)).toEqual(PDF_BYTES)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

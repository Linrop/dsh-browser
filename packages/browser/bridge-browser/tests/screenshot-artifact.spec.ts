import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { saveScreenshotImage } from '../src/screenshot-artifact.ts'

describe('saveScreenshotImage', () => {
  it('rejects an unsupported image type before touching the workspace', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bridge-shot-artifact-'))
    try {
      await expect(saveScreenshotImage(
        { base64: Buffer.from('gif').toString('base64'), mimeType: 'image/gif', width: 1, height: 1 },
        { workspaceRoot: root, boundary: root },
      )).rejects.toThrow(/unsupported image type "image\/gif"/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an empty payload and an unconfigured workspace', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bridge-shot-artifact-'))
    try {
      await expect(saveScreenshotImage(
        { base64: '', mimeType: 'image/png', width: 1, height: 1 },
        { workspaceRoot: root, boundary: root },
      )).rejects.toThrow(/empty image payload/)
      await expect(saveScreenshotImage(
        { base64: Buffer.from('png').toString('base64'), mimeType: 'image/png', width: 1, height: 1 },
        { workspaceRoot: '', boundary: root },
      )).rejects.toThrow(/no screenshot directory is configured/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a root outside the boundary without creating any directory', async () => {
    const boundaryRoot = await mkdtemp(path.join(tmpdir(), 'bridge-shot-boundary-'))
    const targetParent = await mkdtemp(path.join(tmpdir(), 'bridge-shot-target-'))
    try {
      const workspaceRoot = path.join(targetParent, 'nested', 'screenshots-workspace')
      await expect(saveScreenshotImage(
        { base64: Buffer.from('png').toString('base64'), mimeType: 'image/png', width: 1, height: 1 },
        { workspaceRoot, boundary: boundaryRoot },
      )).rejects.toThrow(/is outside the artifact boundary/)
      // Validation runs before `mkdir`, so the refused configuration leaves no residue.
      await expect(realpath(workspaceRoot)).rejects.toThrow()
      await expect(realpath(path.join(targetParent, 'nested'))).rejects.toThrow()

      // A boundary that is distinct from the root must already exist.
      const missingBoundary = path.join(targetParent, 'boundary-that-does-not-exist')
      await expect(saveScreenshotImage(
        { base64: Buffer.from('png').toString('base64'), mimeType: 'image/png', width: 1, height: 1 },
        { workspaceRoot: path.join(missingBoundary, 'screenshots-workspace'), boundary: missingBoundary },
      )).rejects.toThrow(/does not exist/)
      await expect(realpath(missingBoundary)).rejects.toThrow()
    } finally {
      await rm(boundaryRoot, { recursive: true, force: true })
      await rm(targetParent, { recursive: true, force: true })
    }
  })

  it('writes inside the resolved screenshots directory and never overwrites', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bridge-shot-artifact-'))
    try {
      const resolvedRoot = await realpath(root)
      const image = { base64: Buffer.from('png').toString('base64'), mimeType: 'image/png', width: 2, height: 3 }
      const first = await saveScreenshotImage(image, { workspaceRoot: root, boundary: root, now: 1_000 })
      const second = await saveScreenshotImage(image, { workspaceRoot: root, boundary: root, now: 1_000 })
      expect(first.path.startsWith(path.join(resolvedRoot, 'screenshots') + path.sep)).toBe(true)
      expect(first.path).toMatch(/shot-1000-[0-9a-f]{6}\.png$/)
      expect(second.path).not.toBe(first.path)
      expect(first.format).toBe('png')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

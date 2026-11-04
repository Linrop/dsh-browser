import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ArtifactRootRefused,
  assertArtifactRoot,
  isArtifactPath,
  planArtifactEviction,
  sweepArtifacts,
  type ArtifactEntry,
  type ArtifactLimits,
} from '../src/artifact-budget.ts'

const tempRoots: string[] = []
const warned: string[] = []

const log = { warn: (message: string): void => { warned.push(message) } }

afterEach(async () => {
  vi.unstubAllEnvs()
  warned.splice(0)
  for (const root of tempRoots.splice(0)) {
    await chmod(root, 0o700).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

async function tempDir(prefix = 'dsh-artifact-'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

const LIMITS: ArtifactLimits = { maxBytes: 1_000, maxFiles: 100, ttlMs: 1_000_000 }

function entry(filePath: string, size: number, mtimeMs: number, overrides: Partial<ArtifactEntry> = {}): ArtifactEntry {
  return { path: filePath, size, mtimeMs, isFile: true, isSymlink: false, ...overrides }
}

describe('isArtifactPath', () => {
  it('matches the whitelist case-insensitively and rejects everything else', () => {
    for (const name of ['.png', '.PNG', '.JPG', '.jpeg', '.webp', '.bmp', '.ppm', '.gif']) {
      expect(isArtifactPath(`/tmp/x${name}`)).toBe(true)
    }
    for (const name of ['.txt', '.json', '.md', '.ts', '.html', '.htm', '.mhtml', 'png', '.png.bak']) {
      expect(isArtifactPath(`/tmp/x${name}`)).toBe(false)
    }
  })
})

describe('planArtifactEviction', () => {
  it('evicts expired artifacts even when both budgets have room', () => {
    const now = 10_000_000
    const old = entry('/w/old.png', 10, now - LIMITS.ttlMs - 1)
    const fresh = entry('/w/fresh.png', 10, now)
    expect(planArtifactEviction([old, fresh], LIMITS, now)).toEqual(['/w/old.png'])
  })

  it('evicts oldest survivors until the byte budget holds', () => {
    const now = 1_000
    const entries = [
      entry('/w/b.png', 400, 900),
      entry('/w/a.png', 400, 800),
      entry('/w/c.png', 400, 950),
    ]
    expect(planArtifactEviction(entries, { ...LIMITS, maxBytes: 500 }, now)).toEqual(['/w/a.png', '/w/b.png'])
  })

  it('evicts oldest survivors until the file budget holds', () => {
    const now = 1_000
    const entries = [entry('/w/c.png', 1, 900), entry('/w/a.png', 1, 700), entry('/w/b.png', 1, 800)]
    expect(planArtifactEviction(entries, { ...LIMITS, maxFiles: 1 }, now)).toEqual(['/w/a.png', '/w/b.png'])
  })

  it('applies both budgets in one pass', () => {
    const now = 1_000
    const entries = [
      entry('/w/a.png', 900, 700),
      entry('/w/b.png', 900, 800),
      entry('/w/c.png', 10, 900),
    ]
    expect(planArtifactEviction(entries, { ...LIMITS, maxBytes: 100, maxFiles: 2 }, now))
      .toEqual(['/w/a.png', '/w/b.png'])
  })

  it('ignores non-artifact files, symlinks, and non-files entirely', () => {
    const now = 1_000
    const entries = [
      entry('/w/keep.txt', 10_000, 1),
      entry('/w/link.png', 10_000, 1, { isSymlink: true }),
      entry('/w/dir.png', 10_000, 1, { isFile: false }),
      entry('/w/keep.PNG', 10, 900),
    ]
    expect(planArtifactEviction(entries, { ...LIMITS, maxBytes: 100 }, now)).toEqual([])
  })

  it('returns nothing when every condition already holds', () => {
    const now = 1_000
    expect(planArtifactEviction([entry('/w/a.png', 1, 900)], LIMITS, now)).toEqual([])
  })

  it('breaks equal mtimes by path so the plan is deterministic', () => {
    const now = 1_000
    const entries = [entry('/w/z.png', 10, 900), entry('/w/a.png', 10, 900)]
    expect(planArtifactEviction(entries, { ...LIMITS, maxFiles: 1 }, now)).toEqual(['/w/a.png'])
  })
})

describe('assertArtifactRoot', () => {
  it('accepts a real path inside the workspace boundary', async () => {
    const boundary = await tempDir('dsh-artifact-boundary-')
    const root = path.join(boundary, 'artifacts')
    await mkdir(root)
    vi.stubEnv('DSH_BROWSER_SESSION_WORKSPACE', boundary)
    await expect(assertArtifactRoot(root)).resolves.toBe(await realpathOf(root))
  })

  it('accepts the boundary itself', async () => {
    const boundary = await tempDir('dsh-artifact-boundary-')
    vi.stubEnv('DSH_BROWSER_SESSION_WORKSPACE', boundary)
    await expect(assertArtifactRoot(boundary)).resolves.toBe(await realpathOf(boundary))
  })

  it('accepts the configured artifactRoot as the boundary when the env is absent', async () => {
    const boundary = await tempDir('dsh-artifact-boundary-config-')
    const inside = path.join(boundary, 'nested')
    await mkdir(inside)
    await expect(assertArtifactRoot(inside, boundary)).resolves.toBe(await realpathOf(inside))
    // The configured boundary is itself an accepted root (root == boundary).
    await expect(assertArtifactRoot(boundary, boundary)).resolves.toBe(await realpathOf(boundary))
    // A root outside the configured boundary stays refused.
    const outside = await tempDir('dsh-artifact-outside-config-')
    await expect(assertArtifactRoot(outside, boundary)).rejects.toThrow(/outside the artifact boundary/)
    const result = await sweepArtifacts(outside, LIMITS, 1_000, log, boundary)
    expect(result).toEqual({ scanned: 0, kept: 0, deleted: 0, bytesFreed: 0, refused: 1, skippedGit: 0 })
  })

  it('refuses when neither the env nor artifactRoot provides a boundary', async () => {
    const root = await tempDir('dsh-artifact-boundary-')
    await expect(assertArtifactRoot(root, '')).rejects.toThrow(/no artifact boundary configured/)
  })

  it('refuses a root outside the workspace boundary', async () => {
    const boundary = await tempDir('dsh-artifact-boundary-')
    const outside = await tempDir('dsh-artifact-outside-')
    vi.stubEnv('DSH_BROWSER_SESSION_WORKSPACE', boundary)
    await expect(assertArtifactRoot(outside)).rejects.toBeInstanceOf(ArtifactRootRefused)
  })

  it('refuses the home directory', async () => {
    const home = await tempDir('dsh-artifact-home-')
    vi.stubEnv('HOME', home)
    await expect(assertArtifactRoot(home, home)).rejects.toThrow(/home directory/)
  })

  it('refuses the filesystem root', async () => {
    await expect(assertArtifactRoot('/', '/')).rejects.toThrow(/filesystem root/)
  })

  it('refuses an empty root', async () => {
    await expect(assertArtifactRoot('   ', '/tmp')).rejects.toThrow(/empty/)
  })

  it('refuses a root that is itself a Git work tree', async () => {
    const root = await tempDir('dsh-artifact-git-')
    await mkdir(path.join(root, '.git'))
    await expect(assertArtifactRoot(root, root)).rejects.toThrow(/itself a Git work tree/)
  })
})

describe('sweepArtifacts', () => {
  const now = 20_000_000
  /** Sweep with the root doubling as its own boundary. */
  const sweep = (root: string, limits: ArtifactLimits, at = now) =>
    sweepArtifacts(root, limits, at, log, root)

  it('removes planned artifacts recursively and leaves everything else', async () => {
    const root = await tempDir('dsh-artifact-sweep-')
    await mkdir(path.join(root, 'nested'))
    await writeFile(path.join(root, 'old.png'), 'x'.repeat(40))
    await writeFile(path.join(root, 'notes.txt'), 'keep')
    await writeFile(path.join(root, 'nested', 'page.webp'), 'y'.repeat(10))
    const past = new Date(now - 10_000_000)
    await utimes(path.join(root, 'old.png'), past, past)
    await utimes(path.join(root, 'nested', 'page.webp'), past, past)

    const result = await sweep(root, LIMITS)
    expect(result).toMatchObject({ scanned: 3, deleted: 2, bytesFreed: 50, refused: 0 })
    expect(result.kept).toBe(0)
    await expect(readFileOrUndefined(path.join(root, 'old.png'))).resolves.toBeUndefined()
    await expect(readFileOrUndefined(path.join(root, 'notes.txt'))).resolves.toBe('keep')
  })

  it('enforces the byte budget on fresh artifacts', async () => {
    const root = await tempDir('dsh-artifact-sweep-')
    await writeFile(path.join(root, 'a.png'), 'a'.repeat(100))
    await writeFile(path.join(root, 'b.png'), 'b'.repeat(100))
    await utimes(path.join(root, 'a.png'), new Date(now - 10), new Date(now - 10))
    await utimes(path.join(root, 'b.png'), new Date(now - 5), new Date(now - 5))
    const result = await sweep(root, { ...LIMITS, maxBytes: 150 })
    expect(result).toMatchObject({ deleted: 1, kept: 1, bytesFreed: 100, refused: 0 })
    await expect(readFileOrUndefined(path.join(root, 'b.png'))).resolves.toBe('b'.repeat(100))
  })

  it('never follows or deletes symlinks', async () => {
    const root = await tempDir('dsh-artifact-sweep-')
    const outside = await tempDir('dsh-artifact-outside-')
    await writeFile(path.join(outside, 'target.png'), 'secret')
    await symlink(path.join(outside, 'target.png'), path.join(root, 'link.png'))
    const result = await sweep(root, { ...LIMITS, ttlMs: 1 })
    expect(result).toMatchObject({ scanned: 1, deleted: 0, refused: 0 })
    await expect(readFileOrUndefined(path.join(outside, 'target.png'))).resolves.toBe('secret')
  })

  it('counts a failed removal as refused and keeps sweeping', async () => {
    const root = await tempDir('dsh-artifact-sweep-')
    const locked = path.join(root, 'locked')
    await mkdir(locked)
    await writeFile(path.join(locked, 'a.png'), 'x'.repeat(5))
    await writeFile(path.join(root, 'b.png'), 'y'.repeat(5))
    const past = new Date(Date.now() - 10_000)
    await utimes(path.join(locked, 'a.png'), past, past)
    await utimes(path.join(root, 'b.png'), past, past)
    await chmod(locked, 0o500)
    const result = await sweep(root, { ...LIMITS, ttlMs: 1 }, Date.now())
    await chmod(locked, 0o700).catch(() => {})
    expect(result.refused).toBe(1)
    expect(result.deleted).toBe(1)
    expect(warned.some(message => message.includes('could not remove artifact'))).toBe(true)
  })

  it('treats a missing root as already in budget', async () => {
    const root = path.join(await tempDir('dsh-artifact-missing-'), 'not-created-yet')
    const result = await sweep(root, LIMITS)
    expect(result).toEqual({ scanned: 0, kept: 0, deleted: 0, bytesFreed: 0, refused: 0, skippedGit: 0 })
    expect(warned).toEqual([])
  })

  it('refuses to sweep when no boundary is configured anywhere', async () => {
    const root = await tempDir('dsh-artifact-noboundary-')
    await writeFile(path.join(root, 'old.png'), 'x'.repeat(5))
    const past = new Date(now - 10_000_000)
    await utimes(path.join(root, 'old.png'), past, past)
    const result = await sweepArtifacts(root, LIMITS, now, log)
    expect(result).toMatchObject({ deleted: 0, refused: 1 })
    expect(warned.some(message => message.includes('no artifact boundary configured'))).toBe(true)
    await expect(readFileOrUndefined(path.join(root, 'old.png'))).resolves.toBe('x'.repeat(5))
  })

  it('warns once per root when no boundary is configured', async () => {
    const root = await tempDir('dsh-artifact-noboundary-once-')
    await writeFile(path.join(root, 'old.png'), 'x'.repeat(5))
    const localWarned: string[] = []
    const localLog = { warn: (message: string): void => { localWarned.push(message) } }
    const first = await sweepArtifacts(root, LIMITS, now, localLog)
    const second = await sweepArtifacts(root, LIMITS, now, localLog)
    expect(first).toMatchObject({ deleted: 0, refused: 1 })
    expect(second).toMatchObject({ deleted: 0, refused: 1 })
    expect(localWarned.filter(message => message.includes('no artifact boundary configured'))).toHaveLength(1)
    await expect(readFileOrUndefined(path.join(root, 'old.png'))).resolves.toBe('x'.repeat(5))
  })

  it('skips a .git subtree but keeps enforcing the budget', async () => {
    const root = await tempDir('dsh-artifact-repo-')
    const repo = path.join(root, 'project')
    await mkdir(path.join(repo, '.git', 'objects'), { recursive: true })
    await writeFile(path.join(repo, '.git', 'config'), 'gitdir')
    await writeFile(path.join(repo, '.git', 'objects', 'pack.png'), 'object')
    await writeFile(path.join(root, 'a.png'), 'a'.repeat(100))
    await writeFile(path.join(root, 'b.png'), 'b'.repeat(100))
    const past = new Date(now - 10_000)
    await utimes(path.join(root, 'a.png'), past, past)
    await utimes(path.join(root, 'b.png'), new Date(now - 5), new Date(now - 5))

    const result = await sweep(root, { ...LIMITS, maxBytes: 150 })
    expect(result).toMatchObject({ deleted: 1, kept: 1, skippedGit: 1, bytesFreed: 100 })
    await expect(readFileOrUndefined(path.join(root, 'a.png'))).resolves.toBeUndefined()
    await expect(readFileOrUndefined(path.join(root, 'b.png'))).resolves.toBe('b'.repeat(100))
    await expect(readFileOrUndefined(path.join(repo, '.git', 'config'))).resolves.toBe('gitdir')
    await expect(readFileOrUndefined(path.join(repo, '.git', 'objects', 'pack.png'))).resolves.toBe('object')
    expect(warned.filter(message => message.includes('skipped a .git subtree'))).toHaveLength(1)
    // The warning is one-time per root: later sweeps stay quiet.
    await sweep(root, { ...LIMITS, maxBytes: 150 })
    expect(warned.filter(message => message.includes('skipped a .git subtree'))).toHaveLength(1)
  })

  it('reports a refused root instead of throwing', async () => {
    const boundary = await tempDir('dsh-artifact-boundary-')
    const outside = await tempDir('dsh-artifact-outside-')
    vi.stubEnv('DSH_BROWSER_SESSION_WORKSPACE', boundary)
    const result = await sweepArtifacts(outside, LIMITS, now, log)
    expect(result).toEqual({ scanned: 0, kept: 0, deleted: 0, bytesFreed: 0, refused: 1, skippedGit: 0 })
    expect(warned.some(message => message.includes('artifact sweep refused'))).toBe(true)
  })
})

async function realpathOf(target: string): Promise<string> {
  const { realpath } = await import('node:fs/promises')
  return realpath(target)
}

async function readFileOrUndefined(target: string): Promise<string | undefined> {
  const { readFile } = await import('node:fs/promises')
  return readFile(target, 'utf8').catch(() => undefined)
}

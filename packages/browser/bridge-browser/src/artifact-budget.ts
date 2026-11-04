/**
 * Bounded retention for files the browser extension writes into its session
 * workspace.
 *
 * The workspace is a cache, not a deliverable directory: the image artifacts
 * an agent saves there (PNG/JPEG/WebP/BMP/PPM/GIF frames) accumulate while it
 * works. This module keeps that directory within a byte budget, a file-count
 * budget, and a TTL, and refuses to touch anything outside the configured
 * workspace root or any file whose extension is not in {@link ARTIFACT_EXTENSIONS}.
 *
 * @module @yuxianglin/dsh-bridge-browser/src/artifact-budget
 */

import { lstat, readdir, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * Extensions this budget owns. Everything else in the workspace is ignored:
 * a file the operator dropped there is never evicted by the sweep.
 */
export const ARTIFACT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.bmp',
  '.ppm',
  '.gif',
])

/** Roots whose `.git` subtree already produced its one-time warning. */
const warnedGitRoots = new Set<string>()

/** Roots already warned about a missing boundary in this process. */
const warnedNoBoundaryRoots = new Set<string>()

/** Environment override for the artifact workspace boundary. */
const WORKSPACE_ENV = 'DSH_BROWSER_SESSION_WORKSPACE'

/**
 * Resolve the deletion boundary: the environment workspace wins; without it the
 * non-empty `artifactRoot` itself becomes the boundary. When `artifactRoot` is
 * the boundary the root trivially equals it, so only the `$HOME`, filesystem
 * root, and Git checks constrain it; configure that path deliberately. No
 * boundary means no deletion.
 * @param configuredRoot - the plugin's `artifactRoot` config (empty when unset).
 * @returns the boundary path, or `''` when neither source provides one.
 */
export function artifactBoundary(configuredRoot: string): string {
  const fromEnv = process.env[WORKSPACE_ENV]
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv
  return configuredRoot.trim()
}

/** One filesystem entry considered by the budget. */
export interface ArtifactEntry {
  /** Absolute path of the entry. */
  path: string
  /** Size in bytes. */
  size: number
  /** Modification time in epoch milliseconds. */
  mtimeMs: number
  /** Whether `lstat` reported a regular file. */
  isFile: boolean
  /** Whether `lstat` reported a symbolic link. */
  isSymlink: boolean
}

/** Retention limits applied to one workspace root. */
export interface ArtifactLimits {
  /** Total bytes allowed across artifact files. */
  maxBytes: number
  /** Total artifact files allowed. */
  maxFiles: number
  /** Maximum age in milliseconds; older artifacts are always evicted. */
  ttlMs: number
}

/** Counters returned by {@link sweepArtifacts}. */
export interface ArtifactSweepResult {
  /** Regular and symlink entries visited below the root. */
  scanned: number
  /** Artifact files left in place. */
  kept: number
  /** Artifact files removed. */
  deleted: number
  /** Bytes reclaimed by successful removals. */
  bytesFreed: number
  /** Removals that failed, plus 1 when the root itself was refused. */
  refused: number
  /** 1 when a `.git` subtree was found and left untouched, else 0. */
  skippedGit: number
}

/** Sink for sweep diagnostics; the plugin passes its Cordis logger. */
export interface ArtifactSweepLog {
  /** Called once per failed removal. */
  warn(message: string): void
}

/** Raised when the root is outside the workspace boundary or unsafe to sweep. */
export class ArtifactRootRefused extends Error {
  /** Stable code for callers that branch on the refusal. */
  readonly code = 'artifact-root-refused'

  /**
   * @param message - why the root was refused.
   */
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactRootRefused'
  }
}

/**
 * Whether a path carries one of {@link ARTIFACT_EXTENSIONS} (case-insensitive).
 * @param filePath - path or basename to test.
 * @returns true when the sweep may evict the file.
 */
export function isArtifactPath(filePath: string): boolean {
  return ARTIFACT_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

/**
 * Plan which artifacts to evict. Only regular, non-symlink files with a
 * whitelisted extension are candidates; other entries neither count nor get
 * deleted. Expired artifacts are evicted first, then the oldest survivors
 * until both the byte and the file-count budgets hold. Ties break on path so
 * the plan is deterministic.
 * @param entries - entries found below the root.
 * @param limits - byte, count, and age limits.
 * @param now - current epoch milliseconds.
 * @returns absolute paths to delete, in eviction order.
 */
export function planArtifactEviction(
  entries: readonly ArtifactEntry[],
  limits: ArtifactLimits,
  now: number,
): string[] {
  const candidates = entries
    .filter(entry => entry.isFile && !entry.isSymlink && isArtifactPath(entry.path))
    .map(entry => ({ ...entry, size: Math.max(0, entry.size) }))
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path))

  const cutoff = now - limits.ttlMs
  const expired = candidates.filter(entry => entry.mtimeMs < cutoff)
  const survivors = candidates.filter(entry => !expired.includes(entry))
  const evicted = expired.map(entry => entry.path)
  let bytes = survivors.reduce((total, entry) => total + entry.size, 0)
  let count = survivors.length
  for (const entry of survivors) {
    if (bytes <= limits.maxBytes && count <= limits.maxFiles) break
    evicted.push(entry.path)
    bytes -= entry.size
    count -= 1
  }
  return evicted
}

/**
 * Resolve the sweep root and prove it is safe to delete below.
 *
 * A boundary must come from `DSH_BROWSER_SESSION_WORKSPACE` or the
 * `artifactRoot` configuration; without one nothing is swept. The real path
 * must equal that boundary or sit inside it, so when `artifactRoot` is the
 * boundary the containment check cannot constrain the root itself. `$HOME`, the filesystem root,
 * and a root that is itself a Git work tree are refused so a misconfiguration
 * cannot sweep a project. A `.git` directory deeper inside the tree is skipped
 * by the sweep rather than refusing the whole root.
 * @param root - configured sweep root.
 * @param configuredBoundary - `artifactRoot` config, used when the env var is unset.
 * @returns the resolved real path.
 * @throws ArtifactRootRefused when no boundary is configured or the root fails a check.
 */
export async function assertArtifactRoot(root: string, configuredBoundary = ''): Promise<string> {
  const boundarySource = requireBoundary(root, configuredBoundary)
  const resolved = await realpath(root).catch((error: unknown) => {
    throw new ArtifactRootRefused(`artifact root "${root}" cannot be resolved: ${String(error)}`)
  })
  const boundary = await realpath(boundarySource).catch((error: unknown) => {
    throw new ArtifactRootRefused(
      `artifact boundary "${boundarySource}" cannot be resolved: ${String(error)}`,
    )
  })
  assertSafeRoot(resolved, boundary, await artifactHome())
  if (await isGitWorkTree(resolved)) {
    throw new ArtifactRootRefused(`artifact root "${resolved}" is itself a Git work tree`)
  }
  return resolved
}

/**
 * Prove a root is safe to create and write below, without creating it.
 *
 * A caller that creates the root first leaves an empty directory behind when
 * the configuration is refused, so the checks that do not need the directory to
 * exist run here first: both the root and the boundary resolve through their
 * deepest existing ancestor (symlinked prefixes are followed before anything is
 * created), then the same empty, boundary, filesystem-root, and `$HOME`
 * refusals apply. The caller must still call {@link assertArtifactRoot} after
 * creating the directory to repeat them against the real path and to reject a
 * Git work tree.
 *
 * @param root - root the caller intends to create.
 * @param configuredBoundary - `artifactRoot` config, used when the env var is unset.
 * @returns the resolved path the caller should create.
 * @throws ArtifactRootRefused when no boundary is configured or the candidate fails a check.
 */
export async function assertArtifactRootCandidate(root: string, configuredBoundary = ''): Promise<string> {
  const boundarySource = requireBoundary(root, configuredBoundary)
  const resolved = await resolveCandidatePath(root)
  const boundary = await resolveCandidatePath(boundarySource)
  // A boundary distinct from the root authorizes the write and must already
  // exist; only a boundary that is the root itself may be created here, so the
  // first screenshot of a fresh workspace root still works.
  if (boundary !== resolved && await realpath(boundarySource).catch(() => undefined) === undefined) {
    throw new ArtifactRootRefused(
      `artifact boundary "${boundarySource}" cannot be resolved: the directory does not exist`,
    )
  }
  assertSafeRoot(resolved, boundary, await artifactHome())
  return resolved
}

/** Resolve the configured boundary source, refusing an unusable configuration. */
function requireBoundary(root: string, configuredBoundary: string): string {
  if (root.trim() === '') throw new ArtifactRootRefused('artifact root is empty')
  const boundarySource = artifactBoundary(configuredBoundary)
  if (boundarySource === '') {
    throw new ArtifactRootRefused(
      'no artifact boundary configured (set DSH_BROWSER_SESSION_WORKSPACE or a non-empty artifactRoot)',
    )
  }
  return boundarySource
}

/** `$HOME` as the canonical home used by the refusals. */
async function artifactHome(): Promise<string> {
  // `$HOME` is the shell-visible home and is what misconfiguration actually
  // points at; it also makes the refusal testable without touching the real one.
  const home = process.env.HOME ?? homedir()
  return realpath(home).catch(() => path.resolve(home))
}

/** Refuse the roots a misconfiguration must never own. */
function assertSafeRoot(resolved: string, boundary: string, home: string): void {
  if (resolved === path.parse(resolved).root) {
    throw new ArtifactRootRefused(`refusing to sweep the filesystem root "${resolved}"`)
  }
  if (resolved === home) {
    throw new ArtifactRootRefused(`refusing to sweep the home directory "${resolved}"`)
  }
  if (resolved !== boundary && !resolved.startsWith(`${boundary}${path.sep}`)) {
    throw new ArtifactRootRefused(
      `artifact root "${resolved}" is outside the artifact boundary "${boundary}"`,
    )
  }
}

/**
 * Resolve a path that may not exist yet: the deepest existing ancestor is
 * resolved through `realpath`, then the missing segments are appended. This is
 * what lets a candidate be checked before `mkdir` creates it.
 * @param target - path to resolve.
 * @returns the resolved absolute path.
 * @throws ArtifactRootRefused when no ancestor directory exists.
 */
async function resolveCandidatePath(target: string): Promise<string> {
  const missing: string[] = []
  let current = path.resolve(target)
  for (;;) {
    const resolved = await realpath(current).catch(() => undefined)
    if (resolved !== undefined) {
      return missing.length === 0 ? resolved : path.join(resolved, ...missing)
    }
    const parent = path.dirname(current)
    if (parent === current) {
      throw new ArtifactRootRefused(`path "${target}" has no existing ancestor directory`)
    }
    missing.unshift(path.basename(current))
    current = parent
  }
}

/** Whether the directory itself carries a `.git` entry. */
async function isGitWorkTree(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return entries.some(entry => entry.name === '.git')
}

/**
 * Walk the workspace, plan evictions, and delete them. Symlinks are never
 * followed and never deleted; a failing removal is counted and warned about
 * instead of aborting the sweep. A refused root yields `refused: 1`.
 * @param root - configured workspace root.
 * @param limits - byte, count, and age limits.
 * @param now - current epoch milliseconds.
 * @param log - diagnostics sink.
 * @returns sweep counters.
 */
export async function sweepArtifacts(
  root: string,
  limits: ArtifactLimits,
  now: number,
  log: ArtifactSweepLog,
  configuredBoundary = '',
): Promise<ArtifactSweepResult> {
  // The workspace is created lazily by the first session, so a missing root is
  // the normal pre-session state rather than a refusal worth warning about.
  const present = await stat(root).catch(() => undefined)
  if (present === undefined) {
    return { scanned: 0, kept: 0, deleted: 0, bytesFreed: 0, refused: 0, skippedGit: 0 }
  }
  // Without a boundary every sweep would refuse for the same reason; warn once
  // per process instead of on every interval tick.
  if (artifactBoundary(configuredBoundary) === '') {
    if (!warnedNoBoundaryRoots.has(root)) {
      warnedNoBoundaryRoots.add(root)
      log.warn(
        'browser bridge: artifact sweep refused: no artifact boundary configured '
        + '(set DSH_BROWSER_SESSION_WORKSPACE or a non-empty artifactRoot)',
      )
    }
    return { scanned: 0, kept: 0, deleted: 0, bytesFreed: 0, refused: 1, skippedGit: 0 }
  }
  let resolved: string
  try {
    resolved = await assertArtifactRoot(root, configuredBoundary)
  } catch (error: unknown) {
    log.warn(`browser bridge: artifact sweep refused: ${error instanceof Error ? error.message : String(error)}`)
    return { scanned: 0, kept: 0, deleted: 0, bytesFreed: 0, refused: 1, skippedGit: 0 }
  }
  const { entries, skippedGit } = await collect(resolved)
  if (skippedGit && !warnedGitRoots.has(resolved)) {
    warnedGitRoots.add(resolved)
    log.warn(
      `browser bridge: artifact sweep skipped a .git subtree under "${resolved}" (nothing inside it is touched)`,
    )
  }
  const evicted = planArtifactEviction(entries, limits, now)
  const doomed = new Set(evicted)
  let deleted = 0
  let bytesFreed = 0
  let refused = 0
  for (const entry of entries) {
    if (!doomed.has(entry.path)) continue
    try {
      await rm(entry.path, { force: true })
      deleted += 1
      bytesFreed += entry.size
    } catch (error: unknown) {
      refused += 1
      log.warn(`browser bridge: could not remove artifact "${entry.path}": ${String(error)}`)
    }
  }
  const artifactFiles = entries.filter(
    entry => entry.isFile && !entry.isSymlink && isArtifactPath(entry.path),
  )
  return {
    scanned: entries.length,
    kept: artifactFiles.length - deleted,
    deleted,
    bytesFreed,
    refused,
    skippedGit: skippedGit ? 1 : 0,
  }
}

/**
 * Recursively collect every non-directory entry below one resolved root. A
 * `.git` directory is recorded and skipped without descending, so a repository
 * the agent initialized inside the workspace keeps its budget working and its
 * objects untouched.
 * @param root - resolved workspace root.
 * @returns the collected entries and whether a `.git` subtree was skipped.
 */
async function collect(root: string): Promise<{ entries: ArtifactEntry[]; skippedGit: boolean }> {
  const entries: ArtifactEntry[] = []
  let skippedGit = false
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) break
    const children = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const child of children) {
      const full = path.join(directory, child.name)
      if (child.isDirectory()) {
        if (child.name === '.git') {
          skippedGit = true
          continue
        }
        pending.push(full)
        continue
      }
      const info = await lstat(full).catch(() => undefined)
      if (info === undefined) continue
      entries.push({
        path: full,
        size: info.size,
        mtimeMs: info.mtimeMs,
        isFile: info.isFile(),
        isSymlink: info.isSymbolicLink(),
      })
    }
  }
  return { entries, skippedGit }
}

import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { apply, assertPositiveInteger, Config, resolveConfig } from '../src/index.ts'

/** Minimal context stub: apply only needs the services at registration time. */
function stubContext(): Context {
  const gateway = {
    wireStream: {
      open: async (): Promise<AsyncIterable<unknown>> => ({
        async *[Symbol.asyncIterator]() { yield { type: 'ready', clientId: 'test', host: { home: '/tmp' } } },
      }),
      failure: (error: unknown) => ({ code: 'internal', message: String(error), details: {} }),
    },
    invoke: async () => undefined,
  }
  const connection = {
    createSharedFetchHandler: () => ({ fetch: async () => new Response('not found', { status: 404 }) }),
    createPeer: () => ({ principal: { kind: 'owner' }, signal: new AbortController().signal }),
  }
  return {
    webServer: { port: 0, registerUpgrade: () => () => {}, register: () => () => {} },
    tools: { register: () => () => {} },
    agents: { get: () => undefined },
    get: (key: string) => key === 'typertGateway' ? gateway : key === 'connection' ? connection : undefined,
    on: () => () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn: () => unknown, label?: string) => {
      void label
      return fn() as () => void
    },
  } as unknown as Context
}

const dirs: string[] = []
beforeEach(async () => {
  // Never let the startup sweep touch the real dsh home; point the boundary at
  // a per-test temp workspace.
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-bridge-artifacts-'))
  dirs.push(workspace)
  vi.stubEnv('DSH_BROWSER_SESSION_WORKSPACE', workspace)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('assertPositiveInteger', () => {
  it('accepts positive integers and rejects everything else', () => {
    expect(() => assertPositiveInteger('x', 1)).not.toThrow()
    expect(() => assertPositiveInteger('x', 0)).toThrow(/must be a positive integer/)
    expect(() => assertPositiveInteger('x', -1)).toThrow(/must be a positive integer/)
    expect(() => assertPositiveInteger('x', 1.5)).toThrow(/must be a positive integer/)
  })
})

/** Valid budgets (the Loader applies schema defaults; hand-built tests pass them explicitly). */
const VALID = {
  toolTimeoutMs: 90_000,
  snapshotMaxChars: 32_000,
  maxInteractiveItems: 60,
  artifactMaxBytes: 2_147_483_648,
  artifactMaxFiles: 2_000,
  artifactTtlMs: 604_800_000,
  artifactSweepIntervalMs: 600_000,
}

describe('config', () => {
  it('resolves defaults, including an enabled workspace under the dsh home', () => {
    expect(resolveConfig({})).toEqual({
      ...VALID,
      sessionWorkspacePath: dshHomePath('browser-sessions'),
      deferSessionCreate: true,
      artifactRoot: '',
    })
    expect(new Config().sessionWorkspacePath).toBe(dshHomePath('browser-sessions'))
  })

  it('preserves explicit values and the empty-string workspace opt-out', () => {
    expect(resolveConfig({
      token: 'fixed',
      toolTimeoutMs: 1,
      snapshotMaxChars: 500,
      maxInteractiveItems: 3,
      sessionWorkspacePath: '',
      deferSessionCreate: false,
      artifactMaxBytes: 10,
      artifactMaxFiles: 10,
      artifactTtlMs: 10,
      artifactSweepIntervalMs: 10,
      artifactRoot: '/tmp/artifacts',
    })).toEqual({
      token: 'fixed',
      toolTimeoutMs: 1,
      snapshotMaxChars: 500,
      maxInteractiveItems: 3,
      sessionWorkspacePath: '',
      deferSessionCreate: false,
      artifactMaxBytes: 10,
      artifactMaxFiles: 10,
      artifactTtlMs: 10,
      artifactSweepIntervalMs: 10,
      artifactRoot: '/tmp/artifacts',
    })
    expect(new Config({ sessionWorkspacePath: '' }).sessionWorkspacePath).toBe('')
    expect(new Config().artifactRoot).toBe('')
  })
})

describe('apply', () => {
  it('registers the bridge with a fixed token (no generation)', async () => {
    await apply(stubContext(), { token: 'fixed-token', ...VALID, sessionWorkspacePath: '' })
  })

  it.each([undefined, {}, { wireStream: {} }])('rejects unsupported Gateway capabilities: %j', async (gateway) => {
    const ctx = stubContext()
    const get = ctx.get.bind(ctx)
    vi.spyOn(ctx, 'get').mockImplementation((key) => key === 'typertGateway' ? gateway : get(key))
    const register = vi.spyOn(ctx.webServer, 'registerUpgrade')
    await expect(apply(ctx, { token: 'fixed-token', ...VALID })).rejects.toThrow(/dsh 0\.2\.0-rc\.1.*wireStream unavailable/)
    expect(register).not.toHaveBeenCalled()
  })

  it('sweeps expired artifacts from the configured workspace on startup', async () => {
    const workspace = process.env.DSH_BROWSER_SESSION_WORKSPACE as string
    const artifact = join(workspace, 'stale.png')
    await writeFile(artifact, 'x'.repeat(8))
    const past = new Date(Date.now() - 10_000_000)
    await utimes(artifact, past, past)

    await apply(stubContext(), {
      token: 'fixed-token', ...VALID, artifactTtlMs: 1_000, sessionWorkspacePath: '', artifactRoot: workspace,
    })

    const removed = await waitFor(async () => {
      try { await readFile(artifact); return false } catch { return true }
    })
    expect(removed).toBe(true)
  })

  it('sweeps the session workspace as its own boundary when artifactRoot is unset', async () => {
    // The environment boundary would mask the fallback; drop it so only
    // sessionWorkspacePath can supply the boundary.
    vi.unstubAllEnvs()
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-bridge-default-boundary-'))
    dirs.push(workspace)
    await mkdir(join(workspace, 'screenshots'))
    const artifact = join(workspace, 'screenshots', 'stale.png')
    await writeFile(artifact, 'x'.repeat(8))
    const past = new Date(Date.now() - 10_000_000)
    await utimes(artifact, past, past)

    await apply(stubContext(), {
      token: 'fixed-token', ...VALID, artifactTtlMs: 1_000, sessionWorkspacePath: workspace,
    })

    const removed = await waitFor(async () => {
      try { await readFile(artifact); return false } catch { return true }
    })
    expect(removed).toBe(true)
  })

  it('leaves Remote event source ownership to the host composition', async () => {
    const ctx = stubContext()
    const gateway = ctx.get('typertGateway')
    const open = vi.spyOn(gateway.wireStream, 'open')

    await apply(ctx, { token: 'fixed-token', ...VALID, sessionWorkspacePath: '' })

    expect(open).not.toHaveBeenCalled()
  })

  it('generates and persists a token when none is configured', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-bridge-home-'))
    dirs.push(home)
    vi.stubEnv('DSH_HOME', home)
    await apply(stubContext(), VALID)
  })

  it('rejects invalid budgets loudly', async () => {
    await expect(apply(stubContext(), { ...VALID, toolTimeoutMs: 0 })).rejects.toThrow(/toolTimeoutMs/)
    await expect(apply(stubContext(), { ...VALID, snapshotMaxChars: -1 })).rejects.toThrow(/snapshotMaxChars/)
    await expect(apply(stubContext(), { ...VALID, snapshotMaxChars: 499 })).rejects.toThrow(/at least 500/)
    await expect(apply(stubContext(), { ...VALID, artifactMaxBytes: 0 })).rejects.toThrow(/artifactMaxBytes/)
    await expect(apply(stubContext(), { ...VALID, artifactMaxFiles: 1.5 })).rejects.toThrow(/artifactMaxFiles/)
    await expect(apply(stubContext(), { ...VALID, artifactTtlMs: -1 })).rejects.toThrow(/artifactTtlMs/)
    await expect(apply(stubContext(), { ...VALID, artifactSweepIntervalMs: 0 }))
      .rejects.toThrow(/artifactSweepIntervalMs/)
  })
})

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return false
}

/**
 * `@yuxianglin/dsh-bridge-browser`: token-authenticated WebSocket bridge for
 * the browser extension plus the text-only `browser_*` tool set.
 *
 * The bridge mounts its own upgrade route (`/ext/bridge`) on the host
 * webserver, OUTSIDE the /api trust fence — so it brings its own bearer-token
 * authentication (first frame `hello` within HELLO_TIMEOUT_MS). Extension
 * calls, Session streams, and Host waterfalls use dsh's Typert Gateway
 * and Connection services.
 * Tools execute by dispatching
 * `tool.call` frames to the connected extension, which performs the action in
 * the tab explicitly controlled by the user.
 *
 * Opt-in by design: nothing is registered unless this plugin appears in the
 * composition. No dsh core code is touched.
 *
 * @module @yuxianglin/dsh-bridge-browser
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { BridgeServer } from './server.ts'
import { BrowserContextInjector } from './browser-context.ts'
import { registerBrowserTools } from './tools.ts'
import {
  BRIDGE_CONFIG_PATH,
  BRIDGE_PATH,
  DEFAULT_SNAPSHOT_MAX_CHARS,
  MIN_SNAPSHOT_MAX_CHARS,
} from './protocol.ts'
import { withSessionDeferral } from './session-deferral.ts'
import { withSessionWorkspace } from './session-workspace.ts'
import { purgeSessionFiles, type SessionPurgeDeps } from './session-purge.ts'
import { sweepArtifacts, type ArtifactLimits, type ArtifactSweepResult } from './artifact-budget.ts'
import { resolveToken } from './token.ts'
import {
  createRemoteHostApi,
  type HostConnectionLike,
  type TypertGatewayLike,
} from './remote-host-api.ts'
import { isRecord, type BrowserHostApi } from './host-api.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'bridge-browser'

/** Services required by this plugin. */
export const inject = ['webServer', 'typertGateway', 'connection', 'tools', 'agents']

/** Default per-tool-call budget (ms). */
const DEFAULT_TOOL_TIMEOUT_MS = 90_000

/** Default cap on interactive inventory items per snapshot. */
const DEFAULT_MAX_INTERACTIVE_ITEMS = 60

/** Default directory backing the browser extension's session group. */
const DEFAULT_SESSION_WORKSPACE_PATH = dshHomePath('browser-sessions')

/** Durable session storage root written by the JSONL persistence plugin. */
const SESSIONS_ROOT = dshHomePath('sessions')

/** Default: sessions materialize only on the first message (open-and-close leaves no trace). */
const DEFAULT_DEFER_SESSION_CREATE = true

/** Default byte budget for artifacts written into the session workspace (2 GiB). */
const DEFAULT_ARTIFACT_MAX_BYTES = 2_147_483_648

/** Default artifact file-count budget. */
const DEFAULT_ARTIFACT_MAX_FILES = 2_000

/** Default artifact TTL: one week. */
const DEFAULT_ARTIFACT_TTL_MS = 604_800_000

/** Default artifact sweep period: ten minutes. */
const DEFAULT_ARTIFACT_SWEEP_INTERVAL_MS = 600_000

/** Plugin config: deployment-varying tunables only; the wire contract stays fixed. */
export interface Config {
  /** Fixed bearer token. When absent, a token is generated on first boot and persisted under the dsh home (0600). */
  token?: string
  /** Per-tool-call timeout in ms. Defaults to 90000. */
  toolTimeoutMs?: number
  /** Upper bound on one snapshot's rendered characters. Defaults to 32000; minimum 500. */
  snapshotMaxChars?: number
  /** Upper bound on interactive inventory items per snapshot. Defaults to 60. */
  maxInteractiveItems?: number
  /** Dedicated workspace path for extension-created sessions. Empty disables grouping. */
  sessionWorkspacePath?: string
  /** Defer real session creation until the first prompt. Defaults to true. */
  deferSessionCreate?: boolean
  /** Total bytes the artifact sweep leaves in the session workspace. Defaults to 2147483648. */
  artifactMaxBytes?: number
  /** Total artifact files the sweep leaves in the session workspace. Defaults to 2000. */
  artifactMaxFiles?: number
  /** Age after which an artifact is evicted regardless of the budgets. Defaults to 604800000. */
  artifactTtlMs?: number
  /** Period between artifact sweeps. Defaults to 600000. */
  artifactSweepIntervalMs?: number
  /** Sweep root and deletion boundary. Empty falls back to `sessionWorkspacePath`, which is then both. */
  artifactRoot?: string
}

export const Config: z<Config> = z.object({
  token: z.string(),
  toolTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TOOL_TIMEOUT_MS),
  snapshotMaxChars: z.number().step(1).min(MIN_SNAPSHOT_MAX_CHARS).default(DEFAULT_SNAPSHOT_MAX_CHARS),
  maxInteractiveItems: z.number().step(1).min(1).default(DEFAULT_MAX_INTERACTIVE_ITEMS),
  sessionWorkspacePath: z.string().default(DEFAULT_SESSION_WORKSPACE_PATH),
  deferSessionCreate: z.boolean().default(DEFAULT_DEFER_SESSION_CREATE),
  artifactMaxBytes: z.number().step(1).min(1).default(DEFAULT_ARTIFACT_MAX_BYTES),
  artifactMaxFiles: z.number().step(1).min(1).default(DEFAULT_ARTIFACT_MAX_FILES),
  artifactTtlMs: z.number().step(1).min(1).default(DEFAULT_ARTIFACT_TTL_MS),
  artifactSweepIntervalMs: z.number().step(1).min(1).default(DEFAULT_ARTIFACT_SWEEP_INTERVAL_MS),
  artifactRoot: z.string().default(''),
})

/** The shape after schemastery applies its defaults to every field. */
type ResolvedConfig = Required<Omit<Config, 'token'>> & Pick<Config, 'token'>

/** Configured budgets must be positive integers. Exported for validation tests. */
export function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`bridge-browser: ${name} must be a positive integer`)
  }
}

/**
 * Apply defaults and direct-call validation at the plugin boundary.
 * @param config - Loader-resolved or directly supplied plugin configuration.
 * @returns a complete configuration ready for runtime use.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    ...(config.token === undefined ? {} : { token: config.token }),
    toolTimeoutMs: config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    snapshotMaxChars: config.snapshotMaxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS,
    maxInteractiveItems: config.maxInteractiveItems ?? DEFAULT_MAX_INTERACTIVE_ITEMS,
    sessionWorkspacePath: config.sessionWorkspacePath ?? DEFAULT_SESSION_WORKSPACE_PATH,
    deferSessionCreate: config.deferSessionCreate ?? DEFAULT_DEFER_SESSION_CREATE,
    artifactMaxBytes: config.artifactMaxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES,
    artifactMaxFiles: config.artifactMaxFiles ?? DEFAULT_ARTIFACT_MAX_FILES,
    artifactTtlMs: config.artifactTtlMs ?? DEFAULT_ARTIFACT_TTL_MS,
    artifactSweepIntervalMs: config.artifactSweepIntervalMs ?? DEFAULT_ARTIFACT_SWEEP_INTERVAL_MS,
    artifactRoot: config.artifactRoot ?? '',
  }
  assertPositiveInteger('toolTimeoutMs', resolved.toolTimeoutMs)
  assertPositiveInteger('snapshotMaxChars', resolved.snapshotMaxChars)
  if (resolved.snapshotMaxChars < MIN_SNAPSHOT_MAX_CHARS) {
    throw new Error(`bridge-browser: snapshotMaxChars must be at least ${MIN_SNAPSHOT_MAX_CHARS}`)
  }
  assertPositiveInteger('maxInteractiveItems', resolved.maxInteractiveItems)
  assertPositiveInteger('artifactMaxBytes', resolved.artifactMaxBytes)
  assertPositiveInteger('artifactMaxFiles', resolved.artifactMaxFiles)
  assertPositiveInteger('artifactTtlMs', resolved.artifactTtlMs)
  assertPositiveInteger('artifactSweepIntervalMs', resolved.artifactSweepIntervalMs)
  return resolved
}

/**
 * Mount the bridge: resolve the token, register the upgrade route, the tool
 * set, and an optional system-prompt section, all effect-scoped for HMR.
 *
 * @param ctx - Cordis context.
 * @param config - plugin config (schema defaults applied).
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)

  const gateway = ctx.get('typertGateway') as unknown as GatewayCandidate | undefined
  const connection = ctx.get('connection') as unknown as HostConnectionLike | undefined
  if (gateway === undefined || !hasRemoteWireStream(gateway)) {
    throw new Error('bridge-browser: dsh 0.2.0-rc.1 or a compatible newer runtime is required (Gateway wireStream unavailable)')
  }
  if (connection === undefined) throw new Error('bridge-browser: dsh connection service is required')
  const tokenRes = await resolveToken(resolved.token)
  mountBridge(ctx, resolved, tokenRes, createRemoteHostApi(gateway, connection))
}

function mountBridge(
  ctx: Context,
  resolved: ResolvedConfig,
  tokenRes: Awaited<ReturnType<typeof resolveToken>>,
  hostApi: BrowserHostApi,
): void {
  // Workspace grouping wraps the gateway create; session deferral wraps the
  // result so materialization at first prompt still flows through grouping.
  const api = withSessionDeferral(
    withSessionWorkspace(
      hostApi,
      resolved.sessionWorkspacePath,
      message => { ctx.logger.warn(message) },
    ),
    resolved.deferSessionCreate,
    ctx.get('attachments')?.imageLimits,
  )
  // The configured workspace may live in a purgeable cache directory, and it
  // backs the cwd of every session this bridge created. Once it disappears those
  // sessions fail with "directory does not exist" before their first turn, so
  // recreate it when the plugin loads instead of waiting for the next create.
  if (resolved.sessionWorkspacePath !== '') {
    void mkdir(resolved.sessionWorkspacePath, { recursive: true }).catch((error: unknown) => {
      ctx.logger.warn(
        `browser bridge: could not create session workspace "${resolved.sessionWorkspacePath}": ${String(error)}`,
      )
    })
  }
  const browserContext = new BrowserContextInjector(ctx.agents)
  // DSH 0.1.7+ replaced `agent/session-start` with `agent/created` as the
  // startup-driving extension point (agent registered with live session and
  // completed setup); bind there so deferred sessions still receive their
  // pending browser snapshot at materialization.
  ctx.on('agent/created', ({ agent }) => {
    browserContext.activate(agent)
  })

  // The extension writes screenshots and page dumps into its session
  // workspace; keep that cache within budget and age instead of letting a long
  // QA run accumulate files forever. An empty workspace path opts the feature
  // out, in which case no sweep runs at all.
  // The sweep root is `artifactRoot` when configured, otherwise the session
  // workspace. That fallback is also the deletion boundary: without an explicit
  // root nothing else supplies one, and a boundary-less sweep refuses forever,
  // so the screenshots directory would grow without limit.
  const configuredArtifactRoot = resolved.artifactRoot.trim()
  const artifactRoot = configuredArtifactRoot !== '' ? resolved.artifactRoot : resolved.sessionWorkspacePath
  const artifactBoundaryConfig = configuredArtifactRoot !== '' ? resolved.artifactRoot : resolved.sessionWorkspacePath
  const artifactLimits: ArtifactLimits = {
    maxBytes: resolved.artifactMaxBytes,
    maxFiles: resolved.artifactMaxFiles,
    ttlMs: resolved.artifactTtlMs,
  }
  const sweepLog = { warn: (message: string): void => { ctx.logger.warn(message) } }
  const sweepArtifactsOnce = async (): Promise<void> => {
    try {
      const result: ArtifactSweepResult = await sweepArtifacts(
        artifactRoot, artifactLimits, Date.now(), sweepLog, artifactBoundaryConfig,
      )
      ctx.logger.info(
        `browser bridge: artifact sweep root=${artifactRoot} scanned ${result.scanned}, kept ${result.kept}, `
        + `deleted ${result.deleted}, freed ${result.bytesFreed} bytes, refused ${result.refused}, `
        + `skippedGit=${result.skippedGit}`,
      )
      if (result.deleted > 0) {
        ctx.logger.warn(
          `browser bridge: artifact sweep evicted ${result.deleted} file(s) (${result.bytesFreed} bytes) from `
          + `root=${artifactRoot} to stay within artifactMaxBytes/artifactMaxFiles/artifactTtlMs`,
        )
      }
    } catch (error: unknown) {
      ctx.logger.warn(`browser bridge: artifact sweep failed: ${String(error)}`)
    }
  }
  if (artifactRoot !== '') {
    ctx.effect(() => {
      let sweeping = false
      const run = (): void => {
        if (sweeping) return
        sweeping = true
        void sweepArtifactsOnce().finally(() => { sweeping = false })
      }
      run()
      const timer = setInterval(run, resolved.artifactSweepIntervalMs)
      timer.unref?.()
      return () => { clearInterval(timer) }
    }, 'bridge-browser: artifact sweep')
  }

  const purgeSession = async (sessionId: string): Promise<void> => {
    const runningSessionIds = new Set<string>()
    try {
      const listed = await api.call({
        rpcId: randomUUID(),
        method: 'session.list',
        payload: {},
        signal: new AbortController().signal,
      })
      if (listed.ok && isRecord(listed.value) && Array.isArray(listed.value.items)) {
        for (const entry of listed.value.items) {
          if (isRecord(entry) && entry.running === true && typeof entry.sessionId === 'string') {
            runningSessionIds.add(entry.sessionId)
          }
        }
      }
    } catch {
      // Listing is advisory; the required exclusive persistence handle below
      // protects both active and idle sessions, including in other processes.
    }
    const deps: SessionPurgeDeps = {
      sessionsRoot: SESSIONS_ROOT,
      runningSessionIds,
      acquireOwnership: async (id) => {
        const persistence = ctx.get('sessionPersistence')
        if (persistence === undefined) {
          throw new Error('browser bridge: session persistence is required to safely purge a session')
        }
        return persistence.open(id as Parameters<typeof persistence.open>[0], 'write')
      },
      archiveSession: async (id) => {
        const archived = await api.call({
          rpcId: randomUUID(),
          method: 'workspace.archiveSession',
          payload: { sessionId: id },
          signal: new AbortController().signal,
        })
        if (!archived.ok) throw new Error(archived.error.message)
      },
    }
    await purgeSessionFiles(deps, sessionId)
    // A purged session leaves its artifacts behind; sweep once so the cache
    // returns to budget with the session gone. The sweep reports its own
    // failures and never fails the purge.
    if (artifactRoot !== '') await sweepArtifactsOnce()
  }

  const server = new BridgeServer({
    token: tokenRes.token,
    api,
    toolTimeoutMs: resolved.toolTimeoutMs,
    caps: {
      textOnly: true,
      snapshotMaxChars: resolved.snapshotMaxChars,
      maxInteractiveItems: resolved.maxInteractiveItems,
    },
    injectBrowserSnapshot: (sessionId, snapshot) => { browserContext.inject(sessionId, snapshot) },
    purgeSession,
  })

  const route: WebUpgradeRoute = {
    path: BRIDGE_PATH,
    handler: (req, socket, head) => { server.handleUpgrade(req, socket, head) },
  }
  ctx.effect(() => ctx.webServer.registerUpgrade(route), 'bridge-browser: /ext/bridge upgrade route')
  // 异步 disposer：HMR/卸载时先等桥完全关闭（socket/泵/acceptor 静默）再继续。
  ctx.effect(() => () => server.close(), 'bridge-browser: bridge server')

  // Zero-config discovery endpoint: the extension fetches this to learn the
  // bridge WebSocket URL without any manual configuration. The URL carries no
  // secret (loopback connections skip the token); non-loopback deployments
  // keep requiring the token on the WS itself.
  const configRoute: WebRoute = {
    kind: 'exact',
    path: BRIDGE_CONFIG_PATH,
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${ctx.webServer.port}${BRIDGE_PATH}` }))
    },
  }
  ctx.effect(() => ctx.webServer.register(configRoute), 'bridge-browser: /ext/bridge-config route')

  ctx.effect(() => {
    const disposers = registerBrowserTools(ctx, server, {
      toolTimeoutMs: resolved.toolTimeoutMs,
      snapshotMaxChars: resolved.snapshotMaxChars,
      maxInteractiveItems: resolved.maxInteractiveItems,
      // Screenshots join the same artifact root the retention sweep owns, so
      // they share its byte/count/TTL budget and never need a second root.
      screenshotRoot: artifactRoot,
      artifactBoundary: artifactBoundaryConfig,
    })
    return () => { for (const dispose of disposers.values()) dispose() }
  }, 'bridge-browser: browser tools')

  // Optional system-prompt contribution: a one-line hint only — the model is
  // told to fetch snapshots on demand instead of hoarding page text.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'tool:bridge-browser',
      order: 107,
      text: 'A browser bridge may be connected. To read or operate the user\'s active browser page, call browser_snapshot '
        + '(text-only; numbered items are the click/type targets), unless the current turn already includes a plugin-provided '
        + 'followed-page browser_snapshot. Reuse that injected snapshot and its indices directly. Never assume page content you have not snapshotted.',
    }), 'bridge-browser: system prompt section')
  }

  ctx.logger.info(
    tokenRes.generated
      ? `browser bridge: new token generated and persisted at ${tokenRes.file} (chmod 0600); connect the extension and paste it in its settings`
      : `browser bridge: using token from ${tokenRes.file}`,
  )
  ctx.logger.info(`browser bridge: listening on ${BRIDGE_PATH}`)
}

type GatewayCandidate = Pick<TypertGatewayLike, 'invoke'> & {
  readonly wireStream?: TypertGatewayLike['wireStream']
}

/** Check the minimum supported Gateway contract before mounting the bridge. */
function hasRemoteWireStream(gateway: GatewayCandidate): gateway is TypertGatewayLike {
  return gateway.wireStream !== undefined
    && typeof gateway.wireStream.open === 'function'
    && typeof gateway.wireStream.failure === 'function'
}

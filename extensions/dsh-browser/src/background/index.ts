/**
 * Background service worker entry: owns the bridge connection, the gateway
 * RPC client, controlled-tab tool dispatch, and the panel port service.
 *
 * MV3 survival: after the user opens the panel, its port plus a half-minute
 * `alarms` keepalive re-arm the reconnect loop. Merely loading the extension
 * never probes or claims the single-connection bridge.
 *
 * Panel port protocol (chrome.runtime.connect, name "dsh-panel"):
 *   panel → bg: { type: 'rpc', id, method, payload }
 *   panel → bg: { type: 'respond', id, rpcId, result }
 *   panel → bg: { type: 'settings', id, settings: Partial<Settings> }
 *   panel → bg: { type: 'session.active', sessionId }
 *   panel → bg: { type: 'approval.response', id, decision }
 *   panel → bg: { type: 'tab-affinity.response', revision, decision, sessionId }
 *   panel → bg: { type: 'tab-affinity.rebind', id }
 *   panel → bg: { type: 'panel.window', windowId }
 *   panel → bg: { type: 'selection.clear', selection? }
 *   panel → bg: { type: 'request-status' }
 *   bg → panel: { type: 'rpc.result', id, ok, result? | error? }
 *   bg → panel: { type: 'respond.result', id, ok, result? | error? }
 *   bg → panel: { type: 'settings.result', id, ok, error? }
 *   bg → panel: { type: 'status', state: BridgeState, caps? }
 *   bg → panel: { type: 'event', frame: ServerFrame }
 *   bg → panel: { type: 'approval.request', request }
 *   bg → panel: { type: 'approval.resolved', id }
 *   bg → panel: { type: 'session.resume-hint', sessionId }
 *   bg → panel: { type: 'selection', selection }
 *   bg → panel: { type: 'tab-affinity', state }
 *   bg → panel: { type: 'tab-affinity.rebind.result', id, ok, error? }
 *
 * @module
 */

import {
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  isRespondResult,
  type BridgeCaps,
  type RespondResult,
} from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import type { ServerFrame } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { MAX_FRAME_BYTES, type ToolError } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { BRIDGE_CONFIG_PATH, BRIDGE_PATH } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { BRIDGE_LOG_NAMESPACE, BridgeClient, type BridgeState } from './bridge.ts'
import { createRpc } from './rpc.ts'
import {
  dispatchOpenTab,
  dispatchToolCall,
  isNavigationCandidateTool,
  isTabManagementTool,
  resetTabSnapshot,
  type ToolAnswer,
  type ToolCall,
} from './tools.ts'
import {
  isApprovalDecision,
  type ApprovalAuthorization,
  type ApprovalPrompt,
  type ApprovalRequest,
} from '../security/approval.ts'
import { getUiLocale } from '../i18n.ts'
import {
  OFFSCREEN_GIF_MESSAGE,
  OFFSCREEN_GIF_SWEPT_MESSAGE,
  RecordingBuffer,
  recordingStatus,
  type RecordingStatus,
} from '../content/recorder.ts'
import { bumpEvent, eventCounters } from './events.ts'
import { InteractionResponseRouter } from './responses.ts'
import { normalizeToolError } from './error-map.ts'
import {
  ackScreencastFrame,
  forgetTab,
  isDebuggerAvailable,
  noteTabNavigation,
  recordInstrumentEntry,
  releaseTab,
  setDebuggerDetachSink,
  setScreencastFrameSink,
  startScreencast,
  stopScreencast,
} from './cdp.ts'
import {
  LIVE_VIEW_MAX_HEIGHT,
  LIVE_VIEW_MAX_WIDTH,
  LiveViewController,
  type LiveViewFrame,
} from './live-view.ts'
import { isInstrumentEntry } from '../content/instrument.ts'
import {
  actionCoveredByTrustedOrigins,
  normalizeTrustedOrigin,
} from '../security/trusted-origins.ts'
import { isCrossOriginPrompt } from './authorization.ts'
import { TransientEventCache } from './transient-events.ts'
import {
  TabAffinityController,
  isTabAffinityDecision,
  type AffinityTab,
  type TabAffinityDecision,
} from './tab-affinity.ts'
import { bindOpenedTabAffinity } from './open-tab-binding.ts'
import { FocusedWindowTracker } from './focused-window.ts'
import { SelectionTracker, type SelectionSource } from './selection.ts'
import { parsePageSelection, parseSelectionCapture } from '../selection.ts'
import { ApprovalCoordinator, type ApprovalRequestResult } from './approval-coordinator.ts'
import {
  LEGACY_RECENT_SESSION_STORAGE_KEY,
  PAGE_SESSION_CONTEXT_STORAGE_KEY,
  PageSessionContextTracker,
} from './session-continuity.ts'

/** User settings persisted in chrome.storage.local. */
export interface Settings {
  bridgeUrl: string
  token: string
  sharePageContent: 'ask' | 'auto' | 'off'
  /** Allow every browser operation without an approval prompt. */
  unrestrictedBrowserAccess: boolean
  /** Origins whose state-changing actions may run without another prompt. */
  trustedActionOrigins: string[]
  /** Show an OS notification when no side panel can display an approval. */
  approvalNotifications: boolean
  /** Restore the current tab and page path's conversation when the panel reopens. */
  autoResumeSession: boolean
  /** Where work is shown: toolbar badge only, badge plus in-page dot, or nowhere. */
  indicatorMode: IndicatorMode
  /** Refuse browser tools aimed at tabs this session never bound, opened, or followed. */
  tabIsolation: boolean
  /** Keep the service worker warm through the offscreen heartbeat while a panel is open. */
  keepAliveEnabled: boolean
}

/** Visible-work surfaces the user may choose between. */
export type IndicatorMode = 'badge-overlay' | 'off'

const SETTINGS_DEFAULTS: Settings = {
  // 空地址 = 自动探测本机 dsh（零配置）；手动填地址时优先手动。
  bridgeUrl: '',
  token: '',
  sharePageContent: 'auto',
  unrestrictedBrowserAccess: false,
  trustedActionOrigins: [],
  approvalNotifications: true,
  autoResumeSession: true,
  indicatorMode: 'badge-overlay',
  tabIsolation: true,
  keepAliveEnabled: true,
}

/**
 * 自动探测的候选端口：
 * - dsh web（CLI）默认 3080，端口被占时依次回退 3081 / 3090；
 * - DSH Desktop 默认由系统随机分配本地 Web 端口（`dsh-desktop.port: 0`），
 *   用户指南推荐固定为 43189（见 deepseek-harness-desktop docs/user-guide）；
 * - 14389 为历史桌面应用端口，保留兼容旧版。
 */
const DISCOVERY_PORTS = [3080, 3081, 3090, 14389, 43189]
const LEGACY_LOCAL_URL = 'ws://127.0.0.1:3080'

/** 探测本机 dsh 的桥地址：fetch /ext/bridge-config 直到成功。 */
async function discoverBridge(shouldContinue: () => boolean = () => true): Promise<string | undefined> {
  for (const port of DISCOVERY_PORTS) {
    if (!shouldContinue()) return undefined
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ext/bridge-config`, {
        signal: AbortSignal.timeout(1_500),
      })
      if (!shouldContinue()) return undefined
      if (!response.ok) continue
      const body = await response.json() as { wsUrl?: unknown }
      if (typeof body.wsUrl === 'string' && body.wsUrl.startsWith('ws://')) return body.wsUrl
    } catch {
      // 该端口没有 dsh 或未挂桥：试下一个。
    }
  }
  return undefined
}

/** Avoid opening a noisy loopback WebSocket until the local bridge responds. */
async function probeBridge(url: string): Promise<boolean> {
  try {
    const target = new URL(url)
    if (target.hostname !== '127.0.0.1') return true
    target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'
    target.pathname = BRIDGE_CONFIG_PATH
    target.search = ''
    target.hash = ''
    const response = await fetch(target, { signal: AbortSignal.timeout(1_500) })
    if (!response.ok) return false
    const body = await response.json() as { wsUrl?: unknown }
    return typeof body.wsUrl === 'string' && body.wsUrl.startsWith('ws://')
  } catch {
    return false
  }
}

const STORAGE_KEY = 'dshSettings'
const TAB_AFFINITY_STORAGE_KEY = 'dshTabAffinity'

type StoredTabAffinity =
  | { controlledTabId: number; keptActiveTabId?: number; pinned?: true; sessionTabs?: Record<string, AffinityTab>; focusedSessionId?: string }
  | { lost: true; sessionTabs?: Record<string, AffinityTab>; focusedSessionId?: string }

let settings: Settings = { ...SETTINGS_DEFAULTS }
let unrestrictedAccessActive = SETTINGS_DEFAULTS.unrestrictedBrowserAccess
let unrestrictedAccessRevision = 0
let unrestrictedRevocation: Promise<void> | undefined
let settingsPersistence = Promise.resolve()
let caps: BridgeCaps | null = null
let bridge: BridgeClient | null = null
let rpc: ReturnType<typeof createRpc> | null = null
const panelPorts = new Set<chrome.runtime.Port>()
/** Panels that turned their live view on; the stream runs while this is non-empty. */
const liveViewPorts = new Set<chrome.runtime.Port>()
const BRIDGE_KEEPALIVE_ALARM = 'bridge-keepalive'
/** Invalidates an asynchronous discovery attempt when its panel lease ends. */
let bridgeStartRevision = 0
const interactionResponses = new InteractionResponseRouter()
const transientEvents = new TransientEventCache()
const tabAffinity = new TabAffinityController()
// A tab whose ownership is released (closed, replaced, or dropped with the
// connection) must not keep a debugger session attached to it. Only the tab's
// closing or the session ending discards its console and network history.
tabAffinity.onOwnershipReleased = (tabId) => { releaseTab(tabId) }
const focusedWindow = new FocusedWindowTracker()
const selections = new SelectionTracker()
const pageSessionContexts = new PageSessionContextTracker({
  read: async () => (await chrome.storage.session.get(PAGE_SESSION_CONTEXT_STORAGE_KEY))[PAGE_SESSION_CONTEXT_STORAGE_KEY],
  write: async (value) => {
    await chrome.storage.session.set({ [PAGE_SESSION_CONTEXT_STORAGE_KEY]: value })
  },
})
void chrome.storage.session.remove(LEGACY_RECENT_SESSION_STORAGE_KEY).catch(() => {})
/** Ephemeral allowlist: cleared when the last side panel closes or this worker restarts. */
const sessionTrustedActionOrigins = new Set<string>()
/** Tool calls that are either withdrawable or completing an already-dispatched action. */
interface ActiveToolCall {
  controller: AbortController
  unrestrictedAccess: boolean
  committed: boolean
  revocationRequested: boolean
  settled: Promise<void>
  settle: () => void
}

const activeToolCalls = new Map<string, ActiveToolCall>()
/** Disconnection drops result ownership, but dispatched operations must still settle before revocation. */
const unsettledToolCalls = new Set<ActiveToolCall>()
let lastPersistedAffinity: string | undefined
let affinityPersistence = Promise.resolve()
/** Per-session snapshot refreshes preserve prompt ordering without cross-session cancellation. */
const sessionSnapshotRefreshes = new Map<string, Promise<void>>()
interface ActiveFollowRefresh {
  controller: AbortController
  unrestrictedAccess: boolean
  settled: Promise<void>
  settle: () => void
}

const activeFollowRefreshes = new Map<string, ActiveFollowRefresh>()
const TAB_AFFINITY_REBIND_TIMEOUT_MS = 10_000

class TabAffinityRebindError extends Error {
  constructor(readonly code: 'no-active-tab' | 'timeout' | 'cancelled', message: string) {
    super(message)
    this.name = 'TabAffinityRebindError'
  }
}

function rebindAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new TabAffinityRebindError('cancelled', getUiLocale() === 'zh' ? '标签页绑定已取消' : 'Tab binding was cancelled')
}

function throwIfRebindAborted(signal: AbortSignal): void {
  if (signal.aborted) throw rebindAbortReason(signal)
}

/** Reject promptly on cancellation while safely consuming a late Chrome promise. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(rebindAbortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(rebindAbortReason(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(rebindAbortReason(signal))
        else resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const loaded = normalizeSettings({ ...SETTINGS_DEFAULTS, ...(stored[STORAGE_KEY] as Partial<Settings> | undefined) })
  if (loaded.bridgeUrl === LEGACY_LOCAL_URL || loaded.bridgeUrl === `${LEGACY_LOCAL_URL}/`) {
    loaded.bridgeUrl = ''
    await chrome.storage.local.set({ [STORAGE_KEY]: loaded })
  }
  return loaded
}

async function persistSettings(next: Partial<Settings>): Promise<void> {
  const changesUnrestrictedAccess = typeof next.unrestrictedBrowserAccess === 'boolean'
  const accessRevision = changesUnrestrictedAccess ? ++unrestrictedAccessRevision : unrestrictedAccessRevision
  const updated = normalizeSettings({ ...settings, ...next })
  const revokesUnrestrictedAccess = settings.unrestrictedBrowserAccess && !updated.unrestrictedBrowserAccess
  settings = updated
  if (!updated.unrestrictedBrowserAccess) unrestrictedAccessActive = false
  syncSelectionWatch()
  let accessTransition: Promise<void> | undefined
  if (revokesUnrestrictedAccess) {
    let trackedRevocation!: Promise<void>
    trackedRevocation = revokeUnrestrictedAccess().finally(() => {
      if (unrestrictedRevocation !== trackedRevocation) return
      unrestrictedRevocation = undefined
      syncSelectionWatch()
    })
    unrestrictedRevocation = trackedRevocation
    accessTransition = trackedRevocation
  } else if (unrestrictedRevocation !== undefined) {
    accessTransition = unrestrictedRevocation
  }
  const persisted = updated
  const write = settingsPersistence.then(async () => {
    await accessTransition
    await chrome.storage.local.set({ [STORAGE_KEY]: persisted })
  })
  settingsPersistence = write.catch(() => {})
  await write
  if (changesUnrestrictedAccess
    && accessRevision === unrestrictedAccessRevision
    && settings.unrestrictedBrowserAccess
    && persisted.unrestrictedBrowserAccess
    && unrestrictedRevocation === undefined) {
    unrestrictedAccessActive = true
    syncSelectionWatch()
  }
}

function normalizeSettings(candidate: Settings): Settings {
  const trusted = Array.isArray(candidate.trustedActionOrigins)
    ? [...new Set(candidate.trustedActionOrigins.map(normalizeTrustedOrigin).filter((entry): entry is string => entry !== undefined))].sort()
    : []
  const sharePageContent = candidate.sharePageContent === 'auto' || candidate.sharePageContent === 'off'
    ? candidate.sharePageContent
    : candidate.sharePageContent === 'ask' ? 'ask' : 'auto'
  return {
    ...candidate,
    sharePageContent,
    unrestrictedBrowserAccess: candidate.unrestrictedBrowserAccess === true,
    trustedActionOrigins: trusted,
    approvalNotifications: candidate.approvalNotifications !== false,
    autoResumeSession: candidate.autoResumeSession !== false,
    // The dot is the only visible-work surface that shows WHERE work happens,
    // and there is no settings surface to switch it back on, so any legacy
    // `badge` (or absent) value resolves to the overlay. `off` stays honoured.
    indicatorMode: candidate.indicatorMode === 'off' ? 'off' : 'badge-overlay',
    tabIsolation: candidate.tabIsolation !== false,
    keepAliveEnabled: candidate.keepAliveEnabled !== false,
  }
}

/** Settings load is shared by every lazy connection trigger. */
let settingsLoaded = false
const settingsReady = loadSettings().then((loaded) => {
  settings = loaded
  unrestrictedAccessActive = loaded.unrestrictedBrowserAccess
  settingsLoaded = true
})

function armBridgeKeepalive(): void {
  chrome.alarms.create(BRIDGE_KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
  void syncOffscreenKeepAlive()
}

function disarmBridgeKeepalive(): void {
  void Promise.resolve(chrome.alarms.clear(BRIDGE_KEEPALIVE_ALARM)).catch(() => {})
  // The lease is over: the heartbeat document must not outlive it, otherwise
  // the service worker would never sleep again in this browser session.
  void syncOffscreenKeepAlive()
}

/**
 * Last `SW_KEEPALIVE` from the offscreen document. Kept in memory only: it is
 * a liveness hint for the current worker generation, never durable state.
 */
let lastKeepAliveAt = 0

/**
 * Record one offscreen keepalive.
 * @param at - observation time (injectable for tests).
 * @returns the recorded timestamp.
 */
export function noteSwKeepAlive(at: number = Date.now()): number {
  lastKeepAliveAt = at
  return lastKeepAliveAt
}

/** Timestamp of the last offscreen keepalive, or 0 before the first one. */
export function swKeepAliveAt(): number {
  return lastKeepAliveAt
}

/** Outbound-silence window after which the heartbeat document is released. */
export const KEEPALIVE_IDLE_MS = 5 * 60_000

/** Last tool call or live connection change; the idle window starts here. */
let lastToolActivityAt = 0

/** Record that the bridge just did real work, which extends the idle window. */
function noteToolActivity(): void {
  lastToolActivityAt = Date.now()
}

/**
 * Whether the service worker still needs the offscreen heartbeat.
 * @returns true only while a panel, a recording, an in-flight call, the recent
 *   activity window, or a just-finished export needs the worker awake.
 */
export function keepAliveWanted(): boolean {
  // The recording encoder lives in the same document, so a recording needs it
  // regardless of the keepalive toggle; `keepAliveEnabled` only controls the
  // worker-warming lease, never the encoder.
  if (recording !== null) return true
  // A just-exported recording keeps its blob URL alive for the download; the
  // document that owns it must survive until that grace period ends.
  const clearedAt = lastRecordingOutcome.clearedAt
  if (clearedAt !== undefined && Date.now() - clearedAt < RECORDING_BLOB_GRACE_MS) return true
  if (!settings.keepAliveEnabled) return false
  if (panelPorts.size > 0) return true
  if (activeToolCalls.size > 0) return true
  // A live socket is deliberately not part of the lease: a panel closing keeps
  // the socket open (suspendReconnect), so counting the connection would keep
  // the heartbeat document alive forever and the worker would never sleep.
  // Without a panel the half-minute alarm re-arms the reconnect loop instead.
  return lastToolActivityAt > 0 && Date.now() - lastToolActivityAt < KEEPALIVE_IDLE_MS
}

/** How long an exported recording's blob URL needs its offscreen document. */
const RECORDING_BLOB_GRACE_MS = 120_000

/** Periodic lease re-evaluation while the heartbeat document exists. */
let keepaliveSweep: ReturnType<typeof setInterval> | undefined

function startKeepaliveSweep(): void {
  if (keepaliveSweep !== undefined) return
  keepaliveSweep = setInterval(() => { void syncOffscreenKeepAlive() }, 30_000)
}

function stopKeepaliveSweep(): void {
  if (keepaliveSweep === undefined) return
  clearInterval(keepaliveSweep)
  keepaliveSweep = undefined
}

/**
 * Create or release the offscreen heartbeat document to match the lease.
 *
 * The document keeps the MV3 worker warm, so it may exist only while a panel,
 * a recording, an in-flight tool call, or a live connection needs it; once the
 * lease ends it is closed so the worker can sleep again. Firefox has no
 * offscreen API: there the half-minute alarm is the only keepalive.
 */
async function syncOffscreenKeepAlive(): Promise<void> {
  const offscreen = chrome.offscreen
  if (offscreen === undefined
    || typeof offscreen.createDocument !== 'function'
    || typeof offscreen.closeDocument !== 'function') return
  const wanted = keepAliveWanted()
  try {
    const open = typeof offscreen.hasDocument === 'function' ? await offscreen.hasDocument() : false
    if (wanted && !open) {
      await offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS' as chrome.offscreen.Reason],
        justification: 'Keep the MV3 service worker warm while a side panel lease is open.',
      })
    } else if (!wanted && open) {
      // Ask the document to stop ticking before teardown. The literal mirrors
      // SW_KEEPALIVE_STOP_MESSAGE in src/offscreen/index.ts; importing that
      // module here would pull its DOM/worker code into the service worker.
      await chrome.runtime.sendMessage({ type: 'SW_KEEPALIVE_STOP' }).catch(() => {})
      await offscreen.closeDocument()
    }
    if (wanted) startKeepaliveSweep()
    else stopKeepaliveSweep()
  } catch {
    /* A concurrent create/close already decided the document, or this build has
       no page; the half-minute alarm still re-arms the reconnect loop. */
  }
}

// ---- Recording: tab frames → offscreen GIF ----

/** Capture cadence while a recording is active. */
export const RECORDING_CAPTURE_INTERVAL_MS = 1_000
/** Chrome allows two visible-tab captures per second; stay under that. */
export const RECORDING_MIN_CAPTURE_GAP_MS = 500

interface RecordingState {
  buffer: RecordingBuffer
  /** Window whose visible tab is captured; the panel reporting it owns the lease. */
  windowId: number
  timer: ReturnType<typeof setInterval>
  lastCaptureAt: number
  exporting: boolean
}

/** Active recording, or null when no recording is running. */
let recording: RecordingState | null = null
/** Outcome of the last recording, kept after its frames are released. */
let lastRecordingOutcome: Pick<RecordingStatus, 'clearedAt' | 'filename'> = {}

/** Panel-facing recording state, including the last export outcome. */
export function currentRecordingStatus(): RecordingStatus {
  const state = recording
  if (state === null) {
    return recordingStatus(false, { frames: 0, bytes: 0, dropped: 0, expired: 0 }, lastRecordingOutcome)
  }
  const status = recordingStatus(!state.exporting, state.buffer.stats, lastRecordingOutcome)
  return state.exporting ? { ...status, exporting: true } : status
}

/** Push the current recording state to every panel. */
function broadcastRecording(error?: string): void {
  const payload = {
    type: 'recording',
    status: currentRecordingStatus(),
    ...(error === undefined ? {} : { error }),
  }
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

/** Push the local event counters to every panel. */
function broadcastDiagnostics(): void {
  const payload = { type: 'diagnostics', counts: eventCounters.snapshot() }
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

/** Read the recorded page's viewport metrics; missing metrics fall back to the tab. */
async function readViewportMetrics(tabId: number | undefined, tab: chrome.tabs.Tab | undefined): Promise<{
  viewportWidth: number
  viewportHeight: number
  devicePixelRatio: number
}> {
  const fallback = {
    viewportWidth: tab?.width ?? 0,
    viewportHeight: tab?.height ?? 0,
    devicePixelRatio: 1,
  }
  if (tabId === undefined) return fallback
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      }),
    })
    const measured = injected?.result
    if (measured === undefined) return fallback
    return { viewportWidth: measured.width, viewportHeight: measured.height, devicePixelRatio: measured.devicePixelRatio }
  } catch {
    // Restricted pages cannot be scripted; the tab rectangle still describes the frame.
    return fallback
  }
}

/**
 * Capture one frame of the recording window's visible tab.
 *
 * Failures are silent by design: a recording must never break the tool call
 * that triggered the capture, and restricted pages simply contribute no frame.
 * @param action - tool name, or `timer` for cadence frames.
 */
async function captureRecordingFrame(action: string): Promise<void> {
  const state = recording
  if (state === null || state.exporting) return
  const at = Date.now()
  if (at - state.lastCaptureAt < RECORDING_MIN_CAPTURE_GAP_MS) return
  state.lastCaptureAt = at
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId: state.windowId })
    const metrics = await readViewportMetrics(tab?.id, tab)
    const dataUrl = await chrome.tabs.captureVisibleTab(state.windowId, { format: 'png' })
    const separator = dataUrl.indexOf(',')
    if (separator < 0) return
    if (recording !== state) return
    state.buffer.push({ base64: dataUrl.slice(separator + 1), action, ...metrics }, at)
  } catch {
    /* Capture throttling, a restricted page, or a closing window: skip. */
  }
  broadcastRecording()
}

/** Start recording the visible tab of one window. */
function startRecording(windowId: number): void {
  if (recording !== null || windowId < 0) {
    broadcastRecording()
    return
  }
  lastRecordingOutcome = {}
  const state: RecordingState = {
    buffer: new RecordingBuffer(),
    windowId,
    lastCaptureAt: 0,
    exporting: false,
    timer: setInterval(() => { void captureRecordingFrame('timer') }, RECORDING_CAPTURE_INTERVAL_MS),
  }
  recording = state
  void syncOffscreenKeepAlive()
  bumpEvent('recording.started')
  broadcastRecording()
  void captureRecordingFrame('start')
}

/** Release the frames without producing a file. */
function clearRecording(): void {
  const state = recording
  if (state !== null) {
    clearInterval(state.timer)
    state.buffer.clear()
    recording = null
    void syncOffscreenKeepAlive()
  }
  if (state !== null || lastRecordingOutcome.clearedAt !== undefined) {
    lastRecordingOutcome = { clearedAt: Date.now() }
    bumpEvent('recording.cleared')
  }
  broadcastRecording()
}

/** Encode the captured frames offscreen and download the GIF. */
async function exportRecording(): Promise<void> {
  const state = recording
  if (state === null || state.exporting) return
  const frames = state.buffer.frames()
  if (frames.length === 0) {
    broadcastRecording(getUiLocale() === 'zh' ? '还没有录制到画面' : 'Nothing has been recorded yet')
    return
  }
  state.exporting = true
  clearInterval(state.timer)
  broadcastRecording()
  try {
    await syncOffscreenKeepAlive()
    const reply = await chrome.runtime.sendMessage({
      type: OFFSCREEN_GIF_MESSAGE,
      frames: frames.map((frame) => ({ base64: frame.base64, delayMs: frame.delay })),
    }) as { ok?: unknown; filename?: unknown; error?: unknown } | undefined
    if (reply?.ok !== true) {
      throw new Error(typeof reply?.error === 'string' ? reply.error : 'The GIF could not be written')
    }
    bumpEvent('recording.exported')
    lastRecordingOutcome = {
      clearedAt: Date.now(),
      ...(typeof reply.filename === 'string' ? { filename: reply.filename } : {}),
    }
    state.buffer.clear()
    recording = null
    bumpEvent('recording.cleared')
    broadcastRecording()
  } catch (cause) {
    // Keep the frames so the user can retry after the cause is fixed.
    state.exporting = false
    state.timer = setInterval(() => { void captureRecordingFrame('timer') }, RECORDING_CAPTURE_INTERVAL_MS)
    broadcastRecording(cause instanceof Error ? cause.message : String(cause))
  }
  broadcastDiagnostics()
}

function broadcastStatus(): void {
  const payload = { type: 'status', state: bridge?.state ?? ('stopped' as BridgeState), caps }
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

function broadcastTabAffinity(): void {
  const payload = { type: 'tab-affinity', state: tabAffinity.snapshot() }
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
  syncLiveView()
}

/** Send the current live-view state to every panel. */
function broadcastLiveView(): void {
  const payload = { type: 'live-view-state', state: liveView.state() }
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

/** Send one screencast frame to the panels that turned the live view on. */
function broadcastLiveFrame(frame: LiveViewFrame): void {
  const payload = { type: 'live-frame', ...frame }
  for (const port of liveViewPorts) {
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

const liveView = new LiveViewController({
  isDebuggerAvailable,
  isOwnPage: async (tabId: number): Promise<boolean> => {
    try {
      const tab = await chrome.tabs.get(tabId)
      return (tab.url ?? '').startsWith(chrome.runtime.getURL(''))
    } catch {
      return false
    }
  },
  isTabActive: async (tabId: number): Promise<boolean> => {
    try {
      const tab = await chrome.tabs.get(tabId)
      return tab.active === true
    } catch {
      return false
    }
  },
  startScreencast: (tabId, options) => startScreencast(tabId, options),
  stopScreencast: (tabId) => stopScreencast(tabId),
  ackFrame: (tabId, sessionId) => ackScreencastFrame(tabId, sessionId),
  onState: broadcastLiveView,
  onFrame: broadcastLiveFrame,
  viewport: () => ({ width: LIVE_VIEW_MAX_WIDTH, height: LIVE_VIEW_MAX_HEIGHT }),
})

setScreencastFrameSink((tabId, params) => { liveView.handleFrame(tabId, params) })
setDebuggerDetachSink((tabId) => { liveView.handleDetach(tabId) })

/** Point the live view at the tab the affinity state currently controls. */
function syncLiveView(): void {
  void liveView.setTarget(tabAffinity.snapshot().controlled?.tabId)
}

// ---- Visible work: toolbar badge, tab group, in-page dot ----

/** Filled dot shown while a tool call runs; cleared when the connection idles. */
const WORK_BADGE_TEXT = '●'
const WORK_BADGE_BACKGROUND = '#4d6bfe'
const WORK_BADGE_FOREGROUND = '#ffffff'
const TAB_GROUP_TITLE = 'DSH'
/**
 * Titles this extension has used. A group labelled by an older build still
 * belongs to us, so a new tab joins it instead of starting a second group.
 */
const TAB_GROUP_TITLES: readonly string[] = [TAB_GROUP_TITLE, 'DSH Browser']
/** Chrome's sentinel for "this tab is not in any group". */
const TAB_GROUP_NONE = -1
/** Groups this connection labelled; user-owned groups are never restyled. */
const labelledTabGroups = new Set<number>()
/** Windows whose groups already went through the one-time merge. */
const mergedGroupWindows = new Set<number>()
/** Tabs currently carrying a live dot, so a mode switch cannot leave one behind. */
const dotTabs = new Set<number>()
let badgeActive = false

function overlayEnabled(): boolean {
  return settings.indicatorMode === 'badge-overlay'
}

/**
 * Paint or clear the toolbar badge.
 *
 * Chrome omits `chrome.action` in Firefox builds and in some test harnesses,
 * so a missing API leaves the rest of the visibility path untouched.
 * @param active - whether browser work is currently running.
 */
function setWorkBadge(active: boolean): void {
  const next = settings.indicatorMode === 'off' ? false : active
  if (next === badgeActive) return
  badgeActive = next
  const action = chrome.action
  if (action === undefined || typeof action.setBadgeText !== 'function') return
  try {
    void Promise.resolve(action.setBadgeText({ text: next ? WORK_BADGE_TEXT : '' })).catch(() => {})
    if (!next) return
    void Promise.resolve(action.setBadgeBackgroundColor({ color: WORK_BADGE_BACKGROUND })).catch(() => {})
    if (typeof action.setBadgeTextColor === 'function') {
      void Promise.resolve(action.setBadgeTextColor({ color: WORK_BADGE_FOREGROUND })).catch(() => {})
    }
  } catch {
    // A build without badge colours still shows or clears the dot text.
  }
}

/**
 * Every group in one window that this extension created.
 *
 * Titles are the only durable marker Chrome keeps across service-worker
 * restarts, so both the current title and the one older builds wrote count.
 * @param windowId - window whose groups to read.
 * @returns the matching groups, oldest first, or an empty list.
 */
async function ownGroups(windowId: number): Promise<chrome.tabGroups.TabGroup[]> {
  const groups = chrome.tabGroups as typeof chrome.tabGroups | undefined
  if (groups === undefined || typeof groups.query !== 'function') return []
  const found: chrome.tabGroups.TabGroup[] = []
  for (const title of TAB_GROUP_TITLES) {
    try {
      found.push(...await groups.query({ windowId, title }))
    } catch {
      // A build without tab-group queries simply skips grouping.
    }
  }
  return found.sort((left, right) => left.id - right.id)
}

/**
 * Fold groups left by earlier sessions into one, so the window shows a single
 * label instead of one group per grouping call.
 * @param windowId - window to consolidate.
 */
async function mergeOwnGroups(windowId: number): Promise<void> {
  if (mergedGroupWindows.has(windowId)) return
  mergedGroupWindows.add(windowId)
  const groups = chrome.tabGroups as typeof chrome.tabGroups | undefined
  if (groups === undefined || typeof groups.update !== 'function') return
  const mine = await ownGroups(windowId)
  const keeper = mine[0]
  if (keeper === undefined) return
  for (const group of mine.slice(1)) {
    try {
      const members = await chrome.tabs.query({ groupId: group.id })
      const tabIds = members.flatMap((tab) => (tab.id === undefined ? [] : [tab.id]))
      if (tabIds.length === 0) continue
      await chrome.tabs.group({ tabIds, groupId: keeper.id })
      labelledTabGroups.add(keeper.id)
    } catch {
      // A group that vanished mid-merge leaves the rest untouched.
    }
  }
  try {
    await groups.update(keeper.id, { title: TAB_GROUP_TITLE, color: 'blue' })
  } catch {
    // Chrome removed the keeper; nothing left to retitle.
  }
}

/**
 * Put the worked tab in a `DSH Browser` group so the user can see what runs.
 *
 * A tab the user already grouped keeps its own group: silently retitling a
 * user's group would be worse than showing no group at all.
 * @param tabId - the tab a tool call is operating.
 */
async function labelWorkTabGroup(tabId: number): Promise<void> {
  if (settings.indicatorMode === 'off') return
  const tabs = chrome.tabs as typeof chrome.tabs & {
    group?: (options: { tabIds: number[]; groupId?: number }) => Promise<number>
  }
  const groups = chrome.tabGroups as typeof chrome.tabGroups | undefined
  if (tabs.group === undefined || groups === undefined || typeof groups.update !== 'function') return
  try {
    const tab = await chrome.tabs.get(tabId)
    void mergeOwnGroups(tab.windowId)
    const current = typeof tab.groupId === 'number' ? tab.groupId : TAB_GROUP_NONE
    let groupId: number | undefined
    if (current >= 0) {
      if (labelledTabGroups.has(current)) groupId = current
    } else {
      // Join the group this extension already owns in the window; asking Chrome
      // to group a lone tab would open a second group beside it.
      const existing = (await ownGroups(tab.windowId))[0]
      const created = existing === undefined
        ? await tabs.group({ tabIds: [tabId] })
        : await tabs.group({ tabIds: [tabId], groupId: existing.id })
      groupId = typeof created === 'number' ? created : undefined
    }
    if (groupId === undefined || groupId < 0) return
    labelledTabGroups.add(groupId)
    await groups.update(groupId, { title: TAB_GROUP_TITLE, color: 'blue' })
  } catch {
    // Grouping is cosmetic; a Chrome build without tab groups must not fail a tool call.
  }
}

/** Drop labels from groups that no longer hold an owned tab. */
async function clearIdleTabGroups(): Promise<void> {
  const groups = chrome.tabGroups as typeof chrome.tabGroups | undefined
  const pending = [...labelledTabGroups]
  labelledTabGroups.clear()
  if (groups === undefined || typeof groups.update !== 'function') return
  for (const groupId of pending) {
    try {
      await groups.update(groupId, { title: '' })
    } catch {
      // Chrome already removed the group, or the tab left it.
    }
  }
}

/**
 * Drive the in-page dot for one tab.
 *
 * `off` is always delivered so a page that still holds a dot can remove it,
 * even after the user switches the overlay off.
 * @param tabId - target tab, when one is known.
 * @param state - requested dot state.
 */
async function postIndicatorState(tabId: number | undefined, state: 'static' | 'pulsing' | 'off'): Promise<void> {
  if (tabId === undefined) return
  if (state !== 'off' && !overlayEnabled()) return
  if (state === 'off') dotTabs.delete(tabId)
  else dotTabs.add(tabId)
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'DSH_INDICATOR', state })
  } catch {
    // The tab is gone, protected, or has no content script yet.
  }
}

/** Tab that currently receives visible feedback, when one is resolvable. */
function workTabId(): number | undefined {
  const resolution = tabAffinity.resolveTarget()
  return resolution.kind === 'target' ? resolution.tab.tabId : tabAffinity.snapshot().controlled?.tabId
}

/**
 * Show or stop showing active work.
 * @param active - true while a tool call runs on `tabId`.
 * @param tabId - tab the call operates; defaults to the controlled tab.
 */
function setWorkVisibility(active: boolean, tabId?: number): void {
  const target = tabId ?? workTabId()
  setWorkBadge(active)
  if (active) {
    if (target !== undefined) void labelWorkTabGroup(target)
    void postIndicatorState(target, 'pulsing')
    return
  }
  if (overlayEnabled()) void postIndicatorState(target, 'static')
  else if (target !== undefined && dotTabs.has(target)) void postIndicatorState(target, 'off')
}

/** Run one dispatch between the two visible-work edges. */
async function withWorkVisibility<T>(tabId: number | undefined, run: () => Promise<T>): Promise<T> {
  setWorkVisibility(true, tabId)
  try {
    return await run()
  } finally {
    setWorkVisibility(false, tabId)
  }
}

/**
 * Drop every connection-scoped trace of work.
 *
 * Called when the bridge connection ends or the last panel closes: the badge,
 * the in-page dot, the owned-tab set, and the labels on now-idle tab groups all
 * belong to the connection that just ended.
 * @param reason - which ending observed the reset (for logs and tests).
 */
/**
 * Re-claim the tabs the affinity controller still controls.
 *
 * The controlled tab and every session binding survive a socket generation, so
 * a reconnect must restore their ownership; otherwise a healthy binding would
 * look like a foreign tab to tab isolation.
 */
function claimEstablishedBindings(): void {
  const state = tabAffinity.snapshot()
  if (state.controlled !== null) tabAffinity.claimTab(state.controlled.tabId, 'bound')
  for (const tab of Object.values(tabAffinity.sessionMap())) tabAffinity.claimTab(tab.tabId, 'bound')
}

function resetSessionScopedState(reason: 'disconnected'): void {
  const owned = new Set([...tabAffinity.ownedTabOrigins().map((entry) => entry.tabId), ...dotTabs])
  setWorkBadge(false)
  // A debugger session is session-scoped: ending the session must release
  // every attached tab and drop its in-memory telemetry.
  for (const tabId of owned) {
    void postIndicatorState(tabId, 'off')
    forgetTab(tabId)
  }
  tabAffinity.clearOwnedTabs()
  void clearIdleTabGroups()
  console.log(`browser: session-scoped visibility reset (${reason})`)
}

/** Which window each panel port belongs to, so a quote stays in its window. */
const panelWindows = new WeakMap<chrome.runtime.Port, number>()
/** The conversation each live panel is displaying, used for close checkpoints. */
const panelActiveSessions = new WeakMap<chrome.runtime.Port, string>()

/**
 * Send one window's selection to that window's panels only.
 *
 * A panel must never be offered a quote from a page its own window is not
 * looking at, which also keeps an incognito window's highlight out of a
 * normal window's composer.
 */
function broadcastSelection(windowId: number): void {
  const payload = { type: 'selection', selection: selections.current(windowId) }
  for (const port of panelPorts) {
    if (panelWindows.get(port) !== windowId) continue
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

function broadcastSelections(windowIds: readonly number[]): void {
  for (const windowId of windowIds) broadcastSelection(windowId)
}

/** Whether a window currently has a panel that can display its selection. */
function hasPanelInWindow(windowId: number): boolean {
  for (const port of panelPorts) {
    if (panelWindows.get(port) === windowId) return true
  }
  return false
}

/**
 * Tell a frame its quote is gone so re-selecting the same passage reports it
 * again; the content script deduplicates against the last text it sent.
 */
function resetSelectionDedupe(sources: readonly SelectionSource[]): void {
  for (const { tabId, frameId } of sources) {
    void Promise.resolve(chrome.tabs.sendMessage(
      tabId,
      { type: 'DSH_SELECTION_RESET' },
      { frameId },
    ))
      .catch(() => { /* no content script in this tab */ })
  }
}

/** Whether saved privacy settings currently allow page-selection capture. */
function selectionSharingEnabled(): boolean {
  // Until storage answers, `settings` still holds the defaults. Reporting the
  // default here would arm watchers for a user whose saved choice is `off`.
  return settingsLoaded && (unrestrictedAccessEnabled() || settings.sharePageContent !== 'off')
}

/** Whether unrestricted access is enabled and no earlier grant is still being revoked. */
function unrestrictedAccessEnabled(): boolean {
  return unrestrictedAccessActive && unrestrictedRevocation === undefined
}

/** Page selections are captured only in a window with an open panel. */
function selectionWatchEnabled(windowId: number): boolean {
  return selectionSharingEnabled() && hasPanelInWindow(windowId)
}

let selectionWatchArmed = false
/** Distinguishes revisions issued by different MV3 worker lifetimes. */
const selectionWatchEpoch = crypto.randomUUID()
/** Orders arm/disarm commands so a slow delivery cannot undo a newer one. */
let selectionWatchRevision = 0

/**
 * Arm or disarm every content script. `selectionchange` fires on each drag in
 * each tab, so the watcher stays off until a panel can actually show a quote.
 *
 * Delivery is asynchronous, so each command carries a revision: a panel that
 * closes and reopens quickly must not leave watchers in the state of whichever
 * `tabs.query` happened to resolve last.
 */
function syncSelectionWatch(): void {
  const anyEnabled = selectionSharingEnabled()
    && [...panelPorts].some((port) => panelWindows.get(port) !== undefined)
  const wasArmed = selectionWatchArmed
  selectionWatchArmed = anyEnabled
  const revision = ++selectionWatchRevision
  if (wasArmed && !anyEnabled) {
    resetSelectionDedupe(selections.sourcesWithSelection())
    broadcastSelections(selections.clearAll())
  }
  void Promise.resolve(chrome.tabs.query({})).then((tabs) => {
    if (revision !== selectionWatchRevision) return
    for (const tab of tabs) {
      if (tab.id === undefined) continue
      const enabled = selectionWatchEnabled(tab.windowId)
      void Promise.resolve(chrome.tabs.sendMessage(tab.id, {
        type: 'DSH_SELECTION_WATCH',
        enabled,
        epoch: selectionWatchEpoch,
        revision,
      }))
        .catch(() => { /* no content script in this tab */ })
    }
  }).catch(() => {})
}

/**
 * Accept a capture from the page the user is actually looking at.
 *
 * `sender.tab` already carries the tab's window, active state, and incognito
 * flag, so admission needs no `chrome.tabs` call: a background page cannot
 * make the worker query Chrome by moving its own selection in a loop.
 */
function recordSelection(tab: chrome.tabs.Tab, frameId: number, value: unknown): void {
  if (!selectionWatchEnabled(tab.windowId)) return
  // Only the tab the user is looking at, in its own window, may set a quote.
  if (tab.id === undefined || tab.active !== true) return
  const capture = parseSelectionCapture(value)
  if (capture === null) return
  if (selections.capture({ windowId: tab.windowId, tabId: tab.id, frameId }, capture)) {
    broadcastSelection(tab.windowId)
  }
}

function broadcastEvent(frame: ServerFrame): void {
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'event', frame }) } catch { /* port already closed */ }
  }
}

function broadcastApprovalResolved(id: string): void {
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'approval.resolved', id }) } catch { /* port already closed */ }
  }
}

const APPROVAL_NOTIFICATION_PREFIX = 'dsh-browser-approval:'

function approvalNotificationId(id: string): string {
  return `${APPROVAL_NOTIFICATION_PREFIX}${id}`
}

function deliverApproval(request: ApprovalRequest): boolean {
  let delivered = false
  for (const port of panelPorts) {
    try {
      port.postMessage({ type: 'approval.request', request })
      delivered = true
    } catch { /* port already closed */ }
  }
  return delivered
}

function notifyApproval(request: ApprovalRequest, _windowId: number): void {
  if (!settings.approvalNotifications) return
  const copy = getUiLocale() === 'zh'
    ? {
        title: '浏览器操作等待确认',
        message: '点击通知打开 dsh 浏览器助手，并在 60 秒内确认或拒绝。',
      }
    : {
        title: 'Browser action awaiting approval',
        message: 'Click to open dsh Browser Assistant, then allow or deny within 60 seconds.',
      }
  void Promise.resolve(chrome.notifications.create(approvalNotificationId(request.id), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
    title: copy.title,
    message: copy.message,
    requireInteraction: true,
  })).catch(() => {})
}

function clearApprovalNotification(id: string): void {
  void Promise.resolve(chrome.notifications.clear(approvalNotificationId(id))).catch(() => {})
}

const approvals = new ApprovalCoordinator({
  deliver: deliverApproval,
  notify: notifyApproval,
  clearNotification: clearApprovalNotification,
  resolved: broadcastApprovalResolved,
})

function responseMessages(): { unavailable: string; timeout: string; duplicate: string; disconnected: string } {
  return getUiLocale() === 'zh'
    ? {
        unavailable: '未连接 dsh，无法提交回答',
        timeout: '提交回答超时，请重试',
        duplicate: '回答请求编号重复，请重试',
        disconnected: 'dsh 连接已断开，请重新连接后再试',
      }
    : {
        unavailable: 'dsh is not connected, so the answer could not be sent',
        timeout: 'Sending the answer timed out. Try again.',
        duplicate: 'The answer request ID was duplicated. Try again.',
        disconnected: 'The dsh connection was lost. Reconnect and try again.',
      }
}

function cancelPendingApprovals(sessionId?: string): void {
  approvals.cancelAll(sessionId)
}

function summarizeTab(tab: chrome.tabs.Tab): AffinityTab | null {
  if (tab.id === undefined) return null
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    url: tab.url ?? '',
  }
}

function storedAffinity(): StoredTabAffinity | null {
  const state = tabAffinity.snapshot()
  const sessionTabs = tabAffinity.sessionMap()
  const hasSessionTabs = Object.keys(sessionTabs).length > 0
  const focusedSessionId = tabAffinity.focusedSession()
  const focus = focusedSessionId === null ? {} : { focusedSessionId }
  if (state.controlled !== null) {
    return {
      controlledTabId: state.controlled.tabId,
      ...(state.status === 'background' && state.active !== null
        ? { keptActiveTabId: state.active.tabId }
        : {}),
      ...(state.pinned ? { pinned: true as const } : {}),
      ...(hasSessionTabs ? { sessionTabs } : {}),
      ...focus,
    }
  }
  return state.status === 'lost'
    ? { lost: true, ...(hasSessionTabs ? { sessionTabs } : {}), ...focus }
    : (hasSessionTabs ? { lost: true, sessionTabs, ...focus } : null)
}

function persistTabAffinity(): void {
  const record = storedAffinity()
  const serialized = JSON.stringify(record)
  if (serialized === lastPersistedAffinity) return
  lastPersistedAffinity = serialized
  affinityPersistence = affinityPersistence.catch(() => {}).then(async () => {
    if (record === null) await chrome.storage.session.remove(TAB_AFFINITY_STORAGE_KEY)
    else await chrome.storage.session.set({ [TAB_AFFINITY_STORAGE_KEY]: record })
  }).catch(() => {
    if (lastPersistedAffinity === serialized) lastPersistedAffinity = undefined
  })
}

function observeActiveSummary(summary: AffinityTab): void {
  const previousStatus = tabAffinity.snapshot().status
  if (!tabAffinity.observeActive(summary)) return
  if (previousStatus !== 'handoff' && tabAffinity.snapshot().status === 'handoff') {
    const focused = tabAffinity.focusedSession()
    if (focused !== null) {
      activeFollowRefreshes.get(focused)?.controller.abort()
      cancelPendingApprovals(focused)
    } else {
      cancelPendingApprovals()
    }
  }
  persistTabAffinity()
  broadcastTabAffinity()
}

function observeActiveTab(tab: chrome.tabs.Tab): void {
  const summary = summarizeTab(tab)
  if (summary !== null) observeActiveSummary(summary)
}

async function syncActiveTab(windowId?: number, signal?: AbortSignal): Promise<chrome.tabs.Tab | undefined> {
  const queryRevision = focusedWindow.beginQuery()
  const query = windowId === undefined
    ? { active: true, lastFocusedWindow: true }
    : { active: true, windowId }
  try {
    const tabs = chrome.tabs.query(query)
    const [tab] = signal === undefined ? await tabs : await abortable(tabs, signal)
    if (signal !== undefined) throwIfRebindAborted(signal)
    if (tab === undefined) return undefined
    if (!focusedWindow.commitQuery(tab.windowId, queryRevision)) return undefined
    if (signal !== undefined) throwIfRebindAborted(signal)
    observeActiveTab(tab)
    return tab
  } catch {
    if (signal !== undefined && signal.aborted) throw rebindAbortReason(signal)
    return undefined
  }
}

async function restoreTabAffinity(): Promise<void> {
  let record: StoredTabAffinity | null = null
  try {
    const stored = await chrome.storage.session.get(TAB_AFFINITY_STORAGE_KEY)
    const candidate = stored[TAB_AFFINITY_STORAGE_KEY] as Partial<StoredTabAffinity> | undefined
    const controlledTabId = (candidate as { controlledTabId?: unknown } | undefined)?.controlledTabId
    const focusedSessionId = (candidate as { focusedSessionId?: unknown } | undefined)?.focusedSessionId
    const focus = typeof focusedSessionId === 'string' && focusedSessionId.trim() !== '' ? { focusedSessionId } : {}
    if (typeof controlledTabId === 'number' && Number.isInteger(controlledTabId) && controlledTabId >= 0) {
      const keptActiveTabId = (candidate as { keptActiveTabId?: unknown }).keptActiveTabId
      const sessionTabs = (candidate as { sessionTabs?: Record<string, AffinityTab> }).sessionTabs
      record = {
        controlledTabId,
        ...(typeof keptActiveTabId === 'number' && Number.isInteger(keptActiveTabId) && keptActiveTabId >= 0
          ? { keptActiveTabId }
          : {}),
        ...((candidate as { pinned?: unknown }).pinned === true ? { pinned: true as const } : {}),
        ...(typeof sessionTabs === 'object' && sessionTabs !== null ? { sessionTabs } : {}),
        ...focus,
      }
    } else if ((candidate as { lost?: unknown } | undefined)?.lost === true) {
      const sessionTabs = (candidate as { sessionTabs?: Record<string, AffinityTab> }).sessionTabs
      record = {
        lost: true,
        ...(typeof sessionTabs === 'object' && sessionTabs !== null ? { sessionTabs } : {}),
        ...focus,
      }
    }
    lastPersistedAffinity = candidate === undefined || record !== null
      ? JSON.stringify(record)
      : undefined
  } catch {
    // Session storage is a survival aid, not a reason to disable the bridge.
  }

  if (record?.sessionTabs !== undefined) {
    const restoredSessions: Record<string, AffinityTab> = {}
    for (const [sid, storedTab] of Object.entries(record.sessionTabs)) {
      if (typeof storedTab?.tabId !== 'number' || !Number.isInteger(storedTab.tabId) || storedTab.tabId < 0) continue
      try {
        const live = summarizeTab(await chrome.tabs.get(storedTab.tabId))
        if (live !== null) restoredSessions[sid] = live
      } catch {
        // Closed tabs are deliberately pruned so the session fails closed.
      }
    }
    tabAffinity.restoreSessionTabs(restoredSessions)
  }
  tabAffinity.restoreFocusedSession(record?.focusedSessionId ?? null)

  if (record !== null && 'controlledTabId' in record) {
    try {
      const controlled = summarizeTab(await chrome.tabs.get(record.controlledTabId))
      if (controlled === null) tabAffinity.restoreLost()
      else tabAffinity.restoreControlled(controlled)
    } catch {
      tabAffinity.restoreLost()
    }
  } else if (record?.lost === true) {
    tabAffinity.restoreLost()
  }

  // Restore the pin before syncing the active tab: otherwise the sync would
  // surface a handoff prompt for a switch the user already said not to ask about.
  if (record !== null && 'pinned' in record && record.pinned === true) tabAffinity.restorePinned()
  await syncActiveTab()
  if (record !== null && 'keptActiveTabId' in record) {
    const state = tabAffinity.snapshot()
    if (state.status === 'handoff' && state.active?.tabId === record.keptActiveTabId) {
      tabAffinity.decide('keep', state.revision)
    }
  }
  persistTabAffinity()
  broadcastTabAffinity()
}

const affinityReady = restoreTabAffinity()

function validSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Refresh one session's recovery checkpoint from its actual controlled tab. */
async function checkpointSessionPage(sessionValue: unknown): Promise<void> {
  const sessionId = validSessionId(sessionValue)
  if (sessionId === undefined) return
  await Promise.all([affinityReady, pageSessionContexts.ready])
  const bound = tabAffinity.getSessionTab(sessionId)
  if (bound === undefined) return
  try {
    const tab = await chrome.tabs.get(bound.tabId)
    if (tabAffinity.getSessionTab(sessionId)?.tabId !== bound.tabId) return
    pageSessionContexts.bind(sessionId, tab)
  } catch {
    // A concurrently closed tab is cleaned by tabs.onRemoved.
  }
}

/** Resolve the contextual hint only after the panel has identified its window. */
async function postResumeHint(port: chrome.runtime.Port, windowId: number): Promise<void> {
  await pageSessionContexts.ready
  let sessionId: string | null = null
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId })
    if (tab !== undefined) sessionId = pageSessionContexts.candidate(tab)
  } catch {
    // Without an exact live page the panel must start a new conversation.
  }
  if (!panelPorts.has(port) || panelWindows.get(port) !== windowId) return
  try { port.postMessage({ type: 'session.resume-hint', sessionId }) } catch { /* port closed */ }
}

/** Re-checkpoint each open panel before issuing a bridge-epoch resume hint. */
function refreshPanelResumeHints(): void {
  for (const port of panelPorts) {
    const windowId = panelWindows.get(port)
    if (windowId === undefined) continue
    const sessionId = panelActiveSessions.get(port)
    const checkpoint = sessionId === undefined
      ? Promise.resolve()
      : checkpointSessionPage(sessionId)
    void checkpoint.then(() => postResumeHint(port, windowId), () => postResumeHint(port, windowId))
  }
}

/** Bind at prompt submission so a switch while the model is thinking is visible. */
async function ensureInitialTabBinding(sessionId?: string): Promise<boolean> {
  await affinityReady
  if (tabAffinity.resolveTarget(sessionId).kind !== 'initial') return true
  try {
    const tab = await syncActiveTab()
    const summary = tab === undefined ? null : summarizeTab(tab)
    if (summary === null) return false
    if (tabAffinity.bindInitial(summary, sessionId)) {
      persistTabAffinity()
      broadcastTabAffinity()
    }
    return true
  } catch {
    return false
  }
}

function affinityFailure(kind: 'handoff' | 'lost' | 'missing'): ToolAnswer {
  if (kind === 'handoff') {
    return {
      ok: false,
      error: { code: 'action-failed', message: 'The user switched tabs, so browser operations are paused. In the side panel, choose whether to keep the previous page or follow the current page.' },
    }
  }
  if (kind === 'lost') {
    return {
      ok: false,
      error: { code: 'content-unavailable', message: 'The controlled tab was closed. Select the current page in the side panel before retrying.' },
    }
  }
  return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
}

/** Resolve one stable tab target without allowing a manual switch to drift it. */
async function resolveToolTab(sessionId?: string): Promise<Pick<chrome.tabs.Tab, 'id' | 'url' | 'title' | 'windowId'> | ToolAnswer> {
  await affinityReady
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const resolution = tabAffinity.resolveTarget(sessionId)
    if (resolution.kind === 'handoff') return affinityFailure('handoff')
    if (resolution.kind === 'lost') return affinityFailure('lost')
    if (resolution.kind === 'initial') {
      if (!await ensureInitialTabBinding(sessionId)) return affinityFailure('missing')
      continue
    }
    try {
      const tab = await chrome.tabs.get(resolution.tab.tabId)
      const summary = summarizeTab(tab)
      if (summary === null) return affinityFailure('missing')
      if (tabAffinity.observeTab(summary)) broadcastTabAffinity()
      const current = tabAffinity.resolveTarget(sessionId)
      if (current.kind === 'handoff') return affinityFailure('handoff')
      if (current.kind === 'lost') return affinityFailure('lost')
      if (current.kind === 'target' && current.tab.tabId === summary.tabId) return tab
    } catch {
      const affectedSessions = tabAffinity.sessionIdsForTab(resolution.tab.tabId)
      if (tabAffinity.removeTab(resolution.tab.tabId)) {
        forgetTab(resolution.tab.tabId)
        for (const sid of affectedSessions) {
          activeFollowRefreshes.get(sid)?.controller.abort()
          cancelPendingApprovals(sid)
        }
        persistTabAffinity()
        broadcastTabAffinity()
      }
      return affinityFailure('lost')
    }
  }
  return affinityFailure('handoff')
}

/**
 * Pick a window for browser_open_tab without requiring an already-controlled page.
 * Handoff still blocks: the user must finish the keep/follow choice first.
 */
async function resolveOpenTabWindow(sessionId?: string): Promise<{ windowId: number } | ToolAnswer> {
  await affinityReady
  const resolution = tabAffinity.resolveTarget(sessionId)
  if (resolution.kind === 'handoff') return affinityFailure('handoff')
  if (resolution.kind === 'target') {
    try {
      const tab = await chrome.tabs.get(resolution.tab.tabId)
      return { windowId: tab.windowId }
    } catch {
      // Fall through to the focused window when the prior controlled tab is gone.
    }
  }
  try {
    const focused = await chrome.windows.getLastFocused()
    if (focused.id !== undefined) return { windowId: focused.id }
  } catch { /* no focused window */ }
  const [fallback] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (fallback?.windowId !== undefined) return { windowId: fallback.windowId }
  return affinityFailure('missing')
}

function bindOpenedTab(
  tab: chrome.tabs.Tab,
  sessionId?: string,
  options: { active?: boolean } = {},
): boolean {
  const summary = summarizeTab(tab)
  if (summary === null) return false
  tabAffinity.claimTab(summary.tabId, 'opened')
  const sid = sessionId?.trim()
  bindOpenedTabAffinity(tabAffinity, summary, {
    active: options.active,
    sessionId: sid,
  })
  if (sid !== undefined && sid !== '') {
    void pageSessionContexts.ready.then(() => {
      pageSessionContexts.bind(sid, { id: summary.tabId, ...summary })
    })
  }
  persistTabAffinity()
  broadcastTabAffinity()
  return true
}

async function authorizeToolCall(
  prompt: ApprovalPrompt,
  signal: AbortSignal,
  windowId: number,
  sessionId?: string,
  unrestrictedAccess: boolean = unrestrictedAccessEnabled(),
): Promise<ApprovalAuthorization> {
  if (signal.aborted) return 'cancelled'
  if (unrestrictedAccess) return 'approved'
  // A cross-origin migration always asks for this one operation. The allowlist
  // covers same-origin work only; moving a page to another origin is a new
  // decision every time it happens.
  if (!isCrossOriginPrompt(prompt) && actionCoveredByTrustedOrigins(
    prompt,
    sessionTrustedActionOrigins,
    settings.trustedActionOrigins,
  )) {
    return 'approved'
  }
  const result: ApprovalRequestResult = await approvals.request(prompt, signal, windowId, sessionId)
  if (signal.aborted) return 'cancelled'
  if (result.status !== 'decision') return result.status
  const { decision } = result
  if (decision === 'always-allow-reads' && prompt.kind === 'read') {
    await persistSettings({ sharePageContent: 'auto' })
    return 'approved'
  }
  if (decision === 'trust-session' && prompt.kind === 'action' && prompt.canTrust && prompt.origins.length === 1) {
    sessionTrustedActionOrigins.add(prompt.origins[0]!)
    return 'approved'
  }
  // Retain wire compatibility with panels from the previous build. The new UI
  // manages permanent trust explicitly in Settings instead of offering it in
  // the action dialog.
  if (decision === 'trust-origin' && prompt.kind === 'action' && prompt.canTrust && prompt.origins.length === 1) {
    await persistSettings({ trustedActionOrigins: [...settings.trustedActionOrigins, prompt.origins[0]!] })
    return 'approved'
  }
  return decision === 'allow-once' ? 'approved' : 'denied'
}

/** Capture the newly controlled tab and seed it into this session's next Agent step. */
async function refreshFollowedPage(sessionId: string, tabId: number): Promise<void> {
  activeFollowRefreshes.get(sessionId)?.controller.abort()
  const controller = new AbortController()
  const unrestrictedAccess = unrestrictedAccessEnabled()
  let settle!: () => void
  const activeRefresh: ActiveFollowRefresh = {
    controller,
    unrestrictedAccess,
    settled: new Promise<void>((resolve) => { settle = resolve }),
    settle: () => { settle() },
  }
  activeFollowRefreshes.set(sessionId, activeRefresh)
  try {
    const target = await resolveToolTab(sessionId)
    if ('ok' in target || target.id !== tabId || controller.signal.aborted) return
    const budget = caps === null
      ? undefined
      : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars }
    const answer = await dispatchToolCall(
      { id: crypto.randomUUID(), name: 'browser_snapshot', args: {} },
      unrestrictedAccess ? 'auto' : settings.sharePageContent,
      budget,
      (prompt) => authorizeToolCall(prompt, controller.signal, target.windowId, sessionId, unrestrictedAccess),
      controller.signal,
      target,
      () => target.id !== undefined && tabAffinity.allowsTarget(target.id, sessionId),
      { unrestrictedAccess },
    )
    if (!answer.ok || controller.signal.aborted || !tabAffinity.allowsTarget(tabId, sessionId)) return
    if (typeof answer.result !== 'object' || answer.result === null) return
    const snapshot = (answer.result as { text?: unknown }).text
    if (typeof snapshot !== 'string' || snapshot.trim() === '') return
    await gatewayRpc(BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, { sessionId, snapshot })
  } finally {
    activeRefresh.settle()
    if (activeFollowRefreshes.get(sessionId) === activeRefresh) activeFollowRefreshes.delete(sessionId)
  }
}

async function refreshSessionSnapshot(sessionId: string): Promise<void> {
  await affinityReady
  const target = await resolveToolTab(sessionId)
  if (!('ok' in target) && target.id !== undefined) {
    await refreshFollowedPage(sessionId, target.id)
  }
}

async function resolveTabAffinityResponse(response: {
  revision: number
  decision: TabAffinityDecision
  sessionId: unknown
}): Promise<void> {
  await affinityReady
  await syncActiveTab()
  const sid = typeof response.sessionId === 'string' ? response.sessionId : undefined
  const accepted = tabAffinity.decide(response.decision, response.revision, sid)
  const controlled = accepted && response.decision === 'follow'
    ? tabAffinity.snapshot().controlled
    : null
  if (controlled !== null) resetTabSnapshot(controlled.tabId)
  if (accepted) {
    persistTabAffinity()
    if (controlled !== null && sid !== undefined) {
      await pageSessionContexts.ready
      pageSessionContexts.bind(sid, { id: controlled.tabId, ...controlled })
    }
  }
  broadcastTabAffinity()
  if (controlled !== null && typeof response.sessionId === 'string' && response.sessionId.trim() !== '') {
    await refreshFollowedPage(response.sessionId, controlled.tabId)
  }
}

/** Move browser control to the current tab only after a fresh, valid query. */
async function rebindTabAffinityToActive(signal: AbortSignal, sessionId?: string): Promise<void> {
  await abortable(Promise.all([affinityReady, pageSessionContexts.ready]).then(() => undefined), signal)
  const tab = await syncActiveTab(undefined, signal)
  throwIfRebindAborted(signal)
  const summary = tab === undefined ? null : summarizeTab(tab)
  if (summary === null) {
    throw new TabAffinityRebindError('no-active-tab', getUiLocale() === 'zh'
      ? '无法确定当前标签页，原会话和标签页绑定保持不变'
      : 'The current tab could not be determined; the existing session and tab binding were left unchanged')
  }

  commitTabAffinityRebind(summary, sessionId)
}

/** Commit one explicit tab handoff and clear stale element references. */
function commitTabAffinityRebind(
  summary: AffinityTab,
  sessionId?: string,
  mode: 'active' | 'background' = 'active',
): void {
  const previousControlledTabId = tabAffinity.snapshot().controlled?.tabId
  if (sessionId !== undefined) {
    activeFollowRefreshes.get(sessionId)?.controller.abort()
    cancelPendingApprovals(sessionId)
  }
  if (mode === 'active') tabAffinity.rebindActive(summary, sessionId)
  else tabAffinity.rebindControlled(summary, sessionId)
  if (sessionId !== undefined) {
    pageSessionContexts.bind(sessionId, { id: summary.tabId, ...summary })
  }
  if (previousControlledTabId !== undefined && previousControlledTabId !== summary.tabId) {
    resetTabSnapshot(previousControlledTabId)
  }
  resetTabSnapshot(summary.tabId)
  persistTabAffinity()
  broadcastTabAffinity()
}

async function followModelSelectedTab(tab: chrome.tabs.Tab, sessionId?: string): Promise<void> {
  const summary = summarizeTab(tab)
  if (summary === null) throw new Error('the selected tab has no usable identifier')
  await pageSessionContexts.ready
  commitTabAffinityRebind(summary, sessionId, 'background')
}

/** 把协商的快照预算下发到受控页（尚未绑定时使用活动页）。 */
async function pushBudgetToControlledTab(negotiated: BridgeCaps): Promise<void> {
  await affinityReady
  const resolution = tabAffinity.resolveTarget()
  const tabId = resolution.kind === 'target'
    ? resolution.tab.tabId
    : resolution.kind === 'initial'
      ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id
      : undefined
  if (tabId === undefined) return
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'DSH_BUDGET',
      budget: { maxItems: negotiated.maxInteractiveItems, maxChars: negotiated.snapshotMaxChars },
    })
  } catch {
    // 页面尚未注入 content script：下一次快照仍用默认预算，可接受。
  }
}

/** Route one tool.call frame to the user-approved controlled tab. */
/** One `tool.result` frame on the wire. */
type ToolResultFrame =
  | { t: 'tool.result'; id: string; ok: true; result: unknown }
  | { t: 'tool.result'; id: string; ok: false; error: ToolError }

/** Count UTF-8 bytes without materializing a second copy for callers. */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Send one tool result, refusing results that exceed the shared frame cap.
 *
 * The bridge enforces the same cap inbound, so an oversized result is replaced
 * here by a small `send_failed` error frame: the model learns why the answer is
 * missing instead of the call hanging until the Host timeout.
 * @param frame - the result frame to send.
 */
function sendToolResultFrame(frame: ToolResultFrame): void {
  const socket = bridge
  if (socket === null) return
  let bytes: number
  try {
    bytes = utf8Length(JSON.stringify(frame))
  } catch {
    socket.send({
      t: 'tool.result',
      id: frame.id,
      ok: false,
      error: { code: 'js-result-not-serializable', message: 'The tool result could not be serialized' },
    })
    return
  }
  if (bytes > MAX_FRAME_BYTES) {
    socket.send({
      t: 'tool.result',
      id: frame.id,
      ok: false,
      error: {
        code: 'send_failed',
        message: `tool result of ${bytes} bytes exceeds the ${MAX_FRAME_BYTES} byte frame cap`,
      },
    })
    return
  }
  socket.send(frame)
}

/**
 * Settle the tool call whose frame the bridge refused.
 *
 * The notice names one call: a backpressure drop must not abort unrelated
 * work that is still executing. A notice without an id (older peer) is only
 * recorded as an orphan event and never aborts anything.
 * @param toolCallId - the refused call id, when the bridge named one.
 * @param message - the bridge's explanation of the refused frame.
 */
function settleInFlightAsSendFailed(toolCallId: string | undefined, message: string): void {
  const call = toolCallId === undefined ? undefined : activeToolCalls.get(toolCallId)
  if (call === undefined) {
    console.warn(`[${BRIDGE_LOG_NAMESPACE}.send_failed_orphan] ${JSON.stringify({ toolCallId, message })}`)
    return
  }
  activeToolCalls.delete(toolCallId as string)
  call.controller.abort()
  sendToolResultFrame({ t: 'tool.result', id: toolCallId as string, ok: false, error: { code: 'send_failed', message } })
}

function routeToolCall(call: ToolCall): void {
  if (bridge === null) return
  noteToolActivity()
  void syncOffscreenKeepAlive()
  activeToolCalls.get(call.id)?.controller.abort()
  const controller = new AbortController()
  const unrestrictedAccess = unrestrictedAccessEnabled()
  let settle!: () => void
  const activeCall: ActiveToolCall = {
    controller,
    unrestrictedAccess,
    committed: false,
    revocationRequested: false,
    settled: new Promise<void>((resolve) => { settle = resolve }),
    settle: () => { settle() },
  }
  activeToolCalls.set(call.id, activeCall)
  unsettledToolCalls.add(activeCall)
  const commitAction = (): void => { activeCall.committed = true }
  const rollbackActionCommit = (): void => {
    activeCall.committed = false
    if (activeCall.revocationRequested) controller.abort()
  }
  const expiryTimer = call.expiresAt === undefined
    ? undefined
    : setTimeout(() => {
        if (!activeCall.committed) controller.abort()
      }, Math.max(0, call.expiresAt - Date.now()))
  const budget = caps === null
    ? undefined
    : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars }
  const sharePageContent = unrestrictedAccess ? 'auto' : settings.sharePageContent
  const managementDispatch = async (): Promise<ToolAnswer> => {
    await affinityReady
    const affinity = tabAffinity.snapshot()
    let windowId = affinity.active?.windowId ?? affinity.controlled?.windowId
    if (windowId === undefined) {
      try {
        windowId = (await chrome.windows.getLastFocused()).id
      } catch { /* approvals can still report unavailable without a focused window */ }
    }
    const controlledTabId = call.sessionId === undefined
      ? affinity.controlled?.tabId
      : tabAffinity.getSessionTab(call.sessionId)?.tabId
    return dispatchToolCall(
      call,
      sharePageContent,
      budget,
      (prompt) => authorizeToolCall(prompt, controller.signal, windowId ?? 0, call.sessionId, unrestrictedAccess),
      controller.signal,
      undefined,
      undefined,
      {
        unrestrictedAccess,
        tabIsolation: settings.tabIsolation,
        ownsTab: (tabId) => tabAffinity.ownsTab(tabId),
        ...(controlledTabId === undefined ? {} : { controlledTabId }),
        followTab: (tab) => {
          // browser_follow_tab is the one model-facing way to widen the owned set.
          if (tab.id !== undefined) tabAffinity.claimTab(tab.id, 'followed')
          return followModelSelectedTab(tab, call.sessionId)
        },
        commitAction,
        rollbackActionCommit,
      },
    )
  }
  void (isTabManagementTool(call.name)
    ? managementDispatch()
    : call.name === 'browser_open_tab'
    ? resolveOpenTabWindow(call.sessionId).then(async (target) => 'ok' in target
      ? target
      : withWorkVisibility(target.windowId === undefined ? undefined : workTabId(), () => dispatchOpenTab(
          call,
          target.windowId,
          sharePageContent,
          budget,
          (prompt) => authorizeToolCall(prompt, controller.signal, target.windowId, call.sessionId, unrestrictedAccess),
          controller.signal,
          (tab) => bindOpenedTab(tab, call.sessionId, { active: call.args.active !== false }),
          (tabId) => tabAffinity.allowsTarget(tabId, call.sessionId),
          commitAction,
        )))
    : resolveToolTab(call.sessionId).then(async (target) => 'ok' in target
      ? target
      : withWorkVisibility(target.id, () => dispatchToolCall(
          call,
          sharePageContent,
          budget,
          (prompt) => authorizeToolCall(prompt, controller.signal, target.windowId, call.sessionId, unrestrictedAccess),
          controller.signal,
          target,
          () => target.id !== undefined && tabAffinity.allowsTarget(target.id, call.sessionId),
          {
            unrestrictedAccess,
            tabIsolation: settings.tabIsolation,
            ownsTab: (tabId) => tabAffinity.ownsTab(tabId),
            commitAction,
            rollbackActionCommit,
          },
        )))
  ).then(
    async (answer) => {
      // Recording hook: captures are throttled inside captureRecordingFrame, so
      // a burst of tool calls only yields the frames it has budget for.
      if (recording !== null) void captureRecordingFrame(call.name)
      if (activeToolCalls.get(call.id) !== activeCall) return
      // A committed browser_open_tab already rebound affinity; prefer that
      // factual success over a generic cancel that would leave the model wrong.
      if (controller.signal.aborted && !(call.name === 'browser_open_tab' && answer.ok)) {
        if (activeToolCalls.get(call.id) === activeCall) {
          sendToolResultFrame({
            t: 'tool.result',
            id: call.id,
            ok: false,
            error: { code: 'action-failed', message: 'Tool call was cancelled' },
          })
        }
        return
      }
      if (answer.ok) {
        if (isNavigationCandidateTool(call.name)) await checkpointSessionPage(call.sessionId)
        if (activeToolCalls.get(call.id) !== activeCall) return
        const socket = bridge
        if (socket === null) return
        sendToolResultFrame({ t: 'tool.result', id: call.id, ok: true, result: answer.result })
      } else {
        const socket = bridge
        if (socket === null) return
        const normalized = normalizeToolError(answer.error)
        sendToolResultFrame({ t: 'tool.result', id: call.id, ok: false, error: normalized })
      }
    },
    (error: unknown) => {
      if (activeToolCalls.get(call.id) !== activeCall) return
      if (controller.signal.aborted) {
        if (activeToolCalls.get(call.id) === activeCall) {
          sendToolResultFrame({
            t: 'tool.result',
            id: call.id,
            ok: false,
            error: { code: 'action-failed', message: 'Tool call was cancelled' },
          })
        }
        return
      }
      sendToolResultFrame({
        t: 'tool.result',
        id: call.id,
        ok: false,
        error: normalizeToolError(error),
      })
    },
  ).finally(() => {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
    unsettledToolCalls.delete(activeCall)
    activeCall.settle()
    if (activeToolCalls.get(call.id) === activeCall) activeToolCalls.delete(call.id)
  })
}

function cancelToolCall(id: string): void {
  const call = activeToolCalls.get(id)
  if (call !== undefined && !call.committed) call.controller.abort()
}

async function revokeUnrestrictedAccess(): Promise<void> {
  const calls = [...unsettledToolCalls].filter((call) => call.unrestrictedAccess)
  const refreshes = [...activeFollowRefreshes.values()].filter((refresh) => refresh.unrestrictedAccess)
  for (const call of calls) {
    call.revocationRequested = true
    if (!call.committed) call.controller.abort()
  }
  for (const refresh of refreshes) refresh.controller.abort()
  await Promise.allSettled([
    ...calls.map(async (call) => { await call.settled }),
    ...refreshes.map(async (refresh) => { await refresh.settled }),
  ])
}

function cancelAllToolCalls(): void {
  for (const call of activeToolCalls.values()) {
    if (!call.committed) call.controller.abort()
  }
  activeToolCalls.clear()
}

/** (Re)start the bridge with the current settings. 零配置：地址留空时自动探测；回环连接无需 token。 */
async function startBridge(): Promise<void> {
  const revision = ++bridgeStartRevision
  if (panelPorts.size === 0) return
  let url = settings.bridgeUrl
  if (url === '') {
    url = await discoverBridge(() => revision === bridgeStartRevision && panelPorts.size > 0) ?? ''
  }
  // Discovery is asynchronous. A panel may have closed or a newer settings
  // update may have started while its fetches were in flight.
  if (revision !== bridgeStartRevision || panelPorts.size === 0) return
  if (url === '') {
    bridge?.stop()
    bridge = null
    rpc = null
    broadcastStatus()
    return
  }
  // 手动填的地址常只有主机部分（如 ws://127.0.0.1:3080）；桥路径是协议
  // 常量，缺省时自动补全，避免连到根路径失败。
  try {
    const parsed = new URL(url)
    if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = BRIDGE_PATH
    url = parsed.toString()
  } catch {
    // 非法 URL 原样交给 WebSocket 构造函数报错。
  }
  if (bridge === null) {
    const client = new BridgeClient({
      onStateChange: (state) => {
        if (state !== 'connected') {
          cancelAllToolCalls()
          interactionResponses.failAll(responseMessages().disconnected)
          transientEvents.clear()
          // `connecting`/`reconnecting` are transient generations of the same
          // session: the user's controlled tab and bindings are still valid, so
          // ownership must survive them. Only a stopped connection (or an
          // explicit session clear) ends the session-scoped state.
          if (state === 'stopped') resetSessionScopedState('disconnected')
        } else {
          // A reconnect re-establishes the session; re-claim what it still controls.
          claimEstablishedBindings()
        }
        broadcastStatus()
        if (state === 'stopped') refreshPanelResumeHints()
        if (state === 'stopped' && panelPorts.size === 0) disarmBridgeKeepalive()
      },
      onFrame: (frame) => {
        if (frame.t === 'event') {
          transientEvents.ingest(frame)
          broadcastEvent(frame)
        }
        else if (frame.t === 'tool.call') routeToolCall(frame)
        else if (frame.t === 'tool.cancel') cancelToolCall(frame.id)
        else if (frame.t === 'respond.result') interactionResponses.route(frame)
        else if (frame.t === 'error') {
          // A refused outbound frame carries no tool id: every in-flight call
          // can no longer be answered, so settle them all instead of waiting
          // for the per-call timeout. Other error codes keep the existing
          // semantics: the socket state, not this frame, drives reconnection.
          if (frame.code === 'send_failed') settleInFlightAsSendFailed(frame.id, frame.message)
        }
        // rpc.result is settled by the rpc facade (wrapped below).
      },
      onHelloOk: (negotiated) => {
        caps = negotiated
        broadcastStatus()
        void pushBudgetToControlledTab(negotiated)
      },
    }, probeBridge, () => panelPorts.size > 0)
    bridge = client
    rpc = createRpc(client)
  }
  bridge.start(url, settings.token)
}

/** Gateway RPC with a helpful error when the bridge is down. */
async function gatewayRpc(method: string, payload: unknown): Promise<unknown> {
  if (rpc === null || bridge === null || !bridge.connected) {
    throw new Error(getUiLocale() === 'zh'
      ? '未连接 dsh（请检查设置中的地址与 token）'
      : 'dsh is not connected (check the bridge address and token in Settings)')
  }
  return rpc.request(method, payload)
}

// ---- Content script messages ----

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (typeof message !== 'object' || message === null) return
  if (sender.id !== chrome.runtime.id) return
  const type = (message as { type?: unknown }).type
  if (type === 'SW_KEEPALIVE') {
    // The offscreen document has no tab, so this branch must precede the
    // tab-scoped content-script handling below.
    const at = noteSwKeepAlive()
    sendResponse({ ok: true, at })
    return
  }
  if (type === OFFSCREEN_GIF_SWEPT_MESSAGE) {
    // The downloaded recording's blob URL was released; the offscreen document
    // has no tab, so this branch must also precede the tab-scoped handling.
    bumpEvent('artifact.swept')
    broadcastDiagnostics()
    sendResponse({ ok: true })
    return
  }
  if (sender.tab?.id === undefined) return
  if (type === 'DSH_INSTRUMENT_EVENT') {
    // MAIN-world hook entries (debugger-unavailable fallback) arrive from the
    // content script, which forwards the page's postMessage payload.
    const entry = (message as { entry?: unknown }).entry
    if (isInstrumentEntry(entry)) recordInstrumentEntry(sender.tab.id, entry)
    sendResponse({ ok: true })
    return
  }
  if (type === 'DSH_CONTENT_READY') {
    // navigation.ts also listens for this frame-ready announcement; only this
    // listener answers it, telling a fresh document whether to watch
    // selections. The revision lets a slow reply lose to a newer broadcast.
    sendResponse({
      selectionWatch: selectionWatchEnabled(sender.tab.windowId),
      selectionWatchEpoch: selectionWatchEpoch,
      selectionWatchRevision: selectionWatchRevision,
    })
    return
  }
  if (type !== 'DSH_SELECTION' || sender.tab === undefined) return
  recordSelection(sender.tab, sender.frameId ?? 0, (message as { selection?: unknown }).selection)
})

// ---- Panel ports ----

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'dsh-panel') return
  const wasIdle = panelPorts.size === 0
  const tabAffinityRebinds = new Map<string, {
    controller: AbortController
    timer: ReturnType<typeof setTimeout>
  }>()
  panelPorts.add(port)
  if (wasIdle) armBridgeKeepalive()
  // Receipts that arrived while no panel was connected are replayed once.
  interactionResponses.flush(port)
  void settingsReady.then(syncSelectionWatch)
  void settingsReady.then(() => {
    if (!panelPorts.has(port)) return
    if (bridge === null || bridge.state === 'stopped') return startBridge()
  })
  try {
    port.postMessage({ type: 'status', state: bridge?.state ?? ('stopped' as BridgeState), caps })
    port.postMessage({ type: 'live-view-state', state: liveView.state() })
  } catch { /* port closed */ }
  void affinityReady.then(async () => {
    await syncActiveTab()
    try { port.postMessage({ type: 'tab-affinity', state: tabAffinity.snapshot() }) } catch { /* port closed */ }
  })
  port.onMessage.addListener((message: unknown) => {
    if (typeof message !== 'object' || message === null) return
    const msg = message as { type?: string }
    switch (msg.type) {
      case 'rpc': {
        const rpcMsg = message as { id: string; method: string; payload?: unknown }
        const rpcSessionId = typeof rpcMsg.payload === 'object' && rpcMsg.payload !== null
          ? (rpcMsg.payload as { sessionId?: string }).sessionId
          : undefined
        const refresh = rpcSessionId === undefined
          ? Promise.resolve()
          : sessionSnapshotRefreshes.get(rpcSessionId) ?? Promise.resolve()
        const prepare = rpcMsg.method === 'session.prompt'
          ? Promise.resolve().then(async () => {
              await refresh
              return rpcSessionId === undefined || tabAffinity.getSessionTab(rpcSessionId) !== undefined
            })
          : Promise.resolve(true)
        void prepare.then((ready) => {
          if (!ready) throw new Error('This session is not bound to a live browser tab')
          return gatewayRpc(rpcMsg.method, rpcMsg.payload)
        }).then(
          (result) => {
            try { port.postMessage({ type: 'rpc.result', id: rpcMsg.id, ok: true, result }) } catch { /* port closed */ }
          },
          (error: unknown) => {
            try {
              port.postMessage({
                type: 'rpc.result',
                id: rpcMsg.id,
                ok: false,
                error: { code: 'bridge-unavailable', message: error instanceof Error ? error.message : String(error) },
              })
            } catch { /* port closed */ }
          },
        )
        break
      }
      case 'respond': {
        const response = message as { id?: unknown; rpcId?: unknown; result?: unknown }
        if (typeof response.id !== 'string' || typeof response.rpcId !== 'string' || !isRespondResult(response.result)) break
        const messages = responseMessages()
        interactionResponses.begin(
          port,
          response.id,
          () => bridge?.send({
            t: 'respond',
            id: response.id as string,
            rpcId: response.rpcId as string,
            result: response.result as RespondResult,
          }) === true,
          messages,
        )
        break
      }
      case 'settings': {
        const settingsMsg = message as { id?: unknown; settings: Partial<Settings> }
        const requestId = typeof settingsMsg.id === 'string' ? settingsMsg.id : undefined
        void settingsReady.then(async () => {
          try {
            const previousConnection = { bridgeUrl: settings.bridgeUrl, token: settings.token }
            await persistSettings(settingsMsg.settings)
            const connectionChanged = settings.bridgeUrl !== previousConnection.bridgeUrl
              || settings.token !== previousConnection.token
            if (panelPorts.size > 0) {
              if (connectionChanged) await startBridge()
              broadcastStatus()
            } else if (connectionChanged) {
              // The settings write outlived its originating panel. Do not keep a
              // healthy socket authenticated with stale connection settings: make
              // the next explicit panel lease start from the persisted values.
              bridgeStartRevision += 1
              bridge?.stop()
              bridge = null
              rpc = null
              caps = null
              broadcastStatus()
              disarmBridgeKeepalive()
            }
            if (requestId !== undefined) {
              try { port.postMessage({ type: 'settings.result', id: requestId, ok: true }) } catch { /* port closed */ }
            }
          } catch (error: unknown) {
            if (requestId === undefined) return
            try {
              port.postMessage({
                type: 'settings.result',
                id: requestId,
                ok: false,
                error: { message: error instanceof Error ? error.message : String(error) },
              })
            } catch { /* port closed */ }
          }
        })
        break
      }
      case 'panel.window': {
        // The panel reports its own window; a side panel has no sender.tab.
        const registration = message as { windowId?: unknown }
        if (typeof registration.windowId !== 'number'
          || !Number.isInteger(registration.windowId)
          || registration.windowId < 0) break
        panelWindows.set(port, registration.windowId)
        syncSelectionWatch()
        try {
          port.postMessage({ type: 'selection', selection: selections.current(registration.windowId) })
        } catch { /* port closed */ }
        void postResumeHint(port, registration.windowId)
        break
      }
      case 'selection.clear': {
        // The user sent, dismissed, or explicitly abandoned this window's
        // quote. A send/dismiss names the value it acted on so a newer capture
        // that arrived while work was in flight cannot be cleared by mistake.
        const windowId = panelWindows.get(port)
        if (windowId === undefined) break
        const request = message as { selection?: unknown }
        const expected = request.selection === undefined ? undefined : parsePageSelection(request.selection)
        if (expected === null) break
        const source = selections.source(windowId)
        const cleared = expected === undefined
          ? selections.clear(windowId)
          : selections.clearIfCurrent(windowId, expected)
        if (cleared && source !== null) resetSelectionDedupe([source])
        // Also repairs a panel that acted on a stale attachment.
        broadcastSelection(windowId)
        break
      }
      case 'session.active': {
        const session = message as { sessionId?: unknown; isNew?: boolean }
        const sid = validSessionId(session.sessionId)
        if (sid === undefined) {
          panelActiveSessions.delete(port)
        } else {
          panelActiveSessions.set(port, sid)
          if (session.isNew === true) {
            const bind = Promise.all([affinityReady, pageSessionContexts.ready]).then(async () => {
              const tab = await syncActiveTab()
              const summary = tab === undefined ? null : summarizeTab(tab)
              if (summary === null) throw new Error('No active tab is available to bind this session')
              if (tabAffinity.getSessionTab(sid) === undefined) tabAffinity.bindNewSession(sid, summary)
              pageSessionContexts.bind(sid, { id: summary.tabId, ...summary })
              resetTabSnapshot(summary.tabId)
              persistTabAffinity()
              broadcastTabAffinity()
              await refreshSessionSnapshot(sid)
            }).catch(() => {})
            sessionSnapshotRefreshes.set(sid, bind)
            void bind.finally(() => {
              if (sessionSnapshotRefreshes.get(sid) === bind) sessionSnapshotRefreshes.delete(sid)
            })
          } else if (tabAffinity.focusSession(sid)) {
            persistTabAffinity()
            broadcastTabAffinity()
          }
        }
        break
      }
      case 'approval.response': {
        const approval = message as { id?: unknown; decision?: unknown }
        if (typeof approval.id === 'string' && isApprovalDecision(approval.decision)) {
          approvals.respond(approval.id, approval.decision)
        }
        break
      }
      case 'tab-affinity.response': {
        const response = message as { revision?: unknown; decision?: unknown; sessionId?: unknown }
        if (typeof response.revision !== 'number' || !isTabAffinityDecision(response.decision)) break
        const sid = typeof response.sessionId === 'string' ? response.sessionId : undefined
        const decision = resolveTabAffinityResponse({
          revision: response.revision,
          decision: response.decision,
          sessionId: response.sessionId,
        }).catch(() => {})
        if (response.decision === 'follow' && sid !== undefined) {
          sessionSnapshotRefreshes.set(sid, decision)
          void decision.finally(() => {
            if (sessionSnapshotRefreshes.get(sid) === decision) sessionSnapshotRefreshes.delete(sid)
          })
        } else {
          void decision
        }
        break
      }
      case 'tab-affinity.rebind': {
        const request = message as { id?: unknown; sessionId?: unknown }
        if (typeof request.id !== 'string') break
        const requestId = request.id
        const rebindSessionId = validSessionId(request.sessionId) ?? panelActiveSessions.get(port)
        if (tabAffinityRebinds.has(requestId)) break
        const controller = new AbortController()
        const timer = setTimeout(() => {
          controller.abort(new TabAffinityRebindError('timeout', getUiLocale() === 'zh'
            ? '绑定当前标签页超时，请重试'
            : 'Binding the current tab timed out. Try again.'))
        }, TAB_AFFINITY_REBIND_TIMEOUT_MS)
        tabAffinityRebinds.set(requestId, { controller, timer })
        void rebindTabAffinityToActive(controller.signal, rebindSessionId).then(
          () => {
            try { port.postMessage({ type: 'tab-affinity.rebind.result', id: requestId, ok: true }) } catch { /* port closed */ }
          },
          (error: unknown) => {
            try {
              port.postMessage({
                type: 'tab-affinity.rebind.result',
                id: requestId,
                ok: false,
                error: {
                  code: error instanceof TabAffinityRebindError ? error.code : 'no-active-tab',
                  message: error instanceof Error ? error.message : String(error),
                },
              })
            } catch { /* port closed */ }
          },
        ).finally(() => {
          const current = tabAffinityRebinds.get(requestId)
          if (current?.controller !== controller) return
          clearTimeout(current.timer)
          tabAffinityRebinds.delete(requestId)
        })
        break
      }
      case 'live-view': {
        const request = message as { enabled?: unknown }
        if (typeof request.enabled !== 'boolean') break
        if (request.enabled) liveViewPorts.add(port)
        else liveViewPorts.delete(port)
        void liveView.setWatching(liveViewPorts.size > 0)
        break
      }
      case 'recording.start': {
        const recordingWindowId = panelWindows.get(port)
        if (recordingWindowId === undefined) {
          broadcastRecording(getUiLocale() === 'zh'
            ? '侧边栏窗口尚未就绪，请重新打开面板后再录制'
            : 'The panel window is not ready yet; reopen the panel and try again')
          break
        }
        startRecording(recordingWindowId)
        break
      }
      case 'recording.export':
        void exportRecording()
        break
      case 'recording.clear':
        clearRecording()
        break
      case 'request-status':
        try {
          port.postMessage({ type: 'status', state: bridge?.state ?? ('stopped' as BridgeState), caps })
          port.postMessage({ type: 'recording', status: currentRecordingStatus() })
          port.postMessage({ type: 'diagnostics', counts: eventCounters.snapshot() })
          port.postMessage({ type: 'tab-affinity', state: tabAffinity.snapshot() })
          const statusWindowId = panelWindows.get(port)
          if (statusWindowId !== undefined) {
            port.postMessage({ type: 'selection', selection: selections.current(statusWindowId) })
          }
          for (const frame of transientEvents.replay()) port.postMessage({ type: 'event', frame })
          port.postMessage({ type: 'live-view-state', state: liveView.state() })
          approvals.replay((request) => {
            port.postMessage({ type: 'approval.request', request })
            return true
          })
          const resumeWindowId = panelWindows.get(port)
          if (resumeWindowId !== undefined) void postResumeHint(port, resumeWindowId)
        } catch { /* port closed */ }
        break
    }
  })
  port.onDisconnect.addListener(() => {
    for (const operation of tabAffinityRebinds.values()) {
      clearTimeout(operation.timer)
      operation.controller.abort(new TabAffinityRebindError('cancelled', getUiLocale() === 'zh'
        ? '后台连接已断开，标签页绑定已取消'
        : 'The background connection was lost, so tab binding was cancelled'))
    }
    tabAffinityRebinds.clear()
    const panelWindowId = panelWindows.get(port)
    const panelSessionId = panelActiveSessions.get(port)
    panelActiveSessions.delete(port)
    panelPorts.delete(port)
    if (liveViewPorts.delete(port)) void liveView.setWatching(liveViewPorts.size > 0)
    if (panelSessionId !== undefined) void checkpointSessionPage(panelSessionId)
    interactionResponses.removePort(port)
    if (panelWindowId !== undefined && !hasPanelInWindow(panelWindowId)) {
      const source = selections.source(panelWindowId)
      if (selections.clear(panelWindowId) && source !== null) resetSelectionDedupe([source])
    }
    syncSelectionWatch()
    if (panelPorts.size === 0) {
      bridgeStartRevision += 1
      bridge?.suspendReconnect()
      sessionTrustedActionOrigins.clear()
      approvals.notifyPending()
      // Closing a panel does not end the session: the bridge socket may still be
      // connected and the agent may keep working. Only the connection ending
      // clears ownership and visible-work state.
      if (bridge?.state !== 'connected') disarmBridgeKeepalive()
    }
  })
})

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith(APPROVAL_NOTIFICATION_PREFIX)) return
  const id = notificationId.slice(APPROVAL_NOTIFICATION_PREFIX.length)
  const windowId = approvals.windowId(id)
  if (windowId === undefined) return
  clearApprovalNotification(id)
  // Notification clicks are extension user gestures; both panel APIs require
  // the call to remain inside this handler.
  openAssistantPanel(windowId)
})

// ---- Tab affinity ----

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void affinityReady.then(() => {
    const activationRevision = focusedWindow.acceptActivation(windowId)
    if (activationRevision === null) return
    // Mark the switch before awaiting metadata so an already-running trusted
    // action cannot slip through the handoff boundary.
    observeActiveSummary({ tabId, windowId, title: '', url: '' })
    // A screencast only produces frames for the visible tab, so a switch must
    // either start the new controlled tab or report it as unavailable.
    syncLiveView()
    return chrome.tabs.get(tabId).then((tab) => {
      if (focusedWindow.isCurrent(activationRevision)) observeActiveTab(tab)
    }).catch(() => {})
  })
})

chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  void affinityReady.then(() => {
    if (!tabAffinity.tracks(tabId)) return
    const summary = summarizeTab(tab)
    if (summary !== null && tabAffinity.observeTab(summary)) broadcastTabAffinity()
  })
})

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  // The old document is gone even though Chrome transfers the tab identity.
  broadcastSelections(selections.clearTab(removedTabId))
  void pageSessionContexts.ready.then(() => {
    pageSessionContexts.replaceTab(removedTabId, addedTabId)
  })
  void affinityReady.then(() => {
    // onReplaced is an identity swap (for example prerender activation), not
    // a close or user-visible switch. Transfer IDs synchronously before any
    // metadata lookup so tool resolution never observes the removed target.
    const affectedSessions = tabAffinity.sessionIdsForTab(removedTabId)
    if (!tabAffinity.replaceTab(removedTabId, addedTabId)) return
    for (const sid of affectedSessions) {
      activeFollowRefreshes.get(sid)?.controller.abort()
      cancelPendingApprovals(sid)
    }
    forgetTab(removedTabId)
    resetTabSnapshot(removedTabId)
    resetTabSnapshot(addedTabId)
    persistTabAffinity()
    broadcastTabAffinity()
    return chrome.tabs.get(addedTabId).then((tab) => {
      const summary = summarizeTab(tab)
      if (summary !== null && tabAffinity.observeTab(summary)) broadcastTabAffinity()
    }).catch(() => {})
  })
})

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId)
  broadcastSelections(selections.clearTab(tabId))
  void pageSessionContexts.ready.then(() => {
    pageSessionContexts.removeTab(tabId)
  })
  void affinityReady.then(() => {
    const affectedSessions = tabAffinity.sessionIdsForTab(tabId)
    if (!tabAffinity.removeTab(tabId)) return
    for (const sid of affectedSessions) {
      activeFollowRefreshes.get(sid)?.controller.abort()
      cancelPendingApprovals(sid)
    }
    persistTabAffinity()
    broadcastTabAffinity()
  })
})

// A committed navigation replaces a document; a same-document history or
// fragment update does not, and must not drop a quote still on the screen.
// Matching the exact frame keeps an iframe's navigation from invalidating a
// quote taken from its parent page, and vice versa.
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url, documentId }) => {
  // Same-document fragment and history updates keep the document id, so they
  // keep the console/network buffer; a replaced document starts empty.
  if (frameId === 0) noteTabNavigation(tabId, url, documentId)
  broadcastSelections(selections.clearTab(tabId, frameId))
})

// Ports are cleaned up by their own disconnect; only the window's quote is
// left behind when the whole window goes away.
chrome.windows.onRemoved.addListener((windowId) => {
  selections.clear(windowId)
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return
  focusedWindow.markFocused(windowId)
  void affinityReady.then(() => syncActiveTab(windowId))
})

// ---- Keepalive ----

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== BRIDGE_KEEPALIVE_ALARM) return
  // The idle window is evaluated on the same tick as the reconnect re-arm so a
  // quiet connected worker releases the heartbeat without any panel event.
  void syncOffscreenKeepAlive()
  if (panelPorts.size === 0) {
    if (bridge === null || bridge.state !== 'connected') disarmBridgeKeepalive()
    return
  }
  // `stopped` is intentionally terminal until an explicit panel reopen or
  // settings save. In particular, code 4000 means another browser owns the
  // single bridge slot and the keepalive must not reclaim it.
  if (bridge === null || bridge.state === 'reconnecting') {
    void settingsReady.then(() => startBridge())
  }
})

// ---- Boot ----

interface FirefoxSidebarAction {
  open(): Promise<void> | void
}

function openAssistantPanel(windowId?: number): void {
  if (import.meta.env.EXT_TARGET === 'firefox') {
    const sidebar = (chrome as unknown as { sidebarAction?: FirefoxSidebarAction }).sidebarAction
    if (sidebar === undefined) return
    void Promise.resolve(sidebar.open()).catch(() => {})
    return
  }
  if (windowId !== undefined) void chrome.sidePanel.open({ windowId }).catch(() => {})
}

// Open the side panel when the toolbar icon is clicked.
// Chrome 116+ uses chrome.sidePanel; Firefox has no sidePanel API, so the
// action click opens the sidebar via sidebarAction.open() (user gesture).
if (import.meta.env.EXT_TARGET === 'firefox') {
  chrome.action.onClicked.addListener(() => { openAssistantPanel() })
} else {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
}

// Alarms survive some extension/service-worker restarts. Remove any stale
// schedule left by an older eager-connection build; onConnect re-arms it.
disarmBridgeKeepalive()

// `settingsReady` intentionally has no bridge-start continuation: opening a
// side panel is the first action allowed to claim the bridge connection.

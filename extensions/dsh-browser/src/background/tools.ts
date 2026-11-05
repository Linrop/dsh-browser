/**
 * Tool dispatch: executes `tool.call` frames in an explicitly selected tab via
 * the content script and answers with the text-only result.
 *
 * The background service owns tab-affinity policy. Direct callers may omit a
 * target for backward-compatible active-tab dispatch in isolated tests.
 *
 * @module
 */

import { DEFAULT_SNAPSHOT_MAX_CHARS } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import type { ToolError } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import {
  allocateFrameBudgets,
  forgetRecoveredSubframe,
  frameDocumentKey,
  frameOrigin,
  listTabFrames,
  type TabFrame,
} from './frames.ts'
import { wrapUntrustedContent } from '../security/untrusted.ts'
import { redactModelText as redactPageText } from './cdp.ts'
import { PAGE_READS, approvalPromptForCall, originFromUrl } from './authorization.ts'
import {
  DebuggerUnavailableError,
  JsResultNotSerializableError,
  NativeDragUnavailableError,
  PdfTooLargeError,
  ScreenshotTooLargeError,
  captureScreenshot,
  applyViewportOverride,
  captureVisibleTabScreenshot,
  clearViewportOverride,
  clickPointer,
  dragPointer,
  ensureAttached,
  evaluateInPage,
  formatConsoleMessages,
  formatEvaluationResult,
  formatNetworkRequests,
  installPageInstrumentation,
  modifierMask,
  movePointer,
  printToPdf,
  NAMED_KEY_NAMES,
  parseKeyStroke,
  pressKey,
  CONSOLE_PATTERN_BUDGET_MS,
  CONSOLE_PATTERN_MATCH_PREFIX,
  CONSOLE_PATTERN_MAX_LENGTH,
  instrumentChannelFor,
  readConsoleMessages,
  readNetworkRequests,
  seedTelemetryDomain,
  startConsoleCapture,
  startNetworkCapture,
  type CdpMouseButton,
  type DragPointerMode,
  type EvaluateOutcome,
  type KeyStroke,
  type PrintToPdfOptions,
  type ScreenshotCapture,
  type ScreenshotOptions,
} from './cdp.ts'
import {
  ScreenshotPlanError,
  clipFromRegion,
  validateScreenshotClip,
} from './screenshot-plan.ts'
import {
  realInputVerdict,
  type RealInputState,
  type RealInputUnavailableReason,
} from './real-input.ts'
import {
  classifyRestrictedPage,
  restrictedPageRefusal,
  waitForNextDocumentReady,
  type NavigationWait,
  type RestrictedPageKind,
} from './navigation.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../security/approval.ts'
import { getUiLocale } from '../i18n.ts'

/** A tool call from the bridge. */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  /** Server-authored wall-clock deadline; absent only in direct unit tests. */
  expiresAt?: number
  /** Owning Agent session, when supplied by a current bridge. */
  sessionId?: string
}

/** The wire answer for one tool call. */
export interface ToolAnswer {
  ok: boolean
  result?: unknown
  error?: ToolError
}

/** Snapshot limits negotiated with the bridge and forwarded after lazy injection. */
export interface ContentBudget {
  maxItems: number
  maxChars: number
}

const CONTENT_SCRIPT_FILE = 'content.js'
const ACTION_DELTA_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_wait',
  'browser_select',
  'browser_hover',
  'browser_drag',
  'browser_upload_file',
])
const ACTION_DELTA_GUIDANCE = 'The page settled and its current changes are included below. Continue from this state; take another snapshot only when broader page context is needed.'
const NAVIGATION_CANDIDATE_TOOLS = new Set([
  'browser_click',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_open_tab',
  'browser_evaluate',
  'browser_drag',
  'browser_select',
  'browser_upload_file',
])
const TAB_NATIVE_TOOLS = new Set([
  'browser_snapshot',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_screenshot',
  'browser_pdf',
  'browser_resize',
  'browser_viewport',
  'browser_console',
  'browser_network',
  'browser_evaluate',
])
const STATE_CHANGING_PAGE_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_upload_file',
  'browser_select',
  'browser_drag',
  'browser_evaluate',
])
/** Tools implemented by the background worker itself, never by a content script. */
const BACKGROUND_PAGE_TOOLS = new Set([
  'browser_evaluate',
  'browser_screenshot',
  'browser_pdf',
  'browser_viewport',
  'browser_console',
  'browser_network',
  'browser_resize',
])
/** Tools addressed by a snapshot element index, which needs a current snapshot baseline. */
const ELEMENT_TARGET_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_hover',
  'browser_upload_file',
  'browser_drag',
])
/** Tools that operate on the browser tab collection rather than one page document. */
export const TAB_MANAGEMENT_TOOL_NAMES = new Set([
  'browser_list_tabs',
  'browser_follow_tab',
  'browser_close_tab',
  'browser_close',
])

/**
 * Tabs this browser connection opened through `browser_open_tab`.
 *
 * Affinity ownership answers what the connection may operate; this set records
 * how a tab got here. It is what `browser_close` without `tabId` may close and
 * what `browser_list_tabs` reports as `origin: "created"`. The set is
 * connection-scoped like ownership and is pruned against live tabs whenever it
 * is read.
 */
const createdTabIds = new Set<number>()

/** Number of closed reports kept small: ids are listed in close order. */
function recordCreatedTab(tabId: number): void {
  if (Number.isInteger(tabId) && tabId >= 0) createdTabIds.add(tabId)
}

/** Live created tabs, dropping ids whose tab has already gone away. */
async function liveCreatedTabs(): Promise<number[]> {
  const live: number[] = []
  for (const tabId of [...createdTabIds].sort((left, right) => left - right)) {
    if (await findTab(tabId) === undefined) {
      createdTabIds.delete(tabId)
      continue
    }
    live.push(tabId)
  }
  return live
}
const NAVIGATION_SNAPSHOT_GUIDANCE = 'Navigation completed and the current page snapshot is included below. Use it directly instead of taking an immediate duplicate snapshot.'
const RECEIVER_MISSING_NAVIGATION_GRACE_MS = 1_500
const pendingInjections = new Map<number, Promise<void>>()
const snapshotDocumentsByTab = new Map<number, Map<number, string>>()

/** Forget delta/element state whenever the user explicitly follows a new tab. */
export function resetTabSnapshot(tabId: number): void {
  snapshotDocumentsByTab.delete(tabId)
}

/** Whether a successful tool may have changed the controlled tab's page URL. */
export function isNavigationCandidateTool(name: string): boolean {
  return NAVIGATION_CANDIDATE_TOOLS.has(name)
}

/** Whether a tool can run without first resolving the current controlled tab. */
export function isTabManagementTool(name: string): boolean {
  return TAB_MANAGEMENT_TOOL_NAMES.has(name)
}

/** Tab-affinity services owned by the background entry point. */
export interface TabManagementContext {
  /** Skip all browser approval prompts after the user enables unrestricted access. */
  unrestrictedAccess: boolean
  /** Controlled tab for the calling session, when one still exists. */
  controlledTabId?: number
  /** Whether tab isolation refuses targets outside this session's owned tabs. */
  tabIsolation?: boolean
  /** Membership test for the session's owned tabs, supplied by the affinity controller. */
  ownsTab?: (tabId: number) => boolean
  /** Rebind subsequent tools to one existing tab without activating it. */
  followTab?: (tab: chrome.tabs.Tab) => void | Promise<void>
  /** Mark the point after which a state-changing operation cannot be withdrawn. */
  commitAction?: () => void
  /** Restore withdrawability when a content-script action was not delivered. */
  rollbackActionCommit?: () => void
}

/**
 * Refuse a tab this session never opened, followed, or bound to.
 *
 * Tab isolation makes the connection's ownership set the only source of
 * targets: a tool call that points anywhere else fails closed instead of
 * operating a tab the user never handed over.
 * @param tabId - the resolved target tab.
 * @param context - affinity context carrying the ownership test.
 * @returns the `tab_outside` refusal, or undefined when the target is allowed.
 */
export function resolveTargetTab(
  tabId: number,
  context: Pick<TabManagementContext, 'tabIsolation' | 'ownsTab'>,
): ToolAnswer | undefined {
  if (context.tabIsolation !== true || context.ownsTab === undefined) return undefined
  if (context.ownsTab(tabId)) return undefined
  return {
    ok: false,
    error: {
      code: 'tab_outside',
      message: `Tab ${tabId} is outside this session's tabs. Bind, follow, or open a tab in the side panel before operating it, or call browser_list_tabs to find the controlled tab.`,
    },
  }
}

function isToolAnswer(value: unknown): value is ToolAnswer {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { ok?: unknown }).ok === 'boolean'
}

function isInjectablePage(url: string | undefined): boolean {
  return url !== undefined && /^https?:\/\//i.test(url)
}

/** Inject the packaged content script once per tab, coalescing concurrent recovery attempts. */
async function injectContentScript(tabId: number): Promise<void> {
  let pending = pendingInjections.get(tabId)
  if (pending === undefined) {
    pending = chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [CONTENT_SCRIPT_FILE],
    }).then(() => undefined)
    pendingInjections.set(tabId, pending)
  }
  try {
    await pending
  } finally {
    if (pendingInjections.get(tabId) === pending) pendingInjections.delete(tabId)
  }
}

async function sendAction(
  tabId: number,
  call: ToolCall,
  frame: TabFrame,
  budget?: ContentBudget,
  includePageDelta: boolean = false,
): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, {
    type: 'DSH_ACTION',
    action: call.name,
    args: withoutFrame(call.args),
    ...budget === undefined ? {} : { budget },
    ...includePageDelta ? { includePageDelta: true } : {},
  }, frame.documentId === undefined ? { frameId: frame.frameId } : { documentId: frame.documentId })
}

function contentScriptReceiverMissing(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Receiving end does not exist')
}

/**
 * Whether a send failure means the request never got an answer because its
 * receiving document went away, which is what a dispatched action that
 * navigates the page looks like from the background worker.
 */
function contentScriptGoneAfterDispatch(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message
  return message.includes('Receiving end does not exist')
    || message.includes('message port closed')
    || message.includes('Extension context invalidated')
}

/**
 * Report a dispatched action as successful when the page it operated is gone.
 *
 * Only a confirmed document replacement counts: the caller keeps its previous
 * error when nothing navigated.
 *
 * @param tabId - tab the action was dispatched to.
 * @param call - the tool call, for the status line.
 * @param budget - snapshot budget for the replacement page.
 * @param targetStillAllowed - affinity re-check for the replacement page.
 * @param before - frame records captured before the action was dispatched.
 * @param beforeUrl - tab URL observed before the action was dispatched.
 * @param mayReadPageContent - whether the page-content boundary allows reading
 *   the replacement document; false returns a status-only success.
 * @returns the success answer carrying the new snapshot, or undefined.
 */
async function answerNavigatedAfterDispatch(
  tabId: number,
  call: ToolCall,
  budget: ContentBudget,
  targetStillAllowed: (() => boolean) | undefined,
  before: TabFrame[],
  beforeUrl: string | undefined,
  mayReadPageContent: boolean,
): Promise<ToolAnswer | undefined> {
  if (!NAVIGATION_CANDIDATE_TOOLS.has(call.name) && !STATE_CHANGING_PAGE_TOOLS.has(call.name)) return undefined
  if (targetStillAllowed?.() === false) return undefined
  const beforeDocument = before.find((frame) => frame.frameId === 0)?.documentId
  const after = await listTabFrames(tabId, undefined).catch(() => undefined)
  const afterDocument = after?.find((frame) => frame.frameId === 0)?.documentId
  const replacement = beforeDocument !== undefined && afterDocument !== undefined
    ? beforeDocument !== afterDocument
    // Frame records can omit the document id (restored documents, older Chrome);
    // a changed tab URL is the fallback proof that the document was replaced.
    : await tabDocumentReplaced(tabId, beforeUrl)
  // A lost response without a replacement document is an ordinary failure: the
  // caller must keep its error rather than report a click that never happened.
  if (!replacement) return undefined
  const status = dispatchedActionStatus(call)
  if (!mayReadPageContent) {
    return {
      ok: true,
      result: { text: `${status} The page navigated. Page content sharing is disabled, so no snapshot was captured.` },
    }
  }
  try {
    const snapshot = await snapshotAfterNavigation(
      tabId,
      call,
      `${status} The page navigated.`,
      budget,
      targetStillAllowed,
      NAVIGATION_SNAPSHOT_GUIDANCE,
    )
    // The snapshot is opportunistic: the action still succeeded when the new
    // document is not readable yet, so report it and let the model snapshot.
    if (snapshot !== undefined) return snapshot
  } catch {
    // Fall through to the status-only success.
  }
  return {
    ok: true,
    result: { text: `${status} The page navigated. Call browser_snapshot again after it loads.` },
  }
}

/**
 * Whether the tab now shows a different document than `beforeUrl`.
 *
 * @param tabId - tab to read.
 * @param beforeUrl - URL observed before the action was dispatched.
 * @returns true when the committed URL differs.
 */
async function tabDocumentReplaced(tabId: number, beforeUrl: string | undefined): Promise<boolean> {
  if (beforeUrl === undefined) return false
  try {
    const tab = await chrome.tabs.get(tabId)
    const url = tab.url ?? tab.pendingUrl
    return url !== undefined && url !== beforeUrl
  } catch {
    // A closed tab has no replacement document; treat it as not navigated so
    // the caller keeps its original failure.
    return false
  }
}

/** Short status line for an action whose response was lost to a navigation. */
function dispatchedActionStatus(call: ToolCall): string {
  const index = typeof call.args.index === 'number' ? ` [${call.args.index}]` : ''
  switch (call.name) {
    case 'browser_click':
      return `Clicked${index}.`
    case 'browser_select':
      return `Selected an option in${index}.`
    case 'browser_upload_file':
      return `Uploaded files to${index}.`
    case 'browser_drag':
      return 'Dragged.'
    case 'browser_evaluate':
      return 'JavaScript executed.'
    default:
      return 'The action was dispatched.'
  }
}

function unavailable(message: string): ToolAnswer {
  return { ok: false, error: { code: 'content-unavailable', message } }
}

/** Report one browser-owned page with the shared `protected-page` refusal. */
function restrictedPageAnswer(kind: RestrictedPageKind): ToolAnswer {
  const refusal = restrictedPageRefusal(kind)
  return { ok: false, error: { code: refusal.code, message: refusal.message } }
}

function tabMetadataSnapshot(
  tabId: number,
  windowId: number | undefined,
  title: string | undefined,
  url: string | undefined,
  maxChars: number,
): ToolAnswer {
  const status = 'The current tab is available only through browser-level controls because its page DOM is protected or inaccessible. DOM snapshot, click, type, press, select, scroll, wait, text extraction, find, and file upload are unavailable here. Navigate, back, forward, reload, screenshot, resize, console and network telemetry, and JavaScript evaluation remain available.'
  const separator = '\n\n'
  const remaining = maxChars - status.length - separator.length
  if (remaining <= 0) return { ok: true, result: { text: status.slice(0, maxChars) } }
  return {
    ok: true,
    result: {
      text: `${status}${separator}${wrapUntrustedContent([
        `Tab ID: ${tabId}`,
        `Window ID: ${windowId ?? '(unknown)'}`,
        `Title: ${title ?? '(unknown)'}`,
        `URL: ${url ?? '(unknown)'}`,
      ].join('\n'), remaining)}`,
    },
  }
}

async function dispatchTabNativeTool(
  tabId: number,
  tabUrl: string | undefined,
  tabTitle: string | undefined,
  windowId: number | undefined,
  call: ToolCall,
  budget: ContentBudget,
  signal?: AbortSignal,
  targetStillAllowed?: () => boolean,
  commitAction?: () => void,
): Promise<ToolAnswer | undefined> {
  if (call.name === 'browser_snapshot') return tabMetadataSnapshot(tabId, windowId, tabTitle, tabUrl, budget.maxChars)
  if (!TAB_NATIVE_TOOLS.has(call.name)) return undefined
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()

  let operation: Promise<unknown>
  let text: string
  try {
    switch (call.name) {
      case 'browser_navigate': {
        const requested = parseHttpUrl(call.args.url)
        if (requested === undefined) {
          return { ok: false, error: { code: 'action-failed', message: 'url must be a complete http or https URL.' } }
        }
        commitAction?.()
        operation = chrome.tabs.update(tabId, { url: requested.href })
        text = `Navigating to ${requested.href}. Call browser_snapshot again after the page loads.`
        break
      }
      case 'browser_back':
        commitAction?.()
        operation = chrome.tabs.goBack(tabId)
        text = 'Navigating through browser history. Call browser_snapshot again after the page loads.'
        break
      case 'browser_forward':
        commitAction?.()
        operation = chrome.tabs.goForward(tabId)
        text = 'Navigating through browser history. Call browser_snapshot again after the page loads.'
        break
      case 'browser_reload':
        commitAction?.()
        operation = chrome.tabs.reload(tabId)
        text = 'The page is reloading. Call browser_snapshot again after it loads.'
        break
      default:
        return undefined
    }
    resetTabSnapshot(tabId)
    await operation
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return unavailable(`The browser-level operation failed: ${detail}`)
  }
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  return { ok: true, result: { text, navigationPending: true } }
}

function cancelled(): ToolAnswer {
  return { ok: false, error: { code: 'bridge-closed', message: 'The browser tool call was cancelled.' } }
}

/** Preserve the factual approval outcome for the model without prescribing a response. */
function approvalFailure(approval: ApprovalPrompt, authorization: Exclude<ApprovalAuthorization, 'approved'>): ToolAnswer {
  switch (authorization) {
    case 'denied':
      return {
        ok: false,
        error: { code: 'action-failed', message: `The user denied the browser approval request for "${approval.action}".` },
      }
    case 'unavailable':
      return {
        ok: false,
        error: {
          code: 'action-failed',
          message: `No browser side panel was available to receive or complete the approval request for "${approval.action}".`,
        },
      }
    case 'timed-out':
      return {
        ok: false,
        error: { code: 'timeout', message: `The browser approval request for "${approval.action}" timed out before the user responded.` },
      }
    case 'cancelled':
      return {
        ok: false,
        error: { code: 'bridge-closed', message: `The browser approval request for "${approval.action}" was cancelled.` },
      }
  }
}

function targetChanged(): ToolAnswer {
  return unavailable('The controlled tab changed during the operation. Confirm the page in the side panel before retrying.')
}

function isCancelled(call: ToolCall, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
    || (call.expiresAt !== undefined && Date.now() >= call.expiresAt)
}

function withoutFrame(args: Record<string, unknown>): Record<string, unknown> {
  const { frame: _frame, ...rest } = args
  return rest
}

function requestedFrame(args: Record<string, unknown>): number {
  const value = args.frame
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return -1
  return value
}

function answerText(answer: ToolAnswer): string | undefined {
  if (!answer.ok || typeof answer.result !== 'object' || answer.result === null) return undefined
  const text = (answer.result as { text?: unknown }).text
  return typeof text === 'string' ? text : undefined
}

function answerPageContent(answer: ToolAnswer): string | undefined {
  if (!answer.ok || typeof answer.result !== 'object' || answer.result === null) return undefined
  const pageContent = (answer.result as { pageContent?: unknown }).pageContent
  return typeof pageContent === 'string' ? pageContent : undefined
}

function answerNavigationPending(answer: ToolAnswer): boolean {
  return answer.ok
    && typeof answer.result === 'object'
    && answer.result !== null
    && (answer.result as { navigationPending?: unknown }).navigationPending === true
}

/** Keep extension-authored action status outside the nonce-bound page-data boundary. */
function wrapActionDelta(status: string, pageContent: string, frame: TabFrame, maxChars: number): string {
  const prefix = `${status}\n${ACTION_DELTA_GUIDANCE}`
  const separator = '\n\n'
  const boundaryBudget = maxChars - prefix.length - separator.length
  if (boundaryBudget < 500) return prefix.slice(0, maxChars)
  const framedContent = frame.frameId === 0 ? pageContent : `${frameHeader(frame)}\n${pageContent}`
  return `${prefix}${separator}${wrapUntrustedContent(framedContent, boundaryBudget)}`
}

async function snapshotAllFrames(
  tabId: number,
  frames: TabFrame[],
  call: ToolCall,
  budget: ContentBudget,
): Promise<ToolAnswer> {
  const budgets = allocateFrameBudgets(frames, budget)
  const previous = snapshotDocumentsByTab.get(tabId) ?? new Map<number, string>()
  const deltaRequested = call.args.delta === true

  const settled = await Promise.allSettled(frames.map(async (frame) => {
    const sameDocument = previous.get(frame.frameId) === frameDocumentKey(frame)
    const frameCall: ToolCall = {
      ...call,
      args: deltaRequested && sameDocument ? call.args : { ...call.args, delta: false },
    }
    const response = await sendAction(tabId, frameCall, frame, budgets.get(frame.frameId))
    return { frame, response }
  }))

  const sections: string[] = []
  const capturedDocuments = new Map<number, string>()
  for (let index = 0; index < settled.length; index += 1) {
    const outcome = settled[index]!
    const frame = frames[index]!
    if (outcome.status === 'rejected') {
      if (frame.frameId === 0) throw outcome.reason
      if (frame.recovered === true) {
        // A remembered subframe that no longer answers was destroyed while the
        // main document stayed alive. Drop it silently; it is not part of the
        // page any more, and reporting it would contradict the live DOM.
        forgetRecoveredSubframe(tabId, frame.frameId)
        continue
      }
      sections.push(frameHeader(frame), '(This iframe was inaccessible or destroyed while loading.)')
      continue
    }
    const answer = outcome.value.response
    if (!isToolAnswer(answer)) {
      if (frame.frameId === 0) return unavailable('The page content script returned an invalid response.')
      if (frame.recovered === true) {
        forgetRecoveredSubframe(tabId, frame.frameId)
        continue
      }
      sections.push(frameHeader(frame), '(This iframe returned an invalid response.)')
      continue
    }
    const text = answerText(answer)
    if (text === undefined) {
      if (frame.frameId === 0) return answer
      if (frame.recovered === true) {
        forgetRecoveredSubframe(tabId, frame.frameId)
        continue
      }
      sections.push(frameHeader(frame), `(This iframe could not be read: ${answer.error?.message ?? 'unknown error'})`)
      continue
    }
    capturedDocuments.set(frame.frameId, frameDocumentKey(frame))
    if (frame.frameId === 0) sections.push(text)
    else sections.push(frameHeader(frame), text)
  }

  if (deltaRequested) {
    const liveIds = new Set(frames.map((frame) => frame.frameId))
    const removed = [...previous.keys()].filter((frameId) => frameId !== 0 && !liveIds.has(frameId))
    if (removed.length > 0) sections.push(`\nRemoved iframes: ${removed.join(', ')}`)
  }

  snapshotDocumentsByTab.set(tabId, capturedDocuments)
  return { ok: true, result: { text: wrapUntrustedContent(sections.join('\n'), budget.maxChars) } }
}

function frameHeader(frame: TabFrame): string {
  return `\n--- iframe frame=${frame.frameId} parent=${frame.parentFrameId} origin=${frameOrigin(frame)} ---`
}

function stripDuplicateSnapshotPrompt(status: string): string {
  return status.replace(/ Call browser_snapshot again after (?:navigation settles|the page loads|it loads)\.$/, '')
}

async function snapshotAfterNavigation(
  tabId: number,
  call: ToolCall,
  status: string,
  budget: ContentBudget,
  targetStillAllowed?: () => boolean,
  guidance: string = NAVIGATION_SNAPSHOT_GUIDANCE,
): Promise<ToolAnswer | undefined> {
  const prefix = guidance === ''
    ? stripDuplicateSnapshotPrompt(status)
    : `${stripDuplicateSnapshotPrompt(status)}\n${guidance}`
  const snapshotMaxChars = budget.maxChars - prefix.length - 2
  if (snapshotMaxChars < 500) return undefined
  const frames = await listTabFrames(tabId, undefined)
  if (targetStillAllowed?.() === false) return targetChanged()
  const answer = await snapshotAllFrames(
    tabId,
    frames,
    { ...call, name: 'browser_snapshot', args: {} },
    { ...budget, maxChars: snapshotMaxChars },
  )
  const snapshot = answerText(answer)
  if (snapshot === undefined) return undefined
  return { ok: true, result: { text: `${prefix}\n\n${snapshot}` } }
}

/**
 * The status sentence for an action whose response was lost because the page
 * navigated. It replaces the content script's own text, which never arrived.
 */
function dispatchedNavigationStatus(call: ToolCall, includeSnapshot: boolean): string {
  const index = typeof call.args.index === 'number' ? ` [${call.args.index}]` : ''
  const verb = call.name === 'browser_click'
    ? `Clicked${index}.`
    : call.name === 'browser_select'
      ? `Selected an option in${index}.`
      : call.name === 'browser_upload_file'
        ? `Uploaded file(s) to${index}.`
        : call.name === 'browser_drag'
          ? 'Dragged the target.'
          : 'The action was dispatched.'
  if (!includeSnapshot) {
    return `${verb} The page navigated; call browser_snapshot to read the new document.`
  }
  return `${verb} The page navigated; the current page snapshot is included below. Use it directly instead of taking an immediate duplicate snapshot.`
}

/**
 * Wait for a readiness signal, giving up after `timeoutMs` without cancelling
 * the shared listener; the caller cancels it when it keeps the original error.
 */
function navigationReadyWithin(ready: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(false) }, timeoutMs) })
  return Promise.race([ready, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * Turn a lost response into success when the document really was replaced.
 *
 * The readiness listener was armed before the dispatch and only reports a
 * document other than the one that received the action, so it is the evidence
 * that the page navigated. Without it the original send failure stands.
 */
async function answerDispatchedNavigation(
  tabId: number,
  call: ToolCall,
  budget: ContentBudget,
  navigationWait: NavigationWait | undefined,
  error: unknown,
  signal: AbortSignal | undefined,
  targetStillAllowed: (() => boolean) | undefined,
  includeActionDelta: boolean,
): Promise<ToolAnswer | undefined> {
  if (navigationWait === undefined || !contentScriptGoneAfterDispatch(error)) return undefined
  // A missing receiver most often means the tab predates the content script,
  // which the caller recovers by injecting and retrying. Give a late navigation
  // only a short grace so that recovery is not delayed by the full readiness
  // timeout; a closed port proves the script ran, so it waits in full.
  const ready = contentScriptReceiverMissing(error)
    ? await navigationReadyWithin(navigationWait.ready, RECEIVER_MISSING_NAVIGATION_GRACE_MS)
    : await navigationWait.ready
  if (!ready) return undefined
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  if (includeActionDelta) {
    try {
      const snapshot = await snapshotAfterNavigation(
        tabId,
        call,
        dispatchedNavigationStatus(call, true),
        budget,
        targetStillAllowed,
        '',
      )
      if (snapshot !== undefined) return snapshot
    } catch {
      // The replacement page may still be settling; the action itself landed,
      // so report the navigation instead of the stale delivery error.
    }
  }
  return { ok: true, result: { text: dispatchedNavigationStatus(call, false) } }
}

async function dispatchOnce(
  tabId: number,
  frames: TabFrame[],
  call: ToolCall,
  budget: ContentBudget,
  signal?: AbortSignal,
  targetStillAllowed?: () => boolean,
  includeActionDelta: boolean = false,
  commitAction?: () => void,
  rollbackActionCommit?: () => void,
): Promise<ToolAnswer> {
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  if (call.name === 'browser_snapshot') return snapshotAllFrames(tabId, frames, call, budget)

  const frameId = requestedFrame(call.args)
  if (frameId < 0) return { ok: false, error: { code: 'action-failed', message: 'frame must be a non-negative integer.' } }
  const frame = frames.find((candidate) => candidate.frameId === frameId)
  if (frame === undefined) {
    return unavailable(`Frame ${frameId} does not exist or has navigated. Call browser_snapshot again.`)
  }
  // No await occurs between this guard and tabs.sendMessage, so an expired
  // approval cannot cross the final state-changing dispatch boundary.
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  const hasSnapshotBaseline = snapshotDocumentsByTab.get(tabId)?.get(frameId) === frameDocumentKey(frame)
  const requestPageDelta = includeActionDelta && hasSnapshotBaseline && ACTION_DELTA_TOOLS.has(call.name)
  // Armed for every action that can navigate, not only when page content is
  // shared: a lost response still proves the action landed, and only the
  // snapshot half of the answer is gated on page-content permission.
  const navigationWait = isNavigationCandidateTool(call.name)
    ? waitForNextDocumentReady(tabId, frameId, frame.documentId, signal)
    : undefined
  let response: unknown
  const stateChanging = STATE_CHANGING_PAGE_TOOLS.has(call.name)
  try {
    if (stateChanging) commitAction?.()
    response = await sendAction(
      tabId,
      call,
      frame,
      requestPageDelta ? budget : undefined,
      requestPageDelta,
    )
  } catch (error: unknown) {
    const navigationAnswer = await answerDispatchedNavigation(
      tabId,
      call,
      budget,
      navigationWait,
      error,
      signal,
      targetStillAllowed,
      includeActionDelta,
    )
    if (navigationAnswer !== undefined) return navigationAnswer
    if (stateChanging && contentScriptReceiverMissing(error)) rollbackActionCommit?.()
    navigationWait?.cancel()
    throw error
  }
  if (isCancelled(call, signal)) {
    navigationWait?.cancel()
    return cancelled()
  }
  if (!isToolAnswer(response)) {
    navigationWait?.cancel()
    return unavailable('The page content script returned an invalid response.')
  }
  const text = answerText(response)
  if (text === undefined) {
    navigationWait?.cancel()
    return response
  }
  if (answerNavigationPending(response) && navigationWait !== undefined && includeActionDelta) {
    const ready = await navigationWait.ready
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    if (ready) {
      try {
        const snapshot = await snapshotAfterNavigation(tabId, call, text, budget, targetStillAllowed)
        if (snapshot !== undefined) return snapshot
      } catch {
        // Preserve the successful navigation status when the replacement page
        // becomes unavailable before its opportunistic snapshot completes.
      }
    }
  } else {
    navigationWait?.cancel()
  }
  if (call.name === 'browser_get_text') {
    return { ok: true, result: { text: wrapUntrustedContent(text, budget.maxChars) } }
  }
  const pageContent = requestPageDelta ? answerPageContent(response) : undefined
  return {
    ok: true,
    result: {
      text: pageContent === undefined ? text : wrapActionDelta(text, pageContent, frame, budget.maxChars),
    },
  }
}

function requestedTabId(args: Record<string, unknown>): number | undefined {
  const value = args.tabId
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function tabUrl(tab: chrome.tabs.Tab): string {
  return tab.url ?? tab.pendingUrl ?? ''
}

function approvalDisplayUrl(value: string): string {
  try {
    const url = new URL(value)
    const display = url.protocol === 'http:' || url.protocol === 'https:'
      ? `${url.origin}${url.pathname}`
      : `${url.protocol}//${url.host}${url.pathname}`
    return display.replace(/\s+/g, ' ').slice(0, 160)
  } catch {
    return '(unknown URL)'
  }
}

function tabManagementApproval(call: ToolCall, tab?: chrome.tabs.Tab): ApprovalPrompt {
  const locale = getUiLocale()
  if (call.name === 'browser_list_tabs') {
    return {
      kind: 'read',
      action: call.name,
      summary: locale === 'zh' ? '读取所有已打开标签页的标题和链接' : 'Read the titles and URLs of all open tabs',
      origins: [],
      canTrust: false,
    }
  }
  if (call.name === 'browser_close' && tab === undefined) {
    return {
      kind: 'action',
      action: call.name,
      summary: locale === 'zh' ? '关闭本会话打开的标签页' : 'Close the tabs this session opened',
      origins: [],
      canTrust: false,
    }
  }
  const url = tab === undefined ? '' : tabUrl(tab)
  const origin = originFromUrl(url)
  const display = approvalDisplayUrl(url)
  return {
    kind: 'action',
    action: call.name,
    summary: call.name === 'browser_follow_tab'
      ? (locale === 'zh' ? `跟随标签页 ${tab?.id ?? '?'}：${display}` : `Follow tab ${tab?.id ?? '?'}: ${display}`)
      : (locale === 'zh' ? `关闭标签页 ${tab?.id ?? '?'}：${display}` : `Close tab ${tab?.id ?? '?'}: ${display}`),
    origins: origin === undefined ? [] : [origin],
    canTrust: false,
  }
}

async function authorizeTabManagement(
  prompt: ApprovalPrompt,
  unrestrictedAccess: boolean,
  authorize: ((prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>) | undefined,
  call: ToolCall,
  signal: AbortSignal | undefined,
): Promise<ToolAnswer | undefined> {
  if (unrestrictedAccess) return undefined
  const authorization = authorize === undefined ? 'unavailable' : await authorize(prompt)
  if (isCancelled(call, signal)) return cancelled()
  return authorization === 'approved' ? undefined : approvalFailure(prompt, authorization)
}

async function findTab(tabId: number): Promise<chrome.tabs.Tab | undefined> {
  try {
    return await chrome.tabs.get(tabId)
  } catch {
    return undefined
  }
}

async function dispatchTabManagementTool(
  call: ToolCall,
  budget: ContentBudget,
  authorize: ((prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>) | undefined,
  signal: AbortSignal | undefined,
  context: TabManagementContext,
): Promise<ToolAnswer> {
  if (call.name === 'browser_list_tabs') {
    const approval = tabManagementApproval(call)
    const rejected = await authorizeTabManagement(approval, context.unrestrictedAccess, authorize, call, signal)
    if (rejected !== undefined) return rejected
    const tabs = await chrome.tabs.query({})
    if (isCancelled(call, signal)) return cancelled()
    const records = tabs
      .filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id !== undefined)
      .sort((left, right) => left.windowId - right.windowId || left.index - right.index)
      .map((tab) => ({
        tabId: tab.id,
        windowId: tab.windowId,
        index: tab.index,
        active: tab.active,
        controlled: tab.id === context.controlledTabId,
        owned: context.ownsTab === undefined || context.ownsTab(tab.id),
        // How the tab entered this connection: opened through browser_open_tab
        // (created) versus pre-existing, bound, or followed (adopted).
        origin: createdTabIds.has(tab.id) ? 'created' : 'adopted',
        title: tab.title ?? '',
        url: tabUrl(tab),
      }))
    return {
      ok: true,
      result: { text: wrapUntrustedContent(JSON.stringify({ tabs: records }, null, 2), budget.maxChars) },
    }
  }

  if (call.name === 'browser_close') {
    return dispatchCloseTool(call, authorize, signal, context)
  }

  const tabId = requestedTabId(call.args)
  if (tabId === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'tabId must be a non-negative safe integer returned by browser_list_tabs.' } }
  }
  const before = await findTab(tabId)
  if (before === undefined) return unavailable(`Tab ${tabId} is no longer open. Call browser_list_tabs again.`)
  // browser_follow_tab is the one explicit way to widen the owned set, so it is
  // allowed to name a tab the session does not own yet; the approval below is
  // the user's consent for that expansion.
  if (call.name !== 'browser_follow_tab') {
    const outsideRefusal = resolveTargetTab(tabId, context)
    if (outsideRefusal !== undefined) return outsideRefusal
  }
  const approval = tabManagementApproval(call, before)
  const rejected = await authorizeTabManagement(approval, context.unrestrictedAccess, authorize, call, signal)
  if (rejected !== undefined) return rejected
  const current = await findTab(tabId)
  if (current === undefined) return unavailable(`Tab ${tabId} closed while approval was pending. Call browser_list_tabs again.`)
  if (tabUrl(current) !== tabUrl(before)) {
    return unavailable(`Tab ${tabId} navigated while approval was pending. Call browser_list_tabs again before retrying.`)
  }
  if (isCancelled(call, signal)) return cancelled()

  if (call.name === 'browser_follow_tab') {
    if (context.followTab === undefined) return unavailable('The browser could not bind the selected tab in this session.')
    context.commitAction?.()
    await context.followTab(current)
    return {
      ok: true,
      result: { text: `Tab ${tabId} is now the controlled tab. Call browser_snapshot before operating its page.` },
    }
  }
  if (call.name === 'browser_close_tab') return closeTabById(tabId, context)
  return unavailable(`Unsupported tab-management tool: ${call.name}`)
}

/**
 * Close one tab and drop it from the created-tab ledger.
 *
 * Both tab-closing tools share this implementation so the reported text and the
 * ownership bookkeeping cannot drift between them.
 * @param tabId - tab to close.
 * @param context - affinity context carrying the controlled tab and commit hook.
 * @returns the close status, or the refusal when the browser declined.
 */
async function closeTabById(tabId: number, context: TabManagementContext): Promise<ToolAnswer> {
  try {
    context.commitAction?.()
    await chrome.tabs.remove(tabId)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return unavailable(`Tab ${tabId} could not be closed: ${detail}`)
  }
  createdTabIds.delete(tabId)
  return {
    ok: true,
    result: {
      text: tabId === context.controlledTabId
        ? `Closed controlled tab ${tabId}. Call browser_list_tabs and browser_follow_tab before the next page operation.`
        : `Closed tab ${tabId}.`,
    },
  }
}

/**
 * `browser_close`: ownership-aware cleanup of the tabs this session opened.
 *
 * Without `tabId` it closes only tabs this connection created, and a session
 * with none closes nothing and succeeds — cleanup must be safe to call
 * unconditionally. A named tab is refused with the reason when this session
 * neither opened nor followed it, instead of being silently skipped.
 * @param call - the tool call (`tabId` optional).
 * @param authorize - approval request channel.
 * @param signal - bridge lifetime.
 * @param context - affinity context carrying ownership and the controlled tab.
 * @returns the closed ids as status text.
 */
async function dispatchCloseTool(
  call: ToolCall,
  authorize: ((prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>) | undefined,
  signal: AbortSignal | undefined,
  context: TabManagementContext,
): Promise<ToolAnswer> {
  const requested = call.args.tabId
  if (requested === undefined) {
    const owned = await liveCreatedTabs()
    const targets = context.ownsTab === undefined
      ? owned
      : owned.filter((tabId) => context.ownsTab?.(tabId) === true)
    // Cleanup of nothing needs no approval: the call is safe and its answer is
    // the empty report, not a prompt the user must dismiss.
    if (targets.length === 0) {
      return {
        ok: true,
        result: { text: 'Closed no tabs: this session has not opened any tab (closed: []).' },
      }
    }
    const approval = tabManagementApproval(call)
    const rejected = await authorizeTabManagement(approval, context.unrestrictedAccess, authorize, call, signal)
    if (rejected !== undefined) return rejected
    if (isCancelled(call, signal)) return cancelled()
    const closed: number[] = []
    const failures: string[] = []
    for (const tabId of targets) {
      const answer = await closeTabById(tabId, context)
      if (answer.ok) closed.push(tabId)
      else failures.push(answer.error?.message ?? `Tab ${tabId} could not be closed.`)
    }
    if (failures.length > 0) {
      return {
        ok: false,
        error: {
          code: 'action-failed',
          message: `Closed ${closed.length} tab(s): [${closed.join(', ')}]. ${failures.join(' ')}`,
        },
      }
    }
    return {
      ok: true,
      result: { text: `Closed ${closed.length} tab(s) opened by this session: [${closed.join(', ')}].` },
    }
  }

  const tabId = requestedTabId(call.args)
  if (tabId === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'tabId must be a non-negative safe integer returned by browser_list_tabs.' } }
  }
  const before = await findTab(tabId)
  if (before === undefined) return unavailable(`Tab ${tabId} is no longer open. Call browser_list_tabs again.`)
  if (context.ownsTab !== undefined && !context.ownsTab(tabId)) {
    return {
      ok: false,
      error: {
        code: 'tab_outside',
        message: `Tab ${tabId} was not opened or followed by this session, so it is not this session's to close. Call browser_list_tabs to find a tab this session owns.`,
      },
    }
  }
  const approval = tabManagementApproval(call, before)
  const rejected = await authorizeTabManagement(approval, context.unrestrictedAccess, authorize, call, signal)
  if (rejected !== undefined) return rejected
  const current = await findTab(tabId)
  if (current === undefined) return unavailable(`Tab ${tabId} closed while approval was pending. Call browser_list_tabs again.`)
  if (tabUrl(current) !== tabUrl(before)) {
    return unavailable(`Tab ${tabId} navigated while approval was pending. Call browser_list_tabs again before retrying.`)
  }
  if (isCancelled(call, signal)) return cancelled()
  return closeTabById(tabId, context)
}

// ---- Real pointer input through CDP, with the synthesized-event fallback ----

/** Viewport geometry returned by the internal `browser_pointer_rect` action. */
interface PointerRect {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}

/** Parsed real-input options of one `browser_click`. */
interface RealClickOptions {
  button: CdpMouseButton
  count: number
  modifiers: number
}

/** The real-input plan for one tool call. */
type PointerKind = 'hover' | 'click' | 'drag'

/**
 * Whether this click opted into real input by passing one of its new
 * arguments. A plain left click keeps the existing content-script path so the
 * documented behavior of the original tools does not change.
 * @param args - tool arguments.
 * @returns true when `button`, `count`, or `modifiers` was supplied.
 */
function clickRequestsRealInput(args: Record<string, unknown>): boolean {
  return args.button !== undefined || args.count !== undefined || args.modifiers !== undefined
}

function pointerKindOf(call: ToolCall): PointerKind | undefined {
  if (call.name === 'browser_hover') return 'hover'
  if (call.name === 'browser_drag') return 'drag'
  if (call.name === 'browser_click' && clickRequestsRealInput(call.args)) return 'click'
  return undefined
}

/**
 * Validate the click-only real-input arguments.
 * @param args - tool arguments.
 * @returns parsed options, or the `bad-args` answer.
 */
function parseRealClickOptions(args: Record<string, unknown>): { options: RealClickOptions } | { error: ToolAnswer } {
  const button = args.button === undefined ? 'left' : args.button
  if (button !== 'left' && button !== 'right' && button !== 'middle') {
    return { error: badArgs('button must be "left", "right", or "middle".') }
  }
  const count = args.count === undefined ? 1 : args.count
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 3) {
    return { error: badArgs('count must be an integer from 1 to 3.') }
  }
  if (args.modifiers !== undefined && typeof args.modifiers !== 'string') {
    return { error: badArgs('modifiers must be a string such as "ctrl+shift".') }
  }
  const modifiers = modifierMask(typeof args.modifiers === 'string' ? args.modifiers : undefined)
  if (modifiers === undefined) {
    return { error: badArgs('modifiers contains an unknown key; use alt, ctrl, meta, or shift, joined by "+".') }
  }
  return { options: { button, count, modifiers } }
}

/**
 * Validate and resolve the `browser_press` key before any dispatch.
 *
 * An empty key and an unsupported multi-character name are both refused:
 * synthesizing an arbitrary named key would report a press the browser never
 * performed.
 * @param args - tool arguments.
 * @returns the resolved key, or the `bad-args` answer.
 */
function parsePressKeyArg(args: Record<string, unknown>): { stroke: KeyStroke } | { error: ToolAnswer } {
  const key = typeof args.key === 'string' ? args.key : ''
  if (key === '') return { error: badArgs('key must not be empty.') }
  const stroke = parseKeyStroke(key)
  if (stroke === undefined) {
    return {
      error: badArgs(
        `Unsupported key "${key}". Use a single character, or one of: ${NAMED_KEY_NAMES.join(', ')}.`,
      ),
    }
  }
  return { stroke }
}

/**
 * Read the browser facts that decide whether real input reaches a tab.
 *
 * `chrome.windows` is absent on Firefox, and a tab whose window cannot be
 * read has no provable focus, so both are reported as unavailable rather than
 * assumed focused.
 * @param tabId - target tab.
 * @returns active state of the tab and focus state of its window.
 */
async function readRealInputState(tabId: number): Promise<RealInputState> {
  const windowsApi: typeof chrome.windows | undefined = chrome.windows
  const windowApiAvailable = typeof windowsApi?.get === 'function'
  let tabActive: boolean | undefined
  let windowFocused: boolean | undefined
  try {
    const tab = await chrome.tabs.get(tabId)
    tabActive = tab.active
    if (windowApiAvailable && typeof tab.windowId === 'number') {
      try {
        windowFocused = (await windowsApi.get(tab.windowId)).focused
      } catch {
        // The window may have closed between the tab read and the window read.
        windowFocused = undefined
      }
    }
  } catch {
    // A tab that cannot be re-read is no longer a provable input target.
    tabActive = undefined
  }
  return { tabActive, windowApiAvailable, windowFocused }
}

/** The focus condition that stopped real input, without the consequence clause. */
function focusDegradationReason(reason: RealInputUnavailableReason): string {
  return reason === 'tab-not-active'
    ? 'the controlled tab is not focused because another tab is active in its window'
    : reason === 'window-api-unavailable'
      ? 'this browser build cannot report whether the controlled tab is focused'
      : 'the controlled tab is not focused because its window is not focused'
}

/**
 * Explain why real input was replaced by synthesized events.
 * @param reason - blocking condition reported by `realInputVerdict`.
 * @returns the model-facing disclosure appended to the action result.
 */
function pointerFocusDegradation(reason: RealInputUnavailableReason): string {
  return `(synthesized events: ${focusDegradationReason(reason)}, so real input would not reach the page)`
}

/** The coordinate lookup arguments the internal action needs. */
function pointerRectArgs(call: ToolCall, settle = false): Record<string, unknown> {
  const args: Record<string, unknown> = { ...(settle ? { settle: true } : {}) }
  if (call.name === 'browser_drag') {
    if (call.args.from_index !== undefined || call.args.to_index !== undefined) {
      args.from_index = call.args.from_index
      args.to_index = call.args.to_index
    } else {
      args.from = call.args.from
      args.to = call.args.to
    }
    return args
  }
  if (call.args.index !== undefined) {
    args.index = call.args.index
    return args
  }
  args.x = call.args.x
  args.y = call.args.y
  return args
}

function isPointerRect(value: unknown): value is PointerRect {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.x === 'number'
    && typeof record.y === 'number'
    && record.visible === true
}

function parseDragRects(text: string): { from: PointerRect; to: PointerRect; nativeDrag: boolean } | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    return isPointerRect(parsed.from) && isPointerRect(parsed.to)
      ? { from: parsed.from, to: parsed.to, nativeDrag: parsed.nativeDrag === true }
      : undefined
  } catch {
    return undefined
  }
}

function parseSingleRect(text: string): PointerRect | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    return isPointerRect(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

async function sendPointerRect(
  tabId: number,
  frame: TabFrame,
  call: ToolCall,
  budget: ContentBudget | undefined,
  includePageDelta: boolean,
): Promise<ToolAnswer> {
  return await sendAction(
    tabId,
    { id: call.id, name: 'browser_pointer_rect', args: pointerRectArgs(call, includePageDelta) },
    frame,
    budget,
    includePageDelta,
  ) as ToolAnswer
}

/**
 * Append the fallback disclosure to a synthesized-action answer.
 * @param answer - the content-script path's answer.
 * @param note - the degradation note, when real input was unavailable.
 * @returns the answer with the note appended to a successful text result.
 */
function withPointerDegradation(answer: ToolAnswer, note: string | undefined): ToolAnswer {
  if (note === undefined || !answer.ok) return answer
  const text = answerText(answer)
  if (text === undefined) return answer
  return {
    ...answer,
    result: { ...(answer.result as Record<string, unknown>), text: `${text}\n\n${note}` },
  }
}

/**
 * Replace the synthesized press status with the documented degradation form.
 *
 * The content script reports `Sent key "X".`; when real key events were
 * unavailable the answer must name the synthesized path and its reason
 * instead of implying the browser performed the key.
 * @param answer - the content-script path's answer.
 * @param call - the tool call, for the key name.
 * @param note - the reason clause, when real key events were unavailable.
 * @returns the answer with the corrected status line.
 */
function withKeyDegradation(answer: ToolAnswer, call: ToolCall, note: string | undefined): ToolAnswer {
  if (note === undefined || !answer.ok) return answer
  const key = typeof call.args.key === 'string' ? call.args.key : ''
  const text = answerText(answer)
  if (text === undefined) return answer
  const original = `Sent key ${JSON.stringify(key)}.`
  const replacement = `Sent key ${JSON.stringify(key)} with synthesized key events ${note}.`
  const updated = text.startsWith(original)
    ? `${replacement}${text.slice(original.length)}`
    : `${text}\n\n${replacement}`
  return {
    ...answer,
    result: { ...(answer.result as Record<string, unknown>), text: updated },
  }
}

/** Status line for a real-input action. */
function pointerStatus(
  kind: PointerKind,
  call: ToolCall,
  rect: PointerRect,
  to?: PointerRect,
  options?: RealClickOptions,
  dragMode?: DragPointerMode,
): string {
  const index = typeof call.args.index === 'number' ? call.args.index : undefined
  if (kind === 'hover') {
    return index === undefined
      ? `Hovered at (${rect.x}, ${rect.y}) with real mouse events through the browser input pipeline.`
      : `Hovered over [${index}] at (${rect.x}, ${rect.y}) with real mouse events through the browser input pipeline.`
  }
  if (kind === 'click') {
    const button = options?.button ?? 'left'
    const label = button === 'left' ? '' : `${button} button, `
    const count = options !== undefined && options.count > 1 ? `${options.count} clicks, ` : ''
    return `Clicked [${index ?? '?'}] (${label}${count}real mouse events).`
  }
  const pipeline = dragMode === 'native' ? 'native drag events' : 'real mouse events'
  return `Dragged from (${rect.x}, ${rect.y}) to (${to?.x ?? '?'}, ${to?.y ?? '?'}) with ${pipeline} through the browser input pipeline.`
}

/** Ask the content script for the settled page delta after a real key press. */
async function readActionDelta(tabId: number, frame: TabFrame, budget: ContentBudget): Promise<string | undefined> {
  const answer = await sendAction(
    tabId,
    { id: 'browser_action_delta', name: 'browser_action_delta', args: {} },
    frame,
    budget,
    true,
  ) as ToolAnswer
  return answerPageContent(answer)
}

/**
 * Run `browser_press` through real CDP key events.
 *
 * Real key events are what move focus (Tab), scroll (arrows), or submit a form
 * (Enter); a synthesized `KeyboardEvent` never triggers those defaults. When
 * the debugger, focus, or frame target makes real input impossible, this
 * function only contributes the degradation reason and the caller runs the
 * content script's synthesized path.
 * @param tabId - target tab.
 * @param tabUrl - current URL, used to refuse protected pages.
 * @param frames - the tab's frames.
 * @param call - tool call being dispatched.
 * @param budget - output budget used for the automatic page delta.
 * @param includeActionDelta - whether automatic page context is allowed.
 * @param signal - bridge lifetime.
 * @param targetStillAllowed - final fail-closed guard.
 * @param commitAction - marks the withdrawability boundary.
 * @returns a settled answer, or a degradation notice when the content fallback must run.
 */
async function dispatchRealKeyTool(
  tabId: number,
  tabUrl: string | undefined,
  frames: TabFrame[],
  call: ToolCall,
  budget: ContentBudget,
  includeActionDelta: boolean,
  signal: AbortSignal | undefined,
  targetStillAllowed: (() => boolean) | undefined,
  commitAction: (() => void) | undefined,
): Promise<{ answer?: ToolAnswer; degradedNote?: string } | undefined> {
  if (call.name !== 'browser_press') return undefined
  const parsed = parsePressKeyArg(call.args)
  if ('error' in parsed) return { answer: parsed.error }
  // Keyboard events go to the focused document, so a non-main frame keeps the
  // synthesized path whose target element lives in that frame.
  const frame = frames.find((candidate) => candidate.frameId === 0)
  if (frame === undefined || requestedFrame(call.args) !== 0 || !isInjectablePage(tabUrl)) {
    return { degradedNote: KEY_IFRAME_DEGRADATION }
  }
  if (isCancelled(call, signal)) return { answer: cancelled() }
  if (targetStillAllowed?.() === false) return { answer: targetChanged() }
  const verdict = realInputVerdict(await readRealInputState(tabId))
  if (!verdict.usable) return { degradedNote: `(${focusDegradationReason(verdict.reason)}, so real input would not reach the page)` }
  try {
    await ensureAttached(tabId)
  } catch (error: unknown) {
    if (error instanceof DebuggerUnavailableError) return { degradedNote: KEY_DEBUGGER_DEGRADATION }
    return { answer: toolFailure(error) }
  }
  if (isCancelled(call, signal)) return { answer: cancelled() }
  if (targetStillAllowed?.() === false) return { answer: targetChanged() }
  if (STATE_CHANGING_PAGE_TOOLS.has(call.name)) commitAction?.()
  try {
    await pressKey(tabId, parsed.stroke)
  } catch (error: unknown) {
    return { answer: toolFailure(error) }
  }
  const key = typeof call.args.key === 'string' ? call.args.key : ''
  const status = `Sent key ${JSON.stringify(key)} with real key events.`
  const hasSnapshotBaseline = snapshotDocumentsByTab.get(tabId)?.get(0) === frameDocumentKey(frame)
  if (!includeActionDelta || !hasSnapshotBaseline) return { answer: { ok: true, result: { text: status } } }
  try {
    const pageContent = await readActionDelta(tabId, frame, budget)
    return {
      answer: pageContent === undefined
        ? { ok: true, result: { text: status } }
        : { ok: true, result: { text: wrapActionDelta(status, pageContent, frame, budget.maxChars) } },
    }
  } catch {
    // The key already landed; a missing delta is not a failure.
    return { answer: { ok: true, result: { text: status } } }
  }
}

/**
 * Run a hover, drag, or option-carrying click through real CDP input events.
 *
 * A plain left click never reaches this function. When the debugger is
 * unavailable, cannot attach, or the target lives in an iframe, the caller
 * falls back to the content script's synthesized events and this function
 * only contributes the degradation note.
 * @param tabId - target tab.
 * @param tabUrl - current URL, used to refuse protected pages.
 * @param frames - the tab's frames.
 * @param call - tool call being dispatched.
 * @param budget - output budget used for the automatic page delta.
 * @param includeActionDelta - whether automatic page context is allowed.
 * @param signal - bridge lifetime.
 * @param targetStillAllowed - final fail-closed guard.
 * @param commitAction - marks the withdrawability boundary.
 * @returns a settled answer, or a degradation notice when the content fallback must run.
 */
async function dispatchRealPointerTool(
  tabId: number,
  tabUrl: string | undefined,
  frames: TabFrame[],
  call: ToolCall,
  budget: ContentBudget,
  includeActionDelta: boolean,
  signal: AbortSignal | undefined,
  targetStillAllowed: (() => boolean) | undefined,
  commitAction: (() => void) | undefined,
): Promise<{ answer?: ToolAnswer; degradedNote?: string } | undefined> {
  const kind = pointerKindOf(call)
  if (kind === undefined) return undefined
  // CDP coordinates are main-frame viewport pixels. An iframe target keeps the
  // synthesized path, whose coordinates are frame-local and already correct.
  const frame = frames.find((candidate) => candidate.frameId === 0)
  if (frame === undefined || requestedFrame(call.args) !== 0 || !isInjectablePage(tabUrl)) {
    return { degradedNote: POINTER_IFRAME_DEGRADATION }
  }
  let options: RealClickOptions | undefined
  if (kind === 'click') {
    const parsed = parseRealClickOptions(call.args)
    if ('error' in parsed) return { answer: parsed.error }
    options = parsed.options
  }
  if (isCancelled(call, signal)) return { answer: cancelled() }
  if (targetStillAllowed?.() === false) return { answer: targetChanged() }
  // `Input.dispatchMouseEvent` is a no-op for a background tab, so a dispatch
  // there would be reported as success without ever reaching the page.
  const verdict = realInputVerdict(await readRealInputState(tabId))
  if (!verdict.usable) return { degradedNote: pointerFocusDegradation(verdict.reason) }
  try {
    await ensureAttached(tabId)
  } catch (error: unknown) {
    if (error instanceof DebuggerUnavailableError) return { degradedNote: `${POINTER_DEBUGGER_DEGRADATION} (${error.message})` }
    return { answer: toolFailure(error) }
  }
  let rects: { from: PointerRect; to: PointerRect } | PointerRect
  try {
    const lookup = await sendPointerRect(tabId, frame, call, undefined, false)
    const text = answerText(lookup)
    if (text === undefined) {
      // The content script refused the target (missing element, changed page);
      // let its own path report that with the documented message.
      return { degradedNote: POINTER_TARGET_DEGRADATION }
    }
    if (kind === 'drag') {
      const parsed = parseDragRects(text)
      if (parsed === undefined) return { degradedNote: POINTER_TARGET_DEGRADATION }
      if (!parsed.from.visible || !parsed.to.visible) return { degradedNote: POINTER_OFFSCREEN_DEGRADATION }
      rects = parsed
    } else {
      const parsed = parseSingleRect(text)
      if (parsed === undefined) return { degradedNote: POINTER_TARGET_DEGRADATION }
      if (!parsed.visible) return { degradedNote: POINTER_OFFSCREEN_DEGRADATION }
      rects = parsed
    }
  } catch {
    return { degradedNote: POINTER_TARGET_DEGRADATION }
  }
  if (isCancelled(call, signal)) return { answer: cancelled() }
  if (targetStillAllowed?.() === false) return { answer: targetChanged() }
  if (STATE_CHANGING_PAGE_TOOLS.has(call.name)) commitAction?.()
  let dragMode: DragPointerMode | undefined
  try {
    if (kind === 'hover') {
      await movePointer(tabId, rects as PointerRect)
    } else if (kind === 'click') {
      await clickPointer(tabId, rects as PointerRect, options as RealClickOptions)
    } else {
      const drag = rects as { from: PointerRect; to: PointerRect; nativeDrag: boolean }
      dragMode = await dragPointer(tabId, drag.from, drag.to, { nativeDrag: drag.nativeDrag })
    }
  } catch (error: unknown) {
    if (error instanceof NativeDragUnavailableError) return { degradedNote: POINTER_NATIVE_DRAG_DEGRADATION }
    return { answer: toolFailure(error) }
  }
  const single = rects as PointerRect
  const drag = rects as { from: PointerRect; to: PointerRect }
  const status = pointerStatus(kind, call, kind === 'drag' ? drag.from : single, kind === 'drag' ? drag.to : undefined, options, dragMode)
  const hasSnapshotBaseline = snapshotDocumentsByTab.get(tabId)?.get(0) === frameDocumentKey(frame)
  if (!includeActionDelta || !hasSnapshotBaseline) return { answer: { ok: true, result: { text: status } } }
  try {
    const deltaAnswer = await sendPointerRect(tabId, frame, call, budget, true)
    const pageContent = answerPageContent(deltaAnswer)
    return {
      answer: pageContent === undefined
        ? { ok: true, result: { text: status } }
        : { ok: true, result: { text: wrapActionDelta(status, pageContent, frame, budget.maxChars) } },
    }
  } catch {
    // The action already landed; a missing delta is not a failure.
    return { answer: { ok: true, result: { text: status } } }
  }
}

const POINTER_DEBUGGER_DEGRADATION = 'The browser debugger was unavailable, so this action was synthesized as DOM events inside the page instead of using the browser input pipeline; canvas, cross-origin iframe, and system-level drop targets may ignore it.'
const POINTER_IFRAME_DEGRADATION = 'This target is an iframe, so the action was synthesized as DOM events inside that frame instead of using the browser input pipeline; system-level drop targets may ignore it.'
const POINTER_TARGET_DEGRADATION = 'The real-input coordinate lookup failed, so this action was synthesized as DOM events inside the page instead of using the browser input pipeline.'
const POINTER_OFFSCREEN_DEGRADATION = 'The target could not be kept fully inside the viewport for real pointer events, so this action was synthesized as DOM events inside the page instead.'
const POINTER_NATIVE_DRAG_DEGRADATION = 'The browser input pipeline could not dispatch native drag events for this target. This drag was replayed inside the page instead; canvas and system-level drop targets may ignore it.'
const POINTER_SYNTHETIC_CLICK_SEMANTICS = 'The requested button, click count, and modifiers were simulated on those synthesized events instead of the browser input pipeline.'
const POINTER_SYNTHETIC_DRAG_SEMANTICS = 'This drag used synthesized drag events inside the page.'
const KEY_DEBUGGER_DEGRADATION = '(the browser debugger was unavailable, so this key was synthesized as DOM events inside the page)'
const KEY_IFRAME_DEGRADATION = '(this target is an iframe, so this key was synthesized as DOM events inside that frame)'

/**
 * Add the click-semantics disclosure to a synthesized click's degradation note.
 * @param call - tool call being answered.
 * @param note - the degradation note produced by the real-input attempt.
 * @returns the note with the click disclosure appended for option-carrying clicks.
 */
function degradationNoteFor(call: ToolCall, note: string | undefined): string | undefined {
  if (note === undefined) return undefined
  if (call.name === 'browser_drag') return `${note} ${POINTER_SYNTHETIC_DRAG_SEMANTICS}`
  return call.name === 'browser_click' && clickRequestsRealInput(call.args)
    ? `${note} ${POINTER_SYNTHETIC_CLICK_SEMANTICS}`
    : note
}

/**
 * Dispatch one tool call to the selected tab's content script.
 * @param call - the tool call to execute.
 * @param sharePageContent - the user's page-sharing preference ('off' blocks
 *   every page-content read).
 * @param budget - snapshot limits to restore after on-demand content-script injection.
 * @param signal - bridge lifetime; cancellation prevents any not-yet-sent page action.
 * @param targetTab - tab selected by the background affinity controller.
 * @param targetStillAllowed - final fail-closed guard after asynchronous approval/navigation checks.
 * @param tabManagement - access mode and affinity callbacks for tab collection tools.
 * @returns the content script's answer, or a stable error when no tab or
 *   content script is available.
 */
export async function dispatchToolCall(
  call: ToolCall,
  sharePageContent: 'ask' | 'auto' | 'off',
  budget?: ContentBudget,
  authorize?: (prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>,
  signal?: AbortSignal,
  targetTab?: Pick<chrome.tabs.Tab, 'id' | 'url' | 'title'> & { windowId?: number },
  targetStillAllowed?: () => boolean,
  tabManagement: TabManagementContext = { unrestrictedAccess: false },
): Promise<ToolAnswer> {
  if (call.name === 'browser_open_tab') {
    return unavailable('browser_open_tab must be dispatched through the background open-tab path.')
  }
  if (isCancelled(call, signal)) return cancelled()
  const effectiveBudget = budget ?? { maxItems: 60, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS }
  if (isTabManagementTool(call.name)) {
    return dispatchTabManagementTool(call, effectiveBudget, authorize, signal, tabManagement)
  }
  // Privacy boundary: with sharing off, no page content may leave the page.
  // PAGE_READS is the shared list of tools that return page content, so a new
  // read tool added there is gated here without a second hand-maintained list.
  if (!tabManagement.unrestrictedAccess
    && sharePageContent === 'off'
    && PAGE_READS.has(call.name)) {
    return { ok: false, error: { code: 'action-failed', message: 'Page content sharing is disabled in Settings > Page content sharing.' } }
  }
  const tab = targetTab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
  if (isCancelled(call, signal)) return cancelled()
  if (tab?.id === undefined) {
    return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
  }
  if (targetStillAllowed?.() === false) return targetChanged()
  const outsideRefusal = resolveTargetTab(tab.id, tabManagement)
  if (outsideRefusal !== undefined) return outsideRefusal
  const restrictedPage = classifyRestrictedPage(tab.url)
  if (restrictedPage !== undefined && !TAB_NATIVE_TOOLS.has(call.name)) {
    return restrictedPageAnswer(restrictedPage)
  }
  const frames = await listTabFrames(tab.id, tab.url)
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  const frameError = validateFrameTarget(call, frames)
  if (frameError !== undefined) return frameError
  // Validate real-input click arguments before element-baseline checks, so a
  // malformed button/count/modifiers is always reported as bad-args.
  if (call.name === 'browser_click' && clickRequestsRealInput(call.args)) {
    const parsedClick = parseRealClickOptions(call.args)
    if ('error' in parsedClick) return parsedClick.error
  }
  if (call.name === 'browser_press') {
    const parsedPress = parsePressKeyArg(call.args)
    if ('error' in parsedPress) return parsedPress.error
  }
  if (!isInjectablePage(tab.url) && !TAB_NATIVE_TOOLS.has(call.name)) {
    return unavailable('The current page DOM is protected by the browser. DOM actions and text reads that need the content script are unavailable on this page, while snapshot metadata, navigate, back, forward, reload, screenshot, pdf, resize, viewport emulation, console and network telemetry, and JavaScript evaluation remain available.')
  }
  const targetError = validateElementTarget(call, tab.id, frames)
  if (targetError !== undefined) return targetError
  const approval = tabManagement.unrestrictedAccess
    ? undefined
    : approvalPromptForCall(call, sharePageContent, frames)
  if (approval !== undefined) {
    const authorization = authorize === undefined ? 'unavailable' : await authorize(approval)
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    if (authorization !== 'approved') {
      return approvalFailure(approval, authorization)
    }
  }
  let executionFrames = frames
  if (approval !== undefined) {
    executionFrames = await listTabFrames(tab.id, tab.url)
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    const refreshedApproval = approvalPromptForCall(call, sharePageContent, executionFrames)
    if (refreshedApproval === undefined
      || !sameApprovalBoundary(approval, refreshedApproval)
      || (approval.kind === 'action' && !sameTargetDocument(call, frames, executionFrames))) {
      return unavailable('The page changed while approval was pending. Call browser_snapshot again before retrying.')
    }
    const refreshedTargetError = validateElementTarget(call, tab.id, executionFrames)
    if (refreshedTargetError !== undefined) return refreshedTargetError
  }
  const backgroundAnswer = await dispatchBackgroundPageTool(
    { id: tab.id, url: tab.url, windowId: tab.windowId },
    call,
    effectiveBudget,
    signal,
    tabManagement.commitAction,
  )
  if (backgroundAnswer !== undefined) return backgroundAnswer
  const pointerAttempt = await dispatchRealPointerTool(
    tab.id,
    tab.url,
    executionFrames,
    call,
    effectiveBudget,
    tabManagement.unrestrictedAccess || sharePageContent === 'auto',
    signal,
    targetStillAllowed,
    tabManagement.commitAction,
  )
  if (pointerAttempt?.answer !== undefined) return pointerAttempt.answer
  const pointerDegradedNote = degradationNoteFor(call, pointerAttempt?.degradedNote)
  const keyAttempt = await dispatchRealKeyTool(
    tab.id,
    tab.url,
    executionFrames,
    call,
    effectiveBudget,
    tabManagement.unrestrictedAccess || sharePageContent === 'auto',
    signal,
    targetStillAllowed,
    tabManagement.commitAction,
  )
  if (keyAttempt?.answer !== undefined) return keyAttempt.answer
  const keyDegradedNote = keyAttempt?.degradedNote
  const finishAnswer = (answer: ToolAnswer): ToolAnswer =>
    withKeyDegradation(withPointerDegradation(answer, pointerDegradedNote), call, keyDegradedNote)
  if (!isInjectablePage(tab.url)) {
    return await dispatchTabNativeTool(tab.id, tab.url, tab.title, tab.windowId, call, effectiveBudget, signal, targetStillAllowed, tabManagement.commitAction)
      ?? unavailable('The current page DOM is protected by the browser.')
  }
  try {
    return finishAnswer(await dispatchOnce(
      tab.id,
      executionFrames,
      call,
      effectiveBudget,
      signal,
      targetStillAllowed,
      tabManagement.unrestrictedAccess || sharePageContent === 'auto',
      tabManagement.commitAction,
      tabManagement.rollbackActionCommit,
    ))
  } catch (error: unknown) {
    if (isCancelled(call, signal)) return cancelled()
    // A dispatched action that navigates the page takes its answering document
    // with it, so the send can fail as a closed port, a vanished receiver, or a
    // timeout on the response. When the document really was replaced, the action
    // succeeded: report it with the replacement page's snapshot instead of an
    // error the model would retry into a duplicate click.
    {
      const navigated = await answerNavigatedAfterDispatch(
        tab.id,
        call,
        effectiveBudget,
        targetStillAllowed,
        executionFrames,
        tab.url,
        tabManagement.unrestrictedAccess || sharePageContent === 'auto',
      )
      if (navigated !== undefined) return finishAnswer(navigated)
    }
    if (!contentScriptReceiverMissing(error)) {
      return unavailable('The content script stopped responding after the operation was dispatched. Call browser_snapshot before continuing.')
    }
    // Manifest content scripts do not run retroactively in tabs that were
    // already open when an unpacked extension was installed or reloaded.
    // Recover in place so the user never has to refresh and lose page state.
    try {
      await injectContentScript(tab.id)
    } catch {
      return await dispatchTabNativeTool(tab.id, tab.url, tab.title, tab.windowId, call, effectiveBudget, signal, targetStillAllowed, tabManagement.commitAction)
        ?? unavailable('The content script could not be loaded on this page. Its DOM does not support browser operations.')
    }
    try {
      if (isCancelled(call, signal)) return cancelled()
      if (targetStillAllowed?.() === false) return targetChanged()
      const refreshedFrames = await listTabFrames(tab.id, tab.url)
      if (isCancelled(call, signal)) return cancelled()
      if (targetStillAllowed?.() === false) return targetChanged()
      const refreshedTargetError = validateElementTarget(call, tab.id, refreshedFrames)
      if (refreshedTargetError !== undefined) return refreshedTargetError
      if (approval !== undefined) {
        const refreshedApproval = approvalPromptForCall(call, sharePageContent, refreshedFrames)
        if (refreshedApproval === undefined
          || !sameApprovalBoundary(approval, refreshedApproval)
          || (approval.kind === 'action' && !sameTargetDocument(call, executionFrames, refreshedFrames))) {
          return unavailable('The page changed while the content script was loading. Call browser_snapshot again before retrying.')
        }
      }
      return finishAnswer(await dispatchOnce(
        tab.id,
        refreshedFrames,
        call,
        effectiveBudget,
        signal,
        targetStillAllowed,
        tabManagement.unrestrictedAccess || sharePageContent === 'auto',
        tabManagement.commitAction,
        tabManagement.rollbackActionCommit,
      ))
    } catch {
      return unavailable('The content script did not answer after it was loaded. Call browser_snapshot again before retrying.')
    }
  }
}


// ---- Background-native page tools (CDP with documented fallbacks) ----

const EVALUATE_DEFAULT_MAX_CHARS = 20_000
const EVALUATE_MAX_CHARS = 51_200
const CONSOLE_DEFAULT_LIMIT = 100
const NETWORK_DEFAULT_LIMIT = 100
const EVALUATE_FALLBACK_PREFIX = '(evaluated without REPL semantics: add an explicit return)\n(evaluated without the browser debugger: this path always awaits the result, so await=false has no effect)\n'

function badArgs(message: string): ToolAnswer {
  return { ok: false, error: { code: 'bad-args', message } }
}

function toolFailure(error: unknown): ToolAnswer {
  if (error instanceof DebuggerUnavailableError
    || error instanceof JsResultNotSerializableError
    || error instanceof ScreenshotTooLargeError
    || error instanceof PdfTooLargeError
    || error instanceof ScreenshotPlanError) {
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  return {
    ok: false,
    error: {
      code: 'action-failed',
      message: redactPageText(error instanceof Error ? error.message : String(error)),
    },
  }
}

function truncateOutput(text: string, maxChars: number): string {
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n[OUTPUT TRUNCATED: exceeded ${maxChars} characters]`
    : text
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.floor(value), min), max)
}

function isScreenshotFormat(value: unknown): value is 'jpeg' | 'png' {
  return value === 'jpeg' || value === 'png'
}

function parseScreenshotOptions(args: Record<string, unknown>): { options: ScreenshotOptions } | { error: string } {
  const format = args.format === undefined ? 'jpeg' : args.format
  if (!isScreenshotFormat(format)) return { error: 'format must be "jpeg" or "png".' }
  const scale = args.scale
  if (scale !== undefined && (typeof scale !== 'number' || !Number.isInteger(scale) || scale < 1 || scale > 3)) {
    return { error: 'scale must be 1, 2, or 3.' }
  }
  const quality = args.quality === undefined ? 80 : args.quality
  if (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 1 || quality > 100) {
    return { error: 'quality must be a number between 1 and 100.' }
  }
  let region: [number, number, number, number] | undefined
  if (args.region !== undefined) {
    const raw = args.region
    if (!Array.isArray(raw) || raw.length !== 4 || raw.some((part) => typeof part !== 'number' || !Number.isFinite(part))) {
      return { error: 'region must be four finite numbers [x0, y0, x1, y1].' }
    }
    // The plan checks the viewport-dependent bounds; the clip's own geometry
    // fails here so an empty rectangle never starts a capture.
    try {
      validateScreenshotClip(clipFromRegion(raw as [number, number, number, number]))
    } catch (error: unknown) {
      if (error instanceof ScreenshotPlanError) return { error: error.message }
      throw error
    }
    region = raw as [number, number, number, number]
  }
  return {
    options: {
      format,
      quality: Math.floor(quality),
      ...(region === undefined ? {} : { region }),
      ...(scale === undefined ? {} : { scale }),
    },
  }
}

/**
 * Whether a fallback failure is the page's own execution policy, not a missing
 * debugger. CSP refusals and sandboxed frames read as `debugger-unavailable`,
 * which would send the model to the wrong remedy.
 * @param detail - error text from the injected script.
 * @returns true when the page refused to run the script.
 */
function pageRefusedExecution(detail: string): boolean {
  return /content security policy|CSP|refused to execute|refused to evaluate|sandboxed|blocked script execution|permission denied|not allowed to load local resource/i.test(detail)
}

/** Fallback evaluated in the page's MAIN world when CDP cannot attach. */
async function evaluateInMainWorld(code: string): Promise<unknown> {
  const AsyncFunction = Object.getPrototypeOf(async function (): Promise<undefined> { return undefined }).constructor as new (body: string) => () => Promise<unknown>
  const run = new AsyncFunction(code)
  return await run()
}

async function evaluateWithoutDebugger(tabId: number, code: string): Promise<unknown> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'MAIN',
    func: evaluateInMainWorld,
    args: [code],
  })
  return results[0]?.result
}

async function dispatchEvaluateTool(
  tab: { id: number; url?: string },
  call: ToolCall,
  commitAction?: () => void,
): Promise<ToolAnswer> {
  const code = typeof call.args.code === 'string' ? call.args.code : undefined
  if (code === undefined || code.trim() === '') return badArgs('code must be a non-empty string.')
  const restricted = classifyRestrictedPage(tab.url)
  if (restricted !== undefined) return restrictedPageAnswer(restricted)
  const maxChars = boundedInteger(call.args.max_chars, EVALUATE_DEFAULT_MAX_CHARS, 1, EVALUATE_MAX_CHARS)
  const awaitPromise = call.args.await !== false
  commitAction?.()
  let text: string
  try {
    const outcome: EvaluateOutcome = await evaluateInPage(tab.id, code, awaitPromise)
    text = formatEvaluationResult(outcome)
  } catch (error: unknown) {
    if (!(error instanceof DebuggerUnavailableError)) return toolFailure(error)
    try {
      const value = await evaluateWithoutDebugger(tab.id, code)
      text = `${EVALUATE_FALLBACK_PREFIX}${formatEvaluationResult({ value })}`
    } catch (fallbackError: unknown) {
      const detail = redactPageText(fallbackError instanceof Error ? fallbackError.message : String(fallbackError))
      if (/object reference chain is too long|circular|could not (?:be )?serializ|not serializable/i.test(detail)) {
        return {
          ok: false,
          error: {
            code: 'js-result-not-serializable',
            message: `The page value cannot be serialized. Return a string instead, for example: return JSON.stringify(value). (${detail})`,
          },
        }
      }
      if (pageRefusedExecution(detail)) {
        return {
          ok: false,
          error: {
            code: 'action-failed',
            message: `The page's security policy refused to run JavaScript, so browser_evaluate cannot execute here (${detail}). Use the DOM tools instead: browser_snapshot, browser_get_text, browser_find, browser_click, browser_type.`,
          },
        }
      }
      return {
        ok: false,
        error: {
          code: 'debugger-unavailable',
          message: `JavaScript could not be evaluated: the browser debugger is unavailable and the page-side fallback failed (${detail}). Grant the debugger permission, or evaluate on a normal HTTP(S) page.`,
        },
      }
    }
  }
  return { ok: true, result: { text: truncateOutput(text, maxChars) } }
}

async function dispatchScreenshotTool(
  tab: { id: number; windowId?: number },
  call: ToolCall,
): Promise<ToolAnswer> {
  const parsed = parseScreenshotOptions(call.args)
  if ('error' in parsed) return badArgs(parsed.error)
  const save = call.args.save !== false
  let capture: ScreenshotCapture
  try {
    capture = await captureScreenshot(tab.id, parsed.options)
  } catch (error: unknown) {
    if (!(error instanceof DebuggerUnavailableError)) return toolFailure(error)
    try {
      capture = await captureVisibleTabScreenshot(tab.id, tab.windowId, parsed.options)
    } catch (fallbackError: unknown) {
      return toolFailure(fallbackError)
    }
  }
  const format = capture.image.mimeType === 'image/png' ? 'png' : 'jpeg'
  const notes = capture.notes ?? []
  const qualityText = capture.quality === undefined
    ? ''
    : capture.quality.reduced
      ? ` JPEG quality ${capture.quality.effective} (lowered from requested ${capture.quality.requested} by the size ladder).`
      : ` JPEG quality ${capture.quality.effective} (requested).`
  const head = `Screenshot captured (${capture.image.width}x${capture.image.height} px, ${format}).${qualityText} Viewport: ${capture.frame.viewportWidth}x${capture.frame.viewportHeight} CSS px (dpr ${capture.frame.dpr}).`
  const text = [
    head,
    ...notes,
    // The host writes the file itself; without `save` the base64 payload must
    // not cross the bridge at all, and the caller reports dimensions only.
    ...(save ? [] : ['Not saved (save=false): only the dimensions were measured, and the image bytes were not transferred.']),
  ].join('\n')
  const image = save
    ? capture.image
    : { mimeType: capture.image.mimeType, width: capture.image.width, height: capture.image.height }
  return { ok: true, result: { text, image, frame: capture.frame } }
}

async function enablePageInstrumentation(tabId: number, pageUrl: string | undefined): Promise<ToolAnswer | undefined> {
  try {
    // The isolated world must exist before the hook, because it owns the
    // channel check that keeps look-alike page events out of the telemetry
    // buffer. Entry payloads stay untrusted page content.
    try {
      await injectContentScript(tabId)
    } catch {
      // The script may already be present from an earlier injection.
    }
    const channel = instrumentChannelFor(tabId)
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'DSH_INSTRUMENT_CHANNEL', channel }, { frameId: 0 })
    } catch {
      // Fail closed: without the handshake the isolated world forwards nothing,
      // which is safe, and the hook install below still reports page limits.
    }
    await installPageInstrumentation(tabId, channel)
    seedTelemetryDomain(tabId, pageUrl)
    return undefined
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: {
        code: 'debugger-unavailable',
        message: `The browser debugger is unavailable, and the page-side hook could not be installed (${detail}). Grant the debugger permission, or use a normal HTTP(S) page.`,
      },
    }
  }
}

async function dispatchConsoleTool(
  tab: { id: number; url?: string },
  call: ToolCall,
  budget: ContentBudget,
): Promise<ToolAnswer> {
  const onlyErrors = call.args.only_errors === true
  const clear = call.args.clear === true
  const pattern = typeof call.args.pattern === 'string' && call.args.pattern !== '' ? call.args.pattern : undefined
  const limit = boundedInteger(call.args.limit, CONSOLE_DEFAULT_LIMIT, 1, 1_000)
  let fallback = false
  try {
    await startConsoleCapture(tab.id, tab.url)
  } catch (error: unknown) {
    if (!(error instanceof DebuggerUnavailableError)) return toolFailure(error)
    fallback = true
    const refused = await enablePageInstrumentation(tab.id, tab.url)
    if (refused !== undefined) return refused
  }
  const read = readConsoleMessages(tab.id, { onlyErrors, pattern, limit, clear })
  const patternNotes: string[] = []
  if (read.patternDegraded === true) {
    patternNotes.push(`The pattern is longer than ${CONSOLE_PATTERN_MAX_LENGTH} characters or too expensive to run as a regular expression, so matching degraded to a case-insensitive substring test of the first ${CONSOLE_PATTERN_MATCH_PREFIX} characters of each message.`)
  }
  if (read.patternAbandoned === true) {
    patternNotes.push(`Pattern matching stopped after ${CONSOLE_PATTERN_BUDGET_MS} ms because the pattern was too expensive for this buffer; messages after the stop point were not tested. Narrow the pattern or omit it to inspect the messages.`)
  }
  const patternNote = patternNotes.length === 0 ? '' : `\n\n(${patternNotes.join(' ')})`
  if (read.cleared) {
    // `clear` discards the buffer after this read, so the selected messages
    // still leave the page; the status states how many were returned and how
    // many the clear actually discarded.
    if (read.messages.length === 0) {
      const text = read.bufferTotal === 0
        ? 'Cleared 0 console message(s) for this tab.'
        : `Cleared 0 matching console message(s); returned 0 of 0 matching, then cleared all ${read.bufferTotal} buffered message(s) for this tab.`
      return { ok: true, result: { text: truncateOutput(`${text}${patternNote}`, budget.maxChars) } }
    }
    return {
      ok: true,
      result: {
        text: truncateOutput(
          `${formatConsoleMessages(read.messages, fallback)}${patternNote}\n\n(From ${read.bufferTotal} buffered console message(s): returned ${read.messages.length} of ${read.total} matching, then cleared all ${read.bufferTotal} buffered message(s) for this tab.)`,
          budget.maxChars,
        ),
      },
    }
  }
  return { ok: true, result: { text: truncateOutput(`${formatConsoleMessages(read.messages, fallback)}${patternNote}`, budget.maxChars) } }
}

async function dispatchNetworkTool(
  tab: { id: number; url?: string },
  call: ToolCall,
  budget: ContentBudget,
): Promise<ToolAnswer> {
  const urlPattern = typeof call.args.url_pattern === 'string' && call.args.url_pattern !== '' ? call.args.url_pattern : undefined
  const clear = call.args.clear === true
  const limit = boundedInteger(call.args.limit, NETWORK_DEFAULT_LIMIT, 1, 1_000)
  let fallback = false
  try {
    await startNetworkCapture(tab.id, tab.url)
  } catch (error: unknown) {
    if (!(error instanceof DebuggerUnavailableError)) return toolFailure(error)
    fallback = true
    const refused = await enablePageInstrumentation(tab.id, tab.url)
    if (refused !== undefined) return refused
  }
  const read = readNetworkRequests(tab.id, { urlPattern, limit, clear })
  if (read.cleared) {
    // `clear` discards the buffer after this read, so the selected requests
    // still leave the page; the status states how many were returned and how
    // many the clear actually discarded.
    if (read.requests.length === 0) {
      const text = read.bufferTotal === 0
        ? 'Cleared 0 network request(s) for this tab.'
        : `Cleared 0 matching network request(s); returned 0 of 0 matching, then cleared all ${read.bufferTotal} buffered request(s) for this tab.`
      return { ok: true, result: { text: truncateOutput(text, budget.maxChars) } }
    }
    return {
      ok: true,
      result: {
        text: truncateOutput(
          `${formatNetworkRequests(read.requests, fallback)}\n\n(From ${read.bufferTotal} buffered network request(s): returned ${read.requests.length} of ${read.total} matching, then cleared all ${read.bufferTotal} buffered request(s) for this tab.)`,
          budget.maxChars,
        ),
      },
    }
  }
  return { ok: true, result: { text: truncateOutput(formatNetworkRequests(read.requests, fallback), budget.maxChars) } }
}

async function dispatchResizeTool(tabId: number, call: ToolCall, commitAction?: () => void): Promise<ToolAnswer> {
  const width = call.args.width
  const height = call.args.height
  if (typeof width !== 'number' || !Number.isFinite(width) || width < 1 || width > 7_680
    || typeof height !== 'number' || !Number.isFinite(height) || height < 1 || height > 4_320) {
    return badArgs('width and height must be numbers within 1..7680 and 1..4320.')
  }
  const targetWidth = Math.floor(width)
  const targetHeight = Math.floor(height)
  let tab: chrome.tabs.Tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    return unavailable(`Tab ${tabId} is no longer open. Call browser_list_tabs again.`)
  }
  if (tab.windowId === undefined) {
    return { ok: false, error: { code: 'action-failed', message: `Tab ${tabId} is not attached to a browser window.` } }
  }
  commitAction?.()
  try {
    await chrome.windows.update(tab.windowId, { width: targetWidth, height: targetHeight })
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, error: { code: 'action-failed', message: `The window holding tab ${tabId} could not be resized: ${detail}` } }
  }
  return {
    ok: true,
    result: { text: `Resized the window holding tab ${tabId} to ${targetWidth}x${targetHeight}. The page layout may have changed; take a new snapshot.` },
  }
}

/** Viewport bounds, kept in step with browser_resize's window limits. */
const VIEWPORT_MAX_WIDTH = 7_680
const VIEWPORT_MAX_HEIGHT = 4_320

/**
 * Apply or clear a device-metrics override on the controlled tab.
 * @param tabId - target tab.
 * @param call - tool arguments: width/height[/device_scale_factor/mobile] or reset.
 * @param commitAction - marks the call as an approved state change.
 */
async function dispatchViewportTool(tabId: number, call: ToolCall, commitAction?: () => void): Promise<ToolAnswer> {
  if (call.args.reset === true) {
    const sizing = ['width', 'height', 'device_scale_factor', 'mobile']
      .filter((key) => call.args[key] !== undefined)
    if (sizing.length > 0) {
      return badArgs(`reset=true clears the emulated viewport; omit ${sizing.join(', ')}, or omit reset to apply a new one.`)
    }
    commitAction?.()
    let cleared: boolean
    try {
      cleared = await clearViewportOverride(tabId)
    } catch (error: unknown) {
      return toolFailure(error)
    }
    return {
      ok: true,
      result: {
        text: cleared
          ? `Cleared the emulated viewport on tab ${tabId}. It lays out at its real size again; take a new snapshot when the layout matters.`
          : `No emulated viewport was active on tab ${tabId}, so nothing changed.`,
      },
    }
  }
  const width = call.args.width
  const height = call.args.height
  const scale = call.args.device_scale_factor
  if (typeof width !== 'number' || !Number.isFinite(width) || width < 1 || width > VIEWPORT_MAX_WIDTH) {
    return badArgs(`width must be a number within 1..${VIEWPORT_MAX_WIDTH}.`)
  }
  if (typeof height !== 'number' || !Number.isFinite(height) || height < 1 || height > VIEWPORT_MAX_HEIGHT) {
    return badArgs(`height must be a number within 1..${VIEWPORT_MAX_HEIGHT}.`)
  }
  if (scale !== undefined && (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 1 || scale > 4)) {
    return badArgs('device_scale_factor must be a number within 1..4 when given.')
  }
  const mobile = call.args.mobile === true
  const override = {
    width: Math.floor(width),
    height: Math.floor(height),
    mobile,
    ...(typeof scale === 'number' ? { deviceScaleFactor: scale } : {}),
  }
  commitAction?.()
  try {
    await applyViewportOverride(tabId, override)
  } catch (error: unknown) {
    return toolFailure(error)
  }
  const scaleText = override.deviceScaleFactor === undefined ? '' : `, device scale ${override.deviceScaleFactor}`
  return {
    ok: true,
    result: {
      text: `Emulated a ${override.width}x${override.height} ${mobile ? 'mobile' : 'desktop'} viewport${scaleText} on tab ${tabId}. `
        + 'The override belongs to the debugger session: it ends when the debugger detaches after 60 s idle, and reset=true drops it now. '
        + 'Take a new snapshot because the layout changed.',
    },
  }
}

/** Print options accepted from the model, with defaults that match the screen. */
function parsePrintOptions(args: Record<string, unknown>): PrintToPdfOptions {
  return {
    printBackground: args.print_background !== false,
    landscape: args.landscape === true,
    preferCSSPageSize: args.prefer_css_page_size !== false,
  }
}

/**
 * Print the controlled tab to a PDF and hand the bytes to the host.
 * @param tabId - target tab.
 * @param call - tool arguments with the optional print options.
 */
async function dispatchPdfTool(tabId: number, call: ToolCall): Promise<ToolAnswer> {
  const options = parsePrintOptions(call.args)
  let base64: string
  try {
    base64 = await printToPdf(tabId, options)
  } catch (error: unknown) {
    return toolFailure(error)
  }
  const bytes = Math.floor(base64.length * 3 / 4)
  return {
    ok: true,
    result: {
      text: `Printed tab ${tabId} to PDF (${Math.round(bytes / 1024)} KiB${options.landscape ? ', landscape' : ''}${options.printBackground ? '' : ', no CSS backgrounds'}). The host writes the file and returns its path; the bytes never enter the conversation.`,
      pdf: { base64 },
    },
  }
}

/**
 * Dispatch a tool the background worker executes itself.
 *
 * The caller has already resolved this tab through tab affinity and
 * tab-isolation, so a debugger attachment made below only ever covers a tab
 * this session owns. Everything here must degrade rather than throw when the
 * browser refuses the debugger.
 */
async function dispatchBackgroundPageTool(
  tab: { id: number; url?: string; windowId?: number },
  call: ToolCall,
  budget: ContentBudget,
  signal: AbortSignal | undefined,
  commitAction?: () => void,
): Promise<ToolAnswer | undefined> {
  if (!BACKGROUND_PAGE_TOOLS.has(call.name)) return undefined
  if (isCancelled(call, signal)) return cancelled()
  try {
    switch (call.name) {
      case 'browser_evaluate': return await dispatchEvaluateTool(tab, call, commitAction)
      case 'browser_screenshot': return await dispatchScreenshotTool(tab, call)
      case 'browser_console': return await dispatchConsoleTool(tab, call, budget)
      case 'browser_network': return await dispatchNetworkTool(tab, call, budget)
      case 'browser_resize': return await dispatchResizeTool(tab.id, call, commitAction)
      case 'browser_viewport': return await dispatchViewportTool(tab.id, call, commitAction)
      case 'browser_pdf': return await dispatchPdfTool(tab.id, call)
      default: return undefined
    }
  } catch (error: unknown) {
    if (isCancelled(call, signal)) return cancelled()
    return toolFailure(error)
  }
}

function validateFrameTarget(call: ToolCall, frames: TabFrame[]): ToolAnswer | undefined {
  if (call.name === 'browser_snapshot') return undefined
  const frameId = requestedFrame(call.args)
  if (frameId < 0) return { ok: false, error: { code: 'action-failed', message: 'frame must be a non-negative integer.' } }
  if (!frames.some((frame) => frame.frameId === frameId)) {
    return unavailable(`Frame ${frameId} does not exist or has navigated. Call browser_snapshot again.`)
  }
  return undefined
}

function validateElementTarget(call: ToolCall, tabId: number, frames: TabFrame[]): ToolAnswer | undefined {
  if (!ELEMENT_TARGET_TOOLS.has(call.name)) return undefined
  // Coordinate-addressed calls (hover x/y, drag x/y) do not read a snapshot
  // element, so they have no baseline to check.
  const elementAddressed = call.name === 'browser_drag'
    ? typeof call.args.from_index === 'number' && typeof call.args.to_index === 'number'
    : typeof call.args.index === 'number'
  if (!elementAddressed) return undefined
  const frameId = requestedFrame(call.args)
  const frame = frames.find((candidate) => candidate.frameId === frameId)
  const snapshotted = snapshotDocumentsByTab.get(tabId)?.get(frameId)
  if (frame === undefined || snapshotted === undefined) {
    return unavailable('The element reference does not belong to the current document. Call browser_snapshot again for current frame and index values.')
  }
  if (snapshotted !== frameDocumentKey(frame)) {
    // A frame record without a document id falls back to its URL as identity,
    // so an SPA history change looks like a document replacement. Defer to the
    // content script, which re-resolves the ref through its recorded selector
    // when it still holds the document, and reports the ref as gone when a real
    // navigation replaced the registry. A frame with a document id is a proven
    // replacement, so that still fails closed here.
    if (frame.documentId !== undefined) {
      return unavailable('The element reference does not belong to the current document. Call browser_snapshot again for current frame and index values.')
    }
  }
  return undefined
}

function sameApprovalBoundary(before: ApprovalPrompt, after: ApprovalPrompt): boolean {
  return before.kind === after.kind
    && before.action === after.action
    && before.origins.length === after.origins.length
    && before.origins.every((origin, index) => origin === after.origins[index])
}

function sameTargetDocument(call: ToolCall, before: TabFrame[], after: TabFrame[]): boolean {
  const frameId = requestedFrame(call.args)
  const beforeFrame = before.find((frame) => frame.frameId === frameId)
  const afterFrame = after.find((frame) => frame.frameId === frameId)
  return beforeFrame !== undefined
    && afterFrame !== undefined
    && frameDocumentKey(beforeFrame) === frameDocumentKey(afterFrame)
}

/** Parse a model-supplied http(s) URL for tab creation / navigation. */
export function parseHttpUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined
  } catch {
    return undefined
  }
}

async function removeCreatedTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId)
  } catch {
    // The tab may already have been closed by the user or another tool.
  }
}

/**
 * Open a URL in a new tab, then optionally snapshot it once the document is ready.
 * Affinity rebinding is owned by the caller via `bindCreatedTab`.
 *
 * Creates a blank tab first, arms the readiness listener, then navigates so a
 * fast `document_idle` cannot announce readiness before the listener exists.
 * Cancellation before affinity bind rolls the orphan tab back; after bind the
 * open is treated as committed and reported as success even if the call expires.
 */
export async function dispatchOpenTab(
  call: ToolCall,
  windowId: number,
  sharePageContent: 'ask' | 'auto' | 'off',
  budget: ContentBudget | undefined,
  authorize: ((prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>) | undefined,
  signal: AbortSignal | undefined,
  bindCreatedTab: (tab: chrome.tabs.Tab) => boolean,
  targetStillAllowed: (tabId: number) => boolean,
  commitAction?: () => void,
): Promise<ToolAnswer> {
  if (isCancelled(call, signal)) return cancelled()
  const parsed = parseHttpUrl(call.args.url)
  if (parsed === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'url must be a complete http or https URL.' } }
  }
  const active = call.args.active !== false

  const approval = approvalPromptForCall(call, sharePageContent, [])
  let pageContentReadable = sharePageContent === 'auto'
  if (approval !== undefined) {
    const authorization = authorize === undefined ? 'unavailable' : await authorize(approval)
    if (isCancelled(call, signal)) return cancelled()
    if (authorization !== 'approved') return approvalFailure(approval, authorization)
    // On-demand sharing reads the page only for this approved action.
    pageContentReadable = true
  }

  let created: chrome.tabs.Tab
  try {
    // No URL yet: register the readiness wait before the http(s) navigation.
    created = await chrome.tabs.create({ active, windowId })
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: error instanceof Error ? error.message : 'Failed to open a new browser tab.',
      },
    }
  }
  if (created.id === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'Chrome created a tab without an id.' } }
  }
  const tabId = created.id
  if (isCancelled(call, signal)) {
    await removeCreatedTab(tabId)
    return cancelled()
  }

  const navigationWait = waitForNextDocumentReady(tabId, 0, undefined, signal)
  try {
    created = await chrome.tabs.update(tabId, { url: parsed.href })
  } catch (error: unknown) {
    navigationWait.cancel()
    await removeCreatedTab(tabId)
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: error instanceof Error ? error.message : 'Failed to navigate the new browser tab.',
      },
    }
  }

  const ready = await navigationWait.ready
  if (isCancelled(call, signal)) {
    await removeCreatedTab(tabId)
    return cancelled()
  }
  commitAction?.()
  if (!bindCreatedTab(created.id === undefined ? { ...created, id: tabId } : created)) {
    await removeCreatedTab(tabId)
    return {
      ok: false,
      error: { code: 'action-failed', message: 'The new tab could not become the controlled browser target.' },
    }
  }

  recordCreatedTab(tabId)
  // Affinity is committed: further cancellation must not claim the tab was never opened.
  resetTabSnapshot(tabId)
  if (!targetStillAllowed(tabId)) return targetChanged()

  const status = active
    ? `Opened a new tab at ${parsed.href}.`
    : `Opened a new background tab at ${parsed.href}.`
  if (!ready || !pageContentReadable || isCancelled(call, signal)) {
    return {
      ok: true,
      result: {
        text: pageContentReadable
          ? `${status} Call browser_snapshot again after the page loads.`
          : `${status} Page content sharing is disabled, so no snapshot was captured.`,
      },
    }
  }

  try {
    const snapshot = await snapshotAfterNavigation(
      tabId,
      call,
      status,
      budget ?? { maxItems: 60, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS },
      () => targetStillAllowed(tabId),
    )
    if (snapshot !== undefined) return snapshot
  } catch {
    // Keep the successful open when the replacement page is not yet readable.
  }
  return {
    ok: true,
    result: { text: `${status} Call browser_snapshot again after the page loads.` },
  }
}

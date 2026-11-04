/**
 * Content script entry: listens for DSH_ACTION messages from the background
 * service worker, runs the action against the real page, and answers with a
 * text-only result. Starts the DOM watcher that marks the snapshot dirty, and
 * the panel-gated watcher that reports what the user highlights.
 *
 * The content script is the only part that touches the page; the bridge and
 * the model never see page internals beyond the structured text snapshots.
 *
 * @module
 */

import { DEFAULT_SNAPSHOT_MAX_CHARS } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { runAction, ActionError } from './actions.ts'
import { ElementIds } from './ids.ts'
import { PhantomCursorIndicator, type IndicatorState } from './indicator.ts'
import { SelectionWatcher } from './selection.ts'
import { instrumentMessageFromEvent } from './instrument.ts'
import type { SnapshotBudget } from './snapshot.ts'

/** Negotiated snapshot budgets, patched in from the background via message. */
let budget: SnapshotBudget = { maxItems: 60, maxForms: 30, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS }

const ids = new ElementIds()

/** Working dot; mounted only while the background sends a live state. */
const indicator = new PhantomCursorIndicator()

/** Actions that address one inventoried element the dot should point at. */
const AIMED_INDEX_ACTIONS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_select',
  'browser_hover',
  'browser_upload_file',
  // The background resolves element geometry through this internal action
  // before it dispatches real input, so the dot must follow the same target.
  'browser_pointer_rect',
])

/** Resolve the viewport point an action operates, when it names one. */
function actionPoint(action: string, args: Record<string, unknown>): { x: number; y: number } | undefined {
  if (AIMED_INDEX_ACTIONS.has(action) && typeof args.index === 'number') {
    const element = document.querySelector(`[data-dsh-el="${args.index}"]`)
    if (element !== null) {
      const rect = element.getBoundingClientRect()
      if (rect.width !== 0 || rect.height !== 0) {
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      }
    }
    return undefined
  }
  const point = (value: unknown): { x: number; y: number } | undefined => {
    if (!Array.isArray(value) || value.length !== 2) return undefined
    const [x, y] = value as unknown[]
    return typeof x === 'number' && typeof y === 'number' ? { x, y } : undefined
  }
  if (typeof args.x === 'number' && typeof args.y === 'number') return { x: args.x, y: args.y }
  if (Array.isArray(args.from)) return point(args.from)
  if (Array.isArray(args.to)) return point(args.to)
  return undefined
}

function isIndicatorState(value: unknown): value is IndicatorState {
  return value === 'static' || value === 'pulsing' || value === 'off'
}

function indicatorTarget(value: unknown): { x: number; y: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { x, y } = value as { x?: unknown; y?: unknown }
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
    ? { x, y }
    : undefined
}

const selectionWatcher = new SelectionWatcher((selection) => {
  void chrome.runtime.sendMessage({ type: 'DSH_SELECTION', selection }).catch(() => {})
})

const CONTENT_SCRIPT_LISTENER = '__dshBrowserContentScriptListener__'
const CONTENT_SELECTION_WATCHER = '__dshBrowserSelectionWatcher__'
const CONTENT_INSTRUMENT_FORWARDER = '__dshBrowserInstrumentForwarder__'
type ContentListener = typeof onMessage

/** Per-document hook forwarding state kept across content-script re-injection. */
interface InstrumentForwarder {
  channel?: string
  listener?: (event: Event) => void
}

/** A tool-call result for the bridge. */
export interface ToolResult {
  ok: boolean
  result?: { text: string; pageContent?: string; navigationPending?: boolean }
  error?: { code: string; message: string }
}

function onMessage(message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response: ToolResult) => void): true | undefined {
  if (typeof message !== 'object' || message === null) return
  const msg = message as { type?: string }
  if (msg.type === 'DSH_BUDGET') {
    const incoming = (message as { budget?: Partial<SnapshotBudget> }).budget
    if (incoming !== undefined) {
      budget = { ...budget, ...incoming }
      sendResponse({ ok: true, result: { text: `快照预算已更新: ${JSON.stringify(budget)}` } })
    }
    return
  }
  if (msg.type === 'DSH_SELECTION_WATCH') {
    const command = message as { enabled?: unknown; epoch?: unknown; revision?: unknown }
    const epoch = typeof command.epoch === 'string' ? command.epoch : undefined
    const revision = typeof command.revision === 'number' ? command.revision : undefined
    selectionWatcher.setEnabled(command.enabled === true, revision, epoch)
    sendResponse({ ok: true })
    return
  }
  if (msg.type === 'DSH_SELECTION_RESET') {
    // The panel dropped this frame's quote; let the same passage be re-reported.
    selectionWatcher.resetDedupe()
    sendResponse({ ok: true })
    return
  }
  if (msg.type === 'DSH_INSTRUMENT_CHANNEL') {
    // The background sends this immediately before injecting the MAIN-world
    // hook. The channel never travels inside an envelope, so a page that hangs
    // a `message` listener cannot recover it from captured data.
    const channel = (message as { channel?: unknown }).channel
    if (typeof channel !== 'string' || channel === '') return
    try {
      setInstrumentChannel(channel)
      sendResponse({ ok: true })
    } catch {
      // A frozen window cannot register the listener; the hook stays silent.
    }
    return
  }
  if (msg.type === 'DSH_INDICATOR') {
    const command = message as { state?: unknown; target?: unknown }
    const state = command.state
    if (!isIndicatorState(state)) return
    if (state === 'off') {
      indicator.setState('off')
    } else {
      const target = indicatorTarget(command.target)
      if (target !== undefined) indicator.moveTo(target)
      indicator.setState(state)
    }
    sendResponse({ ok: true })
    return
  }
  if (msg.type !== 'DSH_ACTION') return
  const actionMsg = message as {
    action?: string
    args?: Record<string, unknown>
    budget?: Partial<SnapshotBudget>
    includePageDelta?: boolean
  }
  const action = actionMsg.action ?? ''
  const args = actionMsg.args ?? {}
  // Aim the visible dot at the element a click/typing action addresses, so the
  // pointer path ends where the action lands instead of at the last position.
  if (indicator.state !== 'off') {
    const point = actionPoint(action, args)
    if (point !== undefined) indicator.moveTo(point)
  }
  const actionBudget = actionMsg.budget === undefined ? budget : { ...budget, ...actionMsg.budget }
  void runAction(action, args, {
    ids,
    budget: actionBudget,
    includePageDelta: actionMsg.includePageDelta === true,
  }).then(
    (result) => { sendResponse({ ok: true, result }) },
    (error: unknown) => {
      const code = error instanceof ActionError ? error.code : 'action-failed'
      const messageText = error instanceof Error ? error.message : String(error)
      sendResponse({ ok: false, error: { code, message: messageText } })
    },
  )
  return true // async response
}

// executeScript is used to recover tabs opened before extension install/reload.
// Replace any stale listener left in the isolated world so a reload always
// installs a listener belonging to the current extension context.
const contentGlobal = globalThis as typeof globalThis & {
  [CONTENT_SCRIPT_LISTENER]?: ContentListener
  [CONTENT_SELECTION_WATCHER]?: { dispose: () => void }
  [CONTENT_INSTRUMENT_FORWARDER]?: InstrumentForwarder
}

/** The forwarder state owned by this isolated world, created once per document. */
function instrumentForwarder(): InstrumentForwarder {
  const existing = contentGlobal[CONTENT_INSTRUMENT_FORWARDER]
  if (existing !== undefined) return existing
  const state: InstrumentForwarder = {}
  contentGlobal[CONTENT_INSTRUMENT_FORWARDER] = state
  return state
}

/**
 * Listen for the MAIN-world hook on one channel and forward only its entries.
 *
 * The channel is the event type, so ordinary `message` events, envelopes
 * without a channel, and other custom event types never reach the background.
 * Replacing the channel releases the previous listener.
 * @param channel - one-time random channel name installed by the background.
 */
function setInstrumentChannel(channel: string): void {
  const state = instrumentForwarder()
  if (state.channel === channel && state.listener !== undefined) return
  if (state.channel !== undefined && state.listener !== undefined) {
    window.removeEventListener(state.channel, state.listener)
  }
  const listener = (event: Event): void => {
    const envelope = instrumentMessageFromEvent(event, channel)
    if (envelope === undefined) return
    try {
      void chrome.runtime.sendMessage({ type: 'DSH_INSTRUMENT_EVENT', entry: envelope.entry }).catch(() => {})
    } catch {
      // A torn-down extension context must not break the page.
    }
  }
  state.channel = channel
  state.listener = listener
  window.addEventListener(channel, listener)
}

const previousListener = contentGlobal[CONTENT_SCRIPT_LISTENER]
if (previousListener !== undefined) {
  try { chrome.runtime.onMessage.removeListener(previousListener) } catch { /* stale extension context */ }
}
// A replaced content script keeps its page listeners until this instance
// releases them: `selectionchange` is a document listener, not an extension one.
contentGlobal[CONTENT_SELECTION_WATCHER]?.dispose()
contentGlobal[CONTENT_SCRIPT_LISTENER] = onMessage
contentGlobal[CONTENT_SELECTION_WATCHER] = selectionWatcher
// A re-injected script reuses the forwarder and its installed channel;
// installing the same channel again is a no-op.
chrome.runtime.onMessage.addListener(onMessage)

// A navigation action answers before unloading. The replacement content
// script announces when the new document can accept its automatic snapshot,
// and learns from the reply whether a side panel wants selection reports.
void chrome.runtime.sendMessage({ type: 'DSH_CONTENT_READY' }).then((response: unknown) => {
  if (typeof response !== 'object' || response === null) return
  const ready = response as {
    selectionWatch?: unknown
    selectionWatchEpoch?: unknown
    selectionWatchRevision?: unknown
  }
  const epoch = typeof ready.selectionWatchEpoch === 'string' ? ready.selectionWatchEpoch : undefined
  const revision = typeof ready.selectionWatchRevision === 'number' ? ready.selectionWatchRevision : undefined
  selectionWatcher.setEnabled(ready.selectionWatch === true, revision, epoch)
}).catch(() => {})

/**
 * Lazy Chrome DevTools Protocol access for tab-native browser tools.
 *
 * The debugger is attached only when a tool first needs a privilege the
 * content script cannot provide (MAIN-world evaluation, surface screenshots,
 * console and network telemetry). Every entry point gates on a capability
 * probe first: Firefox and restricted Chrome builds have no
 * `chrome.debugger`, and a tab already owned by DevTools refuses attachment.
 * Both map to `debugger-unavailable`, which the tool layer turns into the
 * documented page-side fallback instead of a crash.
 *
 * State lives in this module so it survives between tool calls: one attached
 * session per tab with the set of enabled protocol domains, plus bounded
 * console and network buffers that clear when the tab's page moves to another
 * domain.
 *
 * @module
 */

import type { ToolErrorCode } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { installInstrument, type InstrumentEntry } from '../content/instrument.ts'

/** Protocol version Chrome's `debugger.attach` requires. */
export const DEBUGGER_PROTOCOL_VERSION = '1.3'

/** Console messages retained per tab. */
export const MAX_LOGS_PER_TAB = 10_000

/**
 * Console identities remembered per tab so a replayed history is not stored twice.
 *
 * Enabling `Log` or `Runtime` replays the tab's past console entries after a
 * reattach. Keeping a bounded identity set makes that replay idempotent
 * without growing with the buffer or the page's lifetime.
 */
export const MAX_CONSOLE_DEDUPE_KEYS = MAX_LOGS_PER_TAB

/** Network requests retained per tab. */
export const MAX_REQUESTS_PER_TAB = 1_000

/** Longest text kept for one console message before it is cut. */
export const MAX_CONSOLE_TEXT = 16_384

/** Largest base64 screenshot accepted on the wire before the quality ladder. */
export const MAX_SCREENSHOT_BASE64 = 4 * 1024 * 1024

/** Ordered domains the tool layer may enable. */
type ProtocolDomain = 'Runtime' | 'Page' | 'Network' | 'Log'

/** A `debugger-unavailable` failure carrying its bridge code. */
export class DebuggerUnavailableError extends Error {
  readonly code: ToolErrorCode = 'debugger-unavailable'

  constructor(message: string) {
    super(message)
    this.name = 'DebuggerUnavailableError'
  }
}

/** A page value that cannot cross `returnByValue` serialization. */
export class JsResultNotSerializableError extends Error {
  readonly code: ToolErrorCode = 'js-result-not-serializable'

  constructor(message: string) {
    super(message)
    this.name = 'JsResultNotSerializableError'
  }
}

/** A screenshot that stays above the wire budget after the quality ladder. */
export class ScreenshotTooLargeError extends Error {
  readonly code: ToolErrorCode = 'action-failed'

  constructor(message: string) {
    super(message)
    this.name = 'ScreenshotTooLargeError'
  }
}

/** The browser input pipeline cannot dispatch native drag events for a tab. */
export class NativeDragUnavailableError extends Error {
  readonly code: ToolErrorCode = 'action-failed'

  constructor(message: string) {
    super(message)
    this.name = 'NativeDragUnavailableError'
  }
}

/** The subset of `chrome.debugger` this module calls. */
interface DebuggerApi {
  attach(target: { tabId: number }, requiredVersion: string): Promise<void>
  detach(target: { tabId: number }): Promise<void>
  sendCommand(target: { tabId: number }, method: string, params?: object): Promise<object>
  onDetach: chrome.events.Event<(source: { tabId?: number }, reason: string) => void>
  onEvent: chrome.events.Event<(source: { tabId?: number }, method: string, params?: object) => void>
}

interface TabSession {
  tabId: number
  enabled: Set<ProtocolDomain>
}

const sessions = new Map<number, TabSession>()
const pendingAttachments = new Map<number, Promise<TabSession>>()
const idleDetachTimers = new Map<number, ReturnType<typeof setTimeout>>()
/**
 * Per-tab generation that a detach request increments.
 *
 * An attach that started under an older generation must not install its
 * session after the tab was detached: the tab may have closed, left this
 * session, or been replaced, and re-attaching it would leak a debugger
 * session for a target no tool may touch any more.
 */
const attachGenerations = new Map<number, number>()
/** Tabs where the user dismissed the debugging infobar for this worker lifetime. */
const userDeclinedTabs = new Set<number>()
let listenersInstalled = false

/** Detach a tab that has not needed the debugger for this long. */
export const IDLE_DETACH_MS = 60_000

/** Read the debugger API without assuming every browser build ships it. */
function debuggerApi(): DebuggerApi | undefined {
  const chromeValue = Reflect.get(globalThis, 'chrome')
  if (typeof chromeValue !== 'object' || chromeValue === null) return undefined
  const candidate = Reflect.get(chromeValue, 'debugger')
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const api = candidate as DebuggerApi
  return typeof api.attach === 'function' && typeof api.sendCommand === 'function' ? api : undefined
}

/**
 * Whether this browser build exposes `chrome.debugger`.
 * @returns true when CDP tools can attempt attachment.
 */
export function isDebuggerAvailable(): boolean {
  return debuggerApi() !== undefined
}

function installDebuggerListeners(api: DebuggerApi): void {
  if (listenersInstalled) return
  listenersInstalled = true
  api.onDetach.addListener((source, reason) => {
    try {
      if (source.tabId === undefined) return
      const tabId = source.tabId
      // A detach this module requested deletes the session (and any pending
      // attachment) before calling `chrome.debugger.detach`, so empty slots
      // identify our own detach. Chrome reports that as `canceled_by_user`
      // too, and treating it as a dismissal would refuse later attachments on
      // a healthy tab.
      const selfInitiated = !sessions.has(tabId) && !pendingAttachments.has(tabId)
      sessions.delete(tabId)
      pendingAttachments.delete(tabId)
      clearIdleDetach(tabId)
      if (!selfInitiated && reason === 'canceled_by_user') {
        // The user clicked the infobar's cancel button. Stop offering to
        // attach for this document and let the next call use the page-side
        // fallback instead of failing or throwing. Telemetry buffers survive:
        // they clear only on a domain change, tab close, or session end.
        userDeclinedTabs.add(tabId)
      }
    } catch {
      // A detach notification must never surface as an uncaught error.
    }
  })
  api.onEvent.addListener((source, method, params) => {
    try {
      if (source.tabId === undefined || params === undefined) return
      handleDebuggerEvent(source.tabId, method, params as Record<string, unknown>)
    } catch {
      // Malformed protocol events are dropped, not thrown into the worker.
    }
  })
}

function attachFailure(error: unknown): DebuggerUnavailableError {
  const detail = error instanceof Error ? error.message : String(error)
  if (/already attached|another debugger/i.test(detail)) {
    return new DebuggerUnavailableError(
      `The browser debugger is already attached to this tab, usually because DevTools is open on it. Close DevTools and retry, or use a workspace where another extension is not debugging this tab. (${detail})`,
    )
  }
  if (/not supported|permission|denied|not allowed|cannot attach/i.test(detail)) {
    return new DebuggerUnavailableError(
      `The browser refused to attach the debugger to this tab. Grant the extension its debugger permission, or use a tool with a page-side fallback. (${detail})`,
    )
  }
  return new DebuggerUnavailableError(
    `The browser debugger could not attach to this tab. Retry after the page finishes loading. (${detail})`,
  )
}

/**
 * Attach the debugger to one tab, coalescing concurrent attempts.
 *
 * The tab must be attached at most once per worker lifetime: a second
 * `attach` while DevTools or another extension owns the target is refused and
 * reported as `debugger-unavailable`.
 * @param tabId - the tab to instrument.
 */
export async function ensureAttached(tabId: number): Promise<void> {
  if (sessions.has(tabId)) {
    scheduleIdleDetach(tabId)
    return
  }
  if (userDeclinedTabs.has(tabId)) {
    throw new DebuggerUnavailableError(
      'The debugging permission notice for this tab was dismissed, so the debugger cannot attach here. Reload the page or the extension, or use the page-side fallback.',
    )
  }
  const api = debuggerApi()
  if (api === undefined) {
    throw new DebuggerUnavailableError(
      'The browser debugger is unavailable in this browser build (Firefox and some Chrome builds have no chrome.debugger API). Use the page-side fallback or a browser that supports the debugger permission.',
    )
  }
  installDebuggerListeners(api)
  const generation = attachGenerations.get(tabId) ?? 0
  let pending = pendingAttachments.get(tabId)
  if (pending === undefined) {
    pending = api.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION)
      .then((): TabSession => ({ tabId, enabled: new Set<ProtocolDomain>() }))
    pendingAttachments.set(tabId, pending)
  }
  let session: TabSession
  try {
    session = await pending
  } catch (error: unknown) {
    throw attachFailure(error)
  } finally {
    if (pendingAttachments.get(tabId) === pending) pendingAttachments.delete(tabId)
  }
  if ((attachGenerations.get(tabId) ?? 0) !== generation) {
    // A detach request landed while attach was in flight. Release the target
    // instead of resurrecting a session the caller already gave up on.
    try {
      await api.detach({ tabId })
    } catch {
      // The target may already be gone; discarding the session is what matters.
    }
    throw new DebuggerUnavailableError(
      'The debugger attachment was cancelled because the tab stopped belonging to this session. Retry on the current tab.',
    )
  }
  sessions.set(tabId, session)
  scheduleIdleDetach(tabId)
}

/**
 * Invalidate any attach still in flight for a tab.
 * @param tabId - tab whose pending attach must not install a session.
 * @returns the new generation for that tab.
 */
function bumpAttachGeneration(tabId: number): number {
  const next = (attachGenerations.get(tabId) ?? 0) + 1
  attachGenerations.set(tabId, next)
  return next
}

function clearIdleDetach(tabId: number): void {
  const timer = idleDetachTimers.get(tabId)
  if (timer !== undefined) {
    clearTimeout(timer)
    idleDetachTimers.delete(tabId)
  }
}

function scheduleIdleDetach(tabId: number): void {
  clearIdleDetach(tabId)
  idleDetachTimers.set(tabId, setTimeout(() => {
    idleDetachTimers.delete(tabId)
    void detachTab(tabId)
  }, IDLE_DETACH_MS))
}

/**
 * Detach one tab and forget its protocol session, keeping its buffers.
 *
 * Console and network telemetry outlive the attachment so a later reattach
 * still reports what the page logged before the detach.
 * @param tabId - tab to detach.
 */
export async function detachTab(tabId: number): Promise<void> {
  bumpAttachGeneration(tabId)
  sessions.delete(tabId)
  pendingAttachments.delete(tabId)
  clearIdleDetach(tabId)
  const api = debuggerApi()
  if (api === undefined) return
  try {
    await api.detach({ tabId })
  } catch {
    // The target may already be gone; the state above is what matters.
  }
}

/** Forget every buffer and session for a tab that closed or ended its session. */
export function forgetTab(tabId: number): void {
  consoleBuffers.delete(tabId)
  networkBuffers.delete(tabId)
  userDeclinedTabs.delete(tabId)
  forgetInstrumentChannel(tabId)
  void detachTab(tabId)
}

/**
 * Detach a tab whose last ownership claim was released while it stays open.
 *
 * The page, not the claim, owns its console and network history, so the
 * buffers stay readable if the tab is claimed again.
 * @param tabId - released tab.
 */
export function releaseTab(tabId: number): void {
  void detachTab(tabId)
}

async function send(tabId: number, method: string, params?: object): Promise<Record<string, unknown>> {
  const api = debuggerApi()
  if (api === undefined) {
    throw new DebuggerUnavailableError('The browser debugger is unavailable in this browser build.')
  }
  if (!sessions.has(tabId)) await ensureAttached(tabId)
  try {
    const result = (await api.sendCommand({ tabId }, method, params ?? {})) as Record<string, unknown>
    scheduleIdleDetach(tabId)
    return result
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    if (/not attached|detached|target closed|no target/i.test(detail)) {
      sessions.delete(tabId)
      throw new DebuggerUnavailableError(`The debugger session for this tab ended: ${detail}`)
    }
    throw error
  }
}

async function ensureDomain(tabId: number, domain: ProtocolDomain): Promise<void> {
  const session = sessions.get(tabId)
  if (session?.enabled.has(domain) === true) return
  await send(tabId, `${domain}.enable`, {})
  sessions.get(tabId)?.enabled.add(domain)
}

// ---- Real input through the Input domain ----

/** Mouse buttons the Input domain accepts. */
export type CdpMouseButton = 'left' | 'right' | 'middle'

/** Modifier keys, mapped to the protocol's bit mask. */
const MODIFIER_BITS: Record<string, number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 }

/** Bit mask for a pressed mouse button, as the protocol reports it in `buttons`. */
const BUTTON_BITS: Record<CdpMouseButton, number> = { left: 1, right: 2, middle: 4 }

/** Interpolated pointer moves between a drag's start and end. */
export const CDP_DRAG_STEPS = 5

/** Longest pause between drag segments, so page handlers can run between moves. */
const DRAG_STEP_DELAY_MS = 8

/**
 * Parse a `ctrl+shift` style modifier list into the protocol bit mask.
 * @param spec - comma/plus separated modifier names.
 * @returns the bit mask, or undefined when a name is unknown.
 */
export function modifierMask(spec: string | undefined): number | undefined {
  if (spec === undefined) return 0
  const names = spec.split(/[+,]/).map((name) => name.trim().toLowerCase()).filter((name) => name !== '')
  let mask = 0
  for (const name of names) {
    if (name === 'cmd' || name === 'command' || name === 'win') {
      mask |= MODIFIER_BITS.meta!
      continue
    }
    const bit = MODIFIER_BITS[name]
    if (bit === undefined) return undefined
    mask |= bit
  }
  return mask
}

interface InputPointerEvent {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased'
  x: number
  y: number
  button?: CdpMouseButton | 'none'
  buttons?: number
  clickCount?: number
  modifiers?: number
}

/**
 * Dispatch one real mouse event through the browser input pipeline.
 *
 * Coordinates are viewport CSS pixels of the tab's main frame.
 * @param tabId - target tab.
 * @param event - protocol event fields.
 */
async function dispatchMouseEvent(tabId: number, event: InputPointerEvent): Promise<void> {
  await send(tabId, 'Input.dispatchMouseEvent', event as unknown as Record<string, unknown>)
}

/**
 * Move the real pointer to a viewport point.
 * @param tabId - target tab.
 * @param point - viewport CSS pixels in the main frame.
 * @param modifiers - protocol modifier bit mask.
 */
export async function movePointer(tabId: number, point: { x: number; y: number }, modifiers = 0): Promise<void> {
  await ensureAttached(tabId)
  await dispatchMouseEvent(tabId, {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none',
    buttons: 0,
    modifiers,
  })
}

/**
 * Click a viewport point with real mouse press/release events.
 * @param tabId - target tab.
 * @param point - viewport CSS pixels in the main frame.
 * @param options - button, click count, and modifier mask.
 */
export async function clickPointer(
  tabId: number,
  point: { x: number; y: number },
  options: { button: CdpMouseButton; count: number; modifiers: number },
): Promise<void> {
  await ensureAttached(tabId)
  await dispatchMouseEvent(tabId, {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none',
    buttons: 0,
    modifiers: options.modifiers,
  })
  const buttons = BUTTON_BITS[options.button]
  for (let clickCount = 1; clickCount <= options.count; clickCount += 1) {
    await dispatchMouseEvent(tabId, {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: options.button,
      buttons,
      clickCount,
      modifiers: options.modifiers,
    })
    await dispatchMouseEvent(tabId, {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: options.button,
      buttons: 0,
      clickCount,
      modifiers: options.modifiers,
    })
  }
}

/**
 * Drag between two viewport points with real press, interpolated moves, and release.
 *
 * A native HTML5 drag-and-drop target needs `Input.dispatchDragEvent` after
 * the press, because Chrome never starts a native drag from
 * `Input.dispatchMouseEvent` alone. Plain mouse events stay the default for
 * canvas and custom pointer drags, which reject drag events.
 * @param tabId - target tab.
 * @param from - start point in viewport CSS pixels.
 * @param to - end point in viewport CSS pixels.
 * @param options - modifier bit mask and whether the target needs native DnD.
 * @returns which pipeline produced the drag.
 */
export async function dragPointer(
  tabId: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  options: DragPointerOptions = {},
): Promise<DragPointerMode> {
  const modifiers = options.modifiers ?? 0
  await ensureAttached(tabId)
  await dispatchMouseEvent(tabId, {
    type: 'mouseMoved',
    x: from.x,
    y: from.y,
    button: 'none',
    buttons: 0,
    modifiers,
  })
  await dispatchMouseEvent(tabId, {
    type: 'mousePressed',
    x: from.x,
    y: from.y,
    button: 'left',
    buttons: BUTTON_BITS.left,
    clickCount: 1,
    modifiers,
  })
  if (options.nativeDrag === true) {
    try {
      await dispatchNativeDrag(tabId, from, to, modifiers)
    } catch (error: unknown) {
      // Release the pressed button before handing the drag to the page-side
      // synthesized path, so the page is not left mid-press.
      try {
        await dispatchMouseEvent(tabId, {
          type: 'mouseReleased',
          x: to.x,
          y: to.y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
          modifiers,
        })
      } catch {
        // The detach or target loss that broke the drag also breaks release.
      }
      throw new NativeDragUnavailableError(
        `The browser refused native drag events for this target: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    await dispatchMouseEvent(tabId, {
      type: 'mouseReleased',
      x: to.x,
      y: to.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
      modifiers,
    })
    return 'native'
  }
  for (let step = 1; step <= CDP_DRAG_STEPS; step += 1) {
    const fraction = step / CDP_DRAG_STEPS
    await dispatchMouseEvent(tabId, {
      type: 'mouseMoved',
      x: Math.round(from.x + (to.x - from.x) * fraction),
      y: Math.round(from.y + (to.y - from.y) * fraction),
      button: 'none',
      buttons: BUTTON_BITS.left,
      modifiers,
    })
    if (step < CDP_DRAG_STEPS) await new Promise((resolve) => setTimeout(resolve, DRAG_STEP_DELAY_MS))
  }
  await dispatchMouseEvent(tabId, {
    type: 'mouseReleased',
    x: to.x,
    y: to.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
    modifiers,
  })
  return 'mouse'
}

/** Options for one real drag. */
export interface DragPointerOptions {
  /** Protocol modifier bit mask. */
  modifiers?: number
  /** Dispatch native drag events instead of simulated mouse moves. */
  nativeDrag?: boolean
}

/** Which input pipeline produced a drag. */
export type DragPointerMode = 'mouse' | 'native'

/** MIME type carried by a dispatched native drag. */
const NATIVE_DRAG_MIME = 'text/plain'

/** Payload carried by a dispatched native drag; pages read it from `getData`. */
const NATIVE_DRAG_DATA = 'dsh-drag'

/** Drag data every dispatched drag event of one gesture shares. */
function nativeDragData(): Record<string, unknown> {
  return {
    items: [{ mimeType: NATIVE_DRAG_MIME, data: NATIVE_DRAG_DATA }],
    // `1` is the protocol's copy operation.
    dragOperationsMask: 1,
  }
}

/** Dispatch one drag event of a native drag gesture. */
async function dispatchDragEvent(
  tabId: number,
  type: 'dragEnter' | 'dragOver' | 'drop',
  point: { x: number; y: number },
  modifiers: number,
): Promise<void> {
  await send(tabId, 'Input.dispatchDragEvent', {
    type,
    x: point.x,
    y: point.y,
    modifiers,
    data: nativeDragData(),
  })
}

/**
 * Dispatch the native drag event sequence between two points.
 *
 * @param tabId - target tab.
 * @param from - start point in viewport CSS pixels.
 * @param to - end point in viewport CSS pixels.
 * @param modifiers - protocol modifier bit mask.
 */
async function dispatchNativeDrag(
  tabId: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  modifiers: number,
): Promise<void> {
  await dispatchDragEvent(tabId, 'dragEnter', from, modifiers)
  for (let step = 1; step <= CDP_DRAG_STEPS; step += 1) {
    const fraction = step / CDP_DRAG_STEPS
    await dispatchDragEvent(tabId, 'dragOver', {
      x: Math.round(from.x + (to.x - from.x) * fraction),
      y: Math.round(from.y + (to.y - from.y) * fraction),
    }, modifiers)
    if (step < CDP_DRAG_STEPS) await new Promise((resolve) => setTimeout(resolve, DRAG_STEP_DELAY_MS))
  }
  await dispatchDragEvent(tabId, 'drop', to, modifiers)
}

// ---- Real keys through the Input domain ----

/**
 * One key the protocol can dispatch.
 *
 * `text` is set for keys that produce a character, so the caller can send a
 * `char` event after the `keyDown` without inserting the character twice.
 */
export interface KeyStroke {
  key: string
  code: string
  windowsVirtualKeyCode: number
  nativeVirtualKeyCode: number
  text?: string
}

/**
 * Named keys with their US-layout virtual key codes.
 *
 * Only keys the tool documents are mapped; an unmapped multi-character name is
 * refused rather than guessed, because a wrong code produces a different
 * default action than the caller asked for.
 */
const NAMED_KEY_STROKES: Record<string, KeyStroke> = {
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33, nativeVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34, nativeVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: ' ' },
}

/** Named keys accepted by {@link parseKeyStroke}. */
export const NAMED_KEY_NAMES: readonly string[] = Object.keys(NAMED_KEY_STROKES)

/**
 * Resolve a `browser_press` key name to protocol key fields.
 *
 * A single character is typed as text; a known name gets its documented code;
 * any other multi-character name is unsupported.
 * @param key - the tool's `key` argument.
 * @returns the key fields, or undefined for an empty or unsupported name.
 */
export function parseKeyStroke(key: string): KeyStroke | undefined {
  const named = NAMED_KEY_STROKES[key]
  if (named !== undefined) return named
  const characters = Array.from(key)
  if (characters.length !== 1) return undefined
  const character = characters[0]!
  const isLetter = /^[a-z]$/i.test(character)
  const isDigit = /^[0-9]$/.test(character)
  return {
    key: character,
    code: isLetter ? `Key${character.toUpperCase()}` : isDigit ? `Digit${character}` : '',
    windowsVirtualKeyCode: isLetter || isDigit ? character.toUpperCase().charCodeAt(0) : 0,
    nativeVirtualKeyCode: isLetter || isDigit ? character.toUpperCase().charCodeAt(0) : 0,
    text: character,
  }
}

/**
 * Dispatch one real key press through the browser input pipeline.
 *
 * A `keyDown` without text lets the browser perform its default action (focus
 * movement, form submission); a following `char` inserts character keys; the
 * `keyUp` completes the gesture.
 * @param tabId - target tab.
 * @param stroke - key fields resolved by {@link parseKeyStroke}.
 * @param modifiers - protocol modifier bit mask.
 */
export async function pressKey(tabId: number, stroke: KeyStroke, modifiers = 0): Promise<void> {
  await ensureAttached(tabId)
  const base = {
    key: stroke.key,
    code: stroke.code,
    windowsVirtualKeyCode: stroke.windowsVirtualKeyCode,
    nativeVirtualKeyCode: stroke.nativeVirtualKeyCode,
    modifiers,
  }
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  if (stroke.text !== undefined) {
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: 'char',
      ...base,
      text: stroke.text,
      unmodifiedText: stroke.text,
    })
  }
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

// ---- Console and network telemetry ----

/** One console message or page exception kept for `browser_console`. */
export interface CapturedConsoleMessage {
  type: string
  text: string
  url?: string
  line?: number
  column?: number
  timestamp: number
}

/**
 * A console entry before the buffer assigns a display timestamp.
 *
 * The protocol timestamp stays optional here: a source that never reports one
 * must still dedupe by type, text, and URL instead of a wall-clock default
 * that changes on every replay.
 */
export type CapturedConsoleInput = Omit<CapturedConsoleMessage, 'timestamp'> & { timestamp?: number }

/** One network request kept for `browser_network`. */
export interface CapturedNetworkRequest {
  url: string
  method: string
  status: number
  errorText?: string
  /** Request headers with credential-bearing names already replaced. */
  requestHeaders?: Record<string, string>
  /** Response headers with credential-bearing names already replaced. */
  responseHeaders?: Record<string, string>
  /** Size of the request body. The body itself is never recorded. */
  postDataBytes?: number
  /** True when the body was cut by the protocol cap, so the size is a lower bound. */
  postDataBytesTruncated?: boolean
  timestamp: number
}

interface ConsoleBuffer {
  domain?: string
  messages: CapturedConsoleMessage[]
  /** Identities already buffered, oldest first, for replay deduplication. */
  keys: Set<string>
}

interface NetworkBuffer {
  domain?: string
  requests: Map<string, CapturedNetworkRequest>
}

const consoleBuffers = new Map<number, ConsoleBuffer>()
const networkBuffers = new Map<number, NetworkBuffer>()

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined || url === '') return undefined
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

function consoleBufferFor(tabId: number): ConsoleBuffer {
  let buffer = consoleBuffers.get(tabId)
  if (buffer === undefined) {
    buffer = { messages: [], keys: new Set() }
    consoleBuffers.set(tabId, buffer)
  }
  return buffer
}

function networkBufferFor(tabId: number): NetworkBuffer {
  let buffer = networkBuffers.get(tabId)
  if (buffer === undefined) {
    buffer = { requests: new Map() }
    networkBuffers.set(tabId, buffer)
  }
  return buffer
}

/**
 * Clear telemetry when the tab's page moves to another domain.
 *
 * Same-domain navigations keep the buffer so a model can compare a reload;
 * crossing a domain boundary starts fresh, because messages from the previous
 * origin are no longer about the page being inspected.
 * @param tabId - the tab that committed a navigation.
 * @param url - the new committed document URL, when known.
 */
export function noteTabNavigation(tabId: number, url: string | undefined): void {
  userDeclinedTabs.delete(tabId)
  // A committed main-frame navigation replaces the document, so the installed
  // hook and its token are gone with it.
  forgetInstrumentChannel(tabId)
  const domain = hostOf(url)
  if (domain === undefined) return
  const consoleBuffer = consoleBuffers.get(tabId)
  if (consoleBuffer !== undefined) {
    if (consoleBuffer.domain === undefined) consoleBuffer.domain = domain
    else if (consoleBuffer.domain !== domain) {
      consoleBuffer.messages.length = 0
      consoleBuffer.keys.clear()
      consoleBuffer.domain = domain
    }
  }
  const networkBuffer = networkBuffers.get(tabId)
  if (networkBuffer !== undefined) {
    if (networkBuffer.domain === undefined) networkBuffer.domain = domain
    else if (networkBuffer.domain !== domain) {
      networkBuffer.requests.clear()
      networkBuffer.domain = domain
    }
  }
}

/**
 * Seed the domain boundary of both buffers for a tab.
 *
 * The first capture call records which domain the tab is on; later navigation
 * to another domain clears what was collected. A missing or unparseable URL
 * leaves the boundary unset, so the first resolvable navigation sets it.
 * @param tabId - target tab.
 * @param pageUrl - the tab's current URL, when known.
 */
export function seedTelemetryDomain(tabId: number, pageUrl: string | undefined): void {
  const domain = hostOf(pageUrl)
  if (domain === undefined) return
  const consoleBuffer = consoleBufferFor(tabId)
  if (consoleBuffer.domain === undefined) consoleBuffer.domain = domain
  const networkBuffer = networkBufferFor(tabId)
  if (networkBuffer.domain === undefined) networkBuffer.domain = domain
}

/**
 * Stable identity of one console entry.
 *
 * Timestamp, URL, line, column, and text together distinguish a replay from a
 * later genuine occurrence: Chrome replays `Log` and `Runtime` history with
 * the original timestamp, while a new occurrence carries a new one. Without a
 * timestamp the identity falls back to type, text, and URL.
 * @param message - entry to identify.
 * @returns a deterministic key.
 */
function consoleEntryKey(message: CapturedConsoleInput): string {
  if (message.timestamp === undefined) {
    return JSON.stringify([message.type, message.text, message.url ?? null])
  }
  return JSON.stringify([
    message.type,
    message.timestamp,
    message.url ?? null,
    message.line ?? null,
    message.column ?? null,
    message.text,
  ])
}

/**
 * Append one console entry unless its identity is already buffered.
 *
 * Exported for tests: a source that replays its history must not grow the
 * buffer, and the identity set stays bounded independently of the buffer.
 * @param tabId - tab the entry belongs to.
 * @param message - console entry, with no timestamp when the source omits one.
 * @param options - identity budget, or an options object.
 * @param options.dedupeLimit - identities to remember, oldest evicted first.
 * @param options.dedupe - whether the entry may be a protocol replay; the
 *   page-world hook never replays, so it passes false.
 * @returns true when the entry was buffered, false for a replayed duplicate.
 */
export function pushConsoleEntry(
  tabId: number,
  message: CapturedConsoleInput,
  options: number | { dedupeLimit?: number; dedupe?: boolean } = {},
): boolean {
  const buffer = consoleBufferFor(tabId)
  const key = consoleEntryKey(message)
  const resolved = typeof options === 'number' ? { dedupeLimit: options } : options
  const dedupe = resolved.dedupe ?? true
  if (dedupe && buffer.keys.has(key)) return false
  buffer.messages.push({
    ...message,
    text: redactModelText(message.text),
    timestamp: message.timestamp ?? Date.now(),
    ...(message.url === undefined ? {} : { url: redactUrlForModel(message.url) }),
  })
  if (buffer.messages.length > MAX_LOGS_PER_TAB) {
    buffer.messages.splice(0, buffer.messages.length - MAX_LOGS_PER_TAB)
  }
  if (!dedupe) return true
  const dedupeLimit = resolved.dedupeLimit ?? MAX_CONSOLE_DEDUPE_KEYS
  buffer.keys.add(key)
  while (buffer.keys.size > dedupeLimit) {
    const oldest = buffer.keys.values().next()
    if (oldest.done === true) break
    buffer.keys.delete(oldest.value)
  }
  return true
}

function pushNetwork(tabId: number, requestId: string, request: CapturedNetworkRequest): void {
  const buffer = networkBufferFor(tabId)
  buffer.requests.set(requestId, {
    ...request,
    url: redactUrlForModel(request.url),
    ...(request.requestHeaders === undefined ? {} : { requestHeaders: redactHeaders(request.requestHeaders) }),
    ...(request.responseHeaders === undefined ? {} : { responseHeaders: redactHeaders(request.responseHeaders) }),
  })
  while (buffer.requests.size > MAX_REQUESTS_PER_TAB) {
    const oldest = buffer.requests.keys().next()
    if (oldest.done === true) break
    buffer.requests.delete(oldest.value)
  }
}

interface RemoteObjectLike {
  type?: string
  subtype?: string
  value?: unknown
  description?: string
  unserializableValue?: string
}

function remoteObjectText(remote: RemoteObjectLike | undefined): string {
  if (remote === undefined) return ''
  if (typeof remote.unserializableValue === 'string') return remote.unserializableValue
  if (remote.value !== undefined) {
    if (typeof remote.value === 'string') return remote.value
    try {
      const json = JSON.stringify(remote.value)
      return json === undefined ? String(remote.value) : json
    } catch {
      return String(remote.value)
    }
  }
  if (typeof remote.description === 'string') return remote.description
  return remote.type ?? ''
}

interface CallFrameLike {
  functionName?: string
  url?: string
  lineNumber?: number
  columnNumber?: number
}

function callFramesOf(params: Record<string, unknown>): CallFrameLike[] {
  const stackTrace = params.stackTrace
  if (typeof stackTrace !== 'object' || stackTrace === null) return []
  const callFrames = (stackTrace as { callFrames?: unknown }).callFrames
  if (!Array.isArray(callFrames)) return []
  return callFrames.filter((frame): frame is CallFrameLike => typeof frame === 'object' && frame !== null)
}

function exceptionText(params: Record<string, unknown>): { text: string; url?: string; line?: number; column?: number } {
  const details = params.exceptionDetails
  const record = typeof details === 'object' && details !== null ? details as Record<string, unknown> : {}
  const exception = typeof record.exception === 'object' && record.exception !== null
    ? record.exception as RemoteObjectLike
    : undefined
  const headline = typeof exception?.description === 'string'
    ? exception.description
    : typeof record.text === 'string'
      ? record.text
      : 'Uncaught exception'
  const frames = callFramesOf(record)
  const stack = frames.map((frame) => {
    const name = typeof frame.functionName === 'string' && frame.functionName !== '' ? frame.functionName : '<anonymous>'
    const url = frame.url ?? ''
    const line = (frame.lineNumber ?? 0) + 1
    const column = (frame.columnNumber ?? 0) + 1
    return `    at ${name} (${url}:${line}:${column})`
  })
  const first = frames[0]
  return {
    text: redactModelText([headline, ...stack].join('\n')).slice(0, MAX_CONSOLE_TEXT),
    ...(first?.url === undefined ? {} : { url: first.url }),
    ...(first?.lineNumber === undefined ? {} : { line: first.lineNumber + 1 }),
    ...(first?.columnNumber === undefined ? {} : { column: first.columnNumber + 1 }),
  }
}

function logLevelType(level: unknown): string {
  if (level === 'error') return 'error'
  if (level === 'warning') return 'warn'
  if (level === 'verbose') return 'debug'
  return 'log'
}

/**
 * Apply one CDP event to the tab's telemetry buffers.
 *
 * Exported for tests: the real listener is a thin wrapper, so every buffer
 * rule (bounded growth, domain clearing, failure status) is exercised without
 * a live debugger.
 * @param tabId - tab the event belongs to.
 * @param method - protocol method name.
 * @param params - protocol event payload.
 */
export function handleDebuggerEvent(tabId: number, method: string, params: Record<string, unknown>): void {
  switch (method) {
    case 'Runtime.consoleAPICalled': {
      const args = Array.isArray(params.args) ? params.args as RemoteObjectLike[] : []
      const frames = callFramesOf(params)
      const first = frames[0]
      pushConsoleEntry(tabId, {
        type: typeof params.type === 'string' ? params.type : 'log',
        text: args.map((arg) => remoteObjectText(arg)).join(' ').slice(0, MAX_CONSOLE_TEXT),
        ...(first?.url === undefined ? {} : { url: first.url }),
        ...(first?.lineNumber === undefined ? {} : { line: first.lineNumber + 1 }),
        ...(first?.columnNumber === undefined ? {} : { column: first.columnNumber + 1 }),
        ...(typeof params.timestamp === 'number' ? { timestamp: params.timestamp } : {}),
      })
      return
    }
    case 'Runtime.exceptionThrown': {
      const exception = exceptionText(params)
      pushConsoleEntry(tabId, {
        type: 'exception',
        text: exception.text,
        ...(exception.url === undefined ? {} : { url: exception.url }),
        ...(exception.line === undefined ? {} : { line: exception.line }),
        ...(exception.column === undefined ? {} : { column: exception.column }),
        ...(typeof params.timestamp === 'number' ? { timestamp: params.timestamp } : {}),
      })
      return
    }
    case 'Log.entryAdded': {
      const rawEntry = params.entry
      if (typeof rawEntry !== 'object' || rawEntry === null) return
      const entry = rawEntry as Record<string, unknown>
      pushConsoleEntry(tabId, {
        type: logLevelType(entry.level),
        text: (typeof entry.text === 'string' ? entry.text : '').slice(0, MAX_CONSOLE_TEXT),
        ...(typeof entry.url === 'string' ? { url: entry.url } : {}),
        ...(typeof entry.lineNumber === 'number' ? { line: entry.lineNumber } : {}),
        ...(typeof entry.timestamp === 'number' ? { timestamp: entry.timestamp } : {}),
      })
      return
    }
    case 'Network.requestWillBeSent': {
      const requestId = typeof params.requestId === 'string' ? params.requestId : undefined
      const request = typeof params.request === 'object' && params.request !== null
        ? params.request as Record<string, unknown>
        : undefined
      if (requestId === undefined || request === undefined) return
      const url = typeof request.url === 'string' ? request.url : ''
      const method = typeof request.method === 'string' ? request.method : 'GET'
      const existing = networkBufferFor(tabId).requests.get(requestId)
      const requestHeaders = headerRecord(request.headers)
      // The protocol caps postData at `maxPostDataSize`, so its byte length is
      // only a lower bound. The declared Content-Length is the real size when
      // the page sent one.
      const declaredBytes = contentLengthHeader(requestHeaders)
      const recordedBytes = typeof request.postData === 'string'
        ? new TextEncoder().encode(request.postData).length
        : undefined
      const postDataBytes = declaredBytes ?? recordedBytes
      const bodySizeFields = postDataBytes === undefined
        ? {}
        : { postDataBytes, ...(declaredBytes === undefined && recordedBytes !== undefined ? { postDataBytesTruncated: true } : {}) }
      pushNetwork(tabId, requestId, {
        url,
        method,
        status: existing?.status ?? 0,
        ...(existing?.errorText === undefined ? {} : { errorText: existing.errorText }),
        ...(requestHeaders === undefined ? {} : { requestHeaders }),
        // postData holds the request body; only its size may be retained.
        ...bodySizeFields,
        timestamp: typeof params.timestamp === 'number' ? params.timestamp : Date.now(),
      })
      return
    }
    case 'Network.responseReceived': {
      const requestId = typeof params.requestId === 'string' ? params.requestId : undefined
      const response = typeof params.response === 'object' && params.response !== null
        ? params.response as Record<string, unknown>
        : undefined
      if (requestId === undefined || response === undefined) return
      const existing = networkBufferFor(tabId).requests.get(requestId)
      const responseHeaders = headerRecord(response.headers)
      pushNetwork(tabId, requestId, {
        url: typeof response.url === 'string' ? response.url : (existing?.url ?? ''),
        method: existing?.method ?? 'GET',
        status: typeof response.status === 'number' ? response.status : (existing?.status ?? 0),
        ...(existing?.errorText === undefined ? {} : { errorText: existing.errorText }),
        ...(existing?.requestHeaders === undefined ? {} : { requestHeaders: existing.requestHeaders }),
        ...(existing?.postDataBytes === undefined ? {} : { postDataBytes: existing.postDataBytes }),
        ...(existing?.postDataBytesTruncated === undefined ? {} : { postDataBytesTruncated: existing.postDataBytesTruncated }),
        ...(responseHeaders === undefined ? {} : { responseHeaders }),
        timestamp: existing?.timestamp ?? (typeof params.timestamp === 'number' ? params.timestamp : Date.now()),
      })
      return
    }
    case 'Network.loadingFailed': {
      const requestId = typeof params.requestId === 'string' ? params.requestId : undefined
      if (requestId === undefined) return
      const errorText = typeof params.errorText === 'string' ? params.errorText : 'request failed'
      // A cancelled or aborted navigation is a user action, not a failed
      // request; reporting it as a 503 would mislead the model.
      if (params.canceled === true || /ERR_ABORTED|canceled|cancelled/i.test(errorText)) return
      const existing = networkBufferFor(tabId).requests.get(requestId)
      if (existing === undefined) return
      pushNetwork(tabId, requestId, { ...existing, status: 503, errorText })
      return
    }
    default:
      return
  }
}

/** Record a console/network entry produced by the MAIN-world fallback hook. */
export function recordInstrumentEntry(tabId: number, entry: InstrumentEntry): void {
  if (entry.kind === 'console') {
    pushConsoleEntry(tabId, {
      type: entry.type,
      text: entry.text.slice(0, MAX_CONSOLE_TEXT),
      ...(entry.url === '' ? {} : { url: entry.url }),
      ...(entry.line === undefined ? {} : { line: entry.line }),
      ...(entry.column === undefined ? {} : { column: entry.column }),
      timestamp: entry.timestamp,
    }, { dedupe: false })
    return
  }
  const requestId = `${entry.method} ${entry.url} ${entry.timestamp}`
  pushNetwork(tabId, requestId, {
    url: entry.url,
    method: entry.method,
    status: entry.status,
    ...(entry.errorText === undefined ? {} : { errorText: entry.errorText.slice(0, 512) }),
    timestamp: entry.timestamp,
  })
}

/**
 * Enable console telemetry for a tab through CDP.
 * @param tabId - target tab.
 * @param pageUrl - current document URL, used to seed the domain boundary.
 */
export async function startConsoleCapture(tabId: number, pageUrl: string | undefined): Promise<void> {
  await ensureAttached(tabId)
  await ensureDomain(tabId, 'Runtime')
  await ensureDomain(tabId, 'Log')
  const buffer = consoleBufferFor(tabId)
  if (buffer.domain === undefined) buffer.domain = hostOf(pageUrl)
}

/** Enable network telemetry for a tab through CDP, resetting stale state. */
export async function startNetworkCapture(tabId: number, pageUrl: string | undefined): Promise<void> {
  await ensureAttached(tabId)
  const session = sessions.get(tabId)
  if (session?.enabled.has('Network') !== true) {
    try {
      await send(tabId, 'Network.disable', {})
    } catch {
      // The domain may not be enabled yet; enabling fresh is the normal path.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    await send(tabId, 'Network.enable', { maxPostDataSize: 65_536 })
    sessions.get(tabId)?.enabled.add('Network')
  }
  const buffer = networkBufferFor(tabId)
  if (buffer.domain === undefined) buffer.domain = hostOf(pageUrl)
}

/**
 * Generate a one-time envelope channel name for the MAIN-world hook.
 *
 * The name is delivered out of band (injection argument plus an extension
 * message) and never enters an entry envelope. It only filters look-alike
 * page events; entry payloads remain page-controlled data.
 * @returns a random channel name.
 */
export function newInstrumentChannel(): string {
  const cryptoValue = Reflect.get(globalThis, 'crypto') as { randomUUID?: () => string } | undefined
  if (typeof cryptoValue?.randomUUID === 'function') return cryptoValue.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

/**
 * Per-document channel for the MAIN-world hook.
 *
 * The hook installs once per document and keeps emitting on its original
 * channel, so a second console/network call must reuse that channel instead of
 * rotating it and silencing the already-installed hook.
 */
const instrumentChannels = new Map<number, string>()

/**
 * The channel for a tab's current document, created on first use.
 * @param tabId - target tab.
 * @returns a stable channel for this document.
 */
export function instrumentChannelFor(tabId: number): string {
  const existing = instrumentChannels.get(tabId)
  if (existing !== undefined) return existing
  const channel = newInstrumentChannel()
  instrumentChannels.set(tabId, channel)
  return channel
}

/** Forget the document channel after a navigation or when the tab is released. */
function forgetInstrumentChannel(tabId: number): void {
  instrumentChannels.delete(tabId)
}

/**
 * Inject the MAIN-world console/network hook used without the debugger.
 * @param tabId - target tab.
 * @param channel - one-time channel the isolated world forwards on.
 */
export async function installPageInstrumentation(tabId: number, channel: string): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'MAIN',
    func: installInstrument,
    args: [channel],
  })
}

/** Recording filter for `browser_console`. */
export interface ConsoleQuery {
  onlyErrors?: boolean
  pattern?: string
  limit?: number
  clear?: boolean
}

/** Console messages selected by one query. */
export interface ConsoleReadResult {
  /** Messages after filtering, oldest first, capped at `limit`. */
  messages: CapturedConsoleMessage[]
  /** How many messages matched the filter before `limit` truncated them. */
  total: number
  /** How many messages the buffer held before this read. */
  bufferTotal: number
  /** True when the caller asked to clear the buffer; the buffer is empty after this read. */
  cleared: boolean
  /** True when pattern matching stopped early because the pattern was too expensive. */
  patternAbandoned?: boolean
  /** True when the pattern ran as a literal substring instead of a regular expression. */
  patternDegraded?: boolean
}

/**
 * Total time one `pattern` may spend matching the console buffer.
 *
 * A model-supplied regular expression is untrusted input; a catastrophic
 * pattern over 10,000 retained messages would otherwise block the worker.
 */
export const CONSOLE_PATTERN_BUDGET_MS = 50

/** How often the pattern scan checks whether it has spent its time budget. */
const CONSOLE_PATTERN_CHECK_EVERY = 32

/**
 * Longest model-supplied pattern run as a regular expression.
 *
 * Longer patterns degrade to a case-insensitive substring test, because a
 * long or expensive expression can occupy the worker on a single message.
 */
export const CONSOLE_PATTERN_MAX_LENGTH = 200

/** How many leading characters of one message a pattern may inspect. */
export const CONSOLE_PATTERN_MATCH_PREFIX = 512

/** A compiled pattern, degraded to a literal contains test when unusable. */
interface PatternMatcher {
  test(text: string): boolean
}

/** A compiled pattern plus whether it degraded to literal substring matching. */
interface CompiledPattern {
  matcher: PatternMatcher
  degraded: boolean
}

/**
 * Compile a model-supplied pattern, bounding what one message can cost.
 *
 * A pattern over {@link CONSOLE_PATTERN_MAX_LENGTH}, or one the engine refuses
 * to compile, becomes a literal substring test and is reported as degraded.
 * @param pattern - the `pattern` argument.
 * @returns the matcher and its degraded flag.
 */
function compilePattern(pattern: string): CompiledPattern {
  if (pattern.length > CONSOLE_PATTERN_MAX_LENGTH) {
    return { matcher: literalMatcher(pattern), degraded: true }
  }
  try {
    const regex = new RegExp(pattern, 'i')
    return { matcher: { test: (text) => regex.test(text.slice(0, CONSOLE_PATTERN_MATCH_PREFIX)) }, degraded: false }
  } catch {
    return { matcher: literalMatcher(pattern), degraded: true }
  }
}

/**
 * Build a case-insensitive literal matcher over the inspected prefix.
 * @param pattern - literal text to find.
 * @returns the matcher.
 */
function literalMatcher(pattern: string): PatternMatcher {
  const literal = pattern.toLowerCase()
  return { test: (text) => text.slice(0, CONSOLE_PATTERN_MATCH_PREFIX).toLowerCase().includes(literal) }
}

/** Apply `only_errors` and the pattern rule to the buffer within a time budget. */
function selectConsoleMessages(
  messages: CapturedConsoleMessage[],
  query: ConsoleQuery,
): { messages: CapturedConsoleMessage[]; patternAbandoned: boolean; patternDegraded: boolean } {
  const onlyErrors = query.onlyErrors === true
  const compiled = query.pattern === undefined || query.pattern === '' ? undefined : compilePattern(query.pattern)
  if (compiled === undefined) {
    return {
      messages: messages.filter((message) => !onlyErrors || message.type === 'error' || message.type === 'exception'),
      patternAbandoned: false,
      patternDegraded: false,
    }
  }
  const selected: CapturedConsoleMessage[] = []
  const startedAt = Date.now()
  for (let index = 0; index < messages.length; index += 1) {
    // Check the budget between runs (a single run cannot be interrupted), and
    // bound every run's input so one message cannot monopolize the worker.
    if (index % CONSOLE_PATTERN_CHECK_EVERY === 0 && Date.now() - startedAt > CONSOLE_PATTERN_BUDGET_MS) {
      return { messages: selected, patternAbandoned: true, patternDegraded: compiled.degraded }
    }
    const message = messages[index]!
    if (onlyErrors && message.type !== 'error' && message.type !== 'exception') continue
    if (compiled.matcher.test(message.text)) selected.push(message)
  }
  return { messages: selected, patternAbandoned: false, patternDegraded: compiled.degraded }
}

/**
 * Read the console buffer of one tab, optionally discarding it afterwards.
 *
 * The filter and `limit` are applied before any clearing, and the clearing
 * happens after the selection has been copied out, so `clear` returns the
 * messages it read instead of an empty list.
 * @param tabId - target tab.
 * @param query - filters, limit, and clear flag.
 * @returns the selected messages, oldest first, capped at `limit`.
 */
export function readConsoleMessages(tabId: number, query: ConsoleQuery = {}): ConsoleReadResult {
  const buffer = consoleBufferFor(tabId)
  const bufferTotal = buffer.messages.length
  const limit = Math.min(Math.max(Math.floor(query.limit ?? 100), 1), 1_000)
  const selected = selectConsoleMessages(buffer.messages, query)
  const messages = selected.messages.slice(-limit)
  const clear = query.clear === true
  if (clear) buffer.messages.length = 0
  return {
    messages,
    total: selected.messages.length,
    bufferTotal,
    cleared: clear,
    ...(selected.patternAbandoned ? { patternAbandoned: true } : {}),
    ...(selected.patternDegraded ? { patternDegraded: true } : {}),
  }
}

/** Network request filter for `browser_network`. */
export interface NetworkQuery {
  urlPattern?: string
  limit?: number
  clear?: boolean
}

/** Network requests selected by one query. */
export interface NetworkReadResult {
  /** Requests after filtering, oldest first, capped at `limit`. */
  requests: CapturedNetworkRequest[]
  /** How many requests matched the filter before `limit` truncated them. */
  total: number
  /** How many requests the buffer held before this read. */
  bufferTotal: number
  /** True when the caller asked to clear the buffer; the buffer is empty after this read. */
  cleared: boolean
}

/**
 * Header-name fragments whose values never enter the model-facing buffer.
 *
 * Matching is by substring so vendor-prefixed and newly coined credential
 * names (`x-goog-api-key`, `x-auth-token`, custom `*-api-key`) are covered
 * without maintaining an exhaustive list of exact names.
 */
const SENSITIVE_HEADER_FRAGMENTS = [
  'authorization',
  'cookie',
  'set-cookie',
  'api-key',
  'apikey',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'proxy-authorization',
  'x-goog-api-key',
]

/** Whether a header name carries credential material. */
function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return SENSITIVE_HEADER_FRAGMENTS.some((fragment) => lower.includes(fragment))
}

/**
 * Query parameter name fragments whose values are replaced with `***`.
 *
 * Matching is by substring so vendor-prefixed names (`x-amz-signature`,
 * `sessionId`, `csrf_token`, `jwt`) are covered without maintaining an
 * exhaustive list of exact names.
 */
const SENSITIVE_QUERY_NAMES = /token|secret|key|sig|session|csrf|jwt|password|passwd|auth|credential/i

/** A `name=value` pair in a query-like string, used when a URL does not parse. */
const QUERY_PAIR_PATTERN = /([?&;])([^=&#;?\s]+)=([^&#;\s]*)/g

/** Userinfo in an authority, used when a URL does not parse. */
const USERINFO_PATTERN = /\/\/[^/@\s]+@/g

/**
 * Normalize a CDP header map into lowercase-safe string pairs.
 * @param value - protocol `headers` payload.
 * @returns a header record, or undefined when the payload is not an object.
 */
function headerRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const headers: Record<string, string> = {}
  for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
    headers[name] = typeof headerValue === 'string' ? headerValue : String(headerValue)
  }
  return headers
}

/**
 * Read a declared request body size from the headers.
 * @param headers - request headers as the protocol reported them.
 * @returns the byte count, or undefined when no valid Content-Length exists.
 */
function contentLengthHeader(headers: Record<string, string> | undefined): number | undefined {
  if (headers === undefined) return undefined
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'content-length') continue
    const parsed = Number(value.trim())
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
  }
  return undefined
}

/**
 * Replace credential-bearing header values.
 * @param headers - raw request or response headers.
 * @returns a copy where sensitive names carry `***` and other values are text-redacted.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = isSensitiveHeader(name) ? '***' : redactModelText(value)
  }
  return redacted
}

/**
 * Replace credential-bearing pairs and userinfo in an unparseable URL string.
 * @param raw - page-supplied text the URL parser rejected.
 * @returns the text with sensitive values masked.
 */
function redactUnparseableUrl(raw: string): string {
  return raw
    .replace(USERINFO_PATTERN, '//***:***@')
    .replace(QUERY_PAIR_PATTERN, (match, separator: string, name: string) =>
      SENSITIVE_QUERY_NAMES.test(name) ? `${separator}${name}=***` : match)
}

/**
 * Hide credentials in a URL before it enters a buffer or the model's view.
 *
 * Covers both `user:pass@host` userinfo and query parameters whose names are
 * commonly used for tokens, so a redirect URL cannot carry a session token
 * into the transcript. A URL that does not parse still gets the same
 * key-value masking applied to its whole text.
 * @param raw - the page-supplied URL.
 * @returns the redacted URL.
 */
export function redactUrlForModel(raw: string): string {
  try {
    const url = new URL(raw)
    const hadUserinfo = url.username !== '' || url.password !== ''
    if (hadUserinfo) {
      url.username = '***'
      url.password = '***'
    }
    let changedQuery = false
    for (const name of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_NAMES.test(name)) {
        url.searchParams.set(name, '***')
        changedQuery = true
      }
    }
    return hadUserinfo || changedQuery ? url.toString() : raw
  } catch {
    return redactUnparseableUrl(raw)
  }
}

/**
 * Read the network buffer of one tab, optionally discarding it afterwards.
 *
 * The filter and `limit` are applied before any clearing, and the clearing
 * happens after the selection has been copied out, so `clear` returns the
 * requests it read instead of an empty list.
 * @param tabId - target tab.
 * @param query - URL substring, limit, and clear flag.
 * @returns the selected requests, oldest first, capped at `limit`.
 */
export function readNetworkRequests(tabId: number, query: NetworkQuery = {}): NetworkReadResult {
  const buffer = networkBufferFor(tabId)
  const bufferTotal = buffer.requests.size
  const limit = Math.min(Math.max(Math.floor(query.limit ?? 100), 1), 1_000)
  const all = [...buffer.requests.values()]
  const selected = query.urlPattern === undefined || query.urlPattern === ''
    ? all
    : all.filter((request) => request.url.includes(query.urlPattern as string))
  const requests = selected.slice(-limit)
  const clear = query.clear === true
  if (clear) buffer.requests.clear()
  return { requests, total: selected.length, bufferTotal, cleared: clear }
}

function clock(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Render console messages with the tool's documented layout.
 * @param messages - selected messages, oldest first.
 * @param fallback - append the page-side hook limitation note.
 * @returns the model-facing text.
 */
export function formatConsoleMessages(messages: CapturedConsoleMessage[], fallback = false): string {
  const suffix = fallback
    ? '\n\n(captured by page-side hook: logs emitted before the hook installed and native exceptions outside window.onerror may be missing)'
    : ''
  if (messages.length === 0) {
    return `No console messages found for this tab.${suffix}\n\nNote: console tracking starts when this tool is first called; call it before the page loads, or reload the page to capture from page load.`
  }
  const blocks = messages.map((message, index) => {
    const location = message.url === undefined
      ? ''
      : ` (${redactUrlForModel(message.url)}:${message.line ?? 0}:${message.column ?? 0})`
    return `[${index + 1}] [${clock(message.timestamp)}] [${message.type.toUpperCase()}]${location}\n${redactModelText(message.text)}`
  })
  return `Found ${messages.length} console messages:\n\n${blocks.join('\n\n')}${suffix}`
}

/**
 * Render network requests with the tool's documented layout.
 * @param requests - selected requests, oldest first.
 * @param fallback - append the page-side hook limitation note.
 * @returns the model-facing text.
 */
export function formatNetworkRequests(requests: CapturedNetworkRequest[], fallback = false): string {
  const suffix = fallback
    ? '\n\n(captured by page-side hook: document/resource requests and service-worker traffic are not covered)'
    : ''
  if (requests.length === 0) {
    return `No network requests found for this tab.${suffix}\n\nNote: network tracking starts when this tool is first called; call it before the page loads, or reload the page to capture from page load.`
  }
  const blocks = requests.map((request, index) => [
    `${index + 1}. url: ${request.url}`,
    `   method: ${request.method}`,
    `   statusCode: ${request.status}`,
    ...(request.errorText === undefined ? [] : [`   error: ${request.errorText}`]),
    ...(request.postDataBytes === undefined
      ? []
      : [`   requestBodyBytes: ${request.postDataBytes}${request.postDataBytesTruncated === true ? ' (at least; the recorded body was truncated)' : ''}`]),
  ].join('\n'))
  return `Found ${requests.length} network request(s):\n\n${blocks.join('\n\n')}${suffix}`
}

// ---- Evaluate ----

/** `Runtime.evaluate` timeout before Chrome reports an execution timeout. */
const REPL_TIMEOUT_MS = 30_000

/** Outcome of one `Runtime.evaluate` round trip. */
export interface EvaluateOutcome {
  /** Result value when the page returned a JSON-representable value. */
  value?: unknown
  /** Remote-object description for functions, DOM nodes, and errors. */
  description?: string
  /** Rendered exception, when the evaluated code threw. */
  exception?: string
}

interface EvaluateResponse extends Record<string, unknown> {
  result?: RemoteObjectLike
  exceptionDetails?: Record<string, unknown>
}

function illegalReturn(response: EvaluateResponse): boolean {
  const details = response.exceptionDetails
  if (details === undefined) return false
  const exception = typeof details.exception === 'object' && details.exception !== null
    ? details.exception as RemoteObjectLike
    : undefined
  const text = [details.text, exception?.description].filter((part): part is string => typeof part === 'string').join(' ')
  return /Illegal return statement/i.test(text)
}

function serializationFailure(details: Record<string, unknown>): boolean {
  const exception = typeof details.exception === 'object' && details.exception !== null
    ? details.exception as RemoteObjectLike
    : undefined
  const text = [details.text, exception?.description].filter((part): part is string => typeof part === 'string').join(' ')
  return /object reference chain is too long|could not (?:be )?serializ|circular|convert argument to a value|preview limit/i.test(text)
}

async function evaluateCommand(
  tabId: number,
  expression: string,
  awaitPromise: boolean,
  replMode: boolean,
): Promise<EvaluateResponse> {
  const response = await send(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    replMode,
    timeout: REPL_TIMEOUT_MS,
  })
  return response as EvaluateResponse
}

/**
 * Evaluate JavaScript in the tab's MAIN world through CDP.
 *
 * REPL semantics are tried first so a bare last expression renders; a
 * top-level `return` is syntactically illegal there, so that one failure
 * retries as an async IIFE.
 * @param tabId - tab whose page runs the code.
 * @param code - the model-supplied source.
 * @param awaitPromise - await a returned promise before answering.
 * @returns the raw outcome; formatting and masking happen in {@link formatEvaluationResult}.
 */
export async function evaluateInPage(tabId: number, code: string, awaitPromise = true): Promise<EvaluateOutcome> {
  await ensureAttached(tabId)
  await ensureDomain(tabId, 'Runtime')
  let response: EvaluateResponse
  try {
    response = await evaluateCommand(tabId, code, awaitPromise, true)
    if (illegalReturn(response)) {
      response = await evaluateCommand(tabId, `(async () => {\n${code}\n})()`, awaitPromise, false)
    }
  } catch (error: unknown) {
    if (error instanceof DebuggerUnavailableError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    if (/object reference chain is too long|could not (?:be )?serializ|circular/i.test(detail)) {
      throw new JsResultNotSerializableError(
        `The page value cannot be serialized. Return a string instead, for example: return JSON.stringify(value). (${redactString(detail)})`,
      )
    }
    throw error
  }
  const details = response.exceptionDetails
  if (details !== undefined) {
    if (serializationFailure(details)) {
      throw new JsResultNotSerializableError(
        'The page value cannot be serialized. Return a string instead, for example: return JSON.stringify(value).',
      )
    }
    const exception = typeof details.exception === 'object' && details.exception !== null
      ? details.exception as RemoteObjectLike
      : undefined
    const rawText = exception?.description ?? (typeof details.text === 'string' ? details.text : 'Uncaught exception')
    // A thrown Error can embed a credential in its message or stack; the same
    // text rules that cover results and console output cover it here.
    const text = redactString(rawText)
    if (/timed out|timeout/i.test(text)) {
      return { exception: 'Execution timeout: code exceeded 30-second limit' }
    }
    return { exception: `JavaScript execution error: ${text}` }
  }
  const result = response.result
  if (result === undefined) return { value: undefined }
  if (typeof result.unserializableValue === 'string') return { value: result.unserializableValue }
  if (result.value !== undefined) return { value: result.value }
  if (typeof result.description === 'string') return { description: result.description }
  return { value: result.type ?? 'undefined' }
}

// ---- Credential redaction ----

const SENSITIVE_KEY = /password|token|secret|api[_-]?key|auth|credential|private[_-]?key|access[_-]?key|bearer|oauth|session/i
const COOKIE_KEY = /cookie/i
const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}$/
const BASE64_SHAPE = /^[A-Za-z0-9+/]{40,}={0,2}$/
const HEX_SHAPE = /^(?:0x)?[0-9a-fA-F]{32,}$/
const API_KEY_SHAPE = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g
const BEARER_SHAPE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi

/** Longest single string kept before truncation. */
export const MAX_STRING_VALUE = 1_000

/** How many array items are inspected before the rest is described. */
export const MAX_ARRAY_ITEMS = 100

/** How deep object traversal goes before the rest is described. */
export const MAX_REDACTION_DEPTH = 5

/**
 * Shared text-level credential redaction.
 *
 * Console text, exception text, instrumented entries, and evaluated string
 * values all pass through this one rule set, so a token cannot survive one
 * reporting path while being blocked in another.
 * @param value - page-supplied text.
 * @returns the text with credential shapes replaced, bounded to 1000 characters.
 */
export function redactModelText(value: string): string {
  return redactString(value)
}

function redactString(value: string): string {
  if (value.includes('=') && (value.includes(';') || value.includes('&'))) {
    return '[BLOCKED: Cookie/query string data]'
  }
  if (JWT_SHAPE.test(value)) return '[BLOCKED: jwt data]'
  if (BASE64_SHAPE.test(value)) return '[BLOCKED: base64 data]'
  if (HEX_SHAPE.test(value)) return '[BLOCKED: hex data]'
  const masked = value
    .replace(BEARER_SHAPE, '[BLOCKED: bearer token]')
    .replace(API_KEY_SHAPE, '[BLOCKED: api key]')
  return masked.length > MAX_STRING_VALUE ? `${masked.slice(0, MAX_STRING_VALUE)}…[truncated]` : masked
}

/**
 * Replace credentials and oversized data with bounded placeholders.
 *
 * The walk is bounded in depth, array length, and string length so a hostile
 * page cannot make one tool result unbounded. Cycles become `[Circular]`
 * rather than throwing, because the model needs to know the value existed.
 * @param value - any value returned by page evaluation.
 * @param depth - current traversal depth (callers omit it).
 * @param ancestors - objects on the current branch, used for cycle detection.
 * @returns a JSON-safe value with secrets replaced.
 */
export function redactForModel(
  value: unknown,
  depth = 0,
  ancestors: WeakSet<object> = new WeakSet(),
): unknown {
  if (depth > MAX_REDACTION_DEPTH) return '[TRUNCATED: max depth]'
  if (value === undefined) return 'undefined'
  if (value === null) return null
  switch (typeof value) {
    case 'string':
      return redactString(value)
    case 'number':
    case 'boolean':
      return value
    case 'bigint':
      return value.toString()
    case 'symbol':
      return value.toString()
    case 'function':
      return `[Function ${value.name === '' ? 'anonymous' : value.name}]`
    default:
      break
  }
  if (ancestors.has(value)) return '[Circular]'
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const kept = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactForModel(item, depth + 1, ancestors))
      if (value.length > MAX_ARRAY_ITEMS) kept.push(`[TRUNCATED: ${value.length - MAX_ARRAY_ITEMS} more items]`)
      return kept
    }
    const record = value as Record<string, unknown>
    const redacted: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(record)) {
      if (COOKIE_KEY.test(key)) {
        redacted[key] = '[BLOCKED: Cookie access]'
        continue
      }
      if (SENSITIVE_KEY.test(key)) {
        redacted[key] = '[BLOCKED: Sensitive key]'
        continue
      }
      redacted[key] = redactForModel(entry, depth + 1, ancestors)
    }
    return redacted
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Render one evaluation outcome as the model-facing `Result:` block.
 * @param outcome - value or exception returned by {@link evaluateInPage}.
 * @returns the text, with credentials already replaced.
 */
export function formatEvaluationResult(outcome: EvaluateOutcome): string {
  if (outcome.exception !== undefined) return redactString(outcome.exception)
  if (outcome.description !== undefined) return `Result: ${JSON.stringify(redactString(outcome.description))}`
  const redacted = redactForModel(outcome.value)
  let json: string
  try {
    json = JSON.stringify(redacted, null, 2) ?? 'undefined'
  } catch {
    json = '"undefined"'
  }
  return `Result: ${json}`
}

// ---- Screenshot ----

/** Viewport geometry used to place and size a screenshot clip. */
export interface ViewportMetrics {
  viewportWidth: number
  viewportHeight: number
  scrollX: number
  scrollY: number
  dpr: number
}

/** One captured image with its base64 payload. */
export interface ScreenshotImage {
  base64: string
  mimeType: 'image/jpeg' | 'image/png'
  width: number
  height: number
}

/** Screenshot result: pixels plus the coordinate frame they came from. */
export interface ScreenshotCapture {
  image: ScreenshotImage
  frame: {
    viewportWidth: number
    viewportHeight: number
    screenshotWidth: number
    screenshotHeight: number
    dpr: number
  }
  /** The JPEG quality actually applied, when the capture was JPEG. */
  quality?: ScreenshotQuality
  /** Degradations the caller must report with the image, in model-facing prose. */
  notes?: string[]
}

/** JPEG quality the size ladder actually used for one capture. */
export interface ScreenshotQuality {
  /** Quality the caller asked for. */
  requested: number
  /** Quality the returned bytes were encoded with. */
  effective: number
  /** True when the size ladder lowered the requested quality. */
  reduced: boolean
}

/** Screenshot options after the tool layer validated them. */
export interface ScreenshotOptions {
  region?: [number, number, number, number]
  scale: number
  format: 'jpeg' | 'png'
  quality: number
}

const VIEWPORT_EXPRESSION = 'JSON.stringify({viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY, dpr: window.devicePixelRatio || 1})'

function parseMetrics(raw: unknown): ViewportMetrics | undefined {
  if (typeof raw !== 'string') return undefined
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const viewportWidth = typeof parsed.viewportWidth === 'number' ? parsed.viewportWidth : undefined
    const viewportHeight = typeof parsed.viewportHeight === 'number' ? parsed.viewportHeight : undefined
    if (viewportWidth === undefined || viewportHeight === undefined) return undefined
    return {
      viewportWidth,
      viewportHeight,
      scrollX: typeof parsed.scrollX === 'number' ? parsed.scrollX : 0,
      scrollY: typeof parsed.scrollY === 'number' ? parsed.scrollY : 0,
      dpr: typeof parsed.dpr === 'number' && parsed.dpr > 0 ? parsed.dpr : 1,
    }
  } catch {
    return undefined
  }
}

/**
 * Read the page's viewport geometry through the debugger.
 * @param tabId - target tab.
 * @returns CSS-pixel viewport size, scroll offset, and device pixel ratio.
 */
export async function readViewportMetrics(tabId: number): Promise<ViewportMetrics> {
  const outcome = await evaluateInPage(tabId, VIEWPORT_EXPRESSION, false)
  const metrics = parseMetrics(outcome.value)
  if (metrics === undefined) {
    throw new DebuggerUnavailableError('The page viewport could not be measured through the browser debugger.')
  }
  return metrics
}

interface CaptureResponse extends Record<string, unknown> {
  data?: string
}

async function captureWithParams(tabId: number, params: Record<string, unknown>): Promise<string> {
  const response = (await send(tabId, 'Page.captureScreenshot', params)) as CaptureResponse
  return typeof response.data === 'string' ? response.data : ''
}

/**
 * Capture a screenshot through CDP, shrinking JPEG quality until it fits.
 * @param tabId - target tab.
 * @param options - validated region, format, scale, and quality.
 * @returns image bytes and the frame they were captured in.
 */
export async function captureScreenshot(tabId: number, options: ScreenshotOptions): Promise<ScreenshotCapture> {
  await ensureAttached(tabId)
  await ensureDomain(tabId, 'Page')
  const metrics = await readViewportMetrics(tabId)
  const [x0, y0, x1, y1] = options.region ?? [0, 0, metrics.viewportWidth, metrics.viewportHeight]
  const width = x1 - x0
  const height = y1 - y0
  const clip = {
    x: metrics.scrollX + x0,
    y: metrics.scrollY + y0,
    width,
    height,
    scale: options.scale,
  }
  const baseParams: Record<string, unknown> = {
    format: options.format,
    fromSurface: true,
    captureBeyondViewport: false,
    clip,
    ...(options.format === 'jpeg' ? { quality: options.quality } : {}),
  }
  let base64 = await captureWithParams(tabId, baseParams)
  let mimeType: ScreenshotImage['mimeType'] = options.format === 'png' ? 'image/png' : 'image/jpeg'
  let effectiveQuality = options.format === 'jpeg' ? options.quality : undefined
  if (base64 === '') {
    throw new DebuggerUnavailableError('The browser debugger returned an empty screenshot.')
  }
  if (base64.length > MAX_SCREENSHOT_BASE64) {
    // The wire cap is on base64 characters; recapture as JPEG and walk the
    // quality ladder until it fits or the lowest usable quality is exhausted.
    mimeType = 'image/jpeg'
    let ladderQuality: number | undefined
    for (let quality = Math.min(options.quality, 80); quality >= 10; quality -= 10) {
      const candidate = await captureWithParams(tabId, {
        format: 'jpeg',
        quality,
        fromSurface: true,
        captureBeyondViewport: false,
        clip,
      })
      if (candidate === '') continue
      base64 = candidate
      ladderQuality = quality
      if (base64.length <= MAX_SCREENSHOT_BASE64) break
    }
    if (base64.length > MAX_SCREENSHOT_BASE64) {
      throw new ScreenshotTooLargeError(
        'The screenshot is too large even at the lowest JPEG quality. Capture a smaller region with the region argument.',
      )
    }
    effectiveQuality = ladderQuality
  }
  const screenshotWidth = Math.max(1, Math.round(width * options.scale * metrics.dpr))
  const screenshotHeight = Math.max(1, Math.round(height * options.scale * metrics.dpr))
  return {
    image: { base64, mimeType, width: screenshotWidth, height: screenshotHeight },
    frame: {
      viewportWidth: metrics.viewportWidth,
      viewportHeight: metrics.viewportHeight,
      screenshotWidth,
      screenshotHeight,
      dpr: metrics.dpr,
    },
    ...(effectiveQuality === undefined
      ? {}
      : { quality: { requested: options.quality, effective: effectiveQuality, reduced: effectiveQuality < options.quality } }),
  }
}

/**
 * Measure the viewport without the debugger, through an injected script.
 * @param tabId - target tab.
 * @returns metrics, or undefined when the page cannot be scripted.
 */
export async function readViewportMetricsWithoutDebugger(tabId: number): Promise<ViewportMetrics | undefined> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: () => JSON.stringify({
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        dpr: window.devicePixelRatio || 1,
      }),
    })
    return parseMetrics(result?.result)
  } catch {
    return undefined
  }
}

interface DecodedImage {
  width: number
  height: number
}

async function decodeImage(base64: string, mimeType: string): Promise<DecodedImage> {
  const response = await fetch(`data:${mimeType};base64,${base64}`)
  const bitmap = await createImageBitmap(await response.blob())
  return { width: bitmap.width, height: bitmap.height }
}

function mimeTypeOfFormat(format: 'jpeg' | 'png'): ScreenshotImage['mimeType'] {
  return format === 'png' ? 'image/png' : 'image/jpeg'
}

/**
 * Crop, scale, and re-encode one capture without the debugger.
 *
 * One `drawImage` call covers both cropping and scaling, so the region and
 * `scale` behave the same as in the debugger path. `format` selects the output
 * encoding; JPEG quality is fixed because the tool's `quality` argument only
 * applies to the CDP path.
 * @param base64 - captured payload.
 * @param mimeType - encoding of `base64`.
 * @param crop - source rectangle in device pixels.
 * @param scale - output scale relative to the cropped pixels.
 * @param format - requested output encoding.
 * @returns the rendered image.
 */
async function renderScreenshot(
  base64: string,
  mimeType: ScreenshotImage['mimeType'],
  crop: { x: number; y: number; width: number; height: number },
  scale: number,
  format: 'jpeg' | 'png',
): Promise<ScreenshotImage> {
  const response = await fetch(`data:${mimeType};base64,${base64}`)
  const bitmap = await createImageBitmap(await response.blob())
  const x = Math.max(0, Math.round(crop.x))
  const y = Math.max(0, Math.round(crop.y))
  const width = Math.max(1, Math.min(Math.round(crop.width), bitmap.width - x))
  const height = Math.max(1, Math.min(Math.round(crop.height), bitmap.height - y))
  const targetWidth = Math.max(1, Math.round(width * scale))
  const targetHeight = Math.max(1, Math.round(height * scale))
  const canvas = new OffscreenCanvas(targetWidth, targetHeight)
  const context = canvas.getContext('2d')
  if (context === null) throw new ScreenshotTooLargeError('This browser cannot crop screenshots without the debugger.')
  context.drawImage(bitmap, x, y, width, height, 0, 0, targetWidth, targetHeight)
  bitmap.close()
  const outputType = mimeTypeOfFormat(format)
  const blob = await canvas.convertToBlob({ type: outputType, quality: 0.9 })
  const buffer = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (const byte of buffer) binary += String.fromCharCode(byte)
  return { base64: btoa(binary), mimeType: outputType, width: targetWidth, height: targetHeight }
}

/**
 * Capture the visible viewport without the debugger.
 *
 * `captureVisibleTab` only sees the active tab of a window, so a background
 * tab is refused with `debugger-unavailable` instead of a misleading empty
 * image. The capture itself is at the device pixel ratio, so a region is
 * converted from CSS pixels with the page's device pixel ratio, then cropped,
 * scaled by `scale`, and encoded as `format` in one canvas pass.
 * @param tabId - target tab.
 * @param windowId - the tab's window, when known.
 * @param options - validated region, format, scale, and quality.
 * @returns image bytes, a best-effort coordinate frame, and any degradation notes.
 */
export async function captureVisibleTabScreenshot(
  tabId: number,
  windowId: number | undefined,
  options: ScreenshotOptions,
): Promise<ScreenshotCapture> {
  let tab: chrome.tabs.Tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    throw new DebuggerUnavailableError('The tab no longer exists.')
  }
  if (tab.active !== true) {
    throw new DebuggerUnavailableError(
      `Tab ${tabId} is not the active tab, and capturing a background tab needs the debugger permission. Activate this tab and retry, or grant the debugger permission.`,
    )
  }
  const targetWindow = windowId ?? tab.windowId
  if (targetWindow === undefined) {
    throw new DebuggerUnavailableError('The tab has no window to capture from. Activate the tab and retry.')
  }
  let dataUrl: string
  try {
    dataUrl = options.format === 'png'
      ? await chrome.tabs.captureVisibleTab(targetWindow, { format: 'png' })
      : await chrome.tabs.captureVisibleTab(targetWindow, { format: 'jpeg', quality: options.quality })
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new DebuggerUnavailableError(
      `The visible tab could not be captured: ${detail}. Grant the debugger permission, or activate the tab and retry.`,
    )
  }
  const marker = 'base64,'
  const markerIndex = dataUrl.indexOf(marker)
  if (markerIndex < 0) throw new DebuggerUnavailableError('The browser returned an unreadable screenshot.')
  const rawBase64 = dataUrl.slice(markerIndex + marker.length)
  const captureMimeType = mimeTypeOfFormat(options.format)
  const decoded = await decodeImage(rawBase64, captureMimeType)
  const metrics = await readViewportMetricsWithoutDebugger(tabId)
  const notes: string[] = []
  if (metrics === undefined) {
    notes.push(
      'The page device pixel ratio could not be read without the debugger, so this coordinate frame assumes devicePixelRatio 1; the viewport size was derived from the captured pixels.',
    )
  }
  const dpr = metrics === undefined ? 1 : metrics.dpr
  let image: ScreenshotImage = {
    base64: rawBase64,
    mimeType: captureMimeType,
    width: decoded.width,
    height: decoded.height,
  }
  if (options.region !== undefined || options.scale !== 1) {
    const crop = options.region === undefined
      ? { x: 0, y: 0, width: decoded.width, height: decoded.height }
      : (() => {
        const [x0, y0, x1, y1] = options.region
        return { x: x0 * dpr, y: y0 * dpr, width: (x1 - x0) * dpr, height: (y1 - y0) * dpr }
      })()
    try {
      image = await renderScreenshot(rawBase64, captureMimeType, crop, options.scale, options.format)
    } catch (error: unknown) {
      if (options.region !== undefined) {
        throw new ScreenshotTooLargeError(
          'The browser cannot crop a visible-tab screenshot. Capture the whole viewport (omit region) or grant the debugger permission.',
        )
      }
      // The capture already uses the requested format; only the scale is lost.
      const detail = error instanceof Error ? error.message : String(error)
      notes.push(`This degraded screenshot ignores scale: the browser could not resize it without the debugger (${detail}).`)
    }
  }
  return {
    image,
    frame: {
      viewportWidth: metrics?.viewportWidth ?? Math.round(decoded.width / dpr),
      viewportHeight: metrics?.viewportHeight ?? Math.round(decoded.height / dpr),
      screenshotWidth: image.width,
      screenshotHeight: image.height,
      dpr,
    },
    // captureVisibleTab applies the requested JPEG quality directly; there is
    // no size ladder on this path.
    ...(options.format === 'jpeg'
      ? { quality: { requested: options.quality, effective: options.quality, reduced: false } }
      : {}),
    ...(notes.length === 0 ? {} : { notes }),
  }
}

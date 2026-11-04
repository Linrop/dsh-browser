/**
 * Page actions: click/type/press/scroll/navigate/get_text/wait plus
 * select/hover/drag/upload_file/find, executed in the content script against
 * the real page (preserving login state), each returning a short text status.
 * Navigations return a fresh full snapshot because the document — and the id
 * registry — reset.
 *
 * All browser action results use structured text, so a
 * status line tells the model what happened and what state remains.
 *
 * @module
 */

import { ActionError, elementOrThrow, numberArg } from './action-support.ts'
import { selectAction, uploadFileAction } from './element-actions.ts'
import { pageText, truncate } from './extract.ts'
import { findAction } from './find.ts'
import type { ElementIds } from './ids.ts'
import { dragAction, dragRectsAction, hoverAction, pointerRectAction } from './pointer-actions.ts'
import type { SnapshotBudget } from './snapshot.ts'
import { buildSnapshot, renderSnapshot } from './snapshot.ts'

export { ActionError } from './action-support.ts'

/** A settled action result. */
export interface ActionResult {
  text: string
  /** Page-authored snapshot delta; the background must wrap it as untrusted. */
  pageContent?: string
  /** A same-frame document navigation was scheduled after this response. */
  navigationPending?: boolean
}

/** How long an action should observe a ready document before returning. */
export interface PageSettlePolicy {
  /** Earliest return after the document becomes ready. */
  minimumMs: number
  /** Required DOM-quiet period before returning. */
  quietMs: number
  /** Hard cap after readiness; continuously animated pages cannot stall tools. */
  maxAfterReadyMs: number
  /** Hard cap while waiting for document readiness. */
  timeoutMs: number
}

const TYPE_SETTLE: PageSettlePolicy = { minimumMs: 32, quietMs: 32, maxAfterReadyMs: 100, timeoutMs: 5_000 }
const ACTION_SETTLE: PageSettlePolicy = { minimumMs: 100, quietMs: 50, maxAfterReadyMs: 250, timeoutMs: 5_000 }
const SCROLL_SETTLE: PageSettlePolicy = { minimumMs: 50, quietMs: 50, maxAfterReadyMs: 150, timeoutMs: 5_000 }
const EXPLICIT_WAIT_SETTLE: PageSettlePolicy = { minimumMs: 100, quietMs: 100, maxAfterReadyMs: 1_000, timeoutMs: 5_000 }
/** Keep automatic action context focused while preserving the negotiated full snapshot budget. */
const ACTION_DELTA_MAX_CHARS = 4_000

/**
 * Wait for document readiness and a mutation-free window. The old fixed delay
 * charged every action equally and still returned too early when a late DOM
 * update landed near its boundary. This observer returns early on already
 * stable pages, extends only for real mutations, and stays bounded on pages
 * with continuous animation.
 */
export function waitForPageSettled(policy: PageSettlePolicy = ACTION_SETTLE): Promise<boolean> {
  const startedAt = performance.now()
  let readyAt = document.readyState === 'complete' ? startedAt : undefined
  let lastMutationAt = startedAt
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  let observer: MutationObserver | undefined

  return new Promise((resolve) => {
    const finish = (settled: boolean): void => {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      observer?.disconnect()
      document.removeEventListener('readystatechange', schedule)
      window.removeEventListener('load', schedule)
      resolve(settled)
    }
    const check = (): void => {
      timer = undefined
      const now = performance.now()
      if (readyAt === undefined && document.readyState === 'complete') {
        readyAt = now
        lastMutationAt = now
      }
      if (readyAt !== undefined) {
        const afterReady = now - readyAt
        const quietFor = now - lastMutationAt
        if ((afterReady >= policy.minimumMs && quietFor >= policy.quietMs)
          || afterReady >= policy.maxAfterReadyMs) {
          finish(true)
          return
        }
        const untilMinimum = Math.max(0, policy.minimumMs - afterReady)
        const untilQuiet = Math.max(0, policy.quietMs - quietFor)
        timer = setTimeout(check, Math.max(1, Math.min(policy.maxAfterReadyMs - afterReady, Math.max(untilMinimum, untilQuiet))))
        return
      }
      const elapsed = now - startedAt
      if (elapsed >= policy.timeoutMs) {
        finish(false)
        return
      }
      timer = setTimeout(check, Math.max(1, Math.min(100, policy.timeoutMs - elapsed)))
    }
    function schedule(): void {
      if (finished) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(check, 0)
    }

    if (document.documentElement !== null) {
      observer = new MutationObserver(() => {
        lastMutationAt = performance.now()
        schedule()
      })
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      })
    }
    document.addEventListener('readystatechange', schedule)
    window.addEventListener('load', schedule)
    schedule()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** React-compatible value write: native setter + input/change events. */
function setNativeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter === undefined) {
    input.value = value
  } else {
    setter.call(input, value)
  }
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Action implementations; each returns a text result. */
export interface ActionContext {
  ids: ElementIds
  budget: SnapshotBudget
  /** Enabled only when the background may share page content without another approval. */
  includePageDelta?: boolean
}

/** Run one named action with its args. */
export async function runAction(action: string, args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  switch (action) {
    case 'browser_snapshot':
      return snapshotAction(args, ctx)
    case 'browser_click':
      return clickAction(args, ctx)
    case 'browser_type':
      return typeAction(args, ctx)
    case 'browser_press':
      return pressAction(args, ctx)
    case 'browser_scroll':
      return scrollAction(args, ctx)
    case 'browser_navigate':
      return navigateAction(args)
    case 'browser_back':
      return historyAction(-1)
    case 'browser_forward':
      return historyAction(1)
    case 'browser_reload':
      return reloadAction()
    case 'browser_get_text':
      return getTextAction(args)
    case 'browser_wait':
      return waitAction(args, ctx)
    case 'browser_select':
      return settledElementAction(selectAction(args, ctx.ids), ctx)
    case 'browser_hover':
      return settledElementAction(hoverAction(args, ctx.ids), ctx)
    case 'browser_pointer_rect':
      return await pointerRectResult(args, ctx)
    case 'browser_drag':
      return settledElementAction(dragAction(args, ctx.ids), ctx)
    case 'browser_upload_file':
      return settledElementAction(uploadFileAction(args, ctx.ids), ctx)
    case 'browser_find':
      return { text: findAction(args, ctx.ids, ctx.budget) }
    default:
      throw new ActionError('bad-args', `Unknown action: ${action}`)
  }
}

/**
 * Answer the background's internal coordinate lookup for real input dispatch.
 *
 * Runs `settle` when the background asks for the post-dispatch page delta, and
 * shares `withPageDelta` so a CDP-driven hover/drag still returns the same
 * automatic page context as the synthesized path.
 * @param args - `index`/`x`/`y`, or a drag endpoint form, plus `settle`.
 * @param ctx - action context carrying the id registry and delta gate.
 * @returns the viewport geometry as JSON text, plus any permitted page delta.
 */
async function pointerRectResult(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  if (args.settle === true) await waitForPageSettled(ACTION_SETTLE)
  const drag = args.from_index !== undefined || args.to_index !== undefined
    || args.from !== undefined || args.to !== undefined
  const rects = drag ? dragRectsAction(args, ctx.ids) : pointerRectAction(args, ctx.ids)
  return withPageDelta(JSON.stringify(rects), ctx)
}

function snapshotAction(args: Record<string, unknown>, ctx: ActionContext): ActionResult {
  const delta = args.delta === true
  const region = typeof args.region === 'string' && args.region !== '' ? args.region : undefined
  // 基线在每次快照后都更新：delta 调用才能相对上一次（无论是否 delta）比较。
  const view = buildSnapshot(ctx.ids, { delta, region, budget: ctx.budget }, lastSnapshot)
  lastSnapshot = view
  return { text: renderSnapshot(view, delta) }
}

/** Module-level last snapshot state for delta mode (content-script lifetime). */
let lastSnapshot: ReturnType<typeof buildSnapshot> | null = null

/** Invalidate delta state after navigation (new document). */
function resetDeltaState(): void {
  lastSnapshot = null
}

/** Attach the settled page change while retaining the full view as the next delta baseline. */
function withPageDelta(text: string, ctx: ActionContext): ActionResult {
  if (ctx.includePageDelta !== true || lastSnapshot === null) return { text }
  const view = buildSnapshot(ctx.ids, { delta: true, budget: ctx.budget }, lastSnapshot)
  lastSnapshot = view
  return {
    text,
    pageContent: renderSnapshot(view, true, Math.min(ctx.budget.maxChars, ACTION_DELTA_MAX_CHARS)),
  }
}

/**
 * Run an element action, then report the page delta it caused.
 *
 * Element actions share one settle-and-delta path so the returned context and
 * the delta baseline stay consistent with click/type.
 *
 * @param work - the element action, already addressed through `ctx.ids`.
 * @param ctx - action context carrying the id registry and delta gate.
 * @returns the action's status line plus any permitted page delta.
 */
async function settledElementAction(work: string | Promise<string>, ctx: ActionContext): Promise<ActionResult> {
  const text = await work
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(text, ctx)
}

/** Modifier booleans a synthesized click event carries. */
interface ClickModifiers {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/** Parsed `browser_click` pointer options. */
interface ClickOptions {
  button: 'left' | 'right' | 'middle'
  count: number
  modifiers: ClickModifiers
  /** True when any option argument was supplied, which selects the synthesized path. */
  explicit: boolean
}

/** `MouseEvent.button` values for the three supported buttons. */
const CLICK_BUTTON_EVENT: Record<ClickOptions['button'], number> = { left: 0, middle: 1, right: 2 }

/** `MouseEvent.buttons` bits for the three supported buttons. */
const CLICK_BUTTON_BITS: Record<ClickOptions['button'], number> = { left: 1, middle: 4, right: 2 }

/**
 * Read the click-only `button`, `count`, and `modifiers` arguments.
 *
 * The background validates these before dispatch, but the content script also
 * refuses malformed values because it is the component that synthesizes the
 * events and must never guess their semantics.
 * @param args - action arguments.
 * @returns the parsed options.
 */
function clickOptions(args: Record<string, unknown>): ClickOptions {
  const rawButton = args.button === undefined ? 'left' : args.button
  if (rawButton !== 'left' && rawButton !== 'right' && rawButton !== 'middle') {
    throw new ActionError('bad-args', 'button must be "left", "right", or "middle".')
  }
  const count = args.count === undefined ? 1 : args.count
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 3) {
    throw new ActionError('bad-args', 'count must be an integer from 1 to 3.')
  }
  const modifiers = parseClickModifiers(args.modifiers)
  if (modifiers === undefined) {
    throw new ActionError('bad-args', 'modifiers contains an unknown key; use alt, ctrl, meta, or shift, joined by "+".')
  }
  return {
    button: rawButton,
    count,
    modifiers,
    explicit: args.button !== undefined || args.count !== undefined || args.modifiers !== undefined,
  }
}

/**
 * Map a modifier spec such as `ctrl+shift` onto event boolean flags.
 * @param value - the `modifiers` argument, when supplied.
 * @returns the flags, or undefined when a key is unknown.
 */
function parseClickModifiers(value: unknown): ClickModifiers | undefined {
  const flags: ClickModifiers = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
  if (value === undefined) return flags
  if (typeof value !== 'string') return undefined
  for (const name of value.split(/[+,]/).map((part) => part.trim().toLowerCase())) {
    if (name === '') continue
    if (name === 'alt') flags.altKey = true
    else if (name === 'ctrl' || name === 'control') flags.ctrlKey = true
    else if (name === 'meta' || name === 'cmd' || name === 'command' || name === 'win') flags.metaKey = true
    else if (name === 'shift') flags.shiftKey = true
    else return undefined
  }
  return flags
}

/** Build a pointer event, falling back to `MouseEvent` where `PointerEvent` is absent. */
function syntheticPointerEvent(type: string, init: MouseEventInit): MouseEvent {
  if (typeof PointerEvent === 'function') {
    return new PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true })
  }
  return new MouseEvent(type, init)
}

/**
 * Synthesize the DOM events a real pointer would produce for one click.
 *
 * The page observes the requested button, click count (`detail`), and modifier
 * booleans; a right click additionally gets `contextmenu`, and middle/right
 * clicks get `auxclick` instead of the primary-button `click`. Synthetic
 * events cannot trigger browser-level defaults such as navigation or a real
 * context menu, which the caller reports.
 * @param el - click target.
 * @param options - button, count, and modifiers.
 */
function synthesizeClick(el: Element, options: ClickOptions): void {
  const rect = el.getBoundingClientRect()
  const clientX = Math.round(rect.left + rect.width / 2)
  const clientY = Math.round(rect.top + rect.height / 2)
  if (el instanceof HTMLElement) {
    try { el.focus({ preventScroll: true }) } catch { /* non-focusable targets are valid */ }
  }
  const buttons = CLICK_BUTTON_BITS[options.button]
  const base: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX,
    clientY,
    screenX: clientX,
    screenY: clientY,
    button: CLICK_BUTTON_EVENT[options.button],
    ...options.modifiers,
  }
  for (let detail = 1; detail <= options.count; detail += 1) {
    const pressed: MouseEventInit = { ...base, buttons, detail }
    const released: MouseEventInit = { ...base, buttons: 0, detail }
    el.dispatchEvent(syntheticPointerEvent('pointerdown', pressed))
    el.dispatchEvent(new MouseEvent('mousedown', pressed))
    el.dispatchEvent(syntheticPointerEvent('pointerup', released))
    el.dispatchEvent(new MouseEvent('mouseup', released))
    if (options.button === 'right') el.dispatchEvent(new MouseEvent('contextmenu', released))
    el.dispatchEvent(new MouseEvent(options.button === 'left' ? 'click' : 'auxclick', released))
  }
}

/** A model-facing description of the synthesized click semantics. */
function describeClick(options: ClickOptions): string {
  const modifierNames = Object.entries(options.modifiers)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name.replace('Key', ''))
  const clicks = `${options.count} click${options.count === 1 ? '' : 's'}`
  const modifiers = modifierNames.length === 0 ? '' : `, modifiers: ${modifierNames.join('+')}`
  return `${options.button}-button events (${clicks}${modifiers})`
}

async function clickAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const index = numberArg(args, 'index')
  const options = clickOptions(args)
  const el = elementOrThrow(ctx.ids, index)
  el.scrollIntoView({ block: 'center', behavior: 'instant' })
  if (options.explicit) {
    if (el instanceof HTMLButtonElement && el.disabled) {
      throw new ActionError('action-failed', `Button [${index}] is disabled.`)
    }
    synthesizeClick(el, options)
    await waitForPageSettled(ACTION_SETTLE)
    return withPageDelta(
      `Clicked [${index}] with synthesized ${describeClick(options)}. Browser-level defaults such as navigation and real context menus are not triggered by synthetic events.`,
      ctx,
    )
  }
  if (el instanceof HTMLAnchorElement) {
    const target = el.target.trim().toLowerCase()
    const sameFrameTarget = target === '' || target === '_self'
    let href: URL | undefined
    try { href = new URL(el.href) } catch { /* let the native click handle unusual links */ }
    const controlledNavigation = sameFrameTarget
      && !el.hasAttribute('download')
      && (href?.protocol === 'http:' || href?.protocol === 'https:')
    if (controlledNavigation && href !== undefined) {
      // Manual location assignment cannot preserve browser-managed link
      // semantics such as referrer suppression, hyperlink auditing, or
      // attribution registration. Keep native activation for those links,
      // but do not claim a replacement document is guaranteed: an SPA may
      // still cancel the click and remain in this document.
      const hasReferrerPolicy = typeof el.referrerPolicy === 'string' && el.referrerPolicy !== ''
      const requiresNativeActivation = el.relList.contains('noreferrer')
        || hasReferrerPolicy
        || el.hasAttribute('ping')
        || el.hasAttribute('attributionsrc')
      if (requiresNativeActivation) {
        setTimeout(() => { el.click() }, 0)
        return {
          text: `Clicked link [${index}] using native browser activation. Call browser_snapshot to read the resulting state.`,
        }
      }
      // Dispatch the click handlers without its default navigation so a
      // client-side router can cancel synchronously and keep this document.
      const shouldNavigate = el.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
      }))
      if (!shouldNavigate) {
        await waitForPageSettled(ACTION_SETTLE)
        return withPageDelta(`Clicked link [${index}].`, ctx)
      }
      const sameDocument = href.origin === location.origin
        && href.pathname === location.pathname
        && href.search === location.search
      if (sameDocument) {
        if (href.hash !== location.hash) location.hash = href.hash
        await waitForPageSettled(ACTION_SETTLE)
        return withPageDelta(`Clicked link [${index}].`, ctx)
      }
      // A cross-document navigation can unload this content script before an
      // awaited response. Answer first and navigate in the next task.
      setTimeout(() => { location.href = href.href }, 0)
      return {
        text: `Clicked link [${index}]. Call browser_snapshot again after navigation settles.`,
        navigationPending: true,
      }
    }
    setTimeout(() => { el.click() }, 0)
    return { text: `Clicked link [${index}]. The link may open outside the controlled frame.` }
  }
  if (el instanceof HTMLButtonElement && el.disabled) {
    throw new ActionError('action-failed', `Button [${index}] is disabled.`)
  }
  ;(el as HTMLElement).click()
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Clicked [${index}].`, ctx)
}

/**
 * The nearest editable host, or null when a `contenteditable="false"` island
 * blocks editing.
 *
 * The walk must stop at the nearest `[contenteditable]` boundary instead of
 * skipping disabled ones: an element inside a non-editable island nested in an
 * editable composer belongs to the island, and resolving past it would type
 * into the surrounding composer rather than refusing the target.
 *
 * @param el - element addressed by the action.
 * @returns the owning editable host, or null when editing is blocked.
 */
function editingHost(el: HTMLElement): HTMLElement | null {
  const boundary = el.closest('[contenteditable]')
  if (!(boundary instanceof HTMLElement)) return null
  return boundary.getAttribute('contenteditable') === 'false' ? null : boundary
}

/**
 * Whether the element can receive rich-text input.
 *
 * `isContentEditable` is the browser's own answer; the boundary walk covers the
 * attribute case, which is unimplemented in jsdom, where these tests run.
 *
 * @param el - element addressed by the action.
 * @returns true when the element can receive rich-text input.
 */
function isEditable(el: Element): el is HTMLElement {
  return el instanceof HTMLElement && (el.isContentEditable || editingHost(el) !== null)
}

/**
 * Insert text into a rich-text host through the browser's editing pipeline.
 *
 * Editors such as Lexical, Draft.js and ProseMirror keep their own document
 * model and reconcile away foreign DOM writes, so assigning `textContent`
 * silently reverts and the caller's success report becomes a lie.
 * `execCommand('insertText')` is deprecated but remains the only path that
 * produces the `beforeinput`/`input` sequence those editors listen for. Hosts
 * without it keep the direct-write fallback.
 *
 * @param el - element addressed by the action.
 * @param text - text to insert.
 * @param replace - whether to replace the host's current contents.
 */
function typeIntoContentEditable(el: HTMLElement, text: string, replace: boolean): void {
  // `isEditable` already refused a disabled island, so a null host here means
  // the element is editable without the attribute; address it directly.
  const host = editingHost(el) ?? el
  host.focus()
  const selection = host.ownerDocument.getSelection()
  if (selection !== null) {
    const range = host.ownerDocument.createRange()
    range.selectNodeContents(host)
    // A caret collapsed to the end appends; a full selection is replaced by insertText.
    if (!replace) range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  const doc = host.ownerDocument
  if (typeof doc.execCommand === 'function') {
    try {
      if (doc.execCommand('insertText', false, text)) return
    } catch {
      // Fall through to the direct-write path below.
    }
  }
  if (replace) host.textContent = ''
  host.textContent = `${host.textContent ?? ''}${text}`
  host.dispatchEvent(new Event('input', { bubbles: true }))
}

async function typeAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const index = numberArg(args, 'index')
  const text = typeof args.text === 'string' ? args.text : ''
  if (text === '') throw new ActionError('bad-args', 'text must not be empty.')
  const replace = args.replace === true
  const el = elementOrThrow(ctx.ids, index)
  if (isEditable(el)) {
    typeIntoContentEditable(el, text, replace)
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (replace) setNativeValue(el, '')
    setNativeValue(el, `${el.value}${text}`)
  } else {
    throw new ActionError('action-failed', `Element [${index}] is not editable (${el.tagName.toLowerCase()}).`)
  }
  await waitForPageSettled(TYPE_SETTLE)
  return withPageDelta(`Entered ${text.length} characters into [${index}].`, ctx)
}

async function pressAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const key = typeof args.key === 'string' && args.key !== '' ? args.key : ''
  if (key === '') throw new ActionError('bad-args', 'key must not be empty.')
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
  if (key === 'Enter' && target instanceof HTMLInputElement && target.form !== null) {
    target.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Sent key "${key}".`, ctx)
}

async function scrollAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const direction = typeof args.direction === 'string' ? args.direction : ''
  const amount = typeof args.amount === 'number' ? args.amount : Math.floor(window.innerHeight * 0.8)
  switch (direction) {
    case 'top':
      window.scrollTo({ top: 0, behavior: 'instant' })
      break
    case 'bottom':
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })
      break
    case 'up':
      window.scrollBy({ top: -amount, behavior: 'instant' })
      break
    case 'down':
      window.scrollBy({ top: amount, behavior: 'instant' })
      break
    default:
      throw new ActionError('bad-args', `direction must be up, down, top, or bottom; received "${direction}".`)
  }
  await waitForPageSettled(SCROLL_SETTLE)
  return withPageDelta(`Scrolled ${direction}.`, ctx)
}

async function navigateAction(args: Record<string, unknown>): Promise<ActionResult> {
  const url = typeof args.url === 'string' && args.url !== '' ? args.url : ''
  if (url === '') throw new ActionError('bad-args', 'url must not be empty.')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ActionError('bad-args', `url is not valid: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ActionError('bad-args', `Only http and https URLs are supported; received ${parsed.protocol}.`)
  }
  resetDeltaState()
  // Cross-document navigation unloads this content script and destroys the
  // tabs.sendMessage response port before any await settles — so answer
  // FIRST, then navigate in a fresh task. The model re-snapshots after load.
  setTimeout(() => { location.href = parsed.href }, 0)
  return {
    text: `Navigating to ${parsed.href}. Call browser_snapshot again after the page loads.`,
    navigationPending: true,
  }
}

async function historyAction(delta: 1 | -1): Promise<ActionResult> {
  resetDeltaState()
  // 同 navigate：先响应再导航（文档卸载会销毁响应端口）。
  setTimeout(() => { if (delta === -1) history.back(); else history.forward() }, 0)
  return {
    text: 'Navigating through browser history. Call browser_snapshot again after the page loads.',
    navigationPending: true,
  }
}

function reloadAction(): ActionResult {
  resetDeltaState()
  setTimeout(() => { location.reload() }, 0)
  return {
    text: 'The page is reloading. Call browser_snapshot again after it loads.',
    navigationPending: true,
  }
}

async function getTextAction(args: Record<string, unknown>): Promise<ActionResult> {
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
  const source = selector !== undefined ? document.querySelector(selector) : null
  const text = source !== null ? pageText(source) : selector !== undefined ? `No element matched selector: ${selector}` : pageText()
  const truncated = truncate(text, 8_000)
  return { text: truncated.text + (truncated.truncated > 0 ? `\n(Truncated ${truncated.truncated} characters.)` : '') }
}

async function waitAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const ms = typeof args.ms === 'number' && args.ms > 0 ? args.ms : 0
  await waitForPageSettled(EXPLICIT_WAIT_SETTLE)
  if (ms > 0) await sleep(ms)
  return withPageDelta(`The page is stable${ms > 0 ? ` after an additional ${ms}ms wait` : ''}.`, ctx)
}


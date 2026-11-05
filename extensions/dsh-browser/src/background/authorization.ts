/** Pure authorization policy for model-requested browser tools. */

import type { ToolCall } from './tools.ts'
import type { TabFrame } from './frames.ts'
import type { ApprovalPrompt } from '../security/approval.ts'
import { getUiLocale, type UiLocale } from '../i18n.ts'

/**
 * Tools whose answer contains page content.
 *
 * The privacy setting and the approval prompt both read this one set, so a
 * read tool added here is blocked when sharing is off without updating two
 * hand-maintained lists.
 */
export const PAGE_READS = new Set([
  'browser_snapshot',
  'browser_get_text',
  'browser_find',
  'browser_console',
  'browser_network',
  'browser_evaluate',
  // A screenshot returns page pixels; it belongs to the same read boundary as
  // the textual readers even though the contract lists only the four tools.
  'browser_screenshot',
  // A printed PDF is the same page content in another container.
  'browser_pdf',
])
const STATE_CHANGING_ACTIONS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_navigate',
  'browser_open_tab',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_upload_file',
  'browser_select',
  'browser_drag',
  'browser_evaluate',
  'browser_resize',
  'browser_viewport',
])

/** A prompt that crosses from the page's origin to a different one. */
export interface CrossOriginPrompt extends ApprovalPrompt {
  /** True when the page origin and the operation's target origin differ. */
  crossOrigin: true
  /** Origin the user is looking at now, when the page exposes one. */
  fromOrigin: string
  /** Origin the operation moves to. */
  toOrigin: string
}

/**
 * Whether a prompt migrates the controlled page to another origin.
 *
 * Cross-origin work always asks, once, for this one operation: the persistent
 * allowlist may cover same-origin actions, but it must never silently move a
 * page across origins.
 * @param prompt - the prompt a tool call produced.
 * @returns true when the prompt is a cross-origin migration.
 */
export function isCrossOriginPrompt(prompt: ApprovalPrompt): prompt is CrossOriginPrompt {
  return (prompt as Partial<CrossOriginPrompt>).crossOrigin === true
}

/** Return an approval prompt, or undefined when this call needs no prompt. */
export function approvalPromptForCall(
  call: ToolCall,
  sharePageContent: 'ask' | 'auto' | 'off',
  frames: TabFrame[],
  locale: UiLocale = getUiLocale(),
): ApprovalPrompt | undefined {
  // A tool that both reads and changes the page (browser_evaluate) is approved
  // for its state-changing effect first: the read prompt grants no write
  // trust, so it must never be the prompt that covers a mutation.
  if (!STATE_CHANGING_ACTIONS.has(call.name)) {
    // A page-read prompt is only needed while sharing is not automatic.
    if (PAGE_READS.has(call.name) && sharePageContent === 'ask') {
      const targetFrames = call.name === 'browser_snapshot'
        ? frames
        : frames.filter((frame) => frame.frameId === requestedFrame(call.args))
      return {
        kind: 'read',
        action: call.name,
        summary: readSummary(call, locale),
        origins: uniqueOrigins(targetFrames, frames),
        canTrust: false,
      }
    }
    return undefined
  }
  const pageOrigin = topPageOrigin(frames)
  if (call.name === 'browser_open_tab') {
    const destination = originFromUrl(typeof call.args.url === 'string' ? call.args.url : '')
    const crossOrigin = pageOrigin !== undefined && destination !== undefined && pageOrigin !== destination
    return {
      kind: 'action',
      action: call.name,
      summary: crossOrigin
        ? crossOriginSummary(call, pageOrigin, destination, locale)
        : summarizeAction(call, locale),
      // A new tab does not mutate the current page; only the destination matters.
      origins: destination === undefined ? [] : [destination],
      canTrust: destination !== undefined && !crossOrigin,
      ...(crossOrigin ? { crossOrigin: true as const, fromOrigin: pageOrigin, toOrigin: destination } : {}),
    }
  }
  const frameId = requestedFrame(call.args)
  const target = frames.find((frame) => frame.frameId === frameId) ?? frames.find((frame) => frame.frameId === 0)
  const origins = uniqueOrigins(target === undefined ? [] : [target], frames)
  // A window resize is browser-level, not origin-scoped, so it must never
  // expand persistent per-origin trust.
  let canTrust = origins.length === 1
    && call.name !== 'browser_back'
    && call.name !== 'browser_forward'
    && call.name !== 'browser_resize'
    && call.name !== 'browser_viewport'
  let destinationOrigin: string | undefined
  if (call.name === 'browser_navigate') {
    destinationOrigin = originFromUrl(typeof call.args.url === 'string' ? call.args.url : '')
    if (destinationOrigin !== undefined && !origins.includes(destinationOrigin)) origins.push(destinationOrigin)
    // Do not let an invalid, opaque, or cross-origin navigation become a
    // back door for adding the current page to the persistent allowlist.
    canTrust = destinationOrigin !== undefined && origins.length === 1 && origins[0] === destinationOrigin
  }
  // Only a page-level migration leaves the current origin. An action inside an
  // embedded frame operates that frame's own origin and follows the ordinary
  // per-origin rules; treating it as a migration would prompt on every click in
  // a third-party iframe and could never be satisfied by the allowlist.
  const crossOrigin = call.name === 'browser_navigate'
    && pageOrigin !== undefined
    && destinationOrigin !== undefined
    && pageOrigin !== destinationOrigin
  return {
    kind: 'action',
    action: call.name,
    summary: crossOrigin && destinationOrigin !== undefined
      ? crossOriginSummary(call, pageOrigin, destinationOrigin, locale)
      : summarizeAction(call, locale),
    origins,
    // Cross-origin/invalid navigation and unknown history destinations always
    // require a fresh decision; they must never expand trust implicitly.
    canTrust: canTrust && !crossOrigin,
    ...(crossOrigin ? { crossOrigin: true as const, fromOrigin: pageOrigin, toOrigin: destinationOrigin } : {}),
  }
}

/** Origin of the page itself (frame 0), which defines "where the user is". */
function topPageOrigin(frames: TabFrame[]): string | undefined {
  const top = frames.find((frame) => frame.frameId === 0)
  return top === undefined ? undefined : effectiveFrameOrigin(top, frames)
}

/** Host part used in the panel prompt; origins are already normalized. */
function domainOf(origin: string): string {
  try {
    return new URL(origin).hostname
  } catch {
    return origin
  }
}

/** Name both sides of a cross-origin migration inside the bounded summary. */
function crossOriginSummary(
  call: ToolCall,
  fromOrigin: string,
  toOrigin: string,
  locale: UiLocale,
): string {
  const from = domainOf(fromOrigin)
  const to = domainOf(toOrigin)
  const base = summarizeAction(call, locale)
  return localized(locale, `${base} (cross-origin ${from} → ${to})`, `${base}（跨域 ${from} → ${to}）`).slice(0, 200)
}

function requestedFrame(args: Record<string, unknown>): number {
  return typeof args.frame === 'number' && Number.isInteger(args.frame) && args.frame >= 0 ? args.frame : 0
}

function uniqueOrigins(targets: TabFrame[], allFrames: TabFrame[]): string[] {
  const origins = new Set<string>()
  for (const frame of targets) {
    const origin = effectiveFrameOrigin(frame, allFrames)
    if (origin !== undefined) origins.add(origin)
  }
  return [...origins].sort()
}

function effectiveFrameOrigin(frame: TabFrame, frames: TabFrame[], visited = new Set<number>()): string | undefined {
  if (visited.has(frame.frameId)) return undefined
  visited.add(frame.frameId)
  const direct = originFromUrl(frame.url)
  if (direct !== undefined) return direct
  const parent = frames.find((candidate) => candidate.frameId === frame.parentFrameId)
  return parent === undefined ? undefined : effectiveFrameOrigin(parent, frames, visited)
}

export function originFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'blob:') return undefined
    return url.origin === 'null' ? undefined : url.origin
  } catch {
    return undefined
  }
}

/** One-line panel summary for a page-content read. */
function readSummary(call: ToolCall, locale: UiLocale): string {
  switch (call.name) {
    case 'browser_snapshot':
      return localized(locale, 'Read the current page and accessible iframes', '读取当前页面及可访问 iframe')
    case 'browser_get_text':
      return localized(locale, 'Read text from the specified area of the current page', '读取当前页面的指定文本区域')
    case 'browser_find':
      return localized(
        locale,
        `Search the current page for elements matching “${safeInline(typeof call.args.query === 'string' ? call.args.query : '')}”`,
        `在当前页面中搜索匹配「${safeInline(typeof call.args.query === 'string' ? call.args.query : '')}」的元素`,
      )
    case 'browser_console':
      return localized(locale, 'Read captured console messages from the current tab', '读取当前标签页已捕获的控制台消息')
    case 'browser_network':
      return localized(locale, 'Read captured network requests from the current tab', '读取当前标签页已捕获的网络请求')
    case 'browser_evaluate':
      return localized(
        locale,
        'Run JavaScript in the current page (the code is not shown in this dialog)',
        '在当前页面中执行 JavaScript（代码不会显示在确认框）',
      )
    case 'browser_screenshot':
      return localized(locale, 'Capture a screenshot of the current tab', '截取当前标签页的屏幕截图')
    default:
      return call.name
  }
}

function summarizeAction(call: ToolCall, locale: UiLocale): string {
  const frame = typeof call.args.frame === 'number' && call.args.frame !== 0
    ? localized(locale, `, iframe ${call.args.frame}`, `，iframe ${call.args.frame}`)
    : ''
  const index = typeof call.args.index === 'number' ? call.args.index : '?'
  switch (call.name) {
    case 'browser_click': return localized(locale, `Click element [${index}]${frame}`, `点击元素 [${index}]${frame}`)
    case 'browser_type': {
      const length = typeof call.args.text === 'string' ? call.args.text.length : 0
      return localized(
        locale,
        `Enter ${length} characters in element [${index}]${frame} (the text is not shown in this dialog)`,
        `向元素 [${index}] 输入 ${length} 个字符${frame}（文本内容不会显示在确认框）`,
      )
    }
    case 'browser_press': return localized(
      locale,
      `Press “${safeInline(typeof call.args.key === 'string' ? call.args.key : '')}”${frame}`,
      `发送按键「${safeInline(typeof call.args.key === 'string' ? call.args.key : '')}」${frame}`,
    )
    case 'browser_navigate': return localized(
      locale,
      `Navigate to ${displayUrl(typeof call.args.url === 'string' ? call.args.url : '', locale)}`,
      `导航到 ${displayUrl(typeof call.args.url === 'string' ? call.args.url : '', locale)}`,
    )
    case 'browser_open_tab': {
      const destination = displayUrl(typeof call.args.url === 'string' ? call.args.url : '', locale)
      return call.args.active === false
        ? localized(
          locale,
          `Open a background tab at ${destination}`,
          `在后台新标签页打开 ${destination}`,
        )
        : localized(
          locale,
          `Open a new tab at ${destination}`,
          `在新标签页打开 ${destination}`,
        )
    }
    case 'browser_back': return localized(locale, 'Go back in browser history (destination domain unknown)', '返回浏览历史上一页（目标域名未知）')
    case 'browser_forward': return localized(locale, 'Go forward in browser history (destination domain unknown)', '前进到浏览历史下一页（目标域名未知）')
    case 'browser_reload': return localized(locale, 'Reload the current page', '重新加载当前页面')
    case 'browser_select': return localized(locale, `Select an option in element [${index}]${frame}`, `在元素 [${index}] 中选择选项${frame}`)
    case 'browser_hover': return typeof call.args.index === 'number'
      ? localized(locale, `Hover over element [${index}]${frame}`, `悬停在元素 [${index}] 上${frame}`)
      : localized(
        locale,
        `Hover at (${typeof call.args.x === 'number' ? call.args.x : '?'}, ${typeof call.args.y === 'number' ? call.args.y : '?'})`,
        `在坐标 (${typeof call.args.x === 'number' ? call.args.x : '?'}, ${typeof call.args.y === 'number' ? call.args.y : '?'}) 悬停`,
      )
    case 'browser_drag': {
      const fromIndex = typeof call.args.from_index === 'number' ? call.args.from_index : undefined
      const toIndex = typeof call.args.to_index === 'number' ? call.args.to_index : undefined
      const from = fromIndex === undefined ? 'a point' : `element [${fromIndex}]`
      const to = toIndex === undefined ? 'another point' : `element [${toIndex}]`
      return localized(locale, `Drag from ${from} to ${to}${frame}`, `从 ${from} 拖拽到 ${to}${frame}`)
    }
    case 'browser_upload_file': {
      const count = Array.isArray(call.args.files) ? call.args.files.length : 0
      return localized(
        locale,
        `Upload ${count} file(s) to element [${index}]${frame} (file contents are not shown in this dialog)`,
        `向元素 [${index}] 上传 ${count} 个文件${frame}（文件内容不会显示在确认框）`,
      )
    }
    case 'browser_evaluate': return localized(
      locale,
      'Run JavaScript in the current page (the code is not shown in this dialog)',
      '在当前页面中执行 JavaScript（代码不会显示在确认框）',
    )
    case 'browser_viewport': {
      if (call.args.reset === true) {
        return localized(
          locale,
          'Drop the emulated viewport on the controlled tab',
          '撤销受控标签页的模拟视口',
        )
      }
      const width = typeof call.args.width === 'number' ? Math.floor(call.args.width) : '?'
      const height = typeof call.args.height === 'number' ? Math.floor(call.args.height) : '?'
      return localized(
        locale,
        `Emulate a ${width}x${height} viewport on the controlled tab`,
        `把受控标签页模拟为 ${width}x${height} 的视口`,
      )
    }
    case 'browser_resize': return localized(
      locale,
      `Resize the browser window to ${typeof call.args.width === 'number' ? Math.floor(call.args.width) : '?'}x${typeof call.args.height === 'number' ? Math.floor(call.args.height) : '?'}`,
      `把浏览器窗口调整为 ${typeof call.args.width === 'number' ? Math.floor(call.args.width) : '?'}x${typeof call.args.height === 'number' ? Math.floor(call.args.height) : '?'}`,
    )
    default: return call.name
  }
}

function displayUrl(value: string, locale: UiLocale): string {
  try {
    const url = new URL(value)
    return safeInline(`${url.origin}${url.pathname}`, 160)
  } catch {
    return localized(locale, '(invalid URL)', '(无效 URL)')
  }
}

function localized(locale: UiLocale, english: string, chinese: string): string {
  return locale === 'zh' ? chinese : english
}

function safeInline(value: string, maxLength = 40): string {
  const inline = value.replace(/\s+/g, ' ').trim()
  return inline.length <= maxLength ? inline : `${inline.slice(0, maxLength - 1)}…`
}

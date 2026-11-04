/**
 * One-shot rendezvous between an action that unloads a frame and the content
 * script installed in its replacement document.
 *
 * @module
 */

/** Default ceiling for replacing a model-driven snapshot round trip. */
const NAVIGATION_READY_TIMEOUT_MS = 8_000

/** Browser-owned page families the extension cannot inject into or operate. */
export type RestrictedPageKind = 'chrome' | 'extension' | 'edge' | 'about' | 'devtools' | 'view-source'

/** Scheme prefix each restricted page family starts with. */
const RESTRICTED_PREFIXES: ReadonlyArray<readonly [RestrictedPageKind, string]> = [
  ['chrome', 'chrome://'],
  ['extension', 'chrome-extension://'],
  ['edge', 'edge://'],
  ['devtools', 'devtools://'],
  ['view-source', 'view-source:'],
  ['about', 'about:'],
]

/** One refusal the tool layer turns into a `protected-page` tool error. */
export interface RestrictedPageRefusal {
  code: 'protected-page'
  message: string
}

/**
 * Classify a tab URL as a browser-owned page the extension cannot assist.
 *
 * `about:blank` is the one exception: it is an empty document a frame or a new
 * tab legitimately holds, and no page content exists to protect.
 * @param url - tab URL, which Chrome may leave empty for a pending navigation.
 * @returns the restricted page family, or undefined for an assistable page.
 */
export function classifyRestrictedPage(url: string | undefined): RestrictedPageKind | undefined {
  if (url === undefined) return undefined
  const normalized = url.trim().toLowerCase()
  if (normalized === '') return undefined
  if (normalized === 'about:blank' || normalized.startsWith('about:blank?') || normalized.startsWith('about:blank#')) {
    return undefined
  }
  for (const [kind, prefix] of RESTRICTED_PREFIXES) {
    if (normalized.startsWith(prefix)) return kind
  }
  return undefined
}

/**
 * Build the one refusal every restricted page reports.
 *
 * The message names the page family and the supported escape (browser-level
 * navigation or picking another tab) so the model can recover without guessing.
 * @param kind - restricted page family from {@link classifyRestrictedPage}.
 * @returns the stable `protected-page` refusal.
 */
export function restrictedPageRefusal(kind: RestrictedPageKind): RestrictedPageRefusal {
  const label = kind === 'about' ? 'about:' : kind === 'view-source' ? 'view-source:' : `${kind}://`
  return {
    code: 'protected-page',
    message: `This page cannot be assisted here: ${label} pages are owned by the browser, so DOM snapshots, clicks, typing, scrolling, and text extraction are unavailable. Navigate to a normal HTTP(S) page, or use browser_list_tabs to choose a tab that can be assisted.`,
  }
}

/** A cancellable wait for the next content-script document in one frame. */
export interface NavigationWait {
  ready: Promise<boolean>
  cancel: () => void
}

/**
 * Listen before dispatching a navigation so a fast replacement document
 * cannot announce readiness between the action response and listener setup.
 */
export function waitForNextDocumentReady(
  tabId: number,
  frameId: number,
  previousDocumentId: string | undefined,
  signal?: AbortSignal,
  timeoutMs: number = NAVIGATION_READY_TIMEOUT_MS,
): NavigationWait {
  let finish: (ready: boolean) => void = () => {}
  const ready = new Promise<boolean>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const listener = (message: unknown, sender: chrome.runtime.MessageSender): void => {
      if (typeof message !== 'object' || message === null) return
      if ((message as { type?: unknown }).type !== 'DSH_CONTENT_READY') return
      if (sender.tab?.id !== tabId || (sender.frameId ?? 0) !== frameId) return
      if (previousDocumentId !== undefined && sender.documentId === previousDocumentId) return
      // A newly created Firefox tab can run the content script in its initial
      // about:blank document. With no baseline document id, accept only the
      // HTTP(S) destination document that browser_open_tab can navigate to.
      if (previousDocumentId === undefined
        && (typeof sender.url !== 'string' || !/^https?:\/\//i.test(sender.url))) return
      finish(true)
    }
    const onAbort = (): void => { finish(false) }
    finish = (isReady: boolean): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      chrome.runtime.onMessage.removeListener(listener)
      signal?.removeEventListener('abort', onAbort)
      resolve(isReady)
    }

    if (signal?.aborted === true) {
      finish(false)
      return
    }
    chrome.runtime.onMessage.addListener(listener)
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => { finish(false) }, timeoutMs)
  })

  return { ready, cancel: () => { finish(false) } }
}

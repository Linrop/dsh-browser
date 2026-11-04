/**
 * Frame discovery and budget allocation for one browser tab.
 *
 * Frame ids identify a frame slot and are the routing half of the model-facing
 * `(frame, index)` element address. They can survive navigation, so security
 * checks additionally bind element ids and message delivery to `documentId`.
 * Element ids remain local to each content script, so a re-render in one
 * iframe cannot invalidate otherwise-stable ids in the rest of the page.
 *
 * @module
 */

import type { ContentBudget } from './tools.ts'

/** A live document frame in one tab. Main frame id is always zero. */
export interface TabFrame {
  frameId: number
  parentFrameId: number
  documentId?: string
  url: string
  /**
   * True when the frame came from the per-document memory below rather than
   * from this discovery pass: Chrome reported the main document but omitted
   * its subframes. Such a frame is still addressable by frame id.
   */
  recovered?: boolean
}

/** Per-frame limits whose sum never exceeds the negotiated tab budget. */
export interface FrameBudget extends ContentBudget {}

const MAIN_FRAME_SHARE = 0.8
const REMEMBERED_DOCUMENTS_PER_TAB = 4
const REMEMBERED_TABS = 32

/**
 * Frames discovered for one main document, kept because
 * `chrome.webNavigation.getAllFrames` omits subframes of a document restored
 * from the back/forward cache: the main frame is listed with its original
 * `documentId`, and every child frame is missing from the returned tree while
 * its content script still answers messages addressed by frame or document id.
 * Remembering the last tree of each main document lets the snapshot recover
 * those iframes instead of silently dropping them.
 */
const rememberedFrames = new Map<number, Map<string, TabFrame[]>>()

/** Drop every remembered frame tree for a tab. */
export function forgetTabFrames(tabId: number): void {
  rememberedFrames.delete(tabId)
}

/** Drop one recovered subframe that no longer answers in its document. */
export function forgetRecoveredSubframe(tabId: number, frameId: number): void {
  const documents = rememberedFrames.get(tabId)
  if (documents === undefined) return
  for (const frames of documents.values()) {
    const index = frames.findIndex((frame) => frame.frameId === frameId)
    if (index >= 0) frames.splice(index, 1)
  }
}

/**
 * Discover all frames, falling back to the main frame when webNavigation is
 * unavailable or the tab is between navigations.
 *
 * A discovery pass that reports the main frame but no subframes for a main
 * `documentId` seen before re-adds that document's remembered subframes. They
 * keep their document id, which Chrome resubscribes when the document is
 * restored, and are marked `recovered` so the snapshot can drop them cleanly if
 * they stopped answering.
 */
export async function listTabFrames(tabId: number, mainUrl: string | undefined): Promise<TabFrame[]> {
  let discovered: TabFrame[] | undefined
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId })
    if (frames !== null && frames !== undefined && frames.length > 0) {
      discovered = normalizeDiscoveredFrames(frames)
    }
  } catch {
    // A main-frame message still gives a useful result while the frame tree is
    // unavailable during a navigation or in older test/browser environments.
  }
  if (discovered !== undefined && discovered.length > 0) {
    const mainFrame = discovered.find((frame) => frame.frameId === 0)
    if (mainFrame === undefined) return sortTabFrames(discovered)
    const frames = sortTabFrames([...discovered, ...recoveredSubframes(tabId, mainFrame, discovered)])
    rememberFrames(tabId, mainFrame.documentId ?? mainFrame.url, frames)
    return frames
  }
  return [{ frameId: 0, parentFrameId: -1, url: mainUrl ?? '' }]
}

/** Keep only addressable, deduplicated frames and normalize Chrome's fields. */
function normalizeDiscoveredFrames(discovered: chrome.webNavigation.GetAllFrameResultDetails[]): TabFrame[] {
  const frames: TabFrame[] = []
  const seen = new Set<number>()
  for (const frame of discovered) {
    const frameId = frame.frameId
    if (typeof frameId !== 'number' || !Number.isInteger(frameId) || frameId < 0) continue
    if (seen.has(frameId)) continue
    seen.add(frameId)
    frames.push({
      frameId,
      parentFrameId: typeof frame.parentFrameId === 'number'
        ? frame.parentFrameId
        : frameId === 0 ? -1 : 0,
      documentId: typeof frame.documentId === 'string' && frame.documentId !== '' ? frame.documentId : undefined,
      url: typeof frame.url === 'string' ? frame.url : '',
    })
  }
  return frames
}

/** Subframes this main document had before, minus the ones just discovered. */
function recoveredSubframes(tabId: number, mainFrame: TabFrame, discovered: TabFrame[]): TabFrame[] {
  if (mainFrame.documentId === undefined) return []
  const remembered = rememberedFrames.get(tabId)?.get(mainFrame.documentId)
  if (remembered === undefined) return []
  const discoveredIds = new Set(discovered.map((frame) => frame.frameId))
  return remembered
    .filter((frame) => frame.frameId !== 0 && !discoveredIds.has(frame.frameId))
    .map((frame) => ({ ...frame, recovered: true }))
}

/** Remember one document's frame tree with a bound on tabs and documents. */
function rememberFrames(tabId: number, documentKey: string, frames: TabFrame[]): void {
  let documents = rememberedFrames.get(tabId)
  if (documents === undefined) {
    documents = new Map()
    rememberedFrames.set(tabId, documents)
    while (rememberedFrames.size > REMEMBERED_TABS) {
      const oldest = rememberedFrames.keys().next().value
      if (oldest === undefined) break
      rememberedFrames.delete(oldest)
    }
  }
  documents.delete(documentKey)
  documents.set(documentKey, frames.map((frame) => ({ ...frame })))
  while (documents.size > REMEMBERED_DOCUMENTS_PER_TAB) {
    const oldest = documents.keys().next().value
    if (oldest === undefined) break
    documents.delete(oldest)
  }
}

/** Sort parents before descendants without rebuilding the frame graph per comparison. */
export function sortTabFrames(frames: TabFrame[]): TabFrame[] {
  const parents = new Map(frames.map((frame) => [frame.frameId, frame.parentFrameId]))
  const depths = new Map<number, number>()
  for (const frame of frames) depths.set(frame.frameId, frameDepth(frame.frameId, parents))
  return [...frames].sort((a, b) => depths.get(a.frameId)! - depths.get(b.frameId)! || a.frameId - b.frameId)
}

function frameDepth(frameId: number, parents: Map<number, number>): number {
  const visited = new Set<number>()
  let depth = 0
  let parent = parents.get(frameId) ?? -1
  while (parent !== -1 && !visited.has(parent)) {
    visited.add(parent)
    depth += 1
    parent = parents.get(parent) ?? -1
  }
  return depth
}

/** Give the main document 80% of the budget and divide the exact remainder. */
export function allocateFrameBudgets(frames: TabFrame[], budget: ContentBudget): Map<number, FrameBudget> {
  if (frames.length <= 1) return new Map([[frames[0]?.frameId ?? 0, { ...budget }]])

  const mainFrame = frames.find((frame) => frame.frameId === 0) ?? frames[0]!
  const childFrames = frames.filter((frame) => frame !== mainFrame)
  const childIndex = new Map(childFrames.map((frame, index) => [frame.frameId, index]))
  const chars = allocateDimension(budget.maxChars, childFrames.length)
  const items = allocateDimension(budget.maxItems, childFrames.length)

  return new Map(frames.map((frame) => [
    frame.frameId,
    frame === mainFrame
      ? { maxChars: chars.main, maxItems: items.main }
      : {
          maxChars: chars.children[childIndex.get(frame.frameId)!]!,
          maxItems: items.children[childIndex.get(frame.frameId)!]!,
        },
  ]))
}

function allocateDimension(total: number, childCount: number): { main: number; children: number[] } {
  const boundedTotal = Math.max(0, Math.floor(total))
  const main = Math.min(boundedTotal, Math.max(1, Math.floor(boundedTotal * MAIN_FRAME_SHARE)))
  const remaining = boundedTotal - main
  const perChild = Math.floor(remaining / childCount)
  const remainder = remaining % childCount
  return {
    main,
    children: Array.from({ length: childCount }, (_, index) => perChild + (index < remainder ? 1 : 0)),
  }
}

/** A stable key for detecting frame navigation between delta snapshots. */
export function frameDocumentKey(frame: TabFrame): string {
  return frame.documentId ?? frame.url
}

/** Human-readable origin label; unsupported/opaque URLs stay visibly distinct. */
export function frameOrigin(frame: TabFrame): string {
  try {
    return new URL(frame.url).origin
  } catch {
    return frame.url === '' ? '(unknown)' : frame.url
  }
}

// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import type { ElementIds } from '../src/content/ids.ts'
import { dispatchToolCall, type TabManagementContext, type ToolCall } from '../src/background/tools.ts'
import { handleDebuggerEvent } from '../src/background/cdp.ts'

/**
 * Cross-package wire contract.
 *
 * The host plugin and this extension both read `contract/wire-fixtures.json`,
 * so renaming a request field on one side alone fails a gate instead of
 * silently degrading at runtime.
 */

interface UploadFileWire {
  name: string
  mime_type: string
  base64: string
}

interface WireFixtures {
  uploadRequest: { index: number; files: UploadFileWire[] }
  consoleRequest: { only_errors: boolean; clear: boolean; pattern: string; limit: number }
  networkRequest: { url_pattern: string; clear: boolean; limit: number }
}

// jsdom replaces global URL, which node:fs will not accept as a file URL, so
// resolve the fixture path from the test file's own path string.
const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(
  readFileSync(resolve(TEST_DIR, '../../../contract/wire-fixtures.json'), 'utf8'),
) as WireFixtures

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 2_000 }

/** jsdom has no DataTransfer, and `input.files` is read-only. */
class FakeDataTransfer {
  private readonly collected: File[] = []

  readonly items = {
    add: (file: File): void => {
      this.collected.push(file)
    },
  }

  get files(): File[] {
    return this.collected
  }
}

function fileInput(): HTMLInputElement {
  document.body.innerHTML = '<input id="upload" type="file">'
  const input = document.querySelector('#upload') as HTMLInputElement
  let assigned: unknown
  Object.defineProperty(input, 'files', {
    configurable: true,
    get: () => assigned,
    set: (value: unknown) => { assigned = value },
  })
  return input
}

const UNRESTRICTED: TabManagementContext = { unrestrictedAccess: true }

let tabSequence = 500

function nextTabId(): number {
  tabSequence += 1
  return tabSequence
}

/** Minimal chrome stand-in whose debugger accepts every command. */
function mockChrome(): { tabId: number } {
  const tabId = nextTabId()
  const tab = {
    id: tabId,
    windowId: 2,
    index: 0,
    active: true,
    highlighted: false,
    pinned: false,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    url: 'https://example.com/',
    title: 'Example',
  } as chrome.tabs.Tab
  const frames = [{ frameId: 0, parentFrameId: -1, documentId: `doc-${tabId}`, url: tab.url ?? '' }]
  vi.stubGlobal('chrome', {
    debugger: {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({})),
      onDetach: { addListener: () => undefined },
      onEvent: { addListener: () => undefined },
    },
    tabs: {
      query: vi.fn(async () => [tab]),
      get: vi.fn(async (id: number) => (id === tab.id ? tab : (() => { throw new Error(`No tab with id: ${id}`) })())),
      sendMessage: vi.fn(async () => { throw new Error('Could not establish connection. Receiving end does not exist.') }),
      captureVisibleTab: vi.fn(async () => 'data:image/jpeg;base64,QUJD'),
    },
    webNavigation: { getAllFrames: vi.fn(async () => frames) },
    scripting: { executeScript: vi.fn(async () => [{ frameId: 0, result: undefined }]) },
    windows: { update: vi.fn(async () => undefined) },
    runtime: { id: 'test-extension' },
  })
  return { tabId }
}

function call(name: string, args: Record<string, unknown>, id = name): ToolCall {
  return { id, name, args }
}

function textOf(answer: { result?: unknown }): string {
  return (answer.result as { text?: string } | undefined)?.text ?? ''
}

async function dispatch(call_: ToolCall): Promise<{ ok: boolean; result?: unknown; error?: unknown }> {
  return dispatchToolCall(call_, 'auto', undefined, undefined, undefined, undefined, undefined, UNRESTRICTED)
}

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(globalThis, 'DataTransfer')
  document.body.innerHTML = ''
})

describe('uploadRequest wire form', () => {
  it('parses the fixture files into name, mime type, and bytes', async () => {
    Object.defineProperty(globalThis, 'DataTransfer', { configurable: true, writable: true, value: FakeDataTransfer })
    const input = fileInput()
    const result = await runAction('browser_upload_file', {
      index: fixtures.uploadRequest.index,
      files: fixtures.uploadRequest.files,
    }, { ids: { elementByIndex: vi.fn(() => input) } as unknown as ElementIds, budget: BUDGET })

    const wireFile = fixtures.uploadRequest.files[0]!
    const files = [...input.files!]
    expect(files).toHaveLength(1)
    expect(files[0]!.name).toBe(wireFile.name)
    // `mime_type` is the wire key; a rename to `mimeType` must fail here.
    expect(files[0]!.type).toBe(wireFile.mime_type)
    expect(files[0]!.size).toBe(atob(wireFile.base64).length)
    expect(result.text).toContain(wireFile.name)
  })
})

describe('consoleRequest wire form', () => {
  it('honors only_errors, pattern, and limit from the fixture keys', async () => {
    const { tabId } = mockChrome()
    handleDebuggerEvent(tabId, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'plain note' }], timestamp: 1 })
    handleDebuggerEvent(tabId, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'error one' }], timestamp: 2 })
    handleDebuggerEvent(tabId, 'Runtime.consoleAPICalled', { type: 'warn', args: [{ value: 'error two' }], timestamp: 3 })

    const answer = await dispatch(call('browser_console', fixtures.consoleRequest))
    expect(answer.ok).toBe(true)
    const text = textOf(answer)
    expect(text).toContain('error one')
    expect(text).toContain('error two')
    expect(text).not.toContain('plain note')

    const onlyErrors = await dispatch(call('browser_console', { ...fixtures.consoleRequest, only_errors: true }))
    expect(textOf(onlyErrors)).toContain('error one')
    expect(textOf(onlyErrors)).not.toContain('error two')

    const limited = await dispatch(call('browser_console', { ...fixtures.consoleRequest, limit: 1 }))
    expect(textOf(limited)).not.toContain('error one')
    expect(textOf(limited)).toContain('error two')
  })

  it('keeps the buffer when clear is false and discards it when true', async () => {
    const { tabId } = mockChrome()
    handleDebuggerEvent(tabId, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'error kept until clear' }], timestamp: 1 })

    const read = await dispatch(call('browser_console', fixtures.consoleRequest))
    expect(read.ok).toBe(true)
    expect(textOf(read)).toContain('error kept until clear')

    const cleared = await dispatch(call('browser_console', { ...fixtures.consoleRequest, clear: true }))
    expect(textOf(cleared)).toContain('error kept until clear')
    expect(textOf(cleared)).toContain('returned 1 of 1 matching, then cleared all 1 buffered message(s)')

    const after = await dispatch(call('browser_console', fixtures.consoleRequest))
    expect(textOf(after)).toContain('No console messages found')
  })
})

describe('networkRequest wire form', () => {
  it('honors url_pattern, clear, and limit from the fixture keys', async () => {
    const { tabId } = mockChrome()
    for (const [index, url] of ['https://example.com/api/one', 'https://example.com/api/two', 'https://example.com/page'].entries()) {
      handleDebuggerEvent(tabId, 'Network.requestWillBeSent', {
        requestId: `r${index}`,
        request: { url, method: 'GET' },
        timestamp: index,
      })
    }

    const answer = await dispatch(call('browser_network', fixtures.networkRequest))
    expect(answer.ok).toBe(true)
    const text = textOf(answer)
    expect(text).toContain('https://example.com/api/one')
    expect(text).toContain('https://example.com/api/two')
    expect(text).not.toContain('https://example.com/page')

    const limited = await dispatch(call('browser_network', { ...fixtures.networkRequest, limit: 1 }))
    expect(textOf(limited)).not.toContain('https://example.com/api/one')
    expect(textOf(limited)).toContain('https://example.com/api/two')

    const cleared = await dispatch(call('browser_network', { ...fixtures.networkRequest, clear: true }))
    expect(textOf(cleared)).toContain('https://example.com/api/')
    expect(textOf(cleared)).toContain('returned 2 of 2 matching, then cleared all 3 buffered request(s)')

    const after = await dispatch(call('browser_network', fixtures.networkRequest))
    expect(textOf(after)).toContain('No network requests found')
  })
})

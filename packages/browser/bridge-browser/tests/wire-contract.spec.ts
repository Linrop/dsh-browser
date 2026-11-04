import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BridgeServer } from '../src/server.ts'
import { registerBrowserTools, type BrowserToolsOptions } from '../src/tools.ts'

/**
 * Cross-package wire contract.
 *
 * `contract/wire-fixtures.json` at the repository root is the single source of
 * truth for the payloads this host plugin and the Chrome extension exchange.
 * Both packages assert against it, so a one-sided rename of a wire key fails a
 * test instead of degrading silently at runtime.
 */
const FIXTURE_URL = new URL('../../../../contract/wire-fixtures.json', import.meta.url)

interface UploadFixture {
  index: number
  frame: number
  files: { name: string; mime_type: string; base64: string }[]
}

interface ScreenshotFixture {
  text: string
  image: { base64: string; mimeType: string; width: number; height: number }
  frame: {
    viewportWidth: number
    viewportHeight: number
    screenshotWidth: number
    screenshotHeight: number
    dpr: number
  }
}

interface WireFixtures {
  uploadRequest: UploadFixture
  uploadResult: { text: string }
  screenshotResult: ScreenshotFixture
}

const OPTIONS: BrowserToolsOptions = {
  toolTimeoutMs: 1_000,
  snapshotMaxChars: 12_000,
  maxInteractiveItems: 60,
  screenshotRoot: '',
  artifactBoundary: '',
}

type Run = (args: unknown, exec: { signal: AbortSignal; agent?: unknown }) => Promise<{ text: string }>

function executable(definition: Record<string, unknown>): Run {
  return definition.execute as Run
}

function makeHarness() {
  const registered: { name: string; definition: Record<string, unknown> }[] = []
  const ctx = {
    tools: {
      register: vi.fn((definition: { name: string }) => {
        registered.push({ name: definition.name, definition: definition as Record<string, unknown> })
        return () => {}
      }),
    },
  } as unknown as Context
  const requestTool = vi.fn(async (
    _name: string,
    _args: Record<string, unknown>,
    _signal: AbortSignal,
    _timeoutMs?: number,
  ): Promise<unknown> => ({ text: 'ok' }))
  const bridge = { requestTool } as unknown as BridgeServer
  return { ctx, bridge, requestTool, registered }
}

async function loadFixtures(): Promise<WireFixtures> {
  const raw = await readFile(FIXTURE_URL, 'utf8')
  return JSON.parse(raw) as WireFixtures
}

describe('wire fixtures', () => {
  it('sends upload files with the keys and payload the fixture records', async () => {
    const fixtures = await loadFixtures()
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, OPTIONS)
    const tool = registered.find((r) => r.name === 'browser_upload_file')!
    const exec = { signal: new AbortController().signal }

    await executable(tool.definition)(
      {
        index: fixtures.uploadRequest.index,
        frame: fixtures.uploadRequest.frame,
        files: fixtures.uploadRequest.files,
      },
      exec,
    )

    expect(requestTool).toHaveBeenLastCalledWith(
      'browser_upload_file',
      fixtures.uploadRequest,
      exec.signal,
      1_000,
    )
    const sent = requestTool.mock.calls.at(-1)?.[1] as { files: Record<string, unknown>[] }
    for (const file of sent.files) {
      // Exact key names: the extension reads `mime_type`, never `mimeType`.
      expect(Object.keys(file).sort()).toEqual(['base64', 'mime_type', 'name'])
    }
  })

  it('normalizes the fixture upload result text without rewriting it', async () => {
    const fixtures = await loadFixtures()
    const { ctx, bridge, requestTool, registered } = makeHarness()
    requestTool.mockResolvedValueOnce(fixtures.uploadResult)
    registerBrowserTools(ctx, bridge, OPTIONS)
    const tool = registered.find((r) => r.name === 'browser_upload_file')!
    const exec = { signal: new AbortController().signal }

    const result = await executable(tool.definition)(
      {
        index: fixtures.uploadRequest.index,
        frame: fixtures.uploadRequest.frame,
        files: fixtures.uploadRequest.files,
      },
      exec,
    )

    expect(result.text).toBe(fixtures.uploadResult.text)
    // The fixture records what the extension actually emits for this payload.
    expect(fixtures.uploadResult.text)
      .toBe('Uploaded 1 file(s) to file input [4]: notes.txt (0.0 KB total).')
  })

  it('passes the fixture screenshot text through unchanged when save=false', async () => {
    const fixtures = await loadFixtures()
    const root = await mkdtemp(path.join(tmpdir(), 'bridge-wire-no-save-'))
    try {
      const { ctx, bridge, requestTool, registered } = makeHarness()
      // The extension owns this text; with save=false the host must return it
      // verbatim instead of substituting its own wording, and must not write
      // the fixture's image bytes.
      requestTool.mockResolvedValueOnce(fixtures.screenshotResult)
      registerBrowserTools(ctx, bridge, { ...OPTIONS, screenshotRoot: root, artifactBoundary: root })
      const tool = registered.find((r) => r.name === 'browser_screenshot')!
      const exec = { signal: new AbortController().signal }

      const result = await executable(tool.definition)({ save: false }, exec)

      expect(result.text).toBe(fixtures.screenshotResult.text)
      expect(result.text).toContain('800x600 px, jpeg')
      // The fixture text is the extension's shape, not the host's wording.
      expect(fixtures.screenshotResult.text)
        .toBe('Screenshot captured (800x600 px, jpeg). Viewport: 800x600 CSS px (dpr 2).')
      expect(await readdir(path.join(root, 'screenshots')).catch(() => undefined)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails loudly when save=true returns an image without base64', async () => {
    const fixtures = await loadFixtures()
    const root = await mkdtemp(path.join(tmpdir(), 'bridge-wire-missing-bytes-'))
    try {
      const { ctx, bridge, requestTool, registered } = makeHarness()
      requestTool.mockResolvedValueOnce({
        text: fixtures.screenshotResult.text,
        image: {
          mimeType: fixtures.screenshotResult.image.mimeType,
          width: fixtures.screenshotResult.image.width,
          height: fixtures.screenshotResult.image.height,
        },
        frame: fixtures.screenshotResult.frame,
      })
      registerBrowserTools(ctx, bridge, { ...OPTIONS, screenshotRoot: root, artifactBoundary: root })
      const tool = registered.find((r) => r.name === 'browser_screenshot')!
      const exec = { signal: new AbortController().signal }

      await expect(executable(tool.definition)({}, exec))
        .rejects.toThrow(/browser_screenshot returned no image: Screenshot captured/)
      expect(await readdir(path.join(root, 'screenshots')).catch(() => undefined)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('parses the fixture screenshot result, including image and frame, into the artifact directory', async () => {
    const fixtures = await loadFixtures()
    const root = await mkdtemp(path.join(tmpdir(), 'bridge-wire-contract-'))
    try {
      const resolvedRoot = await realpath(root)
      const { ctx, bridge, requestTool, registered } = makeHarness()
      requestTool.mockResolvedValueOnce(fixtures.screenshotResult)
      registerBrowserTools(ctx, bridge, { ...OPTIONS, screenshotRoot: root, artifactBoundary: root })
      const tool = registered.find((r) => r.name === 'browser_screenshot')!
      const exec = { signal: new AbortController().signal }

      const result = await executable(tool.definition)({}, exec)

      const directory = path.join(resolvedRoot, 'screenshots')
      const head = /^Screenshot saved: (.+) \(800x600 px, jpg\)$/.exec(result.text.split('\n')[0]!)
      expect(head).not.toBeNull()
      const saved = head![1]!
      // The fixture's image block and frame block are both recognized.
      expect(saved.startsWith(`${directory}${path.sep}shot-`)).toBe(true)
      expect(saved).toMatch(/shot-\d+-[0-9a-f]{6}\.jpg$/)
      expect(result.text).toContain('Viewport: 800x600 CSS px (dpr 2).')
      expect(await readFile(saved)).toEqual(Buffer.from(fixtures.screenshotResult.image.base64, 'base64'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

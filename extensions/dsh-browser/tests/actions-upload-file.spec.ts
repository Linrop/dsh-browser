// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import type { ElementIds } from '../src/content/ids.ts'

/**
 * `browser_upload_file` decodes the host's base64 entries into `File` objects,
 * attaches them through a `DataTransfer`, and announces the change.
 */

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 2_000 }

// jsdom has no DataTransfer, and its `input.files` is read-only. This fake
// supplies the constructor and lets the input accept the resulting list.
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

function idsFor(element: Element): ElementIds {
  return { elementByIndex: vi.fn(() => element) } as unknown as ElementIds
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

function base64(text: string): string {
  return btoa(text)
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'DataTransfer', { configurable: true, writable: true, value: FakeDataTransfer })
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'DataTransfer')
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('browser_upload_file', () => {
  it('builds File objects and announces input/change/filechange', async () => {
    const input = fileInput()
    const seen: string[] = []
    let announced: FileList | undefined
    input.addEventListener('input', () => seen.push('input'))
    input.addEventListener('change', () => seen.push('change'))
    input.addEventListener('filechange', (event) => {
      seen.push('filechange')
      announced = (event as CustomEvent<{ files: FileList }>).detail.files
    })
    const content = 'hello world'

    const result = await runAction('browser_upload_file', {
      index: 3,
      files: [{ name: 'note.txt', mimeType: 'text/plain', base64: base64(content) }],
    }, { ids: idsFor(input), budget: BUDGET })

    expect(result.text).toBe('Uploaded 1 file(s) to file input [3]: note.txt (0.0 KB total).')
    expect(seen).toEqual(['input', 'change', 'filechange'])
    expect(document.activeElement).toBe(input)
    const files = input.files!
    expect(files).toHaveLength(1)
    expect(files[0]).toBeInstanceOf(File)
    expect(files[0]!.name).toBe('note.txt')
    expect(files[0]!.type).toBe('text/plain')
    expect(files[0]!.size).toBe(content.length)
    expect(announced).toBe(files)
  })

  it('attaches multiple files with their total size', async () => {
    const input = fileInput()
    const payload = 'a'.repeat(1_024)

    const result = await runAction('browser_upload_file', {
      index: 1,
      files: [
        { name: 'one.txt', base64: base64(payload) },
        { name: 'two.bin', mimeType: 'application/octet-stream', base64: base64(payload) },
      ],
    }, { ids: idsFor(input), budget: BUDGET })

    expect(result.text).toBe('Uploaded 2 file(s) to file input [1]: one.txt, two.bin (2.0 KB total).')
    const files = [...input.files!]
    expect(files.map((file) => file.name)).toEqual(['one.txt', 'two.bin'])
    expect(files[0]!.type).toBe('application/octet-stream')
  })

  it('refuses a non-file element with an explicit error', async () => {
    const button = document.createElement('button')
    document.body.append(button)

    await expect(runAction('browser_upload_file', {
      index: 5,
      files: [{ name: 'note.txt', base64: base64('x') }],
    }, { ids: idsFor(button), budget: BUDGET }))
      .rejects.toMatchObject({ code: 'action-failed', message: expect.stringContaining('is not a file input (button)') })
  })

  it('rejects an empty file list and malformed base64', async () => {
    const input = fileInput()
    const ctx = { ids: idsFor(input), budget: BUDGET }

    await expect(runAction('browser_upload_file', { index: 1, files: [] }, ctx))
      .rejects.toMatchObject({ code: 'bad-args', message: expect.stringContaining('1 to 10 items') })
    await expect(runAction('browser_upload_file', {
      index: 1,
      files: [{ name: 'note.txt', base64: '***not-base64***' }],
    }, ctx)).rejects.toMatchObject({ code: 'bad-args', message: expect.stringContaining('not valid base64') })
  })
})

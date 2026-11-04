/**
 * Form-control page actions: choose an option in a `<select>`, and attach
 * caller-supplied files to an `<input type=file>`.
 *
 * Both actions address an element by its snapshot index, validate the element
 * kind before mutating it, and report the resulting control state as text.
 *
 * @module
 */

import { ActionError, describeElement, elementOrThrow, numberArg } from './action-support.ts'
import type { ElementIds } from './ids.ts'

/** Longest option text/name quoted back in a status line. */
const MAX_QUOTED_TEXT = 80
/** The contract caps the "available options" list so the error stays actionable. */
const MAX_LISTED_OPTIONS = 20
/** Contract cap on one upload call. */
const MAX_UPLOAD_FILES = 10

/** How one select request identifies the target option. */
type OptionRequest =
  | { kind: 'value'; value: string }
  | { kind: 'label'; label: string }
  | { kind: 'index'; index: number }

/** Collapse whitespace and cap length for messages. */
function quote(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > MAX_QUOTED_TEXT ? `${clean.slice(0, MAX_QUOTED_TEXT)}…` : clean
}

/**
 * Parse the value/label/option_index triple: exactly one must be supplied.
 *
 * @param args - action arguments.
 * @returns the requested option selector.
 */
function optionRequest(args: Record<string, unknown>): OptionRequest {
  const given = ['value', 'label', 'option_index'].filter((name) => args[name] !== undefined)
  if (given.length !== 1) {
    throw new ActionError('bad-args', `Provide exactly one of value, label, or option_index; received ${given.length === 0 ? 'none' : given.join(', ')}. Call browser_snapshot to read the select's options, then retry browser_select.`)
  }
  if (args.value !== undefined) {
    if (typeof args.value !== 'string') {
      throw new ActionError('bad-args', `value must be a string; received ${typeof args.value}. Call browser_snapshot to read the select's options, then retry browser_select.`)
    }
    return { kind: 'value', value: args.value }
  }
  if (args.label !== undefined) {
    if (typeof args.label !== 'string') {
      throw new ActionError('bad-args', `label must be a string; received ${typeof args.label}. Call browser_snapshot to read the select's options, then retry browser_select.`)
    }
    return { kind: 'label', label: args.label }
  }
  return { kind: 'index', index: numberArg(args, 'option_index') }
}

/**
 * Find the option index a request names.
 *
 * @param options - the select's options in document order.
 * @param request - the parsed request.
 * @returns the option's position, or undefined when nothing matches.
 */
function matchOption(options: HTMLOptionElement[], request: OptionRequest): number | undefined {
  switch (request.kind) {
    case 'value': {
      const index = options.findIndex((option) => option.value === request.value)
      return index === -1 ? undefined : index
    }
    case 'label': {
      const index = options.findIndex((option) => option.text.trim() === request.label)
      return index === -1 ? undefined : index
    }
    case 'index':
      return request.index < options.length ? request.index : undefined
  }
}

/** Render the unmatched-request description used at the start of the error. */
function describeRequest(request: OptionRequest): string {
  switch (request.kind) {
    case 'value': return `Option with value "${quote(request.value)}"`
    case 'label': return `Option labeled "${quote(request.label)}"`
    case 'index': return `Option index ${request.index}`
  }
}

/** List at most {@link MAX_LISTED_OPTIONS} options for an unmatched-select error. */
function availableOptions(options: HTMLOptionElement[]): string {
  const listed = options.slice(0, MAX_LISTED_OPTIONS)
    .map((option) => `"${quote(option.text.trim())}" (value: "${quote(option.value)}")`)
  if (listed.length === 0) return '(the select has no options)'
  const more = options.length > MAX_LISTED_OPTIONS ? `, and ${options.length - MAX_LISTED_OPTIONS} more` : ''
  return `${listed.join(', ')}${more}`
}

/**
 * Choose one option in a `<select>` by value, visible label, or option index.
 *
 * @param args - `index` plus exactly one of `value`/`label`/`option_index`.
 * @param ids - stable element id registry.
 * @returns a status line naming the selected option.
 */
export function selectAction(args: Record<string, unknown>, ids: ElementIds): string {
  const index = numberArg(args, 'index')
  const request = optionRequest(args)
  const el = elementOrThrow(ids, index)
  if (!(el instanceof HTMLSelectElement)) {
    throw new ActionError('action-failed', `Element [${index}] is not a <select> (${describeElement(el)}). Call browser_snapshot to find a select element, then retry browser_select.`)
  }
  if (el.disabled) {
    throw new ActionError('action-failed', `Select [${index}] is disabled. Call browser_snapshot to find an enabled select, then retry browser_select.`)
  }
  const options = [...el.options]
  const matched = matchOption(options, request)
  if (matched === undefined) {
    throw new ActionError('bad-args', `${describeRequest(request)} not found in select [${index}]. Available options: ${availableOptions(options)}. Call browser_snapshot to read them again, then retry browser_select.`)
  }
  el.selectedIndex = matched
  // Contract order: change then input. Native browsers fire input first, but
  // select listeners (including React's onChange) key off change, so the
  // contract ordering is safe and keeps both observers informed.
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.dispatchEvent(new Event('input', { bubbles: true }))
  const option = options[matched]!
  return `Selected option "${quote(option.text.trim())}" (value: "${quote(option.value)}") in [${index}].`
}

/** One decoded upload entry. */
interface UploadFile {
  name: string
  mimeType: string
  bytes: Uint8Array
}

/**
 * Copy a byte view into a standalone buffer.
 *
 * `File` accepts only `ArrayBuffer`-backed parts, while a `Uint8Array` view may
 * be typed against a shared buffer.
 *
 * @param bytes - decoded bytes.
 * @returns a fresh array buffer holding the same bytes.
 */
function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

/**
 * Decode the host's base64 wire form into bytes.
 *
 * @param base64 - base64 payload, optionally carrying a data-URL prefix.
 * @param position - index in `files`, for the error message.
 * @returns the decoded bytes.
 */
function decodeBase64(base64: string, position: number): Uint8Array {
  const marker = base64.indexOf('base64,')
  const payload = marker === -1 ? base64 : base64.slice(marker + 'base64,'.length)
  let binary: string
  try {
    binary = atob(payload.replace(/\s+/g, ''))
  } catch {
    throw new ActionError('bad-args', `files[${position}].base64 is not valid base64; retry browser_upload_file with the original file path.`)
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Parse the `files` argument into name/type/bytes entries.
 *
 * @param args - action arguments.
 * @returns the decoded upload entries.
 */
function uploadFiles(args: Record<string, unknown>): UploadFile[] {
  const raw = args.files
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_UPLOAD_FILES) {
    throw new ActionError('bad-args', `files must be an array of 1 to ${MAX_UPLOAD_FILES} items; received ${Array.isArray(raw) ? raw.length : typeof raw}. Retry browser_upload_file with at least one file.`)
  }
  return raw.map((entry, position) => {
    const item = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {}
    const name = item.name
    if (typeof name !== 'string' || name === '') {
      throw new ActionError('bad-args', `files[${position}].name must be a non-empty string; retry browser_upload_file with the original file path.`)
    }
    if (typeof item.base64 !== 'string') {
      throw new ActionError('bad-args', `files[${position}].base64 must be a string; retry browser_upload_file with the original file path.`)
    }
    const wireMime = typeof item.mime_type === 'string' && item.mime_type !== '' ? item.mime_type : undefined
    const mimeType = wireMime ?? (typeof item.mimeType === 'string' && item.mimeType !== '' ? item.mimeType : 'application/octet-stream')
    return { name, mimeType, bytes: decodeBase64(item.base64, position) }
  })
}

/**
 * Attach files to a file input through a `DataTransfer`, then announce the
 * change the way native pickers do.
 *
 * @param args - `index` of the file input plus `files` entries.
 * @param ids - stable element id registry.
 * @returns a status line naming the files and their total size.
 */
export function uploadFileAction(args: Record<string, unknown>, ids: ElementIds): string {
  const index = numberArg(args, 'index')
  const el = elementOrThrow(ids, index)
  if (!(el instanceof HTMLInputElement) || el.type !== 'file') {
    throw new ActionError('action-failed', `Element [${index}] is not a file input (${describeElement(el)}). Call browser_snapshot to locate an <input type="file">, then retry browser_upload_file.`)
  }
  const files = uploadFiles(args)
  if (typeof DataTransfer !== 'function') {
    throw new ActionError('action-failed', 'This page cannot build a file list (DataTransfer is unavailable); reload the page and retry browser_upload_file.')
  }
  const transfer = new DataTransfer()
  for (const file of files) {
    transfer.items.add(new File([arrayBufferOf(file.bytes)], file.name, { type: file.mimeType }))
  }
  el.files = transfer.files
  el.focus()
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.dispatchEvent(new CustomEvent('filechange', { bubbles: true, detail: { files: transfer.files } }))
  const totalBytes = files.reduce((total, file) => total + file.bytes.byteLength, 0)
  const names = files.map((file) => file.name).join(', ')
  return `Uploaded ${files.length} file(s) to file input [${index}]: ${names} (${(totalBytes / 1024).toFixed(1)} KB total).`
}

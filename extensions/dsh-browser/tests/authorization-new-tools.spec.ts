// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { PAGE_READS, approvalPromptForCall } from '../src/background/authorization.ts'
import type { ToolCall } from '../src/background/tools.ts'
import type { TabFrame } from '../src/background/frames.ts'

const FRAMES: TabFrame[] = [{ frameId: 0, parentFrameId: -1, documentId: 'doc', url: 'https://example.com/page' }]

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: name, name, args }
}

describe('PAGE_READS', () => {
  it('contains every tool whose answer carries page content', () => {
    for (const name of [
      'browser_snapshot',
      'browser_get_text',
      'browser_find',
      'browser_console',
      'browser_network',
      'browser_evaluate',
      'browser_screenshot',
    ]) {
      expect(PAGE_READS.has(name)).toBe(true)
    }
    expect(PAGE_READS.has('browser_click')).toBe(false)
    expect(PAGE_READS.has('browser_resize')).toBe(false)
  })
})

describe('approval prompts for the new tools', () => {
  it('prompts a read while sharing asks', () => {
    const prompt = approvalPromptForCall(call('browser_console'), 'ask', FRAMES, 'en')
    expect(prompt).toMatchObject({ kind: 'read', action: 'browser_console' })
    expect(prompt?.summary).toContain('console')
  })

  it('still prompts browser_evaluate as an action when sharing is automatic', () => {
    const prompt = approvalPromptForCall(call('browser_evaluate', { code: 'x' }), 'auto', FRAMES, 'en')
    expect(prompt).toMatchObject({ kind: 'action', action: 'browser_evaluate' })
    expect(prompt?.summary).toContain('Run JavaScript')
  })

  it('approves browser_evaluate as a state change even while sharing asks', () => {
    // A read prompt grants no write trust, so the action branch must win for a
    // tool that both reads and changes the page.
    const prompt = approvalPromptForCall(call('browser_evaluate', { code: 'x' }), 'ask', FRAMES, 'en')
    expect(prompt).toMatchObject({ kind: 'action', action: 'browser_evaluate' })
    expect(prompt?.canTrust).toBe(true)
  })

  it('does not show page-read prompts when sharing is automatic', () => {
    expect(approvalPromptForCall(call('browser_network'), 'auto', FRAMES, 'en')).toBeUndefined()
    expect(approvalPromptForCall(call('browser_find', { query: 'login' }), 'off', FRAMES, 'en')).toBeUndefined()
  })

  it('requires an action prompt for every state-changing new tool', () => {
    const tools: Array<[string, Record<string, unknown>]> = [
      ['browser_upload_file', { index: 1, files: [{ path: '/tmp/a' }, { path: '/tmp/b' }] }],
      ['browser_select', { index: 2, value: 'a' }],
      ['browser_drag', { from_index: 1, to_index: 2 }],
      ['browser_resize', { width: 900, height: 700 }],
    ]
    for (const [name, args] of tools) {
      const prompt = approvalPromptForCall(call(name, args), 'auto', FRAMES, 'en')
      expect(prompt?.kind).toBe('action')
      expect(prompt?.action).toBe(name)
    }
    expect(approvalPromptForCall(call('browser_upload_file', { index: 1, files: [{ path: 'a' }, { path: 'b' }] }), 'auto', FRAMES, 'en')?.summary)
      .toContain('2 file(s)')
    expect(approvalPromptForCall(call('browser_resize', { width: 900.9, height: 700.2 }), 'auto', FRAMES, 'en')?.summary)
      .toContain('900x700')
  })

  it('keeps resize out of persistent origin trust', () => {
    const prompt = approvalPromptForCall(call('browser_resize', { width: 800, height: 600 }), 'auto', FRAMES, 'en')
    expect(prompt?.canTrust).toBe(false)
  })
})

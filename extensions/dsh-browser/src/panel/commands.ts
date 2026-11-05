/**
 * Composer command support: fetch the Host command catalogue, parse a typed
 * slash line, and rank catalogue rows against the text after the slash.
 *
 * The Host owns what a command does — the panel only discovers the catalogue
 * and forwards the exact line, so behaviour and permissions stay identical to
 * the DeepSeek Harness Web GUI's own command list.
 *
 * @module
 */

import type { UiLocale } from '../i18n.ts'

/** One Host command as `commands/list` reports it. */
export interface CommandDescriptor {
  /** Lowercase name without the leading slash. */
  readonly name: string
  /** Host-provided summary shown beside the name. */
  readonly description: string
}

/**
 * First-party command names with their localized summaries.
 *
 * The menu falls back to this list while the conversation is still provisional
 * (the bridge creates the real Session on the first prompt, so `commands/list`
 * answers "session not found"); without it a brand-new chat had no menu at all.
 */
const BUILTIN_COMMANDS: Readonly<Record<string, { zh: string; en: string }>> = {
  goal: { zh: '设置或查看长期任务目标', en: 'Set or view the goal for a long-running task' },
  plan: { zh: '进入或退出计划模式', en: 'Enter or leave plan mode' },
  feedback: { zh: '发送关于当前会话的反馈', en: 'Record feedback about this session' },
  compact: { zh: '压缩以上对话内容', en: 'Compact older conversation history' },
  permission: { zh: '切换权限预设（沙箱模式与审批策略）', en: 'Switch the permission preset (sandbox mode + approval policy)' },
  export: { zh: '将当前会话内容导出为 ZIP', en: 'Download this Session log as a ZIP archive' },
}

/**
 * Catalogue used before the conversation exists on the Host.
 * @param locale - UI locale.
 * @returns first-party commands in menu order.
 */
export function fallbackCommands(locale: UiLocale): CommandDescriptor[] {
  return Object.entries(BUILTIN_COMMANDS).map(([name, text]) => ({ name, description: text[locale] }))
}

/** Localized display labels for the first-party command names. */
const BUILTIN_LABELS: Record<UiLocale, Readonly<Record<string, string>>> = {
  zh: { goal: '目标', plan: '计划', feedback: '反馈', compact: '压缩', permission: '权限', export: '导出' },
  en: { goal: 'goal', plan: 'plan', feedback: 'feedback', compact: 'compact', permission: 'permission', export: 'export' },
}

/**
 * Label one command name for the composer menu.
 * @param name - command name without the slash.
 * @param locale - UI locale.
 * @returns the localized label, or the name itself for a plugin command.
 */
export function commandLabel(name: string, locale: UiLocale): string {
  return BUILTIN_LABELS[locale][name] ?? name
}

/** A slash line split into the command it names and its argument tail. */
export interface CommandLine {
  /** Command name without the slash. */
  readonly name: string
  /** Text after the command name, trimmed; empty when the line is bare. */
  readonly args: string
}

/**
 * Parse a draft as a slash command.
 *
 * A line only counts as a command when it starts with `/` and the name is a
 * plain token, so `/compact` and `/export md` both parse while `/` alone and
 * `not /a command` do not.
 * @param line - the composer draft.
 * @returns the parsed command, or undefined when the draft is not one.
 */
export function parseCommandLine(line: string): CommandLine | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('/')) return undefined
  const body = trimmed.slice(1)
  const separator = body.search(/\s/u)
  const name = separator === -1 ? body : body.slice(0, separator)
  if (name === '' || /\s/u.test(name)) return undefined
  const args = separator === -1 ? '' : body.slice(separator + 1).trim()
  return { name, args }
}

/**
 * Whether a draft should open the command menu.
 *
 * The menu is open while the draft is a slash line whose name is still being
 * typed — no argument tail yet — which mirrors the Web GUI's `/` trigger.
 * @param line - the composer draft.
 * @returns true while the menu should be visible.
 */
export function commandQuery(line: string): string | undefined {
  // The trailing space that completes a pick must close the menu, so the raw
  // draft decides: trimming first would keep the menu open after selection.
  const leading = /^\s*\//u.exec(line)
  if (leading === null) return undefined
  const body = line.slice(leading[0].length)
  if (/\s/u.test(body)) return undefined
  return body
}

/**
 * Rank catalogue rows against a typed query.
 *
 * Exact matches rank above prefix matches, which rank above substring
 * matches; equal tiers keep the Host's catalogue order.
 * @param commands - catalogue rows from the Host.
 * @param query - text after the slash, possibly empty.
 * @returns matching rows in display order.
 */
export function filterCommands(
  commands: readonly CommandDescriptor[],
  query: string,
): CommandDescriptor[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...commands]
  const scored: { command: CommandDescriptor; tier: number; index: number }[] = []
  commands.forEach((command, index) => {
    const name = command.name.toLowerCase()
    if (name === needle) scored.push({ command, tier: 0, index })
    else if (name.startsWith(needle)) scored.push({ command, tier: 1, index })
    else if (name.indexOf(needle) > 0) scored.push({ command, tier: 2, index })
  })
  // Equal-tier rows keep the Host's order, so the menu does not reshuffle
  // between keystrokes that match the same set.
  return scored
    .sort((left, right) => left.tier - right.tier || left.index - right.index)
    .map((entry) => entry.command)
}

/**
 * Narrow one `commands/list` response.
 *
 * A malformed row is dropped instead of poisoning the whole menu: the Host is
 * the owner of the catalogue and a partial answer still leaves the menu usable.
 * @param value - the raw RPC value (`{ commands }` or a bare array).
 * @returns the usable rows, in Host order.
 */
export function parseCommandCatalog(value: unknown): CommandDescriptor[] {
  const raw = Array.isArray(value)
    ? value
    : (typeof value === 'object' && value !== null && Array.isArray((value as { commands?: unknown }).commands))
      ? (value as { commands: unknown[] }).commands
      : []
  const rows: CommandDescriptor[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const name = (entry as { name?: unknown }).name
    const description = (entry as { description?: unknown }).description
    if (typeof name !== 'string' || name === '' || /\s/u.test(name)) continue
    rows.push({ name, description: typeof description === 'string' ? description : '' })
  }
  return rows
}

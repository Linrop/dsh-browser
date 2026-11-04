/**
 * `browser_find`: word-based search over the same interactive inventory that
 * `browser_snapshot` renders.
 *
 * The inventory (roles, accessible names, indices) comes from `buildSnapshot`,
 * so a hit can be passed straight to `browser_click`/`browser_type` without a
 * second snapshot, and element numbers never disagree with the snapshot.
 *
 * The inventory already drops elements that do not render, so the contract's
 * "invisible" penalty applies to elements the snapshot leaves outside the
 * viewport.
 *
 * @module
 */

import { ActionError } from './action-support.ts'
import type { ElementIds } from './ids.ts'
import { buildSnapshot, type SnapshotBudget, type SnapshotView } from './snapshot.ts'

/** One inventory row, as rendered by `browser_snapshot`. */
type InventoryItem = SnapshotView['items'][number]

/** The contract caps `find` results at 20. */
const MAX_RESULTS = 20

/** Query words that name a role instead of matching element text. */
const ROLE_ALIASES: Readonly<Record<string, string>> = {
  button: 'button',
  buttons: 'button',
  btn: 'button',
  btns: 'button',
  link: 'link',
  links: 'link',
  hyperlink: 'link',
  hyperlinks: 'link',
  field: 'input',
  fields: 'input',
  input: 'input',
  inputs: 'input',
  box: 'input',
  boxes: 'input',
  textbox: 'input',
  textboxes: 'input',
  checkbox: 'checkbox',
  checkboxes: 'checkbox',
  check: 'checkbox',
  radio: 'radio',
  radios: 'radio',
  dropdown: 'select',
  dropdowns: 'select',
  select: 'select',
  selects: 'select',
  combobox: 'select',
  tab: 'tab',
  tabs: 'tab',
  heading: 'heading',
  headings: 'heading',
  header: 'heading',
  image: 'image',
  images: 'image',
  img: 'image',
  picture: 'image',
  toggle: 'switch',
  toggles: 'switch',
  switch: 'switch',
  switches: 'switch',
  slider: 'slider',
  sliders: 'slider',
  range: 'slider',
  option: 'option',
  options: 'option',
  menuitem: 'menuitem',
  menuitems: 'menuitem',
}

/** Roles that are page structure rather than controls; dropped by `filter: interactive`. */
const NON_INTERACTIVE_ROLES = new Set([
  'presentation', 'none', 'heading', 'image', 'img', 'paragraph', 'group', 'list', 'listitem',
  'region', 'article', 'main', 'navigation', 'banner', 'contentinfo', 'figure', 'separator',
  'note', 'status', 'alert', 'definition', 'term', 'toolbar', 'table', 'row', 'cell',
])

/** Field weights from the contract: visible text, identity, and container context. */
const STRONG_WEIGHT = 1
const IDENTITY_WEIGHT = 0.5
const CONTAINER_WEIGHT = 0.3
/** Bonuses: the whole query appears in the name, or the query names this role. */
const FULL_NAME_BONUS = 0.3
const ROLE_BONUS = 0.3
/** Off-screen matches rank below visible ones. */
const OFF_SCREEN_FACTOR = 0.8

/**
 * Split a query into lowercase search words.
 *
 * camelCase boundaries are split before NFKD normalization; combining marks
 * are dropped; words up to three characters are used as written and longer
 * words get a light plural stem.
 *
 * @param query - raw query text.
 * @returns unique tokens in query order.
 */
function tokenize(query: string): string[] {
  const spaced = query.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  const normalized = spaced.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  const words = normalized.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '')
  const stemmed = words.map(stem)
  return [...new Set(stemmed)]
}

/** Light stemming for plural/inflection endings. */
function stem(word: string): string {
  if (word.length <= 3) return word
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`
  if (word.endsWith('es') && word.length > 4) return word.slice(0, -2)
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/** Map an inventory role to its canonical family (`btn` is never an inventory role). */
function canonicalRole(role: string): string {
  const lower = role.trim().toLowerCase()
  return ROLE_ALIASES[lower] ?? lower
}

/** The text fields a token may hit on one element. */
interface ElementFields {
  strong: string[]
  identity: string[]
  container: string
}

/** Longest container text used as context; a bigger parent is page chrome, not a card. */
const MAX_CONTAINER_TEXT = 400

/**
 * The surrounding container's text, when it is a local component.
 *
 * Using `<body>`'s text would make every element match every page word, so the
 * container signal stops at the body boundary and ignores oversized parents.
 */
function containerText(el: Element): string {
  const parent = el.parentElement
  if (parent === null || parent === document.body || parent === document.documentElement) return ''
  const text = parent.textContent ?? ''
  return text.length > MAX_CONTAINER_TEXT ? '' : text.toLowerCase()
}

/** Collect and lowercase the searchable fields of an inventory element. */
function fieldsOf(el: Element, name: string): ElementFields {
  const attribute = (attributeName: string): string => el.getAttribute(attributeName)?.toLowerCase() ?? ''
  const strong = [
    name,
    attribute('aria-label'),
    attribute('placeholder'),
    attribute('title'),
    attribute('alt'),
    el instanceof HTMLInputElement ? el.value : '',
    el.textContent ?? '',
  ].map((text) => text.toLowerCase())
  const identity = [
    el.id,
    el instanceof HTMLAnchorElement ? el.getAttribute('href') ?? '' : '',
  ].map((text) => text.toLowerCase())
  return {
    strong,
    identity,
    container: containerText(el),
  }
}

/** Whether any token appears in any field of one weight class. */
function hits(fields: string[], tokens: string[]): number {
  let score = 0
  for (const token of tokens) {
    if (fields.some((field) => field.includes(token))) score += 1
  }
  return score
}

/** One scored candidate. */
interface Match {
  index: number
  role: string
  name: string
  score: number
  element: Element
}

/** Compare two elements in document order. */
function compareDocumentOrder(a: Element, b: Element): number {
  if (a === b) return 0
  const position = a.compareDocumentPosition(b)
  if ((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return -1
  if ((position & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return 1
  return 0
}

/**
 * Score one inventory element against the query tokens.
 *
 * @param item - inventory row (index, role, name, viewport state).
 * @param el - the element behind the row.
 * @param tokens - unique query tokens.
 * @param query - normalized whole query, for the name substring bonus.
 * @param roleTokens - canonical roles named by query words.
 * @returns the numeric score; 0 means no match.
 */
function scoreItem(
  item: InventoryItem,
  el: Element,
  tokens: string[],
  query: string,
  roleTokens: string[],
): number {
  const fields = fieldsOf(el, item.name)
  let score = hits(fields.strong, tokens) * STRONG_WEIGHT
    + hits(fields.identity, tokens) * IDENTITY_WEIGHT
    + hits([fields.container], tokens) * CONTAINER_WEIGHT
  if (query !== '' && item.name.toLowerCase().includes(query)) score += FULL_NAME_BONUS
  // A role word matches the element's role even when its name says nothing, so
  // a pure role query (`btn`) still lists that role.
  if (roleTokens.includes(canonicalRole(item.role))) score += ROLE_BONUS
  if (score === 0) return 0
  if (!item.inViewport) score *= OFF_SCREEN_FACTOR
  return score
}

/** Read the `filter` argument. */
function filterArg(args: Record<string, unknown>): 'interactive' | 'all' {
  const value = args.filter
  if (value === undefined) return 'interactive'
  if (value !== 'interactive' && value !== 'all') {
    throw new ActionError('bad-args', `filter must be interactive or all; received "${String(value)}". Retry browser_find with filter: "interactive" or filter: "all".`)
  }
  return value
}

/** Read the `limit` argument (1..20, default 20). */
function limitArg(args: Record<string, unknown>): number {
  const value = args.limit
  if (value === undefined) return MAX_RESULTS
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new ActionError('bad-args', `limit must be a positive number up to ${MAX_RESULTS}; received ${String(value)}. Retry browser_find with a smaller limit.`)
  }
  return Math.min(MAX_RESULTS, Math.floor(value))
}

/**
 * Search the page inventory for elements matching a query.
 *
 * @param args - `query`, optional `filter`, optional `limit`.
 * @param ids - stable element id registry (same numbering as `browser_snapshot`).
 * @param budget - negotiated snapshot budget (caps the candidate inventory).
 * @returns the ranked hits in the contract's text form.
 */
export function findAction(args: Record<string, unknown>, ids: ElementIds, budget: SnapshotBudget): string {
  if (typeof args.query !== 'string' || args.query.trim() === '') {
    throw new ActionError('bad-args', 'query must be a non-empty string. Call browser_snapshot to read the page, then retry browser_find with words that appear on it.')
  }
  const query = args.query
  const filter = filterArg(args)
  const limit = limitArg(args)
  const tokens = tokenize(query)
  const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
  const roleTokens = tokens.map((token) => ROLE_ALIASES[token]).filter((role): role is string => role !== undefined)
  // A query made only of role words browses that role; mixed queries keep every
  // element and use the role only as a ranking bonus.
  const roleOnly = roleTokens.length > 0 && roleTokens.length === tokens.length

  const view = buildSnapshot(ids, { budget }, null)
  const matches: Match[] = []
  for (const item of view.items) {
    const role = canonicalRole(item.role)
    if (filter === 'interactive' && NON_INTERACTIVE_ROLES.has(role)) continue
    if (roleOnly && !roleTokens.includes(role)) continue
    const el = ids.elementByIndex(item.index)
    if (el === undefined) continue
    const score = scoreItem(item, el, tokens, normalizedQuery, roleTokens)
    if (score === 0) continue
    matches.push({ index: item.index, role: item.role, name: item.name, score, element: el })
  }
  matches.sort((a, b) => b.score - a.score
    || compareDocumentOrder(a.element, b.element)
    || a.index - b.index)
  const results = matches.slice(0, limit)
  if (results.length === 0) {
    return 'No matching elements found. Try words that appear on the page, or use browser_snapshot to list it.'
  }
  const lines = [`${results.length} elements share words with the query:`]
  for (const result of results) lines.push(`[${result.index}] ${result.role} "${result.name}"`)
  return lines.join('\n')
}

/**
 * Stable CSS selectors for inventoried elements.
 *
 * A snapshot number is only a key into the content script's element registry.
 * When a single-page app re-renders and drops that node, the number alone can
 * no longer address the control the model saw. Recording a selector beside the
 * number lets an action re-resolve the control on the live page instead of
 * failing outright, and lets an unrecoverable reference explain itself.
 *
 * The selector is built from what survives a re-render: `tag#id` at the
 * element or its nearest identified ancestor, with `:nth-of-type` only where
 * an ancestor has same-tag siblings. It answers with markup reads only — the
 * snapshot path pays no extra document scan per inventoried element.
 *
 * @module
 */

/** CSS.escape with a fallback for environments that lack it (jsdom). */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
}

/** `tag#id` for an element that carries an id, else undefined. */
function identitySelector(node: Element): string | undefined {
  if (node.id === '') return undefined
  return `${node.tagName.toLowerCase()}#${cssEscape(node.id)}`
}

/** One structural step: tag plus `:nth-of-type(k)` when siblings share the tag. */
function structuralSegment(node: Element): string {
  const tag = node.tagName.toLowerCase()
  const parent = node.parentElement
  if (parent === null) return tag
  const sameTag = [...parent.children].filter((child) => child.tagName === node.tagName)
  return sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag
}

/**
 * Compute a selector that addresses one element in the current document.
 *
 * A later re-render can still make it match nothing or several elements;
 * callers must count matches instead of trusting uniqueness.
 *
 * @param el - inventoried element.
 * @returns a CSS selector addressing the element.
 */
export function stableSelector(el: Element): string {
  const own = identitySelector(el)
  if (own !== undefined) return own
  const segments: string[] = []
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    if (node !== el) {
      const anchor = identitySelector(node)
      if (anchor !== undefined) {
        segments.unshift(anchor)
        return segments.join(' > ')
      }
    }
    segments.unshift(node === document.documentElement ? node.tagName.toLowerCase() : structuralSegment(node))
    if (node === document.documentElement) break
  }
  return segments.join(' > ')
}

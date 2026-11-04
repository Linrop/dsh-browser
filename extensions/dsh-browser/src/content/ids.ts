/**
 * Stable element numbering for the interactive inventory.
 *
 * Numbers are the model's addressing scheme ("click 7"), so they must survive
 * re-snapshots as long as the element itself survives: ids are assigned once
 * per element (WeakMap) and only renumbered when the element set is
 * restructured. `data-dsh-el` attributes are also written so the ids stay
 * observable from the outside.
 *
 * @module
 */

/** Attribute written on every inventoried element (observable numbering). */
const ID_ATTRIBUTE = 'data-dsh-el'

/**
 * Stable element → id registry. One instance per content-script lifetime.
 */
export class ElementIds {
  private readonly idByElement = new WeakMap<Element, number>()
  private readonly elementById = new Map<number, Element>()
  /**
   * Selector recorded with the last snapshot that rendered each number.
   *
   * The registry entry itself is a live node reference, so an app that replaces
   * the node leaves a number with no usable target. The selector is what lets
   * an action re-resolve the control on the live page.
   */
  private readonly selectorById = new Map<number, string>()
  private nextId = 1

  /**
   * Reconcile the registry against the current element set: drop ids of
   * vanished elements, assign fresh ids to new ones.
   * @param elements - the current interactive inventory (document order).
   * @returns counts of added and removed elements.
   */
  assign(elements: Element[]): { added: number; removed: number } {
    const seen = new Set(elements)
    let removed = 0
    for (const [id, el] of this.elementById) {
      if (!seen.has(el)) {
        this.elementById.delete(id)
        this.idByElement.delete(el)
        this.selectorById.delete(id)
        removed += 1
      }
    }
    let added = 0
    for (const el of elements) {
      if (!this.idByElement.has(el)) {
        const id = this.nextId
        this.nextId += 1
        this.idByElement.set(el, id)
        this.elementById.set(id, el)
        el.setAttribute(ID_ATTRIBUTE, String(id))
        added += 1
      }
    }
    return { added, removed }
  }

  /**
   * Resolve an element's stable id.
   * @param el - element.
   * @returns the assigned id, or undefined when not inventoried.
   */
  indexOf(el: Element): number | undefined {
    return this.idByElement.get(el)
  }

  /**
   * Resolve an id to its element.
   * @param index - inventory number.
   * @returns the element, or undefined when stale or removed.
   */
  elementByIndex(index: number): Element | undefined {
    return this.elementById.get(index)
  }

  /**
   * Record the selector that addresses one numbered element in this document.
   * @param index - inventory number rendered in the snapshot.
   * @param selector - CSS selector resolved from the live element.
   */
  recordSelector(index: number, selector: string): void {
    if (selector === '') return
    this.selectorById.set(index, selector)
  }

  /**
   * The selector recorded with the last snapshot that rendered an element.
   * @param index - inventory number.
   * @returns the selector, or undefined when no snapshot recorded one.
   */
  selectorFor(index: number): string | undefined {
    return this.selectorById.get(index)
  }

  /**
   * Point one number at a replacement node found through its selector.
   *
   * The re-resolved element keeps the number the model already read, so the
   * action and any later action in the same document agree on it.
   * @param index - inventory number being revived.
   * @param element - live element the recorded selector resolved.
   */
  rebind(index: number, element: Element): void {
    if (this.elementById.has(index)) {
      this.elementById.set(index, element)
      this.idByElement.set(element, index)
      element.setAttribute(ID_ATTRIBUTE, String(index))
    }
  }
}

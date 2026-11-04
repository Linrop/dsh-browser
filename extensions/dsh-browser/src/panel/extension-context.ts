/**
 * Guarded access to the extension APIs the panel uses.
 *
 * A panel document outlives its extension context: reloading or updating the
 * extension invalidates the live port and drops `chrome.runtime`, and the same
 * modules are exercised outside Chrome during development. Reading the APIs
 * through these helpers keeps those states from surfacing as an uncaught
 * `TypeError: Cannot read properties of undefined` in the extension's error
 * list, which the user sees as a defect in the panel.
 *
 * @module
 */

/** Whether this document runs inside an extension context at all. */
function extensionChrome(): typeof chrome | undefined {
  return typeof chrome === 'undefined' ? undefined : chrome
}

/**
 * The runtime API of the hosting extension.
 * @returns the runtime API, or undefined outside an extension context.
 */
export function extensionRuntime(): typeof chrome.runtime | undefined {
  return extensionChrome()?.runtime
}

/**
 * Read one key from `chrome.storage.local`.
 * @param key - storage key to read.
 * @returns the stored value, or undefined when storage is unavailable.
 */
export async function readStoredValue<T>(key: string): Promise<T | undefined> {
  const area = extensionChrome()?.storage?.local
  if (area === undefined) return undefined
  const stored = await area.get(key)
  return stored[key] as T | undefined
}

/**
 * Write one key into `chrome.storage.local`, ignoring unavailable storage.
 * @param key - storage key to write.
 * @param value - value to store.
 */
export function writeStoredValue(key: string, value: unknown): void {
  const area = extensionChrome()?.storage?.local
  if (area === undefined) return
  void area.set({ [key]: value }).catch(() => {})
}

/**
 * The id of the window holding this panel document.
 * @returns the window id, or undefined when the API or the id is unavailable.
 */
export async function currentWindowId(): Promise<number | undefined> {
  const windows = extensionChrome()?.windows
  if (windows === undefined) return undefined
  const current = await windows.getCurrent()
  return current.id
}

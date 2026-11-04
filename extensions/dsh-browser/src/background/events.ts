/**
 * Local event counters for the extension's own diagnostics.
 *
 * Names follow `bridge_browser.<domain>.<action>`, the same namespace the
 * bridge already prints to the service-worker console. Counters stay in
 * memory for the lifetime of one worker generation: they are a debugging
 * view for the panel, never durable state and never external telemetry.
 *
 * @module
 */

/** Namespace shared with the bridge lifecycle log lines. */
export const EVENT_NAMESPACE = 'bridge_browser' as const

/** Every counter the panel can display. */
export const LOCAL_EVENT_NAMES = [
  'recording.started',
  'recording.exported',
  'recording.cleared',
  'bridge.connected',
  'bridge.connect_timeout',
  'bridge.stale_reconnect',
  'artifact.swept',
] as const

/** One counted extension event. */
export type LocalEventName = typeof LOCAL_EVENT_NAMES[number]

/** Counts keyed by event name; a missing name reads as zero. */
export type LocalEventCounts = Record<LocalEventName, number>

/** `bridge_browser.` + the event name, matching the console namespace. */
export function eventLogName(name: LocalEventName): string {
  return `${EVENT_NAMESPACE}.${name}`
}

/**
 * In-memory counters for one service-worker generation.
 */
export class LocalEventCounters {
  private readonly counts = new Map<LocalEventName, number>()

  /**
   * Count one event.
   * @param name - counted event.
   * @param amount - increment; defaults to one.
   */
  bump(name: LocalEventName, amount = 1): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + amount)
  }

  /** Snapshot every known name, so the panel renders a stable list. */
  snapshot(): LocalEventCounts {
    const snapshot = {} as LocalEventCounts
    for (const name of LOCAL_EVENT_NAMES) snapshot[name] = this.counts.get(name) ?? 0
    return snapshot
  }

  /** Forget every count (used when the panel asks for a fresh view). */
  reset(): void {
    this.counts.clear()
  }
}

/** Worker-wide counters; a restart legitimately starts them over. */
export const eventCounters = new LocalEventCounters()

/**
 * Count one event on the worker-wide table.
 * @param name - counted event.
 */
export function bumpEvent(name: LocalEventName): void {
  eventCounters.bump(name)
}

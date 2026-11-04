/**
 * Local echo for prompts the panel queued while a turn is still running.
 *
 * The bridge submits with `mode: 'queue'`, so the host keeps the message in the
 * session inbox and emits no `user/message` event until the running turn ends.
 * Without an echo the composer clears and the text simply vanishes, which reads
 * as a lost message. The echo shown here disappears as soon as the durable row
 * arrives, so the transcript still has exactly one row per message.
 *
 * @module
 */

/** One prompt awaiting its durable row. */
export interface QueuedEcho {
  /** Local identity, stable across re-renders. */
  key: string
  /** Message text the user submitted. */
  text: string
  /** Highest transcript sequence at submission time, used to match the row. */
  sinceSeq: number
}

/**
 * Append an echo unless the same text is already waiting.
 * @param current - echoes already shown.
 * @param echo - the newly queued prompt.
 * @returns the next echo list.
 */
export function addQueuedEcho(current: readonly QueuedEcho[], echo: QueuedEcho): QueuedEcho[] {
  if (current.some((item) => item.text === echo.text)) return [...current]
  return [...current, echo]
}

/**
 * Drop every echo whose durable user row has arrived.
 * @param current - echoes already shown.
 * @param rows - transcript rows visible now, each with its text and sequence.
 * @returns the echoes still waiting for their row.
 */
export function pruneQueuedEchoes(
  current: readonly QueuedEcho[],
  rows: readonly { kind: string; text: string; seq: number }[],
): QueuedEcho[] {
  if (current.length === 0) return []
  const arrived = rows.filter((row) => row.kind === 'user')
  return current.filter((echo) => !arrived.some((row) => row.seq > echo.sinceSeq && row.text.includes(echo.text)))
}

/**
 * Composer voice input: the pure part of microphone capture, kept out of the
 * component so the browser APIs stay the only untested surface.
 *
 * The dsh host accepts exactly one audio format — mono PCM16 WAV with a
 * 44-byte header at 16 kHz — so this module owns the conversion from whatever
 * native sample rate the microphone delivers, plus the transcript/timer and
 * state rules the button renders.
 *
 * @module
 */

import type { PanelCopy } from './strings.ts'

/** Sample rate the host transcribes; anything else is rejected. */
export const TARGET_SAMPLE_RATE = 16_000

/** Playback length of one mono PCM16 WAV that carries `sampleCount` samples. */
const PCM16_BYTES_PER_SAMPLE = 2

/** Canonical WAV header length for a PCM16 stream. */
const WAV_HEADER_BYTES = 44

/** Capture ceiling used when the host omits `maxDurationSeconds`. */
export const DEFAULT_MAX_DURATION_SECONDS = 60

/** A recording phase of the composer button. */
export type VoicePhase = 'idle' | 'requesting' | 'recording' | 'transcribing'

/** One input that advances the recording phase. */
export type VoiceAction = 'start' | 'grant' | 'finish' | 'cancel' | 'settle'

/** What a click on the microphone means right now, or that it is ignored. */
export type VoiceClickAction = 'start' | 'finish' | 'cancel' | null

/** A questionnaire-free failure the panel turns into localized copy. */
export type VoiceErrorKind =
  | 'permission'
  | 'deviceMissing'
  | 'unsupported'
  | 'unavailable'
  | 'tooLarge'
  | 'transcribe'
  | 'empty'

/** The host's recognizer selection, echoed back verbatim with the audio. */
export interface SpeechSelection {
  readonly [key: string]: unknown
}

/** The catalog fields this panel needs from `speech.catalog`. */
export interface ResolvedSpeechCatalog {
  /** Recognizer selection to replay in `speech.transcribe`. */
  selection: SpeechSelection
  /** Largest accepted WAV in bytes; `Infinity` when the host omits it. */
  maxAudioBytes: number
  /** Longest capture in seconds; the default applies when the host omits it. */
  maxDurationSeconds: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Read `speech.catalog`, treating a missing recognizer as unavailable.
 * @param value - raw RPC payload.
 * @returns the resolved catalog, or null when no recognizer can transcribe.
 */
export function resolveSpeechCatalog(value: unknown): ResolvedSpeechCatalog | null {
  if (!isRecord(value)) return null
  const selection = value.selection
  if (!isRecord(selection)) return null
  const providers = value.providers
  if (Array.isArray(providers) && providers.length === 0) return null
  return {
    selection,
    maxAudioBytes: positiveNumber(value.maxAudioBytes) ?? Number.POSITIVE_INFINITY,
    maxDurationSeconds: positiveNumber(value.maxDurationSeconds) ?? DEFAULT_MAX_DURATION_SECONDS,
  }
}

/**
 * Encode mono floating-point samples as the PCM16 WAV the host accepts.
 * @param samples - samples already resampled to {@link TARGET_SAMPLE_RATE}.
 * @returns the complete little-endian WAV bytes.
 */
export function encodeWave(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(WAV_HEADER_BYTES + samples.length * PCM16_BYTES_PER_SAMPLE)
  const view = new DataView(bytes.buffer)
  const text = (at: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) bytes[at + index] = value.charCodeAt(index)
  }
  text(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, TARGET_SAMPLE_RATE, true)
  view.setUint32(28, TARGET_SAMPLE_RATE * PCM16_BYTES_PER_SAMPLE, true)
  view.setUint16(32, PCM16_BYTES_PER_SAMPLE, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * PCM16_BYTES_PER_SAMPLE, true)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0))
    view.setInt16(
      WAV_HEADER_BYTES + index * PCM16_BYTES_PER_SAMPLE,
      Math.round(sample * (sample < 0 ? 0x8000 : 0x7fff)),
      true,
    )
  }
  return bytes
}

/**
 * Resample mono samples to the host rate with linear interpolation.
 * @param samples - native-rate mono samples.
 * @param fromRate - the rate those samples were captured at.
 * @param toRate - target rate; defaults to {@link TARGET_SAMPLE_RATE}.
 * @returns the resampled mono buffer.
 */
export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number = TARGET_SAMPLE_RATE,
): Float32Array {
  if (samples.length === 0) return new Float32Array(0)
  if (fromRate === toRate) return samples
  const length = Math.max(1, Math.round(samples.length * toRate / fromRate))
  const output = new Float32Array(length)
  const step = fromRate / toRate
  const last = samples.length - 1
  for (let index = 0; index < length; index += 1) {
    const position = index * step
    const left = Math.min(Math.floor(position), last)
    const right = Math.min(left + 1, last)
    const fraction = position - left
    const start = samples[left] ?? 0
    const end = samples[right] ?? 0
    output[index] = start + (end - start) * fraction
  }
  return output
}

/**
 * Concatenate the capture chunks into one mono buffer.
 * @param chunks - buffers in arrival order.
 * @returns every sample in one array.
 */
export function concatSamples(chunks: readonly Float32Array[]): Float32Array {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const merged = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

/**
 * Encode bytes as base64 without a data URL prefix.
 * @param bytes - complete recording.
 * @returns base64 text.
 */
export function audioBase64(bytes: Uint8Array): string {
  let text = ''
  // btoa throws past the argument limit, so feed it bounded slices.
  for (let index = 0; index < bytes.length; index += 8192) {
    text += String.fromCharCode(...bytes.subarray(index, index + 8192))
  }
  return btoa(text)
}

/**
 * Format elapsed seconds as the recording timer (`0:03`, `1:05`).
 * @param seconds - elapsed capture time; fractions are dropped.
 * @returns minutes and two-digit seconds.
 */
export function formatDuration(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return `${minutes}:${rest.toString().padStart(2, '0')}`
}

/**
 * Append a transcript to the current draft.
 * @param draft - the draft text the user already typed.
 * @param transcript - recognized speech, unnormalized.
 * @returns the draft with the transcript at its end; an empty transcript leaves it unchanged.
 */
export function mergeTranscript(draft: string, transcript: string): string {
  const next = transcript.trim()
  if (next === '') return draft
  if (draft === '') return next
  return /\s$/.test(draft) ? `${draft}${next}` : `${draft} ${next}`
}

/**
 * Advance the recording phase machine.
 * @param phase - current phase.
 * @param action - input to apply.
 * @returns the next phase; actions that do not apply leave it unchanged.
 */
export function nextVoicePhase(phase: VoicePhase, action: VoiceAction): VoicePhase {
  switch (action) {
    case 'start':
      return phase === 'idle' ? 'requesting' : phase
    case 'grant':
      return phase === 'requesting' ? 'recording' : phase
    case 'finish':
      return phase === 'recording' ? 'transcribing' : phase
    case 'cancel':
      return phase === 'requesting' ? 'idle' : phase
    case 'settle':
      return 'idle'
  }
}

/**
 * Interpret one press of the microphone button.
 * @param phase - current phase.
 * @returns what the press does, or null while a transcription is in flight.
 */
export function voiceClickAction(phase: VoicePhase): VoiceClickAction {
  switch (phase) {
    case 'idle':
      return 'start'
    case 'requesting':
      return 'cancel'
    case 'recording':
      return 'finish'
    case 'transcribing':
      return null
  }
}

/**
 * Decide whether the microphone button is disabled.
 * @param phase - current phase.
 * @param unavailable - the host reported no usable recognizer.
 * @param busy - the composer cannot start another action.
 * @returns true when a press must be ignored.
 */
export function voiceButtonDisabled(phase: VoicePhase, unavailable: boolean, busy: boolean): boolean {
  return busy || unavailable || phase === 'transcribing'
}

/**
 * Localize one capture or transcription failure.
 * @param kind - failure category.
 * @param copy - localized voice section.
 * @returns the message shown in the panel error row.
 */
export function voiceErrorText(kind: VoiceErrorKind, copy: PanelCopy['app']['voice']): string {
  return copy.errors[kind]
}

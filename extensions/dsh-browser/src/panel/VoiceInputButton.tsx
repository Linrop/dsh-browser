/**
 * Composer microphone button: records from the host's own speech recognizer
 * through `api.rpc`, then hands the text back for insertion into the draft.
 *
 * The button owns the browser glue only — `getUserMedia`, a ScriptProcessor
 * capture at the native rate, the recording timer, and the RPC calls. Every
 * conversion, merge, and state rule lives in `voice-input.ts`.
 *
 * @module
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PanelApi } from './api.ts'
import type { PanelCopy } from './strings.ts'
import {
  audioBase64,
  concatSamples,
  encodeWave,
  formatDuration,
  nextVoicePhase,
  resampleLinear,
  resolveSpeechCatalog,
  TARGET_SAMPLE_RATE,
  voiceButtonDisabled,
  voiceClickAction,
  voiceErrorText,
  type ResolvedSpeechCatalog,
  type SpeechSelection,
  type VoiceErrorKind,
  type VoicePhase,
} from './voice-input.ts'

/** ScriptProcessor buffer; 4096 frames is ~85 ms at 48 kHz. */
const CAPTURE_BUFFER_FRAMES = 4096

/** Recording-timer refresh interval. */
const TIMER_INTERVAL_MS = 250

/** One live microphone capture and every resource it holds. */
interface Capture {
  stream: MediaStream
  context: AudioContext
  source: MediaStreamAudioSourceNode
  processor: ScriptProcessorNode
  chunks: Float32Array[]
  sampleRate: number
  startedAt: number
  timer: number
  maxAudioBytes: number
  maxDurationSeconds: number
  selection: SpeechSelection
}

/** Panel-visible properties of the microphone button. */
export interface VoiceInputButtonProps {
  /** Bridge client used for `speech.catalog` and `speech.transcribe`. */
  api: PanelApi
  /** Localized voice strings. */
  copy: PanelCopy['app']['voice']
  /** Disables the control, e.g. while a turn runs. */
  disabled: boolean
  /** Receives the recognized speech for insertion into the draft. */
  onTranscript: (text: string) => void
  /** Receives a localized message plus the raw detail for the error row. */
  onError: (message: string, detail?: string) => void
}

function MicrophoneIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="7.1" y="2.6" width="5.8" height="9.2" rx="2.9" />
      <path d="M4.4 9.6a5.6 5.6 0 0 0 11.2 0M10 15.2v2.2M7.6 17.4h4.8" />
    </svg>
  )
}

function captureErrorKind(error: unknown): VoiceErrorKind {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'permission'
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError'
      || error.name === 'NotReadableError') return 'deviceMissing'
  }
  return 'unsupported'
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * Release every resource one capture holds.
 * @param capture - capture whose tracks, processor, and context must close.
 * @returns after the audio context finishes closing.
 */
async function releaseCapture(capture: Capture): Promise<void> {
  clearInterval(capture.timer)
  capture.processor.onaudioprocess = null
  try {
    capture.source.disconnect()
  } catch (error) {
    console.warn('[voice-input] disconnecting the media source failed', error)
  }
  try {
    capture.processor.disconnect()
  } catch (error) {
    console.warn('[voice-input] disconnecting the processor failed', error)
  }
  for (const track of capture.stream.getTracks()) track.stop()
  if (capture.context.state === 'closed') return
  try {
    await capture.context.close()
  } catch (error) {
    console.warn('[voice-input] closing the audio context failed', error)
  }
}

/** Microphone button for the composer. */
export function VoiceInputButton({
  api,
  copy,
  disabled,
  onTranscript,
  onError,
}: VoiceInputButtonProps): React.JSX.Element {
  const [phase, setPhaseState] = useState<VoicePhase>('idle')
  const [seconds, setSeconds] = useState(0)
  /** null means the catalog has not loaded yet; that state stays retryable. */
  const [available, setAvailable] = useState<boolean | null>(null)
  const phaseRef = useRef<VoicePhase>('idle')
  const catalogRef = useRef<ResolvedSpeechCatalog | null>(null)
  const captureRef = useRef<Capture | null>(null)
  const cancelledRef = useRef(false)
  const mountedRef = useRef(true)

  const setPhase = useCallback((next: VoicePhase): void => {
    phaseRef.current = next
    if (mountedRef.current) setPhaseState(next)
  }, [])

  const loadCatalog = useCallback(async (): Promise<ResolvedSpeechCatalog | null> => {
    try {
      const resolved = resolveSpeechCatalog(await api.rpc<unknown>('speech.catalog', {}))
      catalogRef.current = resolved
      if (mountedRef.current) setAvailable(resolved !== null)
      return resolved
    } catch (error) {
      // A failed lookup is not an unavailable recognizer: keep the button
      // pressable so the next click retries instead of latching it off.
      catalogRef.current = null
      if (mountedRef.current) setAvailable(null)
      console.warn('[voice-input] speech.catalog failed', error)
      return null
    }
  }, [api])

  const fail = useCallback((kind: VoiceErrorKind, detail?: string): void => {
    const capture = captureRef.current
    captureRef.current = null
    if (capture !== null) void releaseCapture(capture)
    setPhase('idle')
    if (mountedRef.current) {
      setSeconds(0)
      onError(voiceErrorText(kind, copy), detail)
    }
  }, [copy, onError, setPhase])

  const cancel = useCallback((): void => {
    cancelledRef.current = true
    const capture = captureRef.current
    captureRef.current = null
    if (capture !== null) void releaseCapture(capture)
    setPhase('idle')
    setSeconds(0)
  }, [setPhase])

  const finish = useCallback(async (): Promise<void> => {
    if (phaseRef.current !== 'recording') return
    const capture = captureRef.current
    if (capture === null) {
      setPhase('idle')
      return
    }
    captureRef.current = null
    setPhase(nextVoicePhase('recording', 'finish'))
    const samples = concatSamples(capture.chunks)
    const sampleRate = capture.sampleRate
    await releaseCapture(capture)
    if (samples.length === 0) {
      fail('empty')
      return
    }
    const bytes = encodeWave(resampleLinear(samples, sampleRate, TARGET_SAMPLE_RATE))
    if (bytes.length > capture.maxAudioBytes) {
      fail('tooLarge')
      return
    }
    try {
      const result = await api.rpc<{ text?: unknown }>('speech.transcribe', {
        request: { audioBase64: audioBase64(bytes), ...capture.selection },
      })
      const text = typeof result?.text === 'string' ? result.text.trim() : ''
      if (text === '') {
        fail('empty')
        return
      }
      if (!mountedRef.current) return
      setPhase('idle')
      onTranscript(text)
    } catch (error) {
      console.warn('[voice-input] speech.transcribe failed', error)
      fail('transcribe', describe(error))
    }
  }, [api, fail, onTranscript, setPhase])

  const begin = useCallback(async (): Promise<void> => {
    if (phaseRef.current !== 'idle') return
    cancelledRef.current = false
    setPhase('requesting')
    const catalog = catalogRef.current ?? await loadCatalog()
    if (catalog === null) {
      if (!mountedRef.current) return
      fail('unavailable', 'speech.catalog returned no usable recognizer')
      return
    }
    if (cancelledRef.current) {
      setPhase('idle')
      return
    }
    const devices: MediaDevices | undefined = navigator.mediaDevices
    if (devices === undefined) {
      fail('unsupported', 'navigator.mediaDevices is undefined')
      return
    }
    let stream: MediaStream
    try {
      stream = await devices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
    } catch (error) {
      if (!mountedRef.current) return
      fail(captureErrorKind(error), describe(error))
      return
    }
    if (!mountedRef.current) {
      for (const track of stream.getTracks()) track.stop()
      return
    }
    if (cancelledRef.current) {
      for (const track of stream.getTracks()) track.stop()
      setPhase('idle')
      return
    }
    let context: AudioContext
    let source: MediaStreamAudioSourceNode
    let processor: ScriptProcessorNode
    try {
      context = new AudioContext()
      if (typeof context.createScriptProcessor !== 'function') {
        throw new Error('AudioContext has no createScriptProcessor')
      }
      source = context.createMediaStreamSource(stream)
      processor = context.createScriptProcessor(CAPTURE_BUFFER_FRAMES, 1, 1)
    } catch (error) {
      for (const track of stream.getTracks()) track.stop()
      if (!mountedRef.current) return
      fail('unsupported', describe(error))
      return
    }
    const capture: Capture = {
      stream,
      context,
      source,
      processor,
      chunks: [],
      sampleRate: context.sampleRate,
      startedAt: performance.now(),
      timer: 0,
      maxAudioBytes: catalog.maxAudioBytes,
      maxDurationSeconds: catalog.maxDurationSeconds,
      selection: catalog.selection,
    }
    captureRef.current = capture
    processor.onaudioprocess = (event: AudioProcessingEvent): void => {
      if (captureRef.current !== capture) return
      capture.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
      const elapsed = (performance.now() - capture.startedAt) / 1000
      if (elapsed >= capture.maxDurationSeconds) void finish()
    }
    try {
      source.connect(processor)
      processor.connect(context.destination)
      void context.resume()
    } catch (error) {
      captureRef.current = null
      void releaseCapture(capture)
      if (!mountedRef.current) return
      fail('unsupported', describe(error))
      return
    }
    capture.timer = window.setInterval(() => {
      if (captureRef.current !== capture) return
      const elapsed = (performance.now() - capture.startedAt) / 1000
      if (mountedRef.current) setSeconds(elapsed)
      if (elapsed >= capture.maxDurationSeconds) void finish()
    }, TIMER_INTERVAL_MS)
    if (!mountedRef.current) {
      captureRef.current = null
      void releaseCapture(capture)
      return
    }
    setSeconds(0)
    setPhase(nextVoicePhase('requesting', 'grant'))
  }, [fail, finish, loadCatalog, setPhase])

  function handlePress(): void {
    const action = voiceClickAction(phaseRef.current)
    if (action === 'start') void begin()
    else if (action === 'finish') void finish()
    else if (action === 'cancel') cancel()
  }

  useEffect(() => {
    mountedRef.current = true
    void loadCatalog()
    return () => {
      mountedRef.current = false
      const capture = captureRef.current
      captureRef.current = null
      if (capture !== null) void releaseCapture(capture)
    }
  }, [loadCatalog])

  useEffect(() => {
    if (phase !== 'recording' && phase !== 'requesting') return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (phaseRef.current === 'recording') void finish()
      else if (phaseRef.current === 'requesting') cancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [phase, finish, cancel])

  const unavailable = available === false
  const isDisabled = disabled || voiceButtonDisabled(phase, unavailable, false)
  const duration = formatDuration(seconds)
  const label = phase === 'recording'
    ? copy.stopAndTranscribe
    : phase === 'requesting'
      ? copy.cancel
      : phase === 'transcribing'
        ? copy.transcribing
        : unavailable
          ? copy.unavailable
          : copy.start
  const title = phase === 'recording' ? copy.recording(duration) : label
  const className = [
    'voice-input-button',
    phase === 'recording' ? 'is-recording' : '',
    phase === 'requesting' ? 'is-requesting' : '',
    phase === 'transcribing' ? 'is-transcribing' : '',
  ].filter((part) => part !== '').join(' ')

  return (
    <span className="voice-input-control">
      {phase === 'recording' && (
        <span className="voice-input-timer" aria-hidden="true">{duration}</span>
      )}
      <button
        type="button"
        className={className}
        onClick={handlePress}
        disabled={isDisabled}
        aria-pressed={phase === 'recording'}
        aria-busy={phase === 'requesting' || phase === 'transcribing' || undefined}
        aria-label={label}
        title={title}
      >
        {phase === 'requesting' || phase === 'transcribing'
          ? <span className="voice-input-spinner" aria-hidden="true" />
          : <MicrophoneIcon />}
      </button>
    </span>
  )
}

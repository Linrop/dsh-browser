// @vitest-environment jsdom

import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanelApi } from '../src/panel/api.ts'
import { VoiceInputButton } from '../src/panel/VoiceInputButton.tsx'
import {
  audioBase64,
  encodeWave,
  formatDuration,
  mergeTranscript,
  nextVoicePhase,
  resampleLinear,
  resolveSpeechCatalog,
  voiceButtonDisabled,
  voiceClickAction,
  type VoicePhase,
} from '../src/panel/voice-input.ts'

const TARGET_RATE = 16_000

function text(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes.subarray(0, 4))
}

function sine(sampleRate: number, frequency: number, length: number): Float32Array {
  const samples = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    samples[index] = Math.sin(2 * Math.PI * frequency * index / sampleRate)
  }
  return samples
}

describe('WAV encoding', () => {
  const samples = new Float32Array([-1, 0, 1, 0.5])
  const bytes = encodeWave(samples)
  const view = new DataView(bytes.buffer)

  it('writes the canonical 44-byte PCM16 mono header', () => {
    expect(bytes.length).toBe(44 + samples.length * 2)
    expect(text(bytes.subarray(0))).toBe('RIFF')
    expect(text(bytes.subarray(8))).toBe('WAVE')
    expect(text(bytes.subarray(12))).toBe('fmt ')
    expect(text(bytes.subarray(36))).toBe('data')
    expect(view.getUint32(4, true)).toBe(bytes.length - 8)
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(28, true)).toBe(32_000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(samples.length * 2)
  })

  it('quantizes the PCM16 boundaries and clamps out-of-range samples', () => {
    const clamped = encodeWave(new Float32Array([-1, 0, 1, -2, 2]))
    const data = new DataView(clamped.buffer)
    expect(data.getInt16(44, true)).toBe(-32768)
    expect(data.getInt16(46, true)).toBe(0)
    expect(data.getInt16(48, true)).toBe(32767)
    expect(data.getInt16(50, true)).toBe(-32768)
    expect(data.getInt16(52, true)).toBe(32767)
  })

  it('encodes nothing but the header for an empty capture', () => {
    const empty = encodeWave(new Float32Array(0))
    expect(empty.length).toBe(44)
    expect(new DataView(empty.buffer).getUint32(40, true)).toBe(0)
  })
})

describe('resampling to the host rate', () => {
  it('keeps the capture duration when dividing 48 kHz by three', () => {
    const input = sine(48_000, 440, 4_800)
    const output = resampleLinear(input, 48_000, TARGET_RATE)
    expect(output.length).toBe(1_600)
  })

  it('preserves the exact samples on an integer ratio', () => {
    const input = sine(48_000, 440, 4_800)
    const output = resampleLinear(input, 48_000, TARGET_RATE)
    expect(output[0]).toBe(0)
    expect(output[100]).toBeCloseTo(input[300] ?? Number.NaN, 6)
    expect(output[1_599]).toBeCloseTo(input[4_797] ?? Number.NaN, 6)
    expect(output[0]).toBeCloseTo(0, 6)
    expect(output[output.length - 1]).toBeCloseTo(Math.sin(2 * Math.PI * 440 * 4_797 / 48_000), 6)
  })

  it('rounds a non-integer ratio to the nearest frame', () => {
    const input = sine(44_100, 440, 4_410)
    const output = resampleLinear(input, 44_100, TARGET_RATE)
    expect(output.length).toBe(Math.round(4_410 * TARGET_RATE / 44_100))
  })

  it('returns the capture unchanged at the target rate', () => {
    const input = sine(16_000, 440, 160)
    expect(resampleLinear(input, 16_000, TARGET_RATE)).toBe(input)
  })

  it('returns an empty buffer for an empty capture', () => {
    expect(resampleLinear(new Float32Array(0), 48_000).length).toBe(0)
  })
})

describe('base64 transport encoding', () => {
  it('matches a single-shot btoa across the chunk boundary', () => {
    const bytes = new Uint8Array(10_000)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 37) % 256
    const whole = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
    expect(audioBase64(bytes)).toBe(btoa(whole))
    expect(audioBase64(bytes).length).toBe(Math.ceil(bytes.length / 3) * 4)
  })

  it('encodes an empty recording as an empty string', () => {
    expect(audioBase64(new Uint8Array(0))).toBe('')
  })
})

describe('recording timer formatting', () => {
  it('formats seconds and minutes', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(3)).toBe('0:03')
    expect(formatDuration(65)).toBe('1:05')
  })

  it('drops fractions and treats negative or non-finite input as zero', () => {
    expect(formatDuration(3.9)).toBe('0:03')
    expect(formatDuration(-1)).toBe('0:00')
    expect(formatDuration(Number.NaN)).toBe('0:00')
  })
})

describe('transcript insertion', () => {
  it('inserts into an empty draft', () => {
    expect(mergeTranscript('', 'hello')).toBe('hello')
  })

  it('separates a non-empty draft with one space', () => {
    expect(mergeTranscript('write a mail', 'to my advisor')).toBe('write a mail to my advisor')
  })

  it('respects whitespace on both sides', () => {
    expect(mergeTranscript('hello ', 'world')).toBe('hello world')
    expect(mergeTranscript('hello', '  world  ')).toBe('hello world')
    expect(mergeTranscript('', '  world  ')).toBe('world')
  })

  it('leaves the draft unchanged for an empty transcript', () => {
    expect(mergeTranscript('keep', '   ')).toBe('keep')
    expect(mergeTranscript('', '')).toBe('')
  })
})

describe('catalog availability', () => {
  it('accepts a complete catalog', () => {
    const catalog = resolveSpeechCatalog({
      providers: ['whisper'],
      selection: { provider: 'whisper', model: 'base' },
      maxAudioBytes: 10_000_000,
      maxDurationSeconds: 120,
    })
    expect(catalog).toEqual({
      selection: { provider: 'whisper', model: 'base' },
      maxAudioBytes: 10_000_000,
      maxDurationSeconds: 120,
    })
  })

  it('treats a missing selection as unavailable', () => {
    expect(resolveSpeechCatalog({ providers: ['whisper'], selection: null })).toBeNull()
    expect(resolveSpeechCatalog({ providers: ['whisper'] })).toBeNull()
    expect(resolveSpeechCatalog(null)).toBeNull()
  })

  it('treats an empty provider list as unavailable', () => {
    expect(resolveSpeechCatalog({ providers: [], selection: { provider: 'x' } })).toBeNull()
  })

  it('falls back to defaults for omitted limits', () => {
    const catalog = resolveSpeechCatalog({ selection: { provider: 'x' } })
    expect(catalog?.maxAudioBytes).toBe(Number.POSITIVE_INFINITY)
    expect(catalog?.maxDurationSeconds).toBe(60)
  })
})

describe('voice phase machine', () => {
  it('walks idle → requesting → recording → transcribing → idle', () => {
    let phase: VoicePhase = 'idle'
    phase = nextVoicePhase(phase, 'start')
    expect(phase).toBe('requesting')
    phase = nextVoicePhase(phase, 'grant')
    expect(phase).toBe('recording')
    phase = nextVoicePhase(phase, 'finish')
    expect(phase).toBe('transcribing')
    phase = nextVoicePhase(phase, 'settle')
    expect(phase).toBe('idle')
  })

  it('cancels a pending permission request back to idle', () => {
    expect(nextVoicePhase('requesting', 'cancel')).toBe('idle')
    expect(nextVoicePhase('idle', 'grant')).toBe('idle')
  })

  it('cannot re-trigger while a transcription is in flight', () => {
    expect(voiceClickAction('transcribing')).toBeNull()
    expect(nextVoicePhase('transcribing', 'finish')).toBe('transcribing')
  })

  it('maps clicks to the phase action', () => {
    expect(voiceClickAction('idle')).toBe('start')
    expect(voiceClickAction('requesting')).toBe('cancel')
    expect(voiceClickAction('recording')).toBe('finish')
  })

  it('disables the button when unavailable, busy, or transcribing', () => {
    expect(voiceButtonDisabled('idle', true, false)).toBe(true)
    expect(voiceButtonDisabled('idle', false, true)).toBe(true)
    expect(voiceButtonDisabled('transcribing', false, false)).toBe(true)
    expect(voiceButtonDisabled('recording', false, false)).toBe(false)
  })
})

interface FakeProcessor {
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null
  connect: () => void
  disconnect: () => void
  emit: (samples: Float32Array) => void
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  sampleRate = 48_000
  state: AudioContextState = 'running'
  destination = {}
  processors: FakeProcessor[] = []

  constructor() {
    FakeAudioContext.instances.push(this)
  }

  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return { connect: () => undefined, disconnect: () => undefined }
  }

  createScriptProcessor(): FakeProcessor {
    const processor: FakeProcessor = {
      onaudioprocess: null,
      connect: () => undefined,
      disconnect: () => undefined,
      emit: (samples: Float32Array) => {
        processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } } as unknown as AudioProcessingEvent)
      },
    }
    this.processors.push(processor)
    return processor
  }

  resume(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.state = 'closed'
    return Promise.resolve()
  }
}

interface RpcSpy {
  (method: string, payload?: unknown): Promise<unknown>
  mock: { calls: unknown[][] }
}

interface TranscriptSpy {
  (value: string): void
  mock: { calls: unknown[][] }
}

describe('microphone button', () => {
  let root: Root
  let container: HTMLDivElement
  let transcribe: RpcSpy
  let onTranscript: TranscriptSpy

  function fakeApi(transcribeImpl: () => Promise<unknown>): PanelApi {
    const catalog = {
      providers: ['mock'],
      selection: { provider: 'mock', model: 'tiny' },
      maxAudioBytes: 5_000_000,
      maxDurationSeconds: 5,
    }
    transcribe = vi.fn(async (method: string) =>
      method === 'speech.catalog' ? catalog : transcribeImpl()) as unknown as RpcSpy
    return { rpc: transcribe } as unknown as PanelApi
  }

  function render(api: PanelApi): void {
    function Harness(): React.JSX.Element {
      const [draft, setDraft] = useState('hello')
      return createElement(
        'div',
        null,
        createElement(VoiceInputButton, {
          api,
          copy: {
            start: 'Start voice input',
            stopAndTranscribe: 'Stop and transcribe',
            cancel: 'Cancel voice input',
            requesting: 'Waiting for the microphone…',
            recording: (duration: string) => `Recording ${duration}`,
            transcribing: 'Transcribing…',
            unavailable: 'Voice input is unavailable',
            errors: {
              permission: 'permission', deviceMissing: 'deviceMissing', unsupported: 'unsupported',
              unavailable: 'unavailable', tooLarge: 'tooLarge', transcribe: 'transcribe', empty: 'empty',
            },
          },
          disabled: false,
          onTranscript: (value: string) => {
            onTranscript(value)
            setDraft((current) => mergeTranscript(current, value))
          },
          onError: () => undefined,
        }),
        createElement('output', { id: 'draft' }, draft),
      )
    }
    act(() => { root.render(createElement(Harness)) })
  }

  function button(): HTMLButtonElement {
    const element = container.querySelector<HTMLButtonElement>('button.voice-input-button')
    if (element === null) throw new Error('voice button missing')
    return element
  }

  function draft(): string {
    return container.querySelector('#draft')?.textContent ?? ''
  }

  async function flush(): Promise<void> {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    FakeAudioContext.instances = []
    vi.stubGlobal('AudioContext', FakeAudioContext)
    onTranscript = vi.fn() as unknown as TranscriptSpy
    const tracks = [{ stop: vi.fn() }]
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => tracks })) },
    })
    container = document.querySelector('#root')!
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    vi.unstubAllGlobals()
  })

  it('records, transcribes on the second click, and inserts the text', async () => {
    render(fakeApi(async () => ({ text: 'recognized speech' })))
    await flush()

    act(() => { button().click() })
    await flush()
    expect(button().getAttribute('aria-pressed')).toBe('true')
    expect(button().getAttribute('aria-label')).toBe('Stop and transcribe')

    const context = FakeAudioContext.instances[0]
    const processor = context?.processors[0]
    if (context === undefined || processor === undefined) throw new Error('capture did not start')
    const captured = sine(48_000, 440, 4_800)
    act(() => { processor.emit(captured) })
    await flush()
    expect(container.querySelector('.voice-input-timer')?.textContent).toBe('0:00')

    act(() => { button().click() })
    await flush()

    const expected = audioBase64(encodeWave(resampleLinear(captured, 48_000, TARGET_RATE)))
    const calls = transcribe.mock.calls
    expect(calls.filter(([method]) => method === 'speech.catalog').length).toBe(1)
    const sent = calls.find(([method]) => method === 'speech.transcribe')
    expect(sent).toBeDefined()
    const payload = sent?.[1] as { request?: { audioBase64?: string; provider?: string; model?: string } }
    expect(payload.request?.audioBase64).toBe(expected)
    expect(payload.request?.provider).toBe('mock')
    expect(payload.request?.model).toBe('tiny')
    expect(onTranscript).toHaveBeenCalledWith('recognized speech')
    expect(draft()).toBe('hello recognized speech')
    expect(button().getAttribute('aria-pressed')).toBe('false')
  })

  it('reports a localized error when the host has no recognizer', async () => {
    const api = { rpc: vi.fn(async () => ({ providers: [], selection: null })) } as unknown as PanelApi
    const onError = vi.fn()
    function OnlyButton(): React.JSX.Element {
      return createElement(VoiceInputButton, {
        api,
        copy: {
          start: 'Start voice input', stopAndTranscribe: 'Stop and transcribe', cancel: 'Cancel',
          requesting: 'Waiting', recording: (duration: string) => duration, transcribing: 'Transcribing',
          unavailable: 'Voice input is unavailable',
          errors: {
            permission: 'permission', deviceMissing: 'deviceMissing', unsupported: 'unsupported',
            unavailable: 'no recognizer', tooLarge: 'tooLarge', transcribe: 'transcribe', empty: 'empty',
          },
        },
        disabled: false,
        onTranscript: () => undefined,
        onError,
      })
    }
    act(() => { root.render(createElement(OnlyButton)) })
    await flush()
    expect(button().disabled).toBe(true)
    expect(button().getAttribute('aria-label')).toBe('Voice input is unavailable')
    expect(onError).not.toHaveBeenCalled()
  })
})

/**
 * Microphone capture worklet for the side panel.
 *
 * The panel used to pull samples with the deprecated `ScriptProcessorNode`,
 * which Chrome reports as an extension error on every recording. A worklet runs
 * on the audio thread and posts each block of mono samples to the panel, which
 * keeps the existing resample-and-encode path unchanged.
 *
 * Loaded by URL (`chrome.runtime.getURL('pcm-capture.worklet.js')`) from the
 * panel page; it ships as plain JavaScript because Vite does not transform
 * worklet modules.
 */

class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0]
    if (channel !== undefined && channel.length > 0) {
      // Copy before transferring: the render quantum buffer is reused.
      const block = new Float32Array(channel)
      this.port.postMessage(block, [block.buffer])
    }
    // Returning true keeps the node alive until the panel disconnects it.
    return true
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor)

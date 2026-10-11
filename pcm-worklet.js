/**
 * @fileoverview AudioWorklet that resamples microphone audio to 16 kHz mono
 * Float32 frames (100 ms each) and posts them, with their RMS level, to the
 * offscreen document.
 */

const TARGET_SAMPLE_RATE = 16000;
const FRAME_SAMPLE_COUNT = 1600; // 100 ms at 16 kHz.

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_SAMPLE_RATE;
    this.buffer = new Float32Array(FRAME_SAMPLE_COUNT);
    this.filled = 0;
    this.carry = 0;
    this.previous = 0;
  }

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples || samples.length === 0) return true;

    // Linear interpolation from the device rate down to 16 kHz.
    let position = this.carry;
    while (position < samples.length) {
      const index = Math.floor(position);
      const fraction = position - index;
      const start = index === 0 ? this.previous : samples[index - 1];
      this.buffer[this.filled++] = start + (samples[index] - start) * fraction;
      if (this.filled === FRAME_SAMPLE_COUNT) {
        let sumSquares = 0;
        for (let i = 0; i < FRAME_SAMPLE_COUNT; i++) {
          sumSquares += this.buffer[i] * this.buffer[i];
        }
        const frame = this.buffer.slice();
        this.port.postMessage(
          {frame, rms: Math.sqrt(sumSquares / FRAME_SAMPLE_COUNT)},
          [frame.buffer],
        );
        this.filled = 0;
      }
      position += this.ratio;
    }
    this.carry = position - samples.length;
    this.previous = samples[samples.length - 1];
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);

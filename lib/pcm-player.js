/**
 * @fileoverview Plays the speech of a Gemini Live AUDIO session: 16-bit
 * little-endian mono PCM chunks (24 kHz), scheduled back to back with Web
 * Audio. Barge-in drops everything still scheduled, and an analyser reports
 * the output level (for the orb in the page bubble).
 */

/** Head start for the first chunk of an utterance, to absorb jitter. */
const LEAD_S = 0.05;
/** Playback counts as stopped after this long without scheduled audio. */
const IDLE_AFTER_MS = 300;

export class PcmPlayer {
  /** @param {{onActive: function(boolean)}} callbacks */
  constructor({onActive}) {
    this.onActive = onActive;
    this.context = null;
    this.analyser = null;
    this.levelBuffer = null;
    this.sources = new Set();
    this.nextTime = 0;
    this.active = false;
    this.idleTimer = 0;
  }

  /**
   * @param {!Uint8Array} bytes PCM16 little-endian mono.
   * @param {number} sampleRate
   */
  push(bytes, sampleRate) {
    const context = this.ensureContext();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frames = Math.floor(bytes.byteLength / 2);
    if (!frames) return;
    const buffer = context.createBuffer(1, frames, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) channel[i] = view.getInt16(i * 2, true) / 0x8000;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);
    const start = Math.max(this.nextTime, context.currentTime + LEAD_S);
    source.start(start);
    this.nextTime = start + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      if (!this.sources.size) this.scheduleIdle();
    };
    clearTimeout(this.idleTimer);
    this.setActive(true);
  }

  /** Barge-in: drops all audio still scheduled. */
  flush() {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    this.sources.clear();
    this.nextTime = 0;
    clearTimeout(this.idleTimer);
    this.setActive(false);
  }

  /** @return {number} The current output RMS level (0 to 1). */
  level() {
    if (!this.active || !this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuffer);
    let sum = 0;
    for (const sample of this.levelBuffer) sum += sample * sample;
    return Math.sqrt(sum / this.levelBuffer.length);
  }

  close() {
    this.flush();
    void this.context?.close().catch(() => {});
    this.context = null;
    this.analyser = null;
  }

  ensureContext() {
    if (!this.context) {
      this.context = new AudioContext({latencyHint: 'interactive'});
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.levelBuffer = new Float32Array(this.analyser.fftSize);
      this.analyser.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') void this.context.resume();
    return this.context;
  }

  scheduleIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.sources.size) this.setActive(false);
    }, IDLE_AFTER_MS);
  }

  setActive(active) {
    if (this.active === active) return;
    this.active = active;
    this.onActive(active);
  }
}

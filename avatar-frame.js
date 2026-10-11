/**
 * @fileoverview The avatar's video inside the page bubble.
 *
 * This extension-origin frame plays the Live Avatar stream relayed from the
 * offscreen session: fragmented MP4 (H.264 Constrained Baseline 704x1280 at
 * 24 fps + AAC-LC 24 kHz mono, a keyframe every 0.5 s) fed to a <video>
 * through Media Source Extensions. Running in the extension's origin keeps the
 * blob: media URL clear of the host page's CSP. The frame takes no input
 * (content.js owns all interaction).
 *
 * Playback: a fresh MediaSource per stream, playback kept near the live edge,
 * stale media trimmed, and a muted fallback when Chrome blocks sound until the
 * user interacts with the page.
 */

import {base64ToBytes} from './lib/bytes.js';
import {MODES, loadSettings, resolveAvatar} from './lib/config.js';

/** SourceBuffer types to try, best first. */
const MIME_TYPES = [
  'video/mp4; codecs="avc1.42E01F, mp4a.40.2"',
  'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
  'video/mp4',
];
/** Seconds of media kept behind the playhead... */
const KEEP_BEHIND_S = 8;
/** ...or, once the SourceBuffer is full, this many. */
const KEEP_BEHIND_WHEN_FULL_S = 1;
/** Stale media piles up to this many seconds before it's trimmed. */
const TRIM_SLACK_S = 4;
/** Playback further behind the live edge than this jumps ahead... */
const MAX_LAG_S = 2.5;
/** ...but a jump while the avatar speaks would clip words. */
const MAX_LAG_SPEAKING_S = 4;
/** Where a jump lands, behind the live edge. */
const LIVE_EDGE_MARGIN_S = 0.1;
/** While silent, playback further behind than this speeds up... */
const CATCH_UP_LAG_S = 0.3;
/** ...to at most this rate. */
const MAX_CATCH_UP_RATE = 1.15;
/** Lands this far into the media after a hole. */
const HOLE_SKIP_S = 0.05;
/** Minimum time between recoveries from a failed video. */
const RECOVER_COOLDOWN_MS = 1000;

class AvatarPlayer {
  /**
   * @param {!HTMLVideoElement} video
   * @param {{
   *   onLive: function(boolean),
   *   onSoundBlocked: function(boolean),
   *   onNeedInit: function(),
   * }} callbacks
   */
  constructor(video, callbacks) {
    this.video = video;
    this.callbacks = callbacks;
    this.streamId = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.objectUrl = '';
    this.queue = [];
    this.speaking = false;
    this.soundBlocked = false;
    this.frame = 0;
    this.lastRecoverAt = 0;
    video.addEventListener('playing', () => callbacks.onLive(true));
    video.addEventListener('error', () => this.recover(false));
  }

  /** @param {{streamId: number, init: boolean, data: string}} message */
  push({streamId, init, data}) {
    if (streamId !== this.streamId) {
      if (!init) return; // A stream must start with its init segment.
      this.start(streamId);
    }
    this.queue.push(base64ToBytes(data));
    this.pump();
  }

  /** The session ended: show the poster again. */
  end() {
    this.reset();
  }

  /** Barge-in: skip past speech still buffered. */
  flushToLive() {
    const buffered = this.video.buffered;
    if (!buffered.length) return;
    const liveEdge = buffered.end(buffered.length - 1);
    this.video.currentTime = Math.max(this.video.currentTime, liveEdge - LIVE_EDGE_MARGIN_S);
  }

  setSpeaking(speaking) {
    this.speaking = Boolean(speaking);
  }

  /** The user interacted with the page: try to play with sound again. */
  unlockSound() {
    if (!this.soundBlocked) return;
    const video = this.video;
    video.muted = false;
    video.play().then(
      () => this.setSoundBlocked(false),
      () => {
        video.muted = true;
        video.play().catch(() => {});
      },
    );
  }

  // ── Stream lifecycle ────────────────────────────────────────────────

  start(streamId) {
    this.reset();
    this.streamId = streamId;
    if (!window.MediaSource) {
      console.warn('[GLA] No Media Source Extensions; the avatar video cannot play.');
      return;
    }
    const mediaSource = new MediaSource();
    this.mediaSource = mediaSource;
    mediaSource.addEventListener('sourceopen', () => this.onSourceOpen(mediaSource), {once: true});
    this.objectUrl = URL.createObjectURL(mediaSource);
    this.video.src = this.objectUrl;
    this.loop();
  }

  reset() {
    cancelAnimationFrame(this.frame);
    this.streamId = null;
    this.queue = [];
    const mediaSource = this.mediaSource;
    this.mediaSource = null;
    this.sourceBuffer = null;
    if (mediaSource?.readyState === 'open') {
      try {
        mediaSource.endOfStream();
      } catch {
        // Closing early; nothing to finish.
      }
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = '';
      this.video.removeAttribute('src');
      this.video.load();
    }
    this.callbacks.onLive(false);
  }

  /** The video failed (decode error, or `force`: an append failed). */
  recover(force) {
    if (!this.objectUrl || (!force && !this.video.error)) return;
    if (Date.now() - this.lastRecoverAt < RECOVER_COOLDOWN_MS) return;
    this.lastRecoverAt = Date.now();
    console.warn(`[GLA] Avatar video failed (code ${this.video.error?.code ?? 'none'}); restarting it.`);
    this.reset();
    this.callbacks.onNeedInit();
  }

  onSourceOpen(mediaSource) {
    if (mediaSource !== this.mediaSource) return;
    const mimeType = MIME_TYPES.find((type) => MediaSource.isTypeSupported(type)) || 'video/mp4';
    try {
      const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
      sourceBuffer.mode = 'sequence';
      sourceBuffer.addEventListener('updateend', () => {
        if (sourceBuffer === this.sourceBuffer) this.onUpdateEnd();
      });
      this.sourceBuffer = sourceBuffer;
    } catch (err) {
      console.warn('[GLA] Cannot play the avatar video:', err);
      return;
    }
    this.pump();
  }

  // ── SourceBuffer ────────────────────────────────────────────────────

  pump() {
    const sourceBuffer = this.sourceBuffer;
    if (!sourceBuffer || sourceBuffer.updating || !this.queue.length) return;
    if (this.mediaSource?.readyState !== 'open') return;
    const bytes = this.queue.shift();
    try {
      sourceBuffer.appendBuffer(bytes);
    } catch (err) {
      if (err?.name === 'QuotaExceededError') {
        this.queue.unshift(bytes);
        if (!this.trim(true)) this.queue.shift(); // Nothing to free: skip it.
      } else {
        console.warn('[GLA] appendBuffer failed:', err);
        this.recover(true);
      }
    }
  }

  onUpdateEnd() {
    if (this.video.paused && this.video.buffered.length) this.play();
    if (this.trim(false)) return;
    this.pump();
  }

  /** @return {boolean} Whether a removal started (the buffer is busy). */
  trim(full) {
    const sourceBuffer = this.sourceBuffer;
    const buffered = this.video.buffered;
    if (!sourceBuffer || sourceBuffer.updating || !buffered.length) return false;
    const start = buffered.start(0);
    const end = this.video.currentTime - (full ? KEEP_BEHIND_WHEN_FULL_S : KEEP_BEHIND_S);
    if (end - start <= (full ? 0 : TRIM_SLACK_S)) return false;
    try {
      sourceBuffer.remove(start, end);
      return true;
    } catch {
      return false; // Mid-transition; the next update retries.
    }
  }

  // ── Playback ────────────────────────────────────────────────────────

  play() {
    const video = this.video;
    video.play().catch((err) => {
      if (err?.name !== 'NotAllowedError' || video.muted) return;
      // Sound needs a user gesture on the page: play muted until one.
      video.muted = true;
      this.setSoundBlocked(true);
      video.play().catch(() => {});
    });
  }

  setSoundBlocked(blocked) {
    if (this.soundBlocked === blocked) return;
    this.soundBlocked = blocked;
    this.callbacks.onSoundBlocked(blocked);
  }

  loop() {
    cancelAnimationFrame(this.frame);
    const step = () => {
      this.frame = requestAnimationFrame(step);
      this.keepLive();
    };
    this.frame = requestAnimationFrame(step);
  }

  keepLive() {
    const video = this.video;
    const buffered = video.buffered;
    if (!buffered.length || video.paused) return;
    const time = video.currentTime;
    const liveEdge = buffered.end(buffered.length - 1);
    const lag = liveEdge - time;
    if (lag > (this.speaking ? MAX_LAG_SPEAKING_S : MAX_LAG_S)) {
      video.currentTime = liveEdge - LIVE_EDGE_MARGIN_S;
      video.playbackRate = 1;
      return;
    }
    // Stalled in a hole (frames dropped up to a keyframe): skip past it.
    let inRange = false;
    let nextStart = Infinity;
    for (let i = 0; i < buffered.length; i++) {
      const start = buffered.start(i);
      if (time >= start && time < buffered.end(i)) {
        inRange = true;
      } else if (start > time) {
        nextStart = Math.min(nextStart, start);
      }
    }
    if (!inRange && nextStart !== Infinity) {
      video.currentTime = nextStart + HOLE_SKIP_S;
      return;
    }
    const rate = !this.speaking && lag > CATCH_UP_LAG_S
      ? Math.min(MAX_CATCH_UP_RATE, 1 + lag * 0.2)
      : 1;
    if (video.playbackRate !== rate) video.playbackRate = rate;
  }
}

// ── Wiring ─────────────────────────────────────────────────────────────

const video = /** @type {!HTMLVideoElement} */ (document.getElementById('video'));
const poster = /** @type {!HTMLImageElement} */ (document.getElementById('poster'));
const orb = /** @type {!HTMLElement} */ (document.getElementById('orb'));
let port = null;
/** The running session's mode; null when idle (the saved setting applies). */
let sessionMode = null;

const player = new AvatarPlayer(video, {
  onLive: (live) => video.classList.toggle('live', live),
  onSoundBlocked: (blocked) => port?.postMessage({type: 'sound', blocked}),
  onNeedInit: () => port?.postMessage({type: 'need-init'}),
});

/** Shows the avatar's portrait/video, or the orb in voice-only mode. */
async function render() {
  const settings = await loadSettings();
  const voiceOnly = (sessionMode || settings.mode) === MODES.LIVE;
  orb.hidden = !voiceOnly;
  poster.hidden = voiceOnly;
  video.hidden = voiceOnly;
  if (!voiceOnly) poster.src = resolveAvatar({...settings, mode: MODES.AVATAR}).poster;
}
void render();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) void render();
});

function setLevels(user, model) {
  const scale = (rms) => Math.min(1, Math.max(0, Number(rms) * 4 || 0)).toFixed(3);
  orb.style.setProperty('--user', scale(user));
  orb.style.setProperty('--model', scale(model));
}

port = chrome.runtime.connect({name: 'gla-video'});
port.onMessage.addListener((message) => {
  switch (message?.type) {
    case 'mode':
      sessionMode = message.mode;
      void render();
      break;
    case 'media':
      player.push(message);
      break;
    case 'level':
      setLevels(message.user, message.model);
      break;
    case 'end':
      player.end();
      setLevels(0, 0);
      sessionMode = null;
      void render();
      break;
    case 'interrupted':
      player.flushToLive();
      break;
    case 'speaking':
      player.setSpeaking(message.value);
      document.body.classList.toggle('speaking', Boolean(message.value));
      break;
    case 'gesture':
      player.unlockSound();
      break;
  }
});
port.onDisconnect.addListener(() => {
  void chrome.runtime.lastError;
  port = null;
  player.end();
});

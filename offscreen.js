/**
 * @fileoverview Offscreen document: owns the Gemini Live session.
 *
 * It holds the Live API WebSocket and the microphone, so the conversation
 * survives page navigations while the in-page bubble is re-created on each
 * one. Two ports connect from the attached tab:
 *   - 'gla-page'  (content.js): page context and controls in; state,
 *     captions, and mic level out.
 *   - 'gla-video' (avatar-frame.js): in avatar mode, the avatar's fragmented
 *     MP4 (the init segment first for a frame that joins mid-stream); in live
 *     (voice-only) mode, voice levels for the orb. Live mode's speech is
 *     played here (PcmPlayer), so it's never blocked by page autoplay rules.
 *
 * Page awareness: the page's text goes into the system instruction; later
 * navigations and text selections are added as `clientContent` turns with
 * `turnComplete: false` (absorbed silently, no reply); and screenshots of the
 * visible tab go in as `realtimeInput.video` frames.
 */

import {base64ToBytes, bytesToBase64, concatBytes} from './lib/bytes.js';
import {MODES} from './lib/config.js';
import {Fmp4BoxAligner} from './lib/fmp4.js';
import {buildSetupMessage, liveSocketUrl} from './lib/live.js';
import {PcmPlayer} from './lib/pcm-player.js';

/** The bubble gone this long (e.g. on an unsupported page) ends the session. */
const NO_PAGE_TIMEOUT_MS = 60000;
/** Silence sent upstream this often while the mic isn't streaming. */
const KEEPALIVE_MS = 5000;
/** Reconnects with session resumption before giving up. */
const MAX_RESUMES = 3;
/** Recent transcript lines carried into a restarted session. */
const MAX_HISTORY = 24;
/** 100 ms of 16 kHz PCM16 silence. */
const SILENCE_BASE64 = bytesToBase64(new Uint8Array(3200));
const GREETING =
  '(The user just opened you on this web page. Greet them in one short, ' +
  'friendly sentence that shows you know what page they are on.)';
/** Lets the model write to the Drive memory folder (see lib/drive.js). */
const SAVE_MEMORY_TOOL = {
  functionDeclarations: [{
    name: 'save_memory',
    description:
      "Saves a long-term memory to the user's Google Drive memory folder, so you remember it in future conversations.",
    parameters: {
      type: 'OBJECT',
      properties: {
        memory: {
          type: 'STRING',
          description: 'What to remember, as one short, self-contained sentence (e.g. "The user\'s dog is named Biscuit.").',
        },
      },
      required: ['memory'],
    },
  }],
};

const state = {
  attachedTabId: null,
  /** Start as soon as the attached page reports its context. */
  autoStartPending: false,
  /** 'idle' | 'connecting' | 'live' | 'error' */
  phase: 'idle',
  error: '',
  /** '' | 'credentials' | 'mic' */
  errorCode: '',
  micMuted: false,
  speaking: false,
  /** The frame could only autoplay muted; it needs a user gesture. */
  soundBlocked: false,
  avatarName: '',
  /** The user wants a session (drives reconnects). */
  wantLive: false,
  ws: null,
  streamId: 0,
  resumeHandle: null,
  resumes: 0,
  goAway: false,
  /** {settings, avatar, credential} of the current session. */
  config: null,
  /** Drive memories: {enabled, folderName, canWrite, text, error}. */
  memories: null,
  systemInstruction: '',
  page: null,
  sentPageKey: '',
  lastSelection: '',
  screenDirty: true,
  lastShotAt: 0,
  shotInFlight: false,
  lastAudioAt: 0,
  captions: {user: '', model: ''},
  history: [],
  pagePort: null,
  videoPort: null,
  noPageTimer: 0,
};

const aligner = new Fmp4BoxAligner();
const textDecoder = new TextDecoder();
const mic = {stream: null, context: null, node: null};
/** Plays live (voice-only) mode's speech; its activity is the speaking state. */
const player = new PcmPlayer({
  onActive: (active) => {
    if (isLiveMode()) setSpeaking(active);
  },
});

/** @return {boolean} Whether the session is voice-only Gemini Live. */
function isLiveMode() {
  return state.config?.settings?.mode === MODES.LIVE;
}

// ── Wiring ───────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;
  if (message.type === 'attach') {
    if (state.attachedTabId !== message.tabId) {
      state.attachedTabId = message.tabId;
      disconnect(state.pagePort);
      disconnect(state.videoPort);
      state.pagePort = state.videoPort = null;
    }
    if (message.autoStart && (state.phase === 'idle' || state.phase === 'error')) {
      state.autoStartPending = true;
    }
  }
  sendResponse({ok: true});
  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined || tabId !== state.attachedTabId) {
    // A stale bubble (e.g. restored from the back/forward cache).
    if (port.name === 'gla-page') port.postMessage({type: 'remove'});
    port.disconnect();
    return;
  }
  if (port.name === 'gla-page') connectPage(port);
  if (port.name === 'gla-video') connectVideo(port);
});

function connectPage(port) {
  disconnect(state.pagePort);
  state.pagePort = port;
  clearTimeout(state.noPageTimer);
  port.onMessage.addListener((message) => {
    if (port === state.pagePort) onPageMessage(message);
  });
  port.onDisconnect.addListener(() => {
    if (state.pagePort !== port) return;
    state.pagePort = null;
    if (state.wantLive) {
      state.noPageTimer = setTimeout(() => {
        if (!state.pagePort) stopSession();
      }, NO_PAGE_TIMEOUT_MS);
    }
  });
  postState();
}

function connectVideo(port) {
  disconnect(state.videoPort);
  state.videoPort = port;
  state.soundBlocked = false;
  port.onMessage.addListener((message) => {
    if (port !== state.videoPort) return;
    if (message?.type === 'sound') {
      state.soundBlocked = Boolean(message.blocked);
      postState();
    } else if (message?.type === 'need-init') {
      sendInit(port);
    }
  });
  port.onDisconnect.addListener(() => {
    if (state.videoPort === port) state.videoPort = null;
  });
  if (state.config) port.postMessage({type: 'mode', mode: state.config.settings.mode});
  port.postMessage({type: 'speaking', value: state.speaking});
  sendInit(port);
}

/**
 * Lets a frame join the stream midway: it starts from the init segment, and
 * media resumes at the next keyframe (at most 0.5 s away).
 */
function sendInit(port) {
  if (!state.ws || !aligner.init) return;
  port.postMessage({
    type: 'media',
    streamId: state.streamId,
    init: true,
    data: bytesToBase64(aligner.init),
  });
}

function onPageMessage(message) {
  switch (message?.type) {
    case 'hello':
    case 'context':
      onPageContext(message.context);
      if (state.autoStartPending) {
        state.autoStartPending = false;
        void startSession();
      }
      break;
    case 'selection':
      onSelection(String(message.text || ''));
      break;
    case 'dirty':
      state.screenDirty = true;
      break;
    case 'start':
      void startSession();
      break;
    case 'mic':
      setMicMuted(Boolean(message.muted));
      break;
    case 'gesture':
      postVideo({type: 'gesture'});
      break;
  }
}

function disconnect(port) {
  try {
    port?.disconnect();
  } catch {
    // Already gone.
  }
}

function postPage(message) {
  try {
    state.pagePort?.postMessage(message);
  } catch {
    // The page is navigating away.
  }
}

function postVideo(message) {
  try {
    state.videoPort?.postMessage(message);
  } catch {
    // The page is navigating away.
  }
}

function postState() {
  postPage({
    type: 'state',
    phase: state.phase,
    error: state.error,
    errorCode: state.errorCode,
    micMuted: state.micMuted,
    speaking: state.speaking,
    soundBlocked: state.soundBlocked,
    avatarName: state.avatarName,
  });
}

function setPhase(phase) {
  state.phase = phase;
  if (phase !== 'error') {
    state.error = '';
    state.errorCode = '';
  }
  postState();
}

function setSpeaking(speaking) {
  if (state.speaking === speaking) return;
  state.speaking = speaking;
  postVideo({type: 'speaking', value: speaking});
  postState();
}

async function askBackground(message) {
  return chrome.runtime.sendMessage({target: 'background', ...message});
}

// ── Session ──────────────────────────────────────────────────────────────

async function startSession({resume = false} = {}) {
  if (state.ws || (state.phase === 'connecting' && !resume)) return;
  state.wantLive = true;
  setPhase('connecting');

  const config = await askBackground({type: 'get-session-config'}).catch(
    (err) => ({error: String(err?.message || err)}),
  );
  if (!state.wantLive || state.ws) return;
  if (!config || config.error) {
    fail(config?.error || 'No session config.', config?.code || '');
    return;
  }
  state.config = config;
  state.avatarName = config.avatar.name;

  try {
    await startMic();
  } catch (err) {
    stopMic();
    const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
    if (denied) void askBackground({type: 'open-options', hash: 'mic'}).catch(() => {});
    fail(
      denied
        ? 'Allow microphone access in the tab that just opened, then tap me again.'
        : `Microphone unavailable: ${err?.message || err}`,
      'mic',
    );
    return;
  }
  if (!state.wantLive || state.ws) return;

  if (!resume) {
    state.memories = await loadMemories();
    if (!state.wantLive || state.ws) return;
    state.systemInstruction = buildSystemInstruction(config, state.page, state.history, state.memories);
    state.sentPageKey = pageKey(state.page);
    state.lastSelection = state.page?.selection || '';
  }
  postVideo({type: 'mode', mode: config.settings.mode});
  openSocket(config, resume);
}

/** @return {!Promise<!Object>} The Drive memories (see state.memories). */
async function loadMemories() {
  const memories = await askBackground({type: 'load-memories'}).catch(
    (err) => ({enabled: true, error: String(err?.message || err)}),
  );
  if (memories?.error) {
    postPage({type: 'caption', role: 'system', text: `Drive memories are off for now: ${memories.error}`, final: true});
  }
  return memories || {enabled: false};
}

/** @return {!Array<!Object>} Live API tools for this session. */
function sessionTools() {
  const memories = state.memories;
  return memories?.enabled && !memories.error && memories.canWrite ? [SAVE_MEMORY_TOOL] : [];
}

function openSocket(config, resume) {
  const ws = new WebSocket(liveSocketUrl(config.settings, config.credential));
  ws.binaryType = 'arraybuffer';
  state.ws = ws;
  state.streamId += 1;
  const streamId = state.streamId;
  aligner.reset();

  ws.onopen = () => {
    if (state.ws !== ws) return;
    ws.send(JSON.stringify(buildSetupMessage({
      settings: config.settings,
      avatar: config.avatar,
      systemInstruction: state.systemInstruction,
      resumeHandle: resume ? state.resumeHandle : null,
      tools: sessionTools(),
    })));
  };
  ws.onmessage = (event) => {
    if (state.ws === ws) onServerMessage(event.data, streamId, resume);
  };
  ws.onclose = (event) => {
    if (state.ws === ws) onSocketClosed(event);
  };
}

function send(message) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(message));
}

/** Runs the model's function calls (save_memory) and answers them. */
async function onToolCall({functionCalls = []}) {
  const ws = state.ws;
  const functionResponses = [];
  for (const call of functionCalls) {
    let response;
    if (call.name === 'save_memory') {
      const memory = String(call.args?.memory || '').trim();
      const result = await askBackground({type: 'save-memory', memory}).catch(
        (err) => ({error: String(err?.message || err)}),
      );
      response = result?.ok
        ? {result: "Saved to the user's Google Drive memory folder."}
        : {error: result?.error || 'Saving failed.'};
      postPage({
        type: 'caption',
        role: result?.ok ? 'note' : 'system',
        text: result?.ok ? `Remembered: ${memory}` : `Couldn't save that memory: ${result?.error}`,
        final: true,
      });
    } else {
      response = {error: `Unknown function: ${call.name}`};
    }
    functionResponses.push({id: call.id, name: call.name, response});
  }
  // A reconnect meanwhile means a new session that never made these calls.
  if (state.ws === ws) send({toolResponse: {functionResponses}});
}

function onServerMessage(data, streamId, resumed) {
  let message;
  try {
    message = JSON.parse(typeof data === 'string' ? data : textDecoder.decode(data));
  } catch {
    return;
  }
  if (message.setupComplete) onSetupComplete(resumed);
  if (message.toolCall) void onToolCall(message.toolCall);
  const update = message.sessionResumptionUpdate;
  if (update?.resumable && update.newHandle) state.resumeHandle = update.newHandle;
  if (message.goAway) {
    // The connection is about to hit its time limit: resume on a new one
    // once the avatar isn't mid-sentence.
    state.goAway = true;
    if (!state.speaking) reconnect();
  }

  const content = message.serverContent;
  if (!content) return;
  const live = isLiveMode();
  for (const part of content.modelTurn?.parts || []) {
    const inline = part.inlineData;
    if (!inline?.data) continue;
    const mimeType = String(inline.mimeType || '');
    if (mimeType.startsWith('video/')) {
      onVideo(inline.data, streamId);
    } else if (mimeType.startsWith('audio/pcm')) {
      // Voice-only mode: e.g. "audio/pcm;rate=24000".
      const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1]) || 24000;
      player.push(base64ToBytes(inline.data), rate);
    }
  }
  if (content.inputTranscription?.text) {
    appendCaption('user', content.inputTranscription.text);
  }
  if (content.outputTranscription?.text) {
    // In voice mode the player's activity drives the speaking state.
    if (!live) setSpeaking(true);
    appendCaption('model', content.outputTranscription.text);
  }
  if (content.interrupted) {
    // Barge-in: drop the speech still buffered (frame video or local audio).
    if (live) {
      player.flush();
    } else {
      postVideo({type: 'interrupted'});
    }
    finishCaption('model', true);
  }
  if (content.turnComplete || content.interrupted) {
    finishCaption('user');
    finishCaption('model');
    if (!live) setSpeaking(false);
    if (state.goAway) reconnect();
  }
}

function onSetupComplete(resumed) {
  state.resumes = 0;
  state.goAway = false;
  state.screenDirty = true;
  setPhase('live');
  if (resumed) return;
  // The page may have changed while connecting.
  if (state.page && pageKey(state.page) !== state.sentPageKey) onPageContext(state.page);
  send({realtimeInput: {text: GREETING}});
}

function onVideo(base64, streamId) {
  const {init, media} = aligner.push(base64ToBytes(base64));
  if ((!init && !media) || !state.videoPort) return;
  const bytes = init && media ? concatBytes([init, media]) : init || media;
  postVideo({type: 'media', streamId, init: Boolean(init), data: bytesToBase64(bytes)});
}

function reconnect() {
  if (!state.wantLive || !state.resumeHandle || state.resumes >= MAX_RESUMES) return;
  state.goAway = false;
  state.resumes += 1;
  closeSocket();
  void startSession({resume: true});
}

function onSocketClosed(event) {
  state.ws = null;
  const wasLive = state.phase === 'live';
  if (!state.wantLive) {
    setPhase('idle');
    return;
  }
  if (wasLive && state.resumeHandle && state.resumes < MAX_RESUMES) {
    console.warn(`[GLA] Session closed (${event.code} ${event.reason}); resuming.`);
    state.resumes += 1;
    void startSession({resume: true});
    return;
  }
  if (!wasLive && event.code === 1006) {
    // A refused handshake (bad key or token, no model access) shows up in
    // the browser only as an abnormal closure.
    fail(
      isLiveMode()
        ? 'Could not connect to the Gemini Live API. Check the API key and model in Options.'
        : 'Could not connect to the Live API. Check the credentials, project, and location in Options.',
      'credentials',
    );
    return;
  }
  fail(`The session closed${event.reason ? `: ${event.reason}` : ` (code ${event.code})`}.`);
}

function closeSocket() {
  const ws = state.ws;
  state.ws = null;
  if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000);
}

function endSession() {
  state.wantLive = false;
  state.autoStartPending = false;
  closeSocket();
  stopMic();
  player.close();
  aligner.reset();
  state.resumeHandle = null;
  state.resumes = 0;
  state.goAway = false;
  postVideo({type: 'end'});
  finishCaption('user');
  finishCaption('model');
  setSpeaking(false);
}

function stopSession() {
  endSession();
  setPhase('idle');
}

function fail(message, code = '') {
  console.warn('[GLA]', message);
  endSession();
  state.error = message;
  state.errorCode = code;
  setPhase('error');
}

// ── Microphone ───────────────────────────────────────────────────────────

async function startMic() {
  if (mic.stream) return;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  const context = new AudioContext();
  Object.assign(mic, {stream, context, node: null});
  try {
    await context.audioWorklet.addModule('pcm-worklet.js');
    if (mic.stream !== stream) throw new Error('The microphone was stopped.');
    const node = new AudioWorkletNode(context, 'pcm-capture');
    node.port.onmessage = (event) => onMicFrame(event.data);
    context.createMediaStreamSource(stream).connect(node);
    mic.node = node;
    if (context.state !== 'running') await context.resume();
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
    if (mic.stream === stream) Object.assign(mic, {stream: null, context: null, node: null});
    throw err;
  }
}

function stopMic() {
  mic.node?.port.close();
  mic.node?.disconnect();
  void mic.context?.close().catch(() => {});
  for (const track of mic.stream?.getTracks() || []) track.stop();
  Object.assign(mic, {stream: null, context: null, node: null});
}

function onMicFrame({frame, rms}) {
  // Only listen while the bubble is on screen and the mic isn't muted.
  const streaming = state.phase === 'live' && !state.micMuted && Boolean(state.pagePort);
  if (state.phase === 'live') postPage({type: 'level', rms: streaming ? rms : 0});
  // Voice-only mode: the orb in the frame follows both voices.
  if (isLiveMode() && state.videoPort) {
    postVideo({type: 'level', user: streaming ? rms : 0, model: player.level()});
  }
  if (!streaming) return;
  send({
    realtimeInput: {
      audio: {data: floatToPcm16Base64(frame), mimeType: 'audio/pcm;rate=16000'},
    },
  });
  state.lastAudioAt = Date.now();
}

function setMicMuted(muted) {
  if (state.micMuted === muted) return;
  state.micMuted = muted;
  postState();
}

function floatToPcm16Base64(samples) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return bytesToBase64(new Uint8Array(pcm.buffer));
}

setInterval(() => {
  if (state.phase !== 'live' || Date.now() - state.lastAudioAt < KEEPALIVE_MS) return;
  send({realtimeInput: {audio: {data: SILENCE_BASE64, mimeType: 'audio/pcm;rate=16000'}}});
  state.lastAudioAt = Date.now();
}, 1000);

// ── Page awareness ───────────────────────────────────────────────────────

function onPageContext(context) {
  if (!context) return;
  state.page = context;
  state.screenDirty = true;
  if (state.phase !== 'live') return;
  const key = pageKey(context);
  if (key === state.sentPageKey) return;
  state.sentPageKey = key;
  state.lastSelection = context.selection || '';
  sendContext(
    '[Browser update, not spoken by the user] The user is now looking at this page:\n' +
      describePage(context),
  );
}

function onSelection(text) {
  const selection = text.trim().slice(0, 2000);
  if (state.page) state.page.selection = selection;
  if (state.phase !== 'live' || !selection || selection === state.lastSelection) return;
  state.lastSelection = selection;
  sendContext(
    '[Browser update, not spoken by the user] The user highlighted this text on the page:\n' +
      `"""\n${selection}\n"""`,
  );
}

/** Adds context the model absorbs without replying. */
function sendContext(text) {
  send({clientContent: {turns: [{role: 'user', parts: [{text}]}], turnComplete: false}});
}

function pageKey(page) {
  return page ? `${page.url}\n${page.text.length}\n${page.text.slice(0, 300)}` : '';
}

function describePage(page) {
  if (!page) return '(The page content is not available yet.)';
  const lines = [`Title: ${page.title || '(untitled)'}`, `URL: ${page.url}`];
  if (page.description) lines.push(`Description: ${page.description}`);
  if (page.selection) lines.push(`Text the user has highlighted: "${page.selection}"`);
  lines.push(
    `Page text${page.truncated ? ' (truncated)' : ''}:`,
    '"""',
    page.text || '(no readable text)',
    '"""',
  );
  return lines.join('\n');
}

function buildSystemInstruction({settings, avatar}, page, history, memories) {
  const name = avatar.name;
  const bubble = settings.mode === MODES.LIVE
    ? 'a small, round, glowing orb that pulses with your voice'
    : 'a small, round, animated video bubble of your face';
  const lines = [
    String(settings.persona || '').trim() || avatar.persona,
    '',
    '## WHERE YOU ARE',
    `You appear as ${name}: ${bubble}, floating over the web page the user is viewing in Chrome. The user can drag you anywhere on the page and talks with you by voice.`,
    '',
    '## WHAT YOU KNOW ABOUT THE PAGE',
    '- The text of the page the user is viewing is below. Messages starting with "[Browser update" tell you when the user moves to another page or highlights text. They are not spoken by the user: never reply to them on their own; use them when the user talks to you.',
    '- You also receive screenshots of the visible part of the page, so you can see what the user sees, including images and layout. The round bubble in them is you; ignore it.',
    '- When the user asks about the page, ground your answer in it. If something is not on the page, say so instead of guessing.',
    '- You cannot click, scroll, type, or open pages for the user; you can only look and talk.',
    '',
    '## HOW YOU TALK',
    '- Everything you say is spoken aloud. Use natural spoken words only: no markdown, lists, emojis, stage directions, or reading out long URLs.',
    '- Keep replies short and conversational, one to three sentences, unless the user asks for more.',
    `- Do not start your replies with your own name (e.g. "${name}:"). Just start talking.`,
    '- Never repeat yourself; keep the conversation moving.',
  ];
  if (memories?.enabled && !memories.error) {
    lines.push(
      '',
      '## LONG-TERM MEMORY',
      `- You have a long-term memory: the user's Google Drive folder "${memories.folderName}". What it holds is below, under YOUR MEMORIES.`,
      memories.canWrite
        ? "- When the user tells you something worth remembering across conversations (facts about them, their preferences or plans, or anything they ask you to remember), call save_memory with one short, self-contained sentence, then confirm in a few words. Don't save page content unless asked."
        : "- The folder is read-only for you, so you can't save new memories; say so if asked.",
      "- Use your memories naturally when they're relevant; don't recite them unprompted.",
      '',
      '## YOUR MEMORIES',
      '"""',
      memories.text || '(No memories yet.)',
      '"""',
    );
  }
  lines.push('', '## CURRENT PAGE', describePage(page));
  if (history.length) {
    lines.push(
      '',
      '## CONVERSATION SO FAR (before a reconnect)',
      ...history.map(({role, text}) => `${role === 'user' ? 'User' : name}: ${text}`),
    );
  }
  return lines.join('\n');
}

// Screenshots of the visible tab, when the page changed since the last one.
setInterval(() => {
  const seconds = Number(state.config?.settings?.screenshotSeconds) || 0;
  if (
    seconds <= 0 || state.phase !== 'live' || !state.pagePort ||
    !state.screenDirty || state.shotInFlight ||
    Date.now() - state.lastShotAt < seconds * 1000
  ) {
    return;
  }
  void captureScreenshot();
}, 500);

async function captureScreenshot() {
  state.shotInFlight = true;
  state.screenDirty = false;
  try {
    const response = await askBackground({type: 'capture-tab', tabId: state.attachedTabId});
    if (response?.data && state.phase === 'live') {
      send({realtimeInput: {video: {data: response.data, mimeType: 'image/jpeg'}}});
    } else {
      state.screenDirty = true; // The tab is in the background; retry later.
    }
  } catch {
    state.screenDirty = true;
  } finally {
    state.lastShotAt = Date.now();
    state.shotInFlight = false;
  }
}

// ── Captions ─────────────────────────────────────────────────────────────

function appendCaption(role, chunk) {
  if (role === 'model' && state.captions.user) finishCaption('user');
  state.captions[role] += chunk;
  postPage({type: 'caption', role, text: state.captions[role].trim(), final: false});
}

function finishCaption(role, interrupted = false) {
  const text = state.captions[role].trim();
  state.captions[role] = '';
  if (!text) return;
  postPage({type: 'caption', role, text: interrupted ? `${text}…` : text, final: true});
  state.history.push({role, text});
  if (state.history.length > MAX_HISTORY) state.history.shift();
}

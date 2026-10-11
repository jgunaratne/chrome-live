/**
 * @fileoverview Gemini Live API helpers, shared by the offscreen document and
 * the options page. Two session modes (see MODES in config.js):
 *
 *   avatar: Vertex AI (v1), `responseModalities: ["VIDEO"]` with
 *       `avatarConfig`: a lip-synced avatar as fragmented MP4. OAuth token
 *       passed as the `access_token` query parameter.
 *   live: Gemini API (v1beta, AI Studio key passed as `key`),
 *       `responseModalities: ["AUDIO"]`: 24 kHz PCM speech, with a thinking
 *       level for thinking models such as gemini-3.8-live-extended-thinking.
 *
 * Both use transcriptions, voice activity detection, context window
 * compression, and session resumption. `turnCoverage` stays at its default so
 * page screenshots sent between turns remain part of the user's turn.
 */

import {MODES} from './config.js';

/**
 * Avatar video bitrate. The page bubble is ~150 px, and 0.5 Mbps keeps the
 * (continuous, even while idle) stream to ~70 KB/s.
 */
export const VIDEO_BITRATE_BPS = 500000;

const VERTEX_WS_PATH =
  '/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent';
const GEMINI_API_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/**
 * @param {!Object} settings
 * @param {string} credential An OAuth access token (avatar mode) or a Gemini
 *     API key (live mode).
 * @return {string}
 */
export function liveSocketUrl(settings, credential) {
  if (settings.mode === MODES.LIVE) {
    return `${GEMINI_API_WS_URL}?key=${encodeURIComponent(credential)}`;
  }
  const host = settings.location === 'global'
    ? 'aiplatform.googleapis.com'
    : `${settings.location}-aiplatform.googleapis.com`;
  return `wss://${host}${VERTEX_WS_PATH}?access_token=${encodeURIComponent(credential)}`;
}

/**
 * @param {!Object} settings
 * @return {string} The model name the setup message needs.
 */
export function modelResource(settings) {
  if (settings.mode === MODES.LIVE) return `models/${settings.liveModel}`;
  const {project, location, model} = settings;
  return `projects/${project}/locations/${location}/publishers/google/models/${model}`;
}

/**
 * @param {{
 *   settings: !Object,
 *   avatar: !Object,
 *   systemInstruction: string,
 *   resumeHandle: (?string|undefined),
 *   tools: (?Array<!Object>|undefined),
 * }} options `tools`: Live API tools (function declarations), if any.
 * @return {!Object} The BidiGenerateContent setup message.
 */
export function buildSetupMessage({settings, avatar, systemInstruction, resumeHandle, tools}) {
  const live = settings.mode === MODES.LIVE;
  const generationConfig = {
    responseModalities: [live ? 'AUDIO' : 'VIDEO'],
    speechConfig: {
      voiceConfig: {prebuiltVoiceConfig: {voiceName: settings.voice || avatar.voice}},
    },
  };
  if (live) {
    if (settings.thinkingLevel) {
      generationConfig.thinkingConfig = {thinkingLevel: settings.thinkingLevel};
    }
  } else {
    generationConfig.temperature = 0.6;
  }
  return {
    setup: {
      model: modelResource(settings),
      generationConfig,
      ...(live ? {} : {avatarConfig: {avatarName: avatar.id, videoBitrateBps: VIDEO_BITRATE_BPS}}),
      systemInstruction: {parts: [{text: systemInstruction}]},
      ...(tools?.length ? {tools} : {}),
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
          endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
          silenceDurationMs: 600,
          prefixPaddingMs: 100,
        },
      },
      contextWindowCompression: {
        triggerTokens: '100000',
        slidingWindow: {targetTokens: '60000'},
      },
      // Lets a dropped or time-limited connection resume the conversation.
      sessionResumption: resumeHandle ? {handle: resumeHandle} : {},
    },
  };
}

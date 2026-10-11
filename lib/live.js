/**
 * @fileoverview Gemini Live API (Vertex AI, v1) helpers for Live Avatar
 * sessions, shared by the offscreen document and the options page.
 *
 * The setup message is the raw BidiGenerateContent JSON: VIDEO modality,
 * `avatarConfig`, transcriptions, voice activity detection, context window
 * compression, and session resumption. `turnCoverage` stays at its default so
 * page screenshots sent between turns remain part of the user's turn.
 */

/**
 * Avatar video bitrate. The page bubble is ~150 px, and 0.5 Mbps keeps the
 * (continuous, even while idle) stream to ~70 KB/s.
 */
export const VIDEO_BITRATE_BPS = 500000;

const WS_PATH =
  '/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent';

/**
 * @param {{location: string}} settings
 * @param {string} accessToken
 * @return {string}
 */
export function liveSocketUrl({location}, accessToken) {
  const host = location === 'global'
    ? 'aiplatform.googleapis.com'
    : `${location}-aiplatform.googleapis.com`;
  return `wss://${host}${WS_PATH}?access_token=${encodeURIComponent(accessToken)}`;
}

/**
 * @param {{project: string, location: string, model: string}} settings
 * @return {string} The fully-qualified Vertex publisher model name.
 */
export function modelResource({project, location, model}) {
  return `projects/${project}/locations/${location}/publishers/google/models/${model}`;
}

/**
 * @param {{
 *   settings: !Object,
 *   avatar: !Object,
 *   systemInstruction: string,
 *   resumeHandle: (?string|undefined),
 * }} options
 * @return {!Object} The BidiGenerateContent setup message.
 */
export function buildSetupMessage({settings, avatar, systemInstruction, resumeHandle}) {
  return {
    setup: {
      model: modelResource(settings),
      generationConfig: {
        responseModalities: ['VIDEO'],
        temperature: 0.6,
        speechConfig: {
          voiceConfig: {prebuiltVoiceConfig: {voiceName: settings.voice || avatar.voice}},
        },
      },
      avatarConfig: {avatarName: avatar.id, videoBitrateBps: VIDEO_BITRATE_BPS},
      systemInstruction: {parts: [{text: systemInstruction}]},
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

/**
 * @fileoverview Settings and the avatar catalog, shared by the service
 * worker, the options page, and the in-page video frame.
 */

/** Poster images of the prebuilt Gemini 3.8 Live avatars. */
const POSTER_BASE =
  'https://www.gstatic.com/pantheon/images/aiplatform/vertex_ai_studio/avatars';

/**
 * Prebuilt avatars (`avatarConfig.avatarName`) and their paired default
 * voices. Available to any project with access to gemini-3.8-live.
 */
const PREBUILT = [
  ['Kai', 'kai.png', 'Rasalgethi'],
  ['Ben', 'ben.png', 'Puck'],
  ['Carmen', 'carmen_2.png', 'Gacrux'],
  ['Ingrid', 'ingrid.png', 'Leda'],
  ['Jay', 'jay.png', 'Alnilam'],
  ['Kira', 'kira.png', 'Kore'],
  ['Leo', 'leo.png', 'Algenib'],
  ['Paul', 'paul.png', 'Charon'],
  ['Piper', 'piper.png', 'Sulafat'],
  ['Sam', 'sam.png', 'Sadaltager'],
  ['Vera', 'vera.png', 'Pulcherrima'],
];

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   poster: string,
 *   voice: string,
 *   persona: string,
 * }} AvatarInfo
 *   `id` is the prebuilt avatar name sent as `avatarConfig.avatarName`;
 *   `poster` the portrait shown until the video plays.
 */

/** @type {!Array<!AvatarInfo>} */
export const AVATARS = PREBUILT.map(([name, img, voice]) => ({
  id: name,
  name,
  poster: `${POSTER_BASE}/${img}`,
  voice,
  persona: companionPersona(name),
}));

/**
 * Session modes:
 *   'avatar': Live Avatar on Vertex AI (gemini-3.8-live, VIDEO output);
 *       needs a Google Cloud project and OAuth credentials.
 *   'live': standard Gemini Live on the Gemini API (AI Studio key), voice
 *       only (gemini-3.8-live-extended-thinking by default).
 *   'chat': typed chat with a standard Gemini model on the Gemini API (AI
 *       Studio key); replies stream as text into a panel by the bubble.
 */
export const MODES = Object.freeze({AVATAR: 'avatar', LIVE: 'live', CHAT: 'chat'});

/** @return {boolean} Whether `mode` talks by voice (avatar or live). */
export function isVoiceMode(mode) {
  return mode === MODES.AVATAR || mode === MODES.LIVE;
}

/**
 * Thinking levels for Gemini Live mode. gemini-3.8-live-extended-thinking
 * requires one (LOW, MEDIUM, or HIGH); '' sends none, for models that don't
 * think.
 */
export const THINKING_LEVELS = ['LOW', 'MEDIUM', 'HIGH', ''];

/** The assistant of Gemini Live and text chat modes (shown as an orb). */
const LIVE_ASSISTANT = Object.freeze({
  id: 'gemini',
  name: 'Gemini',
  poster: '',
  voice: 'Kore',
  persona: companionPersona('Gemini'),
});

function companionPersona(name) {
  return `You are ${name}, a warm, curious, and knowledgeable companion who lives in the user's web browser. ` +
    'You help the user understand, summarize, and explore whatever web page they are looking at, and you are happy to chat about anything else too.';
}

/** The prebuilt Gemini Live HD voices. */
export const VOICES = [
  ['Achernar', 'Female', 'Soft'], ['Achird', 'Male', 'Friendly'],
  ['Algenib', 'Male', 'Gravelly'], ['Algieba', 'Male', 'Smooth'],
  ['Alnilam', 'Male', 'Firm'], ['Aoede', 'Female', 'Breezy'],
  ['Autonoe', 'Female', 'Bright'], ['Callirrhoe', 'Female', 'Easy-going'],
  ['Charon', 'Male', 'Informative'], ['Despina', 'Female', 'Smooth'],
  ['Enceladus', 'Male', 'Breathy'], ['Erinome', 'Female', 'Clear'],
  ['Fenrir', 'Male', 'Excitable'], ['Gacrux', 'Female', 'Mature'],
  ['Iapetus', 'Male', 'Clear'], ['Kore', 'Female', 'Firm'],
  ['Laomedeia', 'Female', 'Upbeat'], ['Leda', 'Female', 'Youthful'],
  ['Orus', 'Male', 'Firm'], ['Puck', 'Male', 'Upbeat'],
  ['Pulcherrima', 'Female', 'Forward'], ['Rasalgethi', 'Male', 'Informative'],
  ['Sadachbia', 'Male', 'Lively'], ['Sadaltager', 'Male', 'Knowledgeable'],
  ['Schedar', 'Male', 'Even'], ['Sulafat', 'Female', 'Warm'],
  ['Umbriel', 'Male', 'Easy-going'], ['Vindemiatrix', 'Female', 'Gentle'],
  ['Zephyr', 'Female', 'Bright'], ['Zubenelgenubi', 'Male', 'Casual'],
].map(([name, gender, style]) => ({name, gender, style}));

export const DEFAULT_SETTINGS = Object.freeze({
  /** 'avatar' (Vertex AI Live Avatar), 'live' (Gemini API, voice only), or 'chat' (typed). */
  mode: MODES.AVATAR,
  /** The voice mode the bubble's keyboard button switches back to. */
  voiceMode: MODES.AVATAR,
  /** Google Cloud project with access to gemini-3.8-live (avatar mode). */
  project: '',
  location: 'us-central1',
  model: 'gemini-3.8-live',
  /** An OAuth access token, or an authorized_user ADC JSON (auto-refresh). */
  credentials: '',
  /** Gemini API key from Google AI Studio (live mode). */
  apiKey: '',
  liveModel: 'gemini-3.8-live-extended-thinking',
  thinkingLevel: 'LOW',
  /** Text chat mode's model (Gemini API). */
  chatModel: 'gemini-flash-latest',
  avatar: 'Kira',
  /** Empty: the avatar's default voice. */
  voice: '',
  /** Empty: the avatar's default persona. */
  persona: '',
  /** How often the visible page is screenshotted for the avatar; 0 = never. */
  screenshotSeconds: 3,
  /**
   * Google Drive folder (link or ID) for long-term memories; empty = off.
   * Uses `credentials`, which then need the Drive scope.
   */
  memoryFolder: '',
});

/** @return {!Promise<!Object>} Saved settings over the defaults. */
export async function loadSettings() {
  const {settings} = await chrome.storage.local.get('settings');
  return {...DEFAULT_SETTINGS, ...(settings || {})};
}

/**
 * @param {!Object} settings
 * @return {!AvatarInfo} The selected avatar, or the Gemini assistant (an
 *     orb) in live and chat modes.
 */
export function resolveAvatar(settings) {
  if (settings.mode !== MODES.AVATAR) return LIVE_ASSISTANT;
  return AVATARS.find((a) => a.id === settings.avatar) ||
    AVATARS.find((a) => a.id === DEFAULT_SETTINGS.avatar);
}

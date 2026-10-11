/**
 * @fileoverview Service worker: puts the avatar on a tab and keeps it there.
 *
 * - The toolbar button attaches the avatar to the current tab (moving it from
 *   another tab, keeping the conversation) or, on the tab it is on, closes it.
 * - The Live session itself runs in the offscreen document (offscreen.js),
 *   which survives navigations, so the conversation continues as the user
 *   browses; this worker re-injects the bubble (content.js) after each
 *   navigation of the attached tab.
 * - It also serves the Chrome APIs the offscreen document lacks: settings and
 *   access tokens, screenshots of the visible tab, and memories in Google
 *   Drive (lib/drive.js).
 */

import {getAccessToken, quotaProjectFor} from './lib/auth.js';
import {bytesToBase64} from './lib/bytes.js';
import {MODES, isVoiceMode, loadSettings, resolveAvatar} from './lib/config.js';
import {DriveMemory, parseFolderId} from './lib/drive.js';

const OFFSCREEN_URL = 'offscreen.html';
/** Screenshots are downscaled to at most this width before upload. */
const SCREENSHOT_MAX_WIDTH = 1280;

// ── Attachment ───────────────────────────────────────────────────────────

/** @return {!Promise<?number>} The tab the avatar is on. */
async function getAttachedTabId() {
  const {attachedTabId} = await chrome.storage.session.get('attachedTabId');
  return typeof attachedTabId === 'number' ? attachedTabId : null;
}

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  void (async () => {
    if ((await getAttachedTabId()) === tab.id) {
      await detach();
    } else {
      await attach(tab.id);
    }
  })().catch((err) => console.error('[GLA] Toggle failed:', err));
});

async function attach(tabId) {
  const previous = await getAttachedTabId();
  await chrome.storage.session.set({attachedTabId: tabId});
  if (previous !== null && previous !== tabId) await removeBubble(previous);
  await ensureOffscreen();
  // autoStart: start talking as soon as the page has sent its context.
  await sendToOffscreen({type: 'attach', tabId, autoStart: true});
  if (!(await injectBubble(tabId))) {
    await detach();
    await chrome.action.setBadgeText({tabId, text: '!'});
    await chrome.action.setTitle({
      tabId,
      title: "The Gemini Live Avatar can't run on this page.",
    });
  }
}

async function detach() {
  const tabId = await getAttachedTabId();
  await chrome.storage.session.remove('attachedTabId');
  if (tabId !== null) await removeBubble(tabId);
  // Closing the offscreen document ends the session and releases the mic.
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}

/** @return {!Promise<boolean>} Whether the bubble could be injected. */
async function injectBubble(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: {tabId, frameIds: [0]},
      files: ['content.js'],
    });
    return true;
  } catch (err) {
    console.warn(`[GLA] Cannot show the avatar on tab ${tabId}:`, err?.message || err);
    return false;
  }
}

async function removeBubble(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, {type: 'gla-remove'}, {frameId: 0});
  } catch {
    // The tab is gone or never had the bubble.
  }
}

// The bubble lives in the page, so every navigation of the attached tab
// needs a fresh one; the offscreen session carries on underneath.
chrome.webNavigation.onDOMContentLoaded.addListener(({tabId, frameId}) => {
  if (frameId !== 0) return;
  void (async () => {
    if ((await getAttachedTabId()) !== tabId) return;
    await ensureOffscreen();
    await sendToOffscreen({type: 'attach', tabId, autoStart: false});
    await injectBubble(tabId);
  })().catch((err) => console.error('[GLA] Re-inject failed:', err));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void getAttachedTabId().then((attached) => {
    if (attached === tabId) return detach();
  });
});

// ── Offscreen document ───────────────────────────────────────────────────

let creatingOffscreen = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification:
        'Streams the microphone to the Gemini Live Avatar conversation, which continues across page navigations.',
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

/** Messages the offscreen document, waiting for it to finish loading. */
async function sendToOffscreen(message) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await chrome.runtime.sendMessage({target: 'offscreen', ...message});
    } catch (err) {
      if (attempt >= 20) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

// ── Requests from the offscreen document and the bubble ───────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'background') return false;
  handleRequest(message, sender).then(sendResponse, (err) =>
    sendResponse({error: String(err?.message || err)}),
  );
  return true;
});

async function handleRequest(message, sender) {
  switch (message.type) {
    case 'get-session-config':
      return getSessionConfig();
    case 'capture-tab':
      return {data: await captureTab(message.tabId)};
    case 'open-options':
      await chrome.tabs.create({
        url: chrome.runtime.getURL(`options.html${message.hash ? `#${message.hash}` : ''}`),
      });
      return {ok: true};
    case 'detach':
      if (sender.tab?.id === (await getAttachedTabId())) await detach();
      return {ok: true};
    case 'ensure-offscreen': {
      // A bubble lost its connection (e.g. the offscreen document closed).
      const attached = await getAttachedTabId();
      if (sender.tab?.id !== attached) return {attached: false};
      await ensureOffscreen();
      await sendToOffscreen({type: 'attach', tabId: attached, autoStart: false});
      return {attached: true};
    }
    case 'switch-mode':
      return switchMode();
    case 'load-memories':
      return loadMemories();
    case 'save-memory':
      return saveMemory(String(message.memory || ''));
    default:
      return {error: `Unknown request: ${message.type}`};
  }
}

// ── Memories in Google Drive ─────────────────────────────────────────────

/** @return {!Promise<?DriveMemory>} null when memories are off. */
async function memoryStore() {
  const settings = await loadSettings();
  if (!settings.memoryFolder.trim()) return null;
  const folderId = parseFolderId(settings.memoryFolder);
  if (!folderId) throw new Error('The memory folder setting is not a Google Drive folder link.');
  if (!settings.credentials.trim()) {
    throw new Error('Drive memories need Google credentials with Drive access in Options.');
  }
  return new DriveMemory({
    token: await getAccessToken(settings.credentials),
    folderId,
    quotaProject: quotaProjectFor(settings.credentials, settings.project),
  });
}

async function loadMemories() {
  try {
    const store = await memoryStore();
    if (!store) return {enabled: false};
    const {folder, text, files} = await store.load();
    return {enabled: true, folderName: folder.name, canWrite: folder.canWrite, text, files};
  } catch (err) {
    return {enabled: true, error: err.message};
  }
}

/** Saves run one at a time, so concurrent appends can't overwrite each other. */
let saveQueue = Promise.resolve();

function saveMemory(memory) {
  const run = saveQueue.then(async () => {
    if (!memory.trim()) return {error: 'The memory was empty.'};
    try {
      const store = await memoryStore();
      if (!store) return {error: 'Memories are turned off.'};
      await store.append(memory);
      return {ok: true};
    } catch (err) {
      return {error: err.message};
    }
  });
  saveQueue = run;
  return run;
}

/**
 * The bubble's keyboard button: text chat, or back to the last voice mode.
 * @return {!Promise<{mode: string}>}
 */
async function switchMode() {
  const settings = await loadSettings();
  const {settings: stored} = await chrome.storage.local.get('settings');
  // Settings saved before voiceMode existed: guess from what's set up.
  const voiceMode = isVoiceMode(stored?.voiceMode)
    ? stored.voiceMode
    : settings.apiKey.trim() && !settings.project ? MODES.LIVE : MODES.AVATAR;
  const mode = settings.mode === MODES.CHAT ? voiceMode : MODES.CHAT;
  await chrome.storage.local.set({
    settings: {...settings, mode, voiceMode: isVoiceMode(settings.mode) ? settings.mode : voiceMode},
  });
  return {mode};
}

async function getSessionConfig() {
  const {credentials, apiKey, ...settings} = await loadSettings();
  const avatar = resolveAvatar(settings);
  if (settings.mode === MODES.LIVE || settings.mode === MODES.CHAT) {
    if (!apiKey.trim()) {
      return {error: 'Paste your Gemini API key (from Google AI Studio) in the extension options.', code: 'credentials'};
    }
    return {settings, avatar, credential: apiKey.trim()};
  }
  if (!settings.project) {
    return {error: 'Set your Google Cloud project in the extension options.', code: 'credentials'};
  }
  try {
    return {settings, avatar, credential: await getAccessToken(credentials)};
  } catch (err) {
    return {error: err.message, code: 'credentials'};
  }
}

/**
 * @return {!Promise<?string>} A base64 JPEG of the tab's visible area, or
 *     null when the tab isn't the one showing in its window.
 */
async function captureTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.active) return null;
  const win = await chrome.windows.get(tab.windowId);
  if (win.state === 'minimized') return null;
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: 'jpeg',
    quality: 70,
  });
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = Math.min(1, SCREENSHOT_MAX_WIDTH / bitmap.width);
  if (scale === 1) {
    bitmap.close();
    return dataUrl.slice(dataUrl.indexOf(',') + 1);
  }
  const canvas = new OffscreenCanvas(
    Math.round(bitmap.width * scale),
    Math.round(bitmap.height * scale),
  );
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await canvas.convertToBlob({type: 'image/jpeg', quality: 0.7});
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

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
 *   access tokens, and screenshots of the visible tab.
 */

import {getAccessToken} from './lib/auth.js';
import {bytesToBase64} from './lib/bytes.js';
import {loadSettings, resolveAvatar} from './lib/config.js';

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
    default:
      return {error: `Unknown request: ${message.type}`};
  }
}

async function getSessionConfig() {
  const {credentials, ...settings} = await loadSettings();
  if (!settings.project) {
    return {error: 'Set your Google Cloud project in the extension options.', code: 'credentials'};
  }
  let accessToken;
  try {
    accessToken = await getAccessToken(credentials);
  } catch (err) {
    return {error: err.message, code: 'credentials'};
  }
  return {settings, avatar: resolveAvatar(settings), accessToken};
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

/**
 * @fileoverview Options page: connection, microphone permission, avatar.
 *
 * Settings save automatically. The microphone is granted here, in an
 * extension page, because the offscreen document that streams it cannot show
 * a permission prompt itself.
 */

import {getAccessToken} from './lib/auth.js';
import {AVATARS, DEFAULT_SETTINGS, VOICES, loadSettings, resolveAvatar} from './lib/config.js';
import {buildSetupMessage, liveSocketUrl} from './lib/live.js';

const $ = (id) => document.getElementById(id);
const fields = ['project', 'location', 'model', 'credentials', 'voice', 'persona', 'screenshotSeconds'];

let settings = await loadSettings();

// ── Settings form ────────────────────────────────────────────────────────

function renderAvatars() {
  const grid = $('avatars');
  grid.textContent = '';
  for (const avatar of AVATARS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'avatar';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(avatar.id === settings.avatar));
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = avatar.poster;
    const name = document.createElement('span');
    name.textContent = avatar.name;
    button.append(img, name);
    button.addEventListener('click', () => {
      settings.avatar = avatar.id;
      renderAvatars();
      renderVoiceAndPersona();
      save();
    });
    grid.append(button);
  }
}

function renderVoiceAndPersona() {
  const avatar = resolveAvatar(settings);
  const select = $('voice');
  select.textContent = '';
  const defaultOption = new Option(`Default for ${avatar.name} (${avatar.voice})`, '');
  select.append(defaultOption);
  for (const gender of ['Female', 'Male']) {
    const group = document.createElement('optgroup');
    group.label = gender;
    for (const voice of VOICES.filter((v) => v.gender === gender)) {
      group.append(new Option(`${voice.name} · ${voice.style}`, voice.name));
    }
    select.append(group);
  }
  select.value = settings.voice || '';
  $('persona').placeholder = avatar.persona;
}

function fillForm() {
  for (const field of ['project', 'location', 'model', 'credentials', 'persona', 'screenshotSeconds']) {
    $(field).value = settings[field] ?? '';
  }
  renderAvatars();
  renderVoiceAndPersona();
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    for (const field of fields) {
      const value = $(field).value;
      settings[field] = field === 'screenshotSeconds'
        ? Math.max(0, Math.min(60, Number(value) || 0))
        : field === 'credentials' || field === 'persona'
          ? value.trim()
          : value.trim() || DEFAULT_SETTINGS[field];
    }
    await chrome.storage.local.set({settings});
    setStatus($('save-status'), 'Saved. Changes apply to the next conversation.', 'ok');
  }, 300);
}

for (const field of fields) {
  $(field).addEventListener('input', save);
  $(field).addEventListener('change', save);
}
$('show-credentials').addEventListener('change', (event) => {
  $('credentials').classList.toggle('revealed', event.target.checked);
});

function setStatus(node, text, kind = '') {
  node.textContent = text;
  node.className = `status ${kind}`;
}

// ── Connection test ──────────────────────────────────────────────────────

$('test').addEventListener('click', async () => {
  const button = $('test');
  const status = $('test-status');
  button.disabled = true;
  clearTimeout(saveTimer);
  save();
  await new Promise((resolve) => setTimeout(resolve, 350));
  try {
    setStatus(status, 'Connecting…');
    const current = await loadSettings();
    if (!current.project) throw new Error('Set your Google Cloud project first.');
    const accessToken = await getAccessToken(current.credentials, {forceRefresh: true});
    const avatar = resolveAvatar(current);
    const result = await probeSession(current, avatar, accessToken);
    setStatus(status, result, 'ok');
  } catch (err) {
    setStatus(status, err.message || String(err), 'error');
  } finally {
    button.disabled = false;
  }
});

/** Opens a Live Avatar session and closes it once set up. */
function probeSession(current, avatar, accessToken) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(liveSocketUrl(current, accessToken));
    ws.binaryType = 'arraybuffer';
    let done = false;
    const finish = (error, message) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (ws.readyState <= WebSocket.OPEN) ws.close(1000);
      if (error) reject(new Error(error));
      else resolve(message);
    };
    const timer = setTimeout(() => finish('Timed out waiting for the Live API.'), 20000);
    ws.onopen = () => {
      ws.send(JSON.stringify(buildSetupMessage({
        settings: current,
        avatar,
        systemInstruction: 'Connection test.',
      })));
    };
    ws.onmessage = (event) => {
      const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
      if (text.includes('"setupComplete"')) {
        finish(null, `Connected: ${current.model} in ${current.project} is ready with ${avatar.name}.`);
      }
    };
    ws.onclose = (event) => {
      finish(
        event.reason
          ? `The Live API closed the session: ${event.reason}`
          : `Could not connect (code ${event.code}). Check the credentials, project, and location.`,
      );
    };
  });
}

// ── Microphone ───────────────────────────────────────────────────────────

async function refreshMicStatus() {
  const status = $('mic-status');
  try {
    const permission = await navigator.permissions.query({name: 'microphone'});
    const describe = () => {
      if (permission.state === 'granted') {
        setStatus(status, 'Allowed.', 'ok');
      } else if (permission.state === 'denied') {
        setStatus(status, 'Blocked: allow it from the site settings icon in the address bar.', 'error');
      } else {
        setStatus(status, 'Not allowed yet.');
      }
    };
    permission.onchange = describe;
    describe();
  } catch {
    setStatus(status, '');
  }
}

async function requestMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio: true});
    for (const track of stream.getTracks()) track.stop();
    setStatus($('mic-status'), 'Allowed. Go back to your tab and tap the avatar.', 'ok');
  } catch (err) {
    setStatus($('mic-status'), `Not allowed (${err.name}). Allow it from the site settings icon in the address bar.`, 'error');
  }
}

$('mic-button').addEventListener('click', requestMic);

fillForm();
void refreshMicStatus();
if (location.hash === '#mic') {
  $('mic').classList.add('highlight');
  $('mic').scrollIntoView();
  void requestMic();
}

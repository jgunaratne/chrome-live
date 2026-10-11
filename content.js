/**
 * @fileoverview The draggable avatar bubble on the page.
 *
 * Injected by the service worker into the tab the avatar is attached to, and
 * again after each navigation. It draws the bubble in a closed shadow root:
 * the avatar video (an extension-origin iframe, avatar-frame.html, that takes
 * no input), a status ring, a badge, captions, and mic / settings / close
 * buttons. It owns all pointer input (drag anywhere to move it, tap to talk)
 * and tells the offscreen session what is on the page: the page text on load
 * and URL changes, the user's text selection, and when the page changed (so a
 * fresh screenshot is taken). It also carries out the model's pointing and,
 * with browser control on, its clicks, typing, key presses, and scrolling.
 */
(() => {
  const existing = globalThis.__geminiLiveAvatar;
  if (existing) {
    existing.revive();
    return;
  }

  /** Bubble diameter (px). */
  const SIZE = 148;
  /** Minimum gap to the viewport edges. */
  const EDGE = 8;
  /** Room kept below the bubble for its badge. */
  const BADGE_ROOM = 36;
  const DRAG_THRESHOLD = 4;
  const MAX_PAGE_TEXT = 10000;
  const MAX_SELECTION = 2000;
  const CAPTION_HIDE_MS = 6000;
  const POSITION_KEY = 'bubblePosition';
  const FRAME_URL = chrome.runtime.getURL('avatar-frame.html');

  /** Material Symbols paths (24x24). */
  const ICONS = {
    mic: 'M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z',
    micOff: 'M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3 3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z',
    keyboard: 'M20 5H4c-1.1 0-1.99.9-1.99 2L2 17c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  };

  const CSS = `
    .gla {
      position: absolute;
      inset: 0;
      font: 500 13px/1.4 "Google Sans", Roboto, system-ui, -apple-system, "Segoe UI", sans-serif;
      color: #1f1f1f;
      -webkit-font-smoothing: antialiased;
      user-select: none;
      -webkit-user-select: none;
      --level: 0;
    }
    .ring {
      position: absolute;
      inset: -5px;
      border-radius: 50%;
      background: conic-gradient(#4285f4, #9b72cb, #d96570, #f9ab00, #34a853, #4285f4);
      opacity: 0.5;
      transition: opacity 0.3s, transform 0.12s ease-out;
    }
    .gla[data-phase="connecting"] .ring { opacity: 1; animation: gla-spin 1.1s linear infinite; }
    .gla[data-phase="live"] .ring {
      opacity: calc(0.45 + var(--level) * 1.5);
      transform: scale(calc(1 + var(--level) * 0.12));
    }
    .gla[data-phase="live"][data-speaking="true"] .ring {
      opacity: 1;
      transform: none;
      animation: gla-spin 2.4s linear infinite;
    }
    .gla[data-phase="live"].muted .ring { opacity: 0.3; transform: none; filter: grayscale(1); }
    .gla[data-phase="error"] .ring { background: #d93025; opacity: 0.85; }
    .frame {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      overflow: hidden;
      background: #202124;
      box-shadow: 0 0 0 3px #fff, 0 8px 28px rgba(0, 0, 0, 0.35);
    }
    .video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
      background: transparent;
      color-scheme: normal;
      pointer-events: none;
    }
    .hit {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      cursor: grab;
      touch-action: none;
      outline: none;
    }
    .hit:focus-visible { box-shadow: 0 0 0 3px #1a73e8; }
    .gla.dragging .hit { cursor: grabbing; }
    .badge {
      position: absolute;
      left: 50%;
      top: calc(100% + 10px);
      transform: translateX(-50%);
      padding: 4px 11px;
      border-radius: 999px;
      background: rgba(32, 33, 36, 0.9);
      color: #fff;
      font-size: 12px;
      white-space: nowrap;
      pointer-events: none;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    .btn {
      position: absolute;
      width: 32px;
      height: 32px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: #fff;
      color: #3c4043;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      cursor: pointer;
      opacity: 0;
      transform: scale(0.85);
      transition: opacity 0.15s, transform 0.15s;
    }
    .btn[hidden] { display: none; }
    .btn:hover { background: #f1f3f4; }
    .btn svg { width: 18px; height: 18px; fill: currentColor; pointer-events: none; }
    .gla:hover .btn, .gla:focus-within .btn, .gla.show-controls .btn { opacity: 1; transform: none; }
    .btn.mic { left: -8px; bottom: 2px; }
    .btn.settings { left: -8px; top: 2px; }
    .btn.close { right: -8px; top: 2px; }
    .btn.keyboard { right: -8px; bottom: 2px; }
    .panel {
      position: absolute;
      left: 0;
      top: 0;
      display: none;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08), 0 10px 36px rgba(0, 0, 0, 0.32);
    }
    .panel.show { display: block; }
    .panel iframe { display: block; width: 100%; height: 100%; border: 0; }
    .btn.mic[aria-pressed="true"] { background: #d93025; color: #fff; opacity: 1; transform: none; }
    .caption {
      position: absolute;
      left: 0;
      bottom: calc(100% + 16px);
      box-sizing: border-box;
      width: max-content;
      max-width: 280px;
      padding: 9px 13px 10px;
      border-radius: 16px;
      background: #fff;
      color: #1f1f1f;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.28);
      font-size: 13.5px;
      font-weight: 400;
      line-height: 1.45;
      pointer-events: none;
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 0.2s, transform 0.2s;
    }
    .caption.below { bottom: auto; top: calc(100% + 46px); transform: translateY(-6px); }
    .caption.show { opacity: 1; transform: none; }
    .caption .who {
      margin-bottom: 2px;
      color: #1a73e8;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .caption[data-role="user"] .who, .caption[data-role="user"] .text { color: #5f6368; }
    .caption[data-role="user"] .text { font-style: italic; }
    .caption[data-role="system"] .who { color: #d93025; }
    .caption[data-role="note"] .who { color: #188038; }
    @keyframes gla-spin { to { transform: rotate(1turn); } }
    @media (prefers-reduced-motion: reduce) { .ring { animation: none !important; } }
  `;

  // ── DOM ────────────────────────────────────────────────────────────────

  const host = document.createElement('gemini-live-avatar');
  const hostStyle = {
    all: 'initial',
    position: 'fixed',
    'z-index': '2147483647',
    left: '0px',
    top: '0px',
    width: `${SIZE}px`,
    height: `${SIZE}px`,
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    'pointer-events': 'auto',
  };
  for (const [name, value] of Object.entries(hostStyle)) {
    host.style.setProperty(name, value, 'important');
  }
  const shadow = host.attachShadow({mode: 'closed'});
  addStyles(shadow, CSS);

  const root = element('div', 'gla');
  const ring = element('div', 'ring');
  const frameBox = element('div', 'frame');
  const iframe = document.createElement('iframe');
  iframe.className = 'video';
  iframe.allow = 'autoplay';
  iframe.tabIndex = -1;
  iframe.setAttribute('aria-hidden', 'true');
  iframe.src = FRAME_URL;
  frameBox.append(iframe);
  const hit = element('div', 'hit');
  hit.tabIndex = 0;
  hit.setAttribute('role', 'button');
  const badge = element('div', 'badge');
  const micButton = iconButton('mic', ICONS.mic);
  const settingsButton = iconButton('settings', ICONS.settings);
  settingsButton.setAttribute('aria-label', 'Avatar settings');
  settingsButton.title = 'Settings';
  const closeButton = iconButton('close', ICONS.close);
  closeButton.setAttribute('aria-label', 'Close the avatar');
  closeButton.title = 'Close';
  const keyboardButton = iconButton('keyboard', ICONS.keyboard);
  // Text chat mode's panel; its frame loads the first time it opens.
  const panel = element('div', 'panel');
  const caption = element('div', 'caption');
  const captionWho = element('div', 'who');
  const captionText = element('div', 'text');
  captionText.setAttribute('aria-live', 'polite');
  caption.append(captionWho, captionText);
  root.append(ring, frameBox, hit, badge, micButton, settingsButton, closeButton, keyboardButton, caption);
  shadow.append(root, panel);
  document.documentElement.append(host);

  function addStyles(shadowRoot, css) {
    try {
      // Constructed stylesheets aren't subject to the page's CSP.
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadowRoot.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = css;
      shadowRoot.append(style);
    }
  }

  /** Built node by node: pages may forbid innerHTML (Trusted Types). */
  function svgElement(tag, attributes, children = []) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    node.append(...children);
    return node;
  }

  function element(tag, className) {
    const node = document.createElement(tag);
    node.className = className;
    return node;
  }

  function iconButton(className, path) {
    const button = element('button', `btn ${className}`);
    button.type = 'button';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', path);
    svg.append(shape);
    button.append(svg);
    return button;
  }

  // ── State from the offscreen session ─────────────────────────────────────

  let view = {
    phase: 'idle',
    error: '',
    errorCode: '',
    micMuted: false,
    speaking: false,
    soundBlocked: false,
    avatarName: '',
    /** The running session's mode; '' when none (savedMode applies). */
    mode: '',
    /** Text chat: a reply is on its way. */
    busy: false,
  };
  /** The mode in the settings, for when no session is running. */
  let savedMode = '';
  let port = null;
  let removed = false;
  let reconnectTimer = 0;
  let captionTimer = 0;

  function connect() {
    if (removed) return;
    try {
      port = chrome.runtime.connect({name: 'gla-page'});
    } catch {
      teardown(); // The extension was reloaded or removed.
      return;
    }
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      if (removed) return;
      if (!chrome.runtime?.id) {
        teardown();
        return;
      }
      scheduleReconnect();
    });
    const context = readPage();
    lastTextLength = context.text.length;
    post({type: 'hello', context});
  }

  /** The session went away (e.g. the offscreen document closed): rejoin. */
  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(async () => {
      if (removed || port) return;
      try {
        const response = await chrome.runtime.sendMessage({
          target: 'background',
          type: 'ensure-offscreen',
        });
        if (!response?.attached) throw new Error('Not attached');
      } catch {
        teardown();
        return;
      }
      iframe.src = FRAME_URL; // Its port reconnects with it.
      if (chatFrame) chatFrame.src = CHAT_URL;
      connect();
    }, 400);
  }

  function post(message) {
    try {
      port?.postMessage(message);
    } catch {
      // Disconnected; onDisconnect handles it.
    }
  }

  function onMessage(message) {
    switch (message?.type) {
      case 'state': {
        const newError = message.phase === 'error' && message.error !== view.error;
        view = {...view, ...message};
        render();
        if (newError) showCaption('system', message.error, true);
        if (message.phase !== 'live') setLevel(0);
        break;
      }
      case 'caption':
        showCaption(message.role, String(message.text || ''), Boolean(message.final));
        break;
      case 'level':
        setLevel(message.rms);
        break;
      case 'point':
        post({type: 'point-result', id: message.id, ...pointAt(message)});
        break;
      case 'act':
        void act(message).then((result) => post({type: 'act-result', id: message.id, ...result}));
        break;
      case 'chat-hide':
        setChatOpen(false);
        break;
      case 'remove':
        teardown();
        break;
    }
  }

  function currentMode() {
    return view.mode || savedMode;
  }

  function render() {
    root.dataset.phase = view.phase;
    root.dataset.speaking = String(view.speaking);
    root.classList.toggle('muted', view.micMuted);
    const chat = currentMode() === 'chat';
    micButton.hidden = view.phase !== 'live' || chat;
    keyboardButton.querySelector('path').setAttribute('d', chat ? ICONS.mic : ICONS.keyboard);
    keyboardButton.setAttribute('aria-label', chat ? 'Switch to voice' : 'Switch to typing');
    keyboardButton.title = chat ? 'Talk instead' : 'Type instead';
    renderPanel();
    micButton.setAttribute('aria-pressed', String(view.micMuted));
    micButton.setAttribute('aria-label', view.micMuted ? 'Unmute microphone' : 'Mute microphone');
    micButton.title = view.micMuted ? 'Unmute' : 'Mute';
    micButton.querySelector('path').setAttribute('d', view.micMuted ? ICONS.micOff : ICONS.mic);
    badge.textContent = badgeText();
    hit.title = view.phase === 'error' ? view.error : '';
    hit.setAttribute(
      'aria-label',
      `${view.avatarName || 'Gemini Live Avatar'}: ${badge.textContent} Drag to move.`,
    );
  }

  function badgeText() {
    const chat = currentMode() === 'chat';
    if (view.phase === 'live' && view.soundBlocked && !chat) return 'Tap to hear me';
    if (chat && view.phase === 'live') {
      if (view.busy) return 'Thinking…';
      return chatOpen ? 'Chatting' : 'Tap to chat';
    }
    if (chat && view.phase === 'idle') return 'Tap to chat';
    switch (view.phase) {
      case 'connecting':
        return 'Connecting…';
      case 'live':
        if (view.micMuted) return 'Mic muted';
        return view.speaking ? 'Speaking…' : 'Listening…';
      case 'error':
        if (view.errorCode === 'credentials') return 'Set up access ›';
        if (view.errorCode === 'mic') return 'Allow mic, then tap';
        return 'Tap to retry';
      default:
        return 'Tap to talk';
    }
  }

  function setLevel(rms) {
    const level = Math.min(1, Math.max(0, Number(rms) * 8 || 0));
    root.style.setProperty('--level', level.toFixed(3));
  }

  function showCaption(role, text, final) {
    if (!text) return;
    const labels = {user: 'You', model: view.avatarName || 'Avatar', note: 'Memory'};
    captionWho.textContent = labels[role] || 'Gemini Live Avatar';
    captionText.textContent = text.length > 240 ? `…${text.slice(-240)}` : text;
    caption.dataset.role = role;
    caption.classList.add('show');
    placeCaption();
    clearTimeout(captionTimer);
    const hideAfter = role === 'system' ? 10000 : final ? CAPTION_HIDE_MS : 15000;
    captionTimer = setTimeout(() => caption.classList.remove('show'), hideAfter);
  }

  // ── Position & dragging ──────────────────────────────────────────────────

  let position = {left: 0, top: 0};
  let drag = null;

  function viewport() {
    const html = document.documentElement;
    const standards = document.compatMode === 'CSS1Compat';
    return {
      width: Math.min(innerWidth, html.clientWidth || innerWidth),
      height: standards ? html.clientHeight || innerHeight : innerHeight,
    };
  }

  function placeAt(left, top) {
    const {width, height} = viewport();
    position = {
      left: Math.round(Math.min(Math.max(EDGE, left), Math.max(EDGE, width - SIZE - EDGE))),
      top: Math.round(Math.min(Math.max(EDGE, top), Math.max(EDGE, height - SIZE - BADGE_ROOM))),
    };
    host.style.setProperty('left', `${position.left}px`, 'important');
    host.style.setProperty('top', `${position.top}px`, 'important');
    placeCaption();
    placePanel();
  }

  /** Keeps the caption on screen: above the bubble, or below near the top. */
  function placeCaption() {
    const {width} = viewport();
    caption.classList.toggle('below', position.top < 150);
    const captionWidth = caption.offsetWidth || 280;
    const centered = SIZE / 2 - captionWidth / 2;
    const left = Math.max(
      EDGE - position.left,
      Math.min(centered, width - EDGE - position.left - captionWidth),
    );
    caption.style.left = `${Math.round(left)}px`;
  }

  hit.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    hit.setPointerCapture(event.pointerId);
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: position.left,
      top: position.top,
      moved: false,
    };
  });

  hit.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    root.classList.add('dragging');
    placeAt(drag.left + dx, drag.top + dy);
  });

  function endDrag(event, cancelled) {
    if (!drag || event.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    root.classList.remove('dragging');
    if (moved) {
      savePosition();
    } else if (!cancelled) {
      onTap();
    }
  }
  hit.addEventListener('pointerup', (event) => endDrag(event, false));
  hit.addEventListener('pointercancel', (event) => endDrag(event, true));
  hit.addEventListener('click', (event) => event.stopPropagation());

  hit.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 64 : 16;
    const moves = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onTap();
    } else if (moves[event.key]) {
      event.preventDefault();
      placeAt(position.left + moves[event.key][0], position.top + moves[event.key][1]);
      savePosition();
    }
  });

  function savePosition() {
    chrome.storage.local.set({[POSITION_KEY]: position}).catch(() => {});
  }

  // ── Controls ─────────────────────────────────────────────────────────────

  function onTap() {
    // The tap is a user gesture on the page, which also lets the video play
    // with sound.
    if (view.soundBlocked) post({type: 'gesture'});
    if (view.phase === 'idle' || view.phase === 'error') {
      // Always retry: the settings may have been fixed since the last
      // failure. The session opens Options if access still isn't set up.
      if (currentMode() === 'chat') setChatOpen(true);
      post({type: 'start'});
    } else if (currentMode() === 'chat' && view.phase === 'live') {
      setChatOpen(!chatOpen);
    } else {
      root.classList.toggle('show-controls');
    }
  }

  function openOptions() {
    chrome.runtime.sendMessage({target: 'background', type: 'open-options'}).catch(() => {});
  }

  micButton.addEventListener('click', (event) => {
    event.stopPropagation();
    post({type: 'mic', muted: !view.micMuted});
  });
  settingsButton.addEventListener('click', (event) => {
    event.stopPropagation();
    openOptions();
  });
  keyboardButton.addEventListener('click', (event) => {
    event.stopPropagation();
    if (currentMode() !== 'chat') setChatOpen(true);
    post({type: 'switch-mode'});
  });
  closeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    chrome.runtime.sendMessage({target: 'background', type: 'detach'}).catch(() => {});
    teardown();
  });
  root.addEventListener('pointerdown', (event) => event.stopPropagation());

  // ── Text chat panel ──────────────────────────────────────────────────────

  const CHAT_URL = chrome.runtime.getURL('chat-frame.html');
  const CHAT_OPEN_KEY = 'chatOpen';
  const PANEL_WIDTH = 340;
  const PANEL_HEIGHT = 460;
  const PANEL_GAP = 14;
  let chatOpen = true;
  let chatFrame = null;
  /** Focus the panel's input once it shows (after a tap or a switch). */
  let focusChat = false;

  function setChatOpen(open) {
    chatOpen = open;
    focusChat = open;
    chrome.storage.local.set({[CHAT_OPEN_KEY]: open}).catch(() => {});
    render();
  }

  function renderPanel() {
    const show = currentMode() === 'chat' && chatOpen && view.phase !== 'idle';
    panel.classList.toggle('show', show);
    if (!show) return;
    if (!chatFrame) {
      chatFrame = document.createElement('iframe');
      chatFrame.title = 'Chat with Gemini';
      chatFrame.src = CHAT_URL;
      chatFrame.addEventListener('load', () => {
        if (focusChat) chatFrame.focus();
      });
      panel.append(chatFrame);
    }
    placePanel();
    if (focusChat && view.phase === 'live') {
      focusChat = false;
      chatFrame.focus();
    }
  }

  /** Beside the bubble (left if there's room, else right), on screen. */
  function placePanel() {
    if (!panel.classList.contains('show')) return;
    const {width, height} = viewport();
    const panelWidth = Math.min(PANEL_WIDTH, width - 2 * EDGE);
    const panelHeight = Math.min(PANEL_HEIGHT, height - 2 * EDGE);
    let left = position.left - PANEL_GAP - panelWidth;
    if (left < EDGE) left = position.left + SIZE + PANEL_GAP;
    left = Math.max(EDGE, Math.min(left, width - panelWidth - EDGE));
    const top = Math.max(EDGE, Math.min(position.top + SIZE - panelHeight, height - panelHeight - EDGE));
    Object.assign(panel.style, {
      left: `${Math.round(left - position.left)}px`,
      top: `${Math.round(top - position.top)}px`,
      width: `${Math.round(panelWidth)}px`,
      height: `${Math.round(panelHeight)}px`,
    });
  }

  function onStorageChanged(changes, area) {
    if (area === 'local' && changes.settings) {
      savedMode = changes.settings.newValue?.mode || '';
      render();
    }
  }

  // ── Pointer ──────────────────────────────────────────────────────────────
  // The model's point_at tool: a cursor flies from the bubble to a thing on
  // the page, found by its text (or by a spot in the latest screenshot), and
  // follows it as the page scrolls until it fades out.

  /** How long the pointer stays up. */
  const POINT_MS = 7000;
  /** Most text the matcher scans, to keep huge pages fast. */
  const MAX_SCAN_CHARS = 400000;

  const POINTER_CSS = `
    .layer { position: fixed; inset: 0; pointer-events: none; overflow: hidden; }
    .highlight {
      position: absolute;
      left: 0;
      top: 0;
      border-radius: 6px;
      background: rgba(66, 133, 244, 0.14);
      box-shadow: 0 0 0 2px rgba(66, 133, 244, 0.9), 0 0 18px rgba(155, 114, 203, 0.55);
      opacity: 0;
      transition: opacity 0.25s;
    }
    .cursor {
      position: absolute;
      left: 0;
      top: 0;
      opacity: 0;
      transition: opacity 0.25s;
      will-change: transform;
    }
    .layer.show .cursor, .layer.show .highlight.on { opacity: 1; }
    .cursor svg {
      position: absolute;
      left: -3px;
      top: -2px;
      width: 30px;
      height: 34px;
      overflow: visible;
      filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.35));
    }
    .pulse {
      position: absolute;
      left: -14px;
      top: -14px;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 2px solid rgba(66, 133, 244, 0.9);
      animation: gla-pulse 1.4s ease-out infinite;
    }
    .label {
      position: absolute;
      left: 24px;
      top: 26px;
      padding: 3px 10px 4px;
      border-radius: 999px;
      background: linear-gradient(90deg, #4285f4, #9b72cb);
      color: #fff;
      font: 500 12.5px/1.4 "Google Sans", Roboto, system-ui, -apple-system, "Segoe UI", sans-serif;
      white-space: nowrap;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    .label:empty { display: none; }
    .ring {
      position: absolute;
      left: -20px;
      top: -20px;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: 3px solid rgba(155, 114, 203, 0.95);
      opacity: 0;
    }
    .cursor.click .ring { animation: gla-ring 0.55s ease-out; }
    @keyframes gla-pulse {
      from { transform: scale(0.5); opacity: 1; }
      to { transform: scale(1.6); opacity: 0; }
    }
    @keyframes gla-ring {
      from { transform: scale(0.3); opacity: 1; }
      to { transform: scale(1.4); opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) { .pulse, .cursor.click .ring { animation: none; } }
  `;

  const pointerHost = document.createElement('gemini-live-pointer');
  for (const [name, value] of Object.entries({
    ...hostStyle,
    'z-index': '2147483646',
    width: '100vw',
    height: '100vh',
    'pointer-events': 'none',
  })) {
    pointerHost.style.setProperty(name, value, 'important');
  }
  const pointerShadow = pointerHost.attachShadow({mode: 'closed'});
  addStyles(pointerShadow, POINTER_CSS);
  const layer = element('div', 'layer');
  const highlight = element('div', 'highlight');
  const cursor = element('div', 'cursor');
  const pulse = element('div', 'pulse');
  const cursorLabel = element('div', 'label');
  const clickRing = element('div', 'ring');
  const arrow = svgElement('svg', {viewBox: '0 0 30 34'}, [
    svgElement('defs', {}, [
      svgElement('linearGradient', {id: 'gla-arrow', x1: '0', y1: '0', x2: '1', y2: '1'}, [
        svgElement('stop', {offset: '0', 'stop-color': '#4285f4'}),
        svgElement('stop', {offset: '1', 'stop-color': '#9b72cb'}),
      ]),
    ]),
    svgElement('path', {
      d: 'M3 2 L3 27 L9.5 20.5 L14 30.5 L18.5 28.5 L14 18.5 L23 18.5 Z',
      fill: 'url(#gla-arrow)',
      stroke: '#fff',
      'stroke-width': '2',
      'stroke-linejoin': 'round',
    }),
  ]);
  cursor.append(pulse, clickRing, arrow, cursorLabel);
  layer.append(highlight, cursor);
  pointerShadow.append(layer);

  /**
   * The current target: {target: () => ?{x, y, box}, until, frame, x, y}.
   * `target` gives the cursor tip and the box to highlight, in viewport px.
   */
  let pointing = null;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  /**
   * @param {{text: (string|undefined), x: (number|undefined), y: (number|undefined), label: (string|undefined)}} request
   * @return {{ok: boolean, scrolled: (boolean|undefined), error: (string|undefined)}}
   */
  function pointAt({text, x, y, label}) {
    let target = null;
    let scrollTo = null;
    const query = String(text || '').trim();
    if (query) {
      const found = findOnPage(query);
      if (found) ({target, scrollTo} = found);
    }
    if (!target && Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
      target = targetAtScreenshotPoint(Number(x), Number(y));
    }
    if (!target) {
      return {
        ok: false,
        error: query
          ? `"${query}" isn't on the page. Use words copied exactly from the page, or x and y from the screenshot.`
          : 'Give the text to point at, or x and y from the screenshot.',
      };
    }
    let scrolled = false;
    if (scrollTo && isOffscreen(target())) {
      scrollTo.scrollIntoView({block: 'center', inline: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth'});
      scrolled = true;
    }
    showPointer(target, String(label || '').trim().slice(0, 40));
    return {ok: true, scrolled};
  }

  /** @param {number=} ms How long the pointer stays up. */
  function showPointer(target, label, ms = POINT_MS) {
    const start = pointing
      ? {x: pointing.x, y: pointing.y}
      : {x: position.left + SIZE / 2, y: position.top + SIZE / 2};
    cancelAnimationFrame(pointing?.frame);
    pointing = {target, until: Date.now() + ms, frame: 0, ...start};
    cursorLabel.textContent = label;
    if (!pointerHost.isConnected) document.documentElement.append(pointerHost);
    // Let the starting position render before fading in.
    moveCursor(start.x, start.y);
    requestAnimationFrame(() => layer.classList.add('show'));
    pointing.frame = requestAnimationFrame(followTarget);
  }

  function followTarget() {
    if (!pointing) return;
    const spot = pointing.target();
    if (!spot || Date.now() > pointing.until) {
      hidePointer();
      return;
    }
    // Glide toward the target; snap when motion is reduced.
    const ease = reducedMotion.matches ? 1 : 0.18;
    pointing.x += (spot.x - pointing.x) * ease;
    pointing.y += (spot.y - pointing.y) * ease;
    moveCursor(pointing.x, pointing.y);
    if (spot.box) {
      const pad = 4;
      Object.assign(highlight.style, {
        transform: `translate(${spot.box.left - pad}px, ${spot.box.top - pad}px)`,
        width: `${spot.box.width + pad * 2}px`,
        height: `${spot.box.height + pad * 2}px`,
      });
    }
    highlight.classList.toggle('on', Boolean(spot.box));
    pointing.frame = requestAnimationFrame(followTarget);
  }

  function moveCursor(x, y) {
    cursor.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }

  function hidePointer(now = false) {
    if (now) pointerHost.remove();
    if (!pointing) return;
    cancelAnimationFrame(pointing.frame);
    pointing = null;
    layer.classList.remove('show');
    highlight.classList.remove('on');
    if (now) return;
    setTimeout(() => {
      if (!pointing) pointerHost.remove();
    }, 300);
  }

  function isOffscreen(spot) {
    const {height} = viewport();
    const box = spot?.box || {top: spot?.y ?? 0, bottom: spot?.y ?? 0};
    return box.bottom < 0 || box.top > height;
  }

  /** Lowercases and folds whitespace, quotes, and dashes for matching. */
  function foldChar(ch) {
    if (/\s/.test(ch)) return ' ';
    if (/[‘’‚′]/.test(ch)) return "'";
    if (/[“”„″]/.test(ch)) return '"';
    if (/[‐-―−]/.test(ch)) return '-';
    return ch.toLowerCase();
  }

  function fold(text) {
    return Array.from(text, foldChar).join('').replace(/ +/g, ' ').trim();
  }

  /**
   * Finds `query` in the page's visible text (across element boundaries), or
   * in labels without visible text (aria-label, alt, placeholder, title).
   * @return {?{target: function(): ?Object, scrollTo: !Element}}
   */
  function findOnPage(query) {
    const needle = fold(query);
    if (needle.length < 2) return null;
    const attempts = [needle];
    // Models paraphrase long quotes: fall back to their start and end.
    const words = needle.split(' ');
    if (words.length > 6) attempts.push(words.slice(0, 5).join(' '), words.slice(-5).join(' '));
    const index = indexPageText();
    for (const attempt of attempts) {
      const range = findInIndex(index, attempt);
      if (range) {
        return {target: rangeTarget(range), scrollTo: range.startContainer.parentElement};
      }
    }
    for (const attempt of attempts) {
      const labelled = findLabelled(attempt);
      if (labelled) return {target: elementTarget(labelled), scrollTo: labelled};
    }
    return null;
  }

  /** The page's folded text, with each character's text node and offset. */
  function indexPageText() {
    let text = '';
    const nodes = [];
    const offsets = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA)$/.test(parent.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        return node.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    for (let node = walker.nextNode(); node && text.length < MAX_SCAN_CHARS; node = walker.nextNode()) {
      // Separate nodes with a space, as words in different elements are.
      if (text && !text.endsWith(' ')) {
        text += ' ';
        nodes.push(null);
        offsets.push(0);
      }
      const data = node.data;
      for (let i = 0; i < data.length; i++) {
        const ch = foldChar(data[i]);
        if (ch === ' ' && (!text || text.endsWith(' '))) continue;
        text += ch;
        nodes.push(node);
        offsets.push(i);
      }
    }
    return {text, nodes, offsets};
  }

  /** @return {?Range} The best visible match: on screen first, then first. */
  function findInIndex({text, nodes, offsets}, needle) {
    const {height} = viewport();
    let fallback = null;
    for (let at = text.indexOf(needle), tries = 0; at !== -1 && tries < 50; at = text.indexOf(needle, at + 1), tries++) {
      let first = at;
      let last = at + needle.length - 1;
      while (first <= last && !nodes[first]) first++;
      while (last >= first && !nodes[last]) last--;
      if (first > last) continue;
      const range = document.createRange();
      range.setStart(nodes[first], offsets[first]);
      range.setEnd(nodes[last], offsets[last] + 1);
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) continue; // Hidden.
      if (rect.bottom > 0 && rect.top < height) return range;
      fallback ??= range;
    }
    return fallback;
  }

  function findLabelled(needle) {
    const selector =
      '[aria-label], img[alt], [placeholder], [title], input[type="submit"], input[type="button"], input[type="reset"]';
    let fallback = null;
    const {height} = viewport();
    for (const el of document.querySelectorAll(selector)) {
      if (el === host || el === pointerHost) continue;
      const label = el.getAttribute('aria-label') || el.getAttribute('alt') ||
        el.getAttribute('placeholder') || el.getAttribute('title') ||
        (el.tagName === 'INPUT' ? el.value : '') || '';
      if (!fold(label).includes(needle)) continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      if (rect.bottom > 0 && rect.top < height) return el;
      fallback ??= el;
    }
    return fallback;
  }

  /** Points just below the middle of the text's first line, boxing it all. */
  function rangeTarget(range) {
    return () => {
      if (!range.startContainer.isConnected) return null;
      const box = range.getBoundingClientRect();
      const line = range.getClientRects()[0] || box;
      return {x: line.left + Math.min(line.width / 2, 60), y: line.bottom - 2, box};
    };
  }

  function elementTarget(el) {
    return () => {
      if (!el.isConnected) return null;
      const box = el.getBoundingClientRect();
      return {x: box.left + box.width / 2, y: box.top + box.height / 2, box};
    };
  }

  /**
   * A spot in the latest screenshot (0..1000 on each axis of the visible
   * tab), pinned to the element under it so the pointer follows scrolling.
   */
  function targetAtScreenshotPoint(x, y) {
    const clamp = (v) => Math.min(1000, Math.max(0, v)) / 1000;
    const px = clamp(x) * innerWidth;
    const py = clamp(y) * innerHeight;
    const el = document.elementFromPoint(px, py);
    if (!el || el === host || el === document.documentElement || el === document.body) {
      return () => ({x: px, y: py, box: null});
    }
    const start = el.getBoundingClientRect();
    const fx = start.width ? (px - start.left) / start.width : 0.5;
    const fy = start.height ? (py - start.top) / start.height : 0.5;
    return () => {
      if (!el.isConnected) return null;
      const box = el.getBoundingClientRect();
      return {x: box.left + fx * box.width, y: box.top + fy * box.height, box: null};
    };
  }

  // ── Acting on the page ───────────────────────────────────────────────────
  // Browser control: the model's click, type_text, press_key, and scroll
  // tools. The cursor flies to each target before acting, so the user sees
  // every step. Input is synthesized with DOM events (the debugger API would
  // give trusted input, but browser policy often blocks it): clicks run the
  // page's handlers and the element's default action (follow a link, press a
  // button, tick a box), and text goes in through the editing commands, as
  // typing or pasting would.

  /** How long the cursor stays on an action's target. */
  const ACT_POINTER_MS = 2500;
  /** Longest wait for the cursor to reach its target before acting. */
  const ARRIVE_MS = 900;
  /** After acting: wait for the page to stop changing, up to SETTLE_MAX_MS. */
  const SETTLE_QUIET_MS = 300;
  const SETTLE_MAX_MS = 1500;
  /** Things a click should land on, when the model names text inside them. */
  const CLICKABLE =
    'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], ' +
    '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="checkbox"], ' +
    '[role="radio"], [role="switch"], [role="option"], [role="treeitem"], [role="combobox"]';
  /** Fields that take typed text (or a choice, for select). */
  const TEXT_FIELD =
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"])' +
    ':not([type="button"]):not([type="reset"]):not([type="image"]):not([type="file"]):not([type="range"])' +
    ':not([type="color"]), textarea, select, [contenteditable=""], [contenteditable="true"], ' +
    '[contenteditable="plaintext-only"], [role="textbox"], [role="searchbox"], [role="combobox"]';
  const FOCUSABLE =
    'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable=""], ' +
    '[contenteditable="true"], [contenteditable="plaintext-only"]';
  /** Keys press_key knows: [key, code, keyCode]. */
  const KEYS = {
    enter: ['Enter', 'Enter', 13],
    escape: ['Escape', 'Escape', 27],
    tab: ['Tab', 'Tab', 9],
    backspace: ['Backspace', 'Backspace', 8],
    delete: ['Delete', 'Delete', 46],
    arrowup: ['ArrowUp', 'ArrowUp', 38],
    arrowdown: ['ArrowDown', 'ArrowDown', 40],
    arrowleft: ['ArrowLeft', 'ArrowLeft', 37],
    arrowright: ['ArrowRight', 'ArrowRight', 39],
    pageup: ['PageUp', 'PageUp', 33],
    pagedown: ['PageDown', 'PageDown', 34],
    home: ['Home', 'Home', 36],
    end: ['End', 'End', 35],
    space: [' ', 'Space', 32],
  };
  const KEY_ALIASES = {
    return: 'enter', esc: 'escape', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright',
    page_up: 'pageup', page_down: 'pagedown', prior: 'pageup', next: 'pagedown', del: 'delete', ' ': 'space',
  };

  /** The field the model last typed into or clicked, for typing without one. */
  let lastField = null;

  /**
   * Runs one action and reports what happened.
   * @param {{id: number, kind: string, args: !Object}} message
   * @return {!Promise<!Object>} {ok, result, url, title, page (if the
   *     address changed), openUrl (a link to open in this tab)} or
   *     {ok: false, error}.
   */
  async function act({id, kind, args = {}}) {
    try {
      switch (kind) {
        case 'click':
          return await actClick(id, args);
        case 'type':
          return await actType(id, args);
        case 'key':
          return await actKey(id, args);
        case 'scroll':
          return await actScroll(args);
        case 'history':
          return await actHistory(id, args);
        default:
          return {ok: false, error: `Unknown action: ${kind}`};
      }
    } catch (err) {
      return {ok: false, error: `That didn't work: ${err?.message || err}`};
    }
  }

  async function actClick(id, {text, x, y, double, label}) {
    const target = findClickTarget({text, x, y});
    if (!target) return notFound(text, 'click');
    await bringIntoView(target);
    showPointer(target.spot, cursorText(label, double ? 'Double-click' : 'Click'), ACT_POINTER_MS);
    await arrive();
    const spot = target.spot();
    if (!spot) return {ok: false, error: 'It went away before I could click it.'};
    // Click what is really there (a dialog may cover the target), unless
    // that's something else entirely: then the target itself.
    const hit = elementAt(spot.x, spot.y);
    const inside = hit && target.element && (target.element === hit.element || target.element.contains(hit.element));
    const where = !target.element || inside ? hit : {element: target.element, x: spot.x, y: spot.y, view: window};
    if (!where?.element) return {ok: false, error: "There's nothing to click there."};
    const what = describe(target.element || closestClickable(where.element) || where.element);
    if (where.element.closest?.('input[type="file"]')) {
      return {ok: false, error: "That opens a file picker, which I can't use. Ask the user to choose the file."};
    }
    flashClick();
    const link = where.element.closest?.('a[href]');
    if (link && !double && /^_blank$/i.test(link.target) && /^https?:/.test(link.href)) {
      // New tabs would leave the bubble behind: open it here instead.
      return {ok: true, openUrl: link.href, result: `Clicked ${what}; it opens in this tab.`};
    }
    const field = where.element.closest?.(TEXT_FIELD);
    if (field) lastField = field;
    const urlBefore = location.href;
    // If the click navigates, this page (and its reply) is gone: say it first.
    post({type: 'act-note', id, result: `Clicked ${what}.`});
    dispatchClick(where, Boolean(double));
    await settle();
    return withPage({ok: true, result: `Clicked ${what}.`}, urlBefore);
  }

  async function actType(id, {text, field, x, y, append, submit}) {
    const value = String(text ?? '');
    const byPoint = Number.isFinite(Number(x)) && Number.isFinite(Number(y));
    let el;
    if (String(field || '').trim() || byPoint) {
      el = findField({field, x, y, byPoint});
      if (!el) {
        return {
          ok: false,
          error: field
            ? `No text field matching "${field}" on the page. Use its label or placeholder, or x and y from the screenshot.`
            : "There's no text field there.",
        };
      }
    } else {
      el = focusedField();
      if (!el) {
        return {ok: false, error: 'No text field has focus. Say which field to type into (its label), or give x and y.'};
      }
    }
    if (isSecret(el)) {
      return {ok: false, error: "That's a password or payment field. Ask the user to type it themselves."};
    }
    if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') {
      return {ok: false, error: `${capitalize(describe(el))} can't be edited right now.`};
    }
    const target = {element: el, spot: elementTarget(el)};
    await bringIntoView(target);
    showPointer(target.spot, el.tagName === 'SELECT' ? 'Choose' : 'Type', ACT_POINTER_MS);
    await arrive();
    lastField = el;
    const urlBefore = location.href;
    if (el.tagName === 'SELECT') {
      const result = chooseOption(el, value);
      if (!result.ok) return result;
      await settle();
      return withPage(result, urlBefore);
    }
    if (el.ownerDocument.activeElement !== el && !el.contains(el.ownerDocument.activeElement)) {
      const spot = target.spot();
      if (spot) dispatchClick({element: el, x: spot.x, y: spot.y, view: window}, false);
      el.focus({preventScroll: true});
    }
    flashClick();
    if (append) {
      caretToEnd(el);
    } else {
      selectAllIn(el);
    }
    if (value) {
      insertText(el, value);
    } else {
      el.ownerDocument.execCommand('delete');
      if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value) setNativeValue(el, '');
    }
    if (!typedInto(el, value)) {
      return {ok: false, error: `I couldn't type into ${describe(el)}; it may only take real keyboard input. Ask the user to type it.`};
    }
    let result = value ? `Typed "${clip(value, 60)}" into ${describe(el)}.` : `Cleared ${describe(el)}.`;
    if (submit) {
      // Enter may load a new page, and this one (and its reply) goes away.
      post({type: 'act-note', id, result: `${result} Pressed Enter.`});
      result += ` ${pressEnter(el)}`;
    }
    await settle();
    return withPage({ok: true, result}, urlBefore);
  }

  async function actKey(id, {key, repeat}) {
    const parsed = parseKey(key);
    if (!parsed) {
      return {
        ok: false,
        error: `I can't press "${key}". Use Enter, Escape, Tab, Shift+Tab, Backspace, Delete, an arrow key, PageUp, PageDown, Home, End, or Space.`,
      };
    }
    const times = Math.max(1, Math.min(20, Math.round(Number(repeat) || 1)));
    const active = deepActiveElement();
    const el = active && active !== document.body && active !== document.documentElement
      ? active
      : focusedField() || document.body;
    const urlBefore = location.href;
    const name = `${parsed.shift ? 'Shift+' : ''}${parsed.key === ' ' ? 'Space' : parsed.key}`;
    const on = el !== document.body && el !== document.documentElement ? ` in ${describe(el)}` : '';
    post({type: 'act-note', id, result: `Pressed ${name}${on}.`});
    let note = '';
    for (let i = 0; i < times; i++) note = pressKey(el, parsed) || note;
    await settle();
    return withPage({ok: true, result: `Pressed ${name}${times > 1 ? ` ${times} times` : ''}${on}.${note ? ` ${note}` : ''}`}, urlBefore);
  }

  async function actScroll({direction, amount, text, x, y}) {
    const query = String(text || '').trim();
    if (query) {
      const found = findOnPage(query);
      if (!found) return notFound(query, 'scroll to');
      found.scrollTo.scrollIntoView({block: 'center', inline: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth'});
      await settleScroll(() => found.target()?.y);
      showPointer(found.target, '', ACT_POINTER_MS);
      return {ok: true, result: `Scrolled to "${clip(query, 60)}".`};
    }
    const way = String(direction || 'down').toLowerCase();
    if (!['up', 'down', 'left', 'right'].includes(way)) {
      return {ok: false, error: 'Scroll up, down, left, or right (or give text to scroll to).'};
    }
    const vertical = way === 'up' || way === 'down';
    const sign = way === 'up' || way === 'left' ? -1 : 1;
    const byPoint = Number.isFinite(Number(x)) && Number.isFinite(Number(y));
    const point = byPoint ? screenshotPoint(Number(x), Number(y)) : {x: innerWidth / 2, y: innerHeight / 2};
    const box = scrollableAt(point, vertical);
    const screens = Math.max(0.1, Math.min(10, Number(amount) || 0.8));
    const position = () => (vertical ? box.position().top : box.position().left);
    const before = position();
    const distance = sign * screens * (vertical ? box.size().height : box.size().width);
    box.scrollBy(vertical ? {top: distance} : {left: distance});
    await settleScroll(position);
    const after = position();
    if (Math.abs(after - before) < 2) {
      return {ok: true, result: `Can't scroll ${way} any further${box.name ? ` in ${box.name}` : ''}.`};
    }
    const range = vertical ? box.extent().height : box.extent().width;
    const percent = range > 0 ? Math.round((after / range) * 100) : 100;
    return {
      ok: true,
      result: `Scrolled ${way}${box.name ? ` in ${box.name}` : ''}; now ${percent}% of the way ${vertical ? 'down' : 'across'}.`,
    };
  }

  /**
   * Back or forward through the page's own history. (The browser's back
   * button skips pages the user never interacted with, and synthesized
   * clicks don't count as interaction, so it could skip right past the page
   * the model just came from.)
   */
  async function actHistory(id, {go}) {
    const forward = go === 'forward';
    const urlBefore = location.href;
    // A new page replaces this one, and the session hears the bubble leave.
    post({type: 'act-note', id, result: forward ? 'Went forward.' : 'Went back.'});
    const moved = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      addEventListener('popstate', () => {
        clearTimeout(timer);
        resolve(true);
      }, {once: true});
    });
    if (forward) {
      history.forward();
    } else {
      history.back();
    }
    if (!(await moved)) {
      return {ok: false, error: `Nothing happened: there may be no page to go ${forward ? 'forward' : 'back'} to.`};
    }
    await settle();
    return withPage({ok: true, result: forward ? 'Went forward.' : 'Went back.'}, urlBefore);
  }

  /** @return {?{element: ?Element, spot: function(): ?{x, y, box}}} */
  function findClickTarget({text, x, y}) {
    const query = String(text || '').trim();
    if (query) {
      const found = findOnPage(query);
      if (found) {
        const clickable = closestClickable(found.scrollTo);
        return clickable && isRendered(clickable)
          ? {element: clickable, spot: elementTarget(clickable)}
          : {element: found.scrollTo, spot: found.target};
      }
    }
    if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
      const point = screenshotPoint(Number(x), Number(y));
      const hit = elementAt(point.x, point.y);
      return {element: hit ? closestClickable(hit.element) : null, spot: targetAtScreenshotPoint(Number(x), Number(y))};
    }
    return null;
  }

  function closestClickable(el) {
    return el?.closest?.(CLICKABLE) || null;
  }

  /** A field by its label, placeholder, or nearby text, or the one at a point. */
  function findField({field, x, y, byPoint}) {
    if (byPoint && !String(field || '').trim()) {
      const point = screenshotPoint(Number(x), Number(y));
      const hit = elementAt(point.x, point.y);
      if (!hit) return null;
      return fieldFor(hit.element);
    }
    const needle = fold(String(field || ''));
    if (needle.length < 1) return null;
    let fallback = null;
    const {height} = viewport();
    for (const el of document.querySelectorAll(TEXT_FIELD)) {
      if (!isRendered(el) || host.contains(el)) continue;
      if (!fold(fieldLabel(el)).includes(needle)) continue;
      const box = el.getBoundingClientRect();
      if (box.bottom > 0 && box.top < height) return el;
      fallback ??= el;
    }
    if (fallback) return fallback;
    // Words near the field (a heading, or a label not tied to it).
    const found = findOnPage(String(field));
    if (!found) return null;
    return fieldFor(found.scrollTo);
  }

  /** The text field at or near an element: itself, its label's, or the nearest one inside its surroundings. */
  function fieldFor(el) {
    const own = el.closest?.(TEXT_FIELD);
    if (own) return own.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') || own;
    const label = el.closest?.('label');
    if (label?.control && label.control.matches(TEXT_FIELD)) return label.control;
    for (let node = el, depth = 0; node && node !== document.body && depth < 4; node = node.parentElement, depth++) {
      for (const candidate of node.querySelectorAll?.(TEXT_FIELD) || []) {
        if (isRendered(candidate) && !host.contains(candidate)) return candidate;
      }
    }
    return null;
  }

  function fieldLabel(el) {
    const parts = [
      el.getAttribute('aria-label'),
      el.getAttribute('placeholder'),
      el.getAttribute('title'),
      el.getAttribute('name'),
      el.getAttribute('aria-placeholder'),
    ];
    for (const label of el.labels || []) parts.push(label.innerText);
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/)) {
      if (id) parts.push(document.getElementById(id)?.innerText);
    }
    return parts.filter(Boolean).join(' ');
  }

  /** A field's name for people: its label, else aria-label, placeholder, title, or name. */
  function fieldName(el) {
    const labels = Array.from(el.labels || [], (label) => label.innerText.trim()).filter(Boolean);
    const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map((id) => (id ? document.getElementById(id)?.innerText.trim() : '')).filter(Boolean);
    return labels[0] || el.getAttribute('aria-label') || labelledBy[0] || el.getAttribute('placeholder') ||
      el.getAttribute('title') || el.getAttribute('name') || '';
  }

  /** The focused text field, or the one last used if focus moved to the bubble. */
  function focusedField() {
    const active = deepActiveElement();
    const field = active?.closest?.(TEXT_FIELD);
    if (field && !host.contains(field)) return field;
    if (lastField?.isConnected && isRendered(lastField)) return lastField;
    return null;
  }

  function deepActiveElement() {
    let el = document.activeElement;
    for (let i = 0; i < 10 && el; i++) {
      const inner = el.shadowRoot?.activeElement ||
        (el.tagName === 'IFRAME' || el.tagName === 'FRAME' ? safeDocument(el)?.activeElement : null);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el === host ? null : el;
  }

  function safeDocument(frame) {
    try {
      return frame.contentDocument;
    } catch {
      return null; // Another origin.
    }
  }

  function isSecret(el) {
    const type = String(el.getAttribute('type') || '').toLowerCase();
    const autocomplete = String(el.getAttribute('autocomplete') || '').toLowerCase();
    const name = `${el.getAttribute('name') || ''} ${el.id || ''}`;
    return type === 'password' ||
      /\b(cc-|current-password|new-password|one-time-code)/.test(autocomplete) ||
      /\b(cc[-_]?num|card[-_]?num|cvv|cvc|card[-_]?code|security[-_]?code)/i.test(name);
  }

  /**
   * The deepest element at a viewport point, as a real click would hit it:
   * through open shadow roots and same-origin frames, never the bubble.
   * @return {?{element: !Element, x: number, y: number, view: !Window}}
   */
  function elementAt(x, y) {
    const hidden = host.style.getPropertyValue('visibility');
    host.style.setProperty('visibility', 'hidden', 'important');
    try {
      let doc = document;
      let view = window;
      let el = doc.elementFromPoint(x, y);
      for (let i = 0; i < 10 && el; i++) {
        const inner = el.shadowRoot?.elementFromPoint?.(x, y);
        if (inner && inner !== el) {
          el = inner;
          continue;
        }
        if (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') break;
        const frameDoc = safeDocument(el);
        if (!frameDoc) break;
        const box = el.getBoundingClientRect();
        x -= box.left + el.clientLeft;
        y -= box.top + el.clientTop;
        doc = frameDoc;
        view = frameDoc.defaultView;
        el = doc.elementFromPoint(x, y);
      }
      if (!el || el === document.documentElement && !document.body) return null;
      return {element: el, x, y, view};
    } finally {
      host.style.setProperty('visibility', hidden || 'visible', 'important');
    }
  }

  /** A 0..1000 screenshot position in viewport px. */
  function screenshotPoint(x, y) {
    const clamp = (v) => Math.min(1000, Math.max(0, v)) / 1000;
    return {x: clamp(x) * innerWidth, y: clamp(y) * innerHeight};
  }

  function isRendered(el) {
    const box = el.getBoundingClientRect();
    return box.width > 0 || box.height > 0;
  }

  /** Scrolls an off-screen target to the middle of the view first. */
  async function bringIntoView(target) {
    const spot = target.spot();
    if (!spot) return;
    const {width, height} = viewport();
    const off = spot.y < 0 || spot.y > height || spot.x < 0 || spot.x > width;
    if (!off || !target.element) return;
    target.element.scrollIntoView({block: 'center', inline: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth'});
    await settleScroll(() => target.spot()?.y);
  }

  /** Resolves once the cursor reaches its target (or after ARRIVE_MS). */
  function arrive() {
    const start = Date.now();
    return new Promise((resolve) => {
      // Animation frames don't run in background tabs: the timer still does.
      const timer = setTimeout(resolve, ARRIVE_MS);
      const check = () => {
        const spot = pointing?.target();
        const near = !pointing || !spot || Math.hypot(spot.x - pointing.x, spot.y - pointing.y) < 3;
        if (near || Date.now() - start > ARRIVE_MS) {
          clearTimeout(timer);
          resolve();
        } else {
          requestAnimationFrame(check);
        }
      };
      requestAnimationFrame(check);
    });
  }

  function flashClick() {
    cursor.classList.remove('click');
    void cursor.offsetWidth; // Restart the animation.
    cursor.classList.add('click');
  }

  function cursorText(label, fallback) {
    return String(label || '').trim().slice(0, 40) || fallback;
  }

  /** Pointer and mouse events as a real click makes them, then the click. */
  function dispatchClick({element: el, x, y, view}, double) {
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view,
      clientX: x,
      clientY: y,
      screenX: (view.screenX || 0) + x,
      screenY: (view.screenY || 0) + y,
      button: 0,
    };
    const pointer = {pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1};
    const fire = (Type, type, extra = {}) => el.dispatchEvent(new Type(type, {...base, ...extra}));
    fire(PointerEvent, 'pointerover', {...pointer, buttons: 0});
    fire(MouseEvent, 'mouseover', {buttons: 0});
    fire(PointerEvent, 'pointermove', {...pointer, buttons: 0});
    fire(MouseEvent, 'mousemove', {buttons: 0});
    for (let detail = 1; detail <= (double ? 2 : 1); detail++) {
      fire(PointerEvent, 'pointerdown', {...pointer, buttons: 1, detail});
      if (fire(MouseEvent, 'mousedown', {buttons: 1, detail})) focusAt(el);
      fire(PointerEvent, 'pointerup', {...pointer, buttons: 0, detail});
      fire(MouseEvent, 'mouseup', {buttons: 0, detail});
      // The default action (follow a link, press a button) comes with click.
      fire(MouseEvent, 'click', {buttons: 0, detail});
    }
    if (double) fire(MouseEvent, 'dblclick', {buttons: 0, detail: 2});
  }

  /** Focus moves on mousedown, as it does for a real click. */
  function focusAt(el) {
    const focusable = el.closest?.(FOCUSABLE);
    if (focusable) {
      focusable.focus({preventScroll: true});
    } else if (el.ownerDocument.activeElement?.matches?.(TEXT_FIELD)) {
      el.ownerDocument.activeElement.blur();
    }
  }

  function selectAllIn(el) {
    const doc = el.ownerDocument;
    if (el.isContentEditable) {
      const range = doc.createRange();
      range.selectNodeContents(el);
      const selection = doc.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    try {
      el.select();
    } catch {
      // Not every input type supports selection.
    }
    if (el.value && !selectionCoversAll(el)) setNativeValue(el, ''); // e.g. type=email: clear it instead.
  }

  function caretToEnd(el) {
    if (el.isContentEditable) {
      const selection = el.ownerDocument.getSelection();
      selection.selectAllChildren(el);
      selection.collapseToEnd();
      return;
    }
    try {
      el.setSelectionRange(el.value.length, el.value.length);
    } catch {
      // No selection API: insertText appends at the caret anyway.
    }
  }

  /** Whether the text landed in the field. */
  function typedInto(el, text) {
    const now = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value : el.innerText || el.textContent || '';
    if (!text) return !now.trim();
    return now.replace(/\s+/g, ' ').includes(text.replace(/\s+/g, ' ').slice(0, 40));
  }

  /** Types text into a field, as typing or pasting would (with input events). */
  function insertText(el, text) {
    const doc = el.ownerDocument;
    const isInput = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
    const selectedAll = isInput && (!el.value || selectionCoversAll(el));
    let ok = false;
    try {
      ok = doc.execCommand('insertText', false, text);
    } catch {
      ok = false;
    }
    if (isInput && (!ok || !el.value.includes(text))) {
      // Some fields reject editing commands: set the value the way frameworks notice.
      setNativeValue(el, selectedAll || !el.value ? text : el.value + text);
    } else if (!ok && el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', {bubbles: true, composed: true, inputType: 'insertText', data: text}));
    }
    if (isInput) el.dispatchEvent(new Event('change', {bubbles: true}));
  }

  function selectionCoversAll(el) {
    try {
      return el.selectionStart === 0 && el.selectionEnd === el.value.length;
    } catch {
      return false; // No selection API (e.g. type=email).
    }
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new InputEvent('input', {bubbles: true, composed: true, inputType: 'insertText', data: value}));
  }

  function chooseOption(select, value) {
    const needle = fold(value);
    const options = Array.from(select.options);
    const option = options.find((o) => fold(o.text) === needle || fold(o.value) === needle) ||
      options.find((o) => fold(o.text).includes(needle));
    if (!option) {
      const names = options.slice(0, 12).map((o) => `"${o.text.trim()}"`).join(', ');
      return {ok: false, error: `${capitalize(describe(select))} has no option "${value}". Options: ${names}.`};
    }
    select.focus({preventScroll: true});
    option.selected = true;
    select.dispatchEvent(new Event('input', {bubbles: true}));
    select.dispatchEvent(new Event('change', {bubbles: true}));
    return {ok: true, result: `Chose "${option.text.trim()}" in ${describe(select)}.`};
  }

  function parseKey(raw) {
    const text = String(raw ?? '').trim().toLowerCase();
    const parts = text ? text.split('+').map((part) => part.trim()).filter(Boolean) : [String(raw ?? '')];
    const shift = parts.includes('shift');
    const name = parts.filter((part) => part !== 'shift').pop() || '';
    const id = KEY_ALIASES[name] || name.replace(/[\s_-]/g, '');
    const key = KEYS[id];
    return key ? {key: key[0], code: key[1], keyCode: key[2], shift} : null;
  }

  /**
   * Dispatches keydown (and keyup) on `el`.
   * @return {boolean} Whether the page let the default action happen.
   */
  function keyEvent(el, {key, code, keyCode, shift}) {
    // keyCode / which / charCode: legacy members Chrome accepts, for older
    // handlers. (Defining them on the event here wouldn't reach the page's
    // scripts, which see the event from their own JavaScript world.)
    const make = (type) => new KeyboardEvent(type, {
      key,
      code,
      keyCode,
      which: keyCode,
      charCode: type === 'keypress' ? keyCode : 0,
      shiftKey: Boolean(shift),
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    const proceed = el.dispatchEvent(make('keydown'));
    if (key === 'Enter') el.dispatchEvent(make('keypress'));
    el.dispatchEvent(make('keyup'));
    return proceed;
  }

  /** Presses a key on `el`, doing the browser's default action if the page doesn't. */
  function pressKey(el, parsed) {
    const editable = Boolean(el.closest?.(TEXT_FIELD));
    if (parsed.key === 'Enter') return pressEnter(el);
    if (!keyEvent(el, parsed)) return '';
    const scroller = editable ? null : scrollableAt({x: innerWidth / 2, y: innerHeight / 2}, true);
    switch (parsed.key) {
      case 'Tab':
        moveFocus(el, parsed.shift);
        return '';
      case 'Backspace':
      case 'Delete':
        if (editable) el.ownerDocument.execCommand(parsed.key === 'Backspace' ? 'delete' : 'forwardDelete');
        return '';
      case ' ':
        if (el.matches?.('button, input[type="checkbox"], input[type="radio"], [role="button"], [role="checkbox"], [role="switch"], summary')) {
          el.click();
        } else if (scroller) {
          scroller.scrollBy({top: (parsed.shift ? -1 : 1) * scroller.size().height * 0.85});
        }
        return '';
      case 'PageDown':
      case 'PageUp':
        scroller?.scrollBy({top: (parsed.key === 'PageUp' ? -1 : 1) * scroller.size().height * 0.85});
        return '';
      case 'Home':
      case 'End':
        scroller?.scrollBy({top: parsed.key === 'Home' ? -1e9 : 1e9});
        return '';
      case 'ArrowDown':
      case 'ArrowUp':
        scroller?.scrollBy({top: parsed.key === 'ArrowUp' ? -60 : 60});
        return '';
      default:
        return '';
    }
  }

  /** Enter: the page's key handlers first, then the form or the focused control. */
  function pressEnter(el) {
    if (!keyEvent(el, {key: 'Enter', code: 'Enter', keyCode: 13})) return 'Pressed Enter.';
    if (el.tagName === 'INPUT' && el.form) {
      el.form.requestSubmit();
      return 'Pressed Enter to submit the form.';
    }
    if (el.matches?.('a[href], button, [role="button"], [role="link"], summary')) {
      el.click();
      return 'Pressed Enter on it.';
    }
    return 'Pressed Enter.';
  }

  /** Tab: the next (or previous) focusable thing in document order. */
  function moveFocus(from, backwards) {
    const items = Array.from(document.querySelectorAll(FOCUSABLE)).filter((el) =>
      !el.disabled && el.tabIndex >= 0 && isRendered(el) && !host.contains(el));
    if (!items.length) return;
    const at = items.indexOf(from);
    const next = items[(at + (backwards ? -1 : 1) + items.length) % items.length] || items[0];
    next.focus();
    if (next.matches(TEXT_FIELD)) lastField = next;
  }

  /**
   * What scrolls at a point: the nearest scrollable box around it, else the
   * page, else (for apps whose page doesn't scroll) the box in the middle.
   */
  function scrollableAt(point, vertical) {
    const canScroll = (el) => {
      if (!el || el === host) return false;
      const style = getComputedStyle(el);
      const overflow = vertical ? style.overflowY : style.overflowX;
      const extra = vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
      return extra > 1 && /(auto|scroll|overlay)/.test(overflow);
    };
    const page = document.scrollingElement || document.documentElement;
    const pageScrolls = vertical
      ? page.scrollHeight - innerHeight > 1
      : page.scrollWidth - innerWidth > 1;
    const hit = elementAt(point.x, point.y);
    for (let el = hit?.element; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (canScroll(el)) return boxScroller(el);
    }
    if (pageScrolls || !hit) return pageScroller();
    const middle = elementAt(innerWidth / 2, innerHeight / 2);
    for (let el = middle?.element; el && el !== document.body; el = el.parentElement) {
      if (canScroll(el)) return boxScroller(el);
    }
    return pageScroller();
  }

  function pageScroller() {
    const page = document.scrollingElement || document.documentElement;
    return {
      name: '',
      position: () => ({top: scrollY, left: scrollX}),
      size: () => ({width: innerWidth, height: innerHeight}),
      extent: () => ({width: page.scrollWidth - innerWidth, height: page.scrollHeight - innerHeight}),
      scrollBy: (delta) => scrollBy({...delta, behavior: reducedMotion.matches ? 'auto' : 'smooth'}),
    };
  }

  function boxScroller(el) {
    return {
      name: el.getAttribute('aria-label') ? `the "${clip(el.getAttribute('aria-label'), 40)}" panel` : 'a scrollable panel',
      position: () => ({top: el.scrollTop, left: el.scrollLeft}),
      size: () => ({width: el.clientWidth, height: el.clientHeight}),
      extent: () => ({width: el.scrollWidth - el.clientWidth, height: el.scrollHeight - el.clientHeight}),
      scrollBy: (delta) => el.scrollBy({...delta, behavior: reducedMotion.matches ? 'auto' : 'smooth'}),
    };
  }

  /** Resolves when `read()` stops changing (a smooth scroll ended), or after 1.2 s. */
  function settleScroll(read) {
    const start = Date.now();
    let last = read();
    let still = 0;
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const now = read();
        still = now === last ? still + 1 : 0;
        last = now;
        if (still >= 3 || Date.now() - start > 1200) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
  }

  /** Resolves once the page stops changing for a moment (or after a limit). */
  function settle() {
    return new Promise((resolve) => {
      let quiet = setTimeout(done, SETTLE_QUIET_MS);
      const limit = setTimeout(done, SETTLE_MAX_MS);
      const watcher = new MutationObserver(() => {
        clearTimeout(quiet);
        quiet = setTimeout(done, SETTLE_QUIET_MS);
      });
      watcher.observe(document.documentElement, {childList: true, subtree: true, attributes: true, characterData: true});
      function done() {
        watcher.disconnect();
        clearTimeout(quiet);
        clearTimeout(limit);
        resolve();
      }
    });
  }

  /** Adds where the page is now, with its text if the address changed. */
  function withPage(result, urlBefore) {
    result.url = location.href;
    result.title = document.title.trim();
    if (location.href !== urlBefore) {
      lastUrl = location.href; // Reported here, not again by the URL watcher.
      result.page = readPage();
    }
    return result;
  }

  function notFound(text, verb) {
    const query = String(text || '').trim();
    return {
      ok: false,
      error: query
        ? `"${query}" isn't on the page. Use words copied exactly from the page (or its label), or x and y from the screenshot.`
        : `Say what to ${verb}: words from the page, or x and y from the screenshot.`,
    };
  }

  /** E.g. 'the button "Sign in"', 'the link "Otters"', 'the text field "Search"'. */
  function describe(el) {
    if (!el) return 'it';
    const tag = el.tagName;
    const type = String(el.getAttribute('type') || '').toLowerCase();
    const kind = el.getAttribute('role') || {
      A: 'link',
      BUTTON: 'button',
      SELECT: 'dropdown',
      TEXTAREA: 'text box',
      SUMMARY: 'disclosure',
      LABEL: 'label',
      IMG: 'image',
      INPUT: /^(submit|button|reset|image)$/.test(type) ? 'button' : /^(checkbox|radio)$/.test(type) ? type : 'text field',
    }[tag] || (el.isContentEditable ? 'text box' : 'element');
    const name = (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ? fieldName(el) : '') ||
      el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') ||
      (tag === 'INPUT' ? el.value : '') || el.innerText || el.textContent || '';
    const clean = clip(name.replace(/\s+/g, ' ').trim(), 60);
    return clean ? `the ${kind} "${clean}"` : `the ${kind}`;
  }

  function clip(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function capitalize(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  // ── Reading the page ─────────────────────────────────────────────────────

  function readPage() {
    const description =
      document
        .querySelector('meta[name="description"], meta[property="og:description"]')
        ?.getAttribute('content')
        ?.trim() || '';
    const main = document.querySelector('main, [role="main"]') || document.querySelector('article');
    let text = cleanText(document.body?.innerText || '');
    const mainText = main ? cleanText(main.innerText || '') : '';
    // Prefer the main content (no navigation chrome) when it's substantial.
    if (mainText.length > 500) text = mainText;
    return {
      title: document.title.trim(),
      url: location.href,
      description: description.slice(0, 500),
      selection: currentSelection(),
      text: text.slice(0, MAX_PAGE_TEXT),
      truncated: text.length > MAX_PAGE_TEXT,
    };
  }

  function cleanText(text) {
    return text
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/ ?\n[\s\n]*\n ?/g, '\n\n')
      .replace(/ ?\n ?/g, '\n')
      .trim();
  }

  function currentSelection() {
    return String(getSelection() || '').trim().slice(0, MAX_SELECTION);
  }

  let lastUrl = location.href;
  let lastTextLength = 0;
  const urlTimer = setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    // Single-page app navigation: let the new view render, then report it.
    setTimeout(() => {
      if (!removed) post({type: 'context', context: readPage()});
    }, 1000);
  }, 1000);

  // Client-rendered pages may fill in after DOMContentLoaded.
  const settleTimer = setTimeout(() => {
    const context = readPage();
    if (Math.abs(context.text.length - lastTextLength) > 500) {
      post({type: 'context', context});
    }
  }, 2500);

  let selectionTimer = 0;
  let lastSelection = '';
  function onSelectionChange() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const text = currentSelection();
      if (text.length < 2 || text === lastSelection) return;
      lastSelection = text;
      post({type: 'selection', text});
    }, 700);
  }

  /** Tells the session the page changed, so it takes a fresh screenshot. */
  let dirtyAt = 0;
  function markDirty() {
    const now = Date.now();
    if (now - dirtyAt < 1000) return;
    dirtyAt = now;
    post({type: 'dirty'});
  }

  function onResize() {
    placeAt(position.left, position.top);
    markDirty();
  }

  /** Any page interaction may unblock sound in the video frame. */
  function onPageGesture() {
    if (view.soundBlocked) post({type: 'gesture'});
  }

  function onPageShow(event) {
    if (event.persisted) revive();
  }

  function onRuntimeMessage(message) {
    if (message?.type === 'gla-remove') teardown();
  }

  const observer = new MutationObserver(markDirty);
  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  const listeners = [
    [window, 'scroll', markDirty, {capture: true, passive: true}],
    [window, 'resize', onResize, false],
    [window, 'input', markDirty, true],
    [window, 'click', markDirty, true],
    [window, 'pointerdown', onPageGesture, true],
    [window, 'keydown', onPageGesture, true],
    [window, 'pageshow', onPageShow, false],
    [document, 'selectionchange', onSelectionChange, false],
  ];
  for (const [target, type, listener, options] of listeners) {
    target.addEventListener(type, listener, options);
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);

  // ── Lifecycle ────────────────────────────────────────────────────────────

  function revive() {
    if (removed) return;
    if (!host.isConnected) document.documentElement.append(host);
    if (!port) {
      iframe.src = FRAME_URL;
      connect();
    }
  }

  function teardown() {
    if (removed) return;
    removed = true;
    clearInterval(urlTimer);
    clearTimeout(settleTimer);
    clearTimeout(reconnectTimer);
    clearTimeout(captionTimer);
    clearTimeout(selectionTimer);
    observer.disconnect();
    hidePointer(true);
    for (const [target, type, listener, options] of listeners) {
      target.removeEventListener(type, listener, options);
    }
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch {
      // The extension context is gone.
    }
    try {
      port?.disconnect();
    } catch {
      // Already disconnected.
    }
    port = null;
    host.remove();
    delete globalThis.__geminiLiveAvatar;
  }

  globalThis.__geminiLiveAvatar = {revive};

  const initial = viewport();
  placeAt(initial.width - SIZE - 28, initial.height - SIZE - BADGE_ROOM - 20);
  chrome.storage.local
    .get([POSITION_KEY, CHAT_OPEN_KEY, 'settings'])
    .then((stored) => {
      if (removed) return;
      savedMode = stored.settings?.mode || '';
      chatOpen = stored[CHAT_OPEN_KEY] !== false;
      const saved = stored[POSITION_KEY];
      if (saved && !drag) placeAt(saved.left, saved.top);
      render();
    })
    .catch(() => {});
  render();
  connect();
})();

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
 * fresh screenshot is taken).
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
  try {
    // Constructed stylesheets aren't subject to the page's CSP.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.append(style);
  }

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
  const caption = element('div', 'caption');
  const captionWho = element('div', 'who');
  const captionText = element('div', 'text');
  captionText.setAttribute('aria-live', 'polite');
  caption.append(captionWho, captionText);
  root.append(ring, frameBox, hit, badge, micButton, settingsButton, closeButton, caption);
  shadow.append(root);
  document.documentElement.append(host);

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
  };
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
      case 'remove':
        teardown();
        break;
    }
  }

  function render() {
    root.dataset.phase = view.phase;
    root.dataset.speaking = String(view.speaking);
    root.classList.toggle('muted', view.micMuted);
    micButton.hidden = view.phase !== 'live';
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
    if (view.phase === 'live' && view.soundBlocked) return 'Tap to hear me';
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
    captionWho.textContent =
      role === 'user' ? 'You' : role === 'model' ? view.avatarName || 'Avatar' : 'Gemini Live Avatar';
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
    if (view.phase === 'idle') {
      post({type: 'start'});
    } else if (view.phase === 'error') {
      if (view.errorCode === 'credentials') {
        openOptions();
      } else {
        post({type: 'start'});
      }
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
  closeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    chrome.runtime.sendMessage({target: 'background', type: 'detach'}).catch(() => {});
    teardown();
  });
  root.addEventListener('pointerdown', (event) => event.stopPropagation());

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
    for (const [target, type, listener, options] of listeners) {
      target.removeEventListener(type, listener, options);
    }
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
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
    .get(POSITION_KEY)
    .then((stored) => {
      const saved = stored[POSITION_KEY];
      if (saved && !drag && !removed) placeAt(saved.left, saved.top);
    })
    .catch(() => {});
  render();
  connect();
})();

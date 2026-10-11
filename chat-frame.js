/**
 * @fileoverview Text chat mode's panel inside the page bubble.
 *
 * An extension-origin frame, so typing here never reaches the host page's
 * keyboard shortcuts, and the page's CSS and CSP can't touch it. It shows the
 * conversation (including earlier voice turns) and sends typed messages to
 * the offscreen session over the 'gla-chat' port; replies stream back in.
 * Model replies are rendered from a small Markdown subset, node by node
 * (never as HTML).
 */

const ICONS = {
  send: 'M3.4 20.4 20.85 12.92a1 1 0 0 0 0-1.84L3.4 3.6a.99.99 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z',
  stop: 'M6 6h12v12H6z',
};

const log = document.getElementById('log');
const form = document.getElementById('composer');
const input = /** @type {!HTMLTextAreaElement} */ (document.getElementById('input'));
const sendButton = /** @type {!HTMLButtonElement} */ (document.getElementById('send'));
const sendIcon = document.getElementById('send-icon');

let port = null;
let view = {ready: false, busy: false, phase: 'idle', error: ''};
/** Message elements by entry id. */
const nodes = new Map();
let thinking = null;

function connect() {
  port = chrome.runtime.connect({name: 'gla-chat'});
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    port = null;
    view = {...view, ready: false, busy: false};
    render();
  });
}

function post(message) {
  try {
    port?.postMessage(message);
  } catch {
    // Disconnected.
  }
}

function onMessage(message) {
  switch (message?.type) {
    case 'log':
      log.textContent = '';
      nodes.clear();
      thinking = null;
      for (const entry of message.messages || []) upsert(entry);
      render();
      break;
    case 'entry':
      upsert(message);
      render();
      break;
    case 'drop':
      nodes.get(message.id)?.remove();
      nodes.delete(message.id);
      render();
      break;
    case 'state':
      view = {...view, ...message};
      render();
      break;
  }
}

function upsert({id, role, text, partial}) {
  const stick = isAtBottom();
  let node = nodes.get(id);
  if (!node) {
    node = document.createElement('div');
    nodes.set(id, node);
    log.append(node);
  }
  node.className = `msg ${role}${partial ? ' partial' : ''}`;
  if (role === 'model') {
    node.replaceChildren(...renderMarkdown(String(text || '')));
  } else {
    node.textContent = String(text || '');
  }
  if (stick) scrollToBottom();
}

function render() {
  const busy = Boolean(view.busy);
  input.disabled = !view.ready;
  input.placeholder = view.ready
    ? 'Ask about this page…'
    : view.phase === 'connecting' ? 'Connecting…' : view.phase === 'error' ? 'Not connected' : 'Starting…';
  sendIcon.setAttribute('d', busy ? ICONS.stop : ICONS.send);
  sendButton.setAttribute('aria-label', busy ? 'Stop' : 'Send');
  sendButton.title = busy ? 'Stop' : 'Send (Enter)';
  sendButton.disabled = !view.ready || (!busy && !input.value.trim());

  // A "thinking" indicator until the reply's first words arrive.
  const last = log.lastElementChild;
  const waiting = busy && (!last || last === thinking || last.classList.contains('user'));
  if (waiting && !thinking) {
    thinking = document.createElement('div');
    thinking.className = 'thinking';
    thinking.setAttribute('aria-label', 'Thinking');
    thinking.append(...Array.from({length: 3}, () => document.createElement('span')));
  }
  if (waiting) {
    log.append(thinking);
    scrollToBottom();
  } else {
    thinking?.remove();
  }

  let empty = log.querySelector('.empty');
  if (!nodes.size && !waiting) {
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'empty';
      log.append(empty);
    }
    empty.textContent = view.phase === 'error'
      ? view.error || 'Not connected.'
      : 'Type a question about this page, or anything else. Gemini can see the page and point at things on it.';
  } else {
    empty?.remove();
  }
}

function isAtBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
}

function scrollToBottom() {
  log.scrollTop = log.scrollHeight;
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (view.busy) {
    post({type: 'stop'});
    return;
  }
  const text = input.value.trim();
  if (!text || !view.ready) return;
  post({type: 'send', text});
  input.value = '';
  autosize();
  render();
});

input.addEventListener('input', () => {
  autosize();
  render();
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!view.busy) form.requestSubmit();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') post({type: 'hide'});
});
document.getElementById('hide').addEventListener('click', () => post({type: 'hide'}));
// The bubble focuses this frame when it opens the panel.
window.addEventListener('focus', () => {
  if (!input.disabled) input.focus();
});

// ── Markdown (a small, safe subset) ──────────────────────────────────────

/** @return {!Array<!Node>} Paragraphs, lists, and code blocks. */
function renderMarkdown(text) {
  const blocks = [];
  const lines = text.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const code = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      const pre = document.createElement('pre');
      const inner = document.createElement('code');
      inner.textContent = code.join('\n');
      pre.append(inner);
      blocks.push(pre);
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]); i++) {
        const item = document.createElement('li');
        item.append(...renderInline(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '')));
        list.append(item);
      }
      blocks.push(list);
    } else if (!line.trim()) {
      i++;
    } else {
      const paragraph = [];
      for (; i < lines.length && lines[i].trim() && !/^\s*(```|[-*+]\s|\d+[.)]\s)/.test(lines[i]); i++) {
        paragraph.push(lines[i].replace(/^#{1,6}\s+/, ''));
      }
      const p = document.createElement('p');
      paragraph.forEach((part, index) => {
        if (index) p.append(document.createElement('br'));
        p.append(...renderInline(part));
      });
      blocks.push(p);
    }
  }
  return blocks;
}

/** @return {!Array<!Node>} Text with `code`, **bold**, *italics*, and links. */
function renderInline(text) {
  const out = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > at) out.push(document.createTextNode(text.slice(at, match.index)));
    const [, code, bold, italic, label, href] = match;
    let node;
    if (code !== undefined) {
      node = document.createElement('code');
      node.textContent = code;
    } else if (bold !== undefined) {
      node = document.createElement('strong');
      node.append(...renderInline(bold));
    } else if (italic !== undefined) {
      node = document.createElement('em');
      node.textContent = italic;
    } else {
      node = document.createElement('a');
      node.href = href;
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
      node.textContent = label;
    }
    out.push(node);
    at = match.index + match[0].length;
  }
  if (at < text.length) out.push(document.createTextNode(text.slice(at)));
  return out;
}

connect();
render();

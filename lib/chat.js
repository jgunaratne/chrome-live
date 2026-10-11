/**
 * @fileoverview Text chat mode's Gemini API client: streamGenerateContent
 * over server-sent events, with the AI Studio key in the x-goog-api-key
 * header. Shared by the offscreen document and the options page.
 */

const API = 'https://generativelanguage.googleapis.com/v1beta';

export class ChatError extends Error {}

/**
 * Streams one model turn.
 * @param {{
 *   apiKey: string,
 *   model: string,
 *   systemInstruction: string,
 *   contents: !Array<!Object>,
 *   tools: (?Array<!Object>|undefined),
 *   signal: (?AbortSignal|undefined),
 *   onText: function(string),
 * }} options `onText` gets each new chunk of visible (non-thought) text.
 * @return {!Promise<{parts: !Array<!Object>, finishReason: string}>} The
 *     turn's parts as received (thought signatures included, which must go
 *     back to the model with the history), and why it stopped.
 */
export async function streamChat({apiKey, model, systemInstruction, contents, tools, signal, onText}) {
  let response;
  try {
    response = await fetch(`${API}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'x-goog-api-key': apiKey},
      body: JSON.stringify({
        systemInstruction: {parts: [{text: systemInstruction}]},
        contents,
        ...(tools?.length ? {tools} : {}),
      }),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ChatError(`Could not reach the Gemini API: ${err?.message || err}`);
  }
  if (!response.ok) throw await toChatError(response);

  const parts = [];
  let finishReason = '';
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    buffer += value.replace(/\r/g, ''); // Events may end in \r\n\r\n.
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = event.split('\n').filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim()).join('');
      if (!data) continue;
      const chunk = JSON.parse(data);
      if (chunk.error) throw new ChatError(chunk.error.message || 'The Gemini API failed.');
      if (chunk.promptFeedback?.blockReason) {
        throw new ChatError(`Gemini declined to answer (${chunk.promptFeedback.blockReason}).`);
      }
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts || []) {
        parts.push(part);
        if (part.text && !part.thought) onText(part.text);
      }
      if (candidate?.finishReason) finishReason = candidate.finishReason;
    }
  }
  return {parts, finishReason};
}

/**
 * Checks that the key works and the model exists (the options page's test).
 * @return {!Promise<string>} The model's display name.
 */
export async function checkChatModel(apiKey, model) {
  const response = await fetch(`${API}/models/${encodeURIComponent(model)}`, {
    headers: {'x-goog-api-key': apiKey},
  });
  if (!response.ok) throw await toChatError(response);
  const info = await response.json();
  return info.displayName || model;
}

async function toChatError(response) {
  const body = await response.json().catch(() => ({}));
  const message = body.error?.message || `HTTP ${response.status}`;
  if (response.status === 400 && /API key/i.test(message)) {
    return new ChatError('The Gemini API key was rejected. Check it in Options.');
  }
  if (response.status === 404) {
    return new ChatError(`The chat model wasn't found: ${message} Check the model name in Options.`);
  }
  if (response.status === 429) {
    return new ChatError('The Gemini API quota is used up for now. Try again in a minute.');
  }
  return new ChatError(`Gemini API error: ${message}`);
}

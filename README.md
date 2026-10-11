# Chrome Live: a Gemini Live Avatar for any web page

A Chrome extension that puts a small, draggable **Gemini 3.8 Live Avatar** on
the page you're viewing. It knows what's on the page and talks with you by
voice, with a lip-synced face.

*   Click the toolbar button on a tab: the avatar pops up in the corner and
    greets you about the page you're on. Talk to it; it answers out loud.
*   Drag it anywhere. It keeps its spot, and the conversation keeps going, as
    you navigate. Click the toolbar button on another tab to move it there;
    click it on the avatar's tab (or ✕) to send it away.
*   It knows the page: its title, URL, and text; what you highlight; and what
    you see (screenshots of the visible tab when the page changes).

## Setup

You need a Google Cloud project with the Vertex AI API enabled and access to
the `gemini-3.8-live` model, and the `gcloud` CLI.

1.  Clone this repo, open `chrome://extensions`, turn on **Developer mode**,
    click **Load unpacked**, and pick the repo directory.
2.  Open the extension's options (**Details → Extension options**, or the ⚙
    on the avatar) and fill in:
    *   **Project** (and location, default `us-central1`).
    *   **Credentials**: either your Application Default Credentials JSON
        (`cat ~/.config/gcloud/application_default_credentials.json` after
        `gcloud auth application-default login`; access tokens are refreshed
        from it automatically), or a short-lived access token
        (`gcloud auth application-default print-access-token`, valid about an
        hour). Credentials are stored unencrypted in the extension's local
        storage.
3.  Click **Test connection**, then **Allow microphone** (choose *Allow while
    visiting the site*).
4.  Pick an avatar, voice, and optional persona.

## How it works

```
 toolbar click ─▶ background.js (service worker)
                   │ attaches the avatar to a tab, re-injects the bubble after
                   │ each navigation, takes tab screenshots, mints tokens
                   ▼
 offscreen.html/js ── wss://LOCATION-aiplatform.googleapis.com/ws/…v1.LlmBidiService/BidiGenerateContent?access_token=…
   Live session, mic (pcm-worklet.js, 16 kHz PCM), page context,
   fMP4 regrouping (lib/fmp4.js) + cached init segment
        ▲ port 'gla-page'                       │ port 'gla-video'
        │ page text, selection, controls        ▼ fMP4 fragments
 content.js (closed shadow DOM)  ─contains─▶ avatar-frame.html/js (iframe)
   bubble, drag, tap, captions                 MSE <video>, extension origin
```

*   **Live Avatar session**: `responseModalities: ["VIDEO"]` with
    `avatarConfig.avatarName` (one of the prebuilt avatars) and a prebuilt
    voice. The avatar arrives as fragmented MP4 (H.264 704x1280 at 24 fps +
    AAC 24 kHz, a keyframe every 0.5 s), streamed continuously, even while it
    is silent.
*   **Why an offscreen document**: it outlives page navigations, so the
    conversation continues while the bubble is rebuilt on each page, and it
    can hold the microphone regardless of the page's permissions policy.
*   **Why an iframe for the video**: the `blob:` MediaSource URL lives in the
    extension's origin, clear of the host page's CSP. The iframe takes no
    input; the content script handles dragging and taps (which also count as
    page interaction, letting the video play with sound).
*   **Auth**: browsers can't set headers on WebSocket handshakes; the Live API
    accepts the OAuth token as an `access_token` query parameter instead, so
    no proxy server is needed.
*   **Page awareness**: the page text (main content, up to 10k characters)
    goes into the system instruction. Navigations and text selections are
    added mid-session as `clientContent` turns with `turnComplete: false`,
    which the model absorbs without replying. Screenshots (downscaled to
    1280 px wide, at most every 3 s and only after the page changed) go in as
    `realtimeInput.video` frames, which also don't trigger replies.
*   **Session limits**: the session asks for `sessionResumption`; on `goAway`
    or a dropped connection it resumes on a new connection, keeping the
    conversation.

## Caveats

*   After a navigation to another site, Chrome may block the avatar's sound
    until you click or type on the new page; the badge then says *Tap to hear
    me*.
*   It can't run on `chrome://` pages, the Chrome Web Store, the PDF viewer,
    or sites where browser policy blocks extensions.
*   It listens only while its bubble is on screen; a session with no bubble
    for 60 s ends.
*   On speakers, Chrome's echo cancellation usually keeps the avatar from
    hearing itself; use headphones if it interrupts itself.
*   Live Avatar output is billed as video tokens; close the avatar when
    you're done.

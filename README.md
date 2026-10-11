# Chrome Live: a Gemini Live companion for any web page

A Chrome extension that puts a small, draggable **Gemini Live** companion on
the page you're viewing. It knows what's on the page and talks with you by
voice.

*   Click the toolbar button on a tab: the companion pops up in the corner and
    greets you about the page you're on. Talk to it; it answers out loud.
*   Drag it anywhere. It keeps its spot, and the conversation keeps going, as
    you navigate. Click the toolbar button on another tab to move it there;
    click it on the companion's tab (or ✕) to send it away.
*   It knows the page: its title, URL, and text; what you highlight; and what
    you see (screenshots of the visible tab when the page changes).
*   It points: when it talks about something on the page, a cursor flies from
    the bubble to it and highlights it (scrolling it into view if needed).
*   Optionally, it keeps long-term memories in a Google Drive folder you give
    it: it reads them at the start of each conversation and saves new ones.

## Modes

Mode | What you see | Model | You need
---- | ------------ | ----- | --------
**Gemini Live, extended thinking** | A glowing orb that pulses with the voices | `gemini-3.8-live-extended-thinking` on the Gemini API | A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)
**Live Avatar** | A lip-synced face (11 prebuilt avatars) | `gemini-3.8-live` on Vertex AI | A Google Cloud project with access to the model, and the `gcloud` CLI

The extended-thinking model needs a thinking level (Low, Medium, or High; Low
by default). On High it often says a quick "let me think about that" before
the full answer.

## Setup

1.  Clone this repo, open `chrome://extensions`, turn on **Developer mode**,
    click **Load unpacked**, and pick the repo directory.
2.  Open the extension's options (**Details → Extension options**, or the ⚙
    on the bubble) and pick a mode:
    *   **Gemini Live, extended thinking**: paste your **API key** (and
        optionally change the model or thinking level).
    *   **Live Avatar**: fill in the **project** (and location, default
        `us-central1`) and **credentials**: either your Application Default
        Credentials JSON (`cat
        ~/.config/gcloud/application_default_credentials.json` after `gcloud
        auth application-default login`; access tokens are refreshed from it
        automatically), or a short-lived access token (`gcloud auth
        application-default print-access-token`, valid about an hour).
    Keys and credentials are stored unencrypted in the extension's local
    storage.
3.  Click **Test connection**, then **Allow microphone** (choose *Allow while
    visiting the site*).
4.  Pick a voice and optional persona (and, for Live Avatar, an avatar).

## Memories in Google Drive (optional)

Give Gemini a Drive folder as its long-term memory:

*   At the start of each conversation it reads the folder's Google Docs,
    Sheets, and Slides (as text) and text files (Markdown, plain text, JSON,
    CSV, YAML): newest first, about 30k characters in total. Drop notes there
    for Gemini to know.
*   When you tell it something worth remembering ("remember that my dog is
    named Biscuit"), it calls a `save_memory` tool that appends a dated line to
    `Gemini memories.md` in the folder (created on the first save). Edit or
    delete lines there freely. The bubble shows *Memory: Remembered …* when it
    saves.

Setup: paste the folder link under **Memories** in Options. Memories use the
**Google credentials** field (in both modes), which needs Drive access:

```sh
gcloud auth application-default login --scopes=openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/drive
gcloud auth application-default set-quota-project YOUR_PROJECT
gcloud services enable drive.googleapis.com --project YOUR_PROJECT
cat ~/.config/gcloud/application_default_credentials.json   # paste into Options
```

The quota project pays for the Drive API calls (they're free, but the API
must be on). Use **Check folder** to confirm Gemini can read the folder and
save to it. The folder can be yours or shared with you (with edit access, for
saving).

## How it works

```
 toolbar click ─▶ background.js (service worker)
                   │ attaches the avatar to a tab, re-injects the bubble after
                   │ each navigation, takes tab screenshots, mints tokens
                   ▼
 offscreen.html/js ── wss:// Live API: Gemini API (?key=…) or Vertex AI (?access_token=…)
   Live session, mic (pcm-worklet.js, 16 kHz PCM), page context,
   voice playback (lib/pcm-player.js) or fMP4 regrouping (lib/fmp4.js)
        ▲ port 'gla-page'                       │ port 'gla-video'
        │ page text, selection, controls        ▼ voice levels or fMP4 fragments
 content.js (closed shadow DOM)  ─contains─▶ avatar-frame.html/js (iframe)
   bubble, drag, tap, captions                 orb, or MSE <video>
```

*   **Gemini Live session** (extended thinking): `responseModalities:
    ["AUDIO"]` with a prebuilt voice and `thinkingConfig.thinkingLevel`.
    Speech arrives as 24 kHz PCM and plays in the offscreen document, so the
    page's autoplay rules never mute it; barge-in drops the queued audio at
    once. The bubble shows an orb driven by both voices' levels.
*   **Live Avatar session**: `responseModalities: ["VIDEO"]` with
    `avatarConfig.avatarName` (one of the prebuilt avatars) and a prebuilt
    voice. The avatar arrives as fragmented MP4 (H.264 704x1280 at 24 fps +
    AAC 24 kHz, a keyframe every 0.5 s), streamed continuously, even while it
    is silent.
*   **Why an offscreen document**: it outlives page navigations, so the
    conversation continues while the bubble is rebuilt on each page, and it
    can hold the microphone regardless of the page's permissions policy.
*   **Why an iframe in the bubble**: its `blob:` MediaSource URL lives in the
    extension's origin, clear of the host page's CSP. The iframe takes no
    input; the content script handles dragging and taps (which also count as
    page interaction, letting the avatar video play with sound).
*   **Auth**: browsers can't set headers on WebSocket handshakes. The Gemini
    API takes the key as the `key` query parameter, and Vertex AI accepts the
    OAuth token as `access_token`, so no proxy server is needed.
*   **Page awareness**: the page text (main content, up to 10k characters)
    goes into the system instruction. Navigations and text selections are
    added mid-session as `clientContent` turns with `turnComplete: false`,
    which the model absorbs without replying. Screenshots (downscaled to
    1280 px wide, at most every 3 s and only after the page changed) go in as
    `realtimeInput.video` frames, which also don't trigger replies.
*   **Pointing**: every session has a `point_at` function tool. The model
    passes words copied from the page (or, for things without text, an x/y
    spot in the latest screenshot on a 0–1000 scale). The bubble finds the
    first visible match in the page text (across element boundaries, then in
    `aria-label`/`alt`/`placeholder`/`title`), draws the cursor in its own
    closed shadow root, and follows the target as the page scrolls for 7 s.
    A miss goes back to the model as an error, so it can retry with other
    words.
*   **Session limits**: the session asks for `sessionResumption`; on `goAway`
    or a dropped connection it resumes on a new connection, keeping the
    conversation.

## Caveats

*   Live Avatar: after a navigation to another site, Chrome may block the
    avatar's sound until you click or type on the new page; the badge then
    says *Tap to hear me*.
*   It can't run on `chrome://` pages, the Chrome Web Store, the PDF viewer,
    or sites where browser policy blocks extensions.
*   It listens only while its bubble is on screen; a session with no bubble
    for 60 s ends.
*   On speakers, Chrome's echo cancellation usually keeps it from hearing
    itself; use headphones if it interrupts itself.
*   Live Avatar output is billed as video tokens; close the bubble when
    you're done.

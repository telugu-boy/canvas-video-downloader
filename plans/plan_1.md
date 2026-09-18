# Canvas Video Downloader Extension Plan

## Goal Description
The goal is to create a Chrome/Edge browser extension (Manifest V3) that automatically captures the hidden `manifest.mpd` (DASH stream manifest) from Canvas LMS video players, parses it, and downloads the fragmented video and audio chunks in parallel. It will stream these chunks to RAM and dump them to IndexedDB to manage memory footprint. Finally, it will merge the audio and video streams into a single `.mp4` file directly within the browser using WebAssembly (FFmpeg) and trigger a browser download using the page title. It will also inject a seamless download button next to the existing Closed Captions `[CC]` button in the Canvas video player, matching the player's DOM structure.

## User Review Required
> [!IMPORTANT]  
> **Manifest V3 Remote Code Policies:** We will bundle the single-threaded `ffmpeg.wasm` core directly inside the extension to comply with MV3 rules.

## Proposed Changes

### Extension Architecture
---
#### [NEW] `manifest.json`
Configuration for MV3, requiring permissions for `offscreen` processing, `storage` (for IndexedDB and settings), and `downloads`.

### Network Interception
---
#### [MODIFY] `inject.js`
Injected into the `MAIN` world to monkey-patch `window.fetch`. 
- It will intercept requests to `manifest.mpd` to capture the video/audio stream metadata.
- It will **also** intercept requests containing `/caption_files/` to capture the raw SRT/VTT subtitle data.
Both the MPD XML and the Caption text will be sent to the content script via `window.postMessage`.

### DOM Manipulation & UI
---
#### [MODIFY] `content.js`
Based on the provided DOM structure, the Canvas video player uses a right-aligned controls container (`div[class*="_right-controls"]`) and buttons with `class="controls-button"`.
The CC button specifically has `aria-label="Captions"`.
- We will query for `button[aria-label="Captions"]`.
- We will clone this button, update its `aria-label` to "Download", and change the inner SVG to a download icon.
- This ensures it inherits the `controls-button` class and perfectly matches the UI's fade-in/fade-out hover effects.

### Parallel Downloading & Memory Management
---
#### [NEW] `offscreen.html` & `offscreen.js`
To handle the RAM requirements of merging high-definition videos:
1. **Parallel Fetching**: We will fetch up to 16 chunks concurrently.
2. **IndexedDB Streaming**: As chunks are downloaded into RAM, they will be immediately dumped into an IndexedDB object store (keyed by segment number) and then released from memory to keep the JS heap small.
3. **Muxing via FFmpeg**: 
   - Once all chunks are in IndexedDB, we will read them sequentially and append them into `video.mp4` and `audio.mp4` files within FFmpeg's virtual filesystem (VFS).
   - If captions were intercepted, they will be saved to `subs.srt` in the VFS.
   - We will run `ffmpeg -i video.mp4 -i audio.mp4 -i subs.srt -c:v copy -c:a copy -c:s mov_text final.mp4` to merge the video, audio, and subtitles into a single MP4 container with an embedded subtitle track.
4. **Final Download**: The merged `final.mp4` will be read from VFS, converted to a Blob, and downloaded via `chrome.downloads.download()` using the page's `<title>` as the filename.

### Dependencies
---
#### [NEW] `lib/ffmpeg/`
Bundled single-threaded `ffmpeg.js`, `ffmpeg-core.js`, and `ffmpeg-core.wasm`.

## Verification Plan
### Manual Verification
1. Open a Canvas LMS video page.
2. Verify the Download button appears in the `_right-controls` div, exactly matching the styling of the Settings and Captions buttons.
3. Click Download.
4. Open the extension's Offscreen document inspector and verify chunks are being written to IndexedDB.
5. Verify a final `.mp4` file is downloaded via the browser's native download manager with the correct page title.

# Canvas Video Downloader Extension Plan (v2)

## Goal Description
The goal is to create a Chrome/Edge browser extension (Manifest V3) that automatically captures the hidden `manifest.mpd` (DASH stream manifest) and subtitle files from Canvas LMS video players, parses them, and downloads the fragmented video and audio chunks in parallel. It will stream these chunks to RAM and dump them to IndexedDB to manage memory footprint. It will merge the audio, video, and subtitles into a single `.mp4` file directly within the browser using WebAssembly (FFmpeg) and trigger a browser download using the page title appended with a UNIX timestamp. 

It will inject a seamless download button to the left of the existing Closed Captions `[CC]` button in the Canvas video player. The button will dynamically act as a real-time progress bar, filling with blue from left to right as the download and muxing process completes. Comprehensive console logging will ensure transparent status updates and error handling.

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
- **Button Placement**: Insert the cloned button to the **left** of the Captions button.
- **Dynamic Progress Bar**: Listen for `DOWNLOAD_PROGRESS` messages forwarded by the background script. Update the button's background using a `linear-gradient` to visually fill the button with blue from left to right as the percentage increases.

### Parallel Downloading & Memory Management
---
#### [NEW] `offscreen.html` & `offscreen.js`
To handle the RAM requirements of merging high-definition videos:
1. **Parallel Fetching**: We will fetch up to 16 chunks concurrently.
2. **IndexedDB Streaming**: As chunks are downloaded into RAM, they will be immediately dumped into an IndexedDB object store (keyed by segment number) and then released from memory to keep the JS heap small.
3. **Muxing via FFmpeg**: 
   - Once all chunks are in IndexedDB, we will read them sequentially and append them into `video.mp4` and `audio.mp4` files within FFmpeg's virtual filesystem (VFS).
   - **Subtitle Handling & Fallback**: Convert intercepted WebVTT captions to SRT format and save them to `subs.srt` in the VFS. Run `ffmpeg -i video.mp4 -i audio.mp4 -i subs.srt -c:v copy -c:a copy -c:s mov_text final.mp4`. If captions are missing or FFmpeg fails to mux them, gracefully fall back to merging just the video and audio streams (`-c copy`) so the download doesn't break.
4. **Progress Broadcasting**: Calculate the overall progress percentage across the entire pipeline (fetching chunks, writing to VFS, FFmpeg processing) and broadcast `DOWNLOAD_PROGRESS` messages back to the background script.
5. **Final Download**: The merged `final.mp4` will be read from VFS, converted to a Blob, and downloaded via `chrome.downloads.download()`. 
   - **Filename Generation**: Combine the page's `<title>` with the current UNIX timestamp (e.g., `Course Video - 1731682341.mp4`).

### Service Worker Router
---
#### [NEW] `background.js`
- Spawns and manages the `offscreen` document.
- Receives the `DOWNLOAD_PROGRESS` messages from `offscreen.js` and securely forwards them to the active tab's `content.js` to drive the UI progress bar.

### Dependencies
---
#### [NEW] `lib/ffmpeg/`
Bundled single-threaded `ffmpeg.js`, `ffmpeg-core.js`, and `ffmpeg-core.wasm`.

## Verification Plan
### Manual Verification
1. Open a Canvas LMS video page.
2. Verify the Download button appears to the **left** of the Captions button in the `_right-controls` div.
3. Open the developer console and verify clear status logs are printed.
4. Click Download.
5. Watch the Download button; verify it fills from left to right with a blue progress bar.
6. Check the console to verify whether captions were successfully muxed or if it gracefully fell back.
7. Verify a final `.mp4` file is downloaded and its name includes the UNIX timestamp at the end.

MPEG-DASH Video Stream Downloader for Canvas LMS

Made with Gemini Antigravity using Gemini 3.1 Pro for planning and Gemini 3.8 Flash subagents

Steps:
1. Intercepts `manifest.mpd` file and external VRT/SRT captions from Canvas XHRs.
2. Downloads all `.m4s` chunks denoted in the `manifest.mpd` file with `MAX_CONCURRENCY = 16` threads.
3. Muxes everything together with `ffmpeg.wasm`
4. Downloads on native browser

Todo: Add icon for extension

// offscreen.js - Handles DASH manifest parsing, 16-worker parallel downloading,
// IndexedDB memory streaming, and FFmpeg WebAssembly muxing.

const DB_NAME = 'CanvasVideoDownloaderDB';
const DB_VERSION = 1;
const VIDEO_STORE = 'video_chunks';
const AUDIO_STORE = 'audio_chunks';
const MAX_CONCURRENCY = 16;

let ffmpegInstance = null;

// ==========================================
// 1. IndexedDB Helper Functions
// ==========================================

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(VIDEO_STORE)) {
                db.createObjectStore(VIDEO_STORE);
            }
            if (!db.objectStoreNames.contains(AUDIO_STORE)) {
                db.createObjectStore(AUDIO_STORE);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function clearDatabase(db) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction([VIDEO_STORE, AUDIO_STORE], 'readwrite');
        tx.objectStore(VIDEO_STORE).clear();
        tx.objectStore(AUDIO_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

function putChunk(db, storeName, index, uint8Array) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        store.put(uint8Array, index);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

function getChunk(db, storeName, index) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.get(index);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// ==========================================
// 2. MPD Parsing & Segment Calculation
// ==========================================

/**
 * Extracts Video and Audio segment lists from DASH MPD XML using SegmentTimeline.
 */
function parseMpd(mpdXml, mpdUrl = '') {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(mpdXml, 'application/xml');

    const parserError = xmlDoc.querySelector('parsererror');
    if (parserError) {
        throw new Error('MPD XML Parse Error: ' + parserError.textContent);
    }

    // Determine default BaseURL from MPD or URL
    let defaultBaseUrl = '';
    const mpdBase = xmlDoc.querySelector('MPD > BaseURL') || xmlDoc.querySelector('BaseURL');
    if (mpdBase && mpdBase.textContent.trim()) {
        const b = mpdBase.textContent.trim();
        defaultBaseUrl = /^https?:\/\//i.test(b) ? b : (mpdUrl ? new URL(b, mpdUrl).href : b);
    } else if (mpdUrl) {
        defaultBaseUrl = mpdUrl;
    }

    const adaptationSets = Array.from(xmlDoc.querySelectorAll('AdaptationSet'));

    let videoAdaptation = null;
    let audioAdaptation = null;

    for (const ad of adaptationSets) {
        const contentType = (ad.getAttribute('contentType') || '').toLowerCase();
        const mimeType = (ad.getAttribute('mimeType') || '').toLowerCase();

        if (contentType === 'video' || mimeType.includes('video') || ad.querySelector('Representation[width], Representation[height]')) {
            if (!videoAdaptation) videoAdaptation = ad;
        } else if (contentType === 'audio' || mimeType.includes('audio') || ad.querySelector('Representation[audioSamplingRate]')) {
            if (!audioAdaptation) audioAdaptation = ad;
        }
    }

    if (!videoAdaptation) {
        throw new Error('Could not find video AdaptationSet in MPD manifest');
    }

    const videoSegments = extractSegmentsForAdaptation(videoAdaptation, xmlDoc, defaultBaseUrl);
    let audioSegments = [];
    if (audioAdaptation) {
        audioSegments = extractSegmentsForAdaptation(audioAdaptation, xmlDoc, defaultBaseUrl);
    }

    return {
        videoSegments,
        audioSegments
    };
}

function extractSegmentsForAdaptation(adaptationSet, xmlDoc, defaultBaseUrl) {
    const representations = Array.from(adaptationSet.querySelectorAll('Representation'));
    if (representations.length === 0) {
        throw new Error('No Representation elements found in AdaptationSet');
    }

    // Sort by bandwidth or resolution to select the best quality
    representations.sort((a, b) => {
        const bwA = parseInt(a.getAttribute('bandwidth') || '0', 10);
        const bwB = parseInt(b.getAttribute('bandwidth') || '0', 10);
        return bwB - bwA;
    });

    const rep = representations[0];
    const repId = rep.getAttribute('id') || '';
    const bandwidth = rep.getAttribute('bandwidth') || '';

    // SegmentTemplate can be directly on Representation or inherited from AdaptationSet
    const template = rep.querySelector('SegmentTemplate') || adaptationSet.querySelector('SegmentTemplate');
    if (!template) {
        throw new Error(`SegmentTemplate missing for representation ${repId}`);
    }

    const initTemplate = template.getAttribute('initialization') || '';
    const mediaTemplate = template.getAttribute('media') || '';
    const startNumber = parseInt(template.getAttribute('startNumber') || '1', 10);
    const timescale = parseInt(template.getAttribute('timescale') || '1', 10);

    // Resolve base URL for this adaptation set / representation
    let baseUrl = defaultBaseUrl;
    const repBase = rep.querySelector('BaseURL');
    const adBase = adaptationSet.querySelector('BaseURL');
    const specificBase = repBase?.textContent?.trim() || adBase?.textContent?.trim();
    if (specificBase) {
        baseUrl = /^https?:\/\//i.test(specificBase) ? specificBase : (baseUrl ? new URL(specificBase, baseUrl).href : specificBase);
    }

    function formatSegmentUrl(templateStr, number, time) {
        let formatted = templateStr
            .replace(/\$RepresentationID\$/g, repId)
            .replace(/\$Bandwidth\$/g, bandwidth);

        // Format $Number%0xd$ or $Number$
        formatted = formatted.replace(/\$Number(?:%0(\d+)d)?\$/g, (match, width) => {
            let numStr = String(number);
            if (width) {
                numStr = numStr.padStart(parseInt(width, 10), '0');
            }
            return numStr;
        });

        // Format $Time%0xd$ or $Time$
        formatted = formatted.replace(/\$Time(?:%0(\d+)d)?\$/g, (match, width) => {
            let timeStr = String(time);
            if (width) {
                timeStr = timeStr.padStart(parseInt(width, 10), '0');
            }
            return timeStr;
        });

        if (/^https?:\/\//i.test(formatted)) {
            return formatted;
        }
        if (baseUrl) {
            return new URL(formatted, baseUrl).href;
        }
        return formatted;
    }

    const segments = [];

    // Chunk 0: Initialization segment (ftyp, moov)
    if (initTemplate) {
        const initUrl = formatSegmentUrl(initTemplate, startNumber, 0);
        segments.push({
            index: 0,
            isInit: true,
            url: initUrl
        });
    }

    // Media segments from SegmentTimeline
    const timeline = template.querySelector('SegmentTimeline');
    if (!timeline) {
        throw new Error(`SegmentTimeline missing in SegmentTemplate for representation ${repId}`);
    }

    const sNodes = Array.from(timeline.querySelectorAll('S'));
    let currentTime = 0;
    let currentNumber = startNumber;

    for (const s of sNodes) {
        if (s.hasAttribute('t')) {
            currentTime = parseInt(s.getAttribute('t'), 10);
        }
        const d = parseInt(s.getAttribute('d'), 10);
        const r = parseInt(s.getAttribute('r') || '0', 10);
        const count = r >= 0 ? r + 1 : 1;

        for (let i = 0; i < count; i++) {
            const segUrl = formatSegmentUrl(mediaTemplate, currentNumber, currentTime);
            segments.push({
                index: segments.length, // Sequential chunk index: 0, 1, 2...
                isInit: false,
                number: currentNumber,
                time: currentTime,
                url: segUrl
            });

            currentTime += d;
            currentNumber += 1;
        }
    }

    console.log(`[offscreen.js] Extracted ${segments.length} chunks for ${repId} (timescale: ${timescale})`);
    return segments;
}

// ==========================================
// 3. Concurrent Downloader (Max 16 at a time) & Progress Tracking
// ==========================================

let currentPercentage = -1;

function resetProgress() {
    currentPercentage = -1;
}

function updateProgress(percentage) {
    const pct = Math.min(100, Math.max(0, Math.floor(percentage)));
    if (pct !== currentPercentage) {
        currentPercentage = pct;
        console.log(`[offscreen.js] Download progress: ${pct}%`);
        try {
            chrome.runtime.sendMessage({
                type: 'DOWNLOAD_PROGRESS',
                percentage: pct
            }).catch(() => {
                // Ignore if background receiver is inactive
            });
        } catch (_) {
            // Context may be invalidated or inactive
        }
    }
}

async function downloadSegmentsInParallel(segments, storeName, db, maxConcurrency = MAX_CONCURRENCY, onProgress = null) {
    let completedCount = 0;
    const totalCount = segments.length;
    let nextIndex = 0;

    async function fetchWithRetry(url, maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                return response;
            } catch (err) {
                if (attempt === maxRetries) throw err;
                console.warn(`[offscreen.js] Retry ${attempt}/${maxRetries} for ${url} after error:`, err.message || err);
                await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt - 1)));
            }
        }
    }

    async function worker() {
        while (nextIndex < totalCount) {
            const currentIndex = nextIndex++;
            const segment = segments[currentIndex];

            try {
                const res = await fetchWithRetry(segment.url);
                let arrayBuffer = await res.arrayBuffer();
                let uint8Data = new Uint8Array(arrayBuffer);

                // Write chunk to IndexedDB by index and immediately release array buffer
                await putChunk(db, storeName, segment.index, uint8Data);
                arrayBuffer = null;
                uint8Data = null;

                completedCount++;
                if (onProgress) {
                    onProgress(completedCount, totalCount);
                }
                if (completedCount % 20 === 0 || completedCount === totalCount) {
                    const pct = Math.round((completedCount / totalCount) * 100);
                    console.log(`[offscreen.js] [${storeName}] Downloaded ${completedCount}/${totalCount} chunks (${pct}%)`);
                }
            } catch (err) {
                console.error(`[offscreen.js] Failed downloading chunk ${segment.index} from ${segment.url}:`, err);
                throw err;
            }
        }
    }

    const workerCount = Math.min(maxConcurrency, totalCount);
    const workers = [];
    for (let i = 0; i < workerCount; i++) {
        workers.push(worker());
    }

    await Promise.all(workers);
    console.log(`[offscreen.js] [${storeName}] All ${totalCount} chunks successfully saved to IndexedDB.`);
}

// ==========================================
// 4. Subtitle Conversion Helper
// ==========================================

function convertToSrtIfNeeded(rawCaption) {
    if (!rawCaption) return '';

    let text = '';
    if (typeof rawCaption === 'string') {
        text = rawCaption;
    } else if (rawCaption instanceof ArrayBuffer || ArrayBuffer.isView(rawCaption)) {
        text = new TextDecoder().decode(rawCaption);
    } else {
        text = String(rawCaption);
    }

    text = text.replace(/^\uFEFF/, '').trim();
    if (!text) return '';

    // Helper to format timestamps into SRT HH:MM:SS,mmm
    function formatSrtTimestamp(ts) {
        ts = ts.trim();
        const parts = ts.split(':');
        let hours = '00';
        let minutes = '00';
        let secondsAndMs = '00,000';

        if (parts.length === 3) {
            hours = parts[0].padStart(2, '0');
            minutes = parts[1].padStart(2, '0');
            secondsAndMs = parts[2];
        } else if (parts.length === 2) {
            minutes = parts[0].padStart(2, '0');
            secondsAndMs = parts[1];
        } else if (parts.length === 1) {
            secondsAndMs = parts[0];
        }

        // Replace dot with comma for SRT millisecond separator
        secondsAndMs = secondsAndMs.replace('.', ',');
        const [sec = '00', ms = '000'] = secondsAndMs.split(',');
        const formattedSec = sec.padStart(2, '0');
        const formattedMs = ms.padEnd(3, '0').slice(0, 3);

        return `${hours}:${minutes}:${formattedSec},${formattedMs}`;
    }

    const lines = text.split(/\r?\n/);
    const srtBlocks = [];
    let cueIndex = 1;
    let i = 0;

    while (i < lines.length) {
        const line = lines[i].trim();

        // Check if this line contains a timestamp arrow
        if (line.includes('-->')) {
            const arrowIndex = line.indexOf('-->');
            const rawStart = line.substring(0, arrowIndex).trim();
            const rawEndWithSettings = line.substring(arrowIndex + 3).trim();
            const rawEnd = rawEndWithSettings.split(/\s+/)[0].trim();

            if (rawStart && rawEnd) {
                const srtStart = formatSrtTimestamp(rawStart);
                const srtEnd = formatSrtTimestamp(rawEnd);

                const cueTextLines = [];
                i++;
                while (i < lines.length && lines[i].trim() !== '') {
                    // Strip WebVTT/HTML tags like <c>, <b>, <i>, <v Name>
                    const clean = lines[i].replace(/<\/?[^>]+(>|$)/g, '').trim();
                    if (clean) {
                        cueTextLines.push(clean);
                    }
                    i++;
                }

                if (cueTextLines.length > 0) {
                    srtBlocks.push(`${cueIndex}\n${srtStart} --> ${srtEnd}\n${cueTextLines.join('\n')}`);
                    cueIndex++;
                }
            } else {
                i++;
            }
        } else {
            i++;
        }
    }

    if (srtBlocks.length === 0) {
        // If no '-->' found and not WebVTT, return original trimmed string
        if (!text.includes('WEBVTT')) {
            return text;
        }
        return '';
    }

    return srtBlocks.join('\n\n') + '\n';
}

// ==========================================
// 5. FFmpeg Muxing & Download Pipeline
// ==========================================

async function getFFmpeg() {
    if (ffmpegInstance && ffmpegInstance.loaded) {
        return ffmpegInstance;
    }

    const { FFmpeg } = window.FFmpegWASM || FFmpegWASM;
    const ffmpeg = new FFmpeg();

    ffmpeg.on('log', ({ message }) => {
        console.log('[FFmpeg Log]', message);
    });

    console.log('[offscreen.js] Loading FFmpeg wasm core...');
    await ffmpeg.load({
        coreURL: chrome.runtime.getURL('lib/ffmpeg/ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('lib/ffmpeg/ffmpeg-core.wasm')
    });
    console.log('[offscreen.js] FFmpeg loaded successfully');

    ffmpegInstance = ffmpeg;
    return ffmpegInstance;
}

async function startDownloadPipeline({ mpdData, captionData, captionUrl, title, mpdUrl }) {
    resetProgress();
    updateProgress(0);
    console.log(`[offscreen.js] Starting pipeline for: "${title}"`);

    // 1. Parse MPD XML
    console.log('[offscreen.js] Parsing MPD manifest...');
    const { videoSegments, audioSegments } = parseMpd(mpdData, mpdUrl);
    console.log(`[offscreen.js] MPD parsed: Video chunks=${videoSegments.length}, Audio chunks=${audioSegments.length}`);

    // 2. Open IndexedDB and clear previous data
    console.log('[offscreen.js] Opening IndexedDB storage...');
    const db = await openDatabase();
    await clearDatabase(db);
    console.log('[offscreen.js] IndexedDB storage cleared and ready');

    // 3. Download chunks with max 16 concurrency into IndexedDB (0% - 70%)
    const totalDownloadChunks = videoSegments.length + audioSegments.length;
    let completedChunks = 0;

    const onChunkDownloaded = () => {
        completedChunks++;
        if (totalDownloadChunks > 0) {
            const pct = (completedChunks / totalDownloadChunks) * 70;
            updateProgress(pct);
        }
    };

    console.log(`[offscreen.js] Fetching ${videoSegments.length} video chunks...`);
    await downloadSegmentsInParallel(videoSegments, VIDEO_STORE, db, MAX_CONCURRENCY, onChunkDownloaded);

    const hasAudio = audioSegments.length > 0;
    if (hasAudio) {
        console.log(`[offscreen.js] Fetching ${audioSegments.length} audio chunks...`);
        await downloadSegmentsInParallel(audioSegments, AUDIO_STORE, db, MAX_CONCURRENCY, onChunkDownloaded);
    }

    updateProgress(70);
    console.log('[offscreen.js] All media chunks downloaded to IndexedDB successfully.');

    // 4. Muxing with FFmpeg: Write chunks sequentially from IndexedDB to FFmpeg VFS (70% - 85%)
    const ffmpeg = await getFFmpeg();
    const totalChunksToWrite = videoSegments.length + audioSegments.length;
    let writtenChunks = 0;

    console.log(`[offscreen.js] Writing ${videoSegments.length} video chunks sequentially to FFmpeg VFS ("video.mp4")...`);
    for (let i = 0; i < videoSegments.length; i++) {
        let chunk = await getChunk(db, VIDEO_STORE, i);
        if (!chunk) {
            throw new Error(`Video chunk missing in IndexedDB at index ${i}`);
        }
        if (i === 0) {
            await ffmpeg.writeFile('video.mp4', chunk);
        } else {
            await ffmpeg.writeFile('video.mp4', chunk, { flags: 'a' });
        }
        chunk = null; // Release from memory
        writtenChunks++;
        if (totalChunksToWrite > 0) {
            updateProgress(70 + (writtenChunks / totalChunksToWrite) * 15);
        }
    }
    console.log('[offscreen.js] Video chunks successfully written to FFmpeg VFS.');

    if (hasAudio) {
        console.log(`[offscreen.js] Writing ${audioSegments.length} audio chunks sequentially to FFmpeg VFS ("audio.mp4")...`);
        for (let i = 0; i < audioSegments.length; i++) {
            let chunk = await getChunk(db, AUDIO_STORE, i);
            if (!chunk) {
                throw new Error(`Audio chunk missing in IndexedDB at index ${i}`);
            }
            if (i === 0) {
                await ffmpeg.writeFile('audio.mp4', chunk);
            } else {
                await ffmpeg.writeFile('audio.mp4', chunk, { flags: 'a' });
            }
            chunk = null; // Release from memory
            writtenChunks++;
            if (totalChunksToWrite > 0) {
                updateProgress(70 + (writtenChunks / totalChunksToWrite) * 15);
            }
        }
        console.log('[offscreen.js] Audio chunks successfully written to FFmpeg VFS.');
    }

    updateProgress(85);

    // Prepare captions/subtitles if provided
    let hasSubtitles = false;
    let finalCaptionData = captionData;

    if (!finalCaptionData && captionUrl) {
        console.log('[offscreen.js] Subtitles: captionUrl provided. Fetching subtitles from:', captionUrl);
        try {
            const capRes = await fetch(captionUrl);
            if (capRes.ok) {
                finalCaptionData = await capRes.text();
            }
        } catch (e) {
            console.warn('[offscreen.js] Subtitles: Failed to fetch captionUrl:', e);
        }
    }

    if (finalCaptionData && typeof finalCaptionData === 'string' && finalCaptionData.trim().length > 0) {
        console.log(`[offscreen.js] Subtitles: captionData found (${finalCaptionData.length} chars). Converting to SRT format...`);
        try {
            const srt = convertToSrtIfNeeded(finalCaptionData);
            if (srt && srt.trim().length > 0) {
                console.log(`[offscreen.js] Subtitles: Converted to SRT successfully (${srt.length} chars). Writing "subs.srt" to FFmpeg VFS...`);
                const encoder = new TextEncoder();
                await ffmpeg.writeFile('subs.srt', encoder.encode(srt));
                hasSubtitles = true;
                console.log('[offscreen.js] Subtitles: "subs.srt" written to FFmpeg VFS successfully.');
            } else {
                console.warn('[offscreen.js] Subtitles: Converted subtitles resulted in empty content. Skipping subtitle muxing.');
            }
        } catch (subErr) {
            console.error('[offscreen.js] Subtitles: Error processing or writing subtitle data:', subErr);
            hasSubtitles = false;
        }
    } else {
        console.log('[offscreen.js] Subtitles: None found or empty. Skipping subtitle muxing.');
    }

    // 5. Run FFmpeg muxing (85% - 95%)
    console.log('[offscreen.js] Starting FFmpeg muxing...');
    let captionsMuxed = false;

    const onFfmpegProgress = ({ progress }) => {
        if (typeof progress === 'number' && progress >= 0 && progress <= 1) {
            updateProgress(85 + progress * 10);
        }
    };

    try {
        ffmpeg.on('progress', onFfmpegProgress);
    } catch (_) {}

    // First attempt: Mux with subtitles if available
    if (hasSubtitles) {
        const ffmpegArgsWithSubs = ['-y', '-i', 'video.mp4'];
        if (hasAudio) {
            ffmpegArgsWithSubs.push('-i', 'audio.mp4');
        }
        ffmpegArgsWithSubs.push('-i', 'subs.srt');
        ffmpegArgsWithSubs.push('-c:v', 'copy');
        if (hasAudio) {
            ffmpegArgsWithSubs.push('-c:a', 'copy');
        }
        ffmpegArgsWithSubs.push('-c:s', 'mov_text');
        ffmpegArgsWithSubs.push('final.mp4');

        console.log('[offscreen.js] Executing FFmpeg command with captions:', ffmpegArgsWithSubs.join(' '));
        try {
            const ret = await ffmpeg.exec(ffmpegArgsWithSubs);
            if (ret === 0) {
                captionsMuxed = true;
                console.log('[offscreen.js] Subtitles: Captions were found and successfully muxed into the video.');
            } else {
                console.warn(`[offscreen.js] Subtitles: FFmpeg mux with captions exited with non-zero code (${ret}). Retrying without captions so video merge succeeds...`);
            }
        } catch (subMuxErr) {
            console.warn('[offscreen.js] Subtitles: FFmpeg mux with captions encountered an error:', subMuxErr, '. Retrying without captions so video merge succeeds...');
        }
    }

    // Fallback: If captions muxing failed or was not requested, mux video (+ audio) without subtitles
    if (!captionsMuxed) {
        if (hasSubtitles) {
            console.log('[offscreen.js] Retrying FFmpeg mux without captions so video merge succeeds...');
        } else {
            console.log('[offscreen.js] Executing FFmpeg mux without captions...');
        }

        const ffmpegArgsNoSubs = ['-y', '-i', 'video.mp4'];
        if (hasAudio) {
            ffmpegArgsNoSubs.push('-i', 'audio.mp4');
        }
        ffmpegArgsNoSubs.push('-c:v', 'copy');
        if (hasAudio) {
            ffmpegArgsNoSubs.push('-c:a', 'copy');
        }
        ffmpegArgsNoSubs.push('final.mp4');

        console.log('[offscreen.js] Executing FFmpeg command:', ffmpegArgsNoSubs.join(' '));
        const ret = await ffmpeg.exec(ffmpegArgsNoSubs);
        if (ret !== 0) {
            throw new Error(`FFmpeg muxing failed with exit code ${ret}`);
        }
        console.log('[offscreen.js] FFmpeg mux without captions completed successfully.');
    }

    try {
        ffmpeg.off('progress', onFfmpegProgress);
    } catch (_) {}

    updateProgress(95);

    // 6. Read final.mp4 into a Blob and trigger browser download (95% - 100%)
    console.log('[offscreen.js] Reading "final.mp4" from FFmpeg VFS...');
    updateProgress(97);
    const finalData = await ffmpeg.readFile('final.mp4');
    console.log(`[offscreen.js] "final.mp4" read successfully (${finalData.byteLength || finalData.length} bytes). Creating Blob...`);
    const blob = new Blob([finalData.buffer || finalData], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);

    const safeTitle = (title || 'video')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim() || 'video';
    const timestamp = Math.floor(Date.now() / 1000);
    const filename = `${safeTitle} - ${timestamp}.mp4`;

    console.log('[offscreen.js] Initiating download for filename:', filename);
    try {
        if (chrome.downloads && chrome.downloads.download) {
            await chrome.downloads.download({ url: blobUrl, filename });
            console.log('[offscreen.js] Direct chrome.downloads download initiated for:', filename);
        } else {
            console.log('[offscreen.js] chrome.downloads not directly available, sending TRIGGER_DOWNLOAD to background...');
            await chrome.runtime.sendMessage({
                type: 'TRIGGER_DOWNLOAD',
                url: blobUrl,
                filename
            });
        }
    } catch (dlErr) {
        console.warn('[offscreen.js] Direct download failed, delegating to background service worker:', dlErr);
        await chrome.runtime.sendMessage({
            type: 'TRIGGER_DOWNLOAD',
            url: blobUrl,
            filename
        });
    }

    updateProgress(100);

    // Cleanup FFmpeg virtual files & IndexedDB
    console.log('[offscreen.js] Cleaning up FFmpeg virtual files and clearing IndexedDB...');
    try {
        await ffmpeg.deleteFile('video.mp4');
    } catch (_) {}
    if (hasAudio) {
        try {
            await ffmpeg.deleteFile('audio.mp4');
        } catch (_) {}
    }
    if (hasSubtitles) {
        try {
            await ffmpeg.deleteFile('subs.srt');
        } catch (_) {}
    }
    try {
        await ffmpeg.deleteFile('final.mp4');
    } catch (_) {}

    await clearDatabase(db);
    console.log(`[offscreen.js] Download pipeline fully completed successfully for: "${filename}"`);
}

// ==========================================
// 6. Message Listener
// ==========================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target === 'offscreen' || message.type === 'START_DOWNLOAD' || message.action === 'START_DOWNLOAD' || message.mpdData) {
        const mpdData = message.mpdData || (message.data && message.data.mpdData);
        const captionData = message.captionData || (message.data && message.data.captionData);
        const captionUrl = message.captionUrl || (message.data && message.data.captionUrl) || '';
        const title = message.title || (message.data && message.data.title) || 'video';
        const mpdUrl = message.mpdUrl || (message.data && message.data.mpdUrl) || '';

        if (!mpdData) {
            console.error('[offscreen.js] START_DOWNLOAD received without mpdData');
            sendResponse({ success: false, error: 'No mpdData provided' });
            return;
        }

        console.log('[offscreen.js] Received START_DOWNLOAD for:', title);
        sendResponse({ success: true, status: 'download_started' });

        startDownloadPipeline({ mpdData, captionData, captionUrl, title, mpdUrl })
            .then(() => {
                console.log('[offscreen.js] Pipeline finished successfully for:', title);
            })
            .catch((err) => {
                console.error('[offscreen.js] Pipeline error for:', title, err);
                try {
                    chrome.runtime.sendMessage({
                        type: 'DOWNLOAD_ERROR',
                        error: err.message || String(err),
                        title
                    }).catch(() => {});
                } catch (_) {}
            });

        return true;
    }
});

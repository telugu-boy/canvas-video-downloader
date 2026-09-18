// content.js - Listens for intercepted MPD & captions and injects download button into player UI

let mpdData = null;
let captionData = null;
let mpdUrl = null;
let captionUrl = null;

// Listen for intercepted network data from inject.js
window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    if (event.data && typeof event.data === 'object') {
        if (event.data.type === 'CANVAS_MPD') {
            mpdData = event.data.data;
            mpdUrl = event.data.url;
            console.log('[Canvas Video DL] Captured MPD manifest');
        } else if (event.data.type === 'CANVAS_CAPTIONS') {
            captionData = event.data.data;
            captionUrl = event.data.url;
            console.log('[Canvas Video DL] Captured Captions data');
        } else if (event.data.type === 'CANVAS_CAPTIONS_URL') {
            captionUrl = event.data.url;
            console.log('[Canvas Video DL] Captured Captions URL from perspective API:', captionUrl);
        } else if (event.data.type === 'DOWNLOAD_PROGRESS') {
            const buttons = document.querySelectorAll('[data-canvas-dl-btn]');
            if (buttons.length === 0) return;

            const percentage = Math.max(0, Math.min(100, typeof event.data.percentage === 'number' ? event.data.percentage : (parseFloat(event.data.percentage) || 0)));
            currentProgress = percentage;
            
            const now = Date.now();
            if (now - lastLogTime >= 1000 || percentage === 100 || percentage === 0) {
                console.log(`[Canvas Video DL] Download progress: ${percentage}%`);
                lastLogTime = now;
            }

            buttons.forEach((btn) => {
                updateButtonProgress(btn, percentage);
                if (percentage === 100) {
                    btn.removeAttribute('title');
                }
            });
        }
    }
});

function getTitle() {
    // Try data-media-player aria-label (e.g. "Video Player - North Saskatchewan River Valley Tour")
    const player = document.querySelector('[data-media-player][aria-label]');
    if (player) {
        const label = player.getAttribute('aria-label') || '';
        const match = label.replace(/^Video Player\s*[-–:]\s*/i, '').trim();
        if (match) return match;
    }

    // Try kebab menu button (e.g. "Actions for North Saskatchewan River Valley Tour")
    const kebab = document.querySelector('button[aria-label*="Actions for "]');
    if (kebab) {
        const label = kebab.getAttribute('aria-label') || '';
        const match = label.replace(/^Actions for\s+/i, '').trim();
        if (match) return match;
    }

    // Fallback to document title
    if (document.title && document.title.trim()) {
        return document.title.trim();
    }

    return 'canvas-video';
}

function attachDownloadButton() {
    const rightControlsList = document.querySelectorAll('div[class*="_right-controls"]');
    rightControlsList.forEach((controlsContainer) => {
        if (controlsContainer.querySelector('[data-canvas-dl-btn]')) {
            return;
        }

        const ccBtn = controlsContainer.querySelector('button[aria-label="Captions"]');
        if (!ccBtn) {
            return;
        }

        // Clone captions button to inherit all classes and hover styles
        const dlBtn = ccBtn.cloneNode(true);
        dlBtn.setAttribute('data-canvas-dl-btn', 'true');
        dlBtn.setAttribute('aria-label', 'Download');
        dlBtn.removeAttribute('aria-pressed');
        dlBtn.removeAttribute('id');

        // Change SVG path to a download icon
        const svg = dlBtn.querySelector('svg');
        if (svg) {
            svg.innerHTML = '<path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" fill="currentColor"></path>';
        }

        // If a download is already in progress, apply current progress style
        if (currentProgress !== null) {
            updateButtonProgress(dlBtn, currentProgress);
        }

        // Handle download click
        dlBtn.addEventListener('click', async (e) => {
            if (!e.isTrusted) {
                console.log('[Canvas Video DL] Ignored untrusted (programmatic) click on download button.');
                return;
            }
            if (currentProgress !== null && currentProgress < 100) {
                console.log('[Canvas Video DL] Cancelling current download.');
                chrome.runtime.sendMessage({ type: 'CANCEL_DOWNLOAD' });
                currentProgress = null;
                const buttons = document.querySelectorAll('[data-canvas-dl-btn]');
                buttons.forEach(b => {
                    b.removeAttribute('title');
                    b.style.background = '';
                    b.style.cursor = '';
                });
                return;
            }
            e.preventDefault();
            e.stopPropagation();

            // Instantly show downloading state
            currentProgress = 0;
            updateButtonProgress(dlBtn, 0);

            // Fallback: If mpdData not yet captured via fetch, try source tag if available
            if (!mpdData) {
                const sourceTag = document.querySelector('source[src*="manifest.mpd"]');
                if (sourceTag && sourceTag.src) {
                    try {
                        const res = await fetch(sourceTag.src);
                        if (res.ok) {
                            mpdData = await res.text();
                            mpdUrl = sourceTag.src;
                        }
                    } catch (err) {
                        console.warn('[Canvas Video DL] Fallback fetch for MPD failed:', err);
                    }
                }
            }

            // Fallback: Find caption url from video tracks if not intercepted
            if (!captionUrl && !captionData) {
                const track = document.querySelector('video track[kind="captions"], video track[kind="subtitles"]');
                if (track && track.src) {
                    captionUrl = track.src;
                    console.log('[Canvas Video DL] Found caption URL in DOM:', captionUrl);
                }
            }

            const title = getTitle();

            chrome.runtime.sendMessage({
                type: 'START_DOWNLOAD',
                action: 'START_DOWNLOAD',
                mpdData: mpdData,
                mpdUrl: mpdUrl,
                captionData: captionData,
                captionUrl: captionUrl,
                title: title
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('[Canvas Video DL] Failed to send START_DOWNLOAD:', chrome.runtime.lastError.message);
                } else {
                    console.log('[Canvas Video DL] START_DOWNLOAD acknowledged by background:', response);
                }
            });
        });

        // Insert to the left of the Captions button
        ccBtn.parentNode.insertBefore(dlBtn, ccBtn);
    });
}

let currentProgress = null;
let lastLogTime = 0;

function updateButtonProgress(btn, percentage) {
    if (percentage === 100) {
        btn.removeAttribute('title');
        btn.style.background = '#4CAF50';
        btn.style.cursor = 'pointer';
    } else {
        btn.setAttribute('title', `Downloading: ${percentage}%`);
        btn.style.background = `linear-gradient(to right, #1e88e5 ${percentage}%, #808080 ${percentage}%)`;
        btn.style.cursor = 'pointer';
    }
    btn.style.overflow = 'hidden';
    if (!btn.style.borderRadius) {
        btn.style.borderRadius = '4px';
    }
}

// Listen for progress updates from background/offscreen
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'DOWNLOAD_PROGRESS') {
        const buttons = document.querySelectorAll('[data-canvas-dl-btn]');
        if (buttons.length === 0) return;

        const percentage = Math.max(0, Math.min(100, typeof message.percentage === 'number' ? message.percentage : (parseFloat(message.percentage) || 0)));
        currentProgress = percentage;
        
        const now = Date.now();
        if (now - lastLogTime >= 1000 || percentage === 100 || percentage === 0) {
            console.log(`[Canvas Video DL] Download progress: ${percentage}%`);
            lastLogTime = now;
        }

        buttons.forEach((btn) => {
            updateButtonProgress(btn, percentage);
            if (percentage === 100) {
                btn.removeAttribute('title');
            }
        });
    } else if (message.type === 'DOWNLOAD_ERROR') {
        console.error('[Canvas Video DL] Download error:', message.error);
    }
});

// Initial scan
attachDownloadButton();

// Observe DOM for dynamic player rendering or layout changes
const observer = new MutationObserver(() => {
    attachDownloadButton();
});

observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true
});

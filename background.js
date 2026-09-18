// background.js - Service Worker handling offscreen document lifecycle and download dispatching

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

/**
 * Checks if the offscreen document is already created.
 */
async function hasOffscreenDocument() {
    if ('getContexts' in chrome.runtime) {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
        });
        return Boolean(contexts.length);
    }
    return false;
}

/**
 * Creates the offscreen document if it does not already exist.
 */
async function setupOffscreenDocument() {
    if (await hasOffscreenDocument()) {
        return;
    }

    try {
        await chrome.offscreen.createDocument({
            url: OFFSCREEN_DOCUMENT_PATH,
            reasons: ['BLOBS', 'WORKERS'],
            justification: 'Fetch DASH stream fragments in parallel and mux using FFmpeg'
        });
    } catch (error) {
        // If another request created it concurrently, ignore the error
        if (!error.message || !error.message.includes('Only a single offscreen document')) {
            throw error;
        }
    }
}

// Listen for messages from content scripts or offscreen document
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'DOWNLOAD_PROGRESS') {
        console.log(`[background.js] Download progress: ${message.percentage}%`);
        // Forward progress to active tab(s) so UI can reflect it
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs && tabs.length > 0) {
                tabs.forEach((tab) => {
                    const res = chrome.tabs.sendMessage(tab.id, message, () => {
                        if (chrome.runtime.lastError) {
                            // Suppress error if content script not listening or tab closed
                        }
                    });
                    if (res && typeof res.catch === 'function') {
                        res.catch(() => {});
                    }
                });
            } else {
                chrome.tabs.query({ active: true }, (allTabs) => {
                    if (allTabs && allTabs.length > 0) {
                        allTabs.forEach((tab) => {
                            const res = chrome.tabs.sendMessage(tab.id, message, () => {
                                if (chrome.runtime.lastError) {
                                    // Suppress error
                                }
                            });
                            if (res && typeof res.catch === 'function') {
                                res.catch(() => {});
                            }
                        });
                    }
                });
            }
        });
        return;
    }

    if (message.type === 'DOWNLOAD_ERROR') {
        console.error(`[background.js] Download pipeline error received:`, message.error);
        return;
    }

    if (message.type === 'TRIGGER_DOWNLOAD') {
        console.log(`[background.js] Triggering download for: "${message.filename}"`);
        chrome.downloads.download({
            url: message.url,
            filename: message.filename
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                console.error('[background.js] Download failed:', chrome.runtime.lastError.message);
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
                console.log('[background.js] Download successfully initiated with id:', downloadId);
                sendResponse({ success: true, downloadId });
            }
        });
        return true;
    }

    // Avoid handling messages targeted to the offscreen document
    if (message.target === 'offscreen') {
        return;
    }

    if (message.type === 'START_DOWNLOAD' || message.action === 'START_DOWNLOAD') {
        console.log(`[background.js] Handling START_DOWNLOAD for: "${message.title}"`);
        (async () => {
            try {
                await setupOffscreenDocument();
                console.log('[background.js] Offscreen document setup verified');

                // Small delay to ensure offscreen listeners are attached if document was just created
                await new Promise((resolve) => setTimeout(resolve, 150));

                // Forward data to the offscreen document
                console.log('[background.js] Forwarding download task to offscreen document...');
                chrome.runtime.sendMessage({
                    target: 'offscreen',
                    type: 'START_DOWNLOAD',
                    action: 'START_DOWNLOAD',
                    mpdData: message.mpdData,
                    mpdUrl: message.mpdUrl,
                    captionData: message.captionData,
                    title: message.title
                }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.warn('[background.js] Warning when dispatching to offscreen document:', chrome.runtime.lastError.message);
                    } else {
                        console.log('[background.js] Offscreen document acknowledged task dispatch:', response);
                    }
                });

                sendResponse({ success: true, status: 'offscreen_loaded' });
            } catch (err) {
                console.error('[background.js] Error initializing offscreen document:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();

        return true; // Keep message port open for async response
    }
});

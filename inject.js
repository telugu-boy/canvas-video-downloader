// inject.js - Runs in the MAIN world to intercept fetch requests
(function () {
    if (window.__canvas_video_dl_fetch_injected) {
        return;
    }
    window.__canvas_video_dl_fetch_injected = true;

    const originalFetch = window.fetch;

    function extractUrl(input) {
        if (typeof input === 'string') {
            return input;
        }
        if (input instanceof URL) {
            return input.href;
        }
        if (input && typeof input === 'object' && input.url) {
            return input.url;
        }
        return '';
    }

    window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);

        try {
            const reqUrl = extractUrl(args[0]);
            const resUrl = response.url || '';
            const targetUrl = resUrl || reqUrl;

            if (reqUrl.includes('manifest.mpd') || resUrl.includes('manifest.mpd')) {
                const clone = response.clone();
                clone.text().then((text) => {
                    window.postMessage({
                        type: 'CANVAS_MPD',
                        data: text,
                        url: targetUrl
                    }, '*');
                }).catch((err) => {
                    console.error('[Canvas Video DL] Error reading manifest.mpd text:', err);
                });
            } else if (reqUrl.includes('/caption_files/') || resUrl.includes('/caption_files/')) {
                const clone = response.clone();
                clone.text().then((text) => {
                    window.postMessage({
                        type: 'CANVAS_CAPTIONS',
                        data: text,
                        url: targetUrl
                    }, '*');
                }).catch((err) => {
                    console.error('[Canvas Video DL] Error reading caption text:', err);
                });
            } else if (reqUrl.includes('/api/media_management/perspectives/') || resUrl.includes('/api/media_management/perspectives/')) {
                const clone = response.clone();
                clone.json().then((json) => {
                    try {
                        let mediaData = json?.perspective?.media;
                        if (mediaData) {
                            const mediaList = Array.isArray(mediaData) ? mediaData : [mediaData];
                            for (const media of mediaList) {
                                if (Array.isArray(media.captions) && media.captions.length > 0) {
                                    // Use the first available caption URL, or prefer English if you want to be fancy.
                                    // Here we just grab the first valid URL we find.
                                    for (const cap of media.captions) {
                                        if (cap.url) {
                                            let fullUrl = cap.url;
                                            if (fullUrl.startsWith('/')) {
                                                const urlObj = new URL(targetUrl);
                                                fullUrl = urlObj.origin + fullUrl;
                                            }
                                            window.postMessage({
                                                type: 'CANVAS_CAPTIONS_URL',
                                                url: fullUrl
                                            }, '*');
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.error('[Canvas Video DL] Error parsing perspectives JSON for captions:', e);
                    }
                }).catch((err) => {
                    console.error('[Canvas Video DL] Error reading perspectives JSON:', err);
                });
            }
        } catch (err) {
            console.error('[Canvas Video DL] Fetch intercept error:', err);
        }

        return response;
    };
})();

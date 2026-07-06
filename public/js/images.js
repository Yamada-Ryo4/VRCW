/*
 * VRCW — images.js
 * 图片懒加载/视口取消/批量预取
 *
 * 注意：本项目为「经典脚本」(非 ES module)，全部按顺序加载、共享全局作用域。
 * 函数声明会提升为全局，跨文件调用没问题；请勿改为 type="module"。
 */
// Smart Image Loading with Viewport Cancellation
// Strategy (rev 2026-06-19):
// - Preload nearby thumbnails only: rootMargin 600px, so first-screen cards do
//   not wait behind far-off images.
// - Leaving the viewport removes pending queue items and aborts in-flight fetches,
//   freeing concurrency slots for currently visible cards.
// - Each image has a 15s timeout so a slow origin cannot monopolize a slot.
// - Higher concurrency (12) still keeps visible grids filling quickly.
const imageQueue = [];
// O(1) membership check: img → true if the img is currently in imageQueue.
// Replaces the O(n) findIndex scans that blocked the main thread during fast
// scrolling (30 images × 50-item queue = 1500 comparisons per scroll tick).
const _imageQueueSet = new WeakSet();
let runningLoads = 0;
const MAX_CONCURRENT_IMAGES = 12;
const loadedImageUrls = new Set();
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// Helper: remove an img from imageQueue + WeakSet in O(n) but only called
// when we actually know the img IS in the set (O(1) guard at call sites).
function _removeFromImageQueue(img) {
  const idx = imageQueue.findIndex(it => it.img === img);
  if (idx !== -1) imageQueue.splice(idx, 1);
  _imageQueueSet.delete(img);
}

function setImageBlobSrc(img, blob) {
  if (!img || !blob) return;
  if (img.dataset.blobUrl) {
    try { URL.revokeObjectURL(img.dataset.blobUrl); } catch (_) {}
    delete img.dataset.blobUrl;
  }
  const blobUrl = URL.createObjectURL(blob);
  img.dataset.blobUrl = blobUrl;
  img.src = blobUrl;
}

function revokeImageBlobSrc(img) {
  if (!img || !img.dataset.blobUrl) return;
  try { URL.revokeObjectURL(img.dataset.blobUrl); } catch (_) {}
  delete img.dataset.blobUrl;
}

function imageCacheKey(src) {
  if (!src || !src.includes('/api/image')) return src || '';
  try {
    const u = new URL(src, location.href);
    return `${u.searchParams.get('bucket') || _apiAuthBucket()}::${u.searchParams.get('url') || src}`;
  } catch (_) {
    return src;
  }
}

function processImageQueue() {
  while (runningLoads < MAX_CONCURRENT_IMAGES && imageQueue.length > 0) {
    runningLoads++;
    const { img, src } = imageQueue.shift();
    _imageQueueSet.delete(img);

    // Skip if cancelled while waiting in queue
    if (img.dataset.cancelled) {
      delete img.dataset.loading;
      delete img.dataset.cancelled;
      runningLoads--;
      continue;
    }

    const wrapper = img.parentElement;
    const cacheKey = imageCacheKey(src);

    // Called on successful load or permanent failure
    const finishLoad = (success) => {
      img.onload = img.onerror = null;
      delete img._abortCtrl;
      img.classList.remove('loading');
      if (wrapper) wrapper.classList.remove('img-loading');
      runningLoads--;
      if (success) {
        img.removeAttribute('data-src');
        delete img.dataset.loading;
        avatarObserver.unobserve(img);
      }
      processImageQueue();
    };

    // Called when fetch is aborted (scrolled out) — restore state for retry
    const cancelLoad = () => {
      img.onload = img.onerror = null;
      delete img._abortCtrl;
      delete img.dataset.cancelled;
      delete img.dataset.loading; // Allow re-queuing on next intersection
      img.classList.remove('loading');
      if (wrapper) wrapper.classList.remove('img-loading');
      // Don't unobserve — observer will retrigger when image re-enters viewport
      runningLoads--;
      processImageQueue();
    };

    img.onload = () => { loadedImageUrls.add(cacheKey); revokeImageBlobSrc(img); finishLoad(true); };
    img.onerror = () => {
      const retryCount = parseInt(img.dataset.retry || '0');
      if (retryCount < 2 && !img.dataset.cancelled) {
        img.dataset.retry = retryCount + 1;
        imageQueue.push({ img, src }); _imageQueueSet.add(img);
        finishLoad(false);
      } else {
        img.classList.add('failed');
        if (wrapper) {
          wrapper.classList.add('img-failed');
          // Tap-to-retry: clicking a failed thumbnail re-queues it. The user
          // shouldn't have to scroll out + back in just to retry a transient
          // CDN hiccup. Listener is one-shot per failure.
          if (!wrapper.dataset.retryWired) {
            wrapper.dataset.retryWired = '1';
            wrapper.style.cursor = 'pointer';
            wrapper.title = t('image.clickToRetry');
            const onRetryClick = (e) => {
              e.stopPropagation();
              wrapper.classList.remove('img-failed');
              wrapper.style.cursor = '';
              wrapper.title = '';
              delete wrapper.dataset.retryWired;
              wrapper.removeEventListener('click', onRetryClick);
              img.classList.remove('failed');
              img.dataset.retry = '0';
              const oldSrc = img.getAttribute('data-src');
              // If data-src was already cleared, recover from the current src
              const recoverSrc = oldSrc || img.src;
              if (recoverSrc) {
                img.setAttribute('data-src', recoverSrc);
                img.dataset.loading = '1';
                imageQueue.push({ img, src: recoverSrc }); _imageQueueSet.add(img);
                processImageQueue();
              }
            };
            wrapper.addEventListener('click', onRetryClick);
          }
        }
        img.removeAttribute('data-src');
        delete img.dataset.loading;
        avatarObserver.unobserve(img);
        finishLoad(false);
      }
    };

    img.classList.add('loading');
    if (wrapper) wrapper.classList.add('img-loading');

    // Check IDB cache first (instant, no network)
    idb.getImage(cacheKey).then(blob => {
      if (img.dataset.cancelled) { cancelLoad(); return; }

      if (blob) {
        setImageBlobSrc(img, blob);
        // onload fires → finishLoad(true)
      } else {
        // Yield to priority tasks (tab switches etc.)
        if (isPriorityTaskRunning) {
          imageQueue.unshift({ img, src }); _imageQueueSet.add(img);
          runningLoads--;
          setTimeout(processImageQueue, 500);
          return;
        }

        // Fetch with AbortController so we can cancel mid-flight
        const ctrl = new AbortController();
        img._abortCtrl = ctrl;
        const _imgTimeout = setTimeout(() => { try { ctrl.abort(); } catch(_) {} }, 15000);

        fetch(src, { signal: ctrl.signal })
          .then(r => r.blob())
          .then(blob => {
            clearTimeout(_imgTimeout);
            delete img._abortCtrl;
            if (img.dataset.cancelled) { cancelLoad(); return; }
            if (blob && blob.type.startsWith('image/')) {
              idb.setImage(cacheKey, blob);
              setImageBlobSrc(img, blob);
              // onload fires → finishLoad(true)
            } else {
              img.src = src; // Fallback direct URL
            }
          })
          .catch(e => {
            clearTimeout(_imgTimeout);
            delete img._abortCtrl;
            if (e.name === 'AbortError') {
              cancelLoad(); // Clean cancel — restore for retry
            } else {
              img.src = src; // Network error fallback
            }
          });
      }
    }).catch(() => { finishLoad(false); });
  }
}

// Batched avatar observer: collects enter/leave events during a scroll tick
// and flushes them in a single rAF. This prevents dozens of synchronous
// findIndex + splice operations from blocking the main thread during fast
// scrolling through 1000+ search results.
const _avatarObsPendingEnter = new Set();
const _avatarObsPendingLeave = new Set();
let _avatarObsRafPending = false;

function _flushAvatarObsQueue() {
  _avatarObsRafPending = false;
  // Process enters: queue for load
  for (const img of _avatarObsPendingEnter) {
    _avatarObsPendingLeave.delete(img); // cancel any pending leave
    delete img.dataset.cancelled;
    const src = img.getAttribute('data-src');
    if (src && !img.dataset.loading) {
      img.dataset.loading = '1';
      imageQueue.push({ img, src }); _imageQueueSet.add(img);
    }
    // Skip bubble-to-front — rAF batch already prioritizes recent entries
  }
  _avatarObsPendingEnter.clear();
  // Process leaves: cancel / remove from queue
  for (const img of _avatarObsPendingLeave) {
    const src = img.getAttribute('data-src');
    if (!src) continue;
    if (_imageQueueSet.has(img)) { // O(1) check instead of O(n) findIndex
      _removeFromImageQueue(img);
      delete img.dataset.loading;
      delete img.dataset.cancelled;
    }
    if (img._abortCtrl && !img.dataset.cancelled) {
      img.dataset.cancelled = '1';
      img._abortCtrl.abort();
    }
  }
  _avatarObsPendingLeave.clear();
  // Kick the queue once after all changes
  processImageQueue();
}

const avatarObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        _avatarObsPendingLeave.delete(entry.target);
        _avatarObsPendingEnter.add(entry.target);
      } else {
        _avatarObsPendingEnter.delete(entry.target);
        _avatarObsPendingLeave.add(entry.target);
      }
    }
    if (!_avatarObsRafPending) {
      _avatarObsRafPending = true;
      requestAnimationFrame(_flushAvatarObsQueue);
    }
  },
  { rootMargin: '600px 0px' }
);

// ── Batch Image Prefetch ──
// Sends thumbnail URLs to the Worker's batch endpoint so it can
// download them from VRC's servers at edge speed and cache them.
function prefetchThumbnails(avatarList) {
  const rawUrls = avatarList
    .map(av => av.thumbnailImageUrl || av.imageUrl || "")
    .filter(u => u && (u.includes("api.vrchat.cloud") || u.includes("files.vrchat.cloud")));

  // Skip URLs already in the browser's memory cache
  const cacheKeys = rawUrls.map(u =>
    imageCacheKey(`${API_BASE}/api/image?url=${encodeURIComponent(u)}&auth=${encodeURIComponent(vrcAuth || "")}&bucket=${encodeURIComponent(_apiAuthBucket())}`)
  );
  const uncached = rawUrls.filter((_, i) => !loadedImageUrls.has(cacheKeys[i]));
  if (!uncached.length) return;

  // Chunk into batches of 40 (CF Worker subrequest limit; keep headroom for cache ops)
  const BATCH_SIZE = 40;
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    const batch = uncached.slice(i, i + BATCH_SIZE);
    apiCall("/api/images/prefetch", {
      method: "POST",
      json: { urls: batch, bucket: _apiAuthBucket() },
    })
      .then(r => r.json())
      .then(d => {
        if (d.fetched > 0) logMsg(`<i class="fa-solid fa-bolt"></i> Prefetched ${d.fetched} thumbnails at edge`, "info");
      })
      .catch(() => {}); // Silent fail
  }
}

VRCW.registerModule('images', { imageCacheKey, processImageQueue, prefetchThumbnails });
renderAppVersionInfo();

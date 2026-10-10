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

// Display blobs belong to their element until replacement/removal, not merely
// until onload. Open-image viewers own a separate blob and never reuse img.src.
const _imageElements = new Set();
const _imageFetchControllers = new Set();
const _backgroundImages = new Map();
const _openImageViewers = new Set();
const _imageMimeTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function _imageSessionToken() {
  if (typeof makeAuthSessionToken === 'function') return makeAuthSessionToken();
  return Object.freeze({
    epoch: typeof authSessionEpoch === 'number' ? authSessionEpoch : null,
    bucket: typeof _apiAuthBucket === 'function' ? _apiAuthBucket() : '',
    credential: typeof vrcAuth === 'string' ? vrcAuth : ''
  });
}

function _imageSessionCurrent(token) {
  if (typeof isAuthSessionCurrent === 'function') return isAuthSessionCurrent(token);
  return !!token && (token.epoch == null || token.epoch === authSessionEpoch)
    && (!token.bucket || typeof _apiAuthBucket !== 'function' || token.bucket === _apiAuthBucket());
}

function _imageAbortError() {
  const error = new Error('Image load cancelled');
  error.name = 'AbortError';
  return error;
}

function _imageMimeAllowed(type) {
  return _imageMimeTypes.has(String(type || '').split(';')[0].trim().toLowerCase());
}

function _imageRequestUrl(src) {
  const clean = proxyImg(src);
  if (!clean) throw new Error('Invalid image URL');
  const url = new URL(clean, location.href);
  if (url.origin !== location.origin || !['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid image URL');
  if (url.pathname === '/api/image') {
    const target = new URL(url.searchParams.get('url') || '');
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid image URL');
  }
  return url;
}

function _imageCanAuthenticate(url) {
  if (url.origin !== location.origin || url.pathname !== '/api/image') return false;
  try {
    const host = new URL(url.searchParams.get('url')).hostname.toLowerCase();
    return host === 'vrchat.com' || host.endsWith('.vrchat.com')
      || host === 'vrchat.cloud' || host.endsWith('.vrchat.cloud');
  } catch (_) { return false; }
}

// The only network transport for image bytes. Never attach auth to a remote
// request, a community target, a native src, or a cache key. Reject error bodies
// and active image formats before creating a display/open object URL.
async function fetchImageBlob(src, { signal, sessionToken = _imageSessionToken(), anonymous = false, timeoutMs = 15000 } = {}) {
  if (!_imageSessionCurrent(sessionToken)) throw _imageAbortError();
  const url = _imageRequestUrl(src);
  const ctrl = new AbortController();
  const signals = [signal, typeof authSessionAbortController !== 'undefined' ? authSessionAbortController.signal : null].filter(Boolean);
  const abort = () => ctrl.abort();
  signals.forEach(s => { if (s.aborted) abort(); else s.addEventListener('abort', abort, { once: true }); });
  _imageFetchControllers.add(ctrl);
  let timedOut = false;
  const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs) : null;
  const headers = new Headers();
  if (!anonymous && _imageCanAuthenticate(url) && typeof vrcAuth === 'string' && vrcAuth) headers.set('X-VRC-Auth', vrcAuth);
  try {
    if (ctrl.signal.aborted) throw _imageAbortError();
    const response = await fetch(url.href, {
      headers, signal: ctrl.signal, mode: 'same-origin', credentials: 'omit',
      redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store',
    });
    if (!_imageSessionCurrent(sessionToken) || ctrl.signal.aborted) throw _imageAbortError();
    if (!response.ok) {
      const error = new Error('Image HTTP ' + response.status);
      error.status = response.status;
      throw error;
    }
    if (!_imageMimeAllowed(response.headers.get('Content-Type'))) throw new Error('Unsupported image type');
    const blob = await response.blob();
    if (!_imageSessionCurrent(sessionToken) || ctrl.signal.aborted) throw _imageAbortError();
    if (!blob || !blob.size || !_imageMimeAllowed(blob.type)) throw new Error('Unsupported image type');
    return blob;
  } catch (error) {
    if (timedOut) {
      const timeout = new Error('Image load timed out');
      timeout.timeout = true;
      throw timeout;
    }
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
    signals.forEach(s => s.removeEventListener('abort', abort));
    _imageFetchControllers.delete(ctrl);
  }
}

function setImageBlobSrc(img, blob) {
  if (!img || !blob) return;
  revokeImageBlobSrc(img);
  const blobUrl = URL.createObjectURL(blob);
  _imageElements.add(img);
  img.dataset.blobUrl = blobUrl;
  img.referrerPolicy = 'no-referrer';
  img.src = blobUrl;
}

function revokeImageBlobSrc(img) {
  if (!img || !img.dataset.blobUrl) return;
  try { URL.revokeObjectURL(img.dataset.blobUrl); } catch (_) {}
  delete img.dataset.blobUrl;
}

function imageCacheKey(src, authBucketOverride) {
  if (!src) return '';
  try {
    const clean = typeof proxyImg === 'function' ? proxyImg(src) : src;
    const u = new URL(clean, location.href);
    const bucket = authBucketOverride || (typeof _apiAuthBucket === 'function' ? _apiAuthBucket() : '');
    return `image-v4::${bucket}::${u.pathname === '/api/image' ? u.searchParams.get('url') || '' : u.href}`;
  } catch (_) { return ''; }
}

// Markup helper: emit only a clean lazy source and a local placeholder. Call
// observeImages(container) after inserting markup; no global src monkeypatch.
function imageSrcAttrs(src) {
  const clean = proxyImg(src);
  if (!clean || /^(data:|blob:)/i.test(clean)) return `src="${escHtml(clean || BLANK)}" referrerpolicy="no-referrer"`;
  return `src="${BLANK}" data-src="${escHtml(clean)}" referrerpolicy="no-referrer"`;
}

function disposeImage(img) {
  if (!img) return;
  img._imageGeneration = (img._imageGeneration || 0) + 1;
  _avatarObsPendingEnter.delete(img);
  _avatarObsPendingLeave.delete(img);
  _removeFromImageQueue(img);
  avatarObserver.unobserve(img._backgroundTarget || img);
  if (img._abortCtrl) { try { img._abortCtrl.abort(); } catch (_) {} }
  if (img._cancelImageLoad) img._cancelImageLoad();
  revokeImageBlobSrc(img);
  _imageElements.delete(img);
  img.removeAttribute('data-src');
  delete img.dataset.imageSource;
  delete img.dataset.loading;
  delete img.dataset.cancelled;
  img.classList.remove('loading');
  if (img._imageNativeHandlers) {
    img.onload = img._imageNativeHandlers.onload;
    img.onerror = img._imageNativeHandlers.onerror;
    delete img._imageNativeHandlers;
  }
  img.src = BLANK;
}

// Native imgs/details and queued grids share the same 12-slot loader and cache.
// Returning the element (not a rejecting promise) keeps inline callers simple.
function loadImage(img, src, { lazy = false } = {}) {
  if (!img) return img;
  const clean = proxyImg(src);
  if (clean && img.dataset.imageSource === clean && img._imageSession && _imageSessionCurrent(img._imageSession)) {
    if (!lazy && img.getAttribute('data-src') && !img.dataset.loading) {
      img.dataset.loading = '1';
      imageQueue.push({ img, src: clean }); _imageQueueSet.add(img);
      processImageQueue();
    }
    return img;
  }
  disposeImage(img);
  clearImageFailureUi(img);
  img.referrerPolicy = 'no-referrer';
  if (!clean || /^(data:|blob:)/i.test(clean)) {
    img.src = clean || BLANK;
    return img;
  }
  img._imageSession = _imageSessionToken();
  img.dataset.imageSource = clean;
  img.dataset.retry = '0';
  delete img._imageSkipCache;
  img.setAttribute('data-src', clean);
  _imageElements.add(img);
  if (lazy) avatarObserver.observe(img._backgroundTarget || img);
  else {
    img.dataset.loading = '1';
    imageQueue.push({ img, src: clean });
    _imageQueueSet.add(img);
    processImageQueue();
  }
  return img;
}

function loadBackgroundImage(el, src, { lazy = false } = {}) {
  if (!el) return;
  const clean = proxyImg(src);
  let img = _backgroundImages.get(el);
  if (img && clean && img.dataset.imageSource === clean && img._imageSession && _imageSessionCurrent(img._imageSession)) return;
  if (img) disposeImage(img);
  el.style.backgroundImage = '';
  if (!clean) { _backgroundImages.delete(el); delete el.dataset.bgSrc; delete el.dataset.imageBackground; return; }
  if (/^(data:|blob:)/i.test(clean)) { _backgroundImages.delete(el); delete el.dataset.bgSrc; el.style.backgroundImage = `url("${clean.replace(/["\\\n\r]/g, '')}")`; return; }
  img = new Image();
  img._backgroundTarget = el;
  img.onload = () => { if (img.dataset.blobUrl) el.style.backgroundImage = `url("${img.dataset.blobUrl}")`; };
  _backgroundImages.set(el, img);
  el.dataset.imageBackground = '1';
  el.dataset.bgSrc = clean;
  loadImage(img, clean, { lazy });
}

function observeImages(root, { lazy = true } = {}) {
  if (!root || !root.querySelectorAll) return;
  const images = [...root.querySelectorAll('img[data-src]')];
  if (root.matches && root.matches('img[data-src]')) images.unshift(root);
  images.forEach(img => loadImage(img, img.getAttribute('data-src'), { lazy }));
  const backgrounds = [...root.querySelectorAll('[data-bg-src]')];
  if (root.matches && root.matches('[data-bg-src]')) backgrounds.unshift(root);
  backgrounds.forEach(el => loadBackgroundImage(el, el.dataset.bgSrc, { lazy }));
}

function disposeImages(root) {
  if (!root) return;
  for (const img of [..._imageElements]) {
    if (img === root || (root.contains && root.contains(img))) disposeImage(img);
  }
  for (const [el, img] of [..._backgroundImages]) {
    if (el === root || (root.contains && root.contains(el))) {
      disposeImage(img);
      el.style.backgroundImage = '';
      delete el.dataset.bgSrc;
      delete el.dataset.imageBackground;
      _backgroundImages.delete(el);
    }
  }
}

function clearImageResources() {
  _imageFetchControllers.forEach(ctrl => ctrl.abort());
  imageQueue.length = 0;
  _avatarObsPendingEnter.clear();
  _avatarObsPendingLeave.clear();
  for (const img of [..._imageElements]) disposeImage(img);
  for (const [el, img] of _backgroundImages) { disposeImage(img); el.style.backgroundImage = ''; delete el.dataset.bgSrc; delete el.dataset.imageBackground; }
  _backgroundImages.clear();
  for (const viewer of [..._openImageViewers]) viewer.close();
  loadedImageUrls.clear();
}

// Allocate synchronously in the click gesture; async fetch cannot lose the
// popup activation. If blocked, use a local overlay instead of navigating the
// current page or sending credentials in a URL. Only inert raster bytes open.
function _createImageViewer() {
  let popup = null;
  try { popup = window.open('about:blank', '_blank'); if (popup) popup.opener = null; } catch (_) {}
  const doc = popup ? popup.document : document;
  const overlay = popup ? null : doc.createElement('div');
  const host = overlay || doc.body;
  const meta = doc.createElement('meta');
  meta.name = 'referrer'; meta.content = 'no-referrer';
  if (popup) { doc.head.appendChild(meta); doc.title = t('media.myGallery', { count: 1 }); host.textContent = ''; }
  host.style.cssText = 'background:#18181b;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:20px;box-sizing:border-box;';
  if (overlay) host.style.cssText += 'position:fixed;inset:0;z-index:2147483647;';
  else host.style.cssText += 'min-height:100vh;margin:0;';
  const status = doc.createElement('div');
  status.textContent = t('loading');
  const img = doc.createElement('img');
  img.referrerPolicy = 'no-referrer';
  img.style.cssText = 'max-width:100%;max-height:85vh;object-fit:contain;';
  host.appendChild(status); host.appendChild(img);
  const viewer = {
    popup, overlay, img, status, ctrl: new AbortController(), blobUrl: '', closed: false, timer: null,
    close() {
      if (this.closed) return;
      this.closed = true;
      this.ctrl.abort();
      if (this.timer !== null) clearInterval(this.timer);
      if (this.blobUrl) { URL.revokeObjectURL(this.blobUrl); this.blobUrl = ''; }
      img.removeAttribute('src');
      if (overlay) overlay.remove();
      if (popup) { try { popup.close(); } catch (_) {} }
      _openImageViewers.delete(this);
    },
  };
  if (overlay) {
    const close = doc.createElement('button');
    close.type = 'button'; close.textContent = t('btn.close');
    close.onclick = () => viewer.close();
    host.appendChild(close);
    doc.body.appendChild(host);
  } else {
    viewer.onPageHide = () => viewer.close();
    popup.addEventListener('pagehide', viewer.onPageHide, { once: true });
    viewer.timer = setInterval(() => { if (popup.closed) viewer.close(); }, 500);
  }
  _openImageViewers.add(viewer);
  return viewer;
}

async function openImageSafely(source) {
  // The source survives successful thumbnail loading; img.src may be a display
  // blob (or the placeholder) and is never a valid navigation/open contract.
  const src = typeof source === 'string' ? source : source && (source.dataset.imageSource || source.getAttribute('data-src'));
  let url;
  try { url = _imageRequestUrl(src); } catch (_) { return false; }
  const viewer = _createImageViewer();
  const token = _imageSessionToken();
  const current = () => !viewer.closed && _imageSessionCurrent(token);
  try {
    let restrictedBlob;
    try {
      await fetchImageBlob(url.href, { anonymous: true, signal: viewer.ctrl.signal, sessionToken: token });
    } catch (error) {
      if (!current() || ![401, 403, 404].includes(error.status) || !_imageCanAuthenticate(url) || !vrcAuth) throw error;
      restrictedBlob = await fetchImageBlob(url.href, { signal: viewer.ctrl.signal, sessionToken: token });
    }
    if (!current()) { viewer.close(); return false; }
    if (restrictedBlob) {
      viewer.blobUrl = URL.createObjectURL(restrictedBlob);
      viewer.img.src = viewer.blobUrl;
    } else if (viewer.popup) {
      // Anonymous probe established that this image is public. Navigate only to
      // its clean versioned proxy URL under the no-referrer viewer policy.
      viewer.popup.removeEventListener('pagehide', viewer.onPageHide);
      viewer.popup.location.replace(url.href);
      if (viewer.timer !== null) clearInterval(viewer.timer);
      _openImageViewers.delete(viewer);
    } else {
      viewer.img.src = url.href;
    }
    viewer.status.textContent = '';
    return true;
  } catch (error) {
    if (!current() || error.name === 'AbortError') viewer.close();
    else viewer.status.textContent = t('toast.loadFailMsg', { msg: error.status ? 'HTTP ' + error.status : 'Image unavailable' });
    return false;
  }
}

// Clear the failed-thumbnail UI state (✕ overlay, tap-to-retry wiring) for a
// fresh load attempt. Used by the success handler and by card restore, so a
// recovered image never keeps showing "点击重试" over real content.
function clearImageFailureUi(img) {
  if (!img) return;
  img.classList.remove('failed');
  const wrapper = img.parentElement;
  if (!wrapper) return;
  wrapper.classList.remove('img-failed');
  wrapper.style.cursor = '';
  wrapper.title = '';
  delete wrapper.dataset.retryWired;
  if (wrapper._retryHandler) {
    wrapper.removeEventListener('click', wrapper._retryHandler);
    delete wrapper._retryHandler;
  }
}

function processImageQueue() {
  while (runningLoads < MAX_CONCURRENT_IMAGES && imageQueue.length > 0) {
    runningLoads++;
    const { img, src: queuedSrc } = imageQueue.shift();
    const src = proxyImg(queuedSrc);
    _imageQueueSet.delete(img);
    const imageSessionToken = img._imageSession || _imageSessionToken();
    const imageAuthBucket = imageSessionToken.bucket;
    const generation = img._imageGeneration || 0;
    const isImageLoadCurrent = () => _imageSessionCurrent(imageSessionToken)
      && generation === (img._imageGeneration || 0);
    if (!isImageLoadCurrent()) { delete img.dataset.loading; runningLoads--; continue; }
    _imageElements.add(img);
    img._imageSession = imageSessionToken;
    img.dataset.imageSource = src;
    if (src) img.setAttribute('data-src', src);

    // Skip if cancelled while waiting in queue
    if (img.dataset.cancelled) {
      delete img.dataset.loading;
      delete img.dataset.cancelled;
      runningLoads--;
      continue;
    }

    const wrapper = img.parentElement;

    // Defensive: a data: URI (the BLANK placeholder) must never be fetched —
    // CSP blocks data: fetches, so the item would burn its retries in a dead
    // loop. Recovering the real URL is onRetryClick's job; a data: item here
    // means a stale caller leaked the placeholder into the queue.
    if (!src || src.startsWith('data:')) {
      img.classList.remove('loading');
      if (wrapper) wrapper.classList.remove('img-loading');
      img.classList.add('failed');
      if (wrapper) wrapper.classList.add('img-failed');
      delete img.dataset.loading;
      runningLoads--;
      continue;
    }

    const cacheKey = imageCacheKey(src, imageAuthBucket);
    let timedOut = false;
    let loadReleased = false;
    const nativeHandlers = img._imageNativeHandlers || { onload: img.onload, onerror: img.onerror };
    img._imageNativeHandlers = nativeHandlers;

    const releaseLoad = (kick = true) => {
      if (loadReleased) return false;
      loadReleased = true;
      delete img._cancelImageLoad;
      runningLoads = Math.max(0, runningLoads - 1);
      if (kick) processImageQueue();
      return true;
    };

    // Discard stale work without applying the old account's blob to the
    // current DOM/cache. Cleanup is idempotent because abort and promise
    // callbacks may race during logout or account switching.
    const discardLoad = () => {
      if (loadReleased) return;
      revokeImageBlobSrc(img);
      img.onload = nativeHandlers.onload;
      img.onerror = nativeHandlers.onerror;
      delete img._imageNativeHandlers;
      delete img._abortCtrl;
      delete img.dataset.loading;
      delete img.dataset.cancelled;
      img.classList.remove('loading');
      if (wrapper) wrapper.classList.remove('img-loading');
      releaseLoad();
    };
    img._cancelImageLoad = discardLoad;

    // Called on successful load or permanent failure
    const finishLoad = (success) => {
      if (loadReleased) return;
      img.onload = nativeHandlers.onload;
      img.onerror = nativeHandlers.onerror;
      delete img._imageNativeHandlers;
      delete img._abortCtrl;
      img.classList.remove('loading');
      if (wrapper) wrapper.classList.remove('img-loading');
      if (success) {
        img.removeAttribute('data-src');
        delete img.dataset.loading;
        avatarObserver.unobserve(img._backgroundTarget || img);
      }
      releaseLoad();
    };

    // Called when fetch is aborted (scrolled out) — restore state for retry
    const cancelLoad = () => {
      if (loadReleased) return;
      img.onload = nativeHandlers.onload;
      img.onerror = nativeHandlers.onerror;
      delete img._imageNativeHandlers;
      delete img._abortCtrl;
      delete img.dataset.cancelled;
      delete img.dataset.loading; // Allow re-queuing on next intersection
      img.classList.remove('loading');
      if (wrapper) wrapper.classList.remove('img-loading');
      // Don't unobserve — observer will retrigger when image re-enters viewport
      releaseLoad();
    };

    img.onload = (event) => {
      if (loadReleased || !img.dataset.blobUrl || img.src !== img.dataset.blobUrl) return;
      if (!isImageLoadCurrent()) { discardLoad(); return; }
      loadedImageUrls.add(cacheKey);
      delete img._imageSkipCache;
      // A failure can recover later (auto-retry via scroll recycle/restore, or
      // a successful manual retry). Clear the failed overlay and its
      // tap-to-retry wiring here, or a loaded image keeps showing "✕ 点击重试"
      // and the stale listener swallows the card's own click.
      clearImageFailureUi(img);
      finishLoad(true);
      if (nativeHandlers.onload) nativeHandlers.onload.call(img, event);
    };
    img.onerror = (event) => {
      if (loadReleased) return;
      if (!isImageLoadCurrent()) { discardLoad(); return; }
      img._imageSkipCache = true;
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
              // Never fall back to img.src: after a failure it is the BLANK
              // placeholder data: URI, and fetching data: violates CSP — the
              // retry would spin forever instead of reloading the real image.
              const recoverSrc = oldSrc || img.dataset.src || '';
              if (recoverSrc && !recoverSrc.startsWith('data:')) {
                img.setAttribute('data-src', recoverSrc);
                img.dataset.loading = '1';
                imageQueue.push({ img, src: recoverSrc }); _imageQueueSet.add(img);
                processImageQueue();
              }
            };
            wrapper.addEventListener('click', onRetryClick);
            wrapper._retryHandler = onRetryClick;
          }
        }
        // Keep data-src on permanent failure: it is the retry click's only
        // link back to the real URL (img.src is the BLANK placeholder here,
        // and fetching data: is CSP-blocked — the dead retry loop).
        delete img.dataset.loading;
        avatarObserver.unobserve(img._backgroundTarget || img);
        revokeImageBlobSrc(img);
        finishLoad(false);
        if (nativeHandlers.onerror) nativeHandlers.onerror.call(img, event);
      }
    };
    img.classList.add('loading');
    if (wrapper) wrapper.classList.add('img-loading');

    // Check IDB cache first (instant, no network)
    const cachedBlob = img._imageSkipCache ? Promise.resolve(null) : idb.getImage(cacheKey, imageSessionToken).catch(() => null);
    cachedBlob.then(blob => {
      if (loadReleased) return;
      if (!isImageLoadCurrent()) { discardLoad(); return; }
      if (img.dataset.cancelled) { cancelLoad(); return; }

      if (blob && _imageMimeAllowed(blob.type) && blob.size) {
        if (!isImageLoadCurrent()) { discardLoad(); return; }
        setImageBlobSrc(img, blob);
        // onload fires → finishLoad(true)
      } else {
        // Yield to priority tasks (tab switches etc.)
        if (isPriorityTaskRunning) {
          imageQueue.unshift({ img, src }); _imageQueueSet.add(img);
          releaseLoad(false);
          setTimeout(processImageQueue, 500);
          return;
        }

        // Fetch with AbortController so we can cancel mid-flight
        const ctrl = new AbortController();
        img._abortCtrl = ctrl;
        const _imgTimeout = setTimeout(() => {
          // A timeout is a failed visible load, not a viewport cancellation.
          // Mark it before abort() so the AbortError path gets bounded retries
          // and eventually leaves the interactive tap-to-retry state intact.
          timedOut = true;
          try { ctrl.abort(); } catch(_) {}
        }, 15000);

        fetchImageBlob(src, { signal: ctrl.signal, sessionToken: imageSessionToken, timeoutMs: 0 })
          .then(blob => {
            clearTimeout(_imgTimeout);
            if (loadReleased) return;
            delete img._abortCtrl;
            if (!isImageLoadCurrent()) { discardLoad(); return; }
            if (img.dataset.cancelled) { cancelLoad(); return; }
            // Cache namespace and token are captured before any asynchronous work.
            idb.setImage(cacheKey, blob, imageSessionToken).catch(() => {});
            if (!isImageLoadCurrent()) { discardLoad(); return; }
            setImageBlobSrc(img, blob);
            // onload fires → finishLoad(true); never use a native fallback.
          })
          .catch(e => {
            clearTimeout(_imgTimeout);
            if (loadReleased) return;
            delete img._abortCtrl;
            if (!isImageLoadCurrent()) { discardLoad(); return; }
            if (e.name === 'AbortError' && !timedOut) {
              cancelLoad(); // Clean cancel — restore for retry
            } else if (img.onerror) {
              // Timeout/status/MIME failures all use the bounded retry budget.
              img.onerror();
            }
          });

      }
    }).catch(() => { if (loadReleased) return; if (!isImageLoadCurrent()) discardLoad(); else if (img.onerror) img.onerror(); });
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
      if (!img._imageSession) img._imageSession = _imageSessionToken();
      _imageElements.add(img);
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
      const img = _backgroundImages.get(entry.target) || entry.target;
      if (entry.isIntersecting) {
        _avatarObsPendingLeave.delete(img);
        _avatarObsPendingEnter.add(img);
      } else {
        _avatarObsPendingEnter.delete(img);
        _avatarObsPendingLeave.add(img);
      }
    }
    if (!_avatarObsRafPending) {
      _avatarObsRafPending = true;
      requestAnimationFrame(_flushAvatarObsQueue);
    }
  },
  { rootMargin: '600px 0px' }
);

// Release removed DOM resources (including innerHTML replacements); moving or
// reconciling connected cards does not revoke their displayed blobs.
if (typeof MutationObserver === 'function') {
  const removedImages = new MutationObserver(records => {
    if (!records.some(record => record.removedNodes.length)) return;
    for (const img of [..._imageElements]) {
      const target = img._backgroundTarget || img;
      if (target.isConnected === false) disposeImage(img);
    }
    for (const [el, img] of [..._backgroundImages]) {
      if (el.isConnected === false) { disposeImage(img); _backgroundImages.delete(el); }
    }
  });
  removedImages.observe(document.documentElement, { childList: true, subtree: true });
}
window.addEventListener('pagehide', clearImageResources);

// ── Batch Image Prefetch ──
// Sends thumbnail URLs to the Worker's batch endpoint so it can
// download them from VRC's servers at edge speed and cache them.
function prefetchThumbnails(avatarList) {
  const rawUrls = avatarList
    .map(av => av.thumbnailImageUrl || av.imageUrl || "")
    .filter(u => u && (u.includes("api.vrchat.cloud") || u.includes("files.vrchat.cloud")));

  // Skip URLs already in the browser's memory cache
  const cacheKeys = rawUrls.map(u =>
    imageCacheKey(proxyImg(u))
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

VRCW.registerModule('images', { imageCacheKey, imageSrcAttrs, fetchImageBlob, loadImage, observeImages, loadBackgroundImage, disposeImage, disposeImages, clearImageResources, openImageSafely, setImageBlobSrc, revokeImageBlobSrc, processImageQueue, prefetchThumbnails });
renderAppVersionInfo();

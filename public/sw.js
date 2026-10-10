/**
 * VRCW Service Worker — header-authenticated, account-partitioned image cache.
 * Legacy credential URLs are redirected before any cache access. Only allowed
 * image responses are stored under credential-free internal v4 cache keys.
 */

const CACHE_NAME = 'vrcw-img-v4';
const IMAGE_PATH = '/api/image';
const IMAGE_CACHE_PATH = '/__vrcw_image_cache/v4';

function imageAuth(request) {
  const header = request.headers.get('X-VRC-Auth') || '';
  if (!header) return '';
  try { return atob(header); } catch (_) { return header; }
}

async function authCacheBucket(request) {
  const auth = imageAuth(request);
  if (!auth) return 'anon';
  const bytes = new TextEncoder().encode(auth);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return 'u:' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function isAllowedImageResponse(response) {
  const mime = (response.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  return response.status === 200 && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime);
}

function imageResponseHeaders(contentType, auth) {
  const headers = new Headers({
    'Cache-Control': auth ? 'private, no-store' : 'public, max-age=604800, immutable',
    'Vary': 'X-VRC-Auth',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  if (contentType) headers.set('Content-Type', contentType.split(';', 1)[0].trim().toLowerCase());
  return headers;
}

function imageResponse(response, auth) {
  // Do not replay Location, cookies, credential headers, or other upstream metadata.
  return new Response(response.body, {
    status: 200,
    headers: imageResponseHeaders(response.headers.get('Content-Type'), auth)
  });
}

function imageError(message, status, auth) {
  const headers = imageResponseHeaders('text/plain', auth);
  headers.set('Cache-Control', auth ? 'private, no-store' : 'no-store');
  return new Response(message, { status, headers });
}

function legacyImageRedirect(url, auth) {
  const cleanUrl = new URL(IMAGE_PATH, url.origin);
  const targetUrl = url.searchParams.get('url');
  if (targetUrl !== null) cleanUrl.searchParams.set('url', targetUrl);
  cleanUrl.searchParams.set('v', '4');
  const headers = imageResponseHeaders(null, auth);
  headers.set('Cache-Control', auth ? 'private, no-store' : 'no-store');
  headers.set('Location', cleanUrl.href);
  return new Response(null, { status: 302, headers });
}

self.addEventListener('install', () => self.skipWaiting());

async function clearImageCaches() {
  const names = await caches.keys();
  await Promise.all(names
    .filter(cacheName => cacheName.startsWith('vrcw-img-'))
    .map(cacheName => caches.delete(cacheName)));
}

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(cacheName => cacheName.startsWith('vrcw-img-') && cacheName !== CACHE_NAME)
      .map(cacheName => caches.delete(cacheName)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname !== IMAGE_PATH) return;

  const auth = imageAuth(event.request);
  if (url.searchParams.has('auth')) {
    event.respondWith(Promise.resolve(legacyImageRedirect(url, auth)));
    return;
  }
  const imageUrl = url.searchParams.get('url');
  if (!imageUrl) {
    event.respondWith(Promise.resolve(imageError('Missing url', 400, auth)));
    return;
  }

  event.respondWith((async () => {
    // Only the real header determines the partition; ignore caller bucket/v.
    const bucket = await authCacheBucket(event.request);
    const stableKey = new Request(url.origin + IMAGE_CACHE_PATH + '?bucket=' + encodeURIComponent(bucket) + '&url=' + encodeURIComponent(imageUrl));
    let cache;
    try {
      cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(stableKey);
      if (cached && isAllowedImageResponse(cached)) return imageResponse(cached, auth);
    } catch (_) { /* Offline storage failure must not block successful images. */ }

    try {
      const response = await fetch(event.request);
      if (!isAllowedImageResponse(response)) {
        const status = response.status === 200 ? 415
          : response.status >= 400 && response.status <= 599 ? response.status : 502;
        return imageError('Image fetch failed', status, auth);
      }
      const outgoing = imageResponse(response, auth);
      if (cache) {
        const copy = outgoing.clone();
        const headers = new Headers(copy.headers);
        // The synthetic hash key already partitions accounts. Vary on the
        // missing credential header would otherwise make every hit miss.
        headers.delete('Vary');
        const cacheCopy = new Response(copy.body, { status: 200, headers });
        event.waitUntil(Promise.resolve().then(() => cache.put(stableKey, cacheCopy)).catch(() => {
          // A failed write must not leave an unread tee branch buffering data.
          if (cacheCopy.body) return cacheCopy.body.cancel().catch(() => {});
        }));
      }
      return outgoing;
    } catch (_) {
      return imageError('Image network unavailable', 502, auth);
    }
  })());
});

// Expose a way for the app to evict old image caches
self.addEventListener('message', event => {
  if (event.data === 'clearImageCache') {
    event.waitUntil(clearImageCaches().then(() => {
      event.source?.postMessage({ type: 'imageCacheCleared' });
    }));
  }
});


/**
 * VRCW Service Worker — Image Cache
 * Intercepts /api/image?url=...&auth=... requests.
 * Uses a stable cache key (URL without auth param) so the browser can
 * cache avatar/world thumbnails indefinitely.
 * After first view, images NEVER hit Cloudflare again.
 */

const CACHE_NAME = 'vrcw-img-v3';
const IMAGE_PATH = '/api/image';

async function authCacheBucket(request, url) {
  const auth = request.headers.get('X-VRC-Auth') || url.searchParams.get('auth') || '';
  if (!auth) return 'anon';
  const bytes = new TextEncoder().encode(auth);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return 'u:' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
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

  // Derive the partition from the credential rather than trusting a caller
  // supplied bucket. The auth query remains for native <img> compatibility;
  // it is only hashed for the cache key.
  const imageUrl = url.searchParams.get('url');
  if (!imageUrl) return;

  event.respondWith(
    authCacheBucket(event.request, url).then(bucket => {
      const stableKey = new Request(url.origin + IMAGE_PATH + '?bucket=' + encodeURIComponent(bucket) + '&url=' + encodeURIComponent(imageUrl));
      return caches.open(CACHE_NAME).then(async cache => {
        // 1. Serve from cache if available
        const cached = await cache.match(stableKey);
        if (cached) return cached;

        // 2. Fetch from network (hits Cloudflare Worker once)
        try {
          const response = await fetch(event.request);
          if (response.ok && response.status === 200) {
            // Clone before consuming, then wait so a terminating worker cannot
            // silently drop the write under memory pressure.
            await cache.put(stableKey, response.clone());
          }
          return response;
        } catch (e) {
          // Network failure — return a transparent 1x1 pixel fallback
          return new Response(
            atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
            { status: 200, headers: { 'Content-Type': 'image/gif' } }
          );
        }
      });
    })
  );
});

// Expose a way for the app to evict old image caches
self.addEventListener('message', event => {
  if (event.data === 'clearImageCache') {
    event.waitUntil(clearImageCaches().then(() => {
      event.source?.postMessage({ type: 'imageCacheCleared' });
    }));
  }
});


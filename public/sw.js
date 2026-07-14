/**
 * VRCW Service Worker — Image Cache
 * Intercepts /api/image?url=...&auth=... requests.
 * Uses a stable cache key (URL without auth param) so the browser can
 * cache avatar/world thumbnails indefinitely.
 * After first view, images NEVER hit Cloudflare again.
 */

const CACHE_NAME = 'vrcw-img-v2';
const IMAGE_PATH = '/api/image';

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
  if (!url.pathname.endsWith(IMAGE_PATH) && url.pathname !== IMAGE_PATH) return;

  // Build a stable cache key — same image URL regardless of auth token
  const imageUrl = url.searchParams.get('url');
  if (!imageUrl) return;
  const bucket = url.searchParams.get('bucket') || 'anon';
  const stableKey = new Request(url.origin + IMAGE_PATH + '?bucket=' + encodeURIComponent(bucket) + '&url=' + encodeURIComponent(imageUrl));

  event.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
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

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = {}; }
  const title = data.title || 'E了吗';
  const options = {
    body: data.body || '你有新的 E了吗 通知',
    icon: '/icon.png',
    badge: '/icon.png',
    data: { url: data.url || '/dating/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const requestedUrl = event.notification.data && event.notification.data.url ? event.notification.data.url : '/dating/';
  let url;
  try {
    const parsed = new URL(requestedUrl, self.location.origin);
    url = parsed.origin === self.location.origin
      ? parsed.href
      : new URL('/dating/', self.location.origin).href;
  } catch (_) {
    url = new URL('/dating/', self.location.origin).href;
  }
  event.waitUntil(clients.openWindow(url));
});

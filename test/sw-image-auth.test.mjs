import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://offline.invalid';
const target = 'https://files.vrchat.cloud/file/synthetic/image';
const cookieA = 'auth=synthetic-account-a';
const cookieB = 'auth=synthetic-account-b';

function runtime(network, { failOpen = false, failMatch = false, failPut = false, syncPutFailure = false, failBroadcast = false } = {}) {
  const listeners = new Map();
  const stores = new Map();
  const opens = [];
  const lookups = [];
  const writes = [];
  const calls = [];
  const deleted = [];
  const notifications = [];
  const broadcasts = [];
  const windows = [];
  let claimed = 0;
  const caches = {
    async open(name) {
      opens.push(name);
      if (failOpen) throw new Error('synthetic cache open failure');
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async match(request) {
          lookups.push({ name, url: request.url });
          if (failMatch) throw new Error('synthetic cache read failure');
          const entry = entries.get(request.url);
          if (!entry) return undefined;
          // Model real Cache API Vary matching, not just URL lookup.
          const vary = entry.response.headers.get('Vary') || '';
          for (const header of vary.split(',').map(value => value.trim()).filter(Boolean)) {
            if (header === '*' || request.headers.get(header) !== entry.request.headers.get(header)) return undefined;
          }
          return entry.response.clone();
        },
        put(request, response) {
          writes.push({ name, url: request.url, headers: new Headers(response.headers), requestHeaders: new Headers(request.headers) });
          if (syncPutFailure) throw new Error('synchronous synthetic quota failure');
          return (async () => {
            if (failPut) throw new Error('synthetic quota failure');
            const bytes = await response.arrayBuffer();
            entries.set(request.url, { request: request.clone(), response: new Response(bytes, { status: response.status, headers: response.headers }) });
          })();
        },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { deleted.push(name); return stores.delete(name); },
  };
  const self = {
    location: { origin },
    addEventListener(name, handler) { listeners.set(name, handler); },
    skipWaiting() {},
    clients: {
      async claim() { claimed++; },
      async matchAll() {
        if (failBroadcast) throw new Error('synthetic client broadcast failure');
        return [{ postMessage(message) { broadcasts.push(message); } }];
      },
    },
    registration: { async showNotification(title, options) { notifications.push({ title, options }); } },
  };
  const clients = { async openWindow(url) { windows.push(url); } };
  const fakeFetch = async request => { calls.push(request); return network(request); };
  new Function('self', 'clients', 'fetch', 'caches', 'crypto', source)(self, clients, fakeFetch, caches, globalThis.crypto);
  return {
    listeners, stores, opens, lookups, writes, calls, deleted, notifications, broadcasts, windows,
    get claimed() { return claimed; },
    dispatch(name, extra = {}) {
      const pending = [];
      let response;
      const event = { ...extra, waitUntil(promise) { pending.push(promise); }, respondWith(value) { response = Promise.resolve(value); } };
      listeners.get(name)?.(event);
      return { response, async drain() { await Promise.all(pending); } };
    },
    request(url, options = {}) { return this.dispatch('fetch', { request: new Request(url, options) }); },
  };
}

function imageUrl(extras = {}) {
  const url = new URL('/api/image', origin);
  url.searchParams.set('url', target);
  for (const [key, value] of Object.entries(extras)) url.searchParams.set(key, value);
  return url.href;
}
function authHeaders(cookie) { return cookie ? { 'X-VRC-Auth': btoa(cookie) } : {}; }
function image(body = 'synthetic-image', headers = {}) {
  return new Response(body, { headers: { 'Content-Type': 'image/png', ...headers } });
}
function assertPolicy(response, auth) {
  assert.equal(response.headers.get('Cache-Control'), auth ? 'private, no-store' : 'public, max-age=604800, immutable');
  assert.equal(response.headers.get('Vary'), 'X-VRC-Auth');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  for (const name of ['Location', 'Set-Cookie', 'X-VRC-Auth', 'X-Upstream-Secret']) assert.equal(response.headers.get(name), null);
}

test('SW only intercepts same-origin image GET requests', () => {
  const rt = runtime(() => { throw new Error('must not fetch'); });
  for (const [url, options] of [[`${origin}/api/other`, {}], ['https://elsewhere.invalid/api/image?url=x', {}], [imageUrl(), { method: 'POST' }]]) {
    assert.equal(rt.request(url, options).response, undefined);
  }
  assert.equal(rt.calls.length, 0);
});

test('SW A/B/anonymous cache isolation uses only decoded header auth and ignores spoof buckets', async () => {
  const rt = runtime(request => {
    const header = request.headers.get('X-VRC-Auth');
    const auth = header ? (header.includes('=synthetic-') ? header : atob(header)) : '';
    return image(auth === cookieA ? 'account-a-image' : auth === cookieB ? 'account-b-image' : 'public-anon-image', {
      Location: `https://offline.invalid/?auth=${btoa(cookieA)}`,
      'Set-Cookie': cookieA,
      'X-VRC-Auth': btoa(cookieA),
      'X-Upstream-Secret': cookieA,
      Vary: 'X-VRC-Auth',
    });
  });
  for (const [cookie, expected] of [[cookieA, 'account-a-image'], [cookieB, 'account-b-image'], ['', 'public-anon-image'], [cookieA, 'account-a-image'], [cookieB, 'account-b-image'], ['', 'public-anon-image']]) {
    const event = rt.request(imageUrl({ bucket: 'anon', v: '3' }), { headers: authHeaders(cookie) });
    const response = await event.response;
    assertPolicy(response, !!cookie);
    assert.equal(await response.text(), expected);
    await event.drain();
  }
  const raw = rt.request(imageUrl(), { headers: { 'X-VRC-Auth': cookieA } });
  assert.equal(await (await raw.response).text(), 'account-a-image');
  assert.equal(rt.calls.length, 3, 'A, B, and anonymous each need only one network fetch');
  assert.equal(rt.stores.get('vrcw-img-v4').size, 3);
  assert.ok(rt.opens.every(name => name === 'vrcw-img-v4'));
  for (const write of rt.writes) {
    assert.equal(new URL(write.url).pathname, '/__vrcw_image_cache/v4');
    assert.equal(write.headers.get('Vary'), null);
    assert.equal(write.headers.get('Location'), null);
    assert.equal(write.requestHeaders.get('X-VRC-Auth'), null);
    assert.ok(!write.url.includes(btoa(cookieA)) && !write.url.includes(encodeURIComponent(cookieA)));
    const bucket = new URL(write.url).searchParams.get('bucket');
    assert.equal(write.headers.get('Cache-Control'), bucket === 'anon' ? 'public, max-age=604800, immutable' : 'private, no-store');
  }
});

test('SW restricted cache cannot be read anonymously or by B using A bucket', async () => {
  const rt = runtime(request => request.headers.get('X-VRC-Auth') === btoa(cookieA)
    ? image('restricted-account-a')
    : new Response(cookieA, { status: 403, headers: { Location: cookieA } }));
  const first = rt.request(imageUrl(), { headers: authHeaders(cookieA) });
  assert.equal(await (await first.response).text(), 'restricted-account-a');
  await first.drain();
  const bucketA = new URL(rt.writes[0].url).searchParams.get('bucket');
  for (const cookie of ['', cookieB]) {
    const event = rt.request(imageUrl({ bucket: bucketA }), { headers: authHeaders(cookie) });
    const response = await event.response;
    assert.equal(response.status, 403);
    assert.match(response.headers.get('Cache-Control'), /no-store/);
    assert.equal(response.headers.get('Location'), null);
    assert.ok(!(await response.text()).includes(cookieA));
    await event.drain();
  }
  assert.equal(rt.calls.length, 3);
  assert.equal(rt.stores.get('vrcw-img-v4').size, 1);
});

test('SW legacy credential URLs redirect cleanly before touching any old/new cache or network', async () => {
  const rt = runtime(() => { throw new Error('credential URL must never fetch'); });
  const oldUrl = imageUrl({ auth: btoa(cookieA), bucket: 'spoof', v: 'secret' });
  rt.stores.set('vrcw-img-v3', new Map([[oldUrl, { request: new Request(oldUrl), response: image('old-credential-image') }]]));
  for (const cookie of ['', cookieB]) {
    const event = rt.request(oldUrl, { headers: authHeaders(cookie) });
    const response = await event.response;
    assert.ok([302, 303].includes(response.status));
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
    assert.match(response.headers.get('Cache-Control'), /no-store/);
    const clean = new URL(response.headers.get('Location'));
    assert.equal(clean.origin, origin);
    assert.deepEqual([...clean.searchParams.keys()], ['url', 'v']);
    assert.equal(clean.searchParams.get('url'), target);
    assert.equal(clean.searchParams.get('v'), '4');
    assert.ok(!clean.href.includes(btoa(cookieA)));
    assert.equal(await response.text(), '');
    await event.drain();
  }
  assert.equal(rt.opens.length, 0);
  assert.equal(rt.lookups.length, 0);
  assert.equal(rt.calls.length, 0);
  const clean = rt.request(imageUrl());
  // The legacy-cache mock remains unreachable; use a denied synthetic network.
  const response = await clean.response;
  assert.equal(response.status, 502);
});

test('SW cache quota/read/open failures never convert a valid image into failure', async () => {
  for (const failures of [{ failPut: true }, { syncPutFailure: true }, { failOpen: true }, { failMatch: true }]) {
    const rt = runtime(() => image('network-success'), failures);
    const event = rt.request(imageUrl(), { headers: authHeaders(cookieA) });
    const response = await event.response;
    assert.equal(response.status, 200);
    assertPolicy(response, true);
    assert.equal(await response.text(), 'network-success');
    await event.drain();
  }
});

test('SW only stores successful allowed image MIME and strips unsafe status/body metadata', async () => {
  for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'IMAGE/PNG; charset=binary']) {
    const rt = runtime(() => image('allowed', { 'Content-Type': mime }));
    const event = rt.request(imageUrl());
    assert.equal((await event.response).status, 200);
    await event.drain();
    assert.equal(rt.writes.length, 1);
  }
  for (const fixture of [
    { status: 200, mime: 'text/html', expected: 415 },
    { status: 200, mime: 'image/svg+xml', expected: 415 },
    { status: 200, mime: '', expected: 415 },
    { status: 206, mime: 'image/png', expected: 502 },
    { status: 302, mime: 'image/png', expected: 502 },
    { status: 404, mime: 'image/png', expected: 404 },
  ]) {
    const rt = runtime(() => new Response(cookieA, { status: fixture.status, headers: { 'Content-Type': fixture.mime, Location: cookieA } }));
    const event = rt.request(imageUrl(), { headers: authHeaders(cookieA) });
    const response = await event.response;
    assert.equal(response.status, fixture.expected);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get('Location'), null);
    assert.ok(!(await response.text()).includes(cookieA));
    await event.drain();
    assert.equal(rt.writes.length, 0);
  }
});

test('SW network failure is a no-store 502, never a transparent success image', async () => {
  const rt = runtime(() => { throw new Error(cookieA); });
  const event = rt.request(imageUrl());
  const response = await event.response;
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Content-Type'), 'text/plain');
  assert.ok(!(await response.text()).includes(cookieA));
  await event.drain();
  assert.equal(rt.writes.length, 0);
});

test('SW sanitizes cached hit headers and rejects unsafe cached entries', async () => {
  const rt = runtime(() => image('fresh-safe-image'));
  const first = rt.request(imageUrl(), { headers: authHeaders(cookieA) });
  await (await first.response).text();
  await first.drain();
  const store = rt.stores.get('vrcw-img-v4');
  const [key, entry] = [...store][0];
  entry.response = image('cached-safe-image', { Location: cookieA, 'X-VRC-Auth': btoa(cookieA), 'Cache-Control': 'public, max-age=999' });
  const hit = rt.request(imageUrl(), { headers: authHeaders(cookieA) });
  const response = await hit.response;
  assertPolicy(response, true);
  assert.equal(await response.text(), 'cached-safe-image');
  assert.equal(rt.calls.length, 1);
  entry.response = image('unsafe-svg', { 'Content-Type': 'image/svg+xml' });
  store.set(key, entry);
  const miss = rt.request(imageUrl(), { headers: authHeaders(cookieA) });
  assert.equal(await (await miss.response).text(), 'fresh-safe-image');
  await miss.drain();
  assert.equal(rt.calls.length, 2);
});

test('SW returns the image stream without waiting for complete cache body consumption', async () => {
  let controller;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const rt = runtime(() => image(stream));
  const event = rt.request(imageUrl(), { headers: authHeaders(cookieA) });
  const response = await event.response;
  assert.equal(response.status, 200, 'response arrives while network stream remains open');
  controller.enqueue(new TextEncoder().encode('streaming-image'));
  controller.close();
  assert.equal(await response.text(), 'streaming-image');
  await event.drain();
  const entry = rt.stores.get('vrcw-img-v4').values().next().value;
  assert.equal(await entry.response.clone().text(), 'streaming-image');
});

test('SW activation cleans old image versions and message clears current account partitions', async () => {
  const rt = runtime(() => image());
  for (const name of ['vrcw-img-v2', 'vrcw-img-v3', 'vrcw-img-v4', 'unrelated-assets']) rt.stores.set(name, new Map());
  await rt.dispatch('activate').drain();
  assert.deepEqual(rt.deleted.sort(), ['vrcw-img-v2', 'vrcw-img-v3']);
  assert.equal(rt.claimed, 1);
  const replies = [];
  await rt.dispatch('message', { data: 'clearImageCache', source: { postMessage(value) { replies.push(value); } } }).drain();
  assert.equal(rt.stores.has('vrcw-img-v4'), false);
  assert.equal(rt.stores.has('unrelated-assets'), true);
  assert.deepEqual(replies, [{ type: 'imageCacheCleared' }]);
});

test('dating push behavior is retained only in main and notification survives broadcast failure', async () => {
  const rt = runtime(() => image());
  if (!rt.listeners.has('push')) {
    assert.equal(rt.listeners.has('notificationclick'), false, 'pure SW has no Dating behavior');
    assert.doesNotMatch(source, /datingPushReceived|\/dating\//);
    return;
  }
  const push = rt.dispatch('push', { data: { json() { return { title: 'synthetic notification', body: 'body' }; } } });
  await push.drain();
  assert.equal(rt.notifications.length, 1);
  assert.deepEqual(rt.broadcasts, [{ type: 'datingPushReceived' }]);
  const failed = runtime(() => image(), { failBroadcast: true });
  await failed.dispatch('push', { data: { json() { return {}; } } }).drain();
  assert.equal(failed.notifications.length, 1);
  let closed = false;
  await rt.dispatch('notificationclick', { notification: { data: { url: 'https://unapproved.invalid/' }, close() { closed = true; } } }).drain();
  assert.equal(closed, true);
  assert.deepEqual(rt.windows, [`${origin}/dating/`]);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const origin = 'https://offline.invalid';
const target = 'https://files.vrchat.cloud/file/synthetic/image';
const cookieA = 'auth=synthetic-account-a';
const cookieB = 'auth=synthetic-account-b';

function runtime(upstream, { failMatch = false, failPut = false } = {}) {
  const entries = new Map();
  const lookups = [];
  const writes = [];
  const calls = [];
  const pending = [];
  const deadlines = [];
  const cache = {
    async match(request) {
      lookups.push(request.url);
      if (failMatch) throw new Error('synthetic cache read failure');
      return entries.get(request.url)?.clone();
    },
    async put(request, response) {
      writes.push({ url: request.url, headers: new Headers(response.headers), requestHeaders: new Headers(request.headers) });
      if (failPut) throw new Error('synthetic cache write failure');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Vary'), null, 'hash-keyed internal cache must not vary on a missing auth header');
      assert.match(response.headers.get('Cache-Control'), /^public,/);
      const bytes = await response.arrayBuffer();
      entries.set(request.url, new Response(bytes, { status: response.status, headers: response.headers }));
    },
  };
  const fakeFetch = async (url, options) => {
    const call = { url: String(url), ...options, headers: new Headers(options.headers) };
    calls.push(call);
    return upstream(call);
  };
  const fakeSignal = { timeout(ms) { deadlines.push(ms); return AbortSignal.timeout(ms); } };
  const worker = new Function('fetch', 'caches', 'crypto', 'AbortSignal', `${source.replace('export default {', 'const handler = {')}
    return { handler, authBucket, imageCacheKey };
  `)(fakeFetch, { default: cache }, globalThis.crypto, fakeSignal);
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  return {
    ...worker, entries, lookups, writes, calls, pending, deadlines,
    async request(url, options = {}) { return worker.handler.fetch(new Request(url, options), {}, ctx); },
    async drain() { await Promise.all(pending); },
  };
}

function imageUrl(rawTarget = target, extras = {}) {
  const url = new URL('/api/image', origin);
  url.searchParams.set('url', rawTarget);
  for (const [key, value] of Object.entries(extras)) url.searchParams.set(key, value);
  return url.href;
}

function authHeaders(cookie) { return cookie ? { 'X-VRC-Auth': btoa(cookie) } : {}; }
function image(body = 'synthetic-image', headers = {}) {
  return new Response(body, { headers: { 'Content-Type': 'image/png', ...headers } });
}

function assertPolicy(response, authenticated) {
  assert.equal(response.headers.get('Cache-Control'), authenticated ? 'private, no-store' : 'public, max-age=604800, immutable');
  assert.equal(response.headers.get('Vary'), 'X-VRC-Auth');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  for (const header of ['Location', 'Set-Cookie', 'X-VRC-Auth', 'X-Upstream-Secret']) assert.equal(response.headers.get(header), null);
}

test('public anonymous images cache in v4 and never replay upstream credential headers', async () => {
  const rt = runtime(() => image('public-image', {
    Location: `https://offline.invalid/?auth=${btoa(cookieA)}`,
    'Set-Cookie': cookieA,
    'X-VRC-Auth': btoa(cookieA),
    'X-Upstream-Secret': cookieA,
  }));
  const first = await rt.request(imageUrl());
  assert.equal(first.status, 200);
  assertPolicy(first, false);
  assert.equal(await first.text(), 'public-image');
  await rt.drain();
  const second = await rt.request(imageUrl(target, { bucket: 'auth:spoof', v: '3' }));
  assertPolicy(second, false);
  assert.equal(await second.text(), 'public-image');
  assert.equal(rt.calls.length, 1);
  assert.equal(rt.calls[0].headers.get('Cookie'), null);
  assert.equal(new URL(rt.writes[0].url).pathname, '/__vrcw_image_cache/v4');
  assert.equal(new URL(rt.writes[0].url).searchParams.get('bucket'), 'anon:v2');
  assert.deepEqual(rt.deadlines, [20000]);
  for (const entry of rt.entries.values()) {
    assert.equal(entry.headers.get('Location'), null);
    assert.equal(entry.headers.get('X-VRC-Auth'), null);
    assert.ok(!(await entry.clone().text()).includes(cookieA));
  }
});

test('restricted images remain private on miss/hit and isolate A, B, and anonymous despite spoofed buckets', async () => {
  const rt = runtime(call => {
    const cookie = call.headers.get('Cookie');
    if (!cookie) return new Response(`not an image: ${cookieA}`, { status: 403, headers: { Location: cookieA } });
    return image(cookie === cookieA ? 'account-a-image' : 'account-b-image');
  });
  for (const [cookie, expected] of [[cookieA, 'account-a-image'], [cookieB, 'account-b-image'], [cookieA, 'account-a-image']]) {
    const response = await rt.request(imageUrl(target, { bucket: 'anon:v2' }), { headers: authHeaders(cookie) });
    assertPolicy(response, true);
    assert.equal(await response.text(), expected);
    await rt.drain();
  }
  const bucketA = await rt.authBucket(cookieA);
  const anon = await rt.request(imageUrl(target, { bucket: bucketA }));
  assert.equal(anon.status, 403);
  assert.equal(anon.headers.get('Cache-Control'), 'no-store');
  assert.equal(anon.headers.get('Location'), null);
  assert.equal(await anon.text(), 'Image fetch failed');
  const rawEquivalent = await rt.request(imageUrl(), { headers: { 'X-VRC-Auth': cookieA } });
  assertPolicy(rawEquivalent, true);
  assert.equal(await rawEquivalent.text(), 'account-a-image');
  assert.equal(rt.calls.length, 3, 'two authorized misses plus one denied anonymous fetch');
  assert.equal(rt.entries.size, 2);
  for (const write of rt.writes) {
    assert.equal(write.requestHeaders.get('X-VRC-Auth'), null);
    assert.ok(!write.url.includes(btoa(cookieA)) && !write.url.includes(encodeURIComponent(cookieA)));
  }
});

test('legacy query auth always produces a clean same-origin redirect before any cache or network access', async () => {
  const rt = runtime(() => { throw new Error('legacy URL must not fetch'); });
  for (const headerCookie of ['', cookieB]) {
    const response = await rt.request(imageUrl(target, { auth: btoa(cookieA), bucket: 'spoof', v: 'secret-version', unrelated: cookieA }), { headers: authHeaders(headerCookie) });
    assert.ok([302, 303].includes(response.status));
    assert.match(response.headers.get('Cache-Control'), /no-store/);
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
    const clean = new URL(response.headers.get('Location'));
    assert.equal(clean.origin, origin);
    assert.equal(clean.pathname, '/api/image');
    assert.deepEqual([...clean.searchParams.keys()], ['url', 'v']);
    assert.equal(clean.searchParams.get('url'), target);
    assert.equal(clean.searchParams.get('v'), '4');
    assert.equal(await response.text(), '');
    assert.ok(!response.headers.get('Location').includes(btoa(cookieA)));
  }
  assert.equal(rt.lookups.length, 0);
  assert.equal(rt.calls.length, 0);
  assert.equal(rt.writes.length, 0);
});

test('old public cache entries and externally requested internal cache URLs cannot expose an authed image', async () => {
  const rt = runtime(() => new Response('denied', { status: 403 }));
  const bucket = await rt.authBucket(cookieA);
  const oldKey = new URL(`/api/image?bucket=${encodeURIComponent(bucket)}&url=${encodeURIComponent(target)}`, origin).href;
  rt.entries.set(oldKey, image('old-secret-image', { Location: cookieA }));
  const internal = rt.imageCacheKey(new Request(origin), target, bucket);
  rt.entries.set(internal.url, image('private-image'));
  const anon = await rt.request(imageUrl(target, { bucket }));
  assert.equal(anon.status, 403);
  assert.equal(await anon.text(), 'Image fetch failed');
  const direct = await rt.request(internal.url);
  assert.equal(direct.status, 404);
  assert.ok(!(await direct.text()).includes('private-image'));
  const nested = await rt.request(imageUrl(imageUrl(target, { auth: btoa(cookieA) })));
  assert.equal(nested.status, 403, 'nested same-origin proxy is not an approved upstream image target');
  assert.equal(rt.calls.length, 1);
});

test('redirects guard targets and remove Cookie before community/CDN hops', async () => {
  const community = 'https://api.avtrdb.com/image/synthetic';
  const rt = runtime(call => call.url === target
    ? new Response(null, { status: 302, headers: { Location: community } })
    : image('community-image'));
  const response = await rt.request(imageUrl(), { headers: authHeaders(cookieA) });
  assert.equal(await response.text(), 'community-image');
  await rt.drain();
  assert.deepEqual(rt.calls.map(call => call.headers.get('Cookie')), [cookieA, null]);
  assert.ok(rt.calls.every(call => call.redirect === 'manual' && call.signal === rt.calls[0].signal));
  assert.deepEqual(rt.deadlines, [20000]);

  const unsafe = runtime(() => new Response(null, { status: 302, headers: { Location: 'https://unapproved.invalid/image' } }));
  const blocked = await unsafe.request(imageUrl(), { headers: authHeaders(cookieA) });
  assert.equal(blocked.status, 502);
  assert.equal(unsafe.calls.length, 1);
  assert.equal(unsafe.writes.length, 0);
  const badTarget = await unsafe.request(imageUrl('https://api.vrchat.cloud.unapproved.invalid/file'));
  assert.equal(badTarget.status, 403);
  assert.equal(unsafe.calls.length, 1);
});

test('unsafe MIME/status/error bodies never become successful or cached images', async () => {
  for (const fixture of [
    { status: 200, mime: 'text/html', expected: 415 },
    { status: 200, mime: 'image/svg+xml', expected: 415 },
    { status: 200, mime: '', expected: 415 },
    { status: 204, mime: 'image/png', expected: 502 },
    { status: 206, mime: 'image/png', expected: 502 },
    { status: 401, mime: 'image/png', expected: 401 },
  ]) {
    const rt = runtime(() => new Response(fixture.status === 204 ? null : cookieA, { status: fixture.status, headers: { 'Content-Type': fixture.mime, Location: cookieA } }));
    const response = await rt.request(imageUrl(), { headers: authHeaders(cookieA) });
    assert.equal(response.status, fixture.expected);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get('Location'), null);
    assert.ok(!(await response.text()).includes(cookieA));
    await rt.drain();
    assert.equal(rt.entries.size, 0);
  }
});

test('prefetch shares v4 header-auth namespace, deadline, MIME policy, and never warms anonymous entries with authed bytes', async () => {
  const rt = runtime(call => call.headers.get('Cookie') ? image('prefetched-a-image') : new Response('denied', { status: 403 }));
  const prefetchUrl = `${origin}/api/images/prefetch?auth=${btoa(cookieB)}&bucket=anon`;
  const options = { method: 'POST', headers: { ...authHeaders(cookieA), 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: [target] }) };
  const prefetched = await rt.request(prefetchUrl, options);
  assert.deepEqual(await prefetched.json(), { ok: true, cached: 0, fetched: 1, total: 1 });
  const hit = await rt.request(imageUrl(), { headers: authHeaders(cookieA) });
  assertPolicy(hit, true);
  assert.equal(await hit.text(), 'prefetched-a-image');
  assert.equal(rt.calls.length, 1);
  const anon = await rt.request(imageUrl());
  assert.equal(anon.status, 403);
  assert.equal(rt.entries.size, 1);
  assert.deepEqual(rt.deadlines, [20000, 20000]);
  const second = await rt.request(prefetchUrl, options);
  assert.deepEqual(await second.json(), { ok: true, cached: 1, fetched: 0, total: 1 });

  for (const [status, mime] of [[200, 'image/svg+xml'], [206, 'image/png'], [403, 'image/png']]) {
    const unsafe = runtime(() => new Response('unsafe', { status, headers: { 'Content-Type': mime } }));
    const result = await unsafe.request(prefetchUrl, options);
    assert.equal((await result.json()).fetched, 0);
    assert.equal(unsafe.entries.size, 0);
  }
});

test('cache read/write failures do not turn a successful streaming image into an error', async () => {
  for (const failures of [{ failPut: true }, { failMatch: true }]) {
    const rt = runtime(() => image('still-a-success'), failures);
    const response = await rt.request(imageUrl(), { headers: authHeaders(cookieA) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'still-a-success');
    await rt.drain();
  }
  let streamController;
  const stream = new ReadableStream({ start(controller) { streamController = controller; } });
  const rt = runtime(() => image(stream));
  const response = await rt.request(imageUrl(), { headers: authHeaders(cookieA) });
  assert.equal(response.status, 200, 'handler returns while upstream image stream is still open');
  assert.equal(response.bodyUsed, false);
  streamController.enqueue(new TextEncoder().encode('streamed-image'));
  streamController.close();
  assert.equal(await response.text(), 'streamed-image');
  await rt.drain();
  assert.equal(await rt.entries.values().next().value.clone().text(), 'streamed-image');
});

test('cached image hits scrub credential headers and invalid cache entries are refetched', async () => {
  const rt = runtime(() => image('safe-network-image'));
  const bucket = await rt.authBucket(cookieA);
  const key = rt.imageCacheKey(new Request(origin), target, bucket);
  rt.entries.set(key.url, image('safe-cached-image', {
    Location: `https://offline.invalid/?auth=${btoa(cookieA)}`,
    'Set-Cookie': cookieA,
    'X-VRC-Auth': btoa(cookieA),
    'X-Upstream-Secret': cookieA,
    'Cache-Control': 'public, max-age=999',
  }));
  const hit = await rt.request(imageUrl(), { headers: authHeaders(cookieA) });
  assertPolicy(hit, true);
  assert.equal(await hit.text(), 'safe-cached-image');
  assert.equal(rt.calls.length, 0);
  rt.entries.set(key.url, image('unsafe-svg', { 'Content-Type': 'image/svg+xml' }));
  const refetched = await rt.request(imageUrl(), { headers: authHeaders(cookieA) });
  assertPolicy(refetched, true);
  assert.equal(await refetched.text(), 'safe-network-image');
  await rt.drain();
  assert.equal(rt.calls.length, 1);
});

test('following a legacy query-auth redirect cannot authorize an image or poison anonymous prefetch', async () => {
  const rt = runtime(call => call.headers.get('Cookie') === cookieB
    ? image('account-b-image')
    : new Response('restricted', { status: 403 }));
  const legacy = await rt.request(imageUrl(target, { auth: btoa(cookieA) }));
  const anonymous = await rt.request(legacy.headers.get('Location'));
  assert.equal(anonymous.status, 403);
  assert.equal(rt.calls[0].headers.get('Cookie'), null);
  const authed = await rt.request(legacy.headers.get('Location'), { headers: authHeaders(cookieB) });
  assert.equal(await authed.text(), 'account-b-image');
  await rt.drain();
  assert.equal(rt.calls[1].headers.get('Cookie'), cookieB);
  const prefetch = await rt.request(`${origin}/api/images/prefetch?auth=${btoa(cookieB)}&bucket=${encodeURIComponent(await rt.authBucket(cookieB))}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: [target] }),
  });
  assert.equal((await prefetch.json()).fetched, 0);
  assert.equal(rt.calls.at(-1).headers.get('Cookie'), null);
  assert.equal(rt.entries.size, 1, 'only the real header-auth B entry can exist');
});

test('image network exceptions produce non-success no-store responses', async () => {
  for (const [name, status] of [['Error', 502], ['TimeoutError', 504]]) {
    const rt = runtime(() => { const error = new Error(cookieA); error.name = name; throw error; });
    const response = await rt.request(imageUrl(), { headers: authHeaders(cookieA) });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.ok(!(await response.text()).includes(cookieA));
    assert.equal(rt.writes.length, 0);
  }
});

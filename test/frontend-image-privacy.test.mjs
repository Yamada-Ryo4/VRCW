import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const root = new URL('../public/js/', import.meta.url);
const commonSource = readFileSync(new URL('common.js', root), 'utf8');
const imagesSource = readFileSync(new URL('images.js', root), 'utf8');
const mediaSource = readFileSync(new URL('media-profile.js', root), 'utf8');

function extractFunction(source, name) {
  const asyncMarker = source.indexOf(`async function ${name}`);
  const marker = asyncMarker >= 0 ? asyncMarker : source.indexOf(`function ${name}`);
  assert.notEqual(marker, -1, `${name} exists`);
  const start = source.indexOf('{', marker);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return source.slice(marker, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function makeCommonContext() {
  const context = {
    URL,
    location: { origin: 'https://vrcw.test', href: 'https://vrcw.test/' },
    API_BASE: 'https://vrcw.test',
    vrcAuth: 'auth=synthetic-cookie',
    _apiAuthBucket: () => 'opaque-bucket',
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(commonSource, 'proxyImg'), context);
  return context;
}

test('proxyImg emits clean, versioned URLs for VRChat and community images', () => {
  const context = makeCommonContext();
  const vrchat = vm.runInContext('proxyImg("https://api.vrchat.cloud/files/synthetic.png")', context);
  const community = vm.runInContext('proxyImg("https://cdn.example/synthetic.png")', context);
  for (const value of [vrchat, community]) {
    assert.match(value, /\/api\/image\?/);
    assert.match(value, /image-cache=4/);
    assert.doesNotMatch(value, /(?:^|[?&])(auth|bucket)=/i);
  }
});

test('image transport and consumers never put auth in markup or native fallback URLs', () => {
  assert.match(imagesSource, /headers\.set\('X-VRC-Auth', vrcAuth\)/);
  assert.match(imagesSource, /mode: 'same-origin'/);
  assert.match(imagesSource, /credentials: 'omit'/);
  assert.match(imagesSource, /redirect: 'error'/);
  assert.match(imagesSource, /referrerPolicy: 'no-referrer'/);
  assert.match(imagesSource, /function clearImageResources\(\)/);
  assert.match(imagesSource, /function openImageSafely\(source\)/);
  assert.doesNotMatch(imagesSource, /img\.src = src;\s*\/\/ Fallback direct URL/);
  assert.doesNotMatch(imagesSource, /encodeURIComponent\(vrcAuth/);
  for (const name of ['avatars.js', 'friends.js', 'sidebar-profile.js', 'friend-profile.js', 'groups-shell.js', 'groups-instance.js', 'assets-groups.js', 'context-menu.js', 'search.js', 'worlds.js']) {
    const source = readFileSync(new URL(name, root), 'utf8');
    assert.doesNotMatch(source, /(?:\/api\/image|image-cache)[^\n]*[?&](?:auth|bucket)=/i, `${name} has no image query credentials`);
    assert.doesNotMatch(source, /window\.open\([^\n]*img(?:Url|\.src)/, `${name} does not open a display URL directly`);
  }
});

test('album and polaroid click contracts use the safe open helper', () => {
  assert.ok(mediaSource.includes('openImageSafely(this.querySelector'), 'gallery cards open through the safe helper');
  assert.ok(mediaSource.includes('openImageSafely(this)'), 'polaroids open through the safe helper');
  assert.doesNotMatch(mediaSource, /window\.open\([^\n]*imgUrl/);
});

test('animated emoji backgrounds carry data-bg-src instead of a credentialed CSS URL', () => {
  const assets = readFileSync(new URL('assets-groups.js', root), 'utf8');
  assert.match(assets, /animatedEmojiStyle\('',/);
  assert.match(assets, /data-bg-src=/);
  assert.match(imagesSource, /function loadBackgroundImage\(el, src/);
});


function makeImageRuntime() {
  const calls = [];
  const revoked = [];
  const state = { epoch: 1, fetchImpl: async () => imageResponse() };
  class RuntimeURL extends URL {}
  let blobId = 0;
  RuntimeURL.createObjectURL = () => `blob:synthetic-${++blobId}`;
  RuntimeURL.revokeObjectURL = value => revoked.push(value);
  const context = {
    console,
    URL: RuntimeURL,
    Blob,
    Headers,
    AbortController,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    location: { origin: 'https://vrcw.test', href: 'https://vrcw.test/' },
    API_BASE: 'https://vrcw.test',
    vrcAuth: 'auth=synthetic-cookie',
    authSessionEpoch: state.epoch,
    authSessionAbortController: new AbortController(),
    _apiAuthBucket: () => 'bucket-synthetic',
    makeAuthSessionToken: () => ({ epoch: state.epoch, bucket: 'bucket-synthetic', credential: 'auth=synthetic-cookie' }),
    isAuthSessionCurrent: token => token?.epoch === state.epoch && token?.bucket === 'bucket-synthetic',
    authSessionCredential: 'auth=synthetic-cookie',
    proxyImg: value => {
      const parsed = new URL(value, 'https://vrcw.test');
      if (parsed.origin === 'https://vrcw.test') return parsed.pathname + parsed.search;
      return `https://vrcw.test/api/image?url=${encodeURIComponent(parsed.href)}&image-cache=4`;
    },
    idb: { getImage: async () => null, setImage: async () => {} },
    isPriorityTaskRunning: false,
    IntersectionObserver: class { observe() {} unobserve() {} },
    MutationObserver: undefined,
    window: { addEventListener() {} },
    VRCW: { registerModule() {} },
    renderAppVersionInfo() {},
    t: key => key,
    escHtml: value => String(value ?? ''),
    fetch: (url, options) => { calls.push({ url, options }); return state.fetchImpl(url, options); },
  };
  vm.createContext(context);
  vm.runInContext(imagesSource, context);
  return { context, calls, revoked, state };
}

function imageResponse({ status = 200, mime = 'image/png', bytes = 'synthetic-image' } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => mime }, blob: async () => new Blob([bytes], { type: mime }) };
}

test('fetchImageBlob uses auth only on same-origin image proxy requests', async () => {
  const runtime = makeImageRuntime();
  const blob = await runtime.context.fetchImageBlob('https://api.vrchat.cloud/files/synthetic.png');
  assert.equal(blob.type, 'image/png');
  const request = runtime.calls[0];
  assert.equal(request.options.headers.get('X-VRC-Auth'), 'auth=synthetic-cookie');
  assert.equal(request.options.mode, 'same-origin');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.referrerPolicy, 'no-referrer');
  assert.doesNotMatch(request.url, /(?:^|[?&])(auth|bucket)=/i);
});

test('fetchImageBlob rejects non-image status and MIME responses', async () => {
  const statusRuntime = makeImageRuntime();
  statusRuntime.state.fetchImpl = async () => imageResponse({ status: 403 });
  await assert.rejects(statusRuntime.context.fetchImageBlob('https://api.vrchat.cloud/files/restricted.png'), error => error.status === 403);
  const mimeRuntime = makeImageRuntime();
  mimeRuntime.state.fetchImpl = async () => imageResponse({ mime: 'text/html' });
  await assert.rejects(mimeRuntime.context.fetchImageBlob('https://api.vrchat.cloud/files/error.html'), /Unsupported image type/);
});

test('stale auth epochs cannot resolve an image blob', async () => {
  const runtime = makeImageRuntime();
  let resolveResponse;
  runtime.state.fetchImpl = () => new Promise(resolve => { resolveResponse = resolve; });
  const pending = runtime.context.fetchImageBlob('https://api.vrchat.cloud/files/old-account.png');
  runtime.state.epoch = 2;
  resolveResponse(imageResponse());
  await assert.rejects(pending, error => error.name === 'AbortError');
});

function fakeImageElement() {
  const attrs = new Map();
  const classes = new Set();
  const wrapper = { classList: { add() {}, remove() {} }, style: {}, dataset: {}, addEventListener() {}, removeEventListener() {} };
  return {
    dataset: {}, style: {}, parentElement: wrapper, onload: null, onerror: null, _src: '',
    classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name) },
    set src(value) { this._src = value; if (String(value).startsWith('blob:') && this.onload) this.onload.call(this); },
    get src() { return this._src; },
    setAttribute(name, value) { attrs.set(name, String(value)); if (name === 'data-src') this.dataset.src = String(value); },
    getAttribute(name) { return attrs.get(name) ?? null; },
    removeAttribute(name) { attrs.delete(name); if (name === 'data-src') delete this.dataset.src; },
  };
}

test('loadImage retains display blob until explicit resource disposal', async () => {
  const runtime = makeImageRuntime();
  const image = fakeImageElement();
  runtime.context.loadImage(image, 'https://api.vrchat.cloud/files/display.png');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(image.src, /^blob:synthetic-/);
  const displayUrl = image.dataset.blobUrl;
  runtime.context.disposeImage(image);
  assert.ok(runtime.revoked.includes(displayUrl));
});

test('gallery and polaroid renderers emit safe open-image handlers at runtime', async () => {
  const mediaContext = {
    console, URL, Date, Promise, setTimeout, clearTimeout, Blob, FormData,
    authSessionEpoch: 1, _assetsGen: 1, ASSETS_CACHE_TTL_MS: 1000,
    VRCW: { registerModule() {} }, renderAppVersionInfo() {}, observeImages() {}, openImageSafely() {},
    proxyImg: value => value, imageSrcAttrs: value => `src="blank" data-src="${value}"`, extractFileVersionUrl: file => file.versions?.[0]?.file?.url || '',
    makeUploadCard: () => '', escHtml: value => String(value ?? ''), escJsAttr: value => String(value ?? ''),
    getLocale: () => 'en-US', t: key => key, isAbortError: () => false,
    readAssetsCache: async () => ({ data: null, fresh: false }), writeAssetsCache: async () => {},
    getMyId: async () => 'usr_synthetic',
    apiCall: async path => ({ ok: true, status: 200, json: async () => path.includes('/prints/user/')
      ? [{ id: 'print-synthetic', files: { image: 'https://api.vrchat.cloud/print.png' } }]
      : [{ name: 'gallery-synthetic', versions: [{ status: 'complete', file: { url: 'https://api.vrchat.cloud/gallery.png' } }] }] }),
  };
  vm.createContext(mediaContext);
  vm.runInContext(mediaSource, mediaContext);
  const gallery = { innerHTML: '' };
  await mediaContext.fetchGalleryOnly(gallery, 1);
  assert.match(gallery.innerHTML, /openImageSafely\(this\.querySelector/);
  const prints = { innerHTML: '' };
  await mediaContext.fetchPrints(prints, 1);
  assert.match(prints.innerHTML, /openImageSafely\(this\)/);
  assert.doesNotMatch(gallery.innerHTML + prints.innerHTML, /[?&](auth|bucket)=/i);
});


function fakeDomNode(tagName) {
  return {
    tagName,
    style: {},
    dataset: {},
    children: [],
    textContent: '',
    onclick: null,
    appendChild(child) { this.children.push(child); return child; },
    remove() { this.removed = true; },
    setAttribute(name, value) { this[name] = String(value); },
    removeAttribute(name) { delete this[name]; },
  };
}

function fakeDocument() {
  return {
    title: '',
    head: fakeDomNode('head'),
    body: fakeDomNode('body'),
    createElement: tagName => fakeDomNode(tagName),
  };
}

test('openImageSafely opens a public image through a clean URL in a no-referrer popup', async () => {
  const runtime = makeImageRuntime();
  const popup = {
    document: fakeDocument(),
    closed: false,
    opener: 'unsafe-opener',
    location: { replaced: '', replace(value) { this.replaced = value; } },
    addEventListener() {},
    removeEventListener() {},
    close() { this.closed = true; },
  };
  runtime.context.window.open = () => popup;
  const opened = await runtime.context.openImageSafely('https://api.vrchat.cloud/files/public.png');
  assert.equal(opened, true);
  assert.equal(popup.opener, null);
  assert.match(popup.location.replaced, /^https:\/\/vrcw\.test\/api\/image\?/);
  assert.match(popup.location.replaced, /image-cache=4/);
  assert.ok(runtime.calls[0].options.headers instanceof Headers);
  assert.equal(runtime.calls[0].options.headers.get('X-VRC-Auth'), null, 'public probe is anonymous');
});

test('openImageSafely retries expected restricted failures with a header and uses a popup-blocked blob viewer', async () => {
  const runtime = makeImageRuntime();
  runtime.context.document = fakeDocument();
  runtime.context.window.open = () => null;
  runtime.state.fetchImpl = async (_url, options) => options.headers.get('X-VRC-Auth')
    ? imageResponse()
    : imageResponse({ status: 403 });
  const opened = await runtime.context.openImageSafely('https://api.vrchat.cloud/files/restricted.png');
  assert.equal(opened, true);
  assert.equal(runtime.calls.length, 2);
  assert.equal(runtime.calls[0].options.headers.get('X-VRC-Auth'), null);
  assert.equal(runtime.calls[1].options.headers.get('X-VRC-Auth'), 'auth=synthetic-cookie');
  assert.equal(runtime.context.document.body.children.length, 1, 'popup-blocked open uses an in-page viewer');
  runtime.context.clearImageResources();
  assert.equal(runtime.context.document.body.children[0].removed, true, 'cleanup closes the fallback viewer');
});

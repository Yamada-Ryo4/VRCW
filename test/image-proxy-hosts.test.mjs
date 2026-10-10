import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const commonSource = readFileSync(new URL('../public/js/common.js', import.meta.url), 'utf8');

function extractFn(source, name) {
  const marker = source.indexOf(`function ${name}`);
  assert.notEqual(marker, -1, `declares ${name}`);
  const brace = source.indexOf('{', marker);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = brace; i < source.length; i += 1) {
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

function createProxyImgHarness({ auth } = { auth: 'auth=authcookie_abc; twoFactorAuth=xyz' }) {
  const context = vm.createContext({
    URL,
    API_BASE: 'https://vrcw.test',
    vrcAuth: auth,
    location: { origin: 'https://vrcw.test', href: 'https://vrcw.test/' },
    _apiAuthBucket: () => 'bucket-opaque',
  });
  vm.runInContext(extractFn(commonSource, 'proxyImg'), context);
  return { proxy: url => vm.runInContext(`proxyImg(${JSON.stringify(url)})`, context) };
}

test('community image hosts are routed through the same-origin image proxy', () => {
  const h = createProxyImgHarness();
  const out = h.proxy('https://avtr.icu/proxy/file_a94aaa7-7ddc-4002-b730-8219a7fe4fa7/1/file');
  assert.ok(out.startsWith('https://vrcw.test/api/image?url='), 'community image goes through /api/image');
  assert.ok(decodeURIComponent(out).includes('avtr.icu/proxy/file_a94aaa7'), 'target URL is preserved');
  assert.ok(!out.includes('auth='), 'community proxy requests stay cookie-free');
});

test('VRChat image hosts use the same credential-free proxy form', () => {
  const h = createProxyImgHarness();
  const out = h.proxy('https://api.vrchat.cloud/api/1/file/file_78134d62-7dde-4519-a890-3fe72f1cfcb4/1/file');
  assert.ok(out.startsWith('https://vrcw.test/api/image?url='));
  assert.match(out, /(?:^|&)image-cache=4(?:&|$)/, 'proxy URL carries the cache migration marker');
  assert.ok(!out.includes('auth='), 'VRChat credentials never appear in image URLs');
  assert.ok(!out.includes('bucket='), 'opaque account buckets never appear in image URLs');
});

test('legacy outer auth and bucket are stripped without changing signed target parameters', () => {
  const h = createProxyImgHarness();
  const legacy = 'https://vrcw.test/api/image?url=' + encodeURIComponent('https://api.vrchat.cloud/file.png?auth=signed&bucket=upstream') + '&auth=legacy-cookie&bucket=legacy-bucket';
  const out = h.proxy(legacy);
  assert.ok(!out.includes('auth=legacy-cookie'));
  assert.ok(!out.includes('bucket=legacy-bucket'));
  const target = new URL(out, 'https://vrcw.test').searchParams.get('url');
  assert.equal(target, 'https://api.vrchat.cloud/file.png?auth=signed&bucket=upstream');
});

test('same-origin and non-http URLs pass through unchanged', () => {
  const h = createProxyImgHarness();
  assert.equal(h.proxy('/api/image?url=x'), '/api/image?url=x&image-cache=4');
  assert.equal(h.proxy('https://vrcw.test/api/image?url=x'), '/api/image?url=x&image-cache=4');
  assert.equal(h.proxy('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
  assert.equal(h.proxy(''), '');
});

test('proxy output never contains auth or bucket query credentials', () => {
  const h = createProxyImgHarness();
  for (const input of ['https://api.vrchat.cloud/file.png', 'https://cdn.example/file.png']) {
    const out = h.proxy(input);
    assert.doesNotMatch(out, /(?:^|[?&])(auth|bucket)=/i);
    assert.match(out, /image-cache=4/);
  }
});

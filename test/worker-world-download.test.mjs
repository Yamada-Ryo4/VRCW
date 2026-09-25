import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const workerSource = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
const routeStart = workerSource.indexOf('if (path === "/api/world-download"');
assert.notEqual(routeStart, -1, 'world download route exists');
const routeEnd = workerSource.indexOf('// GET /api/download', routeStart);
const route = workerSource.slice(routeStart, routeEnd);
const packageSelector = workerSource.slice(workerSource.indexOf('function getLatestWindowsWorldPackage'), workerSource.indexOf('async function proxyWorldDownloadAsset'));
const assetProxy = workerSource.slice(workerSource.indexOf('async function proxyWorldDownloadAsset'), workerSource.indexOf('function jsonResp'));

test('world download route accepts only POST and validates a world ID before upstream calls', () => {
  assert.match(route, /request\.method === "POST"/);
  assert.match(route, /worldId = typeof body\?\.worldId/);
  assert.match(route, /\^wrld_\[0-9a-f\]/i);
  assert.match(route, /const downloadAuth = auth;/, 'route authenticates with the X-VRC-Auth header session');
  assert.match(route, /if \(!downloadAuth\) return jsonResp\(\{ error: 'Authentication required' \}, 401\)/);
  assert.match(route, /resolveVrcIdentity/);
  assert.match(route, /worldResp\.ok/);
});

test('world download resolves identity, refetches official data, and chooses standalonewindows server-side', () => {
  assert.match(route, /vrcFetch\(`\/worlds\/\$\{encodeURIComponent\(worldId\)\}`/);
  assert.match(route, /world\.id !== worldId/);
  assert.match(packageSelector, /pkg\.platform === 'standalonewindows'/);
  assert.match(packageSelector, /pkg\.assetUrl/);
  assert.match(packageSelector, /!pkg\.assetUrl\.includes\('\/variant\/'\)/);
  assert.match(packageSelector, /isOfficialWorldFileUrl\(pkg\.assetUrl\)/);
  assert.match(packageSelector, /Number\(pkg\.assetVersion\)/, 'chooses highest assetVersion');
  assert.doesNotMatch(route, /body\??\.assetUrl|body\??\.filename|body\??\.platform/);
  assert.match(route, /sanitizeWorldDownloadFilename/);
  assert.match(workerSource, /windows\.vrcw/);
  const officialUrl = workerSource.slice(workerSource.indexOf('function isOfficialWorldFileUrl'), workerSource.indexOf('async function readBodyLimited'));
  assert.match(officialUrl, /parsed\.hostname\.toLowerCase\(\) === 'api\.vrchat\.cloud'/);
  assert.match(officialUrl, /file_\[0-9a-f-\]\{36\}/);
});

test('world download validates redirect hops and streams only a binary response', () => {
  assert.match(assetProxy, /redirect: 'manual'/);
  assert.match(assetProxy, /new URL\(location, current\)/);
  assert.match(assetProxy, /isOfficialWorldFileUrl\(current\.toString\(\)\)/);
  assert.match(assetProxy, /isAllowedDeliveryCdnTarget\(current\.toString\(\)\)/);
  assert.match(assetProxy, /if \(!response\?\.ok\)/);
  assert.match(assetProxy, /text\/html/);
  assert.match(assetProxy, /new Response\(response\.body/);
  assert.match(assetProxy, /Content-Disposition/);
});

test('existing GET avatar download route remains available', () => {
  assert.match(workerSource, /if \(path === "\/api\/download" && request\.method === "GET"\)/);
  assert.match(workerSource, /const vrcUrl = url\.searchParams\.get\("url"\)/);
});

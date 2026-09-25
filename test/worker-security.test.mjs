import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const worker = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');

test('s3proxy resolves an authenticated VRChat identity and validates the upload target', () => {
  const routeStart = worker.indexOf('if (path === "/api/s3proxy"');
  assert.notEqual(routeStart, -1, 's3proxy route exists');
  const route = worker.slice(routeStart, worker.indexOf('// POST /api/world-download', routeStart));

  assert.match(route, /resolveVrcIdentity\(request, env\)/, 'requires a live VRChat identity');
  assert.match(route, /if \(!identity\)/, 'rejects missing/invalid auth before upload proxying');
  assert.match(route, /isAllowedUploadTarget\(s3Url\)/, 'validates X-S3-Url with upload-specific allowlist');
  assert.match(route, /redirect:\s*"manual"/, 'does not automatically follow upload redirects');
});

test('image cache bucket is derived from auth instead of client query', () => {
  const routeStart = worker.indexOf('if (path === "/api/image"');
  assert.notEqual(routeStart, -1, 'image route exists');
  const route = worker.slice(routeStart, worker.indexOf('// GET /api/proxy', routeStart));

  assert.match(route, /const imageBucket = await authBucket\(imgAuth\)/, 'derives image cache bucket from effective auth');
  assert.doesNotMatch(route, /url\.searchParams\.get\("bucket"\)/, 'does not trust client-supplied bucket');
});

test('download redirects resolve relative locations and validate final URL', () => {
  const routeStart = worker.indexOf('if (path === "/api/download"');
  assert.notEqual(routeStart, -1, 'download route exists');
  const route = worker.slice(routeStart, worker.indexOf('// PUT /api/s3proxy', routeStart));

  assert.match(route, /new URL\(location, currentUrl\)/, 'resolves relative redirect locations');
  assert.match(route, /if \(!isAllowedTarget\(cdnUrl\) && !isAllowedDeliveryCdnTarget\(cdnUrl\)\)/, 'validates final CDN URL before fetch');
  assert.match(route, /sanitizeDownloadFilename/, 'sanitizes filename used in Content-Disposition');
});

test('target allowlist requires HTTPS for proxied targets', () => {
  const fnStart = worker.indexOf('function isAllowedTarget');
  assert.notEqual(fnStart, -1, 'isAllowedTarget exists');
  const fn = worker.slice(fnStart, worker.indexOf('function jsonResp', fnStart));

  assert.match(fn, /parsed\.protocol !== "https:"/, 'rejects non-HTTPS targets');
  assert.doesNotMatch(fn, /parsed\.protocol !== "https:" && parsed\.protocol !== "http:"/, 'does not allow plain HTTP');
});

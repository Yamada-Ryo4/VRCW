import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// Synthetic browser/API only: never run a Worker, fetch, filesystem picker, or
// real world request. Extract just the owned regions so integration hooks can
// change independently without accidentally exercising unrelated application code.
// This suite uses only bundled Node modules (no parser/package installation).
const source = readFileSync(new URL('../public/js/worlds.js', import.meta.url), 'utf8');
const main = source.includes('async function downloadCurrentWorldWindows(');
const detailAction = main ? 'downloadCurrentWorldWindows' : 'downloadCurrentWorld';
const missingWindows = main ? 'No downloadable Windows world package' : 'Windows world package unavailable';
const topStart = source.indexOf('function getLatestWindowsWorldPackage(');
const topEnd = source.indexOf(main ? '// Temp map used' : 'async function initWorldsTab(', topStart);
const buttonsStart = source.indexOf('function _updateWorldActionBtns(');
const buttonsEnd = source.indexOf('function renderWorldGrid(', buttonsStart);
assert.ok(topStart >= 0 && topEnd > topStart && buttonsStart >= 0 && buttonsEnd > buttonsStart);
const downloadSource = source.slice(topStart, topEnd) + '\n' + source.slice(buttonsStart, buttonsEnd);
const ids = [1, 2, 3, 4, 5, 6].map(n => `wrld_00000000-0000-0000-0000-${String(n).padStart(12, '0')}`);
const packageUrl = 'https://api.vrchat.cloud/api/1/file/file_00000000-0000-0000-0000-000000000001/1/file';
const auth = 'YXV0aD1zeW50aGV0aWM7dHdvRmFjdG9yQXV0aD1maXh0dXJl';
const json = value => JSON.parse(JSON.stringify(value));
const label = (key, params = {}) => `${key} ${JSON.stringify(params)}`;
const windowsWorld = (id = ids[0], name = 'Fixture world') => ({
  id, name, unityPackages: [{ platform: 'standalonewindows', assetUrl: packageUrl, assetVersion: 1 }]
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function binary(payload = 'UnityFS\0synthetic-binary', type = 'application/octet-stream') {
  return new Blob([payload], { type });
}

function response({ status = 200, error = '', blob = binary(), disposition = '', onBlob, onCancel } = {}) {
  const headers = new Headers({ 'Content-Type': blob.type });
  if (disposition) headers.set('Content-Disposition', disposition);
  return {
    ok: status >= 200 && status < 300, status, headers,
    json: async () => ({ error }),
    blob: async () => onBlob ? onBlob() : blob,
    body: { cancel: async () => { onCancel?.(); } }
  };
}

function harness(handler = async () => response(), { autoTimers = true } = {}) {
  const requests = [], saves = [], logs = [], toasts = [], urls = [], timers = [], elements = new Map();
  const memory = { liveUrls: 0, peakUrls: 0 };
  function element(id) {
    const attributes = new Map(), classes = new Set();
    const el = {
      id, dataset: {}, disabled: false, hidden: false, textContent: '', innerHTML: '', isConnected: true,
      setAttribute: (key, value) => attributes.set(key, value),
      getAttribute: key => attributes.get(key), removeAttribute: key => attributes.delete(key),
      classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) },
      click() { saves.push({ href: this.href, filename: this.download }); },
      remove() { this.isConnected = false; }
    };
    return el;
  }
  for (const id of ['btnWorldDownloadSelected', 'btnWorldCleanInvalid', 'btnWorldUnfavoriteSelected',
    'worldDetailDownloadBtn', 'worldDetailMobileDownloadBtn', 'worldDetailId']) elements.set(id, element(id));
  const context = vm.createContext({
    allWorlds: [], currentWorldDetail: null, selectedWorldIds: new Set(),
    currentWorldCategory: 'fav_worlds1', currentWorldFetchSeq: 1, currentUserId: 'usr_synthetic',
    vrcAuth: auth, authEpoch: 1, window: { _worldDetailActiveToken: null },
    Blob, Headers, TextDecoder, URLSearchParams, AbortController,
    URL: class extends URL {
      static createObjectURL(blob) {
        const url = `blob:synthetic-${urls.length + 1}`;
        urls.push({ url, blob });
        memory.liveUrls += 1; memory.peakUrls = Math.max(memory.peakUrls, memory.liveUrls);
        return url;
      }
      static revokeObjectURL(url) {
        const entry = urls.find(item => item.url === url);
        if (entry && !entry.revoked) { entry.revoked = true; delete entry.blob; memory.liveUrls -= 1; }
      }
    },
    document: {
      getElementById: id => elements.get(id) || null,
      createElement: tag => { assert.equal(tag, 'a', 'only a local blob anchor may be created'); return element(tag); },
      body: { appendChild: el => { el.isConnected = true; } }
    },
    setTimeout: (fn, delay) => {
      const entry = { fn, delay, cancelled: false }; timers.push(entry);
      if (autoTimers) queueMicrotask(() => { if (!entry.cancelled) fn(); });
      return timers.length;
    },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    t: label,
    showToast: (text, type) => toasts.push({ text, type }),
    worldLogMsg: (text, type) => logs.push({ text, type }),
    fetch: () => { throw new Error('Raw/real fetch is forbidden in synthetic tests'); },
    btoa: () => { throw new Error('Already encoded vrcAuth must not be encoded again'); },
    apiCall: async (path, options) => { requests.push({ path, options }); return handler(path, options, requests.length); }
  });
  context.makeAuthSessionToken = () => ({ epoch: context.authEpoch });
  context.isAuthSessionCurrent = token => token.epoch === context.authEpoch;
  context.isUiTokenCurrent = token => token === context.window._worldDetailActiveToken && token?.valid === true;
  vm.runInContext(downloadSource, context);
  const evaluate = code => vm.runInContext(code, context);
  function select(worlds) {
    context.allWorlds = worlds;
    context.selectedWorldIds = new Set(worlds.map(world => world.id));
    evaluate('_updateWorldActionBtns()');
  }
  function detail(world = windowsWorld()) {
    const token = { id: world.id, valid: true };
    context.currentWorldDetail = world;
    context.window._worldDetailActiveToken = token;
    elements.get('worldDetailId').textContent = world.id;
    evaluate('updateWorldDownloadButtons(currentWorldDetail)');
    return token;
  }
  return { context, requests, saves, logs, toasts, urls, timers, memory, elements, evaluate, select, detail,
    batch: () => context.downloadSelectedWorlds(), downloadDetail: () => context[detailAction](),
    helper: (id = ids[0], name = 'Fixture', options) => context.downloadWorldWindows(id, name, options),
    button: elements.get('btnWorldDownloadSelected') };
}

async function waitFor(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(predicate(), 'synthetic async step settled');
}

function countResult(started = 0, skipped = 0, failed = 0, stopped = false) {
  return { started, skipped, failed, stopped };
}

function assertReleased(h) {
  assert.equal(h.evaluate('_worldDownloadTask'), null);
  assert.equal(h.button.getAttribute('aria-busy'), 'false');
}

test('selected action is disabled empty and labels selection count without changing favorite visibility', () => {
  const h = harness();
  h.evaluate('_updateWorldActionBtns()');
  assert.equal(h.button.disabled, true);
  assert.equal(h.button.textContent, label('world.downloadSelected'));
  h.select([{ id: ids[0] }, { id: ids[1] }]);
  assert.equal(h.button.disabled, false);
  assert.equal(h.button.textContent, label('world.downloadSelectedCount', { count: 2 }));
  assert.equal(h.elements.get('btnWorldCleanInvalid').classList.contains('hidden'), false);
  h.context.currentWorldCategory = 'local';
  h.evaluate('_updateWorldActionBtns()');
  assert.equal(h.elements.get('btnWorldCleanInvalid').classList.contains('hidden'), true);
  assert.equal(h.button.disabled, false, 'downloads work in local categories too');
});

test('zero selection performs no API request and reports no selection', async () => {
  const h = harness();
  await h.batch();
  assert.equal(h.requests.length, 0);
  assert.equal(h.logs[0].text, label('world.noSelection'));
  assert.equal(h.evaluate('_worldDownloadTask'), null);
});

test('empty auth performs no request from batch, detail, or UI-neutral helper', async () => {
  const h = harness();
  h.select([windowsWorld()]);
  h.detail();
  h.context.vrcAuth = '';
  h.evaluate('_updateWorldActionBtns()');
  await h.batch();
  await h.downloadDetail();
  assert.equal((await h.helper()).status, 'stopped');
  assert.equal(h.requests.length, 0);
  assert.equal(h.button.disabled, true);
  assert.equal(h.saves.length, 0);
});

test('batch snapshots IDs and names, ignores cached package absence, and awaits every body serially', async () => {
  const gates = [deferred(), deferred(), deferred()];
  let active = 0, peak = 0;
  const h = harness(async (_path, _options, index) => response({ onBlob: async () => {
    active += 1; peak = Math.max(peak, active);
    const value = await gates[index - 1].promise;
    active -= 1;
    return value;
  } }));
  h.select([{ id: ids[0], name: 'Alpha', unityPackages: null },
    { id: ids[1], name: 'Beta', unityPackages: [] },
    { id: ids[2], name: 'Gamma', unityPackages: [{ platform: 'android' }] }]);
  const running = h.batch();
  await waitFor(() => active === 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.button.textContent, label('world.downloadProgress', { index: 1, total: 3 }));
  h.context.allWorlds[1].name = 'Changed after snapshot';
  h.context.selectedWorldIds.clear();
  h.context.selectedWorldIds.add(ids[5]);
  h.evaluate('_updateWorldActionBtns()');
  assert.equal(h.button.disabled, true);
  gates[0].resolve(binary());
  await waitFor(() => h.requests.length === 2 && active === 1);
  assert.equal(h.saves.length, 1);
  assert.equal(h.button.textContent, label('world.downloadProgress', { index: 2, total: 3 }));
  gates[1].resolve(binary());
  await waitFor(() => h.requests.length === 3 && active === 1);
  gates[2].resolve(binary());
  assert.deepEqual(json(await running), countResult(3));
  assert.equal(peak, 1, 'never reads two package bodies at once');
  assert.equal(h.memory.peakUrls, 1, 'previous package URL is revoked before the next download');
  assert.equal(h.memory.liveUrls, 0);
  assert.deepEqual(h.saves.map(item => item.filename), ['Alpha', 'Beta', 'Gamma'].map((name, i) => `${name}_${ids[i].slice(-8)}_windows.vrcw`));
  assert.deepEqual(h.logs.filter(item => item.text.startsWith('world.downloadProgress ')).map(item => item.text),
    [1, 2, 3].map(index => label('world.downloadProgress', { index, total: 3 })));
  assert.equal(h.logs.some(item => item.text.includes('Changed after snapshot')), false);
  assert.deepEqual([...h.context.selectedWorldIds], [ids[5]], 'selection is never cleared by download code');
  assertReleased(h);
});

test('transport sends only world identity and encoded auth in POST body/header, never URL credentials/assets', async () => {
  const h = harness();
  h.select([windowsWorld()]);
  await h.batch();
  const { path, options } = h.requests[0];
  assert.equal(options.method, 'POST');
  assert.equal(options.noAbort, true);
  assert.equal(options.headers['X-VRC-Auth'], auth);
  assert.equal(options.signal.aborted, false);
  assert.equal(path.includes('?'), false);
  assert.equal(path.includes(auth), false);
  assert.equal(path.includes(packageUrl), false);
  if (main) {
    assert.equal(path, `/api/worlds/${ids[0]}/download-windows`);
    assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.deepEqual([...new URLSearchParams(options.body)], [['auth', auth]]);
  } else {
    assert.equal(path, '/api/world-download');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), { worldId: ids[0] });
  }
});

test('selected IDs not in cached metadata still reach authoritative route', async () => {
  const h = harness();
  h.context.selectedWorldIds.add(ids[0]);
  assert.deepEqual(json(await h.batch()), countResult(1));
  assert.equal(h.requests.length, 1);
  assert.equal(h.saves.length, 1);
});

test('duplicate batch and simultaneous detail/helper actions cannot start another file', async () => {
  const gate = deferred();
  const h = harness(async () => response({ onBlob: () => gate.promise }));
  h.select([windowsWorld()]);
  h.detail();
  const running = h.batch();
  await waitFor(() => h.requests.length === 1);
  await h.batch();
  await h.downloadDetail();
  assert.equal((await h.helper()).status, 'busy');
  assert.equal(h.requests.length, 1);
  assert.equal(h.elements.get('worldDetailDownloadBtn').disabled, true);
  assert.equal(h.elements.get('btnWorldCleanInvalid').disabled, true);
  assert.equal(h.elements.get('btnWorldUnfavoriteSelected').disabled, true);
  gate.resolve(binary());
  await running;
  assert.equal(h.saves.length, 1);
  assert.equal(h.elements.get('worldDetailDownloadBtn').disabled, false);
  assertReleased(h);
});

test('detail holds the same single-flight lock against duplicate detail and batch clicks', async () => {
  const gate = deferred();
  const h = harness(async () => response({ onBlob: () => gate.promise }));
  h.select([windowsWorld()]);
  h.detail();
  const running = h.downloadDetail();
  await h.downloadDetail();
  await h.batch();
  assert.equal(h.requests.length, 1);
  assert.equal(h.button.textContent, label('world.downloading'));
  gate.resolve(binary());
  await running;
  assert.equal(h.saves.length, 1);
  assert.equal(h.toasts.at(-1).text, label(main ? 'wd.downloadStarted' : 'world.downloadStarted'));
  assert.equal(h.elements.get('worldDetailDownloadBtn').dataset.downloading, undefined);
  assertReleased(h);
});

test('helper is UI-neutral and direct helper callers also share the lock', async () => {
  const gate = deferred();
  const h = harness(async () => response({ onBlob: () => gate.promise }));
  const running = h.helper();
  assert.equal((await h.helper()).status, 'busy');
  assert.equal(h.requests.length, 1);
  gate.resolve(binary());
  assert.equal((await running).status, 'started');
  assert.equal(h.logs.length, 0);
  assert.equal(h.toasts.length, 0);
  assert.equal(h.evaluate('_worldDownloadTask'), null);
});

test('only route-specific missing Windows 404 skips; permission, other 404, 500, network failures continue', async () => {
  const outcomes = [response({ status: 404, error: missingWindows }),
    response({ status: 403, error: 'World permission denied' }),
    response({ status: 404, error: 'World lookup failed' }),
    response({ status: 500, error: 'Synthetic upstream failure' }), new Error('Synthetic network failure'), response()];
  const h = harness(async (_path, _options, index) => {
    if (outcomes[index - 1] instanceof Error) throw outcomes[index - 1];
    return outcomes[index - 1];
  });
  h.select(ids.map(id => ({ id, name: id })));
  assert.deepEqual(json(await h.batch()), countResult(1, 1, 4));
  assert.equal(h.requests.length, 6);
  assert.equal(h.logs.filter(item => item.text.startsWith('world.downloadItemSkipped ')).length, 1);
  assert.equal(h.logs.filter(item => item.text.startsWith('world.downloadItemFailed ')).length, 4);
  assert.equal(h.logs.at(-1).text, label('world.downloadBatchDone', countResult(1, 1, 4)));
  assertReleased(h);
});

test('401 records failure then stops remaining items and releases lock', async () => {
  const h = harness(async () => response({ status: 401, error: 'Authentication required' }));
  h.select([{ id: ids[0] }, { id: ids[1] }]);
  assert.deepEqual(json(await h.batch()), countResult(0, 0, 1, true));
  assert.equal(h.requests.length, 1);
  assert.equal(h.logs.at(-1).text, label('world.downloadBatchStopped'));
  assert.equal(h.saves.length, 0);
  assertReleased(h);
});

for (const [title, value] of [
  ['empty', binary('')], ['JSON', binary('{"error":"denied"}', 'application/json')],
  ['HTML', binary('<!doctype html>Error', 'text/html')], ['plain text', binary('Denied', 'text/plain')],
  ['JSON disguised as binary', binary('{"error":"denied"}')],
  ['HTML disguised as binary', binary('<html>denied</html>')],
  ['text disguised as binary', binary('Unauthorized')]
]) {
  test(`invalid ${title} body never triggers save and does not block the next item`, async () => {
    const h = harness(async (_path, _options, index) => index === 1 ? response({ blob: value }) : response());
    h.select([{ id: ids[0] }, { id: ids[1] }]);
    assert.deepEqual(json(await h.batch()), countResult(1, 0, 1));
    assert.equal(h.saves.length, 1);
    assertReleased(h);
  });
}

for (const [title, change] of [
  ['account epoch', h => { h.context.authEpoch += 1; }],
  ['account ID', h => { h.context.currentUserId = 'usr_switched'; }],
  ['category', h => { h.context.currentWorldCategory = 'local'; }],
  ['list generation', h => { h.context.currentWorldFetchSeq += 1; }],
  ['auth removal', h => { h.context.vrcAuth = ''; }]
]) {
  test(`${title} change during body suppresses stale saves, item logs, and next requests`, async () => {
    const gate = deferred();
    let reading = false;
    const h = harness(async () => response({ onBlob: () => { reading = true; return gate.promise; } }));
    h.select([{ id: ids[0] }, { id: ids[1] }]);
    h.detail();
    const running = h.batch();
    await waitFor(() => reading);
    const logCount = h.logs.length;
    change(h);
    gate.resolve(binary());
    assert.deepEqual(json(await running), countResult(0, 0, 0, true));
    assert.equal(h.saves.length, 0);
    assert.equal(h.urls.length, 0);
    assert.equal(h.logs.length, logCount, 'no stale per-item or completion repaint');
    assert.equal(h.toasts.length, 0);
    assert.equal(h.requests.length, 1);
    assert.equal(h.elements.get('worldDetailDownloadBtn').disabled, true, 'stale cleanup does not repaint details');
    assert.deepEqual([...h.context.selectedWorldIds], ids.slice(0, 2));
    assertReleased(h);
  });
}

test('category change before response cancels discarded body without reading or saving it', async () => {
  const gate = deferred();
  let discarded = 0, bodies = 0;
  const h = harness(async () => gate.promise);
  h.select([{ id: ids[0] }, { id: ids[1] }]);
  const running = h.batch();
  h.context.currentWorldCategory = 'recent';
  gate.resolve(response({ onCancel: () => { discarded += 1; }, onBlob: () => { bodies += 1; return binary(); } }));
  assert.deepEqual(json(await running), countResult(0, 0, 0, true));
  assert.equal(discarded, 1);
  assert.equal(bodies, 0);
  assert.equal(h.saves.length, 0);
  assertReleased(h);
});

test('credential refresh within the same session permits next item using current encoded credential', async () => {
  const h = harness(async (_path, _options, index) => {
    if (index === 1) h.context.vrcAuth = 'cmVmcmVzaGVkLXN5bnRoZXRpYw==';
    return response();
  });
  h.select([{ id: ids[0] }, { id: ids[1] }]);
  assert.deepEqual(json(await h.batch()), countResult(2));
  assert.equal(h.requests[1].options.headers['X-VRC-Auth'], 'cmVmcmVzaGVkLXN5bnRoZXRpYw==');
});

for (const aborted of ['response499', 'AbortError']) {
  test(`${aborted} stops the batch rather than counting an item failure`, async () => {
    const h = harness(async () => {
      if (aborted === 'response499') return response({ status: 499, error: 'Aborted' });
      const error = new Error('Synthetic abort'); error.name = 'AbortError'; throw error;
    });
    h.select([{ id: ids[0] }, { id: ids[1] }]);
    assert.deepEqual(json(await h.batch()), countResult(0, 0, 0, true));
    assert.equal(h.requests.length, 1);
    assert.equal(h.saves.length, 0);
    assertReleased(h);
  });
}

test('cancellation aborts, preserves selection, holds lock until body settles, then permits a new task', async () => {
  const gate = deferred();
  let reading = false;
  const h = harness(async (_path, _options, index) => index === 1
    ? response({ onBlob: () => { reading = true; return gate.promise; } }) : response());
  h.select([{ id: ids[0] }, { id: ids[1] }]);
  const running = h.batch();
  await waitFor(() => reading);
  assert.equal(h.context.cancelWorldDownloads('detail'), false, 'modal hooks do not cancel batches');
  assert.equal(h.context.cancelWorldDownloads(), true);
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.button.disabled, true);
  await h.batch();
  assert.equal(h.requests.length, 1, 'cannot overlap the cancelled in-flight body');
  const logCount = h.logs.length;
  assert.equal(h.context.cancelWorldDownloads(), true);
  assert.equal(h.logs.length, logCount, 'stopped log is not repeated');
  gate.resolve(binary());
  assert.deepEqual(json(await running), countResult(0, 0, 0, true));
  assert.equal(h.saves.length, 0);
  assert.deepEqual([...h.context.selectedWorldIds], ids.slice(0, 2));
  assertReleased(h);
  assert.deepEqual(json(await h.batch()), countResult(2));
});

test('old detail finally cannot overwrite a replacement task owner or its controls', async () => {
  const gate = deferred();
  let reading = false;
  const h = harness(async () => response({ onBlob: () => { reading = true; return gate.promise; } }));
  h.detail();
  const running = h.downloadDetail();
  await waitFor(() => reading);
  h.evaluate('_worldDownloadTask = null; _beginWorldDownloadTask("batch")');
  const replacement = h.evaluate('_worldDownloadTask');
  h.button.textContent = 'Replacement progress';
  h.elements.get('worldDetailDownloadBtn').textContent = 'Replacement controls';
  gate.resolve(binary());
  await running;
  assert.equal(h.evaluate('_worldDownloadTask'), replacement);
  assert.equal(h.button.textContent, 'Replacement progress');
  assert.equal(h.elements.get('worldDetailDownloadBtn').textContent, 'Replacement controls');
  assert.equal(h.saves.length, 0);
  assert.equal(h.toasts.length, 0);
});

test('detail rejects mismatched world ID and invalid token before any request', async () => {
  const h = harness();
  h.detail();
  h.elements.get('worldDetailId').textContent = ids[1];
  await h.downloadDetail();
  h.elements.get('worldDetailId').textContent = ids[0];
  h.context.window._worldDetailActiveToken.valid = false;
  await h.downloadDetail();
  assert.equal(h.requests.length, 0);
  assert.equal(h.saves.length, 0);
});

for (const mutation of ['replace token', 'replace ID', 'close detail']) {
  test(`${mutation} during detail body prevents stale download and stale button/toast updates`, async () => {
    const gate = deferred();
    let reading = false;
    const h = harness(async () => response({ onBlob: () => { reading = true; return gate.promise; } }));
    h.detail();
    const running = h.downloadDetail();
    await waitFor(() => reading);
    if (mutation === 'replace token') h.context.window._worldDetailActiveToken = { id: ids[0], valid: true };
    if (mutation === 'replace ID') {
      h.context.currentWorldDetail = windowsWorld(ids[1]);
      h.elements.get('worldDetailId').textContent = ids[1];
    }
    if (mutation === 'close detail') h.context.window._worldDetailActiveToken = null;
    const button = h.elements.get('worldDetailDownloadBtn');
    button.textContent = 'New detail state';
    gate.resolve(binary());
    await running;
    assert.equal(h.saves.length, 0);
    assert.equal(h.toasts.length, 0);
    assert.equal(button.textContent, 'New detail state');
    assertReleased(h);
  });
}

test('detail also uses fresh route for incomplete packages and shows only known missing-Windows result', async () => {
  const h = harness(async () => response({ status: 404, error: missingWindows }));
  h.detail({ id: ids[0], name: 'Incomplete', unityPackages: null });
  await h.downloadDetail();
  assert.equal(h.requests.length, 1);
  assert.equal(h.toasts[0].text, label(main ? 'wd.noWindowsPackage' : 'world.noWindowsPackage'));
  assert.equal(h.saves.length, 0);
  assertReleased(h);
});

test('caller guard prevents initial request and discards a blob if caller becomes stale', async () => {
  const gate = deferred();
  let current = false, reading = false;
  const h = harness(async () => response({ onBlob: () => { reading = true; return gate.promise; } }));
  assert.equal((await h.helper(ids[0], 'Fixture', { isCurrent: () => current })).status, 'stopped');
  assert.equal(h.requests.length, 0);
  current = true;
  const running = h.helper(ids[0], 'Fixture', { isCurrent: () => current });
  await waitFor(() => reading);
  current = false;
  gate.resolve(binary());
  assert.equal((await running).status, 'stopped');
  assert.equal(h.saves.length, 0);
  assert.equal(h.evaluate('_worldDownloadTask'), null);
});

test('safe server UTF-8 filename takes precedence and ownership lasts until URL revocation', async () => {
  const h = harness(async () => response({ disposition: 'attachment; filename="ascii.vrcw"; filename*=UTF-8\'\'%E4%B8%96%E7%95%8C_windows.vrcw' }), { autoTimers: false });
  const running = h.helper();
  await waitFor(() => h.timers.length === 1);
  assert.equal(h.saves[0].filename, '世界_windows.vrcw');
  assert.match(h.saves[0].href, /^blob:synthetic-/);
  assert.equal(h.urls[0].revoked, undefined);
  assert.equal(h.memory.liveUrls, 1);
  assert.equal(h.timers[0].delay, 1000);
  assert.equal((await h.helper()).status, 'busy', 'second file cannot start during URL consumption grace');
  h.timers[0].fn();
  assert.equal((await running).status, 'started');
  assert.equal(h.urls[0].revoked, true);
  assert.equal(h.memory.liveUrls, 0);
});

test('cancellation during URL grace releases the Blob before a successor can start', async () => {
  const h = harness(async () => response(), { autoTimers: false });
  h.select([{ id: ids[0] }, { id: ids[1] }]);
  const running = h.batch();
  await waitFor(() => h.timers.length === 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.memory.liveUrls, 1);
  h.context.cancelWorldDownloads();
  assert.deepEqual(json(await running), countResult(0, 0, 0, true));
  assert.equal(h.urls[0].revoked, true);
  assert.equal(h.memory.liveUrls, 0);
  assert.equal(h.timers[0].cancelled, true);
  assertReleased(h);
  const successor = h.helper(ids[2]);
  await waitFor(() => h.timers.length === 2);
  h.timers[1].fn();
  assert.equal((await successor).status, 'started');
  assert.equal(h.memory.peakUrls, 1);
  assert.equal(h.memory.liveUrls, 0);
});

test('unsafe server filenames use sanitized name fallback with fixed Windows vrcw extension', async () => {
  for (const disposition of ['attachment; filename="../escape.vrcw"', 'attachment; filename="wrong.exe"',
    'attachment; filename="CON.vrcw"', 'attachment; filename*=UTF-8\'\'%00bad.vrcw',
    'attachment; filename*=UTF-8\'\'%E0%A4%A', 'attachment; filename="C:\\file.vrcw"']) {
    const h = harness(async () => response({ disposition }));
    await h.helper(ids[0], '\u0000<bad>:/\\|?*. ');
    assert.equal(h.saves.length, 1);
    assert.equal(h.saves[0].filename, `${'\u0000<bad>:/\\|?*'.replace(/[\u0000<>:/\\|?*]/g, '_')}_${ids[0].slice(-8)}_windows.vrcw`);
    assert.doesNotMatch(h.saves[0].filename, /[\u0000-\u001f<>:"/\\|?*]/);
  }
});

test('invalid IDs are rejected locally without request and helper ownership is released', async () => {
  const h = harness();
  await assert.rejects(h.helper('https://example.invalid/asset', 'Fixture'), /Invalid world ID/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.evaluate('_worldDownloadTask'), null);
});

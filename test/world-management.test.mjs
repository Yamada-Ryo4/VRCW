import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/js/world-management.js', import.meta.url), 'utf8');
const A = 'wrld_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'wrld_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OWNER = 'usr_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'usr_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function world(overrides = {}) {
  return {
    id: A, authorId: OWNER, name: 'World A', description: 'Original description',
    capacity: 80, recommendedCapacity: 40,
    tags: ['system_approved', 'author_tag_cozy', 'admin_featured', 'author_tag_music', 'unknown_legacy'],
    previewYoutubeId: 'dQw4w9WgXcQ', urlList: ['https://example.test/original'],
    releaseStatus: 'private', imageUrl: 'https://example.test/image.png',
    unityPackages: [{ platform: 'standalonewindows', assetUrl: 'legacy package' }], version: 7,
    ...overrides,
  };
}

class ClassList {
  constructor(values = []) { this.values = new Set(values); }
  contains(value) { return this.values.has(value); }
  add(...values) { values.forEach(value => this.values.add(value)); }
  remove(...values) { values.forEach(value => this.values.delete(value)); }
  toggle(value, force) {
    const next = force ?? !this.values.has(value);
    next ? this.values.add(value) : this.values.delete(value);
    return next;
  }
}

class Element {
  constructor(id, hidden = false) {
    this.id = id;
    this.classList = new ClassList(hidden ? ['hidden'] : []);
    this.hidden = hidden;
    this.disabled = false;
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.value = '';
    this.textContent = '';
    this.focusCount = 0;
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  focus() { this.focusCount += 1; }
  set innerHTML(_) { throw new Error('Management must not write unsafe HTML.'); }
}

function response(body, status = 200, jsonHook = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (jsonHook) return jsonHook();
      if (body === undefined) throw new SyntaxError('Empty response');
      return copy(body);
    },
  };
}

function harness(initial = world()) {
  const ids = [
    'worldDetailModal', 'worldDetailId', 'worldDetailName', 'worldDetailOwnerActions',
    'worldDetailEditBtn', 'worldDetailDeleteBtn', 'worldEditModal', 'worldEditName',
    'worldEditDescription', 'worldEditCapacity', 'worldEditRecommendedCapacity',
    'worldEditTags', 'worldEditPreviewYoutubeId', 'worldEditUrlList',
    'worldEditReleaseStatus', 'worldEditId', 'worldEditStatus', 'btnSaveWorldEdit',
    'worldDeleteConfirmModal', 'worldDeleteConfirmName', 'worldDeleteConfirmId',
    'worldDeleteConfirmStatus', 'btnConfirmWorldDelete', 'btnCancelWorldDelete',
  ];
  const elements = new Map(ids.map(id => [id, new Element(id, ['worldEditModal', 'worldDeleteConfirmModal', 'worldDetailOwnerActions'].includes(id))]));
  const requests = [];
  const updates = [];
  const deletions = [];
  const cacheWrites = [];
  const cache = new Map();
  const translations = [];
  const locks = { count: 0 };
  let route = (_path, options) => response(options.method === 'PUT' ? { ...world(), ...options.json } : undefined);
  let updateImplementation;
  let deleteImplementation;
  const context = vm.createContext({
    console,
    URL,
    document: { getElementById: id => elements.get(id) || null },
    fetch() { throw new Error('Real network is forbidden in this harness.'); },
    logout() { throw new Error('Real logout is forbidden in this harness.'); },
    lockBodyScroll() { locks.count += 1; },
    unlockBodyScroll() { locks.count -= 1; assert.ok(locks.count >= 0, 'balanced dialog scroll locks'); },
    modalZTop: () => 3100,
    t(key, values) { translations.push([key, copy(values)]); return key; },
    VRCW: {
      modules: {},
      registerModule(name, module) { this.modules[name] = Object.freeze({ ...module }); },
    },
    async apiCall(path, options = {}) {
      assert.match(path, /^\/api\/vrc\/worlds\/wrld_[0-9a-f-]{36}$/i, 'only simulated world detail routes');
      assert.ok(['PUT', 'DELETE', 'GET'].includes(options.method || 'GET'));
      requests.push({ path, options: copy(options) });
      return route(path, options);
    },
    idb: {
      async set(key, value, token) {
        if (!vm.runInContext('isAuthSessionCurrent', context)(token)) return;
        cacheWrites.push({ key, value: copy(value), token });
        cache.set(key, copy(value));
      },
      async del(key, token) {
        if (!vm.runInContext('isAuthSessionCurrent', context)(token)) return;
        cacheWrites.push({ key, deleted: true, token });
        cache.delete(key);
      },
    },
    async applyWorldManagementUpdate(record, options) {
      updates.push({ record, options });
      if (updateImplementation) return updateImplementation(record, options);
      if (!options.isSessionCurrent() || !options.isOperationCurrent()) return;
      context.__record = record;
      vm.runInContext('allWorlds = allWorlds.map(item => item.id === __record.id ? {...item, ...__record} : item)', context);
      await context.idb.set('world_basics_v2_' + options.category, [record], options.sessionToken);
      if (!options.isSessionCurrent()) return;
      if (options.isDetailCurrent()) {
        vm.runInContext('currentWorldDetail = __record', context);
        elements.get('worldDetailName').textContent = record.name;
      }
    },
    async applyWorldManagementDelete(record, options) {
      deletions.push({ record, options });
      if (deleteImplementation) return deleteImplementation(record, options);
      if (!options.isSessionCurrent() || !options.isOperationCurrent()) return;
      context.__deletedId = record.id;
      vm.runInContext('allWorlds = allWorlds.filter(item => item.id !== __deletedId); selectedWorldIds.delete(__deletedId)', context);
      await context.idb.del('world_basics_v2_' + options.category, options.sessionToken);
      if (!options.isSessionCurrent()) return;
      if (options.isDetailCurrent() && options.isDialogCurrent()) {
        elements.get('worldDetailModal').classList.add('hidden');
        vm.runInContext('currentWorldDetail = null; window._worldDetailActiveToken = null', context);
      }
    },
  });
  vm.runInContext(`
    window = globalThis;
    let currentUserId = ${JSON.stringify(OWNER)};
    let currentWorldDetail = ${JSON.stringify(initial)};
    let allWorlds = [${JSON.stringify({ ...initial, favoriteId: 'favorite_A', localFavorite: true })}];
    let selectedWorldIds = new Set([${JSON.stringify(A)}]);
    let currentWorldCategory = 'fav_worlds1';
    let worldFavGroups = [{name: 'worlds1'}];
    let worldFavoriteIdMap = new Map([[${JSON.stringify(A)}, 'favorite_A']]);
    let worldFavGroupCounts = new Map([['worlds1', 1]]);
    let sessionEpoch = 1;
    let uiEpoch = 1;
    function makeAuthSessionToken() { return Object.freeze({epoch: sessionEpoch, bucket: 'simulated-' + sessionEpoch, accountId: currentUserId}); }
    function isAuthSessionCurrent(token) { return !!token && token.epoch === sessionEpoch; }
    function isUiTokenCurrent(token) { return !!token && token === window._worldDetailActiveToken && token.epoch === uiEpoch; }
    window._worldDetailActiveToken = {scope: 'worldDetail', id: currentWorldDetail.id, epoch: uiEpoch};
  `, context);
  elements.get('worldDetailId').textContent = initial.id;
  elements.get('worldDetailName').textContent = initial.name;
  vm.runInContext(source, context, { filename: 'world-management.js' });
  const run = expression => vm.runInContext(expression, context);
  return {
    context, elements, requests, updates, deletions, cacheWrites, cache, translations, locks, run,
    module: context.VRCW.modules.worldManagement,
    get: id => elements.get(id),
    input(id, value) { elements.get(id).value = value; },
    setRoute(next) { route = next; },
    onUpdate(next) { updateImplementation = next; },
    onDelete(next) { deleteImplementation = next; },
    switchDetail(next = world({ id: B, name: 'World B' }), reset = true) {
      if (reset) run('resetWorldManagementDialogs()');
      context.__nextWorld = next;
      run('currentWorldDetail = __nextWorld; uiEpoch += 1; window._worldDetailActiveToken = {scope: "worldDetail", id: currentWorldDetail.id, epoch: uiEpoch}');
      elements.get('worldDetailId').textContent = next.id;
      elements.get('worldDetailName').textContent = next.name;
      elements.get('worldDetailModal').hidden = false;
      elements.get('worldDetailModal').classList.remove('hidden');
    },
    switchAccount(account = OTHER, reset = true) {
      if (reset) run('resetWorldManagementDialogs()');
      context.__account = account;
      run('sessionEpoch += 1; currentUserId = __account');
    },
  };
}

const submitted = h => h.requests.filter(request => request.options.method === 'PUT').map(request => request.options.json);

// The whole module runs in a VM with lexical classic globals, fake DOM, fake
// API, and token-aware fake IDB. No existing runtime or real service is loaded.
test('registers private handlers; shell wrappers cannot recursively call themselves', async () => {
  const h = harness();
  const names = ['editCurrentWorld', 'saveWorldEdit', 'closeWorldEditModal', 'updateWorldOwnerActions', 'deleteCurrentWorld', 'confirmWorldDeletion', 'closeWorldDeleteConfirm', 'resetWorldManagementDialogs'];
  assert.deepEqual(Object.keys(h.module).sort(), names.sort());
  h.run('window.editCurrentWorld = () => { throw new Error("shell wrapper re-entered"); }; window.deleteCurrentWorld = window.editCurrentWorld');
  assert.equal(h.module.editCurrentWorld(), true);
  h.module.closeWorldEditModal();
  assert.equal(h.module.deleteCurrentWorld(), true);
  h.module.closeWorldDeleteConfirm();
  assert.equal(h.requests.length, 0);
});

test('fills controls from a frozen official snapshot with text/value only; publication is read-only', () => {
  const initial = world({ name: '<img src=x onerror=bad()>', description: '</textarea><script>bad()</script>', capacity: null, recommendedCapacity: undefined });
  const h = harness(initial);
  assert.equal(h.run('editCurrentWorld()'), true);
  assert.equal(h.get('worldEditName').value, initial.name);
  assert.equal(h.get('worldEditDescription').value, initial.description);
  assert.equal(h.get('worldEditCapacity').value, '');
  assert.equal(h.get('worldEditRecommendedCapacity').value, '');
  assert.equal(h.get('worldEditTags').value, 'cozy, music');
  assert.equal(h.get('worldEditReleaseStatus').textContent, 'private');
  assert.equal(h.get('worldEditId').textContent, A);
  assert.equal(h.get('worldEditName').focusCount, 1);
  assert.equal(h.locks.count, 1);
  h.run('closeWorldEditModal(); closeWorldEditModal()');
  assert.equal(h.get('worldEditModal').hidden, true);
  assert.equal(h.locks.count, 0);
});

test('dirty-only safe whitelist preserves reserved/unknown tags, private release, image, and build fields', async () => {
  const legacyTag = { unknown: ['preserve exactly'] };
  const initial = world({ tags: ['system_x', 'author_tag_cozy', 'admin_x', 'author_tag_music', 'system_x', '', legacyTag] });
  const h = harness(initial);
  h.setRoute((_path, options) => response({ ...initial, ...options.json, name: 'Server-normalized name', version: 8 }));
  h.run('editCurrentWorld()');
  h.input('worldEditName', '  Changed name  ');
  h.input('worldEditDescription', 'Changed description');
  h.input('worldEditCapacity', '160');
  h.input('worldEditRecommendedCapacity', '200'); // No invented recommended <= capacity rule.
  h.input('worldEditTags', ' cozy, dancing, dancing, ');
  h.input('worldEditPreviewYoutubeId', 'AbCdEf012_-');
  h.input('worldEditUrlList', ' https://example.test/a\nhttp://example.test/b ');
  h.get('worldEditReleaseStatus').textContent = 'public';
  h.run('currentWorldDetail.name = "mutated reference"; currentWorldDetail.tags.push("system_late"); allWorlds[0].favoriteId = "mutated favorite"');
  assert.equal(await h.run('saveWorldEdit()'), true);
  assert.deepEqual(submitted(h), [{
    name: 'Changed name', description: 'Changed description', capacity: 160, recommendedCapacity: 200,
    tags: ['system_x', 'author_tag_cozy', 'admin_x', 'author_tag_dancing', 'system_x', '', legacyTag],
    previewYoutubeId: 'AbCdEf012_-', urlList: ['https://example.test/a', 'http://example.test/b'],
  }]);
  assert.equal(h.requests.length, 1, 'complete authoritative response needs no followup GET');
  assert.equal(h.updates[0].record.name, 'Server-normalized name');
  assert.equal(h.updates[0].record.releaseStatus, 'private');
  assert.equal(h.updates[0].record.version, 8);
  const options = h.updates[0].options;
  assert.equal(options.worldId, A);
  assert.equal(options.ownerId, OWNER);
  assert.equal(options.accountId, OWNER);
  assert.equal(options.category, 'fav_worlds1');
  assert.equal(options.operation, 'edit');
  assert.equal(options.selected, true);
  assert.equal(options.sourceWorld.favoriteId, 'favorite_A');
  assert.equal(options.originalWorld.name, initial.name);
  assert.equal(options.originalWorld.tags.length, initial.tags.length);
  assert.ok(Object.isFrozen(options));
  assert.ok(Object.isFrozen(options.originalWorld));
  assert.ok(Object.isFrozen(options.originalWorld.tags));
  assert.ok(Object.isFrozen(options.originalWorld.tags.at(-1).unknown));
  assert.ok(Object.isFrozen(options.sourceWorld));
  assert.throws(() => { options.originalWorld.name = 'alter'; }, TypeError);
  assert.equal(h.get('worldEditModal').hidden, true);
  assert.equal(h.get('worldDetailName').textContent, 'Server-normalized name');
  assert.equal(h.cacheWrites[0].token, options.sessionToken);
  assert.equal(options.isSessionCurrent(), true);
  assert.equal(options.isDialogCurrent(), false);
  assert.equal(options.isOperationCurrent(), false, 'flight guard expires after synchronization');
});

test('unchanged form and cosmetic keyword/URL normalization produce no PUT or cache write', async () => {
  const h = harness();
  h.run('editCurrentWorld()');
  assert.equal(await h.run('saveWorldEdit()'), false);
  assert.match(h.get('worldEditStatus').textContent, /No changes/);
  h.input('worldEditTags', ' cozy , music , music ');
  h.input('worldEditUrlList', '\n https://example.test/original \n');
  h.input('worldEditCapacity', '080');
  h.input('worldEditName', '  World A  ');
  h.get('worldEditReleaseStatus').textContent = 'public';
  assert.equal(await h.run('saveWorldEdit()'), false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.cacheWrites.length, 0);
  assert.equal(h.get('worldEditModal').hidden, false);
});

test('unmodified legacy-invalid and absent optional fields are omitted instead of defaulted or validated', async () => {
  const initial = world({ capacity: null, recommendedCapacity: undefined, tags: ['system_x', 'author_tag_system_legacy'], previewYoutubeId: 'https://legacy.test/video', urlList: ['javascript:legacy()'] });
  const h = harness(initial);
  h.setRoute((_path, options) => response({ ...initial, ...options.json }));
  h.run('editCurrentWorld()');
  h.input('worldEditDescription', 'Only this changes');
  assert.equal(await h.run('saveWorldEdit()'), true);
  assert.deepEqual(submitted(h), [{ description: 'Only this changes' }]);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(copy(h.updates[0].record.urlList), initial.urlList);
  assert.equal(h.updates[0].record.capacity, null);
  assert.equal(Object.hasOwn(h.updates[0].record, 'recommendedCapacity'), false);
});

test('non-negative safe integer capacities include zero, values above 40, and independent recommended capacity', async t => {
  for (const [capacity, recommendedCapacity] of [['0', '200'], ['160', '180'], [String(Number.MAX_SAFE_INTEGER), '900']]) {
    await t.test(`${capacity}/${recommendedCapacity}`, async () => {
      const h = harness();
      h.run('editCurrentWorld()');
      h.input('worldEditCapacity', capacity);
      h.input('worldEditRecommendedCapacity', recommendedCapacity);
      assert.equal(await h.run('saveWorldEdit()'), true);
      assert.deepEqual(submitted(h)[0], { capacity: Number(capacity), recommendedCapacity: Number(recommendedCapacity) });
    });
  }
});

test('invalid changed capacities are rejected without API calls and leave the form usable', async t => {
  for (const id of ['worldEditCapacity', 'worldEditRecommendedCapacity']) {
    for (const value of ['-1', '1.5', '1e2', 'Infinity', 'NaN', '9007199254740992', '', ' ']) {
      await t.test(`${id}=${JSON.stringify(value)}`, async () => {
        const h = harness();
        h.run('editCurrentWorld()');
        h.input(id, value);
        assert.equal(await h.run('saveWorldEdit()'), false);
        assert.equal(h.requests.length, 0);
        assert.match(h.get('worldEditStatus').textContent, /non-negative safe integer/);
        assert.equal(h.get(id).value, value);
        assert.equal(h.get('btnSaveWorldEdit').disabled, false);
        assert.equal(h.get('worldEditModal').hidden, false);
      });
    }
  }
});

test('capacity blank remains optional when null and adding a capacity does not fill unknown recommended capacity', async () => {
  const initial = world({ capacity: null, recommendedCapacity: null });
  const h = harness(initial);
  h.setRoute((_path, options) => response({ ...initial, ...options.json }));
  h.run('editCurrentWorld()');
  h.input('worldEditCapacity', '96');
  assert.equal(await h.run('saveWorldEdit()'), true);
  assert.deepEqual(submitted(h)[0], { capacity: 96 });
});

test('blank name is blocked even when another field changes', async () => {
  const h = harness();
  h.run('editCurrentWorld()');
  h.input('worldEditName', '  \n  ');
  h.input('worldEditDescription', 'Changed');
  assert.equal(await h.run('saveWorldEdit()'), false);
  assert.equal(h.requests.length, 0);
  assert.match(h.get('worldEditStatus').textContent, /world name/);
});

test('keywords reject reserved and duplicate author prefixes; unknown originals are never silently replaced', async t => {
  for (const value of ['cozy,system_new', 'admin_new', 'SYSTEM_NEW', 'author_tag_new', 'author_tag_author_tag_new', 'cozy,evil\u0000tag']) {
    await t.test(value, async () => {
      const h = harness();
      h.run('editCurrentWorld()');
      h.input('worldEditTags', value);
      assert.equal(await h.run('saveWorldEdit()'), false);
      assert.equal(h.requests.length, 0);
      assert.match(h.get('worldEditStatus').textContent, /keywords only/);
    });
  }
  const h = harness(world({ tags: 'legacy-unknown-shape' }));
  h.run('editCurrentWorld()');
  h.input('worldEditTags', 'new');
  assert.equal(await h.run('saveWorldEdit()'), false);
  assert.match(h.get('worldEditStatus').textContent, /Original tags are unavailable/);
  assert.equal(h.requests.length, 0);
});

test('reordering author keywords is a dirty tag change while reserved entries stay in their original slots', async () => {
  const h = harness();
  h.run('editCurrentWorld()');
  h.input('worldEditTags', 'music, cozy');
  assert.equal(await h.run('saveWorldEdit()'), true);
  assert.deepEqual(submitted(h)[0], { tags: ['system_approved', 'author_tag_music', 'admin_featured', 'author_tag_cozy', 'unknown_legacy'] });
});

test('removing all author keywords preserves every non-author tag exactly', async () => {
  const initial = world({ tags: ['author_tag_cozy', 'system_x', 'author_tag_music', 'admin_x', 'legacy_tag', 'system_x'] });
  const h = harness(initial);
  h.setRoute((_path, options) => response({ ...initial, ...options.json }));
  h.run('editCurrentWorld()');
  h.input('worldEditTags', '');
  assert.equal(await h.run('saveWorldEdit()'), true);
  assert.deepEqual(submitted(h)[0], { tags: ['system_x', 'admin_x', 'legacy_tag', 'system_x'] });
});

test('only plain safe YouTube IDs or clearing are allowed', async t => {
  for (const value of ['https://youtu.be/dQw4w9WgXcQ', 'abc', 'dQw4w9WgXcQ?x', '<script>bad']) {
    await t.test(value, async () => {
      const h = harness();
      h.run('editCurrentWorld()');
      h.input('worldEditPreviewYoutubeId', value);
      assert.equal(await h.run('saveWorldEdit()'), false);
      assert.equal(h.requests.length, 0);
      assert.match(h.get('worldEditStatus').textContent, /YouTube video ID/);
    });
  }
  const h = harness();
  h.run('editCurrentWorld()');
  h.input('worldEditPreviewYoutubeId', '');
  assert.equal(await h.run('saveWorldEdit()'), true);
  assert.deepEqual(submitted(h)[0], { previewYoutubeId: '' });
});

test('URL list rejects non-http, relative, malformed, and credential-bearing URLs', async t => {
  for (const value of ['javascript:bad()', 'data:text/plain,bad', '/relative', 'https://', 'https://user:pass@example.test', 'https://user@example.test', 'ftp://example.test', 'https:example.test', 'https://example.test/with space', 'https://example.test/a\tb', 'https://example.test\nnot a URL']) {
    await t.test(value, async () => {
      const h = harness();
      h.run('editCurrentWorld()');
      h.input('worldEditUrlList', value);
      assert.equal(await h.run('saveWorldEdit()'), false);
      assert.equal(h.requests.length, 0);
      assert.match(h.get('worldEditStatus').textContent, /HTTP or HTTPS/);
    });
  }
  const h = harness();
  h.run('editCurrentWorld()');
  h.input('worldEditUrlList', '');
  assert.equal(await h.run('saveWorldEdit()'), true);
  assert.deepEqual(submitted(h)[0], { urlList: [] });
});

test('owner controls are hidden during loading/non-owner/stale or mismatched detail and do not set mobile display', async t => {
  const cases = {
    loading: h => h.run('updateWorldOwnerActions(currentWorldDetail, true)'),
    nonOwner: h => { h.run(`currentWorldDetail.authorId = ${JSON.stringify(OTHER)}`); return h.run('updateWorldOwnerActions(currentWorldDetail)'); },
    noAccount: h => { h.run('currentUserId = ""'); return h.run('updateWorldOwnerActions(currentWorldDetail)'); },
    domMismatch: h => { h.get('worldDetailId').textContent = B; return h.run('updateWorldOwnerActions(currentWorldDetail)'); },
    hidden: h => { h.get('worldDetailModal').hidden = true; return h.run('updateWorldOwnerActions(currentWorldDetail)'); },
    classHidden: h => { h.get('worldDetailModal').classList.add('hidden'); return h.run('updateWorldOwnerActions(currentWorldDetail)'); },
    displayHidden: h => { h.get('worldDetailModal').style.display = 'none'; return h.run('updateWorldOwnerActions(currentWorldDetail)'); },
    invalidId: h => { h.run('currentWorldDetail.id = "wrld_invalid"'); return h.run('updateWorldOwnerActions(currentWorldDetail)'); },
    invalidRecord: h => { h.run('currentWorldDetail.isInvalid = true'); return h.run('updateWorldOwnerActions(currentWorldDetail)'); },
    staleToken: h => { h.run('uiEpoch += 1'); return h.run('updateWorldOwnerActions(currentWorldDetail)'); },
    noToken: h => { h.run('window._worldDetailActiveToken = null'); return h.run('updateWorldOwnerActions(currentWorldDetail)'); },
    wrongTokenId: h => { h.run(`window._worldDetailActiveToken.id = ${JSON.stringify(B)}`); return h.run('updateWorldOwnerActions(currentWorldDetail)'); },
  };
  for (const [name, setup] of Object.entries(cases)) {
    await t.test(name, () => {
      const h = harness();
      assert.equal(h.run('updateWorldOwnerActions(currentWorldDetail)'), true);
      assert.equal(h.get('worldDetailOwnerActions').hidden, false);
      assert.equal(setup(h), false);
      assert.equal(h.get('worldDetailOwnerActions').hidden, true);
      assert.equal(h.get('worldDetailOwnerActions').classList.contains('hidden'), true);
      for (const id of ['worldDetailEditBtn', 'worldDetailDeleteBtn']) {
        assert.equal(h.get(id).hidden, true);
        assert.equal(h.get(id).disabled, true);
        assert.equal(h.get(id).style.display, undefined);
      }
      assert.equal(h.run('editCurrentWorld()'), name === 'loading');
    });
  }
});

test('management cannot start on a non-owner record or submit when owner/DOM ownership changes', async () => {
  const h = harness(world({ authorId: OTHER }));
  assert.equal(h.run('editCurrentWorld()'), false);
  assert.equal(h.run('deleteCurrentWorld()'), false);
  assert.equal(await h.run('confirmWorldDeletion()'), false);
  const owned = harness();
  owned.run('editCurrentWorld()');
  owned.input('worldEditName', 'Changed');
  owned.run(`currentWorldDetail.authorId = ${JSON.stringify(OTHER)}`);
  assert.equal(await owned.run('saveWorldEdit()'), false);
  assert.equal(owned.requests.length, 0);
  const deleting = harness();
  deleting.run('deleteCurrentWorld()');
  deleting.get('worldDeleteConfirmId').textContent = B;
  assert.equal(await deleting.run('confirmWorldDeletion()'), false);
  assert.equal(deleting.requests.length, 0);
});

test('PUT failures preserve form, show JSON error, and do not touch cards/selection/cache', async t => {
  for (const [status, body] of [[403, { error: { message: 'Owner denied' } }], [500, { error: 'Upstream failed' }], [200, { error: { message: 'Logical error' } }]]) {
    await t.test(String(status), async () => {
      const h = harness();
      h.setRoute(() => response(body, status));
      h.run('editCurrentWorld()');
      h.input('worldEditName', 'My retained text');
      assert.equal(await h.run('saveWorldEdit()'), false);
      assert.equal(h.get('worldEditName').value, 'My retained text');
      assert.equal(h.get('worldEditModal').hidden, false);
      assert.equal(h.get('btnSaveWorldEdit').disabled, false);
      assert.match(h.get('worldEditStatus').textContent, /Owner denied|Upstream failed|Logical error/);
      assert.equal(h.updates.length, 0);
      assert.equal(h.cacheWrites.length, 0);
      assert.equal(h.run('selectedWorldIds.has(currentWorldDetail.id)'), true);
    });
  }
});

test('empty, partial, wrong-ID, and unsafe PUT responses use fresh no-cache GET instead of optimistic form data', async t => {
  for (const body of [undefined, { id: A, name: 'partial', authorId: OWNER }, world({ id: B }), world({ authorId: OTHER }), world({ name: 'changed', capacity: -1 }), world({ urlList: { unsafe: true } }), world({ urlList: ['javascript:new()'] })]) {
    await t.test(JSON.stringify(body) || 'empty', async () => {
      const h = harness();
      h.setRoute((_path, options) => options.method === 'PUT' ? response(body) : response(world({ name: 'Fresh server record' })));
      h.run('editCurrentWorld()');
      h.input('worldEditName', 'Submitted name');
      assert.equal(await h.run('saveWorldEdit()'), true);
      assert.equal(h.requests.length, 2);
      assert.equal(h.requests[1].options.noCache, true);
      assert.equal(h.requests[1].options.noDedupe, true);
      assert.equal(h.updates[0].record.name, 'Fresh server record');
    });
  }
});

test('a wrong-ID or failing fresh GET never applies unsafe world data and preserves the editor with saved-refresh error', async t => {
  for (const fresh of [response(world({ id: B })), response({ error: { message: 'Refresh unavailable' } }, 503), response(world({ capacity: 'not-an-integer' }))]) {
    await t.test(String(fresh.status), async () => {
      const h = harness();
      h.setRoute((_path, options) => options.method === 'PUT' ? response(undefined) : fresh);
      h.run('editCurrentWorld()');
      h.input('worldEditName', 'Changed');
      assert.equal(await h.run('saveWorldEdit()'), false);
      assert.equal(h.updates.length, 0);
      assert.equal(h.get('worldEditModal').hidden, false);
      assert.match(h.get('worldEditStatus').textContent, /Saved, but refreshing/);
      assert.equal(h.get('worldEditName').value, 'Changed');
    });
  }
});

test('custom delete opens with escaped text and focus on cancel; cancel/reset never issue DELETE', async () => {
  const h = harness(world({ name: '<img src=x onerror=bad()>' }));
  assert.equal(h.run('deleteCurrentWorld()'), true);
  assert.equal(h.get('worldDeleteConfirmName').textContent, '<img src=x onerror=bad()>');
  assert.equal(h.get('worldDeleteConfirmId').textContent, A);
  assert.equal(h.get('btnCancelWorldDelete').focusCount, 1);
  assert.equal(h.requests.length, 0);
  h.run('closeWorldDeleteConfirm()');
  assert.equal(await h.run('confirmWorldDeletion()'), false);
  h.run('deleteCurrentWorld(); resetWorldManagementDialogs()');
  assert.equal(await h.run('confirmWorldDeletion()'), false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.deletions.length, 0);
  assert.equal(h.run('selectedWorldIds.has(currentWorldDetail.id)'), true);
  assert.equal(h.locks.count, 0);
});

test('successful empty DELETE is single-flight and supplies immutable captured category/selection/session guards', async () => {
  const h = harness();
  const pending = deferred();
  const observed = {};
  h.setRoute(() => pending.promise);
  h.onDelete(async (record, options) => {
    observed.record = record;
    observed.options = options;
    observed.guards = [options.isSessionCurrent(), options.isDetailCurrent(), options.isDialogCurrent(), options.isOperationCurrent()];
  });
  h.run('deleteCurrentWorld()');
  h.run('currentWorldCategory = "mine"; currentWorldDetail.name = "later mutation"');
  const first = h.run('confirmWorldDeletion()');
  assert.equal(h.get('btnConfirmWorldDelete').disabled, true);
  assert.equal(await h.run('confirmWorldDeletion()'), false);
  assert.equal(h.requests.length, 1);
  pending.resolve(response(undefined, 204, () => { throw new Error('Successful DELETE must not parse JSON'); }));
  assert.equal(await first, true);
  assert.deepEqual(observed.guards, [true, true, true, true]);
  assert.equal(observed.record.name, 'World A');
  assert.ok(Object.isFrozen(observed.record));
  assert.equal(observed.options.category, 'fav_worlds1');
  assert.equal(observed.options.selected, true);
  assert.equal(observed.options.operation, 'delete');
  assert.equal(observed.options.accountId, OWNER);
  assert.equal(observed.options.sessionToken.accountId, OWNER);
  assert.equal(observed.options.isDialogCurrent(), false);
  assert.equal(h.get('worldDeleteConfirmModal').hidden, true);
});

test('DELETE failure keeps confirm, card, selected ID and caches intact, then allows retry', async () => {
  const h = harness();
  h.setRoute(() => response({ error: { message: 'Cannot delete' } }, 403));
  h.run('deleteCurrentWorld()');
  assert.equal(await h.run('confirmWorldDeletion()'), false);
  assert.match(h.get('worldDeleteConfirmStatus').textContent, /Cannot delete/);
  assert.equal(h.get('worldDeleteConfirmModal').hidden, false);
  assert.equal(h.get('btnConfirmWorldDelete').disabled, false);
  assert.equal(h.deletions.length, 0);
  assert.equal(h.cacheWrites.length, 0);
  assert.equal(h.run('allWorlds.length'), 1);
  assert.equal(h.run('selectedWorldIds.has(currentWorldDetail.id)'), true);
  h.setRoute(() => response(undefined, 200));
  assert.equal(await h.run('confirmWorldDeletion()'), true);
  assert.equal(h.run(`selectedWorldIds.has(${JSON.stringify(A)})`), false);
  assert.equal(h.run('allWorlds.length'), 0);
  assert.equal(h.cacheWrites[0].key, 'world_basics_v2_fav_worlds1');
  assert.equal(h.get('worldDetailModal').classList.contains('hidden'), true);
});

test('changing detail invalidates an unconfirmed delete even without reset; it never targets B', async () => {
  const h = harness();
  h.run('deleteCurrentWorld()');
  h.switchDetail(world({ id: B, name: 'World B' }), false);
  assert.equal(await h.run('confirmWorldDeletion()'), false);
  assert.equal(h.requests.length, 0);
  assert.match(h.get('worldDeleteConfirmStatus').textContent, /world or account changed/);
  h.run('resetWorldManagementDialogs()');
  assert.equal(await h.run('confirmWorldDeletion()'), false);
  assert.equal(h.get('worldDeleteConfirmModal').hidden, true);
});

test('double save is single-flight and shared world lock prevents edit/delete overlap across dialog resets', async () => {
  const h = harness();
  const pending = deferred();
  h.setRoute(() => pending.promise);
  h.run('editCurrentWorld()');
  h.input('worldEditName', 'Changed');
  const first = h.run('saveWorldEdit()');
  assert.equal(await h.run('saveWorldEdit()'), false);
  assert.equal(h.requests.length, 1);
  h.run('resetWorldManagementDialogs(); deleteCurrentWorld()');
  assert.equal(h.get('btnConfirmWorldDelete').disabled, true);
  assert.equal(await h.run('confirmWorldDeletion()'), false);
  assert.equal(h.requests.length, 1);
  pending.resolve(response(world({ name: 'Changed' })));
  assert.equal(await first, true);
  assert.equal(h.get('worldDeleteConfirmModal').hidden, false, 'edit success cannot close a newer deletion dialog');
  assert.equal(h.get('btnConfirmWorldDelete').disabled, false);
  assert.equal(h.deletions.length, 0);
});

test('pending DELETE blocks PUT on the same world after reopening the editor', async () => {
  const h = harness();
  const pending = deferred();
  h.setRoute(() => pending.promise);
  h.run('deleteCurrentWorld()');
  const deletion = h.run('confirmWorldDeletion()');
  h.run('resetWorldManagementDialogs(); editCurrentWorld()');
  h.input('worldEditName', 'Changed');
  assert.equal(h.get('btnSaveWorldEdit').disabled, true);
  assert.equal(await h.run('saveWorldEdit()'), false);
  assert.equal(h.requests.length, 1);
  pending.resolve(response({ error: 'Failed delete' }, 500));
  assert.equal(await deletion, false);
  assert.equal(h.get('worldEditModal').hidden, false);
  assert.equal(h.get('btnSaveWorldEdit').disabled, false);
  assert.equal(h.get('worldEditStatus').textContent.includes('Failed delete'), false, 'old failure cannot repaint newer editor');
});

test('closing A then opening editor B still synchronizes A, never repaints or closes B, and keeps B busy', async () => {
  const h = harness();
  const aResponse = deferred();
  const bResponse = deferred();
  h.setRoute(path => path.endsWith(A) ? aResponse.promise : bResponse.promise);
  h.run('editCurrentWorld()');
  h.input('worldEditName', 'A changed');
  const savingA = h.run('saveWorldEdit()');
  h.switchDetail();
  h.run('currentWorldCategory = "mine"; editCurrentWorld()');
  h.input('worldEditName', 'B retained form');
  const savingB = h.run('saveWorldEdit()');
  const bStatus = h.get('worldEditStatus').textContent;
  aResponse.resolve(response(world({ name: 'A authoritative' })));
  assert.equal(await savingA, true);
  assert.equal(h.updates[0].record.id, A);
  assert.equal(h.updates[0].options.category, 'fav_worlds1');
  assert.equal(h.updates[0].options.isSessionCurrent(), true);
  assert.equal(h.updates[0].options.isDetailCurrent(), false);
  assert.equal(h.updates[0].options.isDialogCurrent(), false);
  assert.equal(h.get('worldEditModal').hidden, false);
  assert.equal(h.get('worldEditId').textContent, B);
  assert.equal(h.get('worldEditName').value, 'B retained form');
  assert.equal(h.get('worldDetailName').textContent, 'World B');
  assert.equal(h.get('worldEditStatus').textContent, bStatus);
  assert.equal(h.get('btnSaveWorldEdit').disabled, true, 'A finally cannot unlock B flight');
  assert.equal(await h.run('saveWorldEdit()'), false);
  assert.equal(h.requests.length, 2);
  bResponse.resolve(response(world({ id: B, name: 'B authoritative' })));
  assert.equal(await savingB, true);
  assert.ok(h.updates[1].options.dialogGeneration > h.updates[0].options.dialogGeneration);
  assert.equal(h.get('worldDetailName').textContent, 'B authoritative');
  assert.equal(h.get('worldEditModal').hidden, true);
});

test('owner header actions reenable only after their same-session mutation flight is released', async () => {
  const h = harness();
  const entered = deferred();
  const resume = deferred();
  h.onUpdate(async () => {
    h.run('updateWorldOwnerActions(currentWorldDetail)');
    assert.equal(h.get('worldDetailEditBtn').disabled, true);
    assert.equal(h.get('worldDetailDeleteBtn').disabled, true);
    entered.resolve();
    await resume.promise;
  });
  h.run('editCurrentWorld()');
  h.input('worldEditName', 'Changed');
  const saving = h.run('saveWorldEdit()');
  await entered.promise;
  resume.resolve();
  assert.equal(await saving, true);
  assert.equal(h.get('worldDetailEditBtn').disabled, false);
  assert.equal(h.get('worldDetailDeleteBtn').disabled, false);
  assert.equal(h.get('worldDetailOwnerActions').hidden, false);
});

test('late edit success cannot close a reopened editor of the same world', async () => {
  const h = harness();
  const pending = deferred();
  h.setRoute(() => pending.promise);
  h.run('editCurrentWorld()');
  h.input('worldEditName', 'Old save');
  const saving = h.run('saveWorldEdit()');
  h.run('closeWorldEditModal(); editCurrentWorld()');
  h.input('worldEditName', 'New draft');
  assert.equal(h.get('btnSaveWorldEdit').disabled, true);
  pending.resolve(response(world({ name: 'Old save server' })));
  assert.equal(await saving, true);
  assert.equal(h.get('worldEditModal').hidden, false);
  assert.equal(h.get('worldEditName').value, 'New draft');
  assert.equal(h.get('btnSaveWorldEdit').disabled, false);
  assert.equal(h.updates[0].options.isDialogCurrent(), false);
});

test('late DELETE success updates A only; it cannot close B or B confirmation', async () => {
  const h = harness();
  const pending = deferred();
  h.setRoute(() => pending.promise);
  h.run('deleteCurrentWorld()');
  const deletingA = h.run('confirmWorldDeletion()');
  h.switchDetail();
  h.run('deleteCurrentWorld()');
  pending.resolve(response(undefined, 200));
  assert.equal(await deletingA, true);
  assert.equal(h.deletions[0].record.id, A);
  assert.equal(h.run(`selectedWorldIds.has(${JSON.stringify(A)})`), false);
  assert.equal(h.get('worldDetailName').textContent, 'World B');
  assert.equal(h.get('worldDetailModal').classList.contains('hidden'), false);
  assert.equal(h.get('worldDeleteConfirmModal').hidden, false);
  assert.equal(h.get('worldDeleteConfirmId').textContent, B);
  assert.equal(h.deletions[0].options.isDetailCurrent(), false);
  assert.equal(h.deletions[0].options.isDialogCurrent(), false);
});

test('cancelling an already-dispatched deletion does not undo it but never closes the current detail', async () => {
  const h = harness();
  const pending = deferred();
  h.setRoute(() => pending.promise);
  h.run('deleteCurrentWorld()');
  const deleting = h.run('confirmWorldDeletion()');
  h.run('closeWorldDeleteConfirm()');
  pending.resolve(response(undefined));
  assert.equal(await deleting, true);
  assert.equal(h.deletions.length, 1);
  assert.equal(h.deletions[0].options.isDetailCurrent(), true);
  assert.equal(h.deletions[0].options.isDialogCurrent(), false);
  assert.equal(h.get('worldDetailModal').classList.contains('hidden'), false);
  assert.equal(h.run(`selectedWorldIds.has(${JSON.stringify(A)})`), false);
});

test('late DELETE cannot close a reopened confirmation on the same detail token', async () => {
  const h = harness();
  const pending = deferred();
  h.setRoute(() => pending.promise);
  h.run('deleteCurrentWorld()');
  const deleting = h.run('confirmWorldDeletion()');
  h.run('closeWorldDeleteConfirm(); deleteCurrentWorld()');
  pending.resolve(response(undefined));
  assert.equal(await deleting, true);
  assert.equal(h.deletions[0].options.isDetailCurrent(), true);
  assert.equal(h.deletions[0].options.isDialogCurrent(), false);
  assert.equal(h.get('worldDeleteConfirmModal').hidden, false);
  assert.equal(h.get('worldDetailModal').classList.contains('hidden'), false);
  assert.equal(h.get('btnConfirmWorldDelete').disabled, true, 'known deleted world cannot be reconfirmed');
  assert.match(h.get('worldDeleteConfirmStatus').textContent, /world or account changed/);
  assert.equal(await h.run('confirmWorldDeletion()'), false);
  assert.equal(h.requests.length, 1);
  assert.equal(h.run('editCurrentWorld()'), false);
  assert.equal(h.run('deleteCurrentWorld()'), false);
  assert.equal(h.get('worldDetailOwnerActions').hidden, true);
});

test('successful deletion followed by synchronization failure cannot be retried in the same dialog', async () => {
  const h = harness();
  h.onDelete(() => { throw new Error('Simulated cache warning'); });
  h.run('deleteCurrentWorld()');
  assert.equal(await h.run('confirmWorldDeletion()'), false);
  const errorText = h.get('worldDeleteConfirmStatus').textContent;
  assert.match(errorText, /Deleted, but.*Simulated cache warning/);
  assert.equal(h.get('btnConfirmWorldDelete').disabled, true);
  assert.equal(await h.run('confirmWorldDeletion()'), false);
  assert.equal(h.get('worldDeleteConfirmStatus').textContent, errorText, 'committed-sync error remains visible');
  assert.equal(h.requests.length, 1);
  assert.equal(h.run('editCurrentWorld()'), false);
  assert.equal(h.run('deleteCurrentWorld()'), false);
  assert.equal(h.run('updateWorldOwnerActions(currentWorldDetail)'), false);
});

test('successful deletion protects a newer same-world editor from PUT even if the delete hook fails', async () => {
  const h = harness();
  const pending = deferred();
  h.setRoute(() => pending.promise);
  h.onDelete(() => { throw new Error('Simulated cache warning'); });
  h.run('deleteCurrentWorld()');
  const deleting = h.run('confirmWorldDeletion()');
  h.run('closeWorldDeleteConfirm(); editCurrentWorld()');
  h.input('worldEditName', 'New draft');
  pending.resolve(response(undefined));
  assert.equal(await deleting, false);
  assert.equal(h.get('worldEditModal').hidden, false);
  assert.equal(h.get('worldEditName').value, 'New draft');
  assert.equal(h.get('btnSaveWorldEdit').disabled, true);
  assert.match(h.get('worldEditStatus').textContent, /world or account changed/);
  assert.equal(await h.run('saveWorldEdit()'), false);
  assert.equal(h.requests.length, 1);
});

test('committed deletion marker blocks initiation during synchronization but leaves original callback guards current', async () => {
  const h = harness();
  const entered = deferred();
  const resume = deferred();
  h.onDelete(async (_record, options) => {
    assert.equal(options.isDetailCurrent(), true);
    assert.equal(options.isDialogCurrent(), true);
    entered.resolve();
    await resume.promise;
  });
  h.run('deleteCurrentWorld()');
  const deleting = h.run('confirmWorldDeletion()');
  await entered.promise;
  assert.equal(h.run('editCurrentWorld()'), false);
  assert.equal(h.run('deleteCurrentWorld()'), false);
  assert.equal(await h.run('confirmWorldDeletion()'), false);
  assert.equal(h.requests.length, 1);
  resume.resolve();
  assert.equal(await deleting, true);
});

test('committed deletion markers are ignored after an auth epoch changes even for the same account', async () => {
  const h = harness();
  h.onDelete(() => { throw new Error('Simulated cache warning'); });
  h.run('deleteCurrentWorld()');
  assert.equal(await h.run('confirmWorldDeletion()'), false);
  assert.equal(h.run('editCurrentWorld()'), false);
  h.switchAccount(OWNER);
  h.switchDetail(world());
  assert.equal(h.run('updateWorldOwnerActions(currentWorldDetail)'), true);
  assert.equal(h.run('editCurrentWorld()'), true);
  h.input('worldEditName', 'Fresh session');
  assert.equal(await h.run('saveWorldEdit()'), true);
  assert.equal(h.requests.length, 2);
});

test('account switch before confirmation or during mutation prevents old cache/DOM/selection side effects', async t => {
  await t.test('before confirmation', async () => {
    const h = harness();
    h.run('deleteCurrentWorld()');
    h.switchAccount(OTHER, false);
    assert.equal(await h.run('confirmWorldDeletion()'), false);
    assert.equal(h.requests.length, 0);
  });
  for (const operation of ['edit', 'delete']) {
    await t.test(operation, async () => {
      const h = harness();
      const pending = deferred();
      h.setRoute(() => pending.promise);
      h.run(operation === 'edit' ? 'editCurrentWorld()' : 'deleteCurrentWorld()');
      if (operation === 'edit') h.input('worldEditName', 'Changed');
      const result = h.run(operation === 'edit' ? 'saveWorldEdit()' : 'confirmWorldDeletion()');
      h.switchAccount();
      h.switchDetail(world({ id: B, name: 'Other account B', authorId: OTHER }));
      pending.resolve(operation === 'edit' ? response(world({ name: 'old' })) : response(undefined));
      assert.equal(await result, false);
      assert.equal(h.updates.length + h.deletions.length, 0);
      assert.equal(h.cacheWrites.length, 0);
      assert.equal(h.get('worldDetailName').textContent, 'Other account B');
      assert.equal(h.run(`selectedWorldIds.has(${JSON.stringify(A)})`), true);
    });
  }
});

test('account switch during PUT JSON parsing or fresh GET prevents callbacks and further old-session fetches', async t => {
  for (const stage of ['json', 'get']) {
    await t.test(stage, async () => {
      const h = harness();
      const pending = deferred();
      const entered = deferred();
      h.setRoute((_path, options) => {
        if (options.method === 'PUT') return stage === 'json'
          ? response(undefined, 200, () => { entered.resolve(); return pending.promise; })
          : response(undefined);
        entered.resolve();
        return pending.promise;
      });
      h.run('editCurrentWorld()');
      h.input('worldEditName', 'Changed');
      const saving = h.run('saveWorldEdit()');
      await entered.promise;
      h.switchAccount();
      pending.resolve(stage === 'json' ? world({ name: 'Late JSON' }) : response(world({ name: 'Late GET' })));
      assert.equal(await saving, false);
      assert.equal(h.updates.length, 0);
      assert.equal(h.cacheWrites.length, 0);
      assert.equal(h.requests.length, stage === 'json' ? 1 : 2);
    });
  }
});

test('old account finally cannot unlock a newer account flight on the same world', async () => {
  const h = harness();
  const oldResponse = deferred();
  const newResponse = deferred();
  let count = 0;
  h.setRoute(() => ++count === 1 ? oldResponse.promise : newResponse.promise);
  h.run('editCurrentWorld()');
  h.input('worldEditName', 'Old draft');
  const oldSave = h.run('saveWorldEdit()');
  h.switchAccount(OWNER); // Even returning to the same account has a new epoch.
  h.switchDetail(world());
  h.run('editCurrentWorld()');
  h.input('worldEditName', 'New session draft');
  const newSave = h.run('saveWorldEdit()');
  oldResponse.resolve(response(world({ name: 'Old response' })));
  assert.equal(await oldSave, false);
  assert.equal(h.get('btnSaveWorldEdit').disabled, true);
  assert.equal(await h.run('saveWorldEdit()'), false);
  assert.equal(h.requests.length, 2);
  newResponse.resolve(response(world({ name: 'New response' })));
  assert.equal(await newSave, true);
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].record.name, 'New response');
});

test('callback is awaited; its live guards prevent stale IDB writes and stale success-close after an await', async () => {
  const h = harness();
  const entered = deferred();
  const resume = deferred();
  h.onUpdate(async (record, options) => {
    assert.equal(options.isDialogCurrent(), true);
    entered.resolve();
    await resume.promise;
    await h.context.idb.set('simulated-delayed', record, options.sessionToken);
    if (!options.isSessionCurrent()) return;
    h.get('worldDetailName').textContent = 'must not happen';
  });
  h.run('editCurrentWorld()');
  h.input('worldEditName', 'Changed');
  const saving = h.run('saveWorldEdit()');
  await entered.promise;
  assert.equal(h.get('btnSaveWorldEdit').disabled, true);
  h.switchAccount();
  h.switchDetail(world({ id: B, name: 'New account detail', authorId: OTHER }));
  h.run('editCurrentWorld()');
  resume.resolve();
  assert.equal(await saving, false);
  assert.equal(h.cacheWrites.length, 0);
  assert.equal(h.get('worldEditModal').hidden, false);
  assert.equal(h.get('worldDetailName').textContent, 'New account detail');
});

test('missing integration hooks block writes and hook failures are accurately reported without closing forms', async t => {
  for (const operation of ['edit', 'delete']) {
    await t.test(operation, async () => {
      const h = harness();
      h.run(operation === 'edit' ? 'editCurrentWorld()' : 'deleteCurrentWorld()');
      if (operation === 'edit') h.input('worldEditName', 'Changed');
      const hookName = operation === 'edit' ? 'applyWorldManagementUpdate' : 'applyWorldManagementDelete';
      const hook = h.context[hookName];
      h.context[hookName] = undefined;
      assert.equal(await h.run(operation === 'edit' ? 'saveWorldEdit()' : 'confirmWorldDeletion()'), false);
      assert.equal(h.requests.length, 0);
      h.context[hookName] = hook;
      if (operation === 'edit') h.onUpdate(() => { throw new Error('Simulated sync failure'); });
      else h.onDelete(() => { throw new Error('Simulated sync failure'); });
      assert.equal(await h.run(operation === 'edit' ? 'saveWorldEdit()' : 'confirmWorldDeletion()'), false);
      assert.match(h.get(operation === 'edit' ? 'worldEditStatus' : 'worldDeleteConfirmStatus').textContent, /Saved, but|Deleted, but/);
      assert.equal(h.get(operation === 'edit' ? 'worldEditModal' : 'worldDeleteConfirmModal').hidden, false);
    });
  }
});

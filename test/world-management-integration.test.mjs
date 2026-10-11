import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const worldsSource = read('../public/js/worlds.js');
const shellSource = read('../public/js/worlds-shell.js');
const sharedShellSource = read('../public/js/shell.js');
const managementSource = read('../public/js/world-management.js');
const html = read('../public/index.html');
const css = read('../public/style.css');
const start = worldsSource.indexOf('function _worldManagementIsCurrent(');
const end = worldsSource.indexOf('// ── Cache Management Modal', start);
assert.ok(start >= 0 && end > start, 'execute the exact worlds.js integration section');
const integrationSource = worldsSource.slice(start, end);
const usesLocalIds = integrationSource.includes('localWorldFavIds');
function declaration(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `actual application declares ${name}`);
  const open = source.indexOf('{', match.index + match[0].length);
  assert.ok(open >= 0, `${name} has a function body`);
  let depth = 0;
  let state = 'code';
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'line-comment') {
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') { state = 'code'; index += 1; }
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if ((state === 'single' && char === "'") || (state === 'double' && char === '"')
          || (state === 'template' && char === '`')) state = 'code';
      continue;
    }
    if (char === '/' && next === '/') { state = 'line-comment'; index += 1; continue; }
    if (char === '/' && next === '*') { state = 'block-comment'; index += 1; continue; }
    if (char === "'") { state = 'single'; continue; }
    if (char === '"') { state = 'double'; continue; }
    if (char === '`') { state = 'template'; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(match.index, index + 1);
  }
  assert.fail(`${name} function body is unbalanced`);
}

const A = 'wrld_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'wrld_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const C = 'wrld_cccccccc-cccc-cccc-cccc-cccccccccccc';
const OWNER = 'usr_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'usr_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PREFIX = 'world_basics_v2_';
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function world(id = A, overrides = {}) {
  return {
    id, authorId: OWNER, authorName: 'Fake owner', name: id === A ? 'World A' : 'World B',
    description: 'Original description', capacity: 80, recommendedCapacity: 40,
    tags: ['system_approved', 'author_tag_cozy'], previewYoutubeId: 'dQw4w9WgXcQ',
    urlList: ['https://example.test/info'], releaseStatus: 'private', version: 7,
    thumbnailImageUrl: 'https://example.test/old.png', imageUrl: 'https://example.test/full.png',
    unityPackages: [{ platform: 'standalonewindows' }], updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}
function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300, status,
    async json() {
      assert.notEqual(body, undefined, 'a successful empty DELETE must not parse JSON');
      return copy(body);
    },
  };
}

// The fake DOM records every write, including same-value writes. This makes a
// post-account-switch no-write assertion stronger than comparing final text.
class Element {
  constructor(id, writes, hidden = false) {
    this.id = id;
    this.writes = writes;
    this.attributes = {};
    this.dataset = {};
    this.children = new Map();
    this.removed = false;
    this.classes = new Set(hidden ? ['hidden'] : []);
    this.classList = {
      contains: value => this.classes.has(value),
      add: (...values) => { values.forEach(value => this.classes.add(value)); writes.push(['class.add', id, values]); },
      remove: (...values) => { values.forEach(value => this.classes.delete(value)); writes.push(['class.remove', id, values]); },
      toggle: (value, force) => {
        const next = force ?? !this.classes.has(value);
        next ? this.classes.add(value) : this.classes.delete(value);
        writes.push(['class.toggle', id, value, next]);
        return next;
      },
    };
    this.style = new Proxy({}, { set(target, key, value) { writes.push(['style', id, key, value]); target[key] = value; return true; } });
    for (const [key, initial] of Object.entries({ hidden, disabled: false, value: '', textContent: '', innerHTML: '', title: '', onclick: null })) {
      let stored = initial;
      Object.defineProperty(this, key, {
        enumerable: true, get: () => stored,
        set: value => { writes.push([key, id, typeof value === 'function' ? '[handler]' : value]); stored = value; },
      });
    }
  }
  setAttribute(key, value) { this.writes.push(['attribute', this.id, key, String(value)]); this.attributes[key] = String(value); }
  removeAttribute(key) { this.writes.push(['removeAttribute', this.id, key]); delete this.attributes[key]; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  querySelector(selector) { return this.children.get(selector) || null; }
  focus() { this.writes.push(['focus', this.id]); }
  remove() { this.writes.push(['remove', this.id]); this.removed = true; }
  snapshot() {
    return {
      hidden: this.hidden, disabled: this.disabled, value: this.value, text: this.textContent,
      html: this.innerHTML, title: this.title, classes: [...this.classes].sort(),
      attributes: { ...this.attributes }, style: { ...this.style }, removed: this.removed,
    };
  }
}

function harness() {
  const writes = [];
  const effects = [];
  const requests = [];
  const callbacks = [];
  const idbCalls = [];
  const commits = [];
  const buckets = new Map();
  const elements = new Map();
  const ids = [
    'worldDetailModal', 'worldDetailId', 'worldDetailName', 'worldDetailBreadcrumbName',
    'worldDetailDesc', 'worldDetailDescRow', 'worldDetailUpdated', 'worldDetailRawJson',
    'worldDetailBadges', 'worldDetailTags', 'worldDetailOwnerActions', 'worldDetailEditBtn',
    'worldDetailDeleteBtn', 'worldDetailDownloadBtn', 'worldDetailMobileDownloadBtn',
    'worldEditModal', 'worldEditId', 'worldEditName', 'worldEditDescription',
    'worldEditCapacity', 'worldEditRecommendedCapacity', 'worldEditTags',
    'worldEditPreviewYoutubeId', 'worldEditUrlList', 'worldEditReleaseStatus',
    'worldEditStatus', 'btnSaveWorldEdit', 'worldDeleteConfirmModal',
    'worldDeleteConfirmName', 'worldDeleteConfirmId', 'worldDeleteConfirmStatus',
    'btnConfirmWorldDelete', 'btnCancelWorldDelete', 'worldStats', 'btnWorldSelectAll',
    'btnWorldCleanInvalid', 'btnWorldUnfavoriteSelected', 'btnWorldDownloadSelected',
    'worldSearch', 'worldFilterPlatform', 'worldGrid', 'worldFavGroupList', 'worldFavMenu',
  ];
  for (const id of ids) elements.set(id, new Element(id, writes, ['worldEditModal', 'worldDeleteConfirmModal', 'worldDetailOwnerActions', 'worldFavMenu'].includes(id)));
  const searchCards = [A, B].map(id => {
    const card = new Element('search-' + id, writes);
    card.dataset.worldid = id;
    card.children.set('.avatar-name-overlay', new Element('search-name-' + id, writes));
    card.children.set('.avatar-thumb', new Element('search-image-' + id, writes));
    card.querySelector('.avatar-name-overlay').textContent = world(id).name;
    return card;
  });
  const localButtons = [A, B].map(id => {
    const button = new Element('local-' + id, writes);
    button.dataset.localWorldFav = id;
    return button;
  });
  const get = id => elements.get(id);
  get('worldDetailModal').dataset.scrollLocked = '1';
  get('worldDetailId').textContent = A;
  get('worldDetailName').textContent = 'World A';
  get('worldDetailDesc').textContent = 'Original description';
  get('worldDetailRawJson').textContent = JSON.stringify(world());
  get('worldFilterPlatform').value = 'all';
  let localDevice = [world(A, { localFavorite: true, deviceNote: 'keep A' }), world(B, { localFavorite: true, deviceNote: 'keep B' })];
  const initialCache = new Map([
    [PREFIX + 'fav_worlds1', [world(A, { favoriteId: 'favorite-cache-1-A' }), world(B, { favoriteId: 'favorite-cache-1-B' })]],
    [PREFIX + 'fav_worlds2', [world(A, { favoriteId: 'favorite-cache-2-A' }), world(B, { favoriteId: 'favorite-cache-2-B' })]],
    [PREFIX + 'mine', [world(A, { favoriteId: null }), world(B, { favoriteId: null })]],
    [PREFIX + 'recent', [world(B, { favoriteId: null })]],
    [PREFIX + 'empty', []], [PREFIX + 'malformed', { keep: true }],
    ['world_basics_age_fav_worlds1', 11], ['world_basics_age_fav_worlds2', 22],
    ['world_basics_age_mine', 33], ['world_basics_age_recent', 44],
    ['world_name_cache', { [A]: 'World A', [B]: 'World B' }], ['unrelated_cache', { untouched: true }],
  ]);
  buckets.set(OWNER, initialCache);
  buckets.set(OTHER, new Map([[PREFIX + 'mine', [world(A, { name: 'New account A', authorId: OTHER }), world(B, { name: 'New account B', authorId: OTHER })]], ['world_name_cache', { [A]: 'New account A', [B]: 'New account B' }]]));
  let context;
  const run = source => vm.runInContext(source, context);
  const current = token => !!token && token.epoch === run('sessionEpoch') && token.accountId === run('currentUserId');
  const storage = token => buckets.get(token.accountId);
  let idbHook = null;
  let route = (path, options) => response(options.method === 'DELETE' ? undefined : world(path.endsWith(A) ? A : B, { ...options.json }), options.method === 'DELETE' ? 204 : 200);
  const boundary = (method, key, token, value) => {
    if (method !== 'getLocalWorlds') {
      assert.ok(token && typeof token.accountId === 'string', `${method} must receive the captured session token explicitly`);
    }
    const call = { method, key, token, value: copy(value) };
    idbCalls.push(call);
    return call;
  };
  const pause = async call => { if (idbHook) await idbHook(call); };
  let locks = 1;
  let rendered = [];
  context = vm.createContext({
    console, URL,
    document: {
      getElementById: id => elements.get(id) || null,
      querySelectorAll(selector) {
        if (selector === '#avtrdbGrid [data-worldid]') return searchCards.filter(card => !card.removed);
        if (selector === '[data-local-world-fav]') return localButtons;
        throw new Error('Unexpected DOM query: ' + selector);
      },
    },
    fetch() { throw new Error('Real network is forbidden.'); },
    logout() { throw new Error('Real credentials/authentication are forbidden.'); },
    VRCW: { modules: {}, registerModule(name, module) { this.modules[name] = Object.freeze({ ...module }); } },
    async apiCall(path, options = {}) {
      assert.match(path, /^\/api\/vrc\/worlds\/wrld_[a-f0-9-]{36}$/i);
      assert.ok(['PUT', 'DELETE', undefined].includes(options.method));
      assert.equal(options.noAbort, true);
      assert.equal(options.noCache, true);
      assert.equal(options.noDedupe, true);
      requests.push({ path, options: copy(options) });
      return route(path, options);
    },
    idb: {
      async keys(token) {
        const call = boundary('keys', null, token);
        const result = [...storage(token).keys()];
        await pause(call);
        return result;
      },
      async get(key, token) {
        const call = boundary('get', key, token);
        const result = copy(storage(token).get(key));
        await pause(call);
        // Deliberately return the captured old data even after a session switch:
        // the integration helper, not a forgiving fake, must reject the result.
        return result;
      },
      async set(key, value, token) {
        const call = boundary('set', key, token, value);
        await pause(call);
        if (!current(token)) return;
        storage(token).set(key, copy(value));
        commits.push(call);
      },
      async getLocalWorlds() {
        const call = boundary('getLocalWorlds', null, null);
        const result = copy(localDevice); // Device-wide store is intentionally not account-scoped.
        await pause(call);
        return result;
      },
      async saveLocalWorld(record, token) {
        const call = boundary('saveLocalWorld', record.id, token, record);
        await pause(call);
        if (!current(token)) return;
        localDevice = localDevice.map(item => item.id === record.id ? copy(record) : item);
        commits.push(call);
      },
      async removeLocalWorld(id, token) {
        const call = boundary('removeLocalWorld', id, token);
        await pause(call);
        if (!current(token)) return;
        localDevice = localDevice.filter(item => item.id !== id);
        commits.push(call);
      },
    },
    t(key, values = {}) { return key + (Object.keys(values).length ? '(' + Object.values(values).join(',') + ')' : ''); },
    escHtml: value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    escJsAttr: value => String(value).replace(/'/g, '\\u0027'),
    formatDate: value => 'formatted:' + value,
    makeCatBtn: (label, action, id) => `<button id="${id}" data-action="${action}">${label}</button>`,
    renderWorldGrid(records) { rendered = copy(records); effects.push(['renderWorldGrid', copy(records)]); get('worldGrid').textContent = records.map(item => item.name).join('|'); },
    loadImage(element, url) { effects.push(['loadImage', element.id, url]); element.setAttribute('src', url); },
    disposeImages(card) { effects.push(['disposeImages', card.dataset.worldid]); },
    updateWorldDownloadButtons(record) { effects.push(['downloadButtons', copy(record)]); },
    cancelWorldDownloads(...args) { effects.push(['cancelDownloads', ...args]); },
    cancelScopedAbort(scope) { effects.push(['cancelScope', scope]); },
    bumpUiEpoch() { run('uiEpoch += 1'); },
    modalZTop: () => 3100,
    lockBodyScroll() { locks += 1; },
    unlockBodyScroll() { locks -= 1; assert.ok(locks >= 0, 'dialog/detail scroll locks balance'); },
    showToast(...args) { effects.push(['toast', ...args]); },
    toggleWorldFavMenu() { throw new Error('No unrelated favorite mutation is permitted.'); },
    openWorldDetail(id, record) { effects.push(['openDetail', id, copy(record)]); },
  });
  vm.runInContext(`
    window = globalThis;
    let currentUserId = ${JSON.stringify(OWNER)};
    let sessionEpoch = 1;
    let uiEpoch = 1;
    let currentWorldDetail = ${JSON.stringify(world(A, { favoriteId: 'favorite-detail-A' }))};
    let allWorlds = ${JSON.stringify([world(A, { favoriteId: 'favorite-list-A', listNote: 'keep list metadata' }), world(B, { favoriteId: 'favorite-list-B' })])};
    let selectedWorldIds = new Set(${JSON.stringify([A, B])});
    let worldFavoriteIdMap = new Map(${JSON.stringify([[A, 'favorite-list-A'], [B, 'favorite-list-B']])});
    let worldNameCache = new Map(${JSON.stringify([[A, 'World A'], [B, 'World B']])});
    let currentWorldCategory = 'fav_worlds1';
    const WORLD_CACHE_PREFIX = ${JSON.stringify(PREFIX)};
    let currentWorldFetchSeq = 10;
    let localWorldFavs = ${JSON.stringify(localDevice)};
    let localWorldFavIds = new Set(localWorldFavs.map(item => item.id));
    let localWorldIdMap = new Map(localWorldFavs.map(item => [item.id, true]));
    let worldLocalFavoritesCount = localWorldFavs.length;
    let worldFavGroups = [{ name: 'worlds1', displayName: 'Fake favorites' }];
    let worldFavGroupCounts = new Map([['worlds1', 2]]);
    let myProfileData = null;
    let _worldDownloadTask = null;
    let worldsLoaded = true;
    let vrcAuth = true; // Boolean fake only; never a cookie, token, or credential.
    function makeAuthSessionToken() { return Object.freeze({ epoch: sessionEpoch, accountId: currentUserId, bucket: 'fake-' + currentUserId }); }
    function isAuthSessionCurrent(token) { return !!token && token.epoch === sessionEpoch && token.accountId === currentUserId; }
    function isUiTokenCurrent(token) { return !!token && token === window._worldDetailActiveToken && token.epoch === uiEpoch; }
    window._worldDetailActiveToken = Object.freeze({ id: currentWorldDetail.id, epoch: uiEpoch });
  `, context);
  const dependencies = [
    declaration(sharedShellSource, '_worldBasicFromItem'),
    declaration(worldsSource, '_saveWorldBasicsForCurrentCategory'),
    ...['_worldBasicForWorldsCache', '_normalizeWorldPlatform', '_getWorldPlatforms', 'filterWorlds', '_updateWorldActionBtns', 'closeWorldDetail', 'renderWorldFavGroupButtons', '_refreshWorldFavoriteMenuState'].map(name => declaration(worldsSource, name)),
    ...(usesLocalIds
      ? [declaration(worldsSource, '_syncLocalWorldFavoriteUI'), declaration(shellSource, 'loadWorldLocalFavoritesCount')]
      : [declaration(worldsSource, 'syncWorldLocalFavoriteButtons'), declaration(worldsSource, '_refreshWorldLocalFavoriteButton')]),
  ];
  vm.runInContext(dependencies.join('\n') + '\n' + integrationSource, context, { filename: 'worlds.js actual management integration' });
  for (const [operation, name] of [['edit', 'applyWorldManagementUpdate'], ['delete', 'applyWorldManagementDelete']]) {
    const implementation = context[name];
    context[name] = (record, options) => {
      callbacks.push({ operation, record, options });
      return implementation(record, options); // Instrumentation only: never a replacement implementation.
    };
  }
  vm.runInContext(managementSource, context, { filename: 'world-management.js' });
  const management = context.VRCW.modules.worldManagement;
  assert.ok(management, 'load the real captured management module');
  const state = () => copy(run(`({
    account: currentUserId, epoch: sessionEpoch, category: currentWorldCategory,
    seq: currentWorldFetchSeq, detail: currentWorldDetail, list: allWorlds,
    selected: [...selectedWorldIds], favorites: [...worldFavoriteIdMap], names: [...worldNameCache],
    local: localWorldFavs, localIds: ${usesLocalIds ? '[...localWorldFavIds]' : '[...localWorldIdMap.keys()]'},
    localCount: ${usesLocalIds ? 'worldLocalFavoritesCount' : 'localWorldFavs.length'}
  })`));
  const snapshot = () => ({
    state: state(), dom: [...elements].map(([id, element]) => [id, element.snapshot()]),
    search: searchCards.map(card => [card.snapshot(), [...card.children].map(([key, element]) => [key, element.snapshot()])]),
    buttons: localButtons.map(button => button.snapshot()), rendered: copy(rendered),
    buckets: copy([...buckets].map(([account, data]) => [account, [...data]])), localDevice: copy(localDevice),
    writes: writes.length, effects: effects.length, requests: requests.length, commits: commits.length,
  });
  return {
    context, run, management, get, requests, callbacks, idbCalls, commits, buckets, writes, effects, searchCards, localButtons,
    state, snapshot, rendered: () => copy(rendered), device: () => copy(localDevice),
    cache: (key, account = OWNER) => copy(buckets.get(account).get(key)),
    setCache(key, value, account = OWNER) { buckets.get(account).set(key, copy(value)); },
    setRoute(next) { route = next; }, setIDBHook(next) { idbHook = next; },
    replaceList(records) { context.__records = copy(records); run('allWorlds = __records'); },
    replaceLocal(records) {
      localDevice = copy(records); context.__local = copy(records);
      run('localWorldFavs = __local; localWorldFavIds = new Set(__local.map(item => item.id)); localWorldIdMap = new Map(__local.map(item => [item.id, true])); worldLocalFavoritesCount = __local.length');
    },
    switchDetail(record = world(B), reset = true) {
      if (reset) management.resetWorldManagementDialogs();
      context.__detail = copy(record);
      run('currentWorldDetail = __detail; uiEpoch += 1; window._worldDetailActiveToken = Object.freeze({id: currentWorldDetail.id, epoch: uiEpoch})');
      get('worldDetailModal').hidden = false; get('worldDetailModal').classList.remove('hidden');
      get('worldDetailId').textContent = record.id; get('worldDetailName').textContent = record.name;
      get('worldDetailDesc').textContent = record.description; get('worldDetailRawJson').textContent = JSON.stringify(record);
    },
    switchAccount() {
      management.resetWorldManagementDialogs();
      run(`sessionEpoch += 1; currentUserId = ${JSON.stringify(OTHER)}; currentWorldFetchSeq = 100; currentWorldCategory = 'mine';
        allWorlds = ${JSON.stringify([world(A, { authorId: OTHER, name: 'New account A' }), world(B, { authorId: OTHER, name: 'New account B' })])};
        selectedWorldIds = new Set([${JSON.stringify(B)}]); worldFavoriteIdMap = new Map([[${JSON.stringify(B)}, 'new-account-favorite']]);
        worldNameCache = new Map([[${JSON.stringify(B)}, 'New account B']]);
        localWorldFavs = ${JSON.stringify([world(C, { authorId: OTHER, name: 'New local state' })])};
        localWorldFavIds = new Set([${JSON.stringify(C)}]); localWorldIdMap = new Map([[${JSON.stringify(C)}, true]]); worldLocalFavoritesCount = 1;
      `);
      this.switchDetail(world(B, { authorId: OTHER, name: 'New account B' }), false);
      assert.equal(management.editCurrentWorld(), true);
      get('worldEditName').value = 'New account draft';
    },
    options(id = A, overrides = {}) {
      const token = run('makeAuthSessionToken()');
      const detailToken = run('window._worldDetailActiveToken');
      const flags = { session: true, operation: true, detail: true, dialog: true };
      const options = {
        worldId: id, category: run('currentWorldCategory'), sessionToken: token,
        isSessionCurrent: () => flags.session && current(token),
        isOperationCurrent: () => flags.operation,
        isDetailCurrent: () => flags.detail && run('window._worldDetailActiveToken') === detailToken && run('currentWorldDetail?.id') === id,
        isDialogCurrent: () => flags.dialog,
        ...overrides,
      };
      return { options, flags };
    },
    apply(operation, record, options) { return context[operation === 'edit' ? 'applyWorldManagementUpdate' : 'applyWorldManagementDelete'](record, options); },
    saveListSnapshot(category) { return run(`_saveWorldBasicsForCurrentCategory(${JSON.stringify(category)})`); },
    begin(operation, name = 'Submitted draft') {
      assert.equal(management[operation === 'edit' ? 'editCurrentWorld' : 'deleteCurrentWorld'](), true);
      if (operation === 'edit') get('worldEditName').value = name;
      return management[operation === 'edit' ? 'saveWorldEdit' : 'confirmWorldDeletion']();
    },
  };
}

function assertCapturedTokens(h, options) {
  const calls = h.idbCalls.filter(call => call.method !== 'getLocalWorlds');
  assert.ok(calls.some(call => call.method === 'keys'));
  assert.ok(calls.some(call => call.method === 'get'));
  assert.ok(calls.some(call => call.method === 'set'));
  for (const call of calls) assert.equal(call.token, options.sessionToken, `${call.method} ${call.key || ''} uses the exact captured object`);
}
const item = (records, id = A) => records.find(record => record.id === id);
const protectedDetail = h => Object.fromEntries([
  'worldDetailId', 'worldDetailName', 'worldDetailDesc', 'worldDetailRawJson', 'worldDetailBadges', 'worldDetailTags',
  'worldEditModal', 'worldEditId', 'worldEditName', 'worldEditStatus',
  'worldDeleteConfirmModal', 'worldDeleteConfirmId', 'worldDeleteConfirmStatus',
].map(id => [id, h.get(id).snapshot()]));

// These are callback integration tests, not substitutes for the separate
// management module's validation/ownership tests. Every apply/sync/refresh
// helper above executes unchanged application source against fake boundaries.
test('authoritative PUT updates detail/list/search/name caches and every category without losing memberships or local favorites', async () => {
  const h = harness();
  const authoritative = world(A, {
    name: 'Authoritative server name', description: 'Server description', capacity: 160,
    version: 8, tags: ['system_approved', 'author_tag_<img src=x>'],
    thumbnailImageUrl: 'https://example.test/new.png', updated_at: '2026-02-02T00:00:00Z',
    unityPackages: [{ platform: 'standalonewindows' }, { platform: 'android' }],
  });
  const untouched = h.cache(PREFIX + 'recent');
  h.setRoute(() => response(authoritative));
  assert.equal(await h.begin('edit', 'Not the server name'), true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.json.name, 'Not the server name');
  const state = h.state();
  assert.equal(state.detail.name, authoritative.name);
  assert.equal(state.detail.favoriteId, 'favorite-detail-A');
  assert.equal(item(state.list).favoriteId, 'favorite-list-A');
  assert.equal(item(state.list).listNote, 'keep list metadata');
  assert.equal(item(state.list).description, authoritative.description);
  assert.equal(item(state.list, B).name, 'World B');
  assert.deepEqual(state.selected, [A, B]);
  assert.deepEqual(state.favorites, [[A, 'favorite-list-A'], [B, 'favorite-list-B']]);
  assert.equal(new Map(state.names).get(A), authoritative.name);
  assert.deepEqual(h.cache('world_name_cache'), { [A]: authoritative.name, [B]: 'World B' });
  for (const [category, favoriteId] of [['fav_worlds1', 'favorite-cache-1-A'], ['fav_worlds2', 'favorite-cache-2-A'], ['mine', null]]) {
    const record = item(h.cache(PREFIX + category));
    assert.equal(record.name, authoritative.name);
    assert.equal(record.favoriteId, favoriteId);
    assert.equal(record.updatedAt, authoritative.updated_at);
    assert.equal(record.description, authoritative.description);
    assert.equal(h.cache('world_basics_age_' + category), 0);
  }
  assert.deepEqual(h.cache(PREFIX + 'recent'), untouched);
  assert.deepEqual(h.cache(PREFIX + 'empty'), []);
  assert.deepEqual(h.cache(PREFIX + 'malformed'), { keep: true });
  assert.deepEqual(h.cache('unrelated_cache'), { untouched: true });
  assert.equal(h.cache('world_basics_age_recent'), 44);
  assert.equal(item(h.device()).name, authoritative.name);
  assert.equal(item(h.device()).localFavorite, true);
  assert.equal(item(h.device()).deviceNote, 'keep A');
  assert.equal(item(state.local).name, authoritative.name);
  assert.equal(item(state.local, B).deviceNote, 'keep B');
  assert.deepEqual(state.localIds, [A, B]);
  assert.equal(state.localCount, 2);
  assert.equal(h.idbCalls.filter(call => call.method === 'getLocalWorlds').length, 1, 'no unguarded local-count refresh may escape the awaited callback');
  assert.equal(h.localButtons[0].getAttribute('aria-pressed'), 'true');
  assert.match(h.get('worldFavGroupList').innerHTML, /(?:world\.localFavorites.*\(2\)|world\.localCount\(2\))/);
  assert.equal(h.get('worldDetailName').textContent, authoritative.name);
  assert.equal(h.get('worldDetailUpdated').textContent, 'formatted:' + authoritative.updated_at);
  assert.equal(JSON.parse(h.get('worldDetailRawJson').textContent).favoriteId, 'favorite-detail-A');
  assert.match(h.get('worldDetailBadges').innerHTML, /160[\s\S]*v8[\s\S]*Android/);
  assert.match(h.get('worldDetailTags').innerHTML, /&lt;img src=x&gt;/);
  assert.doesNotMatch(h.get('worldDetailTags').innerHTML, /<img/);
  assert.equal(h.get('worldEditModal').hidden, true);
  assert.equal(h.searchCards[0].querySelector('.avatar-name-overlay').textContent, authoritative.name);
  assert.equal(h.searchCards[0].querySelector('.avatar-thumb').getAttribute('src'), authoritative.thumbnailImageUrl);
  h.searchCards[0].onclick();
  assert.deepEqual(h.effects.at(-1), ['openDetail', A, authoritative]);
  assert.equal(item(h.rendered()).favoriteId, 'favorite-list-A');
  assertCapturedTokens(h, h.callbacks[0].options);
});

test('allWorlds edit merging preserves each membership favoriteId even if the response supplies a conflicting one', async t => {
  for (const membership of ['existing-membership', null, undefined]) {
    await t.test(String(membership), async () => {
      const h = harness();
      h.replaceList([world(A, membership === undefined ? {} : { favoriteId: membership }), world(B)]);
      const { options } = h.options(A, { isDetailCurrent: () => false });
      await h.apply('edit', world(A, { name: 'Server name', favoriteId: 'not-the-list-membership' }), options);
      assert.equal(item(h.state().list).favoriteId, membership);
      assert.equal(item(h.rendered()).favoriteId, membership);
      assert.equal(item(h.cache(PREFIX + 'fav_worlds1')).favoriteId, 'favorite-cache-1-A');
    });
  }
});

test('successful empty DELETE removes only its ID from selection/list/memory/search/category/name/device caches and closes matching detail', async () => {
  const h = harness();
  assert.equal(h.management.deleteCurrentWorld(), true);
  assert.equal(h.requests.length, 0, 'opening confirmation is not deletion');
  assert.equal(await h.management.confirmWorldDeletion(), true);
  const state = h.state();
  assert.equal(h.requests.length, 1);
  assert.ok(h.requests[0].path.endsWith(A));
  assert.equal(h.requests[0].options.method, 'DELETE');
  assert.deepEqual(state.list.map(record => record.id), [B]);
  assert.deepEqual(state.selected, [B]);
  assert.deepEqual(state.favorites, [[B, 'favorite-list-B']]);
  assert.deepEqual(state.names, [[B, 'World B']]);
  assert.deepEqual(h.cache('world_name_cache'), { [B]: 'World B' });
  for (const category of ['fav_worlds1', 'fav_worlds2', 'mine']) {
    assert.deepEqual(h.cache(PREFIX + category).map(record => record.id), [B]);
    assert.equal(h.cache('world_basics_age_' + category), 0);
  }
  assert.equal(h.searchCards[0].removed, true);
  assert.equal(h.searchCards[1].removed, false);
  assert.deepEqual(h.effects.filter(effect => effect[0] === 'disposeImages'), [['disposeImages', A]]);
  assert.deepEqual(h.device().map(record => record.id), [B]);
  assert.deepEqual(state.local.map(record => record.id), [B]);
  assert.deepEqual(state.localIds, [B]);
  assert.equal(state.localCount, 1);
  assert.equal(h.localButtons[0].getAttribute('aria-pressed'), 'false');
  assert.equal(h.localButtons[1].getAttribute('aria-pressed'), 'true');
  assert.equal(h.idbCalls.filter(call => call.method === 'getLocalWorlds').length, 1);
  assert.equal(state.detail, null);
  assert.equal(h.get('worldDetailModal').classList.contains('hidden'), true);
  assert.equal(h.get('worldDeleteConfirmModal').hidden, true);
  assert.equal(h.get('worldStats').textContent, 'world.worldCount(1)');
  assertCapturedTokens(h, h.callbacks[0].options);
});

for (const operation of ['edit', 'delete']) {
  test(`late same-account ${operation} A synchronizes A and its captured category without repainting/closing B or its dialog`, async () => {
    const h = harness();
    const pending = deferred();
    h.setRoute(() => pending.promise);
    h.setCache(PREFIX + 'mine', [world(B)]);
    const result = h.begin(operation);
    h.switchDetail();
    h.run('currentWorldCategory = "mine"');
    h.replaceList([world(B, { favoriteId: 'favorite-live-B' })]);
    assert.equal(h.management[operation === 'edit' ? 'editCurrentWorld' : 'deleteCurrentWorld'](), true);
    if (operation === 'edit') h.get('worldEditName').value = 'B retained draft';
    const before = protectedDetail(h);
    const seq = h.state().seq;
    pending.resolve(operation === 'edit' ? response(world(A, { name: 'A server response' })) : response(undefined, 204));
    assert.equal(await result, true);
    assert.deepEqual(protectedDetail(h), before);
    assert.equal(h.state().detail.id, B);
    assert.equal(h.state().seq, seq, 'unrelated B-category streaming fetch must not be invalidated');
    assert.deepEqual(h.state().list, [world(B, { favoriteId: 'favorite-live-B' })]);
    assert.equal(h.get('worldDetailModal').classList.contains('hidden'), false);
    assert.equal(h.callbacks[0].options.category, 'fav_worlds1');
    assert.equal(h.callbacks[0].options.isSessionCurrent(), true);
    assert.equal(h.callbacks[0].options.isDetailCurrent(), false);
    assert.equal(h.callbacks[0].options.isDialogCurrent(), false);
    assert.equal(h.cache('world_basics_age_fav_worlds1'), 0);
    assert.equal(h.cache('world_basics_age_mine'), 33, 'live category is not substituted for the callback snapshot');
    if (operation === 'edit') assert.equal(item(h.cache(PREFIX + 'fav_worlds2')).name, 'A server response');
    else assert.equal(item(h.cache(PREFIX + 'fav_worlds2')), undefined);
    assert.equal(h.requests.length, 1);
    assertCapturedTokens(h, h.callbacks[0].options);
  });
}

test('captured-category invalidation and live-list fetch generation are independent', async t => {
  for (const operation of ['edit', 'delete']) {
    for (const scenario of ['unrelated-category', 'same-category', 'present-in-live-list']) {
      await t.test(operation + '/' + scenario, async () => {
        const h = harness();
        const { options } = h.options(A, { category: 'snapshot-no-payload', isDetailCurrent: () => false, isDialogCurrent: () => false });
        h.setCache('world_basics_age_snapshot-no-payload', 123);
        h.run(`currentWorldCategory = ${JSON.stringify(scenario === 'same-category' ? 'snapshot-no-payload' : 'live-no-payload')}`);
        h.setCache('world_basics_age_live-no-payload', 456);
        h.replaceList(scenario === 'present-in-live-list' ? [world(A), world(B)] : [world(B)]);
        const seq = h.state().seq;
        await h.apply(operation, world(A, { name: 'Changed A' }), options);
        assert.equal(h.state().seq, seq + Number(scenario !== 'unrelated-category'));
        assert.equal(h.cache('world_basics_age_snapshot-no-payload'), 0);
        assert.equal(h.cache('world_basics_age_live-no-payload'), 456);
        assert.equal(h.cache(PREFIX + 'snapshot-no-payload'), undefined, 'do not seed an absent category with a detail record');
        assert.equal(item(h.state().list, B).name, 'World B');
      });
    }
  }
});

test('invalid session/operation/world guards stop before any memory/list/DOM/cache side effect', async t => {
  for (const operation of ['edit', 'delete']) {
    for (const scenario of ['missing-token', 'stale-session-predicate', 'stale-operation', 'stale-auth-token', 'wrong-world-id', 'null-world', 'missing-options']) {
      await t.test(operation + '/' + scenario, async () => {
        const h = harness();
        let { options } = h.options();
        let record = world(A, { name: 'Must not appear' });
        if (scenario === 'missing-token') options.sessionToken = null;
        if (scenario === 'stale-session-predicate') options.isSessionCurrent = () => false;
        if (scenario === 'stale-operation') options.isOperationCurrent = () => false;
        if (scenario === 'stale-auth-token') { h.run('sessionEpoch += 1'); options.isSessionCurrent = () => true; }
        if (scenario === 'wrong-world-id') record = world(B);
        if (scenario === 'null-world') record = null;
        if (scenario === 'missing-options') options = undefined;
        const before = h.snapshot();
        await h.apply(operation, record, options);
        assert.deepEqual(h.snapshot(), before);
        assert.equal(h.idbCalls.length, 0);
      });
    }
  }
});

test('session switch during every awaited cache/local boundary prevents ANY replacement-account/list/DOM/local-count write', { timeout: 10000 }, async t => {
  for (const operation of ['edit', 'delete']) {
    for (const stage of ['keys', 'category-read', 'category-write', 'names-read', 'local-read', 'local-mutation']) {
      await t.test(operation + '/' + stage, async () => {
        const h = harness();
        const entered = deferred();
        const resume = deferred();
        let blocked = false;
        const matches = call => stage === 'keys' ? call.method === 'keys'
          : stage === 'category-read' ? call.method === 'get' && call.key === PREFIX + 'fav_worlds1'
          : stage === 'category-write' ? call.method === 'set' && call.key === PREFIX + 'fav_worlds1'
          : stage === 'names-read' ? call.method === 'get' && call.key === 'world_name_cache'
          : stage === 'local-read' ? call.method === 'getLocalWorlds'
          : call.method === (operation === 'edit' ? 'saveLocalWorld' : 'removeLocalWorld');
        h.setIDBHook(async call => {
          if (blocked || !matches(call)) return;
          blocked = true; entered.resolve(); await resume.promise;
        });
        const resultPromise = h.begin(operation);
        await entered.promise;
        const options = h.callbacks[0].options;
        for (const call of h.idbCalls.filter(call => call.method !== 'getLocalWorlds')) assert.equal(call.token, options.sessionToken);
        h.switchAccount();
        const before = h.snapshot();
        const callCount = h.idbCalls.length;
        resume.resolve();
        assert.equal(await resultPromise, false);
        await tick();
        assert.deepEqual(h.snapshot(), before, 'includes same-value DOM writes, local count, selection, both storage buckets, and device favorites');
        assert.equal(h.idbCalls.length, callCount, 'not even another cache/local call after the stale await');
      });
    }
  }
});

test('a queued old-session edit is rejected before starting persistence after account replacement', async () => {
  const h = harness();
  const entered = deferred();
  const resume = deferred();
  let blocked = false;
  h.setIDBHook(async call => {
    if (blocked || call.method !== 'get' || call.key !== PREFIX + 'fav_worlds1') return;
    blocked = true; entered.resolve(); await resume.promise;
  });
  const a = h.options(A, { isDetailCurrent: () => false }).options;
  const b = h.options(B, { isDetailCurrent: () => false }).options;
  const first = h.apply('edit', world(A, { name: 'Old session A' }), a);
  await entered.promise;
  const second = h.apply('edit', world(B, { name: 'Old session B' }), b);
  await tick();
  h.switchAccount();
  const before = h.snapshot();
  const callCount = h.idbCalls.length;
  resume.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.idbCalls.length, callCount);
  assert.equal(h.idbCalls.filter(call => call.method === 'keys').length, 1);
});

test('delete closes detail only when session, operation, detail AND dialog are still current after persistence', async t => {
  for (const scenario of ['all-current', 'detail-replaced', 'dialog-replaced', 'both-replaced', 'operation-expired']) {
    await t.test(scenario, async () => {
      const h = harness();
      const entered = deferred();
      const resume = deferred();
      h.setIDBHook(async call => { if (call.method === 'keys') { entered.resolve(); await resume.promise; } });
      const { options, flags } = h.options();
      const result = h.apply('delete', world(), options);
      await entered.promise;
      if (scenario.includes('detail') || scenario === 'both-replaced') flags.detail = false;
      if (scenario.includes('dialog') || scenario === 'both-replaced') flags.dialog = false;
      if (scenario === 'operation-expired') flags.operation = false;
      resume.resolve(); await result;
      assert.equal(h.get('worldDetailModal').classList.contains('hidden'), scenario === 'all-current');
      assert.equal(h.state().detail === null, scenario === 'all-current');
    });
  }
});

for (const operation of ['edit', 'delete']) {
  test(`${operation} cache failure never retries the server mutation, targets B, or closes/repaints B`, async () => {
    const h = harness();
    const entered = deferred();
    const fail = deferred();
    let blocked = false;
    h.setIDBHook(async call => {
      if (blocked || call.method !== 'get' || call.key !== PREFIX + 'fav_worlds1') return;
      blocked = true; entered.resolve(); await fail.promise;
    });
    const result = h.begin(operation);
    await entered.promise;
    h.switchDetail();
    assert.equal(h.management[operation === 'edit' ? 'editCurrentWorld' : 'deleteCurrentWorld'](), true);
    if (operation === 'edit') h.get('worldEditName').value = 'B retained draft';
    const before = protectedDetail(h);
    fail.reject(new Error('Fake cache unavailable'));
    assert.equal(await result, operation === 'delete');
    assert.deepEqual(protectedDetail(h), before);
    assert.equal(h.get('worldDetailModal').classList.contains('hidden'), false);
    assert.equal(h.requests.length, 1);
    assert.ok(h.requests.every(request => request.path.endsWith(A)));
    assert.equal(h.idbCalls.filter(call => call.method === 'keys').length, 1, 'no hidden persistence retry');
    assert.equal(item(h.cache(PREFIX + 'fav_worlds1'), B).name, 'World B');
    if (operation === 'delete') assert.ok(h.effects.some(effect => effect[0] === 'toast' && effect[1].includes('Fake cache unavailable')));
  });
}

test('successful DELETE plus cache failure cannot re-delete A through a reopened same-ID confirmation', async () => {
  const h = harness();
  const entered = deferred();
  const fail = deferred();
  h.setIDBHook(async call => { if (call.method === 'keys') { entered.resolve(); await fail.promise; } });
  const result = h.begin('delete');
  await entered.promise;
  h.management.closeWorldDeleteConfirm();
  const reopened = h.management.deleteCurrentWorld();
  fail.reject(new Error('Fake cache unavailable'));
  assert.equal(await result, true);
  assert.equal(h.get('worldDetailModal').classList.contains('hidden'), false, 'a committed deletion cannot close a replacement dialog/detail');
  h.setIDBHook(null);
  assert.equal(await h.management.confirmWorldDeletion(), false, 'a committed world ID must be tombstoned for this session');
  assert.equal(h.management.deleteCurrentWorld(), false);
  assert.equal(h.management.editCurrentWorld(), false);
  assert.equal(h.requests.length, 1);
  if (reopened) assert.equal(h.get('btnConfirmWorldDelete').disabled, true);
});

test('stale in-flight world-list cache save cannot overwrite an authoritative edit or refresh its age', async () => {
  const h = harness();
  const entered = deferred();
  const resume = deferred();
  let blocked = false;
  h.setIDBHook(async call => {
    if (!blocked && call.method === 'set' && call.key === PREFIX + 'fav_worlds1') {
      blocked = true;
      entered.resolve();
      await resume.promise;
    }
  });
  const listSave = h.saveListSnapshot('fav_worlds1');
  await entered.promise;
  const { options } = h.options(A, { isDetailCurrent: () => false });
  const mutation = h.apply('edit', world(A, { name: 'Fresh authoritative world' }), options);
  resume.resolve();
  await Promise.all([listSave, mutation]);
  assert.equal(item(h.cache(PREFIX + 'fav_worlds1')).name, 'Fresh authoritative world');
  assert.equal(h.cache('world_basics_age_fav_worlds1'), 0);
  assert.equal(h.idbCalls.filter(call => call.method === 'set' && call.key === PREFIX + 'fav_worlds1').length, 2);
  const writes = h.commits.filter(call => call.key === PREFIX + 'fav_worlds1');
  assert.equal(writes.length, 2, 'the old in-flight write may complete, but the shared queue must follow it with the mutation RMW');
  assert.equal(item(writes[0].value)?.name, 'World A');
  assert.equal(item(writes[1].value)?.name, 'Fresh authoritative world');
});

test('concurrent different-ID edits serialize cache read/modify/write and retain BOTH changes in all shared caches', async () => {
  const h = harness();
  const entered = deferred();
  const resume = deferred();
  let blocked = false;
  h.setIDBHook(async call => {
    if (blocked || call.method !== 'get' || call.key !== PREFIX + 'fav_worlds1') return;
    blocked = true; entered.resolve(); await resume.promise;
  });
  const a = h.options(A, { isDetailCurrent: () => false }).options;
  const b = h.options(B, { isDetailCurrent: () => false }).options;
  const first = h.apply('edit', world(A, { name: 'Concurrent A' }), a);
  await entered.promise;
  const callCount = h.idbCalls.length;
  const second = h.apply('edit', world(B, { name: 'Concurrent B' }), b);
  await tick();
  assert.equal(h.idbCalls.length, callCount, 'B persistence cannot read the shared pre-A snapshot');
  resume.resolve(); await Promise.all([first, second]);
  for (const category of ['fav_worlds1', 'fav_worlds2', 'mine']) {
    const records = h.cache(PREFIX + category);
    assert.equal(item(records, A).name, 'Concurrent A');
    assert.equal(item(records, B).name, 'Concurrent B');
  }
  assert.equal(item(h.cache(PREFIX + 'fav_worlds1'), A).favoriteId, 'favorite-cache-1-A');
  assert.equal(item(h.cache(PREFIX + 'fav_worlds1'), B).favoriteId, 'favorite-cache-1-B');
  assert.deepEqual(h.cache('world_name_cache'), { [A]: 'Concurrent A', [B]: 'Concurrent B' });
  assert.equal(item(h.device(), A).name, 'Concurrent A');
  assert.equal(item(h.device(), B).name, 'Concurrent B');
  assert.equal(item(h.state().list, A).favoriteId, 'favorite-list-A');
  assert.equal(item(h.state().list, B).favoriteId, 'favorite-list-B');
  const firstB = h.idbCalls.findIndex(call => call.token === b.sessionToken);
  const lastA = h.idbCalls.reduce((last, call, index) => call.token === a.sessionToken ? index : last, -1);
  assert.ok(firstB > lastA, 'one complete persistence flight owns the RMW queue at a time');
});

test('a rejected persistence flight releases the queue for B without retrying or deleting either world', async () => {
  const h = harness();
  const entered = deferred();
  const fail = deferred();
  let blocked = false;
  h.setIDBHook(async call => {
    if (blocked || call.method !== 'keys') return;
    blocked = true; entered.resolve(); await fail.promise;
  });
  const a = h.options(A, { isDetailCurrent: () => false }).options;
  const b = h.options(B, { isDetailCurrent: () => false }).options;
  const first = h.apply('edit', world(A, { name: 'A authoritative but unsynced' }), a);
  const rejected = assert.rejects(first, /Fake failed flight/);
  await entered.promise;
  const second = h.apply('edit', world(B, { name: 'B after failure' }), b);
  fail.reject(new Error('Fake failed flight'));
  await rejected; await second;
  assert.equal(h.idbCalls.filter(call => call.method === 'keys' && call.token === a.sessionToken).length, 1);
  assert.equal(h.idbCalls.filter(call => call.method === 'keys' && call.token === b.sessionToken).length, 1);
  assert.equal(item(h.cache(PREFIX + 'fav_worlds1'), A).name, 'World A');
  assert.equal(item(h.cache(PREFIX + 'fav_worlds1'), B).name, 'B after failure');
  assert.deepEqual(h.state().list.map(record => record.id), [A, B]);
  assert.equal(h.requests.length, 0, 'direct integration helpers never issue server mutations');
});

test('editing/deleting a non-local world never creates device favorites or mutates another saved world', async t => {
  for (const operation of ['edit', 'delete']) {
    await t.test(operation, async () => {
      const h = harness();
      h.replaceLocal([world(B, { localFavorite: true })]);
      const { options } = h.options(A, { isDialogCurrent: () => false });
      await h.apply(operation, world(A, { name: 'Not locally saved' }), options);
      assert.deepEqual(h.device(), [world(B, { localFavorite: true })]);
      assert.deepEqual(h.state().localIds, [B]);
      assert.equal(h.idbCalls.some(call => ['saveLocalWorld', 'removeLocalWorld'].includes(call.method)), false);
    });
  }
});

test('static management UI has hidden owner parent/buttons, hidden dialogs, red destructive styling, and version-independent handlers', () => {
  const tag = id => {
    const tags = html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`, 'g')) || [];
    assert.equal(tags.length, 1, `${id} is unique`);
    return tags[0];
  };
  assert.match(tag('worldDetailOwnerActions'), /\bhidden(?:\s|>)/);
  const ownerStart = html.indexOf(tag('worldDetailOwnerActions'));
  const ownerBlock = html.slice(ownerStart, html.indexOf('</div>', ownerStart));
  for (const [id, handler] of [['worldDetailEditBtn', 'editCurrentWorld'], ['worldDetailDeleteBtn', 'deleteCurrentWorld']]) {
    assert.match(tag(id), /\bhidden(?:\s|>)/);
    assert.ok(ownerBlock.includes(tag(id)), 'both buttons remain inside the hidden owner parent');
    assert.ok(tag(id).includes(`onclick="${handler}()"`));
  }
  for (const [id, role, handler] of [['worldEditModal', 'dialog', 'closeWorldEditModal'], ['worldDeleteConfirmModal', 'alertdialog', 'closeWorldDeleteConfirm']]) {
    assert.match(tag(id), /class="[^"]*\bhidden\b/);
    assert.ok(tag(id).includes(`role="${role}"`));
    assert.ok(tag(id).includes(`${handler}()`));
  }
  for (const id of ['worldEditStatus', 'worldDeleteConfirmStatus']) {
    assert.match(tag(id), /role="status"/);
    assert.match(tag(id), /aria-live="polite"/);
  }
  assert.match(tag('worldEditReleaseStatus'), /^<strong\b/);
  assert.match(tag('worldDetailDeleteBtn'), /\bbtn-danger-full\b/);
  assert.match(tag('btnConfirmWorldDelete'), /\bbtn-danger-full\b/);
  assert.match(tag('btnConfirmWorldDelete'), /onclick="confirmWorldDeletion\(\)"/);
  assert.match(css, /--error:\s*#ef4444\b/i);
  assert.match(css, /\.btn-danger-full\s*\{[^}]*color:\s*var\(--error\)[^}]*border:[^}]*239,\s*68,\s*68/);
  assert.match(css, /#worldDetailOwnerActions\[hidden\]\s*,\s*#worldDetailEditBtn\[hidden\]\s*,\s*#worldDetailDeleteBtn\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(css, /\.hidden\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(shellSource, /loadScriptOnce\('js\/world-management\.js\?v='\s*\+\s*APP_CACHE_VERSION\)/);
});

test('real lazy shell wrappers load worlds then management and call captured management handlers, never worlds/global wrappers', async t => {
  for (const preloaded of [false, true]) {
    await t.test(preloaded ? 'worlds already loaded' : 'both modules lazy', async () => {
      const h = harness();
      const loaded = [];
      const errors = [];
      const worldReady = deferred();
      let shell;
      const poison = () => { throw new Error('Wrong worlds/global wrapper called'); };
      const names = ['editCurrentWorld', 'saveWorldEdit', 'closeWorldEditModal', 'deleteCurrentWorld', 'confirmWorldDeletion', 'closeWorldDeleteConfirm'];
      const worldModule = Object.fromEntries(names.map(name => [name, poison]));
      shell = vm.createContext({
        console, APP_CACHE_VERSION: 'integration-test-version',
        VRCW: { modules: preloaded ? { worlds: worldModule } : {}, registerModule(name, module) { this.modules[name] = module; } },
        async loadScriptOnce(path) {
          loaded.push(path);
          const file = path.split('?')[0];
          if (file === 'js/worlds.js') { await worldReady.promise; shell.VRCW.modules.worlds = worldModule; }
          else if (file === 'js/world-management.js') {
            assert.ok(shell.VRCW.modules.worlds, 'worlds must register before management loads');
            shell.VRCW.modules.worldManagement = h.management;
            for (const name of names) shell[name] = poison;
          } else throw new Error('Unexpected script/network path: ' + path);
        },
        t: key => key, showToast: (...args) => errors.push(args), renderAppVersionInfo() {},
        fetch() { throw new Error('Real network is forbidden.'); },
      });
      vm.runInContext('window = globalThis;\n' + shellSource, shell, { filename: 'worlds-shell.js' });
      const wrappers = Object.fromEntries(names.map(name => [name, shell[name]]));
      const opening = wrappers.editCurrentWorld();
      if (!preloaded) {
        await tick();
        assert.deepEqual(loaded.map(path => path.split('?')[0]), ['js/worlds.js']);
        worldReady.resolve();
      }
      assert.equal(await opening, true);
      assert.deepEqual(loaded.map(path => path.split('?')[0]), preloaded ? ['js/world-management.js'] : ['js/worlds.js', 'js/world-management.js']);
      assert.ok(loaded.every(path => path.endsWith('?v=integration-test-version')));
      assert.notEqual(wrappers.editCurrentWorld, h.management.editCurrentWorld);
      h.get('worldEditName').value = 'Shell execution save';
      assert.equal(await wrappers.saveWorldEdit(), true);
      assert.equal(h.state().detail.name, 'Shell execution save');
      await wrappers.closeWorldEditModal();
      assert.equal(await wrappers.deleteCurrentWorld(), true);
      await wrappers.closeWorldDeleteConfirm();
      assert.equal(h.requests.length, 1, 'closing confirmation must not issue DELETE');
      assert.equal(await wrappers.deleteCurrentWorld(), true);
      assert.equal(await wrappers.confirmWorldDeletion(), true);
      assert.deepEqual(h.requests.map(request => request.options.method), ['PUT', 'DELETE']);
      assert.deepEqual(errors, []);
    });
  }
});

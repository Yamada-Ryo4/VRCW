import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/js/world-management.js', import.meta.url), 'utf8');
const A = 'wrld_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'wrld_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OWNER = 'usr_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'usr_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function world(overrides = {}) {
  return {
    id: A, authorId: OWNER, name: 'World A', description: 'Original description',
    capacity: 80, recommendedCapacity: 40, tags: ['author_tag_cozy', 'admin_featured'],
    previewYoutubeId: 'dQw4w9WgXcQ', urlList: ['https://example.test/info'],
    releaseStatus: 'private', imageUrl: 'https://example.test/image.png', version: 7,
    ...overrides,
  };
}
const labs = overrides => world({ releaseStatus: 'public', tags: ['system_labs', 'author_tag_cozy', 'admin_featured'], ...overrides });
function response(body, status = 200, parse = null) {
  return {
    ok: status >= 200 && status < 300, status,
    async json() {
      if (parse) return parse();
      if (body === undefined) throw new SyntaxError('Empty response');
      return copy(body);
    },
  };
}

// Execute only the private module, with a fake DOM/API and fake account tokens.
// No application boot, browser, credentials, network, real storage, or parser dependency.
function harness(initial = world()) {
  const writes = [];
  const elements = new Map();
  const ids = [
    'worldDetailModal', 'worldDetailId', 'worldDetailName', 'worldDetailOwnerActions',
    'worldDetailEditBtn', 'worldDetailDeleteBtn', 'worldEditModal', 'worldEditId',
    'worldEditName', 'worldEditDescription', 'worldEditCapacity', 'worldEditRecommendedCapacity',
    'worldEditTags', 'worldEditPreviewYoutubeId', 'worldEditUrlList', 'worldEditReleaseStatus',
    'worldEditStatus', 'btnSaveWorldEdit', 'btnWorldPublicationAction', 'worldPublicationEligibility',
    'btnRefreshWorldPublication', 'worldPublicationConfirmModal', 'worldPublicationConfirmTitle',
    'worldPublicationConfirmName', 'worldPublicationConfirmId', 'worldPublicationConfirmWarning',
    'worldPublicationConfirmStatus', 'btnCancelWorldPublication', 'btnConfirmWorldPublication',
    'btnRefreshWorldPublicationConfirm', 'worldDeleteConfirmModal', 'worldDeleteConfirmName',
    'worldDeleteConfirmId', 'worldDeleteConfirmStatus', 'btnConfirmWorldDelete', 'btnCancelWorldDelete',
  ];
  for (const id of ids) {
    const classes = new Set(id.endsWith('Modal') && id !== 'worldDetailModal' ? ['hidden'] : []);
    const el = {
      dataset: {}, style: {}, attributes: {},
      classList: {
        contains: value => classes.has(value),
        add: value => classes.add(value), remove: value => classes.delete(value),
        toggle(value, force) { force ? classes.add(value) : classes.delete(value); },
      },
      setAttribute(key, value) { writes.push([id, key, String(value)]); this.attributes[key] = String(value); },
      getAttribute(key) { return this.attributes[key] ?? null; },
      focus() { writes.push([id, 'focus']); },
      set innerHTML(_) { throw new Error('Unsafe HTML is forbidden.'); },
    };
    for (const [key, initialValue] of Object.entries({ value: '', textContent: '', hidden: classes.has('hidden'), disabled: false })) {
      let value = initialValue;
      Object.defineProperty(el, key, { get: () => value, set(next) { writes.push([id, key, next]); value = next; } });
    }
    elements.set(id, el);
  }
  const get = id => elements.get(id);
  const requests = [];
  const updates = [];
  const cache = new Map();
  let server = copy(initial);
  let locks = 0;
  let customUpdate = null;
  let route = (path, options) => {
    if (path.endsWith('/publish')) {
      if (!options.method) return response({ canPublish: true });
      server = options.method === 'PUT' ? labs({ id: server.id }) : world({ id: server.id });
      return response(undefined, 204);
    }
    if (options.method === 'PUT') server = { ...server, ...options.json };
    return response(server);
  };
  let context;
  const run = expression => vm.runInContext(expression, context);
  context = vm.createContext({
    console, URL,
    document: { getElementById: id => get(id) || null },
    fetch() { throw new Error('Real network is forbidden.'); },
    logout() { throw new Error('Real logout is forbidden.'); },
    lockBodyScroll() { locks += 1; },
    unlockBodyScroll() { locks -= 1; assert.ok(locks >= 0); },
    t: key => key,
    VRCW: { modules: {}, registerModule(name, handlers) { this.modules[name] = handlers; } },
    async apiCall(path, options = {}) {
      assert.match(path, /^\/api\/vrc\/worlds\/wrld_[a-f0-9-]{36}(?:\/publish)?$/i);
      for (const flag of ['noAbort', 'noCache', 'noDedupe']) assert.equal(options[flag], true, flag);
      if (path.endsWith('/publish')) {
        assert.ok([undefined, 'PUT', 'DELETE'].includes(options.method));
        assert.equal(Object.hasOwn(options, 'json'), false, 'publication is bodyless');
        assert.equal(Object.hasOwn(options, 'body'), false, 'publication is bodyless');
      }
      requests.push({ path, options: copy(options) });
      return route(path, options);
    },
    async applyWorldManagementUpdate(record, options) {
      updates.push({ record: copy(record), options });
      if (customUpdate) return customUpdate(record, options);
      if (!options.isSessionCurrent() || !options.isOperationCurrent()) return;
      context.__record = record;
      run('allWorlds = allWorlds.map(item => item.id === __record.id ? {...item, ...__record} : item)');
      await Promise.resolve();
      if (!options.isSessionCurrent() || !options.isOperationCurrent()) return;
      cache.set(record.id, { record: copy(record), token: options.sessionToken });
      if (options.isDetailCurrent()) {
        run('currentWorldDetail = __record');
        get('worldDetailName').textContent = record.name;
      }
    },
    async applyWorldManagementDelete() {},
  });
  vm.runInContext(`
    window = globalThis;
    let currentUserId = ${JSON.stringify(OWNER)};
    let currentWorldDetail = ${JSON.stringify(initial)};
    let allWorlds = [${JSON.stringify(initial)}];
    let selectedWorldIds = new Set([${JSON.stringify(A)}]);
    let currentWorldCategory = 'mine';
    let sessionEpoch = 1;
    let uiEpoch = 1;
    function makeAuthSessionToken() { return Object.freeze({epoch: sessionEpoch, accountId: currentUserId}); }
    function isAuthSessionCurrent(token) { return !!token && token.epoch === sessionEpoch && token.accountId === currentUserId; }
    function isUiTokenCurrent(token) { return !!token && token === window._worldDetailActiveToken && token.epoch === uiEpoch; }
    window._worldDetailActiveToken = {id: currentWorldDetail.id, epoch: uiEpoch};
  `, context);
  get('worldDetailId').textContent = initial.id;
  get('worldDetailName').textContent = initial.name;
  vm.runInContext(source, context, { filename: 'world-management.js' });
  const m = context.VRCW.modules.worldManagement;
  return {
    get, run, context, m, requests, updates, cache, writes,
    locks: () => locks,
    mutations: () => requests.filter(({ options }) => ['PUT', 'DELETE'].includes(options.method)),
    setRoute(next) { route = next; }, onUpdate(next) { customUpdate = next; },
    async open() { assert.equal(m.editCurrentWorld(), true); await tick(); },
    switchDetail(next = world({ id: B, name: 'World B' }), reset = true) {
      if (reset) m.resetWorldManagementDialogs();
      context.__next = next;
      run('currentWorldDetail = __next; uiEpoch += 1; window._worldDetailActiveToken = {id: __next.id, epoch: uiEpoch}');
      get('worldDetailId').textContent = next.id;
      get('worldDetailName').textContent = next.name;
    },
    switchSession(account = OWNER, reset = true) {
      if (reset) m.resetWorldManagementDialogs();
      context.__account = account;
      run('currentUserId = __account; sessionEpoch += 1');
    },
  };
}

const pubRequests = h => h.requests.filter(request => request.path.endsWith('/publish'));

test('opening checks eligibility only; cancel/reset write nothing and retain dirty editor behind confirmation', async () => {
  const h = harness(world({ name: '<script>not HTML</script>' }));
  assert.equal(h.m.editCurrentWorld(), true);
  assert.equal(h.get('btnWorldPublicationAction').disabled, true);
  assert.match(h.get('worldPublicationEligibility').textContent, /Checking/);
  await tick();
  assert.equal(h.get('btnWorldPublicationAction').disabled, false);
  h.get('worldEditName').value = 'Dirty name';
  for (const cancel of [() => h.m.closeWorldPublicationConfirm(), () => h.m.resetWorldManagementDialogs()]) {
    assert.equal(h.m.openWorldPublicationConfirm(), true);
    assert.equal(h.get('worldEditModal').hidden, false);
    assert.equal(h.get('worldPublicationConfirmName').textContent, '<script>not HTML</script>');
    assert.equal(h.get('worldPublicationConfirmId').textContent, A);
    assert.equal(h.locks(), 2);
    cancel();
    assert.equal(await h.m.confirmWorldPublication(), false);
  }
  assert.equal(h.mutations().length, 0);
  assert.equal(h.cache.size, 0);
  assert.equal(h.locks(), 0);
  assert.equal(h.get('worldEditName').value, 'Dirty name');
  assert.equal(pubRequests(h).length, 1);
  assert.equal(h.m.openWorldPublicationConfirm(), false);
});

test('eligibility false/error/malformed stays disabled, and read-only refresh enables retry', async t => {
  for (const result of [response({ canPublish: false }), response({ error: 'Unavailable' }, 503), response({}), response({ canPublish: 'true' }), response(undefined)]) {
    await t.test(JSON.stringify(result.status) + '-' + Math.random().toString(16).slice(2, 6), async () => {
      const h = harness();
      h.setRoute(() => result);
      await h.open();
      assert.equal(h.get('btnWorldPublicationAction').disabled, true);
      assert.equal(h.m.openWorldPublicationConfirm(), false);
      assert.ok(h.get('worldPublicationEligibility').textContent);
      h.setRoute(path => response(path.endsWith('/publish') ? { canPublish: true } : world()));
      assert.equal(await h.m.refreshWorldPublicationStatus(), true);
      assert.equal(h.get('btnWorldPublicationAction').disabled, false);
      assert.equal(h.mutations().length, 0);
    });
  }
});

test('final fresh detail and fresh literal canPublish gate bodyless publish, always refetch even with complete mutation body', async t => {
  for (const mutationResponse of [response(undefined, 200), response(undefined, 204), response(world())]) {
    await t.test(String(mutationResponse.status), async () => {
      const h = harness();
      let written = false;
      h.setRoute((path, options) => {
        if (options.method === 'PUT') { written = true; return mutationResponse; }
        return response(path.endsWith('/publish') ? { canPublish: true } : written ? labs() : world());
      });
      await h.open();
      assert.equal(h.m.openWorldPublicationConfirm(), true);
      assert.equal(await h.m.confirmWorldPublication(), true);
      assert.deepEqual(h.requests.map(({ path, options }) => [path.endsWith('/publish'), options.method || 'GET']), [
        [true, 'GET'], [false, 'GET'], [true, 'GET'], [true, 'PUT'], [false, 'GET'],
      ]);
      assert.equal(h.get('worldEditReleaseStatus').textContent, 'Community Labs');
      assert.equal(h.get('worldEditModal').hidden, false);
      assert.match(h.get('worldPublicationConfirmStatus').textContent, /completed.*Community Labs/);
      assert.equal(h.get('btnConfirmWorldPublication').disabled, true);
      assert.equal(await h.m.confirmWorldPublication(), false, 'confirmed action cannot be replayed');
      assert.equal(h.mutations().length, 1);
      assert.equal(h.updates[0].options.operation, 'publish');
      assert.ok(Object.isFrozen(h.updates[0].options.originalWorld));
    });
  }
});

test('fresh final eligibility false/error/malformed prevents PUT even after initial eligibility was true', async t => {
  for (const eligibility of [response({ canPublish: false }), response({ canPublish: 1 }), response({ error: 'Denied' }, 403), response(undefined)]) {
    await t.test(String(eligibility.status), async () => {
      const h = harness();
      await h.open();
      h.m.openWorldPublicationConfirm();
      h.setRoute(path => path.endsWith('/publish') ? eligibility : response(world()));
      assert.equal(await h.m.confirmWorldPublication(), false);
      assert.equal(h.mutations().length, 0);
      assert.equal(h.get('btnConfirmWorldPublication').disabled, true);
      assert.equal(h.get('worldEditModal').hidden, false);
    });
  }
});

test('public and Labs withdraw through nested DELETE, never root deletion, without any canPublish request', async t => {
  for (const initial of [world({ releaseStatus: 'public', tags: ['system_approved'] }), labs()]) {
    await t.test(initial.tags[0], async () => {
      const h = harness(initial);
      await h.open();
      assert.equal(h.requests.length, 0);
      assert.equal(h.get('worldEditReleaseStatus').textContent, initial.tags.includes('system_labs') ? 'Community Labs' : 'Public');
      h.m.openWorldPublicationConfirm();
      assert.equal(await h.m.confirmWorldPublication(), true);
      assert.deepEqual(h.requests.map(({ path, options }) => [path.endsWith('/publish'), options.method || 'GET']), [[false, 'GET'], [true, 'DELETE'], [false, 'GET'], [true, 'GET']]);
      assert.equal(h.get('worldEditReleaseStatus').textContent, 'Private');
      assert.equal(h.updates[0].options.operation, 'unpublish');
      assert.match(h.get('worldPublicationConfirmStatus').textContent, /Unpublication completed.*Private/);
    });
  }
});

test('publication refetch rebases every untouched control, preserves dirty drafts, and later metadata tags keep fresh system_labs', async () => {
  const h = harness();
  await h.open();
  h.get('worldEditName').value = 'My draft';
  h.get('worldEditTags').value = 'dancing';
  h.get('worldEditCapacity').value = '160';
  h.m.openWorldPublicationConfirm();
  const authoritative = labs({ name: 'Server name', description: 'Server description', recommendedCapacity: 60, previewYoutubeId: '', urlList: ['https://example.test/new'], tags: ['system_labs', 'author_tag_server', 'admin_featured'] });
  let published = false;
  h.setRoute((path, options) => {
    if (path.endsWith('/publish')) {
      if (options.method === 'PUT') { published = true; return response(undefined, 204); }
      return response({ canPublish: true });
    }
    return response(options.method === 'PUT' ? { ...authoritative, ...options.json } : published ? authoritative : world());
  });
  assert.equal(await h.m.confirmWorldPublication(), true);
  assert.equal(h.get('worldEditName').value, 'My draft');
  assert.equal(h.get('worldEditTags').value, 'dancing');
  assert.equal(h.get('worldEditCapacity').value, '160');
  assert.equal(h.get('worldEditDescription').value, 'Server description');
  assert.equal(h.get('worldEditRecommendedCapacity').value, '60');
  assert.equal(h.get('worldEditPreviewYoutubeId').value, '');
  assert.equal(h.get('worldEditUrlList').value, 'https://example.test/new');
  h.m.closeWorldPublicationConfirm();
  assert.equal(await h.m.saveWorldEdit(), true);
  const metadata = h.mutations().find(request => !request.path.endsWith('/publish'));
  assert.deepEqual(metadata.options.json, { name: 'My draft', capacity: 160, tags: ['system_labs', 'author_tag_dancing', 'admin_featured'] });
  assert.equal(Object.hasOwn(metadata.options.json, 'releaseStatus'), false);
});

test('missing/wrong/partial/malformed post-write World stays blocked until read reconciliation and never redispatches', async t => {
  const partial = { id: A, authorId: OWNER, name: 'partial', releaseStatus: 'public', tags: ['system_labs'] };
  for (const invalid of [undefined, partial, labs({ id: B }), labs({ authorId: OTHER }), labs({ releaseStatus: null }), labs({ tags: [1] }), labs({ tags: undefined })]) {
    await t.test(JSON.stringify(invalid) || 'empty', async () => {
      const h = harness();
      await h.open();
      h.m.openWorldPublicationConfirm();
      let written = false;
      h.setRoute((path, options) => {
        if (options.method === 'PUT') { written = true; return response(undefined, 204); }
        return response(path.endsWith('/publish') ? { canPublish: true } : written ? invalid : world());
      });
      assert.equal(await h.m.confirmWorldPublication(), false);
      assert.equal(h.updates.length, 0);
      assert.match(h.get('worldPublicationConfirmStatus').textContent, /succeeded, but refreshing/);
      assert.equal(h.get('btnWorldPublicationAction').disabled, true);
      assert.equal(h.get('btnConfirmWorldPublication').disabled, true);
      h.get('worldEditTags').value = 'retained';
      assert.equal(await h.m.saveWorldEdit(), false, 'unknown reserved tags also block metadata save');
      assert.equal(await h.m.confirmWorldPublication(), false);
      h.setRoute(() => response(labs()));
      assert.equal(await h.m.refreshWorldPublicationStatus(), true);
      assert.equal(h.mutations().length, 1);
      assert.equal(h.get('worldEditTags').value, 'retained');
      assert.equal(h.get('worldEditReleaseStatus').textContent, 'Community Labs');
      assert.equal(h.get('btnWorldPublicationAction').disabled, false);
      assert.equal(h.get('btnConfirmWorldPublication').disabled, true);
    });
  }
});

test('200 does not invent public status; actual private/hidden response is displayed and old confirm is invalidated', async t => {
  for (const releaseStatus of ['private', 'hidden']) {
    await t.test(releaseStatus, async () => {
      const h = harness();
      await h.open();
      h.m.openWorldPublicationConfirm();
      h.setRoute((path, options) => options.method ? response(undefined, 200) : response(path.endsWith('/publish') ? { canPublish: true } : world({ releaseStatus })));
      const publicationResult = await h.m.confirmWorldPublication();
      assert.equal(publicationResult, releaseStatus === 'private');
      assert.equal(h.get('worldEditReleaseStatus').textContent, releaseStatus === 'private' ? 'Private' : 'Unknown / managed');
      assert.match(h.get('worldPublicationConfirmStatus').textContent, /state changed/);
      assert.equal(h.get('btnWorldPublicationAction').disabled, releaseStatus === 'private' ? false : true);
      assert.equal(await h.m.confirmWorldPublication(), false);
    });
  }
});

test('fresh preflight changed state reconciles under lock, retains drafts and cannot replay the old confirmation', async () => {
  const h = harness();
  await h.open();
  h.get('worldEditDescription').value = 'My unsaved description';
  h.m.openWorldPublicationConfirm();
  h.setRoute(() => response(labs({ name: 'Fresh Labs name' })));
  assert.equal(await h.m.confirmWorldPublication(), false);
  assert.equal(h.mutations().length, 0);
  assert.equal(h.updates.length, 1);
  assert.equal(h.get('worldEditName').value, 'Fresh Labs name');
  assert.equal(h.get('worldEditDescription').value, 'My unsaved description');
  assert.equal(h.get('worldEditReleaseStatus').textContent, 'Community Labs');
  assert.equal(h.get('btnConfirmWorldPublication').disabled, true);
  assert.equal(await h.m.confirmWorldPublication(), false);
  h.m.closeWorldPublicationConfirm();
  assert.equal(h.m.openWorldPublicationConfirm(), true, 'fresh withdrawal requires a new confirmation');
});

test('navigation/cancel/editor-close/session replacement during either preflight await cannot dispatch a write', async t => {
  for (const stage of ['detail', 'eligibility', 'detail-json', 'eligibility-json']) {
    for (const change of ['navigate', 'cancel', 'editor-close', 'session']) {
      await t.test(stage + '/' + change, async () => {
        const h = harness();
        await h.open();
        h.m.openWorldPublicationConfirm();
        const entered = deferred();
        const pause = deferred();
        h.setRoute(path => {
          const publish = path.endsWith('/publish');
          const body = publish ? { canPublish: true } : world();
          if (publish !== stage.startsWith('eligibility')) return response(body);
          if (stage.endsWith('json')) return response(body, 200, () => { entered.resolve(); return pause.promise; });
          entered.resolve();
          return pause.promise;
        });
        const result = h.m.confirmWorldPublication();
        await entered.promise;
        if (change === 'navigate') { h.switchDetail(); await h.open(); }
        if (change === 'cancel') h.m.closeWorldPublicationConfirm();
        if (change === 'editor-close') h.m.closeWorldEditModal();
        if (change === 'session') h.switchSession();
        const before = h.writes.length;
        pause.resolve(stage.endsWith('json') ? stage.startsWith('eligibility') ? { canPublish: true } : world() : response(stage === 'eligibility' ? { canPublish: true } : world()));
        assert.equal(await result, false);
        assert.equal(h.mutations().length, 0);
        if (change === 'session') assert.equal(h.writes.length, before, 'old-session finally cannot touch replacement DOM');
        if (change === 'navigate') assert.equal(h.get('worldEditId').textContent, B);
      });
    }
  }
});

test('already-dispatched A may sync same-account cache but never repaint/close B; replacement session cannot sync A', async t => {
  for (const replacement of ['B', 'same-world-editor', 'session']) {
    await t.test(replacement, async () => {
      const h = harness();
      await h.open();
      h.m.openWorldPublicationConfirm();
      const entered = deferred();
      const pause = deferred();
      h.setRoute((path, options) => {
        if (options.method) { entered.resolve(); return pause.promise; }
        return response(path.endsWith('/publish') ? { canPublish: true } : h.mutations().length ? labs() : world());
      });
      const result = h.m.confirmWorldPublication();
      await entered.promise;
      if (replacement === 'session') h.switchSession(OTHER);
      h.switchDetail(world({ id: replacement === 'same-world-editor' ? A : B, name: 'Replacement world', authorId: replacement === 'session' ? OTHER : OWNER }));
      await h.open();
      h.get('worldEditName').value = 'Replacement draft';
      const status = h.get('worldPublicationEligibility').textContent;
      pause.resolve(response(undefined, 204));
      assert.equal(await result, replacement !== 'session');
      assert.equal(h.get('worldEditModal').hidden, false);
      assert.equal(h.get('worldEditName').value, 'Replacement draft');
      assert.equal(h.get('worldDetailName').textContent, 'Replacement world');
      if (replacement === 'B') assert.equal(h.get('worldPublicationEligibility').textContent, status);
      assert.equal(h.cache.has(A), replacement !== 'session');
      assert.equal(h.updates.length, replacement === 'session' ? 0 : 1);
      if (h.updates.length) assert.equal(h.updates[0].options.isDetailCurrent(), false);
      assert.equal(h.mutations().length, 1);
    });
  }
});

test('duplicate publish and edit/delete share one lock across resets, retained through callback synchronization', async () => {
  const h = harness();
  await h.open();
  h.m.openWorldPublicationConfirm();
  const entered = deferred();
  const resume = deferred();
  h.setRoute(path => response(path.endsWith('/publish') ? { canPublish: true } : world()));
  h.onUpdate(async () => { entered.resolve(); await resume.promise; });
  const publishing = h.m.confirmWorldPublication();
  await entered.promise;
  assert.equal(await h.m.confirmWorldPublication(), false);
  h.get('worldEditName').value = 'Cannot overlap';
  assert.equal(await h.m.saveWorldEdit(), false);
  h.m.deleteCurrentWorld();
  assert.equal(h.get('worldPublicationConfirmModal').hidden, true);
  assert.equal(await h.m.confirmWorldDeletion(), false);
  assert.equal(h.get('btnConfirmWorldDelete').disabled, true);
  assert.equal(h.mutations().length, 1);
  resume.resolve();
  assert.equal(await publishing, true);
  assert.equal(h.get('worldDeleteConfirmModal').hidden, false);
  assert.equal(h.get('btnConfirmWorldDelete').disabled, false);
});

test('edit/delete flights block publication including reset/reopened editor and late initial eligibility cannot unlock it', async t => {
  for (const operation of ['edit', 'delete']) {
    await t.test(operation, async () => {
      const h = harness();
      await h.open();
      const pause = deferred();
      h.setRoute(() => pause.promise);
      if (operation === 'edit') h.get('worldEditName').value = 'Pending metadata';
      else h.m.deleteCurrentWorld();
      const result = operation === 'edit' ? h.m.saveWorldEdit() : h.m.confirmWorldDeletion();
      h.m.closeWorldEditModal();
      h.m.editCurrentWorld();
      assert.equal(h.get('btnWorldPublicationAction').disabled, true);
      assert.equal(h.m.openWorldPublicationConfirm(), false);
      pause.resolve(response({ error: 'Explicit rejection' }, 403));
      assert.equal(await result, false);
      assert.equal(h.mutations().length, 1);
    });
  }
});

test('hidden/unknown/contradictory/malformed/non-owner worlds deny publication without eligibility reads', async t => {
  for (const initial of [world({ releaseStatus: 'hidden' }), world({ releaseStatus: 'future-state' }), world({ tags: ['system_labs'] }), world({ tags: ['system_approved'] }), world({ tags: null }), world({ tags: ['author_tag_cozy', {}] }), world({ authorId: OTHER })]) {
    await t.test(JSON.stringify([initial.releaseStatus, initial.tags, initial.authorId]), async () => {
      const h = harness(initial);
      assert.equal(h.m.editCurrentWorld(), initial.authorId === OWNER);
      await tick();
      assert.equal(h.m.openWorldPublicationConfirm(), false);
      assert.equal(await h.m.confirmWorldPublication(), false);
      assert.equal(h.requests.length, 0);
    });
  }
});

test('late initial read is ignored after cancel/reset/reopen, detail owner change, deletion, or new same-account epoch', async () => {
  const h = harness();
  const pause = deferred();
  h.setRoute(() => pause.promise);
  h.m.editCurrentWorld();
  h.m.closeWorldEditModal();
  h.switchDetail(labs());
  await h.open();
  const state = h.get('worldPublicationEligibility').textContent;
  pause.resolve(response({ canPublish: false }));
  await tick();
  assert.equal(h.get('btnWorldPublicationAction').disabled, false);
  assert.equal(h.get('worldPublicationEligibility').textContent, state);
  h.m.deleteCurrentWorld();
  h.setRoute(() => response(undefined, 204));
  assert.equal(await h.m.confirmWorldDeletion(), true);
  assert.equal(h.m.editCurrentWorld(), false);
  assert.equal(h.m.openWorldPublicationConfirm(), false);
  assert.equal(await h.m.refreshWorldPublicationStatus(), false);
  h.switchSession();
  h.switchDetail(world());
  h.setRoute(() => response({ canPublish: true }));
  await h.open();
  assert.equal(h.get('btnWorldPublicationAction').disabled, false);
});

test('uncertain transport failure and post-write callback failure need read reconciliation, not mutation retry', async t => {
  for (const phase of ['transport', 'sync']) {
    await t.test(phase, async () => {
      const h = harness();
      await h.open();
      h.m.openWorldPublicationConfirm();
      h.setRoute((path, options) => {
        if (options.method) {
          if (phase === 'transport') throw new Error('Transport lost');
          return response(undefined, 204);
        }
        return response(path.endsWith('/publish') ? { canPublish: true } : h.mutations().length ? labs() : world());
      });
      if (phase === 'sync') h.onUpdate(() => { throw new Error('Cache failed'); });
      assert.equal(await h.m.confirmWorldPublication(), false);
      assert.equal(h.get('btnWorldPublicationAction').disabled, true);
      assert.equal(await h.m.confirmWorldPublication(), false);
      assert.match(h.get('worldPublicationConfirmStatus').textContent, phase === 'sync' ? /local view failed.*Cache failed/ : /outcome is unknown.*Transport lost/);
      h.onUpdate(null);
      h.setRoute(() => response(labs()));
      assert.equal(await h.m.refreshWorldPublicationStatus(), true);
      assert.equal(h.get('worldEditReleaseStatus').textContent, 'Community Labs');
      assert.equal(h.mutations().length, 1);
    });
  }
});

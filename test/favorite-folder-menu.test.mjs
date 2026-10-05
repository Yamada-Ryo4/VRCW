import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/js/favorite-menus.js', import.meta.url), 'utf8');
function harness(type, { deleteStatus = 200, addStatus = 200, full = false, staleOnDelete = false, multiple = false } = {}) {
  const id = type === 'avatar' ? 'avtr_a' : 'wrld_a';
  let records = [{ id: 'fav_old', favoriteId: id, tags: ['old'] }];
  if (multiple) records.push({ id: 'fav_other', favoriteId: id, tags: ['new'] });
  const calls = [];
  let current = true;
  const context = vm.createContext({
    favoriteIdMap: new Map(), worldFavoriteIdMap: new Map(), avatarFavTagMap: new Map(),
    avatarFavoriteIndexByGroup: new Map(), worldFavoriteIndexByGroup: new Map(),
    avatarFavGroupCounts: new Map(), worldFavGroupCounts: new Map(),
    favoriteGroups: [{ name: 'old' }, { name: 'new' }], worldFavGroups: [{ name: 'old' }, { name: 'new' }],
    localAvatarIdMap: new Map(), currentCategory: 'mine', currentWorldCategory: 'recent',
    document: { querySelectorAll: () => [], getElementById: () => null },
    makeAuthSessionToken: () => 1, isAuthSessionCurrent: () => current,
    _refreshDetailAfterFavChange() {}, _refreshWorldFavoriteMenuState() {},
    async removeAvatarFromFavoriteCache(...args) { calls.push(['cache-delete', ...args]); },
    async upsertAvatarIntoFavoriteCache(...args) { calls.push(['cache-add', ...args]); },
    async removeWorldFromFavoriteCache(...args) { calls.push(['cache-delete', ...args]); },
    async upsertWorldIntoFavoriteCache(...args) { calls.push(['cache-add', ...args]); },
    t: key => key, escHtml: value => String(value), escJsAttr: value => String(value),
    async apiCall(path, options = {}) {
      if (!options.method) {
        const list = path.includes('vrcPlusWorld') ? [] : [...records];
        if (full) for (let i = 0; i < (type === 'avatar' ? 50 : 100); i++) list.push({ id: 'fav_' + i, favoriteId: 'other_' + i, tags: ['new'] });
        const offset = Number(new URL(path, 'https://example.test').searchParams.get('offset')) || 0;
        return { ok: true, status: 200, async json() { return list.slice(offset, offset + 100); } };
      }
      calls.push([options.method, path, options.json]);
      if (options.method === 'DELETE') {
        if (staleOnDelete) current = false;
        if (deleteStatus < 300) records = records.filter(record => !path.endsWith('/' + record.id));
        return { ok: deleteStatus < 300, status: deleteStatus };
      }
      if (addStatus < 300) records = [{ id: 'fav_new', favoriteId: id, tags: ['new'] }];
      return { ok: addStatus < 300, status: addStatus, async json() { return addStatus < 300 ? { id: 'fav_new' } : { error: { message: 'add failed' } }; } };
    },
  });
  vm.runInContext(source, context);
  return { context, calls, id, change: group => vm.runInContext(`changeFavoriteFolder('${type}','${id}','${group}',{id:'${id}'})`, context) };
}

for (const type of ['avatar', 'world']) {
  test(`${type}: moving waits for DELETE before POST and replaces group/maps/caches`, async () => {
    const h = harness(type);
    await h.change('new');
    assert.deepEqual(h.calls.filter(call => ['DELETE', 'POST'].includes(call[0])).map(call => call[0]), ['DELETE', 'POST']);
    const map = type === 'avatar' ? h.context.favoriteIdMap : h.context.worldFavoriteIdMap;
    const counts = type === 'avatar' ? h.context.avatarFavGroupCounts : h.context.worldFavGroupCounts;
    assert.equal(map.get(h.id), 'fav_new');
    assert.equal(counts.get('old'), 0);
    assert.equal(counts.get('new'), 1);
    assert.equal(h.calls.some(call => call[0] === 'cache-delete' && call[1] === 'old'), true);
    assert.equal(h.calls.some(call => call[0] === 'cache-add' && call[1] === 'new'), true);
  });
  test(`${type}: clicking current group removes without adding`, async () => {
    const h = harness(type);
    await h.change('old');
    assert.deepEqual(h.calls.filter(call => ['DELETE', 'POST'].includes(call[0])).map(call => call[0]), ['DELETE']);
  });
  test(`${type}: DELETE failure prevents POST and retains prior membership`, async () => {
    const h = harness(type, { deleteStatus: 500 });
    await assert.rejects(h.change('new'), /HTTP 500/);
    assert.equal(h.calls.some(call => call[0] === 'POST'), false);
    assert.equal((type === 'avatar' ? h.context.favoriteIdMap : h.context.worldFavoriteIdMap).get(h.id), 'fav_old');
  });
  test(`${type}: POST failure exposes the successful removal instead of a false destination`, async () => {
    const h = harness(type, { addStatus: 500 });
    await assert.rejects(h.change('new'), /add failed/);
    assert.equal((type === 'avatar' ? h.context.favoriteIdMap : h.context.worldFavoriteIdMap).has(h.id), false);
  });
  test(`${type}: full destination rejects before deleting`, async () => {
    const h = harness(type, { full: true });
    await assert.rejects(h.change('new'), /world.favGroupFull/);
    assert.equal(h.calls.some(call => call[0] === 'DELETE'), false);
  });
  test(`${type}: duplicate clicks issue a single move`, async () => {
    const h = harness(type);
    await Promise.all([h.change('new'), h.change('new')]);
    assert.equal(h.calls.filter(call => call[0] === 'POST').length, 1);
  });
}

test('active menu row remains removable at capacity and uses green/checkmark styling', () => {
  const h = harness('avatar');
  h.context.avatarFavTagMap.set(h.id, new Set(['old']));
  h.context.avatarFavGroupCounts.set('old', 50);
  const html = vm.runInContext(`favoriteFolderRows('avatar','${h.id}',favoriteGroups)`, h.context);
  const active = html.match(/<button[^>]*data-favgroup="old"[^>]*>[\s\S]*?<\/button>/)[0];
  assert.match(active, /avtrdb-fav-group-active/);
  assert.match(active, /✓ old/);
  assert.doesNotMatch(active, / disabled/);
});

test('detail world star always opens folders; local actions live in the menu rather than header/footer', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const worlds = readFileSync(new URL('../public/js/worlds.js', import.meta.url), 'utf8');
  const menu = worlds.slice(worlds.indexOf('async function toggleWorldFavMenu'), worlds.indexOf('async function toggleWorldFavorite'));
  assert.doesNotMatch(menu, /toggleWorldFavorite\(\)/);
  assert.doesNotMatch(html, /id="worldDetail(?:Mobile)?LocalFavBtn"/);
  assert.match(worlds, /data-world-local-menu/);
  assert.match(worlds, /toggleWorldMenuLocalFavorite/);
});

for (const type of ['avatar', 'world']) {
  test(`${type}: a switched account aborts the move before POST and cache writes`, async () => {
    const h = harness(type, { staleOnDelete: true });
    await assert.rejects(h.change('new'), /toast.uidMissingRelogin/);
    assert.equal(h.calls.some(call => call[0] === 'POST' || call[0] === 'cache-delete'), false);
  });
}

test('world: moving to a VRC+ folder uses the VRC+ favorite type', async () => {
  const h = harness('world');
  h.context.worldFavGroups.push({ name: 'vrcPlusWorlds1' });
  await h.change('vrcPlusWorlds1');
  assert.equal(h.calls.find(call => call[0] === 'POST')[2].type, 'vrcPlusWorld');
});

test('world: sidebar counts and visible source list update together', async () => {
  const h = harness('world');
  const buttons = new Map([['worldCatFav_old', {}], ['worldCatFav_new', {}], ['worldStats', {}]]);
  h.context.document.getElementById = id => buttons.get(id) || null;
  h.context.currentWorldCategory = 'fav_old';
  h.context.allWorlds = [{ id: h.id }];
  h.context.selectedWorldIds = new Set([h.id]);
  let renders = 0;
  h.context.filterWorlds = () => { renders++; };
  await h.change('new');
  assert.equal(h.context.allWorlds.length, 0);
  assert.equal(h.context.selectedWorldIds.size, 0);
  assert.equal(buttons.get('worldCatFav_old').textContent, 'old (0/100)');
  assert.equal(buttons.get('worldCatFav_new').textContent, 'new (1/100)');
  assert.equal(buttons.get('worldStats').textContent, 'world.worldCount');
  assert.equal(renders, 1);
});

test('saved local world reopens with the shared star and a checked menu row', () => {
  const worlds = readFileSync(new URL('../public/js/worlds.js', import.meta.url), 'utf8');
  const from = worlds.indexOf('function _worldFavoriteMenuHtml(');
  const to = worlds.indexOf('async function toggleWorldMenuLocalFavorite(', from);
  const id = 'wrld_a';
  const classes = { toggle() {} };
  const buttons = new Map([
    ['worldDetailMainFavBtn', { classList: classes, setAttribute(name, value) { this[name] = value; } }],
    ['worldDetailFavBtn', { classList: classes, setAttribute(name, value) { this[name] = value; } }],
    ['worldFavMenu', { dataset: { worldId: id } }], ['worldFavGroupListMenu', {}],
  ]);
  const context = vm.createContext({
    currentWorldDetail: { id }, worldFavoriteIdMap: new Map(),
    localWorldFavIds: new Set([id]), localWorldIdMap: new Map([[id, true]]), worldFavGroups: [],
    document: { getElementById: id => buttons.get(id) || null },
    t: key => key, escHtml: String, escJsAttr: String, favoriteFolderRows: () => '',
  });
  vm.runInContext(worlds.slice(from, to), context);
  vm.runInContext(`_refreshWorldFavoriteMenuState('${id}')`, context);
  assert.equal(buttons.get('worldDetailMainFavBtn')['aria-pressed'], 'true');
  assert.match(buttons.get('worldFavGroupListMenu').innerHTML, /✓ world.localFavorites/);
  assert.match(buttons.get('worldFavGroupListMenu').innerHTML, /aria-pressed="true"/);
});

for (const type of ['avatar', 'world']) {
  test(`${type}: removing one checked folder preserves a separate record in another folder`, async () => {
    const h = harness(type, { multiple: true });
    await h.change('old');
    assert.deepEqual(h.calls.filter(call => call[0] === 'DELETE').map(call => call[1]), ['/api/vrc/favorites/fav_old']);
    assert.equal((type === 'avatar' ? h.context.favoriteIdMap : h.context.worldFavoriteIdMap).get(h.id), 'fav_other');
  });
}

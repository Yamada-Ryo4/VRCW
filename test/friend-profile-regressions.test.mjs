import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('public/index.html', root), 'utf8');
const friends = readFileSync(new URL('public/js/friends.js', root), 'utf8');
const profile = readFileSync(new URL('public/js/friend-profile.js', root), 'utf8');
const sidebar = readFileSync(new URL('public/js/sidebar-profile.js', root), 'utf8');
const common = readFileSync(new URL('public/js/common.js', root), 'utf8');
const shell = readFileSync(new URL('public/js/shell.js', root), 'utf8');
const actionShell = readFileSync(new URL('public/js/friend-profile-shell.js', root), 'utf8');
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => copy(body), text: async () => String(body?.error || 'Rejected') });
const friend = (id, state = 'active') => ({ id, displayName: id, state, status: state === 'offline' ? 'offline' : 'active', location: 'offline', tags: [], isFriend: true });
const favorite = id => ({ id: 'fav_' + id, favoriteId: id, type: 'friend', tags: ['group_0'] });
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function between(source, start, end) {
  const at = source.indexOf(start);
  const until = source.indexOf(end, at);
  assert.ok(at >= 0 && until > at);
  return source.slice(at, until);
}
const deleteSource = between(profile, 'async function deleteFriend(', 'async function sendFriendRequest(');
const syncSource = between(shell, 'async function syncAllFavoriteIds()', '// ── Favorite Groups');
const actionSource = between(actionShell, 'function getFriendProfileActionState(', 'function _renderFriendProfileUI(');
const statusSource = between(common, 'function getStatusLabel(', 'function getTrustInfo(');

function harness({ cacheFriends = [], cachedFavorites = [], category = 'all', route } = {}) {
  const elements = new Map();
  for (const id of ['sidebarMyMiniProfile', 'friendMyProfileView', 'friendListView', 'friendModlogView', 'friendNotificationsView', 'friendList', 'friendStats']) {
    elements.set(id, { innerHTML: '', textContent: '', style: {}, attributes: {}, isConnected: true,
      setAttribute(key, value) { this.attributes[key] = value; }, classList: { add() {}, remove() {} } });
  }
  const cache = new Map([['friend_basics', copy(cacheFriends)], ['friend_basics_age', 0], ['friend_favorite_map', copy(cachedFavorites)]]);
  const requests = [], writes = [], rendered = [], logs = [], pendingTimers = new Map();
  let timer = 0, routeFn = route, customSet = null, customGet = null;
  let context;
  const run = script => vm.runInContext(script, context);
  context = vm.createContext({
    console: { warn() {}, error() {}, log() {} }, URL, AbortController,
    document: { visibilityState: 'visible', getElementById: id => elements.get(id) || null, querySelectorAll: () => [] },
    navigator: {}, localStorage: { getItem() { return null; } },
    VRCW: { modules: {}, registerModule(name, handlers) { this.modules[name] = handlers; } },
    renderAppVersionInfo() {},
    t: (key, params = {}) => key + (params.count != null ? ':' + params.count : params.msg ? ':' + params.msg : ''),
    escHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    escJsAttr: value => String(value), escAttrJson: value => JSON.stringify(value),
    isVRCPlus: () => false, proxyImg: value => value, imageSrcAttrs: () => '', observeImages() {},
    getTrustInfo: () => ({ color: '#fff', label: 'Visitor' }), getLanguages: () => [],
    fetchMyModerations() {}, isAbortError: error => error?.name === 'AbortError',
    friendLogMsg: (message, type) => logs.push([message, type]), logMsg() {},
    setInterval() {},
    setTimeout(callback, delay) {
      if (delay === 200) { queueMicrotask(callback); return ++timer; }
      pendingTimers.set(++timer, callback); return timer;
    },
    clearTimeout(id) { pendingTimers.delete(id); },
    async apiCall(path, options = {}) {
      requests.push({ path, options });
      return routeFn ? routeFn(path, options) : response([]);
    },
    idb: {
      async get(key, session) { if (customGet) await customGet(key, session); return copy(cache.get(key)); },
      async set(key, value, session) {
        if (customSet) await customSet(key, value, session);
        if (session && !context.isAuthSessionCurrent(session)) return;
        writes.push({ key, value: copy(value), session }); cache.set(key, copy(value));
      },
    },
    confirm: () => true,
  });
  vm.runInContext(`
    window = globalThis;
    let currentUserId = 'usr_self';
    let currentTab = 'friends';
    let currentGlobalFetchSeq = 0;
    let epoch = 1;
    let friendFavoriteIdMap = new Map(${JSON.stringify(cachedFavorites)});
    let friendFavGroups = [{name:'group_0'}];
    let myModerations = [];
    function makeAuthSessionToken() { return Object.freeze({epoch, accountId:currentUserId}); }
    function isAuthSessionCurrent(token) { return !!token && token.epoch === epoch; }
    function runPriorityTask(work) { currentGlobalFetchSeq++; return Promise.resolve().then(work); }
    ${statusSource}
    ${friends}
    ${sidebar}
    ${deleteSource}
    ${actionSource}
    let closedProfileIds = [];
    closeFriendProfile = function() { closedProfileIds.push(currentFriendProfile?.id); currentFriendProfile = null; };
  `, context);
  context.__rendered = rendered;
  run(`renderMyProfile = function(user) { __rendered.push(JSON.parse(JSON.stringify(user))); document.getElementById('friendMyProfileView').innerHTML = user.displayName; };
    currentFriendCategory = ${JSON.stringify(category)}; allFriends = ${JSON.stringify(cacheFriends)};
    filterFriends = function() { document.getElementById('friendList').innerHTML = allFriends.filter(friend => !isFriendRemoved(friend.id) && (!currentFriendCategory.startsWith('fav_') || friendFavoriteIdMap.get(friend.id)?.tags.includes(currentFriendCategory.slice(4)))).map(friend => friend.id).join(','); };`);
  return {
    context, run, elements, cache, requests, writes, rendered, logs,
    state: () => copy(run('({allFriends, favoriteEntries:[...friendFavoriteIdMap], closedProfileIds, profile:currentFriendProfile, myProfileData})')),
    refresh: force => run(`fetchCurrentFriendCategory(${force !== false})`),
    delete: id => run(`deleteFriend(${JSON.stringify(id)},${JSON.stringify(id)})`),
    route(fn) { routeFn = fn; }, onSet(fn) { customSet = fn; }, onGet(fn) { customGet = fn; },
    switchSession() { run("epoch++; currentUserId='usr_other'; allFriends=[]; friendFavoriteIdMap=new Map(); myProfileData=null; window.myProfileData=null;"); },
    flushTimers() { for (const callback of pendingTimers.values()) callback(); pendingTimers.clear(); },
  };
}
function friendRoute({ online = [], offline = [], favorites = [], membership = null, renewed = false, profiles = {} } = {}) {
  return path => {
    if (path.endsWith('/auth/user')) return response({ id: 'usr_self', friends: membership || [...online, ...offline].map(user => user.id) });
    if (path.endsWith('/friendStatus')) return response({ isFriend: renewed, incomingRequest: false, outgoingRequest: false });
    if (path.startsWith('/api/vrc/users/')) {
      const id = path.slice('/api/vrc/users/'.length);
      if (profiles[id]) return response(profiles[id]);
      throw new Error('Unexpected user-detail request: ' + path);
    }
    if (path.includes('/auth/user/friends?')) {
      const url = new URL('https://fixture.test' + path);
      const users = url.searchParams.get('offline') === 'true' ? offline : online;
      const offset = Number(url.searchParams.get('offset'));
      return response(users.slice(offset, offset + 100));
    }
    if (path.includes('/favorites?')) return response(path.includes('tag=group_0') ? favorites : []);
    throw new Error('Unexpected user-detail request: ' + path);
  };
}

test('sidebar status has a localized fallback instead of question marks or bio, and both mouse/keyboard use the old full-profile category', async () => {
  const h = harness();
  const mini = h.elements.get('sidebarMyMiniProfile');
  h.run("myProfileData={id:'usr_self'}; renderSidebarMiniProfile({displayName:'Profile <fixture>', state:'active', status:'ask me', statusDescription:'', bio:'not a status'});");
  assert.match(mini.innerHTML, /stat\.webOnline/);
  assert.doesNotMatch(mini.innerHTML, /\?{4,}|not a status/);
  assert.match(mini.innerHTML, /Profile &lt;fixture>/);
  assert.equal(mini.attributes.role, 'button');
  assert.equal(mini.attributes.tabindex, '0');
  h.run("switchFriendCategory = function(cat) { window.selectedCategory=cat; }; ");
  mini.onclick();
  assert.equal(h.context.selectedCategory, 'myprofile');
  for (const key of ['Enter', ' ']) {
    h.context.selectedCategory = null;
    let prevented = false;
    mini.onkeydown({ key, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(h.context.selectedCategory, 'myprofile');
  }
  h.run("renderSidebarMiniProfile({displayName:'Profile',state:'offline',statusDescription:'  Hello <there>  '});");
  assert.match(mini.innerHTML, /Hello &lt;there>/);
  assert.doesNotMatch(html, /id="friendCatMyprofile"|data-i18n="friend.fullProfile"/);
});

test('name click switches from a friend list to visible inline profile even with an existing cached profile', async () => {
  const h = harness({ category: 'fav_group_0', route: path => response(path.endsWith('/auth/user') ? {id:'usr_self',displayName:'Self',state:'active'} : {id:'usr_self',state:'active',location:'offline'}) });
  h.run("myProfileData={id:'usr_self',displayName:'Cached Self'}; renderSidebarMiniProfile(myProfileData);");
  h.elements.get('friendMyProfileView').style.display = 'none';
  h.elements.get('friendListView').style.display = 'flex';
  h.elements.get('sidebarMyMiniProfile').onclick();
  await tick();
  await tick();
  assert.equal(h.run('currentFriendCategory'), 'myprofile');
  assert.equal(h.elements.get('friendMyProfileView').style.display, 'block');
  assert.equal(h.elements.get('friendListView').style.display, 'none');
  assert.equal(h.elements.get('friendMyProfileView').innerHTML, 'Self');
});

test('background profile refresh cannot hide a visible list and old session/enrichment responses cannot replace a new profile', async () => {
  const fresh = deferred();
  const full = deferred();
  const h = harness({ category: 'all', route: path => path.endsWith('/auth/user') ? fresh.promise : full.promise });
  h.elements.get('friendListView').style.display = 'flex';
  const refresh = h.run('fetchMyProfile()');
  fresh.resolve(response({id:'usr_self',displayName:'Self',state:'active'}));
  await refresh;
  assert.equal(h.elements.get('friendListView').style.display, 'flex');
  assert.equal(h.rendered.length, 0);
  h.switchSession();
  h.run("myProfileData={id:'usr_other',displayName:'Other'};");
  full.resolve(response({id:'usr_self',state:'online',location:'private'}));
  await tick();
  assert.equal(h.run('myProfileData.id'), 'usr_other');
  assert.equal(h.writes.filter(write => write.session?.epoch === 2).length, 0);
});

test('complete refresh prunes stale list/cache/favorite users, preserves real offline friends, and never hydrates ghosts via user detail', async () => {
  const keep = friend('usr_keep'), offline = friend('usr_offline','offline'), ghost = friend('usr_ghost');
  for (const category of ['all','online','fav_group_0']) {
    const h = harness({ category, cacheFriends:[keep,ghost,offline], cachedFavorites:[['usr_ghost',{favoriteId:'fav_ghost',tags:['group_0']}]],
      route:friendRoute({online:[keep],offline:[offline],favorites:[favorite('usr_ghost'),favorite('usr_keep'),favorite('usr_offline')]}) });
    await h.refresh();
    assert.deepEqual(h.state().allFriends.map(user => user.id), ['usr_keep','usr_offline']);
    assert.deepEqual(h.state().favoriteEntries.map(([id]) => id).sort(), ['usr_keep','usr_offline']);
    assert.deepEqual(h.cache.get('friend_basics').map(user => user.id), ['usr_keep','usr_offline']);
    assert.deepEqual(h.cache.get('friend_favorite_map').map(([id]) => id).sort(), ['usr_keep','usr_offline']);
    assert.equal(h.requests.some(({path}) => path.startsWith('/api/vrc/users/')), false);
    await h.refresh(false);
    assert.equal(h.state().allFriends.some(user => user.id === 'usr_ghost'), false);
    assert.equal(h.run("isCurrentFriend({id:'usr_ghost',isFriend:true})"), false);
  }
});

test('complete empty snapshot clears stale basics, while HTTP/malformed/partial/transport failures never prune unconfirmed friends', async () => {
  const old = friend('usr_old');
  const empty = harness({cacheFriends:[old], route:friendRoute()});
  await empty.refresh();
  assert.deepEqual(empty.cache.get('friend_basics'), []);
  for (const failure of [response([],503), response({error:'bad'}), response([null]), 'transport', 'later-page']) {
    const h = harness({cacheFriends:[old]});
    h.route(path => {
      if (path.includes('/favorites?')) return response([]);
      if (path.includes('offline=false')) return response([]);
      if (failure === 'transport') throw new Error('Network lost');
      if (failure === 'later-page') return path.includes('offset=0&') ? response(Array.from({length:100},(_,i)=>friend('usr_'+i,'offline'))) : response([],503);
      return failure;
    });
    await h.refresh();
    assert.equal(h.state().allFriends.some(user => user.id === 'usr_old'), true);
    assert.equal(h.cache.get('friend_basics').some(user => user.id === 'usr_old'), true);
    assert.equal(h.cache.get('friend_basics_age'), 0);
  }
});

test('pagination reads the final page after 3000 friends before pruning', async () => {
  const users = Array.from({length:3001},(_,i)=>friend('usr_'+i,'offline'));
  const h = harness({cacheFriends:[friend('usr_old')],route:friendRoute({offline:users})});
  await h.refresh();
  assert.equal(h.state().allFriends.length, 3001);
  assert.equal(h.cache.get('friend_basics').some(user => user.id === 'usr_3000'), true);
  assert.equal(h.requests.some(({path}) => path.includes('offset=3000&offline=true')), true);
});

test('partial favorite refresh preserves its previous map but cannot resurrect a user outside a complete friend snapshot', async () => {
  const h = harness({cacheFriends:[friend('usr_old')],cachedFavorites:[['usr_old',{favoriteId:'fav_old',tags:['group_1']}]]});
  const route = friendRoute();
  h.route(path => path.includes('tag=group_2') ? response([],503) : route(path));
  await h.refresh();
  assert.deepEqual(h.state().favoriteEntries,[['usr_old',{favoriteId:'fav_old',tags:['group_1']}]]);
  assert.deepEqual(h.state().allFriends,[]);
  assert.equal(h.writes.some(write => write.key === 'friend_favorite_map'),false);
});

test('successful deletion persists removal even if server favorites and cached user detail remain, cancels stale refresh, and does not close B', async () => {
  const removed = friend('usr_remove'), keep = friend('usr_keep');
  const h = harness({cacheFriends:[removed,keep],cachedFavorites:[['usr_remove',{favoriteId:'fav_remove',tags:['group_0']}]],category:'fav_group_0'});
  const pause = deferred();
  h.route((path, options) => options.method === 'DELETE' ? response({},204) : path.includes('/auth/user/friends?') ? pause.promise : response([favorite('usr_remove')]));
  h.run("currentFriendProfile={id:'usr_remove'}; window._fpCurrentSeq=1;");
  const refreshing = h.refresh();
  await tick();
  h.run("currentFriendProfile={id:'usr_B'}; window._fpCurrentSeq=2;");
  assert.equal(await h.delete('usr_remove'),true);
  pause.resolve(response([removed,keep]));
  await refreshing;
  assert.equal(h.state().profile.id,'usr_B');
  assert.deepEqual(h.state().closedProfileIds,[]);
  assert.deepEqual(h.cache.get('friend_basics').map(user=>user.id),['usr_keep']);
  assert.deepEqual(h.cache.get('friend_favorite_map'),[]);
  h.route(friendRoute({online:[removed,keep],favorites:[favorite('usr_remove')],renewed:false}));
  await h.refresh();
  assert.deepEqual(h.state().allFriends.map(user=>user.id),['usr_keep']);
  assert.equal(h.run("isCurrentFriend({id:'usr_remove',isFriend:true})"),false);
  assert.equal(await h.delete('usr_remove'),false);
  assert.equal(h.requests.filter(request=>request.options.method==='DELETE').length,1);
});

test('cancel/rejection/duplicate delete and old-account completion preserve the appropriate session state', async () => {
  for (const outcome of ['cancel','failure','session','duplicate']) {
    const h = harness({cacheFriends:[friend('usr_remove')],cachedFavorites:[['usr_remove',{favoriteId:'fav_remove',tags:['group_0']}]]});
    const pause = deferred();
    h.route(() => outcome==='failure' ? response({error:'Rejected'},503) : pause.promise);
    if (outcome==='cancel') h.context.confirm=()=>false;
    const running = h.delete('usr_remove');
    if (outcome==='session') { h.switchSession(); pause.resolve(response({},204)); }
    if (outcome==='duplicate') { assert.equal(await h.delete('usr_remove'),false); pause.resolve(response({},204)); }
    const success = await running;
    assert.equal(success,outcome==='duplicate');
    if (outcome==='session') { assert.deepEqual(h.state().allFriends,[]); assert.equal(h.writes.length,0); }
    else if (outcome!=='duplicate') { assert.equal(h.state().allFriends.length,1); assert.equal(h.writes.length,0); }
    assert.equal(h.requests.filter(request=>request.options.method==='DELETE').length,outcome==='cancel'?0:1);
  }
});

test('serialized cache writes cannot finish after deletion and resurrect stale basics', async () => {
  const h = harness({cacheFriends:[friend('usr_remove'),friend('usr_keep')],route:friendRoute({online:[friend('usr_remove'),friend('usr_keep')]})});
  const entered = deferred(), pause = deferred();
  let paused = false;
  h.onSet(async key => { if(key==='friend_basics' && !paused) { paused=true; entered.resolve(); await pause.promise; } });
  const refresh=h.refresh();
  await entered.promise;
  h.route(()=>response({},204));
  const deleting=h.delete('usr_remove');
  await tick();
  pause.resolve();
  await Promise.all([refresh,deleting]);
  assert.deepEqual(h.cache.get('friend_basics').map(user=>user.id),['usr_keep']);
  assert.equal(h.cache.get('friend_basics_age'),0);
});

test('category/session changes during paged read cannot commit stale friendship snapshots or cache into the new session', async () => {
  for(const change of ['category','session']) {
    const entered=deferred(), pause=deferred();
    const h=harness({cacheFriends:[friend('usr_old')],route:()=>{entered.resolve();return pause.promise;}});
    const running=h.refresh();
    await entered.promise;
    if(change==='session') h.switchSession();
    else h.run("currentFriendCategory='myprofile';");
    pause.resolve(response([friend('usr_late')]));
    await running;
    assert.equal(h.writes.length,0);
    assert.equal(h.state().allFriends.some(user=>user.id==='usr_late'),false);
  }
});

test('presence transitions during online/offline enumeration do not remove a real friend from the authenticated membership list', async () => {
  const h = harness({ cacheFriends: [friend('usr_switch')], cachedFavorites: [['usr_switch', {favoriteId:'fav_switch', tags:['group_0']}]],
    route: friendRoute({membership:['usr_switch'],favorites:[favorite('usr_switch')]}) });
  await h.refresh();
  assert.deepEqual(h.state().allFriends.map(user=>user.id),['usr_switch']);
  assert.equal(h.run("isCurrentFriend({id:'usr_switch'})"),true);
  assert.equal(h.cache.get('friend_favorite_map').length,1);
});

test('new positive friend pages extend the previous snapshot even if a later offline page fails', async () => {
  const h=harness({route:friendRoute({online:[friend('usr_old')]})});
  await h.refresh();
  const normal=friendRoute({online:[friend('usr_old'),friend('usr_new')]});
  h.route(path=>path.includes('offline=true')?response([],503):normal(path));
  await h.refresh();
  assert.equal(h.run("isCurrentFriend({id:'usr_new'})"),true);
});

test('renewed friendship lifts deletion barrier only after explicit friend-status confirmation', async () => {
  const h=harness({cacheFriends:[friend('usr_return')]});
  h.route(()=>response({},204));
  await h.delete('usr_return');
  h.route(friendRoute({online:[friend('usr_return')],renewed:false}));
  await h.refresh();
  assert.deepEqual(h.state().allFriends,[]);
  h.route(friendRoute({online:[friend('usr_return')],renewed:true,profiles:{usr_return:friend('usr_return')}}));
  await h.refresh();
  assert.equal(h.run("isCurrentFriend({id:'usr_return'})"),true);
  assert.equal(h.cache.get('friend_basics').length,1);
});

test('missing/malformed/failed authenticated membership does not permit destructive pruning', async () => {
  for(const result of [response({id:'usr_self'}),response({id:'usr_wrong',friends:[]}),response({id:'usr_self',friends:[null]}),response({},503)]) {
    const h=harness({cacheFriends:[friend('usr_uncertain')]});
    h.route(path=>path.endsWith('/auth/user')?result:response([]));
    await h.refresh();
    assert.equal(h.state().allFriends.length,1);
    assert.equal(h.cache.get('friend_basics_age'),0);
  }
});

test('bulk friend cache refresh uses the same session/revision/queue and cannot overwrite successful deletion', async () => {
  const h=harness({cacheFriends:[friend('usr_remove'),friend('usr_keep')],route:friendRoute({online:[friend('usr_remove'),friend('usr_keep')]})});
  const entered=deferred(),pause=deferred();let first=true;
  h.onSet(async key=>{if(key==='friend_basics'&&first){first=false;entered.resolve();await pause.promise;}});
  const refreshing=h.run('refreshFriendPersistentCache(makeAuthSessionToken(),friendListRevision)');
  await entered.promise;
  h.route(()=>response({},204));
  const deleting=h.delete('usr_remove');
  await tick();pause.resolve();await Promise.all([refreshing,deleting]);
  assert.deepEqual(h.cache.get('friend_basics').map(user=>user.id),['usr_keep']);
  assert.equal(h.cache.get('friend_basics_age'),0);
  assert.match(shell,/refreshFriendPersistentCache\(friendSession, friendRevision\)/);
  const bulk=between(shell,'async function refreshAllPersistentCache()', '// ── Categories');
  assert.doesNotMatch(bulk,/idb\.set\('friend_basics'/);
});

test('late global favorite index sync cannot reinstate friend membership after a successful deletion', async () => {
  const h=harness({cacheFriends:[friend('usr_remove')]});
  h.run(`let favoriteIdMap=new Map(), avatarFavTagMap=new Map(), worldFavoriteIdMap=new Map(), avatarFavGroupCounts=new Map(), worldFavGroupCounts=new Map(), avatarFavoriteIndexByGroup=new Map(), worldFavoriteIndexByGroup=new Map(); function _rememberFavoriteIndex() {} ${syncSource}`);
  const entered=deferred(), pause=deferred();
  h.route((path,options)=>options.method==='DELETE'?response({},204):path.includes('type=friend')?(entered.resolve(),pause.promise):response([]));
  const syncing=h.run('syncAllFavoriteIds()');
  await entered.promise;
  await h.delete('usr_remove');
  pause.resolve(response([favorite('usr_remove')]));
  await syncing;
  assert.deepEqual(h.state().favoriteEntries,[]);
});

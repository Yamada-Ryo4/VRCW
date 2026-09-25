/*
 * VRCW — shell.js
 * 收藏同步/收藏分组/前台加载编排/标签与设置/加入偏好/缓存统计
 *
 * 注意：本项目为「经典脚本」(非 ES module)，全部按顺序加载、共享全局作用域。
 * 函数声明会提升为全局，跨文件调用没问题；请勿改为 type="module"。
 */
// ── Sync All Favorites Globally ──
let avatarFavoriteIndexByGroup = new Map();
let worldFavoriteIndexByGroup = new Map();

function _rememberFavoriteIndex(map, groupName, itemId) {
  if (!groupName || !itemId) return;
  let ids = map.get(groupName);
  if (!ids) { ids = []; map.set(groupName, ids); }
  ids.push(itemId);
}

async function syncAllFavoriteIds() {
  const sessionToken = makeAuthSessionToken();
  const current = () => isAuthSessionCurrent(sessionToken);
  try {
    if (!current()) return false;
    const nextFavoriteIdMap = new Map();
    const nextAvatarFavTagMap = new Map();
    const nextWorldFavoriteIdMap = new Map();
    const nextAvatarFavGroupCounts = new Map();
    const nextWorldFavGroupCounts = new Map();
    const nextFriendFavoriteIdMap = new Map();
    const nextAvatarFavoriteIndexByGroup = new Map();
    const nextWorldFavoriteIndexByGroup = new Map();



    // 1. Avatars
    let offset = 0;
    while (true) {
      if (!current()) return false;
      const resp = await apiCall(`/api/vrc/favorites?type=avatar&n=100&offset=${offset}`, { noAbort: true });
      if (!current()) return false;
      if (!resp.ok) throw new Error(`Avatar favorites HTTP ${resp.status}`);
      const favs = await resp.json();
      if (!favs || favs.length === 0) break;
      if (favs.error) throw new Error('Avatar favorites returned error');
      favs.forEach((f) => {
        nextFavoriteIdMap.set(f.favoriteId, f.id);
        const tag = f.tags?.[0];
        if (tag) {
          nextAvatarFavGroupCounts.set(tag, (nextAvatarFavGroupCounts.get(tag) || 0) + 1);
          _rememberFavoriteIndex(nextAvatarFavoriteIndexByGroup, tag, f.favoriteId);
          // Track which group(s) this avatar is favorited into
          const existing = nextAvatarFavTagMap.get(f.favoriteId);
          if (existing) existing.add(tag);
          else nextAvatarFavTagMap.set(f.favoriteId, new Set([tag]));
        }
      });
      if (favs.length < 100) break;
      offset += 100;
      if (offset >= 500) break;
    }
    // 2. Worlds (standard + VRC+ extra slots)
    for (const worldFavType of ['world', 'vrcPlusWorld']) {
      offset = 0;
      while (true) {
        if (!current()) return false;
        const resp = await apiCall(`/api/vrc/favorites?type=${worldFavType}&n=100&offset=${offset}`, { noAbort: true });
        if (!current()) return false;
        if (!resp.ok) {
          if (worldFavType === 'vrcPlusWorld' && (resp.status === 403 || resp.status === 404)) break;
          throw new Error(`${worldFavType} favorites HTTP ${resp.status}`);
        }
        const favs = await resp.json();
        if (!favs || favs.length === 0) break;
        if (favs.error) throw new Error(`${worldFavType} favorites returned error`);
        favs.forEach((f) => {
          nextWorldFavoriteIdMap.set(f.favoriteId, f.id);
          const tag = f.tags?.[0];
          if (tag) {
            nextWorldFavGroupCounts.set(tag, (nextWorldFavGroupCounts.get(tag) || 0) + 1);
            _rememberFavoriteIndex(nextWorldFavoriteIndexByGroup, tag, f.favoriteId);
          }
        });

        if (favs.length < 100) break;
        offset += 100;
      }
    }
    // 3. Friends — store as { favoriteId, tags } to match the per-category refresh
    // shape (friends.js:443). Friend favorites are not part of the persistent
    // avatar/world cache rewrite, so a friend-only failure should not block the
    // startup IDB index sync.
    let friendSyncFailed = false;
    try {
      offset = 0;
      while (true) {
        if (!current()) return false;
        const resp = await apiCall(`/api/vrc/favorites?type=friend&n=100&offset=${offset}`, { noAbort: true });
        if (!current()) return false;
        if (!resp.ok) throw new Error(`Friend favorites HTTP ${resp.status}`);
        const favs = await resp.json();
        if (!favs || favs.length === 0) break;
        if (favs.error) throw new Error('Friend favorites returned error');
        favs.forEach((f) => {
          const tag = f.tags?.[0] || 'group_0';
          const existing = nextFriendFavoriteIdMap.get(f.favoriteId);
          if (existing && existing.tags) {
            if (!existing.tags.includes(tag)) existing.tags.push(tag);
          } else {
            nextFriendFavoriteIdMap.set(f.favoriteId, { favoriteId: f.id, tags: [tag] });
          }
        });
        if (favs.length < 100) break;
        offset += 100;
      }
    } catch (e) {
      friendSyncFailed = true;
      console.warn("Friend favorite sync failed", e);
    }

    if (!current()) return false;
    favoriteIdMap = nextFavoriteIdMap;
    avatarFavTagMap = nextAvatarFavTagMap;
    worldFavoriteIdMap = nextWorldFavoriteIdMap;
    avatarFavGroupCounts = nextAvatarFavGroupCounts;
    worldFavGroupCounts = nextWorldFavGroupCounts;
    if (!friendSyncFailed) friendFavoriteIdMap = nextFriendFavoriteIdMap;
    avatarFavoriteIndexByGroup = nextAvatarFavoriteIndexByGroup;
    worldFavoriteIndexByGroup = nextWorldFavoriteIndexByGroup;

    logMsg(t('log.favoritesSynced', {avatar: favoriteIdMap.size, world: worldFavoriteIdMap.size, friend: friendFavoriteIdMap.size}), "info");
    return true;
  } catch (e) {
    if (!current()) return false;
    console.warn("Failed to sync favorite IDs", e);
    return false;
  }
}

// ── Favorite Groups (dynamic sidebar) ──
function _sortFavoriteGroups(list, type) {
  const arr = Array.isArray(list) ? list : [];
  if (type === 'avatar') return arr.filter(x => x.name && x.name.startsWith('avatars')).sort((a,b) => a.name.localeCompare(b.name, undefined, {numeric:true}));
  if (type === 'world') return arr.filter(x => x.name && (x.name.startsWith('worlds') || x.name.startsWith('vrcPlusWorlds'))).sort((a,b) => a.name.localeCompare(b.name, undefined, {numeric:true}));
  return arr.filter(x => x.name && (x.name.startsWith('group_') || x.name === 'friends')).sort((a,b) => a.name.localeCompare(b.name, undefined, {numeric:true}));
}

function _renderFavoriteGroupsForType(type, groups) {
  if (type === 'avatar') {
    favoriteGroups = _sortFavoriteGroups(groups, 'avatar');
    renderFavoriteGroupButtons();
  } else if (type === 'world') {
    worldFavGroups = _sortFavoriteGroups(groups, 'world');
    if (typeof renderWorldFavGroupButtons === 'function') renderWorldFavGroupButtons();
  } else {
    friendFavGroups = _sortFavoriteGroups(groups, 'friend');
    renderFriendFavGroupButtons();
  }
}

async function _loadCachedFavoriteGroups() {
  const sessionToken = makeAuthSessionToken();
  const entries = [
    ['avatar', 'favorite_groups_avatar'],
    ['world', 'favorite_groups_world'],
    ['friend', 'favorite_groups_friend'],
  ];
  await Promise.all(entries.map(async ([type, key]) => {
    const cached = await idb.get(key).catch(() => null);
    if (isAuthSessionCurrent(sessionToken) && Array.isArray(cached)) _renderFavoriteGroupsForType(type, cached);
  }));
}

async function _refreshFavoriteGroupsFromRemote() {
  const sessionToken = makeAuthSessionToken();
  const specs = [
    ['avatar', 'favorite_groups_avatar', '/api/vrc/favorite/groups?type=avatar&n=50'],
    ['world', 'favorite_groups_world', '/api/vrc/favorite/groups?type=world&n=50'],
    ['friend', 'favorite_groups_friend', '/api/vrc/favorite/groups?type=friend&n=50'],
  ];
  await Promise.allSettled(specs.map(async ([type, key, url]) => {
    const r = await apiCall(url, { noAbort: true });
    if (!r.ok) return;
    const groups = await r.json();
    if (!isAuthSessionCurrent(sessionToken) || !Array.isArray(groups)) return;
    await idb.set(key, groups).catch(() => {});
    if (isAuthSessionCurrent(sessionToken)) _renderFavoriteGroupsForType(type, groups);
  }));
}

async function fetchFavoriteGroups() {
  const sessionToken = makeAuthSessionToken();
  // IDB-first: draw sidebar group buttons immediately, then refresh remote in
  // the background. Do not block startup on VRChat favorite-group endpoints.
  await _loadCachedFavoriteGroups();
  if (!isAuthSessionCurrent(sessionToken)) return;
  _refreshFavoriteGroupsFromRemote().catch(e => console.warn("Could not fetch favorite groups", e));
}
function renderFriendFavGroupButtons() {
  const container = document.getElementById('friendFavGroupList');
  if (!container) return;
  if (!friendFavGroups.length) {
    container.innerHTML = `<div style="font-size:0.75em;color:var(--text-muted);padding:4px 0;">${t('shell.noFavGroups')}</div>`;
    return;
  }
  container.innerHTML = friendFavGroups.map(g =>
    makeCatBtn(`<i class="fa-solid fa-star"></i> ${escHtml(g.displayName || g.name)}`, `switchFriendCategory('fav_${escJsAttr(g.name)}')`, `friendCatFav_${g.name}`)
  ).join('');
}

function _idsMatchSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function _avatarBasicFromFavoriteItem(av) {
  const id = av && (av.id || av.vrc_id);
  if (!id) return null;
  return {
    id,
    name: av.name,
    thumbnailImageUrl: av.thumbnailImageUrl || av.image_url,
    imageUrl: av.imageUrl || av.image_url,
    releaseStatus: av.releaseStatus,
    authorId: av.authorId || av.author_id || av.author?.id,
    tags: av.tags
  };
}

function _worldBasicFromItem(w) {
  if (!w || !w.id) return null;
  return {
    id: w.id,
    name: w.name,
    thumbnailImageUrl: w.thumbnailImageUrl,
    imageUrl: w.imageUrl,
    authorName: w.authorName,
    authorId: w.authorId,
    occupants: w.occupants,
    releaseStatus: w.releaseStatus,
    isInvalid: !!w.isInvalid,
    favoriteId: w.favoriteId || worldFavoriteIdMap.get(w.id) || null,
    platforms: w.platforms || null,
    unityPackages: w.unityPackages || null,
    description: w.description || '',
    updatedAt: w.updated_at || w.updatedAt || null
  };
}

async function _removeFromListCache(fullKey, basicsKey, ageKey, itemId) {
  const sessionToken = makeAuthSessionToken();
  let changed = false;
  try {
    const basics = await idb.get(basicsKey);
    if (!isAuthSessionCurrent(sessionToken)) return false;
    if (Array.isArray(basics)) {
      const nextBasics = basics.filter(item => item && (item.id || item.vrc_id) !== itemId);
      if (nextBasics.length !== basics.length) {
        await idb.set(basicsKey, nextBasics);
        changed = true;
      }
    }
  } catch (_) {}

  if (!isAuthSessionCurrent(sessionToken)) return false;
  if (fullKey) {
    try {
      const full = await idb.get(fullKey);
      if (!isAuthSessionCurrent(sessionToken)) return false;
      if (Array.isArray(full)) {
        const nextFull = full.filter(item => item && (item.id || item.vrc_id) !== itemId);
        if (nextFull.length !== full.length) await idb.set(fullKey, nextFull);
      }
    } catch (_) {}
  }

  if (isAuthSessionCurrent(sessionToken) && changed && ageKey) {
    try { await idb.set(ageKey, Date.now()); } catch (_) {}
  }
  return changed;
}

async function _upsertIntoListCache(fullKey, basicsKey, ageKey, item, toBasic) {
  const sessionToken = makeAuthSessionToken();
  const basic = toBasic(item);
  if (!basic || !basic.id) {
    if (ageKey) {
      try { await idb.set(ageKey, 0); } catch (_) {}
    }
    return false;
  }

  try {
    const basics = await idb.get(basicsKey);
    if (!isAuthSessionCurrent(sessionToken)) return false;
    if (Array.isArray(basics)) {
      const nextBasics = basics.filter(existing => existing && existing.id !== basic.id);
      nextBasics.unshift(basic);
      await idb.set(basicsKey, nextBasics);
      if (!isAuthSessionCurrent(sessionToken)) return false;
      if (ageKey) await idb.set(ageKey, Date.now());
    } else if (ageKey) {
      await idb.set(ageKey, 0);
    }
  } catch (_) {}

  if (!isAuthSessionCurrent(sessionToken)) return false;
  if (fullKey) {
    try {
      const full = await idb.get(fullKey);
      if (!isAuthSessionCurrent(sessionToken)) return false;
      if (Array.isArray(full)) {
        const fullItem = item.id ? item : Object.assign({}, item, { id: basic.id });
        const nextFull = full.filter(existing => existing && (existing.id || existing.vrc_id) !== basic.id);
        nextFull.unshift(fullItem);
        await idb.set(fullKey, nextFull);
      }
    } catch (_) {}
  }
  return true;
}

async function removeAvatarFromFavoriteCache(groupName, avatarId) {
  if (!groupName || !avatarId) return;
  await _removeFromListCache(
    'avatars_' + groupName,
    'avatar_basics_' + groupName,
    'avatar_basics_age_' + groupName,
    avatarId
  );
}

async function upsertAvatarIntoFavoriteCache(groupName, av) {
  if (!groupName || !av) return;
  await _upsertIntoListCache(
    'avatars_' + groupName,
    'avatar_basics_' + groupName,
    'avatar_basics_age_' + groupName,
    av,
    _avatarBasicFromFavoriteItem
  );
}

function _worldCacheKey(category) {
  return (typeof WORLD_CACHE_PREFIX === 'string' ? WORLD_CACHE_PREFIX : 'world_basics_v2_') + category;
}

async function removeWorldFromFavoriteCache(groupName, worldId) {
  if (!groupName || !worldId) return;
  await _removeFromListCache(
    null,
    _worldCacheKey('fav_' + groupName),
    'world_basics_age_fav_' + groupName,
    worldId
  );
}

async function upsertWorldIntoFavoriteCache(groupName, world) {
  if (!groupName || !world) return;
  await _upsertIntoListCache(
    null,
    _worldCacheKey('fav_' + groupName),
    'world_basics_age_fav_' + groupName,
    world,
    typeof _worldBasicForWorldsCache === 'function' ? _worldBasicForWorldsCache : _worldBasicFromItem
  );
}

async function _fetchWorldFavoriteIndex(groupName) {
  const sessionToken = makeAuthSessionToken();
  const favType = typeof _worldFavTypeForGroup === 'function'
    ? _worldFavTypeForGroup(groupName)
    : (String(groupName || '').startsWith('vrcPlusWorlds') ? 'vrcPlusWorld' : 'world');
  const ids = [];
  let offset = 0;
  while (true) {
    if (!isAuthSessionCurrent(sessionToken)) throw _staleAuthSessionError();
    const resp = await apiCall(`/api/vrc/favorites?type=${favType}&tag=${groupName}&n=100&offset=${offset}`, { noAbort: true });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const favs = await resp.json();
    if (!isAuthSessionCurrent(sessionToken)) throw _staleAuthSessionError();
    if (!Array.isArray(favs) || favs.length === 0 || favs.error) break;
    favs.forEach((f) => {
      if (f.favoriteId) {
        ids.push(f.favoriteId);
        if (f.id) worldFavoriteIdMap.set(f.favoriteId, f.id);
      }
    });
    if (favs.length < 100) break;
    offset += 100;
  }
  return ids;
}

async function _fetchWorldBasicsByIds(ids, seqToken) {
  const all = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    if (seqToken && seqToken.cancelled) return all;
    const chunk = ids.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(chunk.map((wid) =>
      apiCall(`/api/vrc/worlds/${wid}`, { noAbort: true }).then(async (res) => {
        if (res.status === 404 || res.status === 403) return { id: wid, name: t('shell.invalidWorld'), isInvalid: true };
        return res.ok ? res.json() : { id: wid, name: t('shell.loadFail'), isInvalid: true };
      })
    ));
    results.forEach((r) => { if (r.status === 'fulfilled') all.push(r.value); });
  }
  return all.map(_worldBasicFromItem).filter(Boolean);
}

async function _fetchAvatarFavoritesForGroup(groupName) {
  const sessionToken = makeAuthSessionToken();
  let offset = 0;
  let all = [];
  while (true) {
    if (!isAuthSessionCurrent(sessionToken)) throw _staleAuthSessionError();
    const resp = await apiCall(`/api/vrc/avatars/favorites?n=100&offset=${offset}&tag=${groupName}`, { noAbort: true });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const batch = await resp.json();
    if (!isAuthSessionCurrent(sessionToken)) throw _staleAuthSessionError();
    if (!Array.isArray(batch) || batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < 100) break;
    offset += 100;
  }
  return all;
}

async function syncAvatarFavoriteCachesByIndex() {
  const sessionToken = makeAuthSessionToken();
  const current = () => isAuthSessionCurrent(sessionToken);
  try {
    if (!Array.isArray(favoriteGroups) || favoriteGroups.length === 0) return;
    for (const g of favoriteGroups) {
      if (!current()) return;
      if (!g || !g.name) continue;
      try {
        const remoteIds = avatarFavoriteIndexByGroup.get(g.name) || [];
        const cachedBasicsRaw = await idb.get('avatar_basics_' + g.name);
        if (!current()) return;
        const cachedBasics = Array.isArray(cachedBasicsRaw) ? cachedBasicsRaw : null;
        const cachedIds = (cachedBasics || []).map(a => a && a.id).filter(Boolean);

        if (cachedBasics && _idsMatchSet(cachedIds, remoteIds)) {
          await idb.set('avatar_basics_age_' + g.name, Date.now());
          continue;
        }

        const full = remoteIds.length ? await _fetchAvatarFavoritesForGroup(g.name) : [];
        if (!current()) return;
        const basics = full.map(a => ({
          id: a.id,
          name: a.name,
          thumbnailImageUrl: a.thumbnailImageUrl,
          imageUrl: a.imageUrl,
          releaseStatus: a.releaseStatus,
          authorId: a.authorId,
          tags: a.tags
        }));
        await idb.set('avatars_' + g.name, full);
        if (!current()) return;
        await idb.set('avatar_basics_' + g.name, basics);
        if (!current()) return;
        await idb.set('avatar_basics_age_' + g.name, Date.now());
        if (!current()) return;
        if (currentTab === 'download' && currentCategory === g.name) {
          avatars = basics;
          applyFilters();
        }
      } catch (e) {
        console.warn('syncAvatarFavoriteCachesByIndex', g.name, e);
      }
    }
  } catch (e) {
    console.warn('syncAvatarFavoriteCachesByIndex failed', e);
  }
}

async function syncWorldFavoriteCachesByIndex() {
  const sessionToken = makeAuthSessionToken();
  const current = () => isAuthSessionCurrent(sessionToken);
  try {
    if (typeof loadWorldFavGroups === 'function') await loadWorldFavGroups();
    if (!current() || !Array.isArray(worldFavGroups) || worldFavGroups.length === 0) return;

    const seqToken = { get cancelled() { return !current(); } };
    for (const g of worldFavGroups) {
      if (!current()) return;
      if (!g || !g.name) continue;
      const category = 'fav_' + g.name;
      try {
        const remoteIds = worldFavoriteIndexByGroup.has(g.name)
          ? (worldFavoriteIndexByGroup.get(g.name) || [])
          : await _fetchWorldFavoriteIndex(g.name);
        if (!current()) return;
        worldFavGroupCounts.set(g.name, remoteIds.length);
        const cachedBasicsRaw = await idb.get(_worldCacheKey(category));
        if (!current()) return;
        const cachedBasics = Array.isArray(cachedBasicsRaw) ? cachedBasicsRaw : null;
        const cachedIds = (cachedBasics || []).map(w => w && w.id).filter(Boolean);

        if (cachedBasics && _idsMatchSet(cachedIds, remoteIds)) {
          await idb.set('world_basics_age_' + category, Date.now());
          continue;
        }

        const basics = remoteIds.length ? await _fetchWorldBasicsByIds(remoteIds, seqToken) : [];
        if (!current()) return;
        await idb.set(_worldCacheKey(category), basics);
        if (!current()) return;
        await idb.set('world_basics_age_' + category, Date.now());
        if (!current()) return;
        if (currentTab === 'worlds' && VRCW.modules.worlds && typeof currentWorldCategory !== 'undefined' && currentWorldCategory === category) {
          allWorlds = basics;
          filterWorlds();
        }
      } catch (e) {
        console.warn('syncWorldFavoriteCachesByIndex', g.name, e);
      }
    }
    if (current() && typeof renderWorldFavGroupButtons === 'function') renderWorldFavGroupButtons();
  } catch (e) {
    console.warn('syncWorldFavoriteCachesByIndex failed', e);
  }
}

async function preloadAllFavorites(groups) {
  // Delay to not compete with the initial fetchAvatars on login
  await new Promise((r) => setTimeout(r, 3000));
  for (const g of groups) {
    // Skip currently active category - already fetched by fetchAvatars
    if (g === currentCategory) continue;
    // Skip if cache is still fresh (same TTL as fetchAvatars: 5 min)
    try {
      const cacheAge = await idb.get('avatar_basics_age_' + g) || 0;
      if (cacheAge > 0 && (Date.now() - cacheAge) < 5 * 60 * 1000) continue;
    } catch (_) {}
    try {
      let offset = 0;
      let allFetched = [];
      while (true) {
          const resp = await apiCall(
            `/api/vrc/avatars/favorites?n=100&offset=${offset}&tag=${g}`,
            { noAbort: true }
          );
        if (!resp.ok) break;
        const batch = await resp.json();
        if (!batch || batch.length === 0) break;
        allFetched = allFetched.concat(batch);
        if (batch.length < 100) break;
        offset += 100;
      }
      if (allFetched.length > 0) {
        await idb.set("avatars_" + g, allFetched);
        // Also write basics + age so fetchAvatars' fast path works correctly
        const basics = allFetched.map(a => ({
          id: a.id, name: a.name, thumbnailImageUrl: a.thumbnailImageUrl,
          imageUrl: a.imageUrl, releaseStatus: a.releaseStatus,
          authorId: a.authorId, tags: a.tags
        }));
        idb.set('avatar_basics_' + g, basics).catch(() => {});
        idb.set('avatar_basics_age_' + g, Date.now()).catch(() => {});
        // Incremental update to global map
        allFetched.forEach(av => {
          if (av.id && av.name && av.name !== 'Unknown') {
            window._localNameMap.set(av.id, av.name);
          }
        });
        logMsg(`✓ Preloaded ${allFetched.length} for ${g}`, "info");
      } else {
        // Even if empty, mark as freshly checked so we don't re-fetch immediately
        idb.set('avatar_basics_age_' + g, Date.now()).catch(() => {});
      }
      // Small delay between groups to prevent rate limiting
      await new Promise((r) => setTimeout(r, 500));
    } catch (e) {
      console.warn("preload failed for", g, e);
    }
  }
}

function renderFavoriteGroupButtons() {
  const container = document.getElementById("favGroupBtns");
  if (!container) return;
  
  container.innerHTML = "";
  
  // 1. Render all dynamic groups
  favoriteGroups.forEach((g) => {
    const btn = document.createElement("button");
    btn.className = "btn btn-secondary btn-block cat-btn";
    btn.id = "cat-" + g.name;
    btn.textContent = g.displayName || g.name.replace("avatars", "Favorites ");
    btn.onclick = () => switchCategory(g.name);
    container.appendChild(btn);
  });
    
  // 2. Append Local Favorites to the absolute bottom
  const btnLocal = document.createElement("button");
  btnLocal.className = "btn btn-secondary btn-block cat-btn";
  btnLocal.id = "cat-local";
  btnLocal.innerHTML = t('shell.localFavoritesBtn');
  btnLocal.onclick = () => switchCategory("local");
  container.appendChild(btnLocal);
}

// ── Foveated Loading Orchestrator ──
// Concurrent runPriorityTask calls used to corrupt isPriorityTaskRunning:
// the inner task's `finally` would flip the flag false while the outer was
// still running, releasing background tasks too early. Counter-based version
// below is reentrant-safe.
let _priorityDepth = 0;
const backgroundTaskKeys = new Set();
const PERSISTENT_BACKGROUND_TASK_KEYS = new Set([
  'startup-favorite-index-sync',
  'startup-my-profile'
]);

async function runPriorityTask(taskFn) {
  currentGlobalFetchSeq++;
  _priorityDepth++;
  isPriorityTaskRunning = true;
  // NOTE: Don't clear imageQueue here. Previously this was done to "favor current
  // JSON" but it caused thumbnails on the destination tab to need re-queueing,
  // making revisits feel slower. IntersectionObserver naturally pauses off-screen
  // image loads (cancelLoad()), so leaving the queue alone is fine.

  try {
    await taskFn();
  } finally {
    _priorityDepth = Math.max(0, _priorityDepth - 1);
    if (_priorityDepth === 0) {
      isPriorityTaskRunning = false;
      processBackgroundQueue();
    }
  }
}

function queueBackgroundTask(taskFn, key = '') {
  const sessionToken = makeAuthSessionToken();
  if (key && backgroundTaskKeys.has(key)) return;
  if (key) backgroundTaskKeys.add(key);
  backgroundLoadQueue.push({ taskFn, key, sessionToken });
  if (!isPriorityTaskRunning) processBackgroundQueue();
}

async function processBackgroundQueue() {
  // _searchActive: while the user is actively searching (after the first
  // doAvtrdbSearch in a session, until they leave the search tab), hold off
  // background work. The browser's 6-concurrent-requests-per-origin limit
  // means a noisy startup-favorite-index-sync (which can fan out to hundreds
  // of /api/vrc/avatars/{id} detail fetches) will otherwise starve the 5
  // streaming search source requests. setSearchActive(false) (called from
  // switchTab leaving search) re-kicks this drain loop.
  if (isPriorityTaskRunning || _searchActive || !backgroundLoadQueue.length) return;
  const item = backgroundLoadQueue.shift();
  if (item) {
    try {
      if (isAuthSessionCurrent(item.sessionToken)) await item.taskFn();
    } catch(e){}
    if (item.key && isAuthSessionCurrent(item.sessionToken)) backgroundTaskKeys.delete(item.key);
    setTimeout(processBackgroundQueue, 500);
  }
}

// Search-tab back-pressure flag. Set true by doAvtrdbSearch, cleared by
// switchTab when leaving the search tab (see below).
let _searchActive = false;
function setSearchActive(v) {
  _searchActive = !!v;
  if (!_searchActive) {
    // Drain queue when search ends so deferred startup syncs eventually run.
    setTimeout(processBackgroundQueue, 50);
  }
}

function clearBackgroundQueue(opts = {}) {
  const preservePersistent = !!opts.preservePersistent;
  if (!preservePersistent) {
    backgroundLoadQueue.length = 0;
    backgroundTaskKeys.clear();
    return;
  }
  const keep = backgroundLoadQueue.filter(item => item?.key && PERSISTENT_BACKGROUND_TASK_KEYS.has(item.key));
  backgroundLoadQueue.length = 0;
  backgroundLoadQueue.push(...keep);
  backgroundTaskKeys.clear();
  keep.forEach(item => { if (item.key) backgroundTaskKeys.add(item.key); });
}

VRCW.registerService('backgroundQueue', {
  queue: queueBackgroundTask,
  clear: clearBackgroundQueue,
  runPriority: runPriorityTask,
});

VRCW.registerService('scripts', {
  loadOnce: loadScriptOnce,
});

function startUpload() {
  return loadScriptOnce('js/upload.js?v=' + APP_CACHE_VERSION).then(() => {
    if (!VRCW.modules.upload || typeof VRCW.modules.upload.startUpload !== 'function') {
      throw new Error('Upload module did not register');
    }
    return VRCW.modules.upload.startUpload();
  }).catch(err => {
    console.error(err);
    showToast(t('toast.uploadModuleLoadFail', {msg: err.message}), 'error');
  });
}


// ── Strict direct-open for avatar/user/world IDs and VRChat URLs ──
function openDirectOpenModal() {
  const modal = document.getElementById('directOpenModal');
  const input = document.getElementById('directOpenInput');
  const error = document.getElementById('directOpenError');
  if (!modal || !input) return;
  if (modal.classList.contains('hidden')) {
    modal._directOpenReturnFocus = document.activeElement;
    lockBodyScroll();
    modal.classList.remove('hidden');
    modal.style.zIndex = modalZTop();
  }
  if (error) { error.textContent = ''; error.style.display = 'none'; }
  requestAnimationFrame(() => input.focus());
}

function closeDirectOpenModal() {
  const modal = document.getElementById('directOpenModal');
  const input = document.getElementById('directOpenInput');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  unlockBodyScroll();
  input?.blur();
  const trigger = modal._directOpenReturnFocus;
  modal._directOpenReturnFocus = null;
  if (trigger?.isConnected) trigger.focus();
}

function submitDirectOpen() {
  const input = document.getElementById('directOpenInput');
  const error = document.getElementById('directOpenError');
  const parsed = typeof parseDirectOpenId === 'function' ? parseDirectOpenId(input?.value) : null;
  if (!parsed) {
    if (error) { error.textContent = t('direct.openInvalid'); error.style.display = 'block'; }
    input?.focus();
    return false;
  }
  if (error) { error.textContent = ''; error.style.display = 'none'; }
  closeDirectOpenModal();
  if (input) input.value = '';
  if (parsed.type === 'avtr') {
    loadScriptOnce('js/search.js?v=' + APP_CACHE_VERSION).then(() => openLocalDetail(parsed.id));
  } else if (parsed.type === 'usr') {
    openFriendProfileById(parsed.id);
  } else if (parsed.type === 'wrld') {
    switchTab('worlds');
    Promise.resolve().then(() => openWorldDetail(parsed.id));
  }
  return false;
}


// ── Tabs ──
function switchTab(tab) {
  // No-op when already on this tab. Re-clicking the active nav item used to
  // re-trigger a full refresh, abort the in-flight requests for the current
  // tab, and visibly wipe the grid — making cached content disappear and reload.
  const isSameTab = currentTab === tab;
  currentTab = tab;
  if (window.innerWidth <= 768) toggleSidebar(false);

  // UI Updates run regardless (so re-clicking a nav still gives visual feedback)
  document.querySelectorAll(".nav-item, .nav-item-icon, .tab-btn").forEach(b => b.classList.remove("active"));
  // Use data-tab="X" (added in index.html) instead of the brittle
  // [onclick*="'X'"] selector — the old version mis-matched any onclick that
  // contained the tab name string anywhere (e.g. switchAssetsPage('search')
  // accidentally activating the search tab nav item). data-tab is a precise
  // declarative anchor.
  document.querySelectorAll('[data-tab="' + tab + '"]').forEach(b => b.classList.add("active"));

  const panels = { download:'downloadPanel', upload:'uploadPanel', search:'searchPanel', friends:'friendsPanel', worlds:'worldsPanel', groups:'groupsPanel', assets:'assetsPanel', settings:'settingsPanel' };
  Object.entries(panels).forEach(([key, id]) => {
      const el = document.getElementById(id);
      if (el) {
          el.classList.toggle('active', tab === key);
      }
  });
  const sp = document.getElementById('settingsPanel');
  if (sp) sp.classList.toggle('hidden', tab !== 'settings');

  const targetPanel = document.getElementById(panels[tab]);
  const btn = document.getElementById('mobileSidebarBtn');
  if (btn && targetPanel) {
      const hasSidebar = targetPanel.querySelector('.sidebar') !== null;
      btn.style.visibility = hasSidebar ? 'visible' : 'hidden';
      btn.innerHTML = '<i class="fa-solid fa-bars"></i>';
      btn.classList.remove('active');
  }

  // If already on this tab, skip the abort+reload dance entirely
  if (isSameTab) return;
  // Leaving the search tab: release the search-active back-pressure so the
  // background queue (startup-favorite-index-sync etc.) can drain. If we're
  // entering search, doAvtrdbSearch will set this true again as soon as the
  // user types a query.
  if (tab !== 'search' && typeof setSearchActive === 'function') setSearchActive(false);
  bumpUiEpoch();
  clearBackgroundQueue({ preservePersistent: true });

  runPriorityTask(async () => {
    if (currentTabAbortController) currentTabAbortController.abort();
    currentTabAbortController = new AbortController();

    // forceRefresh=false: render cache immediately, then silently re-fetch in
    // background. The dedicated <i class="fa-solid fa-rotate-right"></i> refresh buttons inside each tab pass true.
    if (tab === "friends") {
      if (!friendsLoaded) await initFriendsTab();
      else await fetchCurrentFriendCategory(false);
    }
    if (tab === "worlds") {
      if (!worldsLoaded) await initWorldsTab();
      else await fetchWorlds(currentWorldCategory, false);
    }
    if (tab === "groups") await switchGroupsCategory('joined');
    if (tab === "download") {
      // On initial page load (F5/login), always refresh from API so users
      // see up-to-date data. Subsequent tab switches use cached fast path.
      const force = !!window._isInitialLoad;
      window._isInitialLoad = false;
      await fetchAvatars(force);
    }
    if (tab === 'assets') {
      await loadScriptOnce('js/media-profile.js?v=' + APP_CACHE_VERSION);
      await loadScriptOnce('js/assets-groups.js?v=' + APP_CACHE_VERSION);
      await initAssetsTab?.();
    }
    if (tab === 'upload') await loadScriptOnce('js/upload.js?v=' + APP_CACHE_VERSION);
    if (tab === 'settings') await loadCacheStats();
  });
}

function switchSettingsPage(page) {
  ['cache', 'join', 'about'].forEach(p => {
    const el = document.getElementById('setPage' + p.charAt(0).toUpperCase() + p.slice(1));
    if (el) el.style.display = p === page ? '' : 'none';
    const btn = document.getElementById('setCat' + p.charAt(0).toUpperCase() + p.slice(1));
    if (btn) btn.classList.toggle('active', p === page);
  });
  if (page === 'cache') loadCacheStats();
  if (page === 'join') loadJoinPrefs();
}

// ── Join Preferences (localStorage) ──
const PREF_TYPE   = 'vrcw_default_instance_type';
const PREF_REGION = 'vrcw_default_region';


const INSTANCE_TYPE_LABELS = {
  hidden:     t('shell.instanceType.hidden'),
  public:     t('shell.instanceType.public'),
  friends:    t('shell.instanceType.friends'),
  invite:     t('shell.instanceType.invite'),
  inviteplus: t('shell.instanceType.inviteplus'),
};
const REGION_LABELS = {
  use: t('shell.region.use'),
  usw: t('shell.region.usw'),
  eu:  t('shell.region.eu'),
  jp:  t('shell.region.jp'),
};

function loadJoinPrefs() {
  const type   = localStorage.getItem(PREF_TYPE)   || 'hidden';
  const region = localStorage.getItem(PREF_REGION) || 'use';

  // Set hidden inputs
  const typeInput   = document.getElementById('settingInstanceType');
  const regionInput = document.getElementById('settingRegion');
  if (typeInput)   typeInput.value   = type;
  if (regionInput) regionInput.value = region;

  // Update displayed labels
  const typeSelect   = document.getElementById('instanceTypeSelect');
  const regionSelect = document.getElementById('instanceRegionSelect');
  if (typeSelect)   typeSelect.querySelector('.selected-label').textContent   = INSTANCE_TYPE_LABELS[type]   || type;
  if (regionSelect) regionSelect.querySelector('.selected-label').textContent = REGION_LABELS[region]        || region;

  // Mark selected option
  typeSelect?.querySelectorAll('.glass-option').forEach(o =>
    o.classList.toggle('selected', o.dataset.val === type));
  regionSelect?.querySelectorAll('.glass-option').forEach(o =>
    o.classList.toggle('selected', o.dataset.val === region));
}

function saveJoinPrefs() {
  const type   = document.getElementById('settingInstanceType')?.value   || 'hidden';
  const region = document.getElementById('settingRegion')?.value         || 'use';
  localStorage.setItem(PREF_TYPE, type);
  localStorage.setItem(PREF_REGION, region);

  const status = document.getElementById('joinPrefsSaveStatus');
  if (status) {
    status.style.display = 'inline';
    setTimeout(() => { status.style.display = 'none'; }, 2500);
  }
}

async function loadCacheStats() {
  const container = document.getElementById('cacheStatsContainer');
  if (!container) return;
  container.innerHTML = `<div style="color:var(--text-muted);font-size:0.85em;padding:12px;text-align:center;">${t('shell.loadingCache')}</div>`;

  await idb.init();
  let allKeys = [];
  try { allKeys = await idb.keys(); } catch(_) {}

  const CATEGORIES = [
    { id: 'friend',  label: t('shell.cache.friend.label'),  emoji: '<i class="fa-solid fa-users"></i> ', desc: t('shell.cache.friend.desc'),  match: k => k === 'friend_basics' },
    { id: 'profile', label: t('shell.cache.profile.label'), emoji: '<i class="fa-solid fa-id-badge"></i> ', desc: t('shell.cache.profile.desc'), match: k => k === 'my_profile' },
    { id: 'avatar',  label: t('shell.cache.avatar.label'),  emoji: '<i class="fa-solid fa-masks-theater"></i> ', desc: t('shell.cache.avatar.desc'), match: k => k.startsWith('avatar') || k.startsWith('avatars_') },
    { id: 'world',   label: t('shell.cache.world.label'),   emoji: '<i class="fa-solid fa-earth-americas"></i> ', desc: t('shell.cache.world.desc'), match: k => k.startsWith('world') || k.startsWith('worlds_') },
    { id: 'names',   label: t('shell.cache.names.label'),   emoji: '<i class="fa-solid fa-clipboard"></i> ', desc: t('shell.cache.names.desc'), match: k => k === 'persistent_avatar_names' },
    { id: 'other',   label: t('shell.cache.other.label'),   emoji: '<i class="fa-solid fa-box"></i> ', desc: t('shell.cache.other.desc'), match: k => true },
  ];

  const catKeys = {};
  CATEGORIES.forEach(c => catKeys[c.id] = []);
  for (const k of allKeys) {
    let matched = false;
    for (const cat of CATEGORIES.slice(0, -1)) {
      if (cat.match(k)) { catKeys[cat.id].push(k); matched = true; break; }
    }
    if (!matched) catKeys['other'].push(k);
  }

  // Image blob count
  let imageCount = 0;
  try { imageCount = await idb.imageCount(); } catch(_) {}

  let html = '';

  // Render category rows
  for (const cat of CATEGORIES) {
    const keys = catKeys[cat.id];
    if (keys.length === 0) continue;
    html += `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px 16px;display:flex;align-items:center;gap:14px;">
        <span style="font-size:1.5em;">${cat.emoji}</span>
        <div style="flex:1;">
          <div style="font-weight:600;font-size:0.9em;">${cat.label}</div>
          <div style="font-size:0.75em;color:var(--text-muted);margin-top:2px;">${t('shell.cacheRecords', {desc: cat.desc, count: keys.length})}</div>
        </div>
        <button onclick="clearCacheCategory(${JSON.stringify(keys.map(k=>k))})" class="btn btn-secondary" style="padding:6px 14px;font-size:0.82em;flex-shrink:0;">${t('shell.clearBtn')}</button>
      </div>`;
  }

  // Image blob row
  if (imageCount > 0) {
    html += `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px 16px;display:flex;align-items:center;gap:14px;">
        <span style="font-size:1.5em;"><i class="fa-solid fa-image"></i> </span>
        <div style="flex:1;">
          <div style="font-weight:600;font-size:0.9em;">${t('shell.cache.imageBlob.label')}</div>
          <div style="font-size:0.75em;color:var(--text-muted);margin-top:2px;">${t('shell.cache.imageBlob.desc', {count: imageCount})}</div>
        </div>
        <button onclick="clearImageCache()" class="btn btn-secondary" style="padding:6px 14px;font-size:0.82em;flex-shrink:0;">${t('shell.clearBtn')}</button>
      </div>`;
  }

  if (!html) {
    html = `<div style="color:var(--text-muted);font-size:0.85em;padding:20px;text-align:center;background:var(--bg-card);border-radius:12px;">${t('shell.cacheEmpty')}</div>`;
  }

  container.innerHTML = html;
}

async function clearCacheCategory(keys) {
  if (!confirm(t('confirm.clearCacheCategory', {count: keys.length}))) return;
  await idb.deleteKeys(keys);
  loadCacheStats();
  showToast(t('toast.cacheCleared', {count: keys.length}), 'success');
}

async function clearImageCache() {
  if (!confirm(t('confirm.clearImageCache'))) return;
  await idb.clearImages();
  await clearServiceWorkerImageCaches();
  loadCacheStats();
  showToast(t('toast.imageCacheCleared'), 'success');
}

async function clearServiceWorkerImageCaches() {
  if (typeof navigator.serviceWorker !== 'undefined' && navigator.serviceWorker.controller) {
    await new Promise(resolve => {
      const done = () => {
        navigator.serviceWorker.removeEventListener('message', onMessage);
        resolve();
      };
      const onMessage = event => { if (event.data?.type === 'imageCacheCleared') done(); };
      navigator.serviceWorker.addEventListener('message', onMessage);
      navigator.serviceWorker.controller.postMessage('clearImageCache');
      setTimeout(done, 2000);
    });
  } else if (typeof caches !== 'undefined') {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('vrcw-img-')).map(name => caches.delete(name)));
  }
  if (typeof loadedImageUrls !== 'undefined' && loadedImageUrls.clear) loadedImageUrls.clear();
}

async function clearAllCacheNow() {
  if (!confirm(t('confirm.clearAllCache'))) return;
  await idb.clearCache();
  await idb.clearImages();
  await clearServiceWorkerImageCaches();
  loadCacheStats();
  showToast(t('toast.allCacheCleared'), 'success');
}

// ── Refresh All Persistent Cache ──
// Re-fetches avatar groups, friends, worlds, and favorite IDs from API
// and writes them to IDB. Unlike "clear cache", this preserves local favorites
// and just overwrites stale data with fresh API responses.
async function refreshAllPersistentCache() {
  const btn = document.getElementById('btnRefreshAllCache');
  if (btn) { btn.disabled = true; btn.innerHTML = t('shell.refreshing'); }
  const log = (msg) => logMsg(msg, 'info');

  try {
    // 1. Re-sync favorite IDs + group counts
    log(t('log.syncingFavIds'));
    await syncAllFavoriteIds();

    // 2. Re-fetch all avatar favorite groups
    if (favoriteGroups.length > 0) {
      log(t('log.refreshingAvatarFavGroups', {count: favoriteGroups.length}));
      for (const g of favoriteGroups) {
        try {
          let offset = 0, all = [];
          while (true) {
            const resp = await apiCall(`/api/vrc/avatars/favorites?n=100&offset=${offset}&tag=${g.name}`);
            if (!resp.ok) break;
            const batch = await resp.json();
            if (!batch || batch.length === 0) break;
            all = all.concat(batch);
            if (batch.length < 100) break;
            offset += 100;
          }
          // Write full data + basics + age
          await idb.set('avatars_' + g.name, all);
          const basics = all.map(a => ({
            id: a.id, name: a.name, thumbnailImageUrl: a.thumbnailImageUrl,
            imageUrl: a.imageUrl, releaseStatus: a.releaseStatus,
            authorId: a.authorId, tags: a.tags
          }));
          await idb.set('avatar_basics_' + g.name, basics);
          await idb.set('avatar_basics_age_' + g.name, Date.now());
          all.forEach(av => {
            if (av.id && av.name && av.name !== 'Unknown') window._localNameMap.set(av.id, av.name);
          });
          log(t('log.avatarFavGroupCount', {name: g.displayName || g.name, count: all.length}));
        } catch (e) {
          log(`  ✗ ${g.name}: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 300));
      }
    }

    // 3. Re-fetch "my avatars"
    log(t('log.refreshingMyAvatars'));
    try {
      let offset = 0, myAll = [];
      while (true) {
        const resp = await apiCall(`/api/vrc/avatars?user=me&releaseStatus=all&n=100&offset=${offset}`);
        if (!resp.ok) break;
        const batch = await resp.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        myAll = myAll.concat(batch);
        if (batch.length < 100) break;
        offset += 100;
        if (offset >= 1000) break;
      }
      const myBasics = myAll.map(a => ({
        id: a.id, name: a.name, thumbnailImageUrl: a.thumbnailImageUrl,
        imageUrl: a.imageUrl, releaseStatus: a.releaseStatus,
        authorId: a.authorId, tags: a.tags
      }));
      await idb.set('avatar_basics_mine', myBasics);
      await idb.set('avatar_basics_age_mine', Date.now());
      await idb.set('avatars_mine', myAll);
      myAll.forEach(av => {
        if (av.id && av.name) window._localNameMap.set(av.id, av.name);
      });
      log(t('log.myAvatarsCount', {count: myAll.length}));
    } catch (e) {
      log(t('log.myAvatarsFail', {msg: e.message}));
    }

    // 4. Re-fetch friends
    log(t('log.refreshingFriends'));
    try {
      let offset = 0, friendAll = [];
      while (true) {
        const resp = await apiCall(`/api/vrc/auth/user/friends?offset=${offset}&n=100&offline=true`);
        if (!resp.ok) break;
        const batch = await resp.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        friendAll = friendAll.concat(batch);
        if (batch.length < 100) break;
        offset += 100;
        if (offset >= 1000) break;
      }
      const friendBasics = friendAll.map(f => ({
        id: f.id, displayName: f.displayName,
        currentAvatarImageUrl: f.currentAvatarImageUrl,
        currentAvatarThumbnailImageUrl: f.currentAvatarThumbnailImageUrl,
        status: f.status, location: f.location,
        last_activity: f.last_activity, last_login: f.last_login,
        isFriend: f.isFriend, tags: f.tags
      }));
      await idb.set('friend_basics', friendBasics);
      await idb.set('friend_basics_age', Date.now());
      log(t('log.friendsCount', {count: friendAll.length}));
    } catch (e) {
      log(t('log.friendsFail', {msg: e.message}));
    }

    // 5. Persist the name map
    if (window._localNameMap && window._localNameMap.size > 0) {
      const exportMap = {};
      window._localNameMap.forEach((v, k) => { exportMap[k] = v; });
      await idb.set('persistent_avatar_names', exportMap);
      log(t('log.nameMapCount', {count: window._localNameMap.size}));
    }

    log(t('log.allCacheRefreshed'));
    showToast(t('toast.allCacheRefreshed'), 'success');
  } catch (e) {
    showToast(t('toast.refreshCacheFail', {msg: e.message}), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = t('shell.refreshAllCacheBtn'); }
    loadCacheStats();
  }
}

// ── Categories ──

VRCW.registerModule('shell', { syncAllFavoriteIds, fetchFavoriteGroups, renderFriendFavGroupButtons, removeAvatarFromFavoriteCache, upsertAvatarIntoFavoriteCache, removeWorldFromFavoriteCache, upsertWorldIntoFavoriteCache, syncAvatarFavoriteCachesByIndex, syncWorldFavoriteCachesByIndex, preloadAllFavorites, renderFavoriteGroupButtons, runPriorityTask, queueBackgroundTask, processBackgroundQueue, clearBackgroundQueue, startUpload, switchTab, switchSettingsPage, loadJoinPrefs, saveJoinPrefs, loadCacheStats, clearCacheCategory, clearImageCache, clearAllCacheNow, refreshAllPersistentCache });
renderAppVersionInfo();

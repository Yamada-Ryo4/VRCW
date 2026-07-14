/*
 * VRCW — worlds.js
 * 世界标签/详情/实例加入/缓存清理弹窗
 *
 * 注意：本项目为「经典脚本」(非 ES module)，全部按顺序加载、共享全局作用域。
 * 函数声明会提升为全局，跨文件调用没问题；请勿改为 type="module"。
 */

// ═══════════════════════════════════════════════════════════════
// ── WORLDS TAB ──
// ═══════════════════════════════════════════════════════════════

let allWorlds           = [];
let currentWorldDetail  = null;
// Temp map used during online fav-group fetch to stamp favoriteId (the
// favorites-record ID) onto each world object so it survives IDB caching.
let _pendingFavIdMap    = new Map();

async function initWorldsTab() {
  worldsLoaded = true;
  await loadWorldFavGroups();
  // Default: first fav group or recent
  if (worldFavGroups.length > 0) {
    switchWorldCategory('fav_' + worldFavGroups[0].name);
  } else {
    switchWorldCategory('recent');
  }
}

// Bug#3 fix: world favorites - also add "我上传的世界" and handle VRC+ worlds1
function renderWorldFavGroupButtons(message) {
  const container = document.getElementById('worldFavGroupList');
  if (!container) return;

  const groupByName = new Map((worldFavGroups || []).filter(g => g && g.name).map(g => [g.name, g]));
  const myTags = (typeof myProfileData !== 'undefined' && myProfileData && myProfileData.tags) || [];
  const hasVrcPlus = typeof isVRCPlus === 'function' && isVRCPlus(myTags);
  const standardSlots = ['worlds1', 'worlds2', 'worlds3', 'worlds4'];
  const vrcPlusSlots = hasVrcPlus ? ['vrcPlusWorlds1', 'vrcPlusWorlds2', 'vrcPlusWorlds3', 'vrcPlusWorlds4'] : [];
  const slotNames = [...standardSlots, ...vrcPlusSlots];
  const rendered = new Set();

  let html = slotNames.map(name => {
    const g = groupByName.get(name) || { name, displayName: name };
    rendered.add(name);
    const isVrcPlus = name.startsWith('vrcPlusWorlds') || g.type === 'vrcPlusWorld';
    const count = worldFavGroupCounts.get(name);
    const countLabel = Number.isFinite(count) ? ` (${count}/100)` : '';
    const icon = isVrcPlus ? '<i class="fa-solid fa-gem" style="color: #00f2fe;"></i> ' : '<i class="fa-solid fa-star"></i> ';
    return makeCatBtn(`${icon} ${escHtml(g.displayName || g.name)}${countLabel}`, `switchWorldCategory('fav_${name}')`, `worldCatFav_${name}`);
  }).join('');

  const extra = (worldFavGroups || [])
    .filter(g => g && g.name && !rendered.has(g.name))
    .sort((a,b) => a.name.localeCompare(b.name, undefined, {numeric:true}));
  html += extra.map(g => {
    const isVrcPlus = g.name.startsWith('vrcPlusWorlds') || g.type === 'vrcPlusWorld';
    const icon = isVrcPlus ? '<i class="fa-solid fa-gem" style="color: #00f2fe;"></i> ' : '<i class="fa-solid fa-star"></i> ';
    return makeCatBtn(`${icon} ${escHtml(g.displayName || g.name)}`, `switchWorldCategory('fav_${escJsAttr(g.name)}')`, `worldCatFav_${g.name}`);
  }).join('');

  html += makeCatBtn(t('world.myUploads'), "switchWorldCategory('mine')", 'worldCatMine');

  if (message) {
    html = `<div style="font-size:0.75em;color:var(--text-muted);padding:4px 0 8px;line-height:1.5;">${escHtml(message)}</div>` + html;
  }

  container.innerHTML = html || `<div style="font-size:0.75em;color:var(--text-muted);padding:4px 0;">${escHtml(t('world.noFavorites'))}</div>`;
}

async function loadWorldFavGroups() {
  const container = document.getElementById('worldFavGroupList');
  if (container) container.innerHTML = `<div style="font-size:0.75em;color:var(--text-muted);padding:4px 0;">${escHtml(t('loading'))}</div>`;
  try {
    // Fetch both standard world groups AND VRC+ exclusive groups in parallel
    const [r1, r2] = await Promise.all([
      apiCall('/api/vrc/favorite/groups?type=world&n=50', { noAbort: true }),
      apiCall('/api/vrc/favorite/groups?type=vrcPlusWorld&n=50', { noAbort: true })
    ]);
    const standard  = r1.ok ? (await r1.json() || []) : [];
    const vrcPlus   = r2.ok ? (await r2.json() || []) : [];
    const groups = [...standard, ...vrcPlus]
      .filter(g => g && g.name && (g.name.startsWith('worlds') || g.name.startsWith('vrcPlusWorlds') || g.type === 'world' || g.type === 'vrcPlusWorld'))
      .sort((a,b) => a.name.localeCompare(b.name, undefined, {numeric:true}));

    worldFavGroups = groups;
    const failed = [];
    if (!r1.ok) failed.push(t('world.standardFavorites'));
    if (!r2.ok && r2.status !== 403 && r2.status !== 404) failed.push(t('world.vrcPlusFavorites'));
    renderWorldFavGroupButtons(failed.length ? t('toast.favGroupLoadFailPartial', {names: failed.join('、')}) : '');
  } catch(e) {
    console.warn('loadWorldFavGroups', e);
    renderWorldFavGroupButtons(t('toast.favGroupLoadFail'));
  }
}

function switchWorldCategory(cat) {
  currentWorldCategory = cat;
  runPriorityTask(async () => {
    document.querySelectorAll('#worldsPanel .cat-btn, #worldsPanel .category-btn').forEach(b => {
    b.classList.remove('active','btn-primary');
    b.classList.add('btn-secondary');
  });
  const btnId = cat.startsWith('fav_')
    ? `worldCatFav_${cat.slice(4)}`
    : `worldCat${cat.charAt(0).toUpperCase()+cat.slice(1)}`;
  const btn = document.getElementById(btnId);
  if (btn) { btn.classList.remove('btn-secondary'); btn.classList.add('active','btn-primary'); }

  await fetchWorlds(cat, false);
  });
}

function _worldCacheIdsMatch(category, ids) {
  const cachedIds = (allWorlds || []).map(w => w && w.id).filter(Boolean);
  if (!category.startsWith('fav_') || cachedIds.length !== ids.length) return false;
  for (let i = 0; i < ids.length; i++) {
    if (cachedIds[i] !== ids[i]) return false;
  }
  return true;
}

// Cache key prefix that embeds the field schema version. Bump when the
// cached object shape gains fields required by filtering/sorting so stale
// IDB entries are transparently ignored on first load after a deployment.
const WORLD_CACHE_PREFIX = 'world_basics_v2_';

function _worldFavTypeForGroup(groupName) {
  return String(groupName || '').startsWith('vrcPlusWorlds') ? 'vrcPlusWorld' : 'world';
}

function _worldBasicForWorldsCache(w) {
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
        favoriteId: w.favoriteId || null,   // needed to rebuild worldFavoriteIdMap from IDB cache
        // Platform fields required by filterWorldsByPlatform - without these,
        // cache hits make platform filtering return empty lists.
        platforms: w.platforms || null,
        unityPackages: w.unityPackages || null,
        description: w.description || '',
        updatedAt: w.updated_at || w.updatedAt || null
    };
}

async function _saveWorldBasicsForCurrentCategory(cat = currentWorldCategory) {
    if (!cat) return;
    const basics = (allWorlds || []).map(_worldBasicForWorldsCache).filter(Boolean);
    await idb.set(WORLD_CACHE_PREFIX + cat, basics);
    await idb.set('world_basics_age_' + cat, Date.now());
}

async function fetchWorlds(category, forceRefresh = false) {
  const seq = ++currentWorldFetchSeq;
  currentWorldCategory = category;
  const gridEl  = document.getElementById('worldGrid');
  const statsEl = document.getElementById('worldStats');
  if (!gridEl) return;

  // Reset worlds list and selection when switching category to avoid mixing
  allWorlds = [];
  selectedWorldIds.clear();
  _updateWorldActionBtns();

  const catLabel = category.startsWith('fav_') ? t('world.favGroupLabel', {name: category.slice(4)}) : category;
  worldLogMsg(t('log.switchToWorldCat', {name: catLabel}), 'info');

  // ── Step 1: Load basics from cache immediately ──────────────────────────
  const WORLDS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
  let cacheIsFresh = false;
  try {
    const cachedBasicsRaw = await idb.get(WORLD_CACHE_PREFIX + category);
    const cacheExists = Array.isArray(cachedBasicsRaw);
    const cachedBasics = cacheExists ? cachedBasicsRaw : [];
    const cacheAge = await idb.get('world_basics_age_' + category) || 0;
    cacheIsFresh = cacheExists && (Date.now() - cacheAge) < WORLDS_CACHE_TTL;

    if (cacheExists) {
      allWorlds = cachedBasics;
      filterWorlds();
      const freshLabel = forceRefresh ? t('world.cacheRefreshing') : (category.startsWith('fav_') || cacheIsFresh ? t('world.cache') : t('world.cacheRefreshing'));
      if (statsEl) statsEl.textContent = t('world.worldCountWithCache', {count: allWorlds.length, state: freshLabel});
      worldLogMsg(t('log.loadedFromCache', {count: cachedBasics.length}) + (cacheIsFresh && !forceRefresh ? t('log.cacheFreshSkipApi') : ''), 'info');

      // Favorite groups are IDB-first: startup/background index sync updates
      // stale favorite caches only when their remote ID index changes.
      // IMPORTANT: rebuild worldFavoriteIdMap from cached favoriteId field BEFORE
      // returning, otherwise cleanupInvalidWorlds() can't find favIds and all
      // DELETE calls fail silently (BUG: every item falls into the else-fail branch).
      if (!forceRefresh && category.startsWith('fav_')) {
        worldFavoriteIdMap = new Map();
        cachedBasics.forEach(w => { if (w.id && w.favoriteId) worldFavoriteIdMap.set(w.id, w.favoriteId); });
        return;
      }
      // If cache is still fresh, skip API refresh entirely — saves 87+ requests
      if (cacheIsFresh && !forceRefresh) return;
    } else {
      gridEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:60px;color:rgba(255,255,255,0.3);">${escHtml(t('loading'))}</div>`;
      worldLogMsg(t('log.fetchingWorldsFromApi'), 'info');
    }
  } catch(_) {}

  // ── Step 2: Streaming Refresh ───────────────────────────────────────────
  try {
    const freshWorlds = [];
    let batchCount = 0;
    // True streaming display: each resolved batch of 5 is APPENDED to the grid
    // immediately via _appendWorldCards (no full rebuild). This replaces the
    // old debounced filterWorlds() approach which either twitched (500ms) or
    // made you wait for all 100 to finish (3000ms). Existing cards are never
    // touched, so there's no twitch AND cards stream in as they arrive.
    const updateWorldBatch = (batch) => {
      if (seq !== currentWorldFetchSeq || category !== currentWorldCategory) return;
      const isFirst = freshWorlds.length === 0;
      batch.forEach(w => {
        const idx = freshWorlds.findIndex(ex => ex.id === w.id);
        if (idx !== -1) freshWorlds[idx] = Object.assign(freshWorlds[idx], w);
        else freshWorlds.push(w);
      });
      allWorlds = freshWorlds;
      batchCount += batch.length;
      // First batch: clear the cache view (if any) and do a clean render so the
      // grid order is correct. Subsequent batches: just append the new cards.
      if (isFirst) renderWorldGrid(freshWorlds);
      else _appendWorldCards(batch);
      saveWorldBasics(category);
      worldLogMsg(t('log.worldsLoadedCount', {count: freshWorlds.length}), 'info');
    };

    if (category.startsWith('fav_')) {
      const groupName = category.slice(4);
      const favType = _worldFavTypeForGroup(groupName);
      const onlineWorldIds = [];
      let favoriteListFailed = false;
      // Clear the previous category's id map so stale entries from another
      // favorite group don't leak into this one (F9: cross-category accumulation
      // caused wrong favId lookups on DELETE and stale gold-star badges).
      worldFavoriteIdMap = new Map();

      let offset = 0;
      while (true) {
        if (seq !== currentWorldFetchSeq) return;
        const r = await apiCall(`/api/vrc/favorites?type=${favType}&tag=${groupName}&n=100&offset=${offset}`);
        if (!r.ok) {
          favoriteListFailed = true;
          worldLogMsg(t('log.favListFetchFail', {status: r.status}), 'error');
          break;
        }
        const favs = await r.json();
        if (!favs || !favs.length || seq !== currentWorldFetchSeq) break;
        
        const worldIds = favs.map(f => {
            if (f.favoriteId) {
                worldFavoriteIdMap.set(f.favoriteId, f.id);
                // Also store a temporary lookup so we can stamp favoriteId
                // onto the world object when it arrives from the API.
                // This makes _worldBasicForWorldsCache persist it to IDB.
                _pendingFavIdMap.set(f.favoriteId, f.id);
            }
            return f.favoriteId;
        }).filter(Boolean);
        onlineWorldIds.push(...worldIds);
        if (favs.length < 100) break;
        offset += 100;
      }

      if (favoriteListFailed) return;

      worldFavGroupCounts.set(groupName, onlineWorldIds.length);
      renderWorldFavGroupButtons();
      const activeBtn = document.getElementById(`worldCatFav_${groupName}`);
      if (activeBtn) { activeBtn.classList.remove('btn-secondary'); activeBtn.classList.add('active', 'btn-primary'); }

      if (forceRefresh && _worldCacheIdsMatch(category, onlineWorldIds)) {
        if (statsEl) statsEl.textContent = t('world.worldCountUpToDate', {count: allWorlds.length});
        worldLogMsg(t('log.favUnchangedSkipRefresh'), 'success');
        return;
      }

      if (onlineWorldIds.length === 0) {
        allWorlds = [];
        renderWorldGrid([]);
        await idb.set(WORLD_CACHE_PREFIX + category, []);
        await idb.set('world_basics_age_' + category, Date.now());
        worldLogMsg(t('log.favEmptySynced'), 'success');
      }

      // Concurrency 8: streams in fast without bursting the CF free-tier
      // subrequest budget. Each resolved chunk is appended immediately
      // (see updateWorldBatch -> _appendWorldCards), so the user sees
      // worlds appear continuously rather than waiting for all 100.
      const CONCURRENCY = 8;
      for (let i = 0; i < onlineWorldIds.length; i += CONCURRENCY) {
          if (seq !== currentWorldFetchSeq || category !== currentWorldCategory) return;
          const chunk = onlineWorldIds.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(chunk.map(wid =>
              apiCall(`/api/vrc/worlds/${wid}`).then(async res => {
                  let w;
                  if (res.status === 404 || res.status === 403) w = { id: wid, name: t('world.invalidWorld') + ' (Invalid World)', isInvalid: true };
                  else w = res.ok ? await res.json() : { id: wid, name: t('world.loadFailed'), isInvalid: true };
                  // Stamp the favorites-record ID so _worldBasicForWorldsCache
                  // can persist it to IDB and cleanupInvalidWorlds can find it.
                  if (_pendingFavIdMap.has(wid)) w.favoriteId = _pendingFavIdMap.get(wid);
                  return w;
              })
          ));
          const freshBatch = results.filter(r => r.status === 'fulfilled').map(r => r.value);
          const invalids = freshBatch.filter(w => w.isInvalid).length;
          if (invalids > 0) worldLogMsg(t('log.foundInvalidWorlds', {count: invalids}), 'error');
          updateWorldBatch(freshBatch);
      }
    } else {
      // Recent, Active, Mine
      let url = '';
      if (category === 'recent') url = '/api/vrc/worlds/recent?n=100';
      else if (category === 'active') url = '/api/vrc/worlds/active?n=100&sort=popularity&order=descending&releaseStatus=public';
      else if (category === 'mine') {
          const uResp = await apiCall('/api/vrc/auth/user');
          if (uResp.ok) {
              const u = await uResp.json();
              url = `/api/vrc/worlds?userId=${u.id}&releaseStatus=all&n=100&sort=updated`;
          }
      }
      if (url) {
          const r = await apiCall(url);
          if (r.ok) updateWorldBatch(await r.json() || []);
          else worldLogMsg(t('log.worldFetchFail', {status: r.status}), 'error');
      }
    }

    if (seq === currentWorldFetchSeq && statsEl) {
        const invalidCount = allWorlds.filter(w => w.isInvalid).length;
        statsEl.textContent = t('world.worldCount', {count: allWorlds.length}) + (invalidCount ? t('world.invalidCountSuffix', {count: invalidCount}) : '');
        worldLogMsg(t('log.worldLoadComplete', {count: allWorlds.length}) + (invalidCount ? t('log.worldLoadInvalids', {count: invalidCount}) : ''), invalidCount > 0 ? 'error' : 'success');
    }
  } catch(e) {
    console.error('World fetch error', e);
    worldLogMsg(t('log.worldLoadError', {msg: e.message}), 'error');
  }
}

function saveWorldBasics(cat) {
    _saveWorldBasicsForCurrentCategory(cat).catch(()=>{});
}

async function cleanupInvalidWorlds() {
    const invalid = allWorlds.filter(w => w.isInvalid);
    const privateNonOwn = allWorlds.filter(w =>
        !w.isInvalid &&
        w.releaseStatus === 'private' &&
        w.authorId && currentUserId &&
        w.authorId !== currentUserId
    );

    if (!invalid.length && !privateNonOwn.length) {
        showToast(t('toast.noInvalidToClean'), 'info');
        return;
    }

    _showCleanupModal({
        title: t('world.cleanFavWorldsTitle'),
        invalidItems: invalid,
        privateNonOwnItems: privateNonOwn,
        invalidLabel: item => item.name || t('world.invalidWorld'),
        onConfirm: async (toDelete, ctx) => {
            let count = 0, fail = 0, done = 0;
            for (const w of toDelete) {
                if (ctx?.isCancelled?.()) break;
                const favId = worldFavoriteIdMap.get(w.id);
                if (favId) {
                    try {
                        const r = await apiCall(`/api/vrc/favorites/${favId}`, { method: 'DELETE' });
                        if (r.ok) {
                            worldFavoriteIdMap.delete(w.id);
                            if (currentWorldCategory && currentWorldCategory.startsWith('fav_')) {
                                await removeWorldFromFavoriteCache(currentWorldCategory.slice(4), w.id);
                            }
                            count++;
                        } else {
                            fail++;
                        }
                    } catch (_) {
                        fail++;
                    }
                } else fail++;
                done++;
                ctx?.updateProgress?.(done, toDelete.length);
                await new Promise(r => setTimeout(r, 200));
            }
            const cancelled = ctx?.isCancelled?.();
            showToast(cancelled ? t('toast.cleanupStopped', {success: count, fail: fail}) : t('toast.cleanupDone', {success: count, fail: fail}), count > 0 ? 'success' : (cancelled ? 'info' : 'error'));
            try { await _saveWorldBasicsForCurrentCategory(); } catch(_) {}
            fetchWorlds(currentWorldCategory, true);
        }
    });
}


function _normalizeWorldPlatform(p) {
    if (!p) return null;
    const s = typeof p === 'string' ? p.toLowerCase() : (p.platform || '').toLowerCase();
    if (s === 'standalonewindows' || s === 'pc') return 'pc';
    if (s === 'android' || s === 'quest') return 'android';
    if (s === 'ios') return 'ios';
    return null;
}

function _getWorldPlatforms(w) {
    if (!w) return [];
    const set = new Set();
    if (Array.isArray(w.platforms)) {
        for (const p of w.platforms) { const n = _normalizeWorldPlatform(p); if (n) set.add(n); }
    }
    if (Array.isArray(w.unityPackages)) {
        for (const p of w.unityPackages) { const n = _normalizeWorldPlatform(p); if (n) set.add(n); }
    }
    return [...set];
}

function filterWorlds() {
  const q = (document.getElementById('worldSearch')?.value||'').toLowerCase().trim();
  const plat = document.getElementById('worldFilterPlatform')?.value || 'all';
  let list = allWorlds;

  if (q) list = list.filter(w => (w.name||'').toLowerCase().includes(q)||(w.description||'').toLowerCase().includes(q));

  if (plat !== 'all') {
    list = list.filter(w => _getWorldPlatforms(w).includes(plat));
  }

renderWorldGrid(list);
}

function _updateWorldActionBtns() {
  const isFav = currentWorldCategory && currentWorldCategory.startsWith('fav_');
  // Match avatar panel behavior exactly: show both buttons whenever in a favorites category
  document.getElementById('btnWorldCleanInvalid')?.classList.toggle('hidden', !isFav);
  document.getElementById('btnWorldUnfavoriteSelected')?.classList.toggle('hidden', !isFav);
}

function renderWorldGrid(list) {
  const gridEl = document.getElementById('worldGrid');
  if (!gridEl) return;
  if (!list.length) {
    gridEl.innerHTML = `<div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;height:300px;color:rgba(255,255,255,0.3);gap:12px;"><div style="font-size:3em;"><i class="fa-solid fa-earth-americas"></i> </div><div>${escHtml(t('world.emptyGrid'))}</div></div>`;
    return;
  }
  gridEl.innerHTML = '';
  list.forEach(w => {
    const card = _buildWorldCard(w);
    gridEl.appendChild(card);
    const img = card.querySelector('.avatar-thumb[data-src]');
    if (img) avatarObserver.observe(img);
  });
}

// Build ONE world card element. Extracted so both the full re-render
// (renderWorldGrid) and the streaming appender (_appendWorldCards) share
// identical markup.
function _buildWorldCard(w) {
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const thumb = proxyImg(w.thumbnailImageUrl||w.imageUrl||'');
  const pc  = w.occupants || 0;
  const card = document.createElement('div');
  card.className = `avatar-card ${w.isInvalid ? 'invalid-world' : ''} ${selectedWorldIds.has(w.id) ? 'selected' : ''}`;
  card.style.cursor = 'pointer';
  card.id = 'world-card-' + w.id;
  if (w.isInvalid) card.style.border = '1px solid rgba(239, 68, 68, 0.4)';
  card.setAttribute('data-worldid', w.id);

  const friendsHere = (allFriends || []).filter(f => f.location && f.location.startsWith(w.id)).length;
  card.onclick = () => openWorldDetail(w.id, w);
  const isCached = loadedImageUrls.has(imageCacheKey(thumb));
  const isFaved  = worldFavoriteIdMap.has(w.id);
  const sel = selectedWorldIds.has(w.id);

  card.innerHTML = `<div class="avatar-thumb-wrapper ${isCached?'':'img-loading'}">
      ${isCached ? `<img class="avatar-thumb" src="${escHtml(thumb)}" alt="">` : `<img class="avatar-thumb loading" src="${BLANK}" data-src="${escHtml(thumb)}" alt="">`}
      <div class="avatar-name-overlay">${escHtml(w.name||t('world.unknownWorld'))}</div>
      <div class="card-tl-overlay">
        <div class="card-checkbox ${sel ? 'on' : ''}" onclick="toggleSelectWorld('${escJsAttr(w.id)}', event)" title="${t('world.toggleSelect')}">${sel ? '✓' : ''}</div>
      </div>
      <div class="card-tr-overlay">
        <div class="card-fav-quick" data-fav-btn="${escHtml(w.id)}" onclick="quickWorldFav('${escJsAttr(w.id)}',event)" title="${isFaved ? t('world.unfavorite') : t('world.addToFavorites')}">${isFaved ? '<i class="fa-solid fa-star"></i> ' : '☆'}</div>
      </div>
      <div style="position:absolute;bottom:8px;right:8px;display:flex;gap:4px;z-index:5;pointer-events:none;">
        ${friendsHere>0 ? `<div style="background:var(--accent);color:white;font-size:0.7em;padding:2px 6px;border-radius:4px;font-weight:700;box-shadow:0 2px 4px rgba(0,0,0,0.3);"><i class="fa-solid fa-handshake"></i> ${friendsHere}</div>` : ''}
        ${pc>0 ? `<div class="world-player-badge" style="position:static;margin:0;"><i class="fa-solid fa-user-group"></i> ${pc}</div>` : ''}
      </div>
      ${w.isInvalid ? `<div class="card-release-badge release-private" style="background:var(--error);">${escHtml(t('world.invalid'))}</div>` : ''}
    </div>`;
  return card;
}

// Append world cards INCREMENTALLY during streaming load, without rebuilding
// the whole grid. This is what gives true streaming display: each batch of 5
// shows up as soon as it resolves, instead of waiting for all 100. Cards
// already present are skipped (by id), so calling this repeatedly is safe.
// A search/platform filter being active falls back to a full filtered render.
function _appendWorldCards(batch) {
  const gridEl = document.getElementById('worldGrid');
  if (!gridEl) return;
  // If a filter is active the incremental path could show cards that don't
  // match — defer to the full filtered render instead.
  const q = (document.getElementById('worldSearch')?.value || '').trim();
  const plat = document.getElementById('worldFilterPlatform')?.value || 'all';
  if (q || plat !== 'all') { filterWorlds(); return; }

  // Clear the "加载中..." placeholder on first append.
  const placeholder = gridEl.querySelector('div[style*="grid-column"]');
  if (placeholder) gridEl.innerHTML = '';

  batch.forEach(w => {
    if (document.getElementById('world-card-' + w.id)) return; // already shown
    const card = _buildWorldCard(w);
    gridEl.appendChild(card);
    const img = card.querySelector('.avatar-thumb[data-src]');
    if (img) avatarObserver.observe(img);
  });
}

// ── Global sync for favorite status ────────────────────────────────────────
function _broadcastWorldFavUpdate(worldId, isFaved) {
  // 1. Update all visible grid cards
  const btn = document.querySelector(`[data-fav-btn="${worldId}"]`);
  if (btn) {
    btn.innerHTML = isFaved ? '<i class="fa-solid fa-star"></i> ' : '☆';
    btn.title = isFaved ? t('world.unfavorite') : t('world.addToFavorites');
  }
  // 2. Update mobile bottom action bar button (id=worldDetailFavBtn)
  if (currentWorldDetail && currentWorldDetail.id === worldId) {
    const mobileBtn = document.getElementById('worldDetailFavBtn');
    if (mobileBtn) {
      mobileBtn.innerHTML = isFaved ? `<i class="fa-solid fa-star"></i> ${escHtml(t('world.unfavorite'))}` : `<i class="fa-solid fa-star"></i> ${escHtml(t('world.favorite'))}`;
      mobileBtn.className = isFaved ? 'btn btn-warning' : 'btn btn-secondary';
    }
    // 3. Also update the desktop header icon button
    const headerBtn = document.getElementById('worldDetailMainFavBtn');
    if (headerBtn) {
      headerBtn.innerHTML = isFaved ? '<i class="fa-solid fa-star"></i> ' : '☆';
      headerBtn.title = isFaved ? t('world.unfavorite') : t('world.addToFavorites');
    }
  }
}

// ── Quick World Favorite (from grid card) ──────────────────────────────────
async function quickWorldFav(worldId, event) {
  event.stopPropagation();
  const btn = event.currentTarget;

  if (worldFavoriteIdMap.has(worldId)) {
    if (!confirm(t('confirm.unfavoriteWorld'))) return;
    btn.innerHTML = '<i class="fa-solid fa-hourglass-half"></i> ';
    try {
      const favId = worldFavoriteIdMap.get(worldId);
      // Determine which favorite group this world belongs to. The old code tried
      // cur.favorites[0]?.tags?.[0] but the /worlds/<id> response has no
      // favorites array, so it almost always fell through. The reliable signal
      // is the currently-viewed category (fav_<groupName>) since this map is
      // rebuilt per-category.
      const removedGroup = (currentWorldCategory && currentWorldCategory.startsWith('fav_'))
        ? currentWorldCategory.replace(/^fav_/, '')
        : null;
      const r = await apiCall(`/api/vrc/favorites/${favId}`, { method: 'DELETE' });
      if (r.ok) {
        worldFavoriteIdMap.delete(worldId);
        _broadcastWorldFavUpdate(worldId, false);
        if (removedGroup) {
          const c = worldFavGroupCounts.get(removedGroup) || 0;
          worldFavGroupCounts.set(removedGroup, Math.max(0, c - 1));
          await removeWorldFromFavoriteCache(removedGroup, worldId);
        }
        if (currentWorldCategory.startsWith('fav_')) {
          allWorlds = allWorlds.filter(w => w.id !== worldId);
          filterWorlds();
        }
      } else { btn.innerHTML = '<i class="fa-solid fa-star"></i> '; showToast(t('toast.unfavoriteFail'), 'error'); }
    } catch(e) { btn.innerHTML = '<i class="fa-solid fa-star"></i> '; }
    return;
  }

  // Auto-load groups if empty
  if (!worldFavGroups.length) {
    btn.innerHTML = '<i class="fa-solid fa-hourglass-half"></i> ';
    await loadWorldFavGroups();
    btn.textContent = '☆';
    if (!worldFavGroups.length) { showToast(t('toast.favGroupListFail'), 'error'); return; }
  }

  document.getElementById('_wqfMenu')?.remove();
  const menu = document.createElement('div');
  menu.id = '_wqfMenu';
  menu.style.cssText = `
    position:fixed;z-index:9999;
    background:var(--bg-card);border:1px solid var(--border);
    border-radius:10px;padding:6px;min-width:150px;
    box-shadow:0 8px 24px rgba(0,0,0,0.6);
  `;
  const hdr = document.createElement('div');
  hdr.style.cssText = 'font-size:0.72em;color:var(--text-muted);padding:4px 8px 6px;border-bottom:1px solid var(--border);margin-bottom:4px;';
  hdr.innerHTML = t('world.favoriteTo');
  menu.appendChild(hdr);

  worldFavGroups.forEach(g => {
    const b = document.createElement('button');
    b.className = 'avtrdb-fav-group-btn';
    b.style.cssText = 'width:100%;display:block;text-align:left;';
    b.textContent = g.displayName || g.name;
    b.onclick = async () => {
      btn.innerHTML = '<i class="fa-solid fa-hourglass-half"></i> ';
      try {
        const r = await apiCall('/api/vrc/favorites', {
          method: 'POST',
          json: { type: _worldFavTypeForGroup(g.name), favoriteId: worldId, tags: [g.name] }
        });
        if (r.ok) {
          const res = await r.json();
          worldFavoriteIdMap.set(worldId, res.id);
          _broadcastWorldFavUpdate(worldId, true);
          // Bump the per-group counter so the dropdown limit/disabled state
          // stays accurate without waiting for a refresh.
          worldFavGroupCounts.set(g.name, (worldFavGroupCounts.get(g.name) || 0) + 1);
          const knownWorld = allWorlds.find(w => w.id === worldId) || currentWorldDetail || { id: worldId };
          await upsertWorldIntoFavoriteCache(g.name, knownWorld);
        } else { btn.textContent = '☆'; showToast(t('toast.favoriteFail'), 'error'); }
      } catch(e) { btn.textContent = '☆'; }
    };
    menu.appendChild(b);
  });

  const rect = btn.getBoundingClientRect();
  const menuW = 160, menuH = worldFavGroups.length * 38 + 40;
  let left = rect.left, top = rect.bottom + 6;
  if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
  if (top + menuH > window.innerHeight - 8) top = rect.top - menuH - 6;
  menu.style.left = left + 'px';
  menu.style.top  = top  + 'px';

  document.body.appendChild(menu);

  const cleanup = () => { menu.remove(); document.removeEventListener('click', closeHandler, true); };
  const closeHandler = e => { if (!menu.contains(e.target)) cleanup(); };
  menu.querySelectorAll('button').forEach(b => {
    const original = b.onclick;
    b.onclick = async (e) => { await original(e); cleanup(); };
  });
  setTimeout(() => document.addEventListener('click', closeHandler, true), 10);
}


function selectAllWorlds() {
  const list = allWorlds;
  const allSelected = selectedWorldIds.size > 0 && selectedWorldIds.size === list.length;
  selectedWorldIds.clear();
  if (!allSelected) list.forEach(w => selectedWorldIds.add(w.id));
  list.forEach(w => {
    const card = document.getElementById('world-card-' + w.id);
    if (!card) return;
    const sel = selectedWorldIds.has(w.id);
    card.classList.toggle('selected', sel);
    // Sync the unified .card-checkbox UI (added in renderWorldGrid).
    const cb = card.querySelector('.card-checkbox');
    if (cb) {
      cb.classList.toggle('on', sel);
      cb.textContent = sel ? '✓' : '';
    }
  });
  // Toggle button text: 全选 ↔ 取消全选
  const btn = document.getElementById('btnWorldSelectAll');
  if (btn) btn.textContent = selectedWorldIds.size > 0 ? t('world.unselectAll') : t('world.selectAll');
  _updateWorldActionBtns();
}

async function unfavoriteSelectedWorlds() {
  if (selectedWorldIds.size === 0) return;
  const count = selectedWorldIds.size;
  if (!confirm(t('confirm.unfavoriteSelectedWorlds', {count: count}))) return;
  worldLogMsg(t('log.batchRemoveStart', {count: count}), 'info');
  const ids = [...selectedWorldIds];
  let success = 0, fail = 0;
  for (const wid of ids) {
    const fid = worldFavoriteIdMap.get(wid);
    const wName = allWorlds.find(w => w.id === wid)?.name || wid;
    if (!fid) { fail++; worldLogMsg(t('log.favIdNotFound', {name: wName}), 'error'); continue; }
    try {
      const resp = await apiCall(`/api/vrc/favorites/${fid}`, { method: 'DELETE' });
      if (!resp.ok) throw new Error(await resp.text());
      worldFavoriteIdMap.delete(wid);
      if (currentWorldCategory && currentWorldCategory.startsWith('fav_')) {
        await removeWorldFromFavoriteCache(currentWorldCategory.slice(4), wid);
      }
      allWorlds = allWorlds.filter(w => w.id !== wid);
      selectedWorldIds.delete(wid);
      const card = document.getElementById('world-card-' + wid);
      if (card) {
        card.style.transform = 'scale(0.9)';
        card.style.opacity = '0';
        card.style.transition = 'all 0.15s ease';
        setTimeout(() => card.remove(), 150);
      }
      success++;
      worldLogMsg(t('log.worldRemoved', {name: wName}), 'success');
    } catch(e) { fail++; worldLogMsg(t('log.worldRemoveFail', {name: wName, msg: e.message}), 'error'); }
    await new Promise(r => setTimeout(r, 300));
  }
  try { await idb.set(WORLD_CACHE_PREFIX + currentWorldCategory, allWorlds); } catch(_) {}
  worldLogMsg(t('log.batchRemoveDone', {success: success, fail: fail}), success > 0 ? 'success' : 'error');
  _updateWorldActionBtns();
}

async function cleanInvalidWorlds() {
  if (!currentWorldCategory || !currentWorldCategory.startsWith('fav_')) return;
  return cleanupInvalidWorlds();
}

function toggleSelectWorld(id, e) {
  e.stopPropagation();
  if (selectedWorldIds.has(id)) selectedWorldIds.delete(id);
  else selectedWorldIds.add(id);
  const isSelected = selectedWorldIds.has(id);
  const card = document.getElementById('world-card-' + id);
  if (card) {
    card.classList.toggle('selected', isSelected);
    // Sync the unified .card-checkbox UI (added in renderWorldGrid).
    const cb = card.querySelector('.card-checkbox');
    if (cb) {
      cb.classList.toggle('on', isSelected);
      cb.textContent = isSelected ? '✓' : '';
    }
  }
  _updateWorldActionBtns();
}

// ── World Detail Tab Switcher ──────────────────────────────────────────────
function switchWorldDetailTab(tab) {
  const pages = { info: 'wdPageInfo', instances: 'wdPageInstances', raw: 'wdPageRaw' };
  const btns  = { info: 'wdTabInfo',  instances: 'wdTabInstances',  raw: 'wdTabRaw' };
  Object.entries(pages).forEach(([t, pageId]) => {
    const page = document.getElementById(pageId);
    if (page) page.style.display = (t === tab) ? '' : 'none';
    const btn = document.getElementById(btns[t]);
    if (btn) btn.classList.toggle('active', t === tab);
  });
}

async function openWorldDetail(worldId, worldObj = null) {
  const modal = document.getElementById('worldDetailModal');
  if (!modal) return;
  bumpUiEpoch();
  const detailToken = makeUiToken('worldDetail', worldId);
  window._worldDetailActiveToken = detailToken;
  const detailCtrl = beginScopedAbort('worldDetail');

  // Show the modal FIRST so the user sees something immediately,
  // even if subsequent setup throws.
  modal.style.zIndex = modalZTop();
  modal.classList.remove('hidden');
  if (modal.dataset.scrollLocked !== '1') { lockBodyScroll(); modal.dataset.scrollLocked = '1'; }

  // Reset UI to loading state
  const safe = (id) => document.getElementById(id);
  if (safe('worldDetailName'))          safe('worldDetailName').textContent = t('loading');
  if (safe('worldDetailBreadcrumbName'))safe('worldDetailBreadcrumbName').textContent = t('loading');
  if (safe('worldDetailBreadcrumbAuthor'))safe('worldDetailBreadcrumbAuthor').textContent = '...';
  if (safe('worldDetailInstances'))     safe('worldDetailInstances').innerHTML = `<div style="color:var(--text-muted);font-size:0.8em;padding:8px;text-align:center;">${escHtml(t('world.loadingInstances'))}</div>`;
  if (safe('worldDetailFavStatus'))     safe('worldDetailFavStatus').textContent = '';
  if (safe('worldDetailBadges'))        safe('worldDetailBadges').innerHTML = '';
  if (safe('worldDetailRawJson'))       safe('worldDetailRawJson').textContent = '';

  switchWorldDetailTab('info');
  if (worldObj) { const img = safe('worldDetailImg'); if (img) img.src = proxyImg(worldObj.thumbnailImageUrl||worldObj.imageUrl||''); }

  try {
    const r = await apiCall(`/api/vrc/worlds/${worldId}`, { signal: detailCtrl.signal, noDedupe: true });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const w = await r.json();
    if (!isUiTokenCurrent(detailToken) || !isScopedAbortCurrent('worldDetail', detailCtrl)) return;
    currentWorldDetail = w;

    // Fill Basic Info
    document.getElementById('worldDetailImg').src = proxyImg(w.thumbnailImageUrl||w.imageUrl||'');
    document.getElementById('worldDetailName').textContent = w.name || 'Unknown World';
    document.getElementById('worldDetailBreadcrumbName').textContent = w.name || 'World';
    document.getElementById('worldDetailBreadcrumbAuthor').textContent = w.authorName || 'Unknown';
    document.getElementById('worldDetailAuthorRow').innerHTML = `by <a href="#" onclick="openFriendProfileById('${escJsAttr(w.authorId)}'); event.preventDefault();" style="color:var(--accent-light);text-decoration:none;font-weight:600;">${escHtml(w.authorName||'Unknown')}</a>`;
    document.getElementById('worldDetailId').textContent = w.id;
    document.getElementById('worldDetailDesc').textContent = w.description || t('world.noDescription');
    document.getElementById('worldDetailCreated').textContent = formatDate(w.created_at);
    document.getElementById('worldDetailUpdated').textContent = formatDate(w.updated_at);
    document.getElementById('worldDetailRawJson').textContent = JSON.stringify(w, null, 2);

    // Badges
    const badgesEl = document.getElementById('worldDetailBadges');
    badgesEl.innerHTML = `
      <span class="avtrdb-badge" style="background:rgba(134,239,172,0.1);color:#4ade80;border-color:rgba(134,239,172,0.2);">${escHtml(w.releaseStatus||'public').toUpperCase()}</span>
      <span class="avtrdb-badge"><i class="fa-solid fa-user-group"></i> ${w.capacity || 0}</span>
      <span class="avtrdb-badge">v${w.version || 1}</span>
    `;
    
    // Platforms
    const platforms = [];
    if (w.unityPackages?.some(p => p.platform === 'standalonewindows')) platforms.push('PC');
    if (w.unityPackages?.some(p => p.platform === 'android')) platforms.push('Android');
    platforms.forEach(p => {
      badgesEl.innerHTML += `<span class="avtrdb-badge" style="background:rgba(255, 255, 255, 0.1);color:#d4d4d8;border-color:rgba(255, 255, 255, 0.2);">${p}</span>`;
    });
    document.getElementById('worldDetailPlatformsList').innerHTML = platforms.map(p => `<span class="avtrdb-badge">${p}</span>`).join('');

    // Tags
    const tags = (w.tags||[]).filter(t=>!t.startsWith('author_tag')&&!t.startsWith('system_'));
    document.getElementById('worldDetailTags').innerHTML = tags.slice(0,12).map(t=>`<span class="avtrdb-badge" style="font-size:0.7em;padding:2px 6px;">${escHtml(t)}</span>`).join('');

    // Delete Button (only if I'm the author)
    const delBtn = document.getElementById('worldDetailDeleteBtn');
    if (delBtn) delBtn.style.display = (w.authorId === currentUserId) ? 'flex' : 'none';

    // ── Instances & Friends ──
    const instContainer = document.getElementById('worldDetailInstances');
    const friendsInWorld = (allFriends || []).filter(f => f.location && f.location.startsWith(worldId + ':'));
    if (myProfileData?.location?.startsWith(worldId + ':')) {
      if (!friendsInWorld.some(f => f.id === myProfileData.id)) friendsInWorld.unshift({ ...myProfileData });
    }

    let html = '';
    if (friendsInWorld.length) {
      const friendInstMap = new Map();
      for (const f of friendsInWorld) {
        const instStr = f.location.slice(worldId.length + 1);
        if (!friendInstMap.has(instStr)) friendInstMap.set(instStr, []);
        friendInstMap.get(instStr).push(f);
      }
      html += `<div style="font-size:0.8em;font-weight:700;color:var(--text-primary);margin-bottom:8px;">${t('world.friendsInWorld')}</div>`;
      for (const [instStr, friends] of friendInstMap) {
        let typeLabel = t('world.instPublic'), typeColor = '#64748b';
        if (instStr.includes('~private'))      { typeLabel=t('world.instPrivate'); typeColor='#f59e0b'; }
        else if (instStr.includes('~hidden'))  { typeLabel=t('world.instFriendsPlus'); typeColor='#22c55e'; }
        else if (instStr.includes('canRequestInvite')) { typeLabel=t('world.instFriendsPlus'); typeColor='#22c55e'; }
        else if (instStr.includes('~friends')) { typeLabel=t('world.instFriends'); typeColor='#22c55e'; }
        else if (instStr.includes('group('))   { typeLabel=t('world.instGroup'); typeColor='#3b82f6'; }
        const fullLoc = worldId + ':' + instStr;
        html += `<div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:12px;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
            <span style="font-size:0.65em;padding:2px 8px;border-radius:6px;background:${typeColor}22;color:${typeColor};border:1px solid ${typeColor}44;font-weight:700;">${typeLabel}</span>
            <span style="flex:1;font-size:0.75em;opacity:0.6;font-family:monospace;overflow:hidden;text-overflow:ellipsis;">#${escHtml(instStr.split('~')[0])}</span>
            ${!instStr.includes('~private') ? `<button class="btn btn-xs" onclick="inviteSelf('${escJsAttr(fullLoc)}')" style="padding:4px 10px;font-size:0.75em;background:rgba(74,222,128,0.1);color:#4ade80;border:1px solid rgba(74,222,128,0.2);">${t('world.inviteSelf')}</button>` : ''}
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${friends.map(f => {
              const trust = getTrustInfo(f.tags||[]);
              return `<div onclick="openFriendProfileById('${escJsAttr(f.id)}')" style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(255,255,255,0.05);border-radius:8px;cursor:pointer;border:1px solid transparent;transition:all 0.15s;" onmouseover="this.style.background='rgba(255,255,255,0.08)';this.style.borderColor='var(--border)'" onmouseout="this.style.background='rgba(255,255,255,0.05)';this.style.borderColor='transparent'">
                <img src="${proxyImg(f.currentAvatarThumbnailImageUrl||f.userIcon||'')}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;border:2px solid ${trust.color}66;">
                <span style="font-size:0.85em;font-weight:600;color:${trust.color};">${escHtml(f.displayName)}</span>
              </div>`;
            }).join('')}
          </div>
        </div>`;
      }
      html += `<div style="font-size:0.8em;font-weight:700;color:var(--text-primary);margin:8px 0 8px;">${t('world.publicInstances')}</div>`;
    }

    const instances = Array.isArray(w.instances) ? w.instances : [];
    const descRow = document.getElementById('worldDetailDescRow');
    const descEl  = document.getElementById('worldDetailDesc');
    if (descEl) descEl.textContent = w.description||'';
    if (descRow) descRow.style.display = w.description ? '' : 'none';
    let friendsHtml = '';
    if (friendsInWorld.length) {
      // Group by instance
      const friendInstMap = new Map();
      for (const f of friendsInWorld) {
        const instStr = f.location.slice(worldId.length + 1); // strip "wrld_xxx:"
        if (!friendInstMap.has(instStr)) friendInstMap.set(instStr, []);
        friendInstMap.get(instStr).push(f);
      }
      friendsHtml = `<div style="font-size:0.82em;font-weight:700;color:var(--text-primary);margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border);">${t('world.friendsInWorld')}</div>`;
      for (const [instStr, friends] of friendInstMap) {
        let typeLabel = t('world.instPublic'), typeColor = '#64748b';
        if (instStr.includes('~private'))      { typeLabel=t('world.instPrivate'); typeColor='#f59e0b'; }
        else if (instStr.includes('~hidden'))  { typeLabel=t('world.instFriendsPlus'); typeColor='#22c55e'; }
        else if (instStr.includes('canRequestInvite')) { typeLabel=t('world.instFriendsPlus'); typeColor='#22c55e'; }
        else if (instStr.includes('~friends')) { typeLabel=t('world.instFriends'); typeColor='#22c55e'; }
        else if (instStr.includes('group('))   { typeLabel=t('world.instGroup'); typeColor='#3b82f6'; }
        const fullLoc = worldId + ':' + instStr;
        const isPrivateInst = instStr.includes('~private');
        friendsHtml += `<div style="background:rgba(134,239,172,0.05);border:1px solid rgba(134,239,172,0.2);border-radius:8px;padding:8px;margin-bottom:8px;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
            <span style="font-size:0.7em;padding:2px 7px;border-radius:99px;background:${typeColor}22;color:${typeColor};border:1px solid ${typeColor}44;">${typeLabel}</span>
            <span style="flex:1;font-size:0.72em;opacity:0.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(instStr.split('~')[0])}</span>
            ${!isPrivateInst ? `<button class="btn btn-xs" onclick="inviteSelf('${escJsAttr(fullLoc)}')" style="padding:2px 8px;font-size:0.75em;background:rgba(134,239,172,0.1);color:#4ade80;border:1px solid rgba(134,239,172,0.2);border-radius:4px;cursor:pointer;">${t('world.inviteSelf')}</button>` : ''}
            <button class="btn btn-xs" onclick="openInstanceDetail('${escJsAttr(fullLoc)}')" style="padding:2px 8px;font-size:0.75em;background:rgba(255, 255, 255, 0.1);color:#d4d4d8;border:1px solid rgba(255, 255, 255, 0.2);border-radius:4px;cursor:pointer;">${t('world.instanceDetails')}</button>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            ${friends.map(f => {
              const trust = getTrustInfo(f.tags||[]);
              return `<div onclick="openFriendProfileById('${escJsAttr(f.id)}')" style="display:flex;align-items:center;gap:6px;padding:4px 8px;background:rgba(255,255,255,0.04);border-radius:6px;cursor:pointer;transition:background 0.15s;" onmouseover="this.style.background='rgba(255,255,255,0.08)'" onmouseout="this.style.background='rgba(255,255,255,0.04)'">
                <img src="${proxyImg(f.currentAvatarThumbnailImageUrl||f.userIcon||'')}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;border:2px solid ${trust.color}44;">
                <span style="font-size:0.78em;font-weight:600;color:${trust.color};">${escHtml(f.displayName)}</span>
              </div>`;
            }).join('')}
          </div>
        </div>`;
      }
      friendsHtml += `<div style="font-size:0.82em;font-weight:700;color:var(--text-primary);margin:10px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--border);">${t('world.publicInstances')}</div>`;
    }

    // Bug#1: instance entry format is [instanceString, occupantCount]
    // e.g. ["12345~region(jp)", 3] or ["12345~friends(usr_xxx)~canRequestInvite~region(jp)~strict", 5]
    const activeInst = instances.filter(([,c])=>c>0).sort(([,a],[,b])=>b-a);
    if (!activeInst.length && !friendsHtml) {
      instContainer.innerHTML = `<div style="color:rgba(255,255,255,0.3);font-size:0.8em;padding:8px;">${escHtml(t('world.noPlayersOnline'))}</div>`;
    } else if (!activeInst.length) {
      instContainer.innerHTML = friendsHtml;
    } else {
      instContainer.innerHTML = activeInst.slice(0,10).map(([instStr, count]) => {
        let typeLabel = t('world.instPublic'), typeColor = '#64748b';
        if (instStr.includes('~private'))   { typeLabel=t('world.instPrivate'); typeColor='#f59e0b'; }
        else if (instStr.includes('~friends+') || instStr.includes('canRequestInvite')) { typeLabel=t('world.instFriendsPlus'); typeColor='#22c55e'; }
        else if (instStr.includes('~friends')) { typeLabel=t('world.instFriends'); typeColor='#22c55e'; }
        else if (instStr.includes('~hidden')) { typeLabel=t('world.instFriendsPlus'); typeColor='#22c55e'; }
        else if (instStr.includes('group(')) { typeLabel=t('world.instGroup'); typeColor='#3b82f6'; }

        const regionMatch = instStr.match(/region\(([^)]+)\)/);
        const region = regionMatch ? regionMatch[1].toUpperCase() : '';
        const regionFlag = {JP:'🇯🇵',US:'🇺🇸',EU:'🇪🇺',USE:'🇺🇸',USW:'🇺🇸'}[region] || (region?`[${region}]`:'');

        const isPrivate = instStr.includes('~private');
        const instShortId = instStr.split('~')[0]; // just the numeric instance ID
        return `<div class="world-instance-item" style="display:flex;align-items:center;gap:8px;padding:8px;background:rgba(255,255,255,0.02);border-radius:8px;margin-bottom:4px;">
          <span style="flex:1;font-size:0.78em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${regionFlag} ${escHtml(instShortId)}</span>
          <span style="font-size:0.68em;padding:2px 7px;border-radius:99px;background:${typeColor}22;color:${typeColor};border:1px solid ${typeColor}44;">${typeLabel}</span>
          <span class="inst-players" style="font-size:0.75em;opacity:0.7;"><i class="fa-solid fa-user-group"></i> ${count}/${w.capacity||'∞'}</span>
          <div style="display:flex;gap:4px;">
            <button class="btn btn-xs" onclick="event.stopPropagation();openInstanceDetail('${escJsAttr(w.id)}:${escJsAttr(instStr)}')" style="padding:2px 6px;font-size:0.8em;border-radius:4px;background:rgba(255, 255, 255, 0.15);color:var(--accent-light);border:1px solid var(--accent);cursor:pointer;" title="${t('world.viewWhoInInstance')}"><i class="fa-solid fa-user-group"></i> </button>
            ${!isPrivate ? `<button class="btn btn-xs" onclick="event.stopPropagation();inviteSelf('${escJsAttr(w.id)}:${escJsAttr(instStr)}')" style="padding:2px 6px;font-size:0.8em;border-radius:4px;background:rgba(134,239,172,0.1);color:#4ade80;border:1px solid rgba(134,239,172,0.2);cursor:pointer;" title="${t('world.sendInvite')}">&nbsp;<i class="fa-solid fa-envelope"></i> &nbsp;</button>` : ''}
          </div>
        </div>`;
      }).join('');
      instContainer.innerHTML = friendsHtml + instContainer.innerHTML;
    }

    const favBtn  = document.getElementById('worldDetailFavBtn');
    const isFaved = worldFavoriteIdMap.has(w.id) || !!w.favoriteId;
    if (isFaved && w.favoriteId) worldFavoriteIdMap.set(w.id, w.favoriteId);
    if (favBtn) {
      favBtn.innerHTML  = isFaved ? `<i class="fa-solid fa-star"></i> ${escHtml(t('world.unfavorite'))}` : `<i class="fa-solid fa-star"></i> ${escHtml(t('world.favorite'))}`;
      favBtn.className  = isFaved ? 'btn btn-warning' : 'btn btn-secondary';
    }
  } catch(e) {
    // apiCall converts abort into a Response with status 499 rather than
    // throwing AbortError, so isAbortError(e) never fires here. The 499 check
    // below handles the real "user switched tab mid-fetch" path.
    if (e && e.status === 499) return;
    if (isAbortError(e)) return;
    if (!isUiTokenCurrent(detailToken)) return;
    document.getElementById('worldDetailName').textContent = t('world.loadFailed');
    document.getElementById('worldDetailInstances').innerHTML = `<div style="color:var(--error);padding:8px;">${escHtml(e.message)}</div>`;
  }
}

function closeWorldDetail() {
  bumpUiEpoch();
  window._worldDetailActiveToken = null;
  cancelScopedAbort('worldDetail');
  const modal = document.getElementById('worldDetailModal');
  if (modal) {
    modal.classList.add('hidden');
    if (modal.dataset.scrollLocked === '1') { unlockBodyScroll(); modal.dataset.scrollLocked = ''; }
  }
  currentWorldDetail = null;
  if (typeof flushPendingAvatarCardUpdates === 'function') flushPendingAvatarCardUpdates();
}

// Delete the world the user is currently viewing.
// Wired from #worldDetailDeleteBtn (only visible for the user's own worlds —
// see openWorldDetail logic that flips its display:none). Without this binding
// the trash icon was a no-op: there was no JS handler at all.
async function deleteCurrentWorld() {
  const w = currentWorldDetail;
  if (!w) return;
  if (!confirm(t('confirm.deleteWorld', {name: w.name || w.id}))) return;
  try {
    const r = await apiCall(`/api/vrc/worlds/${encodeURIComponent(w.id)}`, { method: 'DELETE' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      showToast(t('toast.deleteWorldFail', {msg: err.error?.message || ('HTTP ' + r.status)}), 'error');
      return;
    }
    logMsg(t('log.worldDeleted', {name: w.name || w.id}), 'success');
    closeWorldDetail();
    // Drop from in-memory list and re-filter so the card disappears without
    // needing a tab reload.
    if (Array.isArray(allWorlds)) {
      allWorlds = allWorlds.filter(x => x.id !== w.id);
      if (typeof filterWorlds === 'function') filterWorlds();
    }
    // Invalidate the IDB cache for this category so it isn't resurrected from
    // the 60s TTL on the next reload. Delete the basics payload entirely (not
    // just age=0) so a cold load doesn't briefly show the deleted world before
    // the API refresh lands.
    if (currentWorldCategory) {
      try {
        await idb.set('world_basics_age_' + currentWorldCategory, 0);
        await idb.del(WORLD_CACHE_PREFIX + currentWorldCategory);
      } catch(_) {}
    }
  } catch(e) {
    showToast(t('toast.deleteWorldFail', {msg: e.message}), 'error');
  }
}

// ── Cache Management Modal ─────────────────────────────────────────────────
async function showCacheClearModal() {
  document.getElementById('cacheClearModal')?.remove();

  // Read all cache keys
  let allKeys = [];
  try { allKeys = await idb.keys(); } catch(_) {}

  // Define categories with matchers
  const CATEGORIES = [
    { id: 'friend',  label: t('label.cacheFriend'),  emoji: '<i class="fa-solid fa-user-group"></i> ', match: k => k === 'friend_basics' },
    { id: 'profile', label: t('label.cacheProfile'), emoji: '<i class="fa-solid fa-id-badge"></i> ', match: k => k === 'my_profile' },
    { id: 'avatar',  label: t('label.cacheAvatar'),  emoji: '<i class="fa-solid fa-masks-theater"></i> ', match: k => k.startsWith('avatar') || k.startsWith('avatars_') },
    { id: 'world',   label: t('label.cacheWorld'),   emoji: '<i class="fa-solid fa-earth-americas"></i> ', match: k => k.startsWith('world') || k.startsWith('worlds_') },
    { id: 'names',   label: t('label.cacheNames'),   emoji: '<i class="fa-solid fa-clipboard"></i> ', match: k => k === 'persistent_avatar_names' },
    { id: 'images',  label: t('label.cacheImages'),  emoji: '🖼️', match: () => false, isImages: true },
    { id: 'other',   label: t('label.cacheOther'),   emoji: '<i class="fa-solid fa-box"></i> ', match: k => true },
  ];

  // Assign each key to first matching category
  const catKeys = {};
  CATEGORIES.forEach(c => catKeys[c.id] = []);
  for (const k of allKeys) {
    let matched = false;
    for (const cat of CATEGORIES) {
      if (cat.isImages) continue;
      if (cat.match(k)) { catKeys[cat.id].push(k); matched = true; break; }
    }
    if (!matched) catKeys['other'].push(k);
  }

  // Estimate image blob count
  let imageCount = 0;
  try {
    imageCount = await new Promise(res => {
      const tx = idb.db.transaction('images','readonly');
      const req = tx.objectStore('images').count();
      req.onsuccess = () => res(req.result);
      req.onerror  = () => res(0);
    });
  } catch(_) {}
  catKeys['images'] = imageCount > 0 ? Array(imageCount).fill('__img__') : [];

  const modal = document.createElement('div');
  modal.id = 'cacheClearModal';
  // z-index set after appendChild via modalZTop() so it stacks above any open modal.
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;padding:16px;';

  const rows = CATEGORIES.map(cat => {
    const count = catKeys[cat.id].length;
    if (count === 0) return '';
    return `<label style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:8px;background:rgba(255,255,255,0.03);cursor:pointer;border:1px solid transparent;transition:border-color 0.15s;" onmouseover="this.style.borderColor='var(--border)'" onmouseout="this.style.borderColor='transparent'">
      <input type="checkbox" id="ccc_${cat.id}" checked style="width:16px;height:16px;accent-color:var(--accent);flex-shrink:0;">
      <span style="font-size:1.2em;">${cat.emoji}</span>
      <div style="flex:1;">
        <div style="font-weight:600;font-size:0.88em;">${cat.label}</div>
        <div style="font-size:0.75em;color:var(--text-muted);">${cat.isImages ? t('world.imageBlobCount', {count: count}) : t('world.recordCount', {count: count})}</div>
      </div>
    </label>`;
  }).join('');

  modal.innerHTML = `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:24px;max-width:420px;width:100%;display:flex;flex-direction:column;gap:14px;box-shadow:0 24px 64px rgba(0,0,0,0.6);">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <h2 style="margin:0;font-size:1.1em;">${t('world.clearCacheTitle')}</h2>
      <button id="cccClose" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:1.5em;line-height:1;">×</button>
    </div>
    <div style="font-size:0.8em;color:var(--text-muted);background:rgba(255,200,0,0.08);border:1px solid rgba(255,200,0,0.25);border-radius:8px;padding:10px 12px;">
      ${t('world.clearCacheWarn')}
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;">
      ${rows || `<div style="color:var(--text-muted);font-size:0.85em;text-align:center;padding:20px;">${escHtml(t('world.cacheEmpty'))}</div>`}
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="cccCancel" class="btn btn-secondary" style="padding:8px 20px;">${escHtml(t('btn.cancel'))}</button>
      <button id="cccConfirm" class="btn btn-primary" style="padding:8px 20px;background:linear-gradient(135deg,#ef4444,#dc2626);border-color:transparent;">${t('world.confirmClear')}</button>
    </div>
  </div>`;

  document.body.appendChild(modal);
  // Stack above any open modal and lock background scroll.
  // Set dataset.scrollLocked so the global Esc handler routes through our
  // close() → unlockBodyScroll instead of force-removing and leaking the lock.
  modal.style.zIndex = modalZTop();
  if (!modal.dataset.scrollLocked) {
    lockBodyScroll();
    modal.dataset.scrollLocked = '1';
  }
  const close = () => { modal.remove(); unlockBodyScroll(); };
  document.getElementById('cccClose').onclick = close;
  document.getElementById('cccCancel').onclick = close;
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  document.getElementById('cccConfirm').onclick = async () => {
    const btn = document.getElementById('cccConfirm');
    btn.disabled = true;
    btn.textContent = t('world.clearing');

    // Collect keys to delete
    const keysToDelete = [];
    for (const cat of CATEGORIES) {
      if (cat.isImages) continue;
      if (document.getElementById('ccc_' + cat.id)?.checked) {
        keysToDelete.push(...catKeys[cat.id]);
      }
    }

    // Delete from cache store
    if (keysToDelete.length) {
      await idb.init();
      await new Promise(resolve => {
        const tx = idb.db.transaction('cache', 'readwrite');
        const store = tx.objectStore('cache');
        keysToDelete.forEach(k => store.delete(k));
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
    }

    // Clear images store if checked
    if (document.getElementById('ccc_images')?.checked && imageCount > 0) {
      await new Promise(resolve => {
        const tx = idb.db.transaction('images', 'readwrite');
        tx.objectStore('images').clear();
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
      // Also clear Service Worker image cache
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage('clearImageCache');
      } else {
        Promise.all([caches.delete('vrcw-img-v1'), caches.delete('vrcw-img-v2')]).catch(() => {});
      }
    }

    close();
    showToast(t('toast.cacheCleared', {count: keysToDelete.length + (document.getElementById('ccc_images')?.checked ? imageCount : 0)}), 'success');
  };
}


async function joinWorldInstance() {
  if (!currentWorldDetail) return;
  const worldId = currentWorldDetail.id;
  const myId = currentUserId || myProfileData?.id;
  if (!myId) { showToast(t('toast.uidMissingRelogin'), 'error'); return; }

  // Update both header and mobile action buttons
  const allJoinBtns = [
    document.getElementById('worldDetailJoinBtn'),
    document.querySelector('.world-detail-mobile-actions .btn-primary')
  ].filter(Boolean);
  allJoinBtns.forEach(b => { b.disabled = true; b.innerHTML = t('world.creating'); });

  const statusEl = document.getElementById('worldDetailFavStatus');
  const _joinType   = localStorage.getItem(PREF_TYPE)   || 'hidden';
  // Default region: 'use' (US East). Mirrors shell.js loadJoinPrefs/saveJoinPrefs
  // and the HTML hidden input — earlier inconsistency had this defaulting to
  // 'jp' which would create instances in Japan for first-session users who
  // never visited Settings.
  const _joinRegion = localStorage.getItem(PREF_REGION) || 'use';
  const _typeLabel   = INSTANCE_TYPE_LABELS[_joinType]   || _joinType;
  const _regionLabel = REGION_LABELS[_joinRegion]?.replace(/🇺🇸|🇪🇺|🇯🇵/u, '').trim() || _joinRegion;
  if (statusEl) { statusEl.textContent = t('world.creatingRoom', {type: _typeLabel, region: _regionLabel}); statusEl.style.color = 'var(--text-muted)'; }


  try {
    // Map internal pref keys to VRChat API fields
    // 'invite' and 'inviteplus' both use type:'private'; inviteplus adds canRequestInvite:true
    const apiType = (_joinType === 'invite' || _joinType === 'inviteplus') ? 'private' : _joinType;
    const instanceBody = {
      worldId,
      type:    apiType,
      region:  _joinRegion,
      ownerId: myId,
    };
    if (_joinType === 'inviteplus') instanceBody.canRequestInvite = true;

    const r = await apiCall('/api/vrc/instances', {
      method: 'POST',
      json: instanceBody,
      noAbort: true
    });
    if (!r.ok) throw new Error(t('toast.createInstanceFail', {status: r.status}));
    const inst = await r.json();
    const location = inst.location || (worldId + ':' + (inst.instanceId || inst.id));

    // 2. Invite self
    if (statusEl) statusEl.textContent = t('world.sendingInvite');
    const r2 = await apiCall(`/api/vrc/invite/myself/to/${encodeURIComponent(location)}`, { method: 'POST', noAbort: true });
    if (!r2.ok) throw new Error(t('toast.inviteFailHttp', {status: r2.status}));

    if (statusEl) { statusEl.innerHTML = t('log.inviteSelfSent'); statusEl.style.color = 'var(--success)'; }
    allJoinBtns.forEach(b => { b.innerHTML = t('world.invited'); });
  } catch(e) {
    if (statusEl) { statusEl.innerHTML = '<i class="fa-solid fa-xmark"></i> ' + e.message; statusEl.style.color = 'var(--error)'; }
    allJoinBtns.forEach(b => {
      if (b.id === 'worldDetailJoinBtn') b.innerHTML = '<i class="fa-solid fa-bolt"></i> ';
      else b.innerHTML = t('world.joinWorld');
    });
  } finally {
    setTimeout(() => {
      allJoinBtns.forEach(b => {
        if(b) {
          b.disabled = false;
          // Restore icon: worldDetailJoinBtn is just an icon, the other is <i class="fa-solid fa-bolt"></i> 加入世界
          if (b.id === 'worldDetailJoinBtn') b.innerHTML = '<i class="fa-solid fa-bolt"></i> ';
          else b.innerHTML = t('world.joinWorld');
          b.classList.remove('btn-success');
        }
      });
      if (statusEl) statusEl.textContent = '';
    }, 4000);
  }
}


function joinSpecificInstance(worldId, instanceId) {
  window.open(`vrchat://launch?ref=vrchat.com&id=${encodeURIComponent(worldId+':'+instanceId)}`, '_self');
}

async function addWorldToFavorite(worldId, groupName, btn) {
  const menu = document.getElementById('worldFavMenu');
  if (menu) menu.classList.add('hidden');
  const statusEl = document.getElementById('worldDetailFavStatus');
  if (statusEl) {
    statusEl.textContent = t('world.favoritingTo', {name: groupName});
    statusEl.style.color = 'var(--text-muted)';
  }
  if (btn) btn.disabled = true;

  try {
    const r = await apiCall('/api/vrc/favorites', {
      method: "POST",
      json: { type: _worldFavTypeForGroup(groupName), favoriteId: worldId, tags: [groupName] },
    });
    if (r.ok) {
      const res = await r.json();
      worldFavoriteIdMap.set(worldId, res.id);
      _broadcastWorldFavUpdate(worldId, true);
      // Bump the in-memory group counter so the dropdown's "x/100" badge
      // and the disabled-when-full state stay accurate without a full re-sync.
      worldFavGroupCounts.set(groupName, (worldFavGroupCounts.get(groupName) || 0) + 1);
      if (statusEl) { statusEl.textContent = t('world.favoritedTo', {name: groupName}); statusEl.style.color='var(--success)'; }
      await upsertWorldIntoFavoriteCache(groupName, currentWorldDetail || { id: worldId });
    } else {
      const err = await r.json().catch(() => ({}));
      if (statusEl) { statusEl.textContent = t('world.favFailStatus', {msg: err.error?.message || r.status}); statusEl.style.color='var(--error)'; }
    }
  } catch(e) {
    if (statusEl) { statusEl.textContent = t('world.errorStatus', {msg: e.message}); statusEl.style.color='var(--error)'; }
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(()=>{ if(statusEl) statusEl.textContent=''; }, 3000);
  }
}

function toggleWorldFavMenu(event) {
  const menu = document.getElementById("worldFavMenu");
  // Use whichever fav button is currently visible
  const isMobile = window.innerWidth <= 768;
  const btn = document.getElementById(isMobile ? "worldDetailFavBtn" : "worldDetailMainFavBtn");
  if (!menu || !btn) return;

  const w = currentWorldDetail;
  if (!w) return;

  // If already favorited, clicking should toggle unfavorite
  if (worldFavoriteIdMap.has(w.id)) {
    toggleWorldFavorite();
    return;
  }

  toggleFavMenuGeneric(event, menu, btn, () => {
    if (worldFavGroups.length === 0) return `<div style="padding:8px 12px;font-size:0.8em;color:var(--text-muted);">${escHtml(t('world.loadFavGroupsFirst'))}</div>`;
    return worldFavGroups.map(g => {
      const count = worldFavGroupCounts.get(g.name) || 0;
      const cap = 100;
      const full = count >= cap;
      const countLabel = `<span style="margin-left:4px;font-size:0.8em;opacity:0.7;color:${full?'#f87171':'inherit'}">(${count}/${cap})</span>`;
      return `<button class="avtrdb-fav-group-btn" ${full?`disabled title="${t('world.favGroupFull')}"`:''} onclick="addWorldToFavorite('${escJsAttr(w.id)}','${escJsAttr(g.name)}',this)">${escHtml(g.displayName || g.name)} ${countLabel}</button>`;
    }).join("");
  });
}

async function toggleWorldFavorite() {
  if (!currentWorldDetail) return;
  const w       = currentWorldDetail;
  const favBtn  = document.getElementById('worldDetailFavBtn');
  const statusEl = document.getElementById('worldDetailFavStatus');
  const isFaved = worldFavoriteIdMap.has(w.id);
  if (favBtn) favBtn.disabled = true;
  if (statusEl) statusEl.textContent = t('world.processing');
  try {
    if (isFaved) {
      const favId = worldFavoriteIdMap.get(w.id);
      // Use the current category to determine the group (reliable — the id map
      // is rebuilt per-category). The old cur.favorites[0]?.tags?.[0] inference
      // never worked because the world detail object has no favorites array.
      const removedGroup = (currentWorldCategory && currentWorldCategory.startsWith('fav_'))
        ? currentWorldCategory.replace(/^fav_/, '')
        : null;
      const r = await apiCall(`/api/vrc/favorites/${favId}`, {method:'DELETE'});
      if (!r.ok) throw new Error(t('toast.unfavoriteFailHttp', {status: r.status}));
      try { await r.json(); } catch(_) {} // Consume if JSON, ignore if not
      worldFavoriteIdMap.delete(w.id);
      _broadcastWorldFavUpdate(w.id, false);
      if (removedGroup) {
        const c = worldFavGroupCounts.get(removedGroup) || 0;
        worldFavGroupCounts.set(removedGroup, Math.max(0, c - 1));
        await removeWorldFromFavoriteCache(removedGroup, w.id);
      }
      if (statusEl) { statusEl.textContent=t('world.unfavorited'); statusEl.style.color='var(--text-muted)'; }
      if (currentWorldCategory && currentWorldCategory.startsWith('fav_')) {
        allWorlds = allWorlds.filter(aw => aw.id!==w.id);
        await idb.set(WORLD_CACHE_PREFIX + currentWorldCategory, allWorlds);
        filterWorlds();
      }
    } else {
       // This fallback is only used if called directly without selection menu
       const groupName = worldFavGroups.length>0 ? worldFavGroups[0].name : 'worlds1';
       await addWorldToFavorite(w.id, groupName, favBtn);
    }
  } catch(e) {
    if (statusEl) { statusEl.textContent = t('world.errorStatus', {msg: e.message}); statusEl.style.color='var(--error)'; }
  } finally {
    if (favBtn) favBtn.disabled = false;
    setTimeout(()=>{ if(statusEl) statusEl.textContent=''; }, 3000);
  }
}

VRCW.registerModule('worlds', {
  initWorldsTab,
  renderWorldFavGroupButtons,
  fetchWorlds,
  loadWorldFavGroups,
  switchWorldCategory,
  cleanupInvalidWorlds,
  filterWorlds,
  selectAllWorlds,
  unfavoriteSelectedWorlds,
  cleanInvalidWorlds,
  toggleSelectWorld,
  switchWorldDetailTab,
  openWorldDetail,
  closeWorldDetail,
  deleteCurrentWorld,
  showCacheClearModal,
  joinWorldInstance,
  joinSpecificInstance,
  addWorldToFavorite,
  toggleWorldFavMenu,
  toggleWorldFavorite,
});
renderAppVersionInfo();

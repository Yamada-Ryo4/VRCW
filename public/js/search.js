/*
 * VRCW — search.js
 * avtrDB 公开搜索/搜索结果详情/穿戴/Fallback/Impostor
 *
 * 注意：本项目为「经典脚本」(非 ES module)，全部按顺序加载、共享全局作用域。
 * 函数声明会提升为全局，跨文件调用没问题；请勿改为 type="module"。
 */
let avtrdbPage = 0;
// Persistent dedup state — reset on new search, survives Load More and auto-fill pages
let _avtrdbDedupMap = new Map(); // id -> avatar data
let _avtrdbRenderMap = new Map(); // id -> card DOM element
const SEARCH_TARGET = 500; // (legacy, unused after streaming rewrite)
const COMMUNITY_LOAD_MORE_LIMIT = 50; // (legacy, unused — community sources ignore `n=`)
let _avtrdbHasMore = false; // avtrdb has more pages (set by page responses)
// Background avtrdb pagination driver: auto-flips pages until has_more=false,
// so the user never needs a "Load More" button.
let _avtrdbBgDriverRunning = false;
let _avtrdbBgDriverAbortEpoch = 0; // bumped on every new search to stop a stale driver
let _avtrdbBgDriverFailedPage = -1; // page that failed twice → driver stopped
let _searchAbortController = null;
// How many sources (avtrdb + community DBs) still have an in-flight request
// for the current search. When it hits 0 with zero results, we swap the
// spinner for an error message instead of leaving it spinning forever (F5).
let _avtrdbPendingSources = 0;

function _newSearchSignal() {
  if (_searchAbortController) {
    try { _searchAbortController.abort(); } catch (_) {}
  }
  _searchAbortController = new AbortController();
  return _searchAbortController.signal;
}

function _communityDbSources(query, append) {
  const suffix = append ? '&n=' + COMMUNITY_LOAD_MORE_LIMIT : '';
  return [
    { name: 'vrcdb', url: `/api/proxy?url=${encodeURIComponent(`https://vrcx.vrcdb.com/avatars/Avatar/VRCX?search=${encodeURIComponent(query)}${suffix}`)}` },
    { name: 'avatarrecovery', url: `/api/proxy?url=${encodeURIComponent(`https://api.avatarrecovery.com/Avatar/vrcx?search=${encodeURIComponent(query)}${suffix}`)}` },
    { name: 'cute.bet', url: `/api/proxy?url=${encodeURIComponent(`https://avtr.cute.bet/search?search=${encodeURIComponent(query)}${suffix}`)}` },
    { name: 'nekosunevr', url: `/api/proxy?url=${encodeURIComponent(`https://avtr.nekosunevr.co.uk/vrcx_search?search=${encodeURIComponent(query)}${suffix}`)}` }
  ];
}

let avtrdbCurrentQuery = "";
let avtrdbCurrentPlatform = "";
let avtrdbDebounceTimer = null;
let avtrdbTotalLoaded = 0;
let avtrdbMatchField = (function () {
  try { return normalizeAvtrdbMatchField(localStorage.getItem('vrcw_avtrdb_match_field')); }
  catch (_) { return 'all'; }
})();
let _avtrdbDisplayOrder = [];
const AVTRDB_RENDER_BATCH = 60;
let _avtrdbRenderItems = [];
let _avtrdbRenderedCount = 0;
let _avtrdbRenderObserver = null;
let _avtrdbProcessedIds = new Set();
// The avatar object currently shown in the detail modal. Set by displayAvatarDetail()
// so the "save to local" fav-menu button has something to pass to saveToLocalFavorite().
// (Fixes a ReferenceError: the inline onclick referenced an undefined `currentAvatarDetail`.)
let _currentDetailAvatar = null;
// Global wrapper so the inline onclick can reach the (lexically-scoped) module var.
// NOTE: a top-level `let` is NOT a window property, so inline handlers can't read
// `_currentDetailAvatar` directly — but a function *declaration* IS global. Route
// the fav-menu button through this.
function saveCurrentDetailToLocal() {
  if (_currentDetailAvatar) saveToLocalFavorite(_currentDetailAvatar);
}

function fetchJsonWithTimeout(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || 8000;
  const parentSignal = opts.signal;
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, timeoutMs);
  const abortFromParent = () => { try { ctrl.abort(); } catch (_) {} };
  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }
  return fetch(url, { signal: ctrl.signal })
    .then(r => {
      if (r.status === 499) throw new DOMException('Aborted', 'AbortError');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .finally(() => {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', abortFromParent);
    });
}

function normalizeAvtrdbMatchField(field) {
  const allowed = new Set(['all', 'title', 'author', 'tags', 'desc']);
  return allowed.has(field) ? field : 'all';
}

// Builds the favorite group list HTML with checkmarks for groups where the avatar
// is already favorited. Clicking a checked group unfavorites; unchecked adds.
function _findFavGroupNode(favList, attr, groupName) {
  return Array.from(favList.querySelectorAll(`[${attr}]`)).find(el => el.getAttribute(attr) === groupName) || null;
}

function _buildFavGroupListHtml(favList, id, opts = {}) {
  const favedGroups = avatarFavTagMap.get(id) || new Set();
  const isLocalFaved = localAvatarIdMap.has(id);
  const localSaveAction = opts.localSaveAction || `saveCurrentDetailToLocal(); _refreshDetailAfterFavChange('${escJsAttr(id)}')`;

  let html = '';
  // Local favorites row
  if (isLocalFaved) {
    html += `<button class="avtrdb-fav-group-btn avtrdb-fav-group-active" onclick="removeFromLocalFavorite('${escJsAttr(id)}'); _refreshDetailAfterFavChange('${escJsAttr(id)}');">✓ <i class="fa-solid fa-box"></i> 本地收藏</button>`;
  } else {
    html += `<button class="avtrdb-fav-group-btn" style="color:var(--secondary);border-bottom:1px solid rgba(255,255,255,0.1);margin-bottom:4px;" onclick="${localSaveAction}">+ <i class="fa-solid fa-box"></i> 保存到本地 (200槽位)</button>`;
  }

  // Cloud groups
  if (favoriteGroups.length === 0) {
    html += `<div style="padding:8px 12px;font-size:0.8em;color:var(--text-muted);">请先加载收藏夹</div>`;
  } else {
    html += favoriteGroups.map(g => {
      const isFavedInGroup = favedGroups.has(g.name);
      const lbl = `<span data-favcount="${escHtml(g.name)}" style="margin-left:4px;font-size:0.8em;opacity:0.7;">(…/50)</span>`;
      const displayName = escHtml(g.displayName || g.name);

      if (isFavedInGroup) {
        // Already in this group — click to unfavorite
        return `<button class="avtrdb-fav-group-btn avtrdb-fav-group-active" data-favgroup="${escHtml(g.name)}" onclick="unfavoriteFromGroup('${escJsAttr(id)}','${escJsAttr(g.name)}',this)">✓ ${displayName} ${lbl}</button>`;
      } else {
        // Not in this group — click to add
        return `<button class="avtrdb-fav-group-btn" data-favgroup="${escHtml(g.name)}" onclick="addToFavorite('${escJsAttr(id)}','${escJsAttr(g.name)}',this)">${displayName} ${lbl}</button>`;
      }
    }).join("");
  }
  favList.innerHTML = html;
}

function _setFavGroupCountState(favList, groupName, count, id) {
  const cap = 50;
  const span = _findFavGroupNode(favList, 'data-favcount', groupName);
  const btn = _findFavGroupNode(favList, 'data-favgroup', groupName);
  const favedGroups = avatarFavTagMap.get(id) || new Set();
  const isFavedInGroup = favedGroups.has(groupName);
  const full = count >= cap;
  if (span) {
    span.textContent = `(${count}/${cap})`;
    span.style.color = full && !isFavedInGroup ? '#f87171' : 'inherit';
  }
  if (btn && !isFavedInGroup) {
    btn.disabled = full;
    btn.title = full ? '收藏夹已满' : '';
  }
}

async function _refreshFavGroupCountsLive(favList, id) {
  if (!favList || favoriteGroups.length === 0) return;
  await Promise.allSettled(favoriteGroups.map(async (g) => {
    try {
      const r = await apiCall(`/api/vrc/favorites?type=avatar&tag=${encodeURIComponent(g.name)}&n=100`, { noAbort: true });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const list = await r.json();
      const count = Array.isArray(list) ? list.length : 0;
      avatarFavGroupCounts.set(g.name, count);
      _setFavGroupCountState(favList, g.name, count, id);
    } catch (_) {
      const span = _findFavGroupNode(favList, 'data-favcount', g.name);
      if (span) span.textContent = '(?/50)';
    }
  }));
}


function onSearchCategoryChange() {
  const cat = document.getElementById("searchCategory")?.value;
  const platWrap = document.getElementById("platGlassSelect")?.closest(".search-platform-select");
  const fieldWrap = document.getElementById("fieldGlassSelect")?.closest(".search-platform-select");
  const searchInput = document.getElementById("avtrdbSearch");

  // Show platform filter for avatars and worlds; hide for users/groups
  const showPlatform = cat === "avatars" || cat === "worlds";
  if (platWrap) platWrap.style.visibility = showPlatform ? "visible" : "hidden";
  if (fieldWrap) fieldWrap.style.visibility = cat === "avatars" ? "visible" : "hidden";

  // Update placeholder text based on category
  const placeholders = {
    avatars: "搜索模型 / Search avatars...",
    users:   "搜索玩家 / Search users...",
    worlds:  "搜索世界 / Search worlds...",
    groups:  "搜索群组 / Search groups...",
  };
  if (searchInput) searchInput.placeholder = placeholders[cat] || "搜索 / Search...";

  // Only trigger search if there's a query
  if (searchInput?.value.trim()) doAvtrdbSearch();
}

function onAvtrdbInput() {
  clearTimeout(avtrdbDebounceTimer);
  avtrdbDebounceTimer = setTimeout(doAvtrdbSearch, 600);
}


async function doAvtrdbSearch() {
  const query = document.getElementById("avtrdbSearch")?.value.trim() || "";
  const cat = document.getElementById("searchCategory")?.value || "avatars";
  const platform = document.getElementById("avtrdbPlatform")?.value || "";

  if (!query) return;
  avtrdbCurrentQuery = query;
  avtrdbCurrentPlatform = platform;
  window.searchCurrentCat = cat;

  // Abort only the previous search. Tab navigation owns currentTabAbortController;
  // sharing it here lets search cancel unrelated tab work and vice versa.
  const searchSignal = _newSearchSignal();

  // Tell the background queue to hold off while the user is actively
  // searching — startup favorite-index sync / world-detail prefetches would
  // otherwise hog browser concurrency slots (6/origin) and starve the 5
  // search source fetches. Cleared when the user leaves the search tab.
  if (typeof setSearchActive === 'function') setSearchActive(true);

  avtrdbPage = 0;
  avtrdbTotalLoaded = 0;
  _avtrdbHasMore = false;
  _avtrdbDedupMap = new Map();
  _avtrdbRenderMap = new Map();
  _avtrdbDisplayOrder = [];
  // Stop any in-flight background pagination from a previous search and
  // reset render queue / sentinel state so streaming starts from scratch.
  _avtrdbBgDriverAbortEpoch++;
  _avtrdbBgDriverFailedPage = -1;
  _avtrdbRenderItems = [];
  _avtrdbRenderedCount = 0;
  _avtrdbProcessedIds = new Set();
  if (_avtrdbRenderObserver) { _avtrdbRenderObserver.disconnect(); _avtrdbRenderObserver = null; }
  if (_avtrdbRecycler) { _avtrdbRecycler.disconnect(); _avtrdbRecycler = null; }
  if (_avtrdbMetaObserver) { _avtrdbMetaObserver.disconnect(); _avtrdbMetaObserver = null; }

  const grid = document.getElementById("avtrdbGrid");
  grid.classList.remove('search-user-grid', 'search-group-grid', 'search-world-grid');
  const searchGridClass = cat === 'users' ? 'search-user-grid' : cat === 'groups' ? 'search-group-grid' : cat === 'worlds' ? 'search-world-grid' : '';
  if (searchGridClass) grid.classList.add(searchGridClass);
  grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:rgba(255,255,255,0.4);">搜索中...</div>`;
  document.getElementById("avtrdbStats").textContent = "";
  const btnSearch = document.getElementById("btnSearchMain");
  const btnIcon = btnSearch?.querySelector('.search-btn-icon');
  const originalIcon = btnIcon?.textContent || '<i class="fa-solid fa-magnifying-glass"></i> ';
  
  if (btnSearch) {
    btnSearch.disabled = true;
    if (btnIcon) btnIcon.innerHTML = `<div class="btn-spinner"></div>`;
  }

  try {
    if (cat === 'avatars') {
      await avtrdbFetch(false, searchSignal);
    } else {
      await vrcdbFetch(cat, query, searchSignal);
    }
  } finally {
    if (btnSearch) {
      btnSearch.disabled = false;
      if (btnIcon) btnIcon.textContent = originalIcon;
    }
  }
}
async function vrcdbFetch(cat, query, signal) {
  const grid = document.getElementById("avtrdbGrid");
  const stats = document.getElementById("avtrdbStats");
  
  try {
    let url = '';
    if (cat === 'users') url = `/api/vrc/users?search=${encodeURIComponent(query)}&n=50`;
    else if (cat === 'worlds') url = `/api/vrc/worlds?search=${encodeURIComponent(query)}&n=50`;
    else if (cat === 'groups') url = `/api/vrc/groups?query=${encodeURIComponent(query)}&n=50`;
    
    const resp = await apiCall(url, { signal, noDedupe: true });
    if (resp.status === 499) return;
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    
    if (!data || data.length === 0) {
      grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:rgba(255,255,255,0.4);padding:40px;">未找到结果 (No results)</div>';
      return;
    }
    stats.textContent = `找到 ${data.length} 个结果`;
    
    // Filter by platform if applicable
    const plat = document.getElementById("avtrdbPlatform")?.value || "";
    let filteredData = data;
    if (plat && cat === 'worlds') {
      const required = plat.split('+');
      filteredData = data.filter(w => {
        const wPlats = w.platforms || (w.unityPackages ? w.unityPackages.map(p => p.platform) : []);
        return required.every(p => wPlats.includes(p));
      });
      stats.textContent = `找到 ${data.length} 个结果 (过滤后 ${filteredData.length})`;
    }

    if (cat === 'users') {
      grid.innerHTML = filteredData.map(u => {
        const fJson = escAttrJson(u);
        return `<div class="friend-card search-user-card" onclick="openFriendProfile(this);" data-friend="${fJson}">
          <div class="friend-avatar-wrap">
            <img src="${escHtml(proxyImg(u.userIcon||u.profilePicOverride||u.currentAvatarThumbnailImageUrl||''))}" onerror="this.style.display=\'none\'">
          </div>
          <div class="friend-info">
            <div class="friend-name">${escHtml(u.displayName)}</div>
            <div class="friend-location search-user-id">${escHtml(u.id||'')}</div>
            <div class="friend-location search-user-status">${escHtml(u.statusDescription||u.username||'')}</div>
          </div>
        </div>`;
      }).join('');
    } else if (cat === 'worlds') {
      grid.innerHTML = '';
      filteredData.forEach(w => {
        const thumb = proxyImg(w.thumbnailImageUrl || w.imageUrl || '');
        const isFaved = worldFavoriteIdMap.has(w.id);
        const isCached = loadedImageUrls.has(imageCacheKey(thumb));
        const card = document.createElement('div');
        card.className = 'avatar-card';
        card.style.cursor = 'pointer';
        card.onclick = () => openWorldDetail(w.id, w);
        card.innerHTML = `<div class="avatar-thumb-wrapper ${isCached?'':'img-loading'}">
          ${isCached
            ? `<img class="avatar-thumb" src="${escHtml(thumb)}" alt="">`
            : `<img class="avatar-thumb loading" src="${BLANK}" data-src="${escHtml(thumb)}" alt="">`}
          <div class="avatar-name-overlay">${escHtml(w.name||'未知世界')}</div>
          <div style="position:absolute;bottom:6px;left:6px;z-index:10;">
            <div data-fav-btn="${escHtml(w.id)}" onclick="quickWorldFav('${escJsAttr(w.id)}',event)"
              style="width:26px;height:26px;border-radius:6px;background:rgba(0,0,0,0.55);border:1px solid rgba(255,255,255,0.18);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:0.85em;" title="${isFaved?'取消收藏':'添加到收藏夹'}">${isFaved?'\u2b50':'\u2606'}</div>
          </div>
          <div style="position:absolute;bottom:8px;right:8px;display:flex;gap:4px;z-index:5;">
            ${(w.occupants||0)>0 ? `<div class="world-player-badge" style="position:static;margin:0;">\u{1f465} ${w.occupants}</div>` : ''}
            ${(w.favorites||0)>0 ? `<div style="background:rgba(0,0,0,0.55);color:#fbbf24;font-size:0.7em;padding:2px 6px;border-radius:4px;">\u2b50 ${w.favorites}</div>` : ''}
          </div>
        </div>`;
        grid.appendChild(card);
        if (!isCached && thumb) {
          const img = card.querySelector('.avatar-thumb[data-src]');
          if (img) avatarObserver.observe(img);
        }
      });

    } else if (cat === 'groups') {
      grid.innerHTML = filteredData.map(g => {
        return `<div class="friend-card" style="box-shadow: 0 4px 12px rgba(0,0,0,0.5);border:1px solid var(--border);">
          <div class="friend-avatar-wrap" style="border-radius:12px;">
            <img src="${escHtml(proxyImg(g.iconUrl||''))}" style="border-radius:12px;" onerror="this.style.display=\'none\'">
          </div>
          <div class="friend-info">
            <div class="friend-name">${escHtml(g.name)} <span style="font-size:0.7em;opacity:0.6;">${escHtml(g.shortCode)}</span></div>
            <div class="friend-location" style="font-size:0.8em;"><i class="fa-solid fa-users"></i> ${g.memberCount||0} Members</div>
          </div>
        </div>`;
      }).join('');
    }
  } catch(e) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--error);padding:40px;">搜索失败: ${escHtml(String(e.message || e))}</div>`;
  }
}

// avtrdbLoadMore — DEPRECATED. The streaming background driver auto-fills the
// grid as new pages arrive, so a manual button is no longer needed (and it had
// a bug where it got hidden while results were still incoming). Kept as a
// no-op so any stale inline handler doesn't ReferenceError.
function avtrdbLoadMore() { /* no-op: streaming auto-fill replaces this */ }

// Current sort mode for avatar search: 'relevance' | 'newest' | 'name'
// Persisted in localStorage so a chosen sort survives reloads — mirrors VRCX.
let avtrdbSortMode = (function () {
  try { return localStorage.getItem('vrcw_avtrdb_sort') || 'relevance'; }
  catch (_) { return 'relevance'; }
})();

// On script load, paint the saved sort onto the chip row. Without this the
// HTML's hardcoded `<button class="sort-chip active" data-sort="relevance">`
// would remain highlighted even when the user previously selected newest/name.
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('#avtrdbSortBtns .sort-chip').forEach(b =>
    b.classList.toggle('active', b.dataset.sort === avtrdbSortMode));
  document.querySelectorAll('#fieldGlassSelect .glass-option').forEach(b =>
    b.classList.toggle('selected', b.dataset.field === avtrdbMatchField));
  const activeField = document.querySelector(`#fieldGlassSelect .glass-option[data-field="${avtrdbMatchField}"]`);
  const fieldLabel = document.querySelector('#fieldGlassSelect .selected-label');
  if (activeField && fieldLabel) fieldLabel.textContent = activeField.textContent;
});

function setAvtrdbSort(mode) {
  if (avtrdbSortMode === mode) return;
  avtrdbSortMode = mode;
  try { localStorage.setItem('vrcw_avtrdb_sort', mode); } catch (_) {}
  document.querySelectorAll('#avtrdbSortBtns .sort-chip').forEach(b =>
    b.classList.toggle('active', b.dataset.sort === mode));
  _rerenderAvtrdbGrid({ preserveOrder: false }); // explicit sort change may reorder
}

function setAvtrdbMatchField(field) {
  if (!field) field = document.getElementById('avtrdbMatchField')?.value || 'all';
  field = normalizeAvtrdbMatchField(field);
  if (avtrdbMatchField === field) return;
  avtrdbMatchField = field || 'all';
  try { localStorage.setItem('vrcw_avtrdb_match_field', avtrdbMatchField); } catch (_) {}
  document.querySelectorAll('#fieldGlassSelect .glass-option').forEach(b =>
    b.classList.toggle('selected', b.dataset.field === avtrdbMatchField));
  const activeField = document.querySelector(`#fieldGlassSelect .glass-option[data-field="${avtrdbMatchField}"]`);
  const fieldLabel = document.querySelector('#fieldGlassSelect .selected-label');
  if (activeField && fieldLabel) fieldLabel.textContent = activeField.textContent;
  _rerenderAvtrdbGrid({ preserveOrder: false });
}

function authorLinkHtml(authorName, authorId) {
  const name = authorName || "Unknown";
  if (authorId) {
    return `<span class="link-like" onclick="event.stopPropagation(); openFriendProfileById('${escJsAttr(authorId)}')">${escHtml(name)}</span>`;
  }
  if (name && name !== "Unknown") {
    return `<span class="link-like" title="解析作者资料" onclick="event.stopPropagation(); openAuthorProfileByName('${escJsAttr(name)}')">${escHtml(name)}</span>`;
  }
  return escHtml(name);
}

async function openAuthorProfileByName(authorName) {
  const name = String(authorName || '').trim();
  if (!name) return;
  try {
    const resp = await apiCall(`/api/vrc/users?search=${encodeURIComponent(name)}&n=10`);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const users = await resp.json().catch(() => []);
    const list = Array.isArray(users) ? users : (users?.users || users?.data || []);
    const lower = name.toLowerCase();
    const hit = list.find(u => String(u.displayName || '').toLowerCase() === lower
      || String(u.username || '').toLowerCase() === lower
      || String(u.name || '').toLowerCase() === lower) || list[0];
    if (hit?.id) {
      openFriendProfileById(hit.id);
    } else {
      showToast('找不到作者资料: ' + name, 'error');
    }
  } catch (e) {
    showToast('作者资料解析失败: ' + (e.message || e), 'error');
  }
}

// === Streaming search infrastructure (added 2026-06-19, see memory.md) ===
// Each source (avtrdb / vrcdb / avatarrecovery / cute.bet / nekosune) flushes
// its results to the grid as soon as it resolves — no Promise.allSettled wait.
// Sources arrive over a wide time range (~0.3s for vrcdb, ~12s for cute.bet),
// so streaming makes the user see cards in <1s instead of waiting for the
// slowest source. Order is "arrival order" — clicking a sort chip re-sorts.

// Module-level dedup collector. Returns true if the av is brand-new (added to
// dedupMap), false if it merged into an existing entry. Used by both the
// initial avtrdbFetch and the background pagination driver so they share one
// source of truth.
function _collectAvatar(av) {
  const id = av.vrc_id;
  if (!id) return false;
  const dedupMap = _avtrdbDedupMap;
  if (!dedupMap.has(id)) {
    dedupMap.set(id, av);
    return true;
  }
  // Already have it — merge richer fields in (description / tags / image_url)
  const existing = dedupMap.get(id);
  const richness = o => ((o.unityPackages && o.unityPackages.length) ? 2 : 0)
    + ((o.performance && Object.keys(o.performance).length > 2) ? 1 : 0)
    + (o.image_url || o.imageUrl ? 1 : 0)
    + (o.name && o.name !== '未知模型' ? 1 : 0);
  if (richness(av) > richness(existing)) {
    dedupMap.set(id, Object.assign({}, existing, av));
    _refreshAvtrdbCard(dedupMap.get(id));
  } else {
    let changed = false;
    if (av.description && !existing.description) { existing.description = av.description; changed = true; }
    if (Array.isArray(av.tags)) {
      const merged = [...new Set([...(existing.tags || []), ...av.tags])];
      if (merged.length !== (existing.tags || []).length) { existing.tags = merged; changed = true; }
    }
    if (!existing.image_url && (av.image_url || av.imageUrl)) {
      existing.image_url = av.image_url || av.imageUrl; changed = true;
    }
    if (changed) _refreshAvtrdbCard(existing);
  }
  return false;
}

// Push any newly-collected av records (in dedupMap but not yet in display
// order) into the render queue, in arrival order, and trigger the existing
// _appendAvtrdbRenderBatch incremental renderer. Also removes the initial
// loading spinner once we have first cards.
function _flushStreamedCards() {
  if (_avtrdbDedupMap.size === 0) return;
  const requiredPlats = avtrdbCurrentPlatform ? avtrdbCurrentPlatform.split("+") : [];
  const q = avtrdbCurrentQuery;
  let added = 0;
  for (const [id, av] of _avtrdbDedupMap) {
    if (_avtrdbProcessedIds.has(id)) continue;
    _avtrdbProcessedIds.add(id);
    let pass = true;
    if (requiredPlats.length > 0) {
      const r = getAvatarPlatforms(av);
      if (!requiredPlats.every(p => r.has(p))) pass = false;
    }
    if (pass && !_avtrdbTextMatchesField(av, q, avtrdbMatchField)) pass = false;
    if (pass) {
      _avtrdbDisplayOrder.push(id);
      _avtrdbRenderItems.push(av);
      added++;
    }
  }
  if (added > 0) {
    document.getElementById('avtrdb-loading-spinner')?.remove();
    document.getElementById('avtrdb-loadmore-spinner')?.remove();
    _appendAvtrdbRenderBatch();
    avtrdbTotalLoaded = _avtrdbDisplayOrder.length;
  }
  _updateAvtrdbStats();
}

// Update the top stats line. Reflects: rendered/indexed counts, current
// platform/field/sort filters, and live background-driver state.
function _updateAvtrdbStats() {
  const stats = document.getElementById("avtrdbStats");
  if (!stats) return;
  const platLabelMap = { pc: "PC", android: "Quest", ios: "Apple", "pc+android": "PC + Quest", "pc+android+ios": "PC + Quest + Apple" };
  const platLabel = avtrdbCurrentPlatform ? (platLabelMap[avtrdbCurrentPlatform] || avtrdbCurrentPlatform) : "全平台";
  const sortLabel = { relevance: '相关度', newest: '最新', name: '名称', arrival: '到达顺序' }[avtrdbSortMode] || '到达顺序';
  const fieldLabel = { all: '全部字段', title: '标题', author: '作者', tags: 'Tag', desc: '描述' }[avtrdbMatchField] || '全部字段';
  const indexed = _avtrdbDedupMap.size;
  const rendered = _avtrdbRenderedCount;
  let suffix;
  if (_avtrdbBgDriverFailedPage >= 0) {
    suffix = ` · avtrdb 拉取中断 (第 ${_avtrdbBgDriverFailedPage} 页失败)`;
  } else if (_avtrdbBgDriverRunning || _avtrdbHasMore) {
    suffix = ` · 后台拉取中...`;
  } else {
    suffix = ` · 全部加载完毕`;
  }
  stats.textContent = `已显示 ${rendered} / 已索引 ${indexed}（${platLabel} · ${fieldLabel} · ${sortLabel}）${suffix}`;
}

// Called when one search source (avtrdb or a community DB) finishes — success
// or fail. When all sources are done: (1) if we have a non-arrival sort mode,
// apply a final re-sort so relevance/newest/name actually takes effect (F4 —
// streamed cards were previously never sorted, leaving the default 'relevance'
// chip highlighted but ignored); (2) if zero results, swap the spinner for an
// error/empty message so it doesn't spin forever (F5).
function _avtrdbSourceDone(signal) {
  if (signal?.aborted) return;
  if (_avtrdbPendingSources > 0) _avtrdbPendingSources--;
  if (_avtrdbPendingSources > 0) return;
  // All sources resolved.
  if (_avtrdbDedupMap.size > 0) {
    // Apply the user's chosen sort mode now that all results are in. During
    // streaming we keep arrival order to avoid cards jumping around; this
    // final pass makes relevance/newest/name actually mean something.
    if (avtrdbSortMode && avtrdbSortMode !== 'arrival') {
      _rerenderAvtrdbGrid();
    }
  } else {
    // Nothing collected — show an error instead of a stuck spinner (F5).
    const grid = document.getElementById('avtrdbGrid');
    const spinner = document.getElementById('avtrdb-loading-spinner');
    if (grid && spinner) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:40px;">未找到匹配的模型，或所有数据源暂时不可用，请稍后重试。</div>`;
    }
    _updateAvtrdbStats();
  }
}

// Background avtrdb pagination driver. Auto-flips pages from avtrdbPage onward
// until has_more=false. Each page flushes to the grid as it arrives. A single
// page is retried up to 10 times with exponential backoff (300ms, 600ms, 1.2s,
// 2.4s, …, capped at 8s) before the driver gives up — a transient network
// blip in the middle of a long search shouldn't truncate the result set.
// Note: community sources (vrcdb / avatarrecovery / cute.bet / nekosune) are
// NOT in this driver — they each fire one HTTP request from avtrdbFetch and
// flush independently, so they're already done by the time the driver runs.
// If the driver stops, only avtrdb pagination stops; community results stay.
async function _avtrdbBackgroundDriver(signal) {
  if (_avtrdbBgDriverRunning) return;
  _avtrdbBgDriverRunning = true;
  const myEpoch = _avtrdbBgDriverAbortEpoch;
  _avtrdbBgDriverFailedPage = -1;
  const MAX_RETRIES = 10;
  const sleep = (ms) => new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true });
  });
  try {
    while (_avtrdbHasMore && myEpoch === _avtrdbBgDriverAbortEpoch) {
      if (signal?.aborted) break;
      const page = avtrdbPage;
      let ok = false;
      let lastErr = null;
      for (let attempt = 0; attempt < MAX_RETRIES && !ok; attempt++) {
        if (myEpoch !== _avtrdbBgDriverAbortEpoch || signal?.aborted) return;
        try {
          let url = `https://api.avtrdb.com/v2/avatar/search?query=${encodeURIComponent(avtrdbCurrentQuery)}&page_size=50&page=${page}`;
          const requiredPlats = avtrdbCurrentPlatform ? avtrdbCurrentPlatform.split("+") : [];
          if (requiredPlats.length > 0) url += `&compatibility=${requiredPlats[0]}`;
          const data = await fetchJsonWithTimeout(`/api/proxy?url=${encodeURIComponent(url)}`, { signal, timeoutMs: 7000 });
          if (myEpoch !== _avtrdbBgDriverAbortEpoch) return; // user kicked off a new search
          if (signal?.aborted) return;
          _avtrdbHasMore = data.has_more || false;
          (data.avatars || []).forEach(av => _collectAvatar({
            ...av, vrc_id: av.vrc_id, image_url: av.image_url,
            compatibility: av.compatibility || [], performance: av.performance || {}
          }));
          _flushStreamedCards();
          ok = true;
        } catch (e) {
          lastErr = e;
          // Exponential backoff: 300, 600, 1200, 2400, 4800, then 8000 cap.
          if (attempt < MAX_RETRIES - 1) {
            const delay = Math.min(300 * Math.pow(2, attempt), 8000);
            try { await sleep(delay); } catch (_) { return; }
          }
        }
      }
      if (!ok) { _avtrdbBgDriverFailedPage = page; break; }
      avtrdbPage = page + 1;
      _updateAvtrdbStats();
    }
  } finally {
    _avtrdbBgDriverRunning = false;
    _updateAvtrdbStats();
  }
}

// Build one normalized avatar card element from a collected record.
function _buildAvtrdbCard(av) {
  const id = av.vrc_id;
  const card = document.createElement("div");
  card.className = "avatar-card";
  card.style.cursor = "pointer";
  card.title = "点击查看详情";
  card.setAttribute('data-avid', id);
  card.addEventListener("click", () => openAvtrdbDetail(av));
  _avtrdbRenderMap.set(id, card);

  const ratings = getAvatarPlatforms(av);
  const platBadges = Array.from(ratings.keys()).map(p =>
    `<span class="avtrdb-badge">${{ pc: "PC", android: "Quest", ios: "Apple" }[p] || p}</span>`
  ).join("");
  const thumb = proxyImg(av.image_url || av.imageUrl || av.thumbnailImageUrl || "");
  const isCached = thumb && loadedImageUrls.has(imageCacheKey(thumb));
  const imgHtml = thumb
    ? (isCached
      ? `<img class="avatar-thumb" src="${escHtml(thumb)}" alt="${escHtml(av.name || "")}">`
      : `<img class="avatar-thumb loading" src="${BLANK}" data-src="${escHtml(thumb)}" alt="${escHtml(av.name || "")}">`)
    : `<img class="avatar-thumb" src="${BLANK}" alt="">`;

  card.innerHTML = `
    <div class="avatar-thumb-wrapper ${thumb && !isCached ? 'img-loading' : ''}">
      ${imgHtml}
      <div class="avatar-name-overlay">${escHtml(av.name || "未知模型")}</div>
    </div>
    <div style="padding:8px 6px 4px;font-size:0.7em;color:rgba(255,255,255,0.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
      by ${authorLinkHtml(av.author?.name || av.authorName || "Unknown", av.author?.id || av.authorId || "")}
    </div>
    <div class="card-plat-badges" style="padding:0 6px 10px;display:flex;gap:4px;flex-wrap:wrap;">${platBadges}</div>
  `;

  // Lazy metadata enrichment when the card scrolls into view
  const lazyImg = card.querySelector('.avatar-thumb[data-src]');
  if (lazyImg) avatarObserver.observe(lazyImg);

  if (!(av.unityPackages && av.unityPackages.length > 0)) {
    const metaObs = _ensureAvtrdbMetaObserver();
    if (metaObs) metaObs.observe(card);
  }
  // Register with the recycler: cards scrolled far outside the viewport
  // (>2000px buffer) get their image+observers torn down to keep memory
  // bounded (avoids the multi-hundred-MB blow-up when scrolling 2000+ cards).
  // The av record stays in _avtrdbDedupMap; the skeleton stays at its slot;
  // _restoreCard rebuilds the thumbnail when the card scrolls back in.
  // Defer observation by one frame so a freshly-appended card that ends up
  // outside the buffer band isn't torn down before its image even loads.
  const recycler = _ensureRecycler();
  if (recycler) requestAnimationFrame(() => { if (card.isConnected) recycler.observe(card); });
  return card;
}

let _avtrdbMetaObserver = null;
function _ensureAvtrdbMetaObserver() {
  if (_avtrdbMetaObserver) return _avtrdbMetaObserver;
  const grid = document.getElementById('avtrdbGrid');
  _avtrdbMetaObserver = new IntersectionObserver((entries, obs) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        const card = e.target;
        obs.unobserve(card);
        const id = card.getAttribute('data-avid');
        const av = id && _avtrdbDedupMap.get(id);
        if (av) {
          avatarMetadataQueue.add(id, (data) => {
            Object.assign(av, {
              unityPackages: data.unityPackages || av.unityPackages,
              performance: (data.performance && Object.keys(data.performance).length) ? data.performance : av.performance,
              created_at: av.created_at || data.created_at || data.createdAt,
              updated_at: av.updated_at || data.updated_at || data.updatedAt,
              description: av.description || data.description || ""
            });
            const badgeWrap = card.querySelector('.card-plat-badges');
            if (badgeWrap) {
              const liveRatings = getAvatarPlatforms(av);
              badgeWrap.innerHTML = Array.from(liveRatings.keys()).map(p =>
                `<span class="avtrdb-badge">${{ pc: "PC", android: "Quest", ios: "Apple" }[p] || p}</span>`
              ).join("");
            }
          });
        }
      }
    }
  }, { root: grid, rootMargin: '200px 0px' });
  return _avtrdbMetaObserver;
}

// DOM recycler: keeps live memory bounded. Cards scrolled far outside the
// viewport (>2000px buffer) have their heavy resources torn down (thumbnail
// image decoded bitmap + in-flight fetch + per-card metadata observer) but
// the lightweight card skeleton (div + text) stays in the DOM at its
// position — so scroll position is stable and a scroll-back rebuilds the
// image via the same avatarObserver lazy-load path. This trades a little DOM
// node count for rock-solid scroll correctness (no "holes" when scrolling up).
let _avtrdbRecycler = null;
const AVTRDB_RECYCLE_BUFFER = 2000; // px outside viewport before teardown

function _ensureRecycler() {
  if (_avtrdbRecycler) return _avtrdbRecycler;
  const grid = document.getElementById('avtrdbGrid');
  // Batch recycle/restore into a single rAF to avoid scroll jank.
  // Fast scrolling fires the observer for dozens of cards in one tick;
  // doing querySelector + attribute work synchronously for each one
  // blocks the main thread and causes visible stutter.
  const pendingRecycle = new Set();
  const pendingRestore = new Set();
  let rafScheduled = false;
  function flushRecycleQueue() {
    rafScheduled = false;
    // Process restores first (user is scrolling towards these)
    for (const card of pendingRestore) {
      pendingRecycle.delete(card); // cancel recycle if also queued
      _restoreCard(card);
    }
    pendingRestore.clear();
    for (const card of pendingRecycle) {
      _recycleCard(card);
    }
    pendingRecycle.clear();
  }
  _avtrdbRecycler = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        pendingRecycle.delete(e.target);
        pendingRestore.add(e.target);
      } else {
        pendingRestore.delete(e.target);
        pendingRecycle.add(e.target);
      }
    }
    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(flushRecycleQueue);
    }
  }, {
    root: grid,
    rootMargin: AVTRDB_RECYCLE_BUFFER + 'px 0px',
    threshold: 0
  });
  return _avtrdbRecycler;
}

// Rebuild a recycled card's thumbnail when it re-enters the buffer band.
function _restoreCard(card) {
  if (!card || !card.isConnected) return;
  if (card.dataset.recycled !== '1') return; // wasn't torn down
  const id = card.getAttribute('data-avid');
  const av = id && _avtrdbDedupMap.get(id);
  if (!av) return;
  delete card.dataset.recycled;
  
  const img = card.querySelector('.avatar-thumb');
  if (img) {
    const thumb = proxyImg(av.image_url || av.imageUrl || av.thumbnailImageUrl || "");
    const isCached = thumb && loadedImageUrls.has(imageCacheKey(thumb));
    const wrapper = img.closest('.avatar-thumb-wrapper');
    if (thumb) {
      if (isCached) {
        img.src = thumb;
      } else {
        img.dataset.src = thumb;
        img.classList.add('loading');
        if (wrapper) wrapper.classList.add('img-loading');
        if (typeof avatarObserver !== 'undefined') avatarObserver.observe(img);
      }
    }
  }
}

// Tear down a card's heavy resources (decoded image bitmap + in-flight fetch)
// but keep the lightweight skeleton in place so scroll position stays correct.
function _recycleCard(card) {
  if (!card || !card.isConnected) return;
  if (card.dataset.recycled === '1') return; // already torn down
  const img = card.querySelector('.avatar-thumb');
  if (img) {
    if (typeof avatarObserver !== 'undefined') {
      try { avatarObserver.unobserve(img); } catch (_) {}
    }
    if (img._abortCtrl) { try { img._abortCtrl.abort(); } catch (_) {} }
    if (img.src && img.src.startsWith('blob:')) { try { URL.revokeObjectURL(img.src); } catch (_) {} }
    // Remove this image from the pending imageQueue to prevent a stale fetch
    // from loading a now-recycled card (which would waste bandwidth + leak a
    // blob URL that nobody ever sees).
    if (typeof _imageQueueSet !== 'undefined' && _imageQueueSet.has(img)) {
      _removeFromImageQueue(img);
    }
    img.removeAttribute('data-src');
    // Using an embedded 1x1 transparent gif instead of global BLANK to be safe
    img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    delete img.dataset.loading;
    delete img.dataset.cancelled;
    img.classList.remove('loading');
    const wrapper = img.closest('.avatar-thumb-wrapper');
    if (wrapper) wrapper.classList.remove('img-loading');
  }
  card.dataset.recycled = '1';
}

function _refreshAvtrdbCard(av) {
  if (!av?.vrc_id) return;
  // Find the already-rendered card in the DOM and rebuild it with the merged
  // (richer) data. Previously this only deleted the renderMap entry, leaving
  // the stale card visible until a full grid rerender — so merged tags /
  // descriptions / images never showed up on the live card (F7).
  const oldCard = _avtrdbRenderMap.get(av.vrc_id);
  if (oldCard && oldCard.isConnected) {
    const newCard = _buildAvtrdbCard(av);
    // Preserve any lazy-load state the recycler set up.
    oldCard.replaceWith(newCard);
    _avtrdbRenderMap.set(av.vrc_id, newCard);
    // Re-attach observers so images still lazy-load on the rebuilt card.
    try {
      _ensureRecycler().observe(newCard);
      if (typeof _ensureAvtrdbMetaObserver === 'function') _ensureAvtrdbMetaObserver().observe(newCard);
    } catch (_) {}
  } else {
    _avtrdbRenderMap.delete(av.vrc_id);
  }
}

function _avtrdbTextMatchesField(av, q, field) {
  const query = String(q || '').trim().toLowerCase();
  if (!query) return true;
  // 如果是“全部字段”搜索，无条件信任服务端的返回结果（服务端支持模糊匹配 / ES 分词搜索）。
  // 避免本地的强包含（includes）逻辑误杀服务端的有效搜索结果，导致“已显示 < 已索引”
  if (!field || field === 'all') return true;

  const name = String(av.name || av.avatarName || '').toLowerCase();
  const author = String(av.author?.name || av.authorName || '').toLowerCase();
  const tags = Array.isArray(av.tags) ? av.tags.join(' ').toLowerCase() : '';
  const desc = String(av.description || '').toLowerCase();
  
  const tokens = query.split(/\s+/).filter(Boolean);
  const check = (text) => tokens.every(t => text.includes(t));
  
  if (field === 'title') return check(name);
  if (field === 'author') return check(author);
  if (field === 'tags') return check(tags);
  if (field === 'desc') return check(desc);
  return true;
}

function _avtrdbSortItems(items) {
  const isBad = (av) => {
    const rs = av.releaseStatus || av.release_status || "";
    return av.isInvalid || rs === 'unavailable' || rs === 'hidden';
  };

  if (avtrdbSortMode === 'name') {
    return items.sort((a, b) => {
      const aBad = isBad(a), bBad = isBad(b);
      if (aBad !== bBad) return aBad ? 1 : -1;
      return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
    });
  }
  if (avtrdbSortMode === 'newest') {
    return items.sort((a, b) => {
      const aBad = isBad(a), bBad = isBad(b);
      if (aBad !== bBad) return aBad ? 1 : -1;
      return new Date(b.updated_at || b.updatedAt || b.created_at || b.createdAt || 0)
             - new Date(a.updated_at || a.updatedAt || a.created_at || a.createdAt || 0);
    });
  }
  items.forEach(av => {
    av._rel = relevanceScore(av, avtrdbCurrentQuery);
    av._qual = qualityScore(av);
  });
  return items.sort((a, b) => {
    const aBad = isBad(a), bBad = isBad(b);
    if (aBad !== bBad) return aBad ? 1 : -1;
    return (b._rel - a._rel) || (b._qual - a._qual)
      || String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function _appendAvtrdbRenderBatch(count = AVTRDB_RENDER_BATCH) {
  const grid = document.getElementById("avtrdbGrid");
  if (!grid || !_avtrdbRenderItems.length) return;
  document.getElementById('avtrdb-render-sentinel')?.remove();

  const frag = document.createDocumentFragment();
  const nextCount = Math.min(_avtrdbRenderedCount + count, _avtrdbRenderItems.length);
  const recycler = _ensureRecycler();
  for (let i = _avtrdbRenderedCount; i < nextCount; i++) {
    const av = _avtrdbRenderItems[i];
    let card = _avtrdbRenderMap.get(av.vrc_id);
    if (!card) {
      card = _buildAvtrdbCard(av);
    } else {
      recycler.observe(card);
      if (typeof _ensureAvtrdbMetaObserver === 'function') _ensureAvtrdbMetaObserver().observe(card);
    }
    frag.appendChild(card);
  }
  _avtrdbRenderedCount = nextCount;

  if (_avtrdbRenderedCount < _avtrdbRenderItems.length) {
    const sentinel = document.createElement('div');
    sentinel.id = 'avtrdb-render-sentinel';
    sentinel.style.cssText = 'grid-column:1/-1;height:1px;';
    frag.appendChild(sentinel);
  }
  grid.appendChild(frag);

  const stats = document.getElementById("avtrdbStats");
  if (stats && _avtrdbRenderItems.length) {
    stats.dataset.rendered = String(_avtrdbRenderedCount);
    stats.dataset.total = String(_avtrdbRenderItems.length);
  }

  const sentinel = document.getElementById('avtrdb-render-sentinel');
  if (_avtrdbRenderObserver) _avtrdbRenderObserver.disconnect();
  if (sentinel) {
    _avtrdbRenderObserver = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) _appendAvtrdbRenderBatch();
    }, { root: grid, rootMargin: '700px 0px' });
    _avtrdbRenderObserver.observe(sentinel);
  }
}

// Score + sort all collected records, then (re)render the grid in order.
// This is the core of the relevance ranking: results are ordered by how well
// they match the query, with quality/recency as tiebreakers.
function _rerenderAvtrdbGrid(opts = {}) {
  const grid = document.getElementById("avtrdbGrid");
  const stats = document.getElementById("avtrdbStats");
  if (!grid) return;
  const preserveOrder = !!opts.preserveOrder;

  const requiredPlats = avtrdbCurrentPlatform ? avtrdbCurrentPlatform.split("+") : [];
  const q = avtrdbCurrentQuery;

  let items = Array.from(_avtrdbDedupMap.values()).filter(av => {
    if (!av.vrc_id) return false;
    if (requiredPlats.length > 0) {
      const r = getAvatarPlatforms(av);
      if (!requiredPlats.every(p => r.has(p))) return false;
    }
    if (!_avtrdbTextMatchesField(av, q, avtrdbMatchField)) return false;
    return true;
  });

  if (!preserveOrder) {
    items = _avtrdbSortItems(items);
    _avtrdbDisplayOrder = items.map(av => av.vrc_id);
  } else if (_avtrdbDisplayOrder.length) {
    const order = new Map(_avtrdbDisplayOrder.map((id, idx) => [id, idx]));
    items.sort((a, b) => (order.get(a.vrc_id) ?? 1e9) - (order.get(b.vrc_id) ?? 1e9));
  } else {
    items = _avtrdbSortItems(items);
    _avtrdbDisplayOrder = items.map(av => av.vrc_id);
  }

  const previousRendered = opts.preserveRendered ? _avtrdbRenderedCount : 0;
  _avtrdbRenderItems = items;
  _avtrdbRenderedCount = 0;
  if (_avtrdbRenderObserver) { _avtrdbRenderObserver.disconnect(); _avtrdbRenderObserver = null; }
  // Clear the render map so _appendAvtrdbRenderBatch doesn't re-attach
  // detached cards from the previous render (which could be recycled
  // skeletons that never get restored, leaving blank cards).
  _avtrdbRenderMap = new Map();
  grid.innerHTML = '';
  _appendAvtrdbRenderBatch(Math.max(AVTRDB_RENDER_BATCH, previousRendered));

  // After a manual re-sort, scroll the user back to the top of the new order
  // (otherwise the same scroll position points at a totally different item).
  if (!preserveOrder) {
    try { (grid.closest('.upload-panel') || document.scrollingElement || document.documentElement).scrollTo({ top: 0 }); } catch (_) {}
  }
  avtrdbTotalLoaded = items.length;
  _updateAvtrdbStats();
}

// renderEarlyAvtrdbResults — DEPRECATED. The streaming avtrdbFetch now flushes
// each source to the grid the moment it resolves, so there is no "early vs
// final" distinction. Removed; kept this comment as a tombstone.

async function avtrdbFetch(append, _signal) {
  // Streaming search rewrite (2026-06-19, see memory.md):
  //   - Each source flushes results to the grid the moment it resolves
  //     (no Promise.allSettled wait). User sees first cards in <1s.
  //   - Community sources return their FULL result set in one shot (the `n=`
  //     param is ignored by all four; verified by direct probing). So one
  //     request per community source is enough — no Load-More re-fetch.
  //   - avtrdb is the only source that paginates (page_size capped at 50).
  //     A background driver auto-flips pages until has_more=false; the
  //     "Load More" button is removed.
  // The `append` parameter is preserved for ABI compatibility but is now
  // effectively always-false: any caller passing true is a stale code path.
  const signal = _signal || currentTabAbortController?.signal;
  const grid = document.getElementById("avtrdbGrid");

  const requiredPlats = avtrdbCurrentPlatform ? avtrdbCurrentPlatform.split("+") : [];

  // Fresh search: show a spinner until the first source resolves.
  if (!append) {
    grid.innerHTML = `<div id="avtrdb-loading-spinner" style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;height:200px;gap:16px;color:rgba(255,255,255,0.5);">
      <div style="width:48px;height:48px;border:3px solid rgba(255,255,255,0.15);border-top-color:rgba(255,255,255,0.7);border-radius:50%;animation:spin 0.8s linear infinite;"></div>
      <div style="font-size:0.85em;">正在从 5 个数据库流式搜索...</div>
    </div>`;
  }

  // avtrdb page 0 — fetch + collect + flush, then maybe kick off background driver.
  let avtrdbUrl = `https://api.avtrdb.com/v2/avatar/search?query=${encodeURIComponent(avtrdbCurrentQuery)}&page_size=50&page=0`;
  if (requiredPlats.length > 0) avtrdbUrl += `&compatibility=${requiredPlats[0]}`;
  fetchJsonWithTimeout(`/api/proxy?url=${encodeURIComponent(avtrdbUrl)}`, { signal, timeoutMs: 9000 })
    .then(data => {
      if (signal?.aborted) return;
      _avtrdbHasMore = !!data.has_more;
      (data.avatars || []).forEach(av => _collectAvatar({
        ...av, vrc_id: av.vrc_id, image_url: av.image_url,
        compatibility: av.compatibility || [], performance: av.performance || {}
      }));
      _flushStreamedCards();
      avtrdbPage = 1;
      if (_avtrdbHasMore) {
        // fire-and-forget, but never let an uncaught rejection kill the page
        // promise or leave stats stuck on "background fetching...".
        _avtrdbBackgroundDriver(signal).catch(e => {
          _avtrdbBgDriverRunning = false;
          _avtrdbBgDriverFailedPage = avtrdbPage;
          _updateAvtrdbStats();
        });
      }
    })
    .then(() => { _avtrdbSourceDone(signal); })
    .catch(() => { _avtrdbSourceDone(signal); });

  // Community DBs — each returns its full set in one HTTP call. Fire all four
  // in parallel; each flushes independently as soon as it resolves.
  const dbSources = _communityDbSources(avtrdbCurrentQuery, false);
  if (!append) _avtrdbPendingSources = 1 + dbSources.length; // avtrdb + community DBs
  dbSources.forEach(db => {
    fetchJsonWithTimeout(db.url, { signal, timeoutMs: 14000 })
      .then(data => {
        if (signal?.aborted) return;
        const rawList = Array.isArray(data) ? data : data?.avatars || [];
        rawList.forEach(av => {
          if (db.name === 'cute.bet') {
            _collectAvatar({ ...av, vrc_id: av.id, image_url: av.imageUrl || av.thumbnailImageUrl || "",
              author: { name: av.authorName || "Unknown", id: av.authorId }, unityPackages: av.unityPackages || [] });
          } else {
            _collectAvatar({ vrc_id: av.id, name: av.name || av.avatarName || "未知模型",
              author: { name: av.authorName || "Unknown", id: av.authorId },
              image_url: av.imageUrl || av.thumbnailImageUrl || "",
              performance: av.performance || {},
              compatibility: av.compatibility || (av.imageUrl ? ["pc"] : []),
              description: av.description || "" });
          }
        });
        _flushStreamedCards();
        _avtrdbSourceDone(signal);
      })
      .catch(() => { _avtrdbSourceDone(signal); });
  });

  // Don't await — sources flush themselves. After ~15s, if still no results,
  // the lingering spinner will tell the user something's off (TODO: nicer fail).
  _updateAvtrdbStats();
}





function displayAvatarDetail(av, opts = {}) {
  const modal = document.getElementById("avtrdbDetailModal");
  if (!modal) return;
  _currentDetailAvatar = av; // remember for the fav-menu "save to local" action
  // 1. Normalize fields (handle both VRChat API and AvtrDB/VRCX formats)
  const id = av.vrc_id || av.id || "";
  let name = av.name || av.avatarName || "";
  
  // Recovery: Check global favorites map
  if ((!name || name === 'Unknown' || name.startsWith('Model ')) && window._localNameMap?.has(id)) {
    name = window._localNameMap.get(id);
    av.name = name; // Update memory
  }
  if (!name || name === 'Unknown') name = `Model ${id.substring(5, 13)}`;
  const author = av.author?.name || av.authorName || "Unknown";
  const authorId = av.author?.id || av.authorId || "";
  const desc = av.description || "";
  let thumb = av.image_url || av.thumbnailImageUrl || av.imageUrl || "";
  
  thumb = proxyImg(thumb);

  const createdAt = av.created_at || av.createdAt;
  const updatedAt = av.updated_at || av.updatedAt;

  // 2. Populate UI
  document.getElementById("avtrdbDetailImg").src = thumb;
  document.getElementById("avtrdbDetailName").textContent = name;
  const authorEl = document.getElementById("avtrdbDetailAuthor");
  if (authorEl) authorEl.innerHTML = `by ${authorLinkHtml(author, authorId)}`;
  document.getElementById("avtrdbDetailId").textContent = id;

  const fmt = d => d ? new Date(d).toLocaleString("zh-CN", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" }) : "-";
  document.getElementById("avtrdbDetailCreated").textContent = fmt(createdAt);
  document.getElementById("avtrdbDetailUpdated").textContent = fmt(updatedAt);

  // 3. Platform & Performance Logic (Strict Alignment)
  const platMap = { pc: "PC", android: "Quest", ios: "Apple" };
  const ratingColor = r => ({ VeryPoor:"#ef4444", Poor:"#f59e0b", Medium:"#eab308", Good:"#22c55e", Excellent:"#a3e635" }[r] || "#64748b");
  const ratingHtml = (label, r) => r && r !== "None" ? `<span style="display:inline-block;font-size:0.75em;color:${ratingColor(r)};background:rgba(255,255,255,0.05);padding:2px 8px;border-radius:4px;border:1px solid ${ratingColor(r)}40;margin-right:8px;margin-bottom:4px;">${label}: ${r}</span>` : "";

  const ratingsMap = getAvatarPlatforms(av);
  const plats = Array.from(ratingsMap.keys());

  // Render Platform Badges at top
  const platBadges = plats.map(p =>
    `<span class="avtrdb-badge" style="font-size:0.85em;padding:3px 10px;">${platMap[p] || p}</span>`
  ).join("") || "<span style='color:rgba(255,255,255,0.4)'>-</span>";
  document.getElementById("avtrdbDetailPlats").innerHTML = platBadges;

  // Render Performance section (only show platforms that have actual ratings)
  const perfumes = plats.map(p => ratingHtml(platMap[p] || p, ratingsMap.get(p))).filter(Boolean);
  const perfHtml = perfumes.join("") || "<span style='color:rgba(255,255,255,0.4)'>-</span>";
  document.getElementById("avtrdbDetailPerf").innerHTML = perfHtml;

  const descRow = document.getElementById("avtrdbDetailDescRow");
  document.getElementById("avtrdbDetailDesc").textContent = desc;
  descRow.style.display = desc ? "" : "none";

  // 3b. Release status (Public/Private). VRChat owned-avatar objects carry
  // `releaseStatus`; AvtrDB/community search records sometimes don't, so only
  // show the badge when we actually know. Shown on EVERY detail open
  // regardless of which view (mine / favorites / search) launched it.
  const relRow = document.getElementById("avtrdbDetailReleaseRow");
  const relEl = document.getElementById("avtrdbDetailRelease");
  if (relRow && relEl) {
    const rs = av.releaseStatus || av.release_status || "";
    if (av.isInvalid || rs === 'unavailable' || rs === 'hidden') {
      relEl.innerHTML = '<i class="fa-solid fa-ban"></i> 已失效';
      relEl.style.background = 'var(--error)';
      relEl.style.color = '#fff';
      relRow.style.display = '';
    } else if (rs === 'public') {
      relEl.innerHTML = '<i class="fa-solid fa-globe"></i> Public';
      relEl.style.background = 'var(--success)';
      relEl.style.color = '#052e16';
      relRow.style.display = '';
    } else if (rs === 'private') {
      relEl.innerHTML = '<i class="fa-solid fa-lock"></i> Private';
      relEl.style.background = 'rgba(0,0,0,0.55)';
      relEl.style.color = '#fff';
      relRow.style.display = '';
    } else {
      // Unknown — hide rather than show a misleading default.
      relRow.style.display = 'none';
    }
  }

  // 4. Favorites Status — unified group selector
  // The button always opens the fav-group menu. Groups where this avatar is
  // already favorited show a ✓ checkmark; clicking them triggers unfavorite.
  // Groups without a checkmark add the avatar on click.
  document.getElementById("avtrdbFavStatus").textContent = "";
  document.getElementById("avtrdbFavMenu")?.classList.add("hidden");

  const favBtn = document.getElementById("avtrdbDetailFavBtn");
  const isLocalFaved = localAvatarIdMap.has(id);
  const isCloudFaved = favoriteIdMap.has(id);

  if (isCloudFaved || isLocalFaved) {
     favBtn.innerHTML = '<i class="fa-solid fa-star"></i> 已收藏';
     favBtn.className = "btn btn-success-full";
  } else {
     favBtn.innerHTML = '<i class="fa-solid fa-star"></i> 收藏';
     favBtn.className = "btn btn-secondary";
  }
  // Always open the group selector — for adding or removing
  favBtn.onclick = toggleAvtrdbFavMenu;

  // Pre-build the group list so it's ready when the menu opens
  const favList = document.getElementById("avtrdbFavGroupList");
  if (favList) {
     _buildFavGroupListHtml(favList, id);
     _refreshFavGroupCountsLive(favList, id);
  }

  // 5. Actions
  const switchBtn = document.getElementById("avtrdbDetailSwitchBtn");
  if (switchBtn) switchBtn.onclick = () => switchAvatar(id);

  // 5b. Copy ID / Copy Link buttons — injected dynamically so they always reflect
  //     the current avatar's id regardless of which card/tab opened the modal.
  const favStatus = document.getElementById("avtrdbFavStatus");
  if (favStatus) {
    // Remove old copy buttons if any (from a previous open)
    const oldCopyRow = document.getElementById("avtrdbCopyRow");
    if (oldCopyRow) oldCopyRow.remove();

    const copyRow = document.createElement("div");
    copyRow.id = "avtrdbCopyRow";
    copyRow.style.cssText = "display:flex;gap:8px;margin-top:6px;";

    const copyIdBtn = document.createElement("button");
    copyIdBtn.className = "btn btn-secondary";
    copyIdBtn.style.cssText = "flex:1;font-size:0.82em;";
    copyIdBtn.innerHTML = '<i class="fa-solid fa-copy"></i> 复制 ID';
    copyIdBtn.onclick = () => {
      navigator.clipboard.writeText(id).then(() => {
        showToast("模型 ID 已复制", "success");
        copyIdBtn.innerHTML = '<i class="fa-solid fa-check"></i> 已复制';
        setTimeout(() => { copyIdBtn.innerHTML = '<i class="fa-solid fa-copy"></i> 复制 ID'; }, 2000);
      }).catch(() => showToast("复制失败，请手动复制", "error"));
    };

    const copyLinkBtn = document.createElement("button");
    copyLinkBtn.className = "btn btn-secondary";
    copyLinkBtn.style.cssText = "flex:1;font-size:0.82em;";
    copyLinkBtn.innerHTML = '<i class="fa-solid fa-link"></i> 复制链接';
    copyLinkBtn.onclick = () => {
      const url = `https://vrchat.com/home/avatar/${id}`;
      navigator.clipboard.writeText(url).then(() => {
        showToast("VRChat 模型链接已复制", "success");
        copyLinkBtn.innerHTML = '<i class="fa-solid fa-check"></i> 已复制';
        setTimeout(() => { copyLinkBtn.innerHTML = '<i class="fa-solid fa-link"></i> 复制链接'; }, 2000);
      }).catch(() => showToast("复制失败，请手动复制", "error"));
    };

    copyRow.appendChild(copyIdBtn);
    copyRow.appendChild(copyLinkBtn);
    favStatus.parentNode.insertBefore(copyRow, favStatus);
  }

  // 6. Owner-only actions: edit + delete inside the detail modal.
  // Per-card edit/delete were removed; the detail modal is now the single
  // place these live, matching how worlds work (worldDetailDeleteBtn).
  const ownerRow = document.getElementById("avtrdbDetailOwnerActions");
  if (ownerRow) {
    const isOwner = currentUserId && av.authorId && av.authorId === currentUserId;
    // Use the .hidden class (display:none !important) instead of inline style
    // so we don't fight with our flex layout on show.
    ownerRow.classList.toggle('hidden', !isOwner);
    if (isOwner) {
      const editBtn = document.getElementById("avtrdbDetailEditBtn");
      const delBtn = document.getElementById("avtrdbDetailDeleteBtn");
      if (editBtn) editBtn.onclick = () => {
        // Close detail first so the edit modal owns the foreground.
        closeAvtrdbDetail();
        if (typeof editAvatar === 'function') editAvatar(id);
      };
      if (delBtn) delBtn.onclick = () => {
        if (typeof deleteAvatar === 'function') deleteAvatar(id, name);
      };
    }
  }

  modal.classList.remove("hidden");
  if (modal.dataset.scrollLocked !== '1') { lockBodyScroll(); modal.dataset.scrollLocked = '1'; }
  if (!opts.preserveZ) modal.style.zIndex = modalZTop();
  if (!av.isInvalid && typeof rememberAvatarDetailSnapshot === 'function') {
    rememberAvatarDetailSnapshot(av).catch(() => {});
  }
}

async function openAvtrdbDetail(av) {
  bumpUiEpoch();
  const detailToken = makeUiToken('avatarDetail', av.vrc_id || av.id || '');
  window._avatarDetailActiveToken = detailToken;
  const detailCtrl = beginScopedAbort('avatarDetail');
  displayAvatarDetail(av); // Show immediately with available data

  const id = av.vrc_id || av.id;
  if (!id) return;

  // If dates are missing, fetch from sources that reliably carry them
  if (!av.created_at && !av.createdAt) {
    // Try cute.bet first (returns updated_at reliably, sometimes created_at)
    const cuteUrl = `/api/proxy?url=${encodeURIComponent(`https://avtr.cute.bet/search?search=${id}`)}`;
    // Also try AvtrDB v2 single-id search (carries created_at)
    const avtrUrl = `/api/proxy?url=${encodeURIComponent(`https://api.avtrdb.com/v2/avatar/search?query=${id}&page_size=1`)}`;

    const tryPatch = (data) => {
      if (!isUiTokenCurrent(detailToken)) return;
      if (!data) return;
      const created = data.created_at || data.createdAt;
      const updated = data.updated_at || data.updatedAt;
      if (created || updated) {
        if (created && !av.created_at) av.created_at = created;
        if (updated && !av.updated_at) av.updated_at = updated;
        // Re-render dates in the open modal
        const fmt = d => d ? new Date(d).toLocaleString("zh-CN", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" }) : "-";
        const elC = document.getElementById("avtrdbDetailCreated");
        const elU = document.getElementById("avtrdbDetailUpdated");
        if (elC) elC.textContent = fmt(av.created_at || av.createdAt);
        if (elU) elU.textContent = fmt(av.updated_at || av.updatedAt);
      }
    };

    // Fire both in parallel, patch as soon as either returns
    fetch(cuteUrl, { signal: detailCtrl.signal }).then(r => r.json()).then(data => {
      if (!isUiTokenCurrent(detailToken)) return;
      const list = Array.isArray(data) ? data : (data?.avatars || []);
      const match = list.find(x => x.id === id) || (list.length === 1 ? list[0] : null) || (list.length > 0 ? list[0] : null);
      tryPatch(match);
    }).catch(() => {});

    fetch(avtrUrl, { signal: detailCtrl.signal }).then(r => r.json()).then(data => {
      if (!isUiTokenCurrent(detailToken)) return;
      const list = data?.avatars || [];
      const match = list.find(x => x.vrc_id === id);
      tryPatch(match);
    }).catch(() => {});
  }
}

async function openLocalDetail(id) {
  bumpUiEpoch();
  const detailToken = makeUiToken('avatarDetail', id);
  window._avatarDetailActiveToken = detailToken;
  const detailCtrl = beginScopedAbort('avatarDetail');
  const av = visibleAvatars.find(a => a.id === id) || avatars.find(a => a.id === id) || { id };
  displayAvatarDetail(av);

  try {
    const r = await apiCall(`/api/vrc/avatars/${id}`, { signal: detailCtrl.signal, noDedupe: true });
    if (r.ok) {
      const full = await r.json();
      if (!isUiTokenCurrent(detailToken) || !isScopedAbortCurrent('avatarDetail', detailCtrl)) return;
      if (full && full.id) {
        const merged = Object.assign({}, av, full, { isInvalid: false, invalidReason: '' });
        const vidx = visibleAvatars.findIndex(a => a.id === id);
        if (vidx !== -1) visibleAvatars[vidx] = merged;
        const aidx = avatars.findIndex(a => a.id === id);
        if (aidx !== -1) avatars[aidx] = Object.assign({}, avatars[aidx], merged);
        displayAvatarDetail(merged, { preserveZ: true });
      }
      return;
    }

    if (r.status === 404 || r.status === 403) {
      const cached = typeof findCachedAvatarSnapshot === 'function' ? await findCachedAvatarSnapshot(id) : null;
      if (!isUiTokenCurrent(detailToken) || !isScopedAbortCurrent('avatarDetail', detailCtrl)) return;
      const invalid = Object.assign(
        {},
        cached || {},
        av,
        cached || {},
        {
          id,
          isInvalid: true,
          releaseStatus: 'unavailable',
          invalidReason: `HTTP ${r.status}`,
          name: (cached?.name || cached?.avatarName || av.name || av.lastKnownName || '失效模型 (Invalid / Deleted)'),
          thumbnailImageUrl: cached?.thumbnailImageUrl || cached?.imageUrl || cached?.image_url || av.thumbnailImageUrl || av.imageUrl || '',
          imageUrl: cached?.imageUrl || cached?.thumbnailImageUrl || cached?.image_url || av.imageUrl || av.thumbnailImageUrl || ''
        }
      );
      displayAvatarDetail(invalid, { preserveZ: true });
      recoverInvalidAvatarDetailFromPublicSources(id, invalid, { persist: false, token: detailToken, signal: detailCtrl.signal }).catch(() => {});
    }
  } catch (_) {
    const cached = typeof findCachedAvatarSnapshot === 'function' ? await findCachedAvatarSnapshot(id) : null;
    if (cached && isUiTokenCurrent(detailToken) && isScopedAbortCurrent('avatarDetail', detailCtrl)) displayAvatarDetail(Object.assign({}, av, cached), { preserveZ: true });
  }
}

async function recoverInvalidAvatarDetailFromPublicSources(id, baseAv, opts = {}) {
  if (!id) return null;
  const cached = typeof findCachedAvatarSnapshot === 'function' ? await findCachedAvatarSnapshot(id) : null;
  let merged = Object.assign({}, baseAv || {}, cached || {}, { id, isInvalid: true, releaseStatus: 'unavailable' });

  const mergeCandidate = (candidate) => {
    if (!candidate) return;
    const candidateId = candidate.id || candidate.vrc_id || candidate.avatarId;
    if (candidateId && candidateId !== id) return;
    if (candidate.name && (!merged.name || merged.name.startsWith('失效模型'))) merged.name = candidate.name;
    if (candidate.avatarName && !merged.name) merged.name = candidate.avatarName;
    if (candidate.thumbnailImageUrl && !merged.thumbnailImageUrl) merged.thumbnailImageUrl = candidate.thumbnailImageUrl;
    if (candidate.imageUrl && !merged.imageUrl) merged.imageUrl = candidate.imageUrl;
    if (candidate.image_url && !merged.imageUrl) merged.imageUrl = candidate.image_url;
    if (candidate.image_url && !merged.thumbnailImageUrl) merged.thumbnailImageUrl = candidate.image_url;
    if (candidate.created_at && !merged.created_at) merged.created_at = candidate.created_at;
    if (candidate.createdAt && !merged.created_at) merged.created_at = candidate.createdAt;
    if (candidate.updated_at && !merged.updated_at) merged.updated_at = candidate.updated_at;
    if (candidate.updatedAt && !merged.updated_at) merged.updated_at = candidate.updatedAt;
    if (candidate.description && !merged.description) merged.description = candidate.description;
  };

  try {
    const endpoints = [
      `/api/proxy?url=${encodeURIComponent(`https://avtr.cute.bet/search?search=${id}`)}`,
      `/api/proxy?url=${encodeURIComponent(`https://api.avtrdb.com/v2/avatar/search?query=${id}&page_size=1`)}`,
      `/api/proxy?url=${encodeURIComponent(`https://vrcx.vrcdb.com/avatars/Avatar/VRCX?avatarId=${id}`)}`
    ];

    for (const url of endpoints) {
      try {
        const r = await apiCall(url, Object.assign({ noAbort: true }, opts.signal ? { signal: opts.signal, noAbort: false } : {}));
        if (!r.ok) continue;
        const data = await r.json().catch(() => null);
        const list = Array.isArray(data) ? data : (data?.avatars || data?.results || []);
        const hit = (list || []).find(x => x.id === id || x.vrc_id === id || x.avatarId === id) || (Array.isArray(data) ? null : data);
        mergeCandidate(hit);
      } catch (_) {}
    }
  } catch (_) {}

  merged.name = merged.name || merged.avatarName || `失效模型 ${id.substring(5, 13)}`;
  merged.thumbnailImageUrl = merged.thumbnailImageUrl || merged.imageUrl || '';
  merged.imageUrl = merged.imageUrl || merged.thumbnailImageUrl || '';
  merged.invalidReason = merged.invalidReason || 'HTTP 404';
  if (opts.persist && typeof rememberAvatarDetailSnapshot === 'function') {
    await rememberAvatarDetailSnapshot(merged);
  }
  const modal = document.getElementById("avtrdbDetailModal");
  if ((!opts.token || isUiTokenCurrent(opts.token)) && modal && !modal.classList.contains("hidden")) {
    displayAvatarDetail(merged, { preserveZ: true });
  }
  return merged;
}


function closeAvtrdbDetail() {
  bumpUiEpoch();
  window._avatarDetailActiveToken = null;
  cancelScopedAbort('avatarDetail');
  const modal = document.getElementById("avtrdbDetailModal");
  if (modal) {
    modal.classList.add("hidden");
    if (modal.dataset.scrollLocked === '1') { unlockBodyScroll(); modal.dataset.scrollLocked = ''; }
  }
  document.getElementById("avtrdbFavMenu")?.classList.add("hidden");
  if (typeof flushPendingAvatarCardUpdates === 'function') flushPendingAvatarCardUpdates();
}

function toggleAvatarFavGridMenu(event, id, name, btn) {
  const menu = document.getElementById("avtrdbFavMenu");
  if (!menu) return;
  menu.dataset.avatarId = id;
  toggleFavMenuGeneric(event, menu, btn, () => {
    const tmp = document.createElement('div');
    _buildFavGroupListHtml(tmp, id, {
      localSaveAction: `saveToLocalFavorite(visibleAvatars.find(a=>a.id==='${escJsAttr(id)}'))`
    });
    return tmp.innerHTML;
  });
}

function toggleAvtrdbFavMenu(event) {
  const menu = document.getElementById("avtrdbFavMenu");
  const btn = document.getElementById("avtrdbDetailFavBtn");
  if (!menu || !btn) return;
  toggleFavMenuGeneric(event, menu, btn, () => {
    const idRow = document.getElementById("avtrdbDetailId");
    const id = idRow ? idRow.textContent : "";
    menu.dataset.avatarId = id;
    // Build immediately with live per-group counters; avoids showing stale cached counts.
    const tmp = document.createElement('div');
    _buildFavGroupListHtml(tmp, id);
    return tmp.innerHTML;
  });
}

function toggleFavMenuGeneric(event, menu, btn, contentFn) {
  event.stopPropagation();
  if (!menu.classList.contains("hidden")) {
    menu.classList.add("hidden");
    return;
  }
  const list = menu.querySelector('div:last-child');
  if (list) {
    list.innerHTML = contentFn();
    if (menu.dataset.avatarId) _refreshFavGroupCountsLive(list, menu.dataset.avatarId);
  }

  menu.classList.remove("hidden");
  // Float above whatever modal is currently open. The hardcoded z-index:2000 in
  // the markup gets overridden here because friend/world detail modals use
  // modalZTop() which starts at 2001+ — the menu would otherwise paint BEHIND
  // the modal that opened it ("friend favorite button doesn't respond").
  if (typeof modalZPeek === 'function') {
    menu.style.zIndex = String(modalZPeek() + 5);
  }
  
  let left, top;
  if (btn) {
    const rect = btn.getBoundingClientRect();
    const menuH = menu.offsetHeight || 160;
    left = Math.min(rect.left, window.innerWidth - 200);
    top = rect.top - menuH - 6;
    if (top < 10) top = rect.bottom + 6;
  } else {
    left = Math.min(event.clientX, window.innerWidth - 200);
    top = Math.min(event.clientY, window.innerHeight - 200);
  }
  
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  
  const close = (e) => {
    if (!menu.contains(e.target)) {
      menu.classList.add("hidden");
      document.removeEventListener("click", close);
    }
  };
  setTimeout(() => document.addEventListener("click", close), 0);
}

async function addToFavorite(avtrId, groupName, btn) {
  document.getElementById("avtrdbFavMenu")?.classList.add("hidden");
  const statusEl = document.getElementById("avtrdbFavStatus");
  statusEl.style.color = "var(--text-muted)";
  statusEl.textContent = `正在收藏到 ${groupName}...`;
  if (btn) { btn.disabled = true; btn.style.opacity = "0.6"; }

  try {
    const resp = await apiCall("/api/vrc/favorites", {
      method: "POST",
      json: { type: "avatar", favoriteId: avtrId, tags: [groupName] },
    });
    if (resp.ok) {
      statusEl.style.color = "var(--success)";
      statusEl.textContent = `✓ 已收藏到 ${groupName}`;
      // Track the new favoriteId so the user can immediately unfavorite without
      // first refetching the whole favorites list. Same shape as syncAllFavoriteIds.
      const data = await resp.json().catch(() => null);
      if (data && data.id) favoriteIdMap.set(avtrId, data.id);
      // Track which group this avatar is now in
      const existing = avatarFavTagMap.get(avtrId);
      if (existing) existing.add(groupName);
      else avatarFavTagMap.set(avtrId, new Set([groupName]));
      // Bump the per-group counter so the sidebar "x/50" hint and the
      // disabled-when-full state are accurate without a roundtrip.
      avatarFavGroupCounts.set(groupName, (avatarFavGroupCounts.get(groupName) || 0) + 1);
      // Keep IDB in step with this local mutation. Normal category switches are
      // IDB-first; startup index sync handles out-of-band changes.
      const knownAvatar = visibleAvatars.find(a => a.id === avtrId)
        || (_currentDetailAvatar && ((_currentDetailAvatar.id || _currentDetailAvatar.vrc_id) === avtrId) ? _currentDetailAvatar : null)
        || { id: avtrId };
      await upsertAvatarIntoFavoriteCache(groupName, knownAvatar);
      // INSTANT UI: flip the unified card-fav-quick toggle from ☆ to ★ on the
      // currently-rendered card so the user sees the favorite land immediately.
      const card = document.getElementById("card-" + avtrId);
      if (card) {
        const fq = card.querySelector('.card-fav-quick');
        if (fq) {
          fq.innerHTML = '<i class="fa-solid fa-star"></i> ';
          fq.title = '已收藏';
        }
      }
      // Refresh the detail modal button to show "已收藏" state
      _refreshDetailAfterFavChange(avtrId);
    } else {
      const err = await resp.json().catch(() => ({}));
      statusEl.style.color = "var(--error)";
      statusEl.textContent = `✗ 收藏失败：${err.error?.message || resp.status}`;
    }
  } catch (e) {
    statusEl.style.color = "var(--error)";
    statusEl.textContent = `✗ 网络错误：${e.message}`;
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ""; }
  }
}

// Unfavorite from a specific group via the group selector in the detail modal.
// Unlike the old unfavorite() which removes the avatar from the current view list,
// this only removes the favorite link. The detail modal stays open.
async function unfavoriteFromGroup(avtrId, groupName, btn) {
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; btn.textContent = '移除中...'; }
  const statusEl = document.getElementById("avtrdbFavStatus");
  try {
    // Resolve the favoriteId for this avatar
    const favId = favoriteIdMap.get(avtrId);
    if (!favId) {
      // Try live lookup
      const r = await apiCall(`/api/vrc/favorites?type=avatar&tag=${groupName}&n=100`);
      if (r.ok) {
        const list = await r.json();
        const hit = (list || []).find(f => f.favoriteId === avtrId);
        if (hit) favoriteIdMap.set(avtrId, hit.id);
      }
    }
    const resolvedFavId = favoriteIdMap.get(avtrId);
    if (!resolvedFavId) {
      if (statusEl) { statusEl.style.color = 'var(--error)'; statusEl.textContent = '✗ 找不到收藏记录'; }
      return;
    }
    const resp = await apiCall(`/api/vrc/favorites/${resolvedFavId}`, { method: 'DELETE' });
    if (!resp.ok && resp.status !== 404) {
      throw new Error('HTTP ' + resp.status);
    }
    // Update state
    favoriteIdMap.delete(avtrId);
    const tags = avatarFavTagMap.get(avtrId);
    if (tags) { tags.delete(groupName); if (tags.size === 0) avatarFavTagMap.delete(avtrId); }
    const cur = avatarFavGroupCounts.get(groupName) || 0;
    avatarFavGroupCounts.set(groupName, Math.max(0, cur - 1));
    await removeAvatarFromFavoriteCache(groupName, avtrId);
    if (statusEl) { statusEl.style.color = 'var(--success)'; statusEl.textContent = `✓ 已从 ${groupName} 移除`; }
    // Flip the card star back
    const card = document.getElementById('card-' + avtrId);
    if (card) {
      const fq = card.querySelector('.card-fav-quick');
      if (fq && !favoriteIdMap.has(avtrId) && !localAvatarIdMap.has(avtrId)) {
        fq.textContent = '☆'; fq.title = '添加到收藏';
      }
    }
    // Refresh detail modal
    _refreshDetailAfterFavChange(avtrId);
  } catch (e) {
    if (statusEl) { statusEl.style.color = 'var(--error)'; statusEl.textContent = `✗ 取消收藏失败: ${e.message}`; }
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

// Refresh the detail modal's favorite button and group list after a fav change.
// Called after addToFavorite / unfavoriteFromGroup / saveToLocal / removeFromLocal.
function _refreshDetailAfterFavChange(avtrId) {
  const modal = document.getElementById('avtrdbDetailModal');
  if (!modal || modal.classList.contains('hidden')) return;
  const displayedId = document.getElementById('avtrdbDetailId')?.textContent;
  if (displayedId !== avtrId) return;

  const favBtn = document.getElementById('avtrdbDetailFavBtn');
  const isCloudFaved = favoriteIdMap.has(avtrId);
  const isLocalFaved = localAvatarIdMap.has(avtrId);
  if (isCloudFaved || isLocalFaved) {
    favBtn.innerHTML = '<i class="fa-solid fa-star"></i> 已收藏';
    favBtn.className = 'btn btn-success-full';
  } else {
    favBtn.innerHTML = '<i class="fa-solid fa-star"></i> 收藏';
    favBtn.className = 'btn btn-secondary';
  }
  // Rebuild group list to reflect new checkmarks
  const favList = document.getElementById('avtrdbFavGroupList');
  if (favList) {
    _buildFavGroupListHtml(favList, avtrId);
    _refreshFavGroupCountsLive(favList, avtrId);
  }
}

function openInVRCX(avtrId) {
  window.open(`vrcx://avatar/${avtrId}`, "_self");
}

async function switchAvatar(avtrId) {
  const btn = document.getElementById("avtrdbDetailSwitchBtn");
  const originalText = btn ? btn.innerHTML : '<i class="fa-solid fa-bolt"></i> 切换模型';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-bolt"></i> 正在切换...';
  }

  try {
    const resp = await apiCall(`/api/vrc/avatars/${avtrId}/select`, {
      method: "PUT"
    });
    const result = await resp.json().catch(() => ({}));
    if (resp.ok && !result.error) {
      logMsg('<i class="fa-solid fa-check"></i> 模型切换成功 (Avatar switched successfully)！', "success");
      if (btn) btn.innerHTML = '<i class="fa-solid fa-check"></i> 已切换';
    } else {
      throw new Error(result.error?.message || "未知错误");
    }
  } catch (e) {
    logMsg(`<i class="fa-solid fa-xmark"></i> 模型切换失败 (Failed to switch): ${e.message}`, "error");
    if (btn) btn.innerHTML = '<i class="fa-solid fa-xmark"></i> 切换失败';
  } finally {
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalText;
      }
    }, 2000);
  }
}

// ── Set Fallback Avatar (PUT /avatars/{id}/selectFallback) ──
// Fallback avatars must be public & PC-performance "Good" or better; the API
// rejects ineligible avatars, so we surface that error to the user.
async function setFallbackAvatar(avtrId, name) {
  if (!confirm(`将「${name || avtrId}」设为后备模型？\n\n（后备模型需为公开且 PC 性能良好以上）`)) return;
  try {
    const r = await apiCall(`/api/vrc/avatars/${avtrId}/selectFallback`, { method: 'PUT' });
    const res = await r.json().catch(() => ({}));
    if (r.ok && !res.error) {
      showToast('已设为后备模型', 'success');
      logMsg(`<i class="fa-solid fa-check"></i> 已将「${name || avtrId}」设为后备模型`, 'success');
    } else {
      throw new Error(res.error?.message || ('HTTP ' + r.status));
    }
  } catch(e) {
    showToast('设置后备模型失败: ' + e.message, 'error');
  }
}

// ── Impostor generation (Quest/mobile optimized clones) ──
async function enqueueImpostor(avtrId, name) {
  if (!confirm(`为「${name || avtrId}」生成 Impostor？\n\nImpostor 是 VRChat 自动生成的低性能替身，方便移动端显示。生成需要排队，可能耗时数分钟。`)) return;
  try {
    const r = await apiCall(`/api/vrc/avatars/${avtrId}/impostor/enqueue`, { method: 'POST' });
    const res = await r.json().catch(() => ({}));
    if (r.ok && !res.error) {
      showToast('已加入 Impostor 生成队列', 'success');
      logMsg(`<i class="fa-solid fa-check"></i> 已为「${name || avtrId}」排队生成 Impostor`, 'success');
    } else {
      throw new Error(res.error?.message || ('HTTP ' + r.status));
    }
  } catch(e) {
    showToast('生成 Impostor 失败: ' + e.message, 'error');
  }
}

async function deleteImpostor(avtrId, name) {
  if (!confirm(`删除「${name || avtrId}」的 Impostor？`)) return;
  try {
    const r = await apiCall(`/api/vrc/avatars/${avtrId}/impostor`, { method: 'DELETE' });
    if (r.ok) {
      showToast('已删除 Impostor', 'success');
      logMsg(`<i class="fa-solid fa-check"></i> 已删除「${name || avtrId}」的 Impostor`, 'info');
    } else {
      showToast('删除 Impostor 失败: HTTP ' + r.status, 'error');
    }
  } catch(e) {
    showToast('错误: ' + e.message, 'error');
  }
}

VRCW.registerModule('search', {
  saveCurrentDetailToLocal,
  onSearchCategoryChange,
  onAvtrdbInput,
  doAvtrdbSearch,
  avtrdbLoadMore,
  setAvtrdbSort,
  setAvtrdbMatchField,
  openAvtrdbDetail,
  openLocalDetail,
  closeAvtrdbDetail,
  toggleAvatarFavGridMenu,
  toggleAvtrdbFavMenu,
  addToFavorite,
  unfavoriteFromGroup,
  _refreshDetailAfterFavChange,
  openInVRCX,
  switchAvatar,
  setFallbackAvatar,
  enqueueImpostor,
  deleteImpostor,
});
renderAppVersionInfo();

/*
 * VRCW — avatars.js
 * 模型分类/列表渲染/收藏取消/清理/编辑删除/下载/文件拖拽
 *
 * 注意：本项目为「经典脚本」(非 ES module)，全部按顺序加载、共享全局作用域。
 * 函数声明会提升为全局，跨文件调用没问题；请勿改为 type="module"。
 */
let currentCategory = "mine";

function switchCategory(cat) {
  currentCategory = cat;
  // Switching tabs invalidates the current selection — keeping IDs across tabs
  // would let "delete selected" hit avatars in a category the user can't see,
  // and the "已选 N" footer would lie about scope. Reset both the set and the
  // counter chip so the next click of an avatar starts fresh in the new view.
  if (typeof selectedIds !== 'undefined' && selectedIds.clear) selectedIds.clear();
  const ssChip = document.getElementById('statSelected');
  if (ssChip) ssChip.textContent = '0';
  document.querySelectorAll(".cat-btn").forEach((btn) => {
    btn.classList.remove("active", "btn-primary");
    btn.classList.add("btn-secondary");
  });
  const activeBtn = document.getElementById("cat-" + cat);
  if (activeBtn) {
    activeBtn.classList.remove("btn-secondary");
    activeBtn.classList.add("btn-primary", "active");
  }

  // Immediately update context-dependent sidebar buttons
  const isFavoriteView = cat !== "mine";
  document.getElementById("btnCleanFavs")?.classList.toggle("hidden", !isFavoriteView);
  document.getElementById("btnUnfavoriteSelected")?.classList.toggle("hidden", !isFavoriteView);
  document.getElementById("btnSelectAll")?.classList.remove("hidden"); // Always visible
  document.getElementById("saveDirGroup")?.classList.toggle("hidden", isFavoriteView);
  document.querySelector('button[onclick="downloadSelected()"]')?.classList.toggle("hidden", isFavoriteView);

  // Close sidebar on mobile after selection
  document.getElementById("appSidebar")?.classList.remove("open");
  document.getElementById("sidebarOverlay")?.classList.remove("active");

  const shouldRefreshLive = cat !== "mine" && cat !== "local";
  runPriorityTask(async () => { await fetchAvatars(shouldRefreshLive); });
}

// ── Selected Count Helper ──
function updateSelectedCount() {
  const el = document.getElementById("statSelected");
  if (el) el.textContent = selectedIds.size;
}

// ── Avatars ──
let fetchSeq = 0; // Track latest fetch to avoid stale renders
// TTL: skip the API refresh entirely when basics cache is younger than this.
// Tab switches pass forceRefresh=false → fast path; the <i class="fa-solid fa-rotate-right"></i> button passes true.
const AVATARS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const avatarCardElements = new Map();
const pendingAvatarCardUpdates = new Map();

function _isAvatarListRenderable() {
  const panel = document.getElementById('downloadPanel');
  const blockingDetailIds = [
    'avtrdbDetailModal',
    'friendProfileModal',
    'worldDetailModal',
    'groupDetailModal',
    'instanceDetailModal'
  ];
  const detailOpen = blockingDetailIds.some(id => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden');
  });
  return currentTab === 'download'
    && (!panel || panel.classList.contains('active'))
    && !detailOpen;
}

function _queueAvatarCardUpdate(av) {
  if (!av || !av.id) return;
  pendingAvatarCardUpdates.set(av.id, av);
}

function flushPendingAvatarCardUpdates() {
  if (!_isAvatarListRenderable() || pendingAvatarCardUpdates.size === 0) return;
  const pending = Array.from(pendingAvatarCardUpdates.values());
  pendingAvatarCardUpdates.clear();
  pending.forEach(av => _replaceAvatarCard(av));
}

function _avatarMatchesCurrentFilters(av) {
  if (!av) return false;
  const q = document.getElementById("searchInput")?.value.toLowerCase().trim() || "";
  const state = document.getElementById("filterStatus")?.value || "all";
  const plat = document.getElementById("filterPlatform")?.value || "all";

  if (state !== "all" && av.releaseStatus !== state) return false;
  if (plat !== "all") {
    const { hasPC, hasQuest, hasApple } = _platformCheck(av);
    if (plat === "pc" && !hasPC) return false;
    if (plat === "pc-quest" && (!hasPC || !hasQuest)) return false;
    if (plat === "pc-quest-apple" && (!hasPC || !hasQuest || !hasApple)) return false;
  }
  if (q) {
    const name = (av.name || "").toLowerCase();
    const desc = (av.description || "").toLowerCase();
    const tags = (av.tags || []).join(" ").toLowerCase();
    let score = 0;
    if (name === q) score += 100;
    else if (name.includes(q)) score += 50;
    if (tags.includes(q)) score += 30;
    if (desc.includes(q)) score += 10;
    if (score === 0) {
      let qIdx = 0;
      for (let i = 0; i < name.length; i++) {
        if (name[i] === q[qIdx]) qIdx++;
        if (qIdx === q.length) break;
      }
      if (qIdx === q.length) score += 5;
    }
    if (score === 0) return false;
  }
  return true;
}

function _mergeAvatarIntoLists(fresh) {
  if (!fresh || !fresh.id) return null;
  let merged = fresh;
  const aidx = avatars.findIndex(ex => ex.id === fresh.id);
  if (aidx !== -1) {
    merged = Object.assign({}, avatars[aidx], fresh);
    avatars[aidx] = merged;
  } else {
    avatars.push(fresh);
  }
  const vidx = visibleAvatars.findIndex(ex => ex.id === fresh.id);
  if (vidx !== -1) {
    visibleAvatars[vidx] = Object.assign({}, visibleAvatars[vidx], merged);
    merged = visibleAvatars[vidx];
  }
  return merged;
}

function _avatarBasicFromItem(a) {
  if (!a || !a.id) return null;
  return {
    id: a.id,
    name: a.name,
    thumbnailImageUrl: a.thumbnailImageUrl,
    imageUrl: a.imageUrl,
    releaseStatus: a.releaseStatus,
    authorId: a.authorId,
    tags: a.tags,
    isInvalid: !!a.isInvalid,
    invalidReason: a.invalidReason,
    lastKnownName: a.lastKnownName,
    lastKnownThumbnailImageUrl: a.lastKnownThumbnailImageUrl,
    lastKnownImageUrl: a.lastKnownImageUrl
  };
}

function _markAvatarInvalidFromCache(av, status) {
  const name = av?.name && !String(av.name).startsWith('失效模型') ? av.name : (av?.lastKnownName || '');
  const thumb = av?.thumbnailImageUrl || av?.imageUrl || av?.lastKnownThumbnailImageUrl || av?.lastKnownImageUrl || '';
  return Object.assign({}, av || {}, {
    id: av?.id,
    name: name || '失效模型 (Invalid / Deleted)',
    releaseStatus: 'unavailable',
    isInvalid: true,
    invalidReason: status ? `HTTP ${status}` : 'unavailable',
    lastKnownName: name || av?.lastKnownName || '',
    lastKnownThumbnailImageUrl: av?.lastKnownThumbnailImageUrl || av?.thumbnailImageUrl || '',
    lastKnownImageUrl: av?.lastKnownImageUrl || av?.imageUrl || '',
    thumbnailImageUrl: thumb,
    imageUrl: av?.imageUrl || av?.lastKnownImageUrl || thumb
  });
}

function _isAvatarInvalid(av) {
  return !!(av && (av.isInvalid || !av.name || av.releaseStatus === 'hidden' || av.releaseStatus === 'unavailable'));
}

async function _verifyFavoriteAvatarCache(groupName, seq, opts = {}) {
  if (!groupName || groupName === 'mine' || groupName === 'local') return;
  const list = Array.isArray(opts.source) ? opts.source : avatars;
  if (!Array.isArray(list) || list.length === 0) return;
  const CONCURRENCY = opts.concurrency || 12;
  let changed = false;
  let verified = 0;
  const next = list.map(a => Object.assign({}, a));

  const verifyOne = async (av) => {
    if (!av || !av.id) return null;
    try {
      const r = await apiCall(`/api/vrc/avatars/${av.id}`, { noAbort: true });
      if (r.ok) {
        const full = await r.json().catch(() => null);
        if (full && full.id) return Object.assign({}, av, full, { isInvalid: false, invalidReason: '' });
        return av;
      }
      if (r.status === 404 || r.status === 403) return _markAvatarInvalidFromCache(av, r.status);
      return av;
    } catch (_) {
      return av;
    }
  };

  for (let i = 0; i < next.length; i += CONCURRENCY) {
    if (seq && seq !== fetchSeq) return;
    const chunk = next.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(verifyOne));
    results.forEach((fresh, offset) => {
      if (!fresh) return;
      const idx = i + offset;
      if (JSON.stringify(_avatarBasicFromItem(next[idx])) !== JSON.stringify(_avatarBasicFromItem(fresh))) changed = true;
      next[idx] = fresh;
      verified++;
    });
    if (opts.onProgress) opts.onProgress(verified, next.length);
  }

  if (!changed) {
    await idb.set("avatar_basics_age_" + groupName, Date.now()).catch(()=>{});
    return;
  }

  await idb.set("avatars_" + groupName, next).catch(()=>{});
  await idb.set("avatar_basics_" + groupName, next.map(_avatarBasicFromItem).filter(Boolean)).catch(()=>{});
  await idb.set("avatar_basics_age_" + groupName, Date.now()).catch(()=>{});

  if (!seq || (seq === fetchSeq && currentCategory === groupName)) {
    avatars = next.map(_avatarBasicFromItem).filter(Boolean);
    applyFilters();
    const invalidCount = avatars.filter(_isAvatarInvalid).length;
    if (invalidCount > 0) logMsg(`⚠ 发现 ${invalidCount} 个失效模型，已更新缓存`, 'error');
  }
}

async function fetchAvatars(forceRefresh = false) {
  const seq = ++currentGlobalFetchSeq;
  fetchSeq = seq; 
  const grid = document.getElementById("avatarGrid");

  // ── Step 1: Always render basics from cache immediately (if available) ──
  // forceRefresh now ONLY means "also re-hit the API after rendering cache" —
  // it no longer trashes the cached UI. Previously force=true wiped the grid to
  // a "加载中..." spinner, so switching tabs (which always passes force=true)
  // visibly nuked already-rendered cards. Reserve the wipe for genuinely empty
  // states.
  let renderedFromCache = false;
  let cacheIsFresh = false;
  try {
    const cachedBasicsRaw = await idb.get('avatar_basics_' + currentCategory);
    const cacheExists = Array.isArray(cachedBasicsRaw);
    const cachedBasics = cacheExists ? cachedBasicsRaw : [];
    const cacheAge = await idb.get('avatar_basics_age_' + currentCategory) || 0;
    cacheIsFresh = cacheExists && (Date.now() - cacheAge) < AVATARS_CACHE_TTL;
    if (cacheExists) {
      avatars = cachedBasics;
      applyFilters();
      renderedFromCache = true;
      if (!forceRefresh) logMsg(`Loaded ${avatars.length} cached avatars${cacheIsFresh ? '（缓存有效跳过 API）' : ''}`, "info");
      // Favorite groups are IDB-first: startup/background index sync updates
      // stale favorite caches only when their remote ID index changes. "Mine"
      // has no cheap index endpoint, so it keeps the TTL-driven refresh path.
      if (!forceRefresh && currentCategory !== "mine") {
        _verifyFavoriteAvatarCache(currentCategory, seq).catch(e => console.warn('verify favorite avatars failed', e));
        return;
      }
      if (!forceRefresh && currentCategory === "mine" && cacheIsFresh) return;
    } else if (grid) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:60px;color:rgba(255,255,255,0.4);">加载中...</div>`;
    }
  } catch(e) {}

  // ── Step 2: Full Refresh ──────────────────────────────────────────────
  try {
    let allFetched = [];

    if (currentCategory === "mine") {
      // VRChat caps `n` at 100 — paginate for users with more avatars.
      // (Worker exposes `/api/vrc/*` as a passthrough; the legacy `/api/avatars`
      //  was removed from the worker, which made this fetch 404 → black-screen on login.)
      let offset = 0;
      while (true) {
        if (seq !== currentGlobalFetchSeq) return;
        const resp = await apiCall(`/api/vrc/avatars?user=me&releaseStatus=all&n=100&offset=${offset}`);
        if (!resp.ok) {
          if (offset === 0) throw new Error("Failed to fetch avatars: HTTP " + resp.status);
          break; // partial result is fine
        }
        const batch = await resp.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        allFetched = allFetched.concat(batch);
        // Render progressively after each page so users with 200+ avatars see
        // the first 100 immediately instead of waiting for every page. Only do
        // this when there's no cached view already on screen (cold load) — when
        // a cache render is up we let the final applyFilters() swap it once.
        if (!renderedFromCache && seq === fetchSeq) {
          avatars = allFetched;
          applyFilters();
        }
        if (batch.length < 100) break;
        offset += 100;
        if (offset >= 1000) break; // safety ceiling
      }
    } else if (currentCategory === "local") {
      allFetched = localAvatarFavs;
    } else {
      // VRC+ favorites max is around 256. Fetch sequentially to avoid rate-limiting (429 errors)
      let offset = 0;
      while (true) {
        if (seq !== currentGlobalFetchSeq) return;
        const resp = await apiCall(`/api/vrc/avatars/favorites?n=100&offset=${offset}&tag=${currentCategory}`);
        if (!resp.ok) break;
        const batch = await resp.json();
        if (!batch || batch.length === 0 || seq !== currentGlobalFetchSeq) break;
        allFetched = allFetched.concat(batch);
        // Progressive render per page (cold load only) so the first 100
        // favorites show immediately instead of waiting for all pages.
        if (!renderedFromCache && seq === fetchSeq) {
          const seenIds = new Set();
          avatars = allFetched.filter(av => { if (seenIds.has(av.id)) return false; seenIds.add(av.id); return true; });
          applyFilters();
        }
        if (batch.length < 100) break;
        offset += 100;
        if (offset >= 400) break; // Maximum safety ceiling for favorites
      }

      // Deduplicate by ID just in case
      const seen = new Set();
      allFetched = allFetched.filter(av => {
        if (seen.has(av.id)) return false;
        seen.add(av.id);
        return true;
      });
    }

    // If views changed while we waited, abandon stale render
    if (seq !== fetchSeq) return;
    avatars = allFetched;
    // renderGrid now does DOM reconciliation so calling applyFilters() won't flash.
    // This ensures remote additions/deletions immediately update the grid structure.
    applyFilters();
    
    // Save basics only
    const basics = allFetched.map(_avatarBasicFromItem).filter(Boolean);
    idb.set("avatar_basics_" + currentCategory, basics).catch(()=>{});
    idb.set("avatar_basics_age_" + currentCategory, Date.now()).catch(()=>{});
    logMsg(`<i class="fa-solid fa-check"></i> Sync complete: ${avatars.length} avatars`, "success");

    // Optimized: Disable background prefetch to save Cloudflare Worker requests
    // prefetchThumbnails(allFetched);

    try {
      await idb.set("avatars_" + currentCategory, allFetched);
    } catch (e) {}

    // If viewing a favorites category, also fetch the Favorite objects
    // so we have the favoriteId needed to unfavorite each avatar.
    if (currentCategory !== "mine") {
      try {
        const favPromises = [0, 100, 200, 300].map(offset =>
          apiCall(`/api/vrc/favorites?type=avatar&tag=${currentCategory}&n=100&offset=${offset}`)
            .then(r => (r.ok ? r.json() : []))
            .catch(() => [])
        );
        const favResults = await Promise.all(favPromises);
        // Build a fresh map for THIS category: collect IDs that belong here, then
        // remove their old entries (which may have been written when the user was
        // viewing a different fav group — VRChat issues a different favoriteId per
        // group per item, so the cached one may belong to another group).
        const catItemIds = new Set();
        favResults.forEach(favList => {
          if (favList && favList.length > 0 && !favList.error) {
            favList.forEach(fav => {
              catItemIds.add(fav.favoriteId);
              favoriteIdMap.set(fav.favoriteId, fav.id);
            });
          }
        });
        // Stash for unfavorite to reference. Used as a hint — if cleared/missing
        // we still fall through to the cached favoriteId.
        window._currentCategoryFavIds = catItemIds;
      } catch (e) {
        console.warn("Could not fetch favoriteIds", e);
      }
      // NOTE: previously this block patched a per-card `.btn-action.unfavorite`
      // button to mark unresolvable favoriteIds. That button no longer exists
      // (cards were unified — unfavorite now lives in the detail modal / the
      // card-fav-quick toggle), so the DOM-patching loop was removed as dead code.
    }

    // Stage 3: Streaming Refresh (metadata check)
    if (currentCategory !== 'mine' && currentCategory !== 'local') {
      const avIds = allFetched.map(a => a.id);
      const CONCURRENCY = 10;
      let cursor = 0;
      let dirty = false;
      let lastSaveAt = 0;
      const saveFreshBasics = () => {
        const now = Date.now();
        if (!dirty || now - lastSaveAt < 800) return;
        dirty = false;
        lastSaveAt = now;
        const freshBasics = avatars.map(_avatarBasicFromItem).filter(Boolean);
        idb.set("avatar_basics_" + currentCategory, freshBasics).catch(()=>{});
        idb.set("avatar_basics_age_" + currentCategory, Date.now()).catch(()=>{});
      };
      const worker = async () => {
        while (cursor < avIds.length) {
          if (seq !== fetchSeq || currentCategory === 'mine' || currentTab !== 'download') return;
          const id = avIds[cursor++];
          const fresh = await fetchOfficialAvatarData(id).catch(() => null);
          if (seq !== fetchSeq || currentCategory === 'mine' || currentTab !== 'download') return;
          if (fresh && fresh.id) {
            updateAvatarCardStream(fresh, { flash: false });
            dirty = true;
            saveFreshBasics();
          }
        }
      };
      const workers = Array.from({ length: Math.min(CONCURRENCY, avIds.length) }, () => worker());
      await Promise.allSettled(workers);
      if (seq === fetchSeq && currentTab === 'download' && dirty) {
        const freshBasics = avatars.map(_avatarBasicFromItem).filter(Boolean);
        idb.set("avatar_basics_" + currentCategory, freshBasics).catch(()=>{});
        idb.set("avatar_basics_age_" + currentCategory, Date.now()).catch(()=>{});
      }
      flushPendingAvatarCardUpdates();
    }

    // Also populate upload avatar select
    const selOptions = document.getElementById("avatarSelectOptions");
    if (selOptions) {
      selOptions.innerHTML = '<div class="glass-option" onclick="selectGlassOption(event, this, \'\')">-- Select --</div>';
      avatars.forEach((a) => {
        const opt = document.createElement("div");
        opt.className = "glass-option";
        opt.textContent = a.name;
        opt.onclick = (e) => selectGlassOption(e, opt, a.id);
        selOptions.appendChild(opt);
      });
    }
  } catch (e) {
    if (isAbortError(e)) return; // tab switch — not a real error
    logMsg("Error: " + e.message, "error");
  }
}

function applyFilters() {
  const q = document.getElementById("searchInput")?.value.toLowerCase().trim() || "";
  const state = document.getElementById("filterStatus")?.value || "all";
  const plat = document.getElementById("filterPlatform")?.value || "all";

  // When searching in any favorites category, search across ALL favorites groups
  const isFavoritesSearch = q && currentCategory !== "mine";
  if (isFavoritesSearch) {
    applyFiltersAcrossAllFavorites(q, state, plat);
    return;
  }

  _applyFiltersToList(avatars, q, state, plat);
}

// Search across all cached favorites groups combined
async function applyFiltersAcrossAllFavorites(q, state, plat) {
  const groups = favoriteGroups.map(g => g.name);
  if (groups.length === 0) {
    // Fallback: just filter current avatars
    _applyFiltersToList(avatars, q, state, plat);
    return;
  }

  // Load all favorites from IDB cache and combine
  let combined = [...avatars]; // Start with already-loaded current group
  const currentGroupSet = new Set(avatars.map(a => a.id));

  for (const g of groups) {
    if (g === currentCategory) continue; // Already included
    try {
      const cached = await idb.get("avatars_" + g);
      if (cached && cached.length > 0) {
        // Deduplicate by id
        cached.forEach(av => { if (!currentGroupSet.has(av.id)) { combined.push(av); currentGroupSet.add(av.id); } });
      }
    } catch (_) {}
  }

  _applyFiltersToList(combined, q, state, plat);
}

function _platformCheck(av) {
  // 根据性能评级来更精准地判断平台兼容性（如果某个平台没有评级或是 None，则认为不支持）
  const pkgs = av.unityPackages || [];
  const hasPC = pkgs.some(p => p.platform === "standalonewindows" && p.performanceRating && p.performanceRating !== "None");
  const hasQuest = pkgs.some(p => p.platform === "android" && p.performanceRating && p.performanceRating !== "None");
  const hasApple = pkgs.some(p => p.platform === "ios" && p.performanceRating && p.performanceRating !== "None");
  return { hasPC, hasQuest, hasApple };
}

function _applyFiltersToList(list, q, state, plat) {
  let filtered = list
    .map((av) => {
      let score = 0;

      // Match status
      if (state !== "all" && av.releaseStatus !== state) return null;

      // Match platform — inclusive: "PC Only" means has PC, "PC+Quest" means has both, etc.
      if (plat !== "all") {
        const { hasPC, hasQuest, hasApple } = _platformCheck(av);
        if (plat === "pc" && !hasPC) return null;
        if (plat === "pc-quest" && (!hasPC || !hasQuest)) return null;
        if (plat === "pc-quest-apple" && (!hasPC || !hasQuest || !hasApple)) return null;
      }

      // Match Query (Fuzzy Search & Relevance Scoring)
      if (q) {
        const name = (av.name || "").toLowerCase();
        const desc = (av.description || "").toLowerCase();
        const tags = (av.tags || []).join(" ").toLowerCase();

        if (name === q) score += 100;
        else if (name.includes(q)) score += 50;

        if (tags.includes(q)) score += 30;
        if (desc.includes(q)) score += 10;

        // Allow loose typos in name using simple check (e.g., if query letters appear in order)
        if (score === 0) {
          let qIdx = 0;
          for (let i = 0; i < name.length; i++) {
            if (name[i] === q[qIdx]) qIdx++;
            if (qIdx === q.length) break;
          }
          if (qIdx === q.length) score += 5; // Fuzzy match
        }

        if (score === 0) return null;
      } else {
        score = 1; // Base score
      }

      return { avatar: av, score };
    })
    .filter((x) => x !== null);

  // Sort by relevance (score descending), then by updated_at (newest first)
  filtered.sort((a, b) => {
    const isBad = (x) => x.avatar.isInvalid || x.avatar.releaseStatus === 'unavailable' || x.avatar.releaseStatus === 'hidden' || x.avatar.release_status === 'unavailable' || x.avatar.release_status === 'hidden';
    const aBad = isBad(a), bBad = isBad(b);
    if (aBad !== bBad) return aBad ? 1 : -1;

    if (b.score !== a.score) return b.score - a.score;
    return (
      new Date(b.avatar.updatedAt || b.avatar.updated_at || 0) -
      new Date(a.avatar.updatedAt || a.avatar.updated_at || 0)
    );
  });

  visibleAvatars = filtered.map((x) => x.avatar);
  renderGrid(visibleAvatars);
}

function _disposeAvatarCard(card) {
  if (!card) return;
  card.querySelectorAll(".avatar-thumb[data-src]").forEach((img) => {
    try { avatarObserver.unobserve(img); } catch (_) {}
    const idx = imageQueue.findIndex(it => it.img === img);
    if (idx !== -1) imageQueue.splice(idx, 1);
    if (img._abortCtrl) {
      try { img._abortCtrl.abort(); } catch (_) {}
    }
  });
}

function _buildAvatarCard(av) {
  let thumb = av.thumbnailImageUrl || av.imageUrl || "";
  thumb = proxyImg(thumb);

  const isOwner = currentUserId && av.authorId === currentUserId;
  const card = document.createElement("div");
  card.className = "avatar-card" + (selectedIds.has(av.id) ? " selected" : "");
  card.style.cursor = "pointer";

  const isLocalFaved = localAvatarIdMap.has(av.id);
  const isCloudFaved = favoriteIdMap.has(av.id);
  const isFaved = isLocalFaved || isCloudFaved;

  const isCached = loadedImageUrls.has(imageCacheKey(thumb));
  const imgHtml = isCached
      ? `<img class="avatar-thumb" src="${escHtml(thumb)}" alt="${escHtml(av.name || '')}">`
      : `<img class="avatar-thumb loading" src="${BLANK}" data-src="${escHtml(thumb)}" alt="">`;

  const releaseBadge = isOwner
    ? (av.releaseStatus === 'public'
        ? '<div class="card-release-badge release-public">Public</div>'
        : '<div class="card-release-badge release-private">Private</div>')
    : '';

  card.innerHTML = `<div class="avatar-thumb-wrapper ${isCached ? '' : 'img-loading'}">
    ${imgHtml}
    <div class="avatar-name-overlay">${escHtml(av.name || "失效模型 (Invalid / Deleted)")}</div>
    <div class="card-tl-overlay">
      <div class="card-checkbox ${selectedIds.has(av.id) ? 'on' : ''}" onclick="event.stopPropagation(); toggleSelect('${escJsAttr(av.id)}')" title="选中/取消选中">${selectedIds.has(av.id) ? '✓' : ''}</div>
    </div>
    <div class="card-tr-overlay">
      <div class="card-fav-quick" onclick="event.stopPropagation(); _avatarQuickFav('${escJsAttr(av.id)}','${escJsAttr(av.name || '')}',event,this)" title="${isFaved ? '已收藏' : '添加到收藏'}">${isFaved ? '<i class="fa-solid fa-star"></i> ' : '☆'}</div>
    </div>
    ${releaseBadge}
  </div>`;
  card.id = "card-" + av.id;
  card.dataset.avatarId = av.id;
  card.onclick = () => openLocalAvatarDetail(av.id);
  return card;
}

function _observeAvatarCardImages(card) {
  if (!card) return;
  card.querySelectorAll(".avatar-thumb[data-src]").forEach((img) => avatarObserver.observe(img));
}

function _replaceAvatarCard(av) {
  if (!av || !av.id) return;
  const grid = document.getElementById("avatarGrid");
  if (!grid) return;
  const oldCard = avatarCardElements.get(av.id) || document.getElementById("card-" + av.id);
  const matches = _avatarMatchesCurrentFilters(av);
  if (!matches) {
    if (oldCard) {
      _disposeAvatarCard(oldCard);
      oldCard.remove();
      avatarCardElements.delete(av.id);
      visibleAvatars = visibleAvatars.filter(x => x.id !== av.id);
      const totalEl = document.getElementById("statTotal");
      if (totalEl) totalEl.textContent = visibleAvatars.length;
    }
    return;
  }
  if (!visibleAvatars.some(x => x.id === av.id)) visibleAvatars.push(av);
  const nextCard = _buildAvatarCard(av);
  if (oldCard && oldCard.parentNode === grid) {
    _disposeAvatarCard(oldCard);
    grid.replaceChild(nextCard, oldCard);
  } else {
    grid.appendChild(nextCard);
  }
  avatarCardElements.set(av.id, nextCard);
  _observeAvatarCardImages(nextCard);
  const totalEl = document.getElementById("statTotal");
  if (totalEl) totalEl.textContent = visibleAvatars.length;
}

function updateAvatarCardStream(fresh, opts = {}) {
  const merged = _mergeAvatarIntoLists(fresh);
  if (!merged) return;
  if (!_isAvatarListRenderable()) {
    _queueAvatarCardUpdate(merged);
    return;
  }
  // Skip DOM replacement if the card already exists and no visible data changed.
  // Stage 3 fetches ~200 avatar details; most return identical data to what
  // the cache already shows. Replacing the DOM for those creates a jarring
  // visual flicker (card briefly goes blank + image reloads).
  const existingCard = avatarCardElements.get(merged.id);
  if (existingCard && existingCard.parentNode) {
    const nameEl = existingCard.querySelector('.avatar-name-overlay');
    const oldName = nameEl ? nameEl.textContent : '';
    const newName = merged.name || merged.avatarName || '';
    const badgeEl = existingCard.querySelector('.card-plat-badges, .avatar-badges-row');
    const oldBadgeText = badgeEl ? badgeEl.textContent.trim() : '';
    const { hasPC, hasQuest, hasApple } = _platformCheck(merged);
    const newBadgeText = [hasPC && 'PC', hasQuest && 'Quest', hasApple && 'Apple'].filter(Boolean).join('');
    // If name and platform badges haven't changed, skip the expensive DOM swap
    if (oldName === newName && oldBadgeText.replace(/\s+/g,'') === newBadgeText) return;
  }
  _replaceAvatarCard(merged);
  if (opts.flash !== false) {
    const card = avatarCardElements.get(merged.id);
    if (card) {
      card.classList.add('stream-updated');
      setTimeout(() => card.classList.remove('stream-updated'), 650);
    }
  }
}

function renderGrid(list) {
  const grid = document.getElementById("avatarGrid");
  if (!grid) return;

  const isFavoriteView = currentCategory !== "mine";

  // Toggle Action Buttons based on context
  document.getElementById("btnCleanFavs")?.classList.toggle("hidden", !isFavoriteView);
  document.getElementById("btnUnfavoriteSelected")?.classList.toggle("hidden", !isFavoriteView);
  document.getElementById("btnSelectAll")?.classList.remove("hidden"); // Always visible
  document.getElementById("saveDirGroup")?.classList.toggle("hidden", isFavoriteView);
  document.querySelector('button[onclick="downloadSelected()"]')?.classList.toggle("hidden", isFavoriteView);

  // Show empty state when no avatars
  if (list.length === 0) {
    grid.querySelectorAll(".avatar-thumb[data-src]").forEach((img) => avatarObserver.unobserve(img));
    imageQueue.length = 0; 
    grid.innerHTML = `<div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;height:300px;color:rgba(255,255,255,0.4);gap:12px;">
      <div style="font-size:3em;"><i class="fa-solid fa-masks-theater"></i> </div>
      <div style="font-size:1.1em;">暂无模型 / No avatars found</div>
      <div style="font-size:0.85em;">点击「刷新」按钮重新加载 / Click Refresh to reload</div>
    </div>`;
    avatarCardElements.clear();
    const statEl = document.getElementById("statTotal");
    if (statEl) statEl.textContent = 0;
    return;
  }

  // Fast path for cold boot: if grid is empty, just build normally (no diffing needed)
  if (avatarCardElements.size === 0) {
    grid.innerHTML = "";
    const frag = document.createDocumentFragment();
    list.forEach((av) => {
      const card = _buildAvatarCard(av);
      frag.appendChild(card);
      avatarCardElements.set(av.id, card);
    });
    grid.appendChild(frag);
    grid.querySelectorAll(".avatar-thumb[data-src]").forEach((img) => avatarObserver.observe(img));
    const statEl = document.getElementById("statTotal");
    if (statEl) statEl.textContent = list.length;
    return;
  }

  // Reconciliation: re-use DOM nodes so sorting/filtering doesn't flash
  const frag = document.createDocumentFragment();
  const keep = new Set(list.map(av => av.id));
  
  // Cleanup cards that are removed
  for (const [id, card] of avatarCardElements.entries()) {
    if (!keep.has(id)) {
      _disposeAvatarCard(card);
      avatarCardElements.delete(id);
    }
  }

  list.forEach((av) => {
    let card = avatarCardElements.get(av.id);
    if (!card) {
      card = _buildAvatarCard(av);
      avatarCardElements.set(av.id, card);
      _observeAvatarCardImages(card);
    }
    // Append moves the element if it's already in the DOM
    frag.appendChild(card);
  });

  // Since we appendChild on the frag, any card that was in `grid` but NOT in `list`
  // remains in `grid`. Then we just clear `grid` and append the ordered frag.
  grid.innerHTML = "";
  grid.appendChild(frag);

  const statEl = document.getElementById("statTotal");
  if (statEl) statEl.textContent = list.length;
}

// ── Unfavorite ──
async function unfavorite(avatarId, avatarName) {
  // Resolve favoriteId. If our cache has it, try that first. The cache may be
  // stale (favoriteId from a different group than the one being viewed), so on
  // 404/410 fall back to a live lookup against the current category.
  const resolveFavId = async () => {
    const cached = favoriteIdMap.get(avatarId);
    if (cached) return cached;
    // Live lookup: scan favorites for the current category and find this avatar.
    if (currentCategory !== 'mine' && currentCategory !== 'local') {
      try {
        const r = await apiCall(`/api/vrc/favorites?type=avatar&tag=${currentCategory}&n=100`);
        if (r.ok) {
          const list = await r.json();
          const hit = (list || []).find(f => f.favoriteId === avatarId);
          if (hit) {
            favoriteIdMap.set(avatarId, hit.id);
            return hit.id;
          }
        }
      } catch(_) {}
    }
    return null;
  };
  let favoriteId = await resolveFavId();
  if (!favoriteId) {
    logMsg(`⚠ Cannot unfavorite ${avatarName}: favoriteId not found`, "error");
    return;
  }
  if (!confirm(`⚠️ 即将移出收藏夹\n\n「${avatarName}」\n\n此操作不可撤销，确定继续吗？`)) return;
  try {
    logMsg(`Removing ${avatarName} from favorites...`, "info");
    let resp = await apiCall(`/api/vrc/favorites/${favoriteId}`, { method: "DELETE" });
    // Stale cached favoriteId? Try a live re-resolve once and retry.
    if (resp.status === 404 || resp.status === 410) {
      favoriteIdMap.delete(avatarId);
      const fresh = await resolveFavId();
      if (fresh && fresh !== favoriteId) {
        favoriteId = fresh;
        resp = await apiCall(`/api/vrc/favorites/${favoriteId}`, { method: "DELETE" });
      }
    }
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(err);
    }
    logMsg(`✓ Removed ${avatarName} from favorites`, "success");
    // Remove from local data
    favoriteIdMap.delete(avatarId);
    avatarFavTagMap.delete(avatarId);
    // Decrement group counter
    if (currentCategory && currentCategory !== 'mine' && currentCategory !== 'local') {
      const cur = avatarFavGroupCounts.get(currentCategory) || 0;
      avatarFavGroupCounts.set(currentCategory, Math.max(0, cur - 1));
    }
    avatars = avatars.filter((a) => a.id !== avatarId);
    visibleAvatars = visibleAvatars.filter((a) => a.id !== avatarId);
    selectedIds.delete(avatarId);
    // Update IDB cache to reflect removal
    try { await idb.set("avatars_" + currentCategory, avatars); } catch (_) {}
    try { await idb.set("avatar_basics_" + currentCategory, avatars.map(_avatarBasicFromItem).filter(Boolean)); } catch (_) {}
    try { await idb.set("avatar_basics_age_" + currentCategory, Date.now()); } catch (_) {}
    
    // Update Modal UI via the shared helper
    if (typeof _refreshDetailAfterFavChange === 'function') {
      _refreshDetailAfterFavChange(avatarId);
    }

    // Animate card removal
    const card = document.getElementById("card-" + avatarId);
    if (card) {
      card.style.transform = "scale(0.9)";
      card.style.opacity = "0";
      card.style.transition = "all 0.2s ease";
      setTimeout(() => card.remove(), 200);
    }
    document.getElementById("statTotal").textContent = visibleAvatars.length;
    document.getElementById("statSelected").textContent = selectedIds.size;
  } catch (e) {
    logMsg(`✗ Failed to unfavorite ${avatarName}: ${e.message}`, "error");
  }
}

// ── Batch Unfavorite Selected ──
async function unfavoriteSelected() {
  if (selectedIds.size === 0) {
    logMsg("未选择任何模型 (No avatars selected)", "error");
    return;
  }
  const count = selectedIds.size;
  if (!confirm(`确定要将选中的 ${count} 个模型移出收藏夹吗？\nRemove ${count} selected avatar(s) from favorites?`)) return;

  const ids = [...selectedIds];
  logMsg(`开始批量移除 ${count} 个收藏...`, "info");
  let successCount = 0, failCount = 0;

  for (const avatarId of ids) {
    const fid = favoriteIdMap.get(avatarId);
    if (!fid) {
      // No favorite-id mapping means we can't delete it on the server, but we
      // still drop it from the selection — otherwise the chip count below is
      // wrong and the next "select all" toggle keeps picking up zombies.
      selectedIds.delete(avatarId);
      failCount++;
      continue;
    }
    try {
      const resp = await apiCall(`/api/vrc/favorites/${fid}`, { method: "DELETE" });
      if (!resp.ok) throw new Error(await resp.text());
      favoriteIdMap.delete(avatarId);
      avatars = avatars.filter((a) => a.id !== avatarId);
      visibleAvatars = visibleAvatars.filter((a) => a.id !== avatarId);
      selectedIds.delete(avatarId);
      const card = document.getElementById("card-" + avatarId);
      if (card) {
        card.style.transform = "scale(0.9)";
        card.style.opacity = "0";
        card.style.transition = "all 0.15s ease";
        setTimeout(() => card.remove(), 150);
      }
      successCount++;
    } catch (e) {
      logMsg(`✗ 移除失败: ${e.message}`, "error");
      // Drop from the selection even on failure — leaving it selected makes the
      // next "selected count" UI lie and confuses the user about which row is
      // pending. The card still exists in `avatars` so they can retry manually.
      selectedIds.delete(avatarId);
      failCount++;
    }
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }

  // Update IDB cache
  try { await idb.set("avatars_" + currentCategory, avatars); } catch (_) {}
  try { await idb.set("avatar_basics_" + currentCategory, avatars.map(_avatarBasicFromItem).filter(Boolean)); } catch (_) {}
  try { await idb.set("avatar_basics_age_" + currentCategory, Date.now()); } catch (_) {}
  document.getElementById("statTotal").textContent = visibleAvatars.length;
  // Reflect the *real* remaining selection size — hard-coding 0 hid bugs where
  // the loop forgot to delete from the set.
  document.getElementById("statSelected").textContent = selectedIds.size;
  logMsg(`✓ 批量移除完成: 成功 ${successCount}, 失败 ${failCount}`, successCount > 0 ? "success" : "error");
}

// ── Shared Cleanup Modal ─────────────────────────────────────────────────────
// Used by both avatar and world cleanup functions.
// opts: { title, invalidItems[], privateNonOwnItems[], invalidLabel(item), onConfirm(items[]) }
function _showCleanupModal(opts) {
  document.getElementById('cleanupModal')?.remove();

  const { title, invalidItems, privateNonOwnItems, invalidLabel, onConfirm } = opts;
  const hasPrivate = privateNonOwnItems.length > 0;

  const modal = document.createElement('div');
  modal.id = 'cleanupModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);display:flex;align-items:center;justify-content:center;z-index:2000;padding:16px;';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:28px;max-width:500px;width:100%;max-height:82vh;overflow-y:auto;display:flex;flex-direction:column;gap:16px;box-shadow:0 24px 64px rgba(0,0,0,0.6);">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <h2 style="margin:0;font-size:1.2em;">${title}</h2>
        <button id="cuClose" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:1.5em;line-height:1;">\u00d7</button>
      </div>

      ${invalidItems.length > 0 ? `
        <div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:10px;padding:14px;">
          <div style="font-weight:700;color:#f87171;margin-bottom:8px;">\ud83d\udeab \u5931\u6548/\u9690\u85cf\u5185\u5bb9 <span style="font-weight:400;font-size:0.85em;opacity:0.8;">(\u5c06\u59cb\u7ec8\u79fb\u9664)</span></div>
          <div style="font-size:0.82em;color:var(--text-secondary);max-height:100px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;">
            ${invalidItems.slice(0,20).map(item=>`<span>\u2022 ${escHtml(invalidLabel(item))}</span>`).join('')}
            ${invalidItems.length>20?`<span style="opacity:0.6;">\u2026 \u8fd8\u6709 ${invalidItems.length-20} \u4e2a</span>`:''}
          </div>
        </div>
      ` : ''}

      ${hasPrivate ? `
        <div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.28);border-radius:10px;padding:14px;">
          <label style="display:flex;align-items:flex-start;gap:12px;cursor:pointer;">
            <input type="checkbox" id="cuIncPrivate" style="width:18px;height:18px;margin-top:2px;accent-color:var(--accent);flex-shrink:0;">
            <div>
              <div style="font-weight:700;color:#fbbf24;">\ud83d\udd12 \u4ed6\u4eba\u4e0a\u4f20\u7684\u79c1\u4eba\u5185\u5bb9
                <span style="font-size:0.8em;background:rgba(245,158,11,0.2);padding:1px 7px;border-radius:4px;margin-left:4px;">${privateNonOwnItems.length} \u4e2a</span>
              </div>
              <div style="font-size:0.8em;color:var(--text-muted);margin-top:4px;">\u8fd9\u4e9b\u5185\u5bb9\u72b6\u6001\u4e3a Private \u4e14\u4e0a\u4f20\u8005\u4e0d\u662f\u4f60\u7684\u8d26\u53f7\u3002\u52fe\u9009\u540e\u5c06\u4e00\u5e76\u4ece\u6536\u85cf\u5939\u79fb\u9664\u3002</div>
              <div style="font-size:0.78em;color:var(--text-secondary);max-height:80px;overflow-y:auto;margin-top:8px;display:flex;flex-direction:column;gap:3px;">
                ${privateNonOwnItems.slice(0,15).map(item=>`<span>\u2022 ${escHtml(invalidLabel(item))}</span>`).join('')}
                ${privateNonOwnItems.length>15?`<span style="opacity:0.6;">\u2026 \u8fd8\u6709 ${privateNonOwnItems.length-15} \u4e2a</span>`:''}
              </div>
            </div>
          </label>
        </div>
      ` : ''}

      <div style="font-size:0.8em;color:var(--text-muted);padding:10px 12px;background:rgba(255,255,255,0.03);border-radius:8px;border-left:3px solid var(--border);">
        \u26a0\ufe0f \u6b64\u64cd\u4f5c\u5c06\u8c03\u7528 API \u5f7b\u5e95\u53d6\u6d88\u6536\u85cf\uff0c\u65e0\u6cd5\u64a4\u9500\u3002
      </div>

      <div id="cuProgress" style="display:none;font-size:0.85em;color:var(--accent-light);text-align:center;padding:10px;background:rgba(255, 255, 255, 0.08);border-radius:8px;border:1px solid rgba(255, 255, 255, 0.2);">\u5904\u7406\u4e2d...</div>
      <div id="cuProgressBar" class="progress-bar-container" style="margin-bottom:0;">
        <div class="progress-bar-track">
          <div id="cuProgressFill" class="progress-bar-fill"></div>
        </div>
        <div id="cuProgressText" class="progress-text">0%</div>
      </div>

      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:4px;">
        <button id="cuCancel" class="btn btn-secondary" style="padding:8px 22px;">\u53d6\u6d88</button>
        <button id="cuConfirm" class="btn btn-primary" style="padding:8px 22px;background:linear-gradient(135deg,#ef4444,#dc2626);border-color:transparent;">\ud83d\uddd1\ufe0f \u786e\u8ba4\u6e05\u7406</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  // Stack above any open modal and lock background scroll (released in closeModal).
  // Set dataset.scrollLocked so the global Esc handler (core.js) routes through
  // our closeModal → unlockBodyScroll, instead of force-removing the modal and
  // leaking the scroll lock (BUG-4 class).
  modal.style.zIndex = modalZTop();
  if (!modal.dataset.scrollLocked) {
    lockBodyScroll();
    modal.dataset.scrollLocked = '1';
  }

  const state = { running: false, cancelled: false };
  const closeModal = () => {
    if (state.running) {
      state.cancelled = true;
      const cancelBtn = document.getElementById('cuCancel');
      if (cancelBtn) {
        cancelBtn.disabled = true;
        cancelBtn.textContent = '正在停止...';
      }
      const prog = document.getElementById('cuProgress');
      if (prog) prog.textContent = '正在停止，当前请求结束后会退出';
      return;
    }
    modal.remove();
    unlockBodyScroll();
  };
  document.getElementById('cuClose').onclick = closeModal;
  document.getElementById('cuCancel').onclick = closeModal;
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  document.getElementById('cuConfirm').onclick = async () => {
    const includePrivate = hasPrivate && document.getElementById('cuIncPrivate')?.checked;
    const toDelete = [...invalidItems, ...(includePrivate ? privateNonOwnItems : [])];
    if (!toDelete.length) { closeModal(); return; }

    state.running = true;
    document.getElementById('cuConfirm').disabled = true;
    document.getElementById('cuClose').disabled = true;
    const cancelBtn = document.getElementById('cuCancel');
    if (cancelBtn) cancelBtn.textContent = '停止';
    const prog = document.getElementById('cuProgress');
    const bar = document.getElementById('cuProgressBar');
    const fill = document.getElementById('cuProgressFill');
    const txt = document.getElementById('cuProgressText');
    prog.style.display = '';
    bar?.classList.add('active');
    prog.textContent = `\u5904\u7406\u4e2d 0 / ${toDelete.length}...`;
    if (fill) fill.style.width = '0%';
    if (txt) txt.textContent = '0%';

    const updateProgress = (done, total, label) => {
      const pct = total ? Math.round((done / total) * 100) : 0;
      if (fill) fill.style.width = pct + '%';
      if (txt) txt.textContent = pct + '%';
      prog.textContent = label || `\u5904\u7406\u4e2d ${done} / ${total}...`;
    };

    try {
      await onConfirm(toDelete, {
        isCancelled: () => state.cancelled,
        updateProgress
      });
    } finally {
      state.running = false;
      closeModal();
    }
  };
}

async function cleanInvalidFavorites() {
  if (currentCategory === 'mine') return;

  // Categorize avatars
  const invalid = avatars.filter(av =>
    !av.name || av.releaseStatus === 'hidden' || av.releaseStatus === 'unavailable'
  );
  const privateNonOwn = avatars.filter(av =>
    av.releaseStatus === 'private' && av.authorId && currentUserId && av.authorId !== currentUserId
  );

  if (!invalid.length && !privateNonOwn.length) {
    logMsg('<i class="fa-solid fa-check"></i> 当前收藏夹没有需要清理的内容', 'success');
    return;
  }

  // Show rich cleanup modal
  _showCleanupModal({
    title: '<i class="fa-solid fa-broom"></i> 清理收藏模型',
    invalidItems: invalid,
    privateNonOwnItems: privateNonOwn,
    invalidLabel: item => item.name || '失效/无名模型',
    onConfirm: async (toDelete, ctx) => {
      let success = 0, fail = 0, done = 0;
      for (const av of toDelete) {
        if (ctx?.isCancelled?.()) break;
        const fid = favoriteIdMap.get(av.id);
        if (!fid) {
          fail++;
          done++;
          ctx?.updateProgress?.(done, toDelete.length);
          continue;
        }
        try {
          await apiCall(`/api/vrc/favorites/${fid}`, { method: 'DELETE' });
          // Cleanup the per-avatar state so the sidebar group counter and the
          // <i class="fa-solid fa-star"></i> badge stay in sync without waiting for a full re-sync. The
          // grouping for this view is `currentCategory` (the favorite tag the
          // user is currently looking at).
          favoriteIdMap.delete(av.id);
          await removeAvatarFromFavoriteCache(currentCategory, av.id);
          if (currentCategory && currentCategory !== 'mine' && currentCategory !== 'local') {
            const cur = avatarFavGroupCounts.get(currentCategory) || 0;
            avatarFavGroupCounts.set(currentCategory, Math.max(0, cur - 1));
          }
          success++;
        } catch(e) { fail++; }
        done++;
        ctx?.updateProgress?.(done, toDelete.length);
        await new Promise(r => setTimeout(r, 200));
      }
      const cancelled = ctx?.isCancelled?.();
      logMsg(`${cancelled ? '⏹ 已停止清理' : '<i class="fa-solid fa-check"></i> 清理完毕'}：成功移除 ${success} 个，失败 ${fail} 个`, success > 0 ? 'success' : (cancelled ? 'info' : 'error'));
      try {
        await idb.set('avatar_basics_' + currentCategory, avatars.map(_avatarBasicFromItem).filter(Boolean));
        await idb.set('avatar_basics_age_' + currentCategory, Date.now());
      } catch(_) {}
      fetchAvatars(true);
    }
  });
}

// ── Open Local Avatar Detail Modal ──
async function openLocalAvatarDetail(id) {
  return openLocalDetail(id);
}

function renderAvatars() {
  applyFilters();
}

function toggleSelect(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  const card = document.getElementById("card-" + id);
  if (card) {
    const on = selectedIds.has(id);
    card.classList.toggle("selected", on);
    // Sync the in-card checkbox UI: ✓ when selected, blank when not
    const cb = card.querySelector('.card-checkbox');
    if (cb) {
      cb.classList.toggle('on', on);
      cb.textContent = on ? '✓' : '';
    }
  }
  document.getElementById("statSelected").textContent = selectedIds.size;
}

// Quick favorite from the unified card. Mirrors quickWorldFav in worlds.js:
//   - already faved (cloud or local): confirm + remove
//   - not faved: open the existing fav-group dropdown menu
// Per-card edit/delete are gone (moved to detail modal); fav stays because it
// flips with one click and is the most common card-level action.
function _avatarQuickFav(id, name, event, btn) {
  if (event) event.stopPropagation();
  const isLocalFaved = localAvatarIdMap.has(id);
  const isCloudFaved = favoriteIdMap.has(id);
  if (isCloudFaved) { unfavorite(id, name); return; }
  if (isLocalFaved) { removeFromLocalFavorite(id); return; }
  // Not yet faved → reuse the existing toggleAvatarFavGridMenu (search.js)
  // which builds the "save to local + per-group" dropdown anchored to btn.
  if (typeof toggleAvatarFavGridMenu === 'function') {
    toggleAvatarFavGridMenu(event, id, name, btn);
  }
}

function selectAll() {
  const allSelected = selectedIds.size > 0 && selectedIds.size === visibleAvatars.length;
  selectedIds.clear();
  if (!allSelected) visibleAvatars.forEach((a) => selectedIds.add(a.id));
  // Toggle CSS class + the in-card checkbox UI on existing cards — DO NOT
  // call renderAvatars() which would rebuild the DOM and lose scroll/observer.
  visibleAvatars.forEach((a) => {
    const card = document.getElementById("card-" + a.id);
    if (!card) return;
    const on = selectedIds.has(a.id);
    card.classList.toggle("selected", on);
    const cb = card.querySelector('.card-checkbox');
    if (cb) {
      cb.classList.toggle('on', on);
      cb.textContent = on ? '✓' : '';
    }
  });
  document.getElementById("statSelected").textContent = selectedIds.size;
}

// ── Edit & Delete Avatar ──
let currentEditId = null;

function editAvatar(id) {
  const av = avatars.find((a) => a.id === id);
  if (!av) return;
  currentEditId = id;
  document.getElementById("editName").value = av.name || "";
  document.getElementById("editDesc").value = av.description || "";
  // Sync the whole glass-select (hidden input + visible label + selected
  // highlight) to the avatar's actual releaseStatus. Setting only
  // #editStatus.value left the trigger label stuck on "Private" for models
  // that were actually public.
  const statusSelect = document.getElementById("editStatus").closest('.glass-select');
  setGlassSelectValue(statusSelect, av.releaseStatus || "private");
  document.getElementById("editTags").value = (av.tags || [])
    .filter((t) => !t.startsWith("author_tag"))
    .join(", ");

  // Show current thumbnail preview
  const thumb = av.thumbnailImageUrl || av.imageUrl || "";
  const preview = document.getElementById("editThumbPreview");
  const note = document.getElementById("editThumbNote");
  const input = document.getElementById("editThumbInput");
  if (preview) {
    preview.src = thumb ? proxyImg(thumb) : "";
  }
  if (note) note.textContent = "";
  if (input) input.value = ""; // Reset file picker

  const editModal = document.getElementById("editModal");
  editModal.style.zIndex = modalZTop();
  editModal.classList.remove("hidden");
  if (!editModal.dataset.scrollLocked) {
    lockBodyScroll();
    editModal.dataset.scrollLocked = '1';
  }
}

// Handle thumbnail file selection — show local preview
function onEditThumbSelected(input) {
  const file = input.files[0];
  if (!file) return;
  const preview = document.getElementById("editThumbPreview");
  const note = document.getElementById("editThumbNote");
  // Revoke previous blob URL if one existed
  if (preview && preview.src && preview.src.startsWith('blob:')) URL.revokeObjectURL(preview.src);
  if (preview) preview.src = URL.createObjectURL(file);
  if (note) note.textContent = `✓ ${file.name} (${(file.size / 1024).toFixed(0)} KB) — 保存时上传 / will upload on save`;
}

function closeEditModal() {
  const editModal = document.getElementById("editModal");
  editModal.classList.add("hidden");
  if (editModal.dataset.scrollLocked) {
    unlockBodyScroll();
    delete editModal.dataset.scrollLocked;
  }
  currentEditId = null;
}

async function saveEditAvatar() {
  if (!currentEditId) return;
  const name = document.getElementById("editName").value.trim();
  if (!name) return alert("Name is required");
  const desc = document.getElementById("editDesc").value.trim();
  const status = document.getElementById("editStatus").value;
  const tagsStr = document.getElementById("editTags").value;
  const tags = tagsStr
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t);

  const btn = document.getElementById("btnSaveEdit");
  const oldText = btn.textContent;
  const oldWidth = btn.offsetWidth;
  if (oldWidth) btn.style.width = oldWidth + 'px'; // prevent jitter
  btn.innerHTML = `<div class="btn-spinner" style="margin-right:6px;"></div>`;
  btn.disabled = true;

  try {
    // Upload new thumbnail if selected
    let newImageUrl = null;
    const thumbInput = document.getElementById("editThumbInput");
    if (thumbInput && thumbInput.files.length > 0) {
      btn.innerHTML = `<div class="btn-spinner" style="margin-right:6px;"></div> 图片上传中...`;
      logMsg(`🖼️ Uploading new thumbnail for ${name}...`, "info");
      newImageUrl = await uploadImageToVRChat(thumbInput.files[0], name);
    }

    btn.innerHTML = `<div class="btn-spinner" style="margin-right:6px;"></div> 保存中...`;
    logMsg(`✏️ Updating ${name}...`, "info");
    const payload = {
      name,
      description: desc,
      releaseStatus: status,
      tags,
    };
    if (newImageUrl) payload.imageUrl = newImageUrl;

    const resp = await apiCall(`/api/vrc/avatars/${currentEditId}`, {
      method: "PUT",
      json: payload,
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(err);
    }

    // Update local object
    const updatedAv = await resp.json();
    const idx = avatars.findIndex((a) => a.id === currentEditId);
    if (idx !== -1) avatars[idx] = updatedAv;

    // Update IDB cache
    try { await idb.set("avatars_" + currentCategory, avatars); } catch (_) {}

    // Update the card's name overlay + thumbnail in-place (no full re-render)
    const card = document.getElementById("card-" + currentEditId);
    if (card) {
      const nameOverlay = card.querySelector(".avatar-name-overlay");
      if (nameOverlay) nameOverlay.textContent = updatedAv.name || "";
      if (newImageUrl) {
        const img = card.querySelector(".avatar-thumb");
        if (img) {
          const proxyUrl = proxyImg(newImageUrl);
          img.classList.remove("failed");
          img.src = proxyUrl;
          loadedImageUrls.add(proxyUrl);
        }
      }
    }
    closeEditModal();
    // Re-apply filters after edit. The user may have flipped releaseStatus
    // (public→private etc.); without this the card stays visible in a filtered
    // view ("Public only") even though it no longer matches the predicate.
    if (typeof applyFilters === 'function') applyFilters();
    logMsg(`✓ ${t("editSuccess")} ${name}`, "success");
    showToast(`✓ ${t("editSuccess")} ${name}`, 'success');
  } catch (e) {
    logMsg(`✗ ${t("editFail")} ${name} - ${e.message}`, "error");
    showToast(`${t("editFail")}: ${e.message}`, 'error');
  } finally {
    btn.textContent = oldText;
    btn.disabled = false;
    btn.style.width = '';
  }
}

async function deleteAvatar(id, name) {
  if (!confirm(t("confirmDelete") + name)) return;
  try {
    logMsg(`🗑️ Deleting ${name}...`, "info");
    const resp = await apiCall(`/api/vrc/avatars/${id}`, { method: "DELETE" });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(err);
    }
    logMsg(`✓ ${t("deleted")} ${name}`, "success");

    // Remove from all local arrays and selection
    avatars = avatars.filter((a) => a.id !== id);
    visibleAvatars = visibleAvatars.filter((a) => a.id !== id);
    selectedIds.delete(id);

    // Update IDB cache
    try { await idb.set("avatars_" + currentCategory, avatars); } catch (_) {}

    // Remove from DOM with animation
    const card = document.getElementById("card-" + id);
    if (card) {
      card.style.transform = "scale(0.9)";
      card.style.opacity = "0";
      setTimeout(() => card.remove(), 200);
    }

    // Update stats to reflect filtered count
    document.getElementById("statTotal").textContent = visibleAvatars.length;
    document.getElementById("statSelected").textContent = selectedIds.size;
  } catch (e) {
    logMsg(`✗ ${t("deleteFail")} ${name} - ${e.message}`, "error");
  }
}

// ── Save Location Picker ──
async function pickSaveDir() {
  if (!("showDirectoryPicker" in window)) {
    logMsg(t("dirNotSupported"), "error");
    return;
  }
  try {
    saveDirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    const dirLabel = document.getElementById("saveDirLabel");
    if (dirLabel) {
      dirLabel.textContent = t("dirSelected") + saveDirHandle.name;
      dirLabel.style.display = "block";
    }
    const clearBtn = document.getElementById("clearDirBtn");
    if (clearBtn) clearBtn.style.display = "block";
    logMsg(t("dirSelected") + saveDirHandle.name, "success");
  } catch (e) {
    if (e.name !== "AbortError") logMsg("Error: " + e.message, "error");
  }
}

function clearSaveDir() {
  saveDirHandle = null;
  const dirLabel = document.getElementById("saveDirLabel");
  if (dirLabel) {
    dirLabel.textContent = "";
    dirLabel.style.display = "none";
  }
  const clearBtn = document.getElementById("clearDirBtn");
  if (clearBtn) clearBtn.style.display = "none";
  logMsg(t("dirCleared"), "info");
}

// ── Download ──
async function downloadSelected() {
  if (selectedIds.size === 0) {
    logMsg("No avatars selected", "error");
    return;
  }
  // Use visibleAvatars so we download what's actually selected in the current filtered view
  const toDownload = visibleAvatars.filter((a) => selectedIds.has(a.id));

  // Verify directory permission is still valid
  if (saveDirHandle) {
    try {
      const perm = await saveDirHandle.queryPermission({ mode: "readwrite" });
      if (perm !== "granted") {
        const req = await saveDirHandle.requestPermission({
          mode: "readwrite",
        });
        if (req !== "granted") {
          saveDirHandle = null;
          logMsg("Directory permission denied, using browser default", "info");
        }
      }
    } catch {
      saveDirHandle = null;
    }
  }

  // Start concurrent download queue
  const CONCURRENT_DOWNLOADS = 4;
  let queue = [...toDownload];
  let activeCount = 0;

  logMsg(
    `Started downloading ${toDownload.length} avatars (${CONCURRENT_DOWNLOADS} concurrent)...`,
    "info",
  );

  return new Promise((resolve) => {
    function next() {
      if (queue.length === 0 && activeCount === 0) {
        logMsg("All downloads finished.", "success");
        resolve();
        return;
      }
      while (activeCount < CONCURRENT_DOWNLOADS && queue.length > 0) {
        const av = queue.shift();
        activeCount++;
        downloadSingleAvatar(av).finally(() => {
          activeCount--;
          next();
        });
      }
    }
    next();
  });
}

async function downloadSingleAvatar(av) {
  const card = document.getElementById("card-" + av.id);
  if (card) card.classList.add("downloading");

  // ALWAYS fetch fresh details right before downloading.
  // The VRChat API often omits 'assetUrl' in list endpoints (like /avatars?user=me).
  try {
    const fresh = await fetchOfficialAvatarData(av.id);
    if (fresh && fresh.id) {
      av = fresh;
      if (typeof updateAvatarCardStream === 'function') {
        updateAvatarCardStream(fresh, { flash: false });
      }
    }
  } catch (e) {
    console.warn(`[Download] Failed to fetch fresh data for ${av.id}, using cached version:`, e);
  }

  // Collect all candidate URLs (prefer no-variant first, then security, skip impostor)
  const candidateUrls = [];
  const fallbackUrls = [];
  for (const pkg of av.unityPackages || []) {
    if (!pkg.assetUrl) continue;
    if (pkg.variant && pkg.variant.includes("impostor")) continue;
    
    const plat = (pkg.platform || "").toLowerCase();
    if (plat === "standalonewindows" || plat === "pc") {
      if (!pkg.variant || pkg.variant === "") {
        candidateUrls.unshift(pkg.assetUrl); // top priority
      } else {
        candidateUrls.push(pkg.assetUrl);
      }
    } else {
      if (!pkg.variant || pkg.variant === "") {
        fallbackUrls.unshift(pkg.assetUrl);
      } else {
        fallbackUrls.push(pkg.assetUrl);
      }
    }
  }

  // Fallback 1: try root assetUrl (older API format)
  if (candidateUrls.length === 0 && av.assetUrl) {
    candidateUrls.push(av.assetUrl);
  }

  // Fallback 2: try non-PC packages (e.g. Android/Quest)
  if (candidateUrls.length === 0 && fallbackUrls.length > 0) {
    candidateUrls.push(...fallbackUrls);
  }

  if (candidateUrls.length === 0) {
    logMsg(`⚠ ${av.name}: No valid asset URL found`, "skip");
    if (card) {
      card.classList.remove("downloading");
      card.classList.add("skipped");
    }
    return;
  }

  const safeName = av.name.replace(/[\\/*?:"<>|]/g, "_");
  const filename = `${safeName}_${av.id}.vrca`;

  try {
    logMsg(`⬇ ${t("downloading")} ${av.name}...`, "info");

    if (saveDirHandle) {
      // Check if file already exists → skip
      try {
        await saveDirHandle.getFileHandle(filename, { create: false });
        logMsg(`⏭ ${av.name}: Already exists, skipped`, "skip");
        if (card) {
          card.classList.remove("downloading");
          card.classList.add("success");
        }
        return;
      } catch {
        /* file doesn't exist, proceed with download */
      }

      // ── File System Access API: try each candidate URL ──
      let downloaded = false;
      for (let urlIdx = 0; urlIdx < candidateUrls.length; urlIdx++) {
        const proxyUrl = `${API_BASE}/api/download?url=${encodeURIComponent(candidateUrls[urlIdx])}&filename=${encodeURIComponent(filename)}&auth=${encodeURIComponent(vrcAuth)}`;
        try {
          const resp = await fetch(proxyUrl);
          if (!resp.ok) {
            const errText = await resp
              .text()
              .catch(() => `HTTP ${resp.status}`);
            if (urlIdx < candidateUrls.length - 1) {
              logMsg(
                `  ↳ URL ${urlIdx + 1}/${candidateUrls.length} failed (${resp.status}), trying next...`,
                "info",
              );
              continue;
            }
            throw new Error(
              `Server error ${resp.status}: ${errText.substring(0, 200)}`,
            );
          }
          const ct = resp.headers.get("Content-Type") || "";
          if (ct.includes("text/html") || ct.includes("application/json")) {
            const body = await resp.text();
            if (urlIdx < candidateUrls.length - 1) {
              logMsg(
                `  ↳ URL ${urlIdx + 1}/${candidateUrls.length} returned error page, trying next...`,
                "info",
              );
              continue;
            }
            throw new Error(
              "Got error page instead of file: " + body.substring(0, 200),
            );
          }
          const blob = await resp.blob();
          if (blob.size < 10240) {
            if (urlIdx < candidateUrls.length - 1) {
              logMsg(
                `  ↳ URL ${urlIdx + 1}/${candidateUrls.length} too small (${blob.size}B), trying next...`,
                "info",
              );
              continue;
            }
            throw new Error(
              `File too small (${blob.size} bytes), likely an error response`,
            );
          }
          const fileHandle = await saveDirHandle.getFileHandle(filename, {
            create: true,
          });
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
          logMsg(
            `✓ ${av.name}: Saved → ${saveDirHandle.name}/${filename} (${(blob.size / 1048576).toFixed(1)} MB)`,
            "success",
          );
          downloaded = true;
          if (card) {
            card.classList.remove("downloading");
            card.classList.add("success");
          }
          break;
        } catch (e) {
          if (urlIdx < candidateUrls.length - 1) {
            logMsg(
              `  ↳ URL ${urlIdx + 1}/${candidateUrls.length} failed: ${e.message}, trying next...`,
              "info",
            );
            continue;
          }
          throw e;
        }
      }
      if (!downloaded) throw new Error("All candidate URLs failed");
    } else {
      // ── Fallback: browser native <a> download (uses first URL) ──
      const proxyUrl = `${API_BASE}/api/download?url=${encodeURIComponent(candidateUrls[0])}&filename=${encodeURIComponent(filename)}&auth=${encodeURIComponent(vrcAuth)}`;
      const a = document.createElement("a");
      a.href = proxyUrl;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      logMsg(`✓ ${av.name}: Download started → ${filename}`, "success");
      if (card) {
        card.classList.remove("downloading");
        card.classList.add("success");
      }
    }
  } catch (e) {
    logMsg(`✗ ${av.name}: ${e.message}`, "error");
    if (card) {
      card.classList.remove("downloading");
      card.classList.add("skipped");
    }
  }
}


// ── Upload Mode Toggle ──

VRCW.registerModule('avatars', { switchCategory, updateSelectedCount, fetchAvatars, applyFilters, renderGrid, unfavorite, unfavoriteSelected, cleanInvalidFavorites, openLocalAvatarDetail, renderAvatars, toggleSelect, selectAll, editAvatar, onEditThumbSelected, closeEditModal, saveEditAvatar, deleteAvatar, pickSaveDir, clearSaveDir, downloadSelected, downloadSingleAvatar });
renderAppVersionInfo();

/*
 * VRCW - groups-shell.js
 * Small always-loaded helpers for global nav and groups. Heavy assets/economy
 * code stays in assets-groups.js and is loaded only when the assets tab opens.
 */

// ── Groups list cache ─────────────────────────────────────────────────────
// The groups tab used to fire 2 serial API calls (/auth/user then /users/{id}/groups)
// on EVERY open with no cache and no "already loaded" guard — friends/worlds/
// avatars tabs all have IDB caches + TTL + *Loaded guards, groups did not, which
// is why it felt noticeably slower to open. Below mirrors that pattern: IDB-first
// render, background refresh, 5-min TTL, one-shot groupsLoaded guard.
let groupsLoaded = false;
let _groupsListCache = [];          // raw /users/{id}/groups response
const GROUPS_CACHE_TTL = 5 * 60 * 1000; // 5 min — matches avatars/worlds

function toggleGlobalNav() {
  const nav = document.getElementById("globalNav");
  const navCol = document.getElementById("globalNavCollapsed");
  if (!nav || !navCol) return;
  const isOpen = !nav.classList.contains("hidden");
  nav.classList.toggle("hidden", isOpen);
  navCol.classList.toggle("hidden", !isOpen);
  try { localStorage.setItem("navCollapsed", isOpen ? "1" : "0"); } catch (_) {}
}

document.addEventListener("DOMContentLoaded", () => {
  try {
    if (localStorage.getItem("navCollapsed") === "1") {
      document.getElementById("globalNav")?.classList.add("hidden");
      document.getElementById("globalNavCollapsed")?.classList.remove("hidden");
    }
  } catch (_) {}
});

function _loadAssetsModule() {
  if (VRCW.modules.assets) return Promise.resolve(VRCW.modules.assets);
  return loadScriptOnce('js/media-profile.js?v=' + APP_CACHE_VERSION)
    .then(() => loadScriptOnce('js/assets-groups.js?v=' + APP_CACHE_VERSION))
    .then(() => {
      if (!VRCW.modules.assets) throw new Error('Assets module did not register');
      return VRCW.modules.assets;
    });
}

function switchAssetsPage(page) {
  return _loadAssetsModule().then(module => module.switchAssetsPage(page)).catch(err => {
    console.error(err);
    showToast(t('toast.assetsModuleLoadFail', {msg: err.message}), 'error');
  });
}

function extractFileVersionUrl(f) {
  if (!f || !f.versions || !f.versions.length) return '';
  for (let i = f.versions.length - 1; i >= 0; i--) {
    const v = f.versions[i];
    if (v.status === 'complete' && v.file && v.file.url) return v.file.url;
  }
  for (let i = f.versions.length - 1; i >= 0; i--) {
    const v = f.versions[i];
    if (v.file && v.file.url) return v.file.url;
  }
  return '';
}

function switchGroupsCategory(cat) {
  document.querySelectorAll('#groupsPanel .cat-btn').forEach(b => {
    b.classList.remove('active', 'btn-primary');
    b.classList.add('btn-secondary');
  });
  const btn = document.getElementById('gpCat' + cat.charAt(0).toUpperCase() + cat.slice(1));
  if (btn) { btn.classList.remove('btn-secondary'); btn.classList.add('active', 'btn-primary'); }
  loadGroupsPage(cat);
}

async function loadGroupsPage(cat) {
  const area = document.getElementById('groupsContentArea');
  if (!area) return;

  // Search sub-view has no cache — it's driven by user input.
  if (cat === 'search') {
    area.innerHTML = t('group.searchTitle') +
      '<div style="display:flex;gap:8px;margin-bottom:16px;">' +
        '<input type="text" id="groupSearchInput" class="input-field" placeholder="' + escHtml(t('group.searchPlaceholder')) + '" style="flex:1;">' +
        '<button class="btn btn-primary" onclick="searchGroups()">' + escHtml(t('group.searchBtn')) + '</button>' +
      '</div>' +
      '<div id="groupSearchResults"></div>';
    return;
  }

  // ── Cache-first render ────────────────────────────────────────────────
  // Draw from IDB immediately (if present) so the user sees their groups
  // instantly, then silently refresh from the API in the background. The
  // old code blocked on 2 serial API calls every open → slow.
  let cacheAge = 0;
  let cacheIsFresh = false;
  try {
    const cached = await idb.get('groups_basics');
    if (Array.isArray(cached) && cached.length >= 0) {
      _groupsListCache = cached;
      cacheAge = (await idb.get('groups_basics_age')) || 0;
      cacheIsFresh = cacheAge > 0 && (Date.now() - cacheAge) < GROUPS_CACHE_TTL;
      if (cached.length > 0) {
        renderGroupsList(area, cat, cached);
      }
    }
  } catch (_) {}

  if (cacheIsFresh && _groupsListCache.length > 0) {
    // Cache fresh enough — skip the API entirely (like avatars/worlds do).
    return;
  }

  // ── Background refresh ────────────────────────────────────────────────
  // Only show the spinner when there's nothing cached to show yet.
  if (_groupsListCache.length === 0) {
    area.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">' + escHtml(t('loading')) + '</div>';
  }

  try {
    // Reuse the global currentUserId instead of round-tripping /auth/user.
    // It's set during showMainApp() and stays valid for the session.
    let myId = (typeof currentUserId !== 'undefined' && currentUserId) || '';
    if (!myId) {
      const me = await (await apiCall('/api/vrc/auth/user')).json();
      myId = me.id || '';
    }
    if (!myId) throw new Error(t('toast.uidMissing'));

    const r = await apiCall('/api/vrc/users/' + myId + '/groups');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const groups = await r.json();

    _groupsListCache = Array.isArray(groups) ? groups : [];
    // Persist to IDB for next session's instant render.
    try {
      await idb.set('groups_basics', _groupsListCache);
      await idb.set('groups_basics_age', Date.now());
    } catch (_) {}

    renderGroupsList(area, cat, _groupsListCache);
  } catch (e) {
    if (isAbortError(e)) return;
    // Keep cached content visible on transient failure (mirrors friends.js).
    if (_groupsListCache.length === 0) {
      area.innerHTML = '<div style="color:var(--error);padding:20px;">' + escHtml(t('toast.loadFailMsg', {msg: e.message})) + '</div>';
    }
  }
}

// Render the filtered groups grid for a category. Extracted so both the
// cache-first render and the background refresh share identical markup.
function renderGroupsList(area, cat, groups) {
  let filtered = groups || [];
  let title = '';
  if (cat === 'mine') {
    filtered = filtered.filter(g => g.ownerId === currentUserId || g.userId === currentUserId);
    title = t('group.mineCount', {count: filtered.length});
  } else {
    filtered = filtered.filter(g => g.ownerId !== currentUserId && g.userId !== currentUserId);
    title = t('group.joinedCount', {count: filtered.length});
  }

  if (!filtered.length) {
    area.innerHTML = '<h2 style="font-size:1.2rem;margin-bottom:12px;">' + title + '</h2><div style="color:var(--text-muted);">' + escHtml(t('group.noGroups')) + '</div>';
    return;
  }

  area.innerHTML = '<h2 style="font-size:1.2rem;margin-bottom:16px;">' + title + '</h2>';
  area.innerHTML += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;">' +
    filtered.map(g => {
      const icon = proxyImg(g.iconUrl || g.bannerUrl || '');
      return '<div onclick="openGroupDetail(\'' + escJsAttr(g.groupId || g.id) + '\')" style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg-glass);border:1px solid var(--border);border-radius:10px;cursor:pointer;">' +
        '<img src="' + escHtml(icon) + '" style="width:44px;height:44px;border-radius:8px;object-fit:cover;flex-shrink:0;" onerror="this.style.display=\'none\'">' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-weight:600;font-size:0.9em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(g.name || '') + '</div>' +
          '<div style="font-size:0.75em;color:var(--text-muted);">.' + escHtml(g.shortCode || '') + ' · <i class="fa-solid fa-user-group"></i> ' + (g.memberCount || 0) + '</div>' +
        '</div>' +
      '</div>';
    }).join('') +
  '</div>';
}

// Invalidate the cache after a join/leave so the next open re-fetches.
// Called from groups-instance.js vrcGroupAction().
function invalidateGroupsCache() {
  _groupsListCache = [];
  groupsLoaded = false;
  try { idb.set('groups_basics_age', 0); } catch (_) {}
}

async function searchGroups() {
  const input = document.getElementById('groupSearchInput');
  const results = document.getElementById('groupSearchResults');
  if (!input || !results) return;
  const q = input.value.trim();
  if (!q) return;
  results.innerHTML = '<div style="color:var(--text-muted);">' + escHtml(t('group.searching')) + '</div>';
  try {
    const r = await apiCall('/api/vrc/groups?query=' + encodeURIComponent(q) + '&n=20');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const groups = await r.json();
    if (!groups || !groups.length) {
      results.innerHTML = '<div style="color:var(--text-muted);">' + escHtml(t('group.noResults')) + '</div>';
      return;
    }
    results.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;">' +
      groups.map(g => {
        const icon = proxyImg(g.iconUrl || g.bannerUrl || '');
        return '<div onclick="openGroupDetail(\'' + escJsAttr(g.id || '') + '\')" style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg-glass);border:1px solid var(--border);border-radius:10px;cursor:pointer;">' +
          '<img src="' + escHtml(icon) + '" style="width:44px;height:44px;border-radius:8px;object-fit:cover;flex-shrink:0;" onerror="this.style.display=\'none\'">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-weight:600;font-size:0.9em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(g.name || '') + '</div>' +
            '<div style="font-size:0.75em;color:var(--text-muted);">.' + escHtml(g.shortCode || '') + ' · <i class="fa-solid fa-user-group"></i> ' + (g.memberCount || 0) + '</div>' +
          '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  } catch (e) {
    results.innerHTML = '<div style="color:var(--error);">' + escHtml(t('group.searchFail', {msg: e.message})) + '</div>';
  }
}

VRCW.registerModule('groupsShell', {
  toggleGlobalNav,
  switchAssetsPage,
  extractFileVersionUrl,
  switchGroupsCategory,
  loadGroupsPage,
  searchGroups,
});
renderAppVersionInfo();

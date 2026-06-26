/*
 * VRCW — friends.js
 * 好友标签/资料/通知/筛选/好友列表渲染
 *
 * 注意：本项目为「经典脚本」(非 ES module)，全部按顺序加载、共享全局作用域。
 * 函数声明会提升为全局，跨文件调用没问题；请勿改为 type="module"。
 */
// ═══════════════════════════════════════════════════════════════
// ── FRIENDS TAB ──
// ═══════════════════════════════════════════════════════════════

let allFriends       = [];
let currentFriendCategory = 'myprofile';
let friendsLoaded    = false;
let currentFriendProfile = null;
let myProfileData    = null;

async function initFriendsTab() {
  friendsLoaded = true;
  fetchMyModerations();
  switchFriendCategory('myprofile');
}

// Helper: make a sidebar button with cat-btn + btn-secondary styling identical to Models tab

function makeCatBtn(text, onclick, id) {
  return `<button class="btn btn-secondary btn-block cat-btn" onclick="${escHtml(onclick)}" id="${escHtml(id)}">${text}</button>`;
}

function switchFriendCategory(cat) {
  currentFriendCategory = cat;
  runPriorityTask(async () => {
    document.querySelectorAll('#friendsPanel .cat-btn, #friendsPanel .category-btn').forEach(b => {
    b.classList.remove('active','btn-primary');
    b.classList.add('btn-secondary');
  });
  const btnId = cat.startsWith('fav_')
    ? `friendCatFav_${cat.slice(4)}`
    : `friendCat${cat.charAt(0).toUpperCase()+cat.slice(1)}`;
  const btn = document.getElementById(btnId);
  if (btn) { btn.classList.remove('btn-secondary'); btn.classList.add('active','btn-primary'); }

  const myView   = document.getElementById('friendMyProfileView');
  const listView = document.getElementById('friendListView');
  const logView  = document.getElementById('friendModlogView');
  const notifyView = document.getElementById('friendNotificationsView');
  if (myView)   myView.style.display = 'none';
  if (listView) listView.style.display = 'none';
  if (logView)  logView.style.display = 'none';
  if (notifyView) notifyView.style.display = 'none';

  if (cat === 'myprofile') {
    if (myView) myView.style.display = 'block';
    await fetchMyProfile();
  } else if (cat === 'modlog') {
    if (logView) logView.style.display = 'flex';
    await renderModerationLog();
  } else if (cat === 'notifications') {
    if (notifyView) notifyView.style.display = 'flex';
    await fetchNotifications();
    } else {
      if (listView) listView.style.display = 'flex';
      await fetchCurrentFriendCategory();
    }
  });
}

async function fetchMyProfile(forceRefresh = false) {
  // Show the inline view (not modal) in the right panel
  const myView = document.getElementById('friendMyProfileView');
  const listView = document.getElementById('friendListView');
  if (myView && (!myProfileData || forceRefresh)) { myView.style.display = ''; myView.innerHTML = '<div style="text-align:center;padding:60px;color:rgba(255,255,255,0.3);">加载中...</div>'; }
  if (listView) listView.style.display = 'none';
  // Highlight the nav entry
  document.querySelectorAll('#friendsPanel .cat-btn').forEach(b => b.classList.remove('active','btn-primary'));
  const catBtn = document.getElementById('friendCatMyprofile');
  if (catBtn) { catBtn.classList.add('active','btn-primary'); catBtn.style.display = ''; }
  try {
    // Stale-while-revalidate:
    // 1. Render cached data immediately (name, avatar, bio — stable fields)
    const cached = await idb.get('my_profile');
    if (cached && !forceRefresh) {
      myProfileData = cached;
      renderMyProfile(cached);
      renderSidebarMiniProfile(cached);
    }

    // 2. Always fetch fresh from API (gets latest status etc.)
    const resp = await apiCall('/api/vrc/auth/user', { cache: 'no-store' });
    if (!resp.ok) throw new Error('Failed to fetch profile');
    const fresh = await resp.json();
    myProfileData = fresh;

    // 3. auth/user may not return location — fetch it from users/{id}
    //    which always includes the current in-game location
    if (fresh.id) {
      apiCall('/api/vrc/users/' + fresh.id).then(r => r.ok ? r.json() : null).then(full => {
        if (!full) return;
        myProfileData.location = full.location || myProfileData.location;
        myProfileData.state    = full.state    || myProfileData.state;
        // Update the location row without a full re-render
        const locRow = document.getElementById('myProfileLocRow');
        const locEl  = document.getElementById('myProfileLocText');
        const loc = myProfileData.location;
        if (locRow && locEl) {
          if (loc && loc !== 'offline' && loc !== 'private') {
            locRow.style.display = '';
            getLocationDisplay(loc).then(txt => {
              locEl.innerHTML = `<a href="#" onclick="openInstanceDetail('${escJsAttr(loc)}'); event.preventDefault();" style="color:var(--accent-light);text-decoration:none;">${txt}</a> <button onclick="inviteSelf('${escJsAttr(loc)}')" class="btn btn-xs" style="background:rgba(134,239,172,0.1);color:#4ade80;border:1px solid rgba(134,239,172,0.2);padding:2px 8px;border-radius:4px;font-size:0.75em;cursor:pointer;vertical-align:middle;"><i class="fa-solid fa-envelope"></i> 邀请自己</button>`;
            }).catch(() => { locEl.textContent = loc; });
          } else if (loc === 'private') {
            locRow.style.display = '';
            locEl.innerHTML = '<i class="fa-solid fa-lock"></i> 私人房间';
          } else {
            locRow.style.display = 'none';
          }
        }
      }).catch(() => {});
    }

    await idb.set('my_profile', fresh); // update cache
    const u = fresh;
    // Render profile INLINE into the right panel area
    renderMyProfile(u);
    // Update the sidebar mini-profile card
    renderSidebarMiniProfile(u);
    fetchMyModerations();
  } catch(e) {
    if (isAbortError(e)) return;
    // Network blip / 522 / etc.: if we already rendered cached profile content,
    // KEEP it visible — don't replace the populated panel with a red error
    // message. Only show the error state when there's nothing cached to fall
    // back to.
    if (myProfileData) {
      console.warn('fetchMyProfile refresh failed (keeping cached):', e.message);
      try { friendLogMsg(`⚠ 资料刷新失败 (使用缓存): ${e.message}`, 'error'); } catch(_) {}
      return;
    }
    if (myView) myView.innerHTML = `<div style="text-align:center;padding:60px;color:var(--error);">加载失败: ${escHtml(e.message)}</div>`;
  }
}

function renderMyProfile(u) {
  const view = document.getElementById('friendMyProfileView');
  const trust  = getTrustInfo(u.tags || []);
  const vrcP   = isVRCPlus(u.tags || []);
  const langs  = getLanguages(u.tags || []);
  const showcasedBadges = (u.badges || []);

  const statusColor = {active:'#22c55e','join me':'#1A75FF','ask me':'#f59e0b',busy:'#ef4444',offline:'#475569'}[u.status] || '#22c55e';
  const platformIcon = {standalonewindows:'🖥️',android:'<i class="fa-solid fa-vr-cardboard"></i> ',ios:'<i class="fa-solid fa-mobile-screen"></i> '}[u.last_platform] || '';
  const statCard = (label, val) =>
    `<div class="fp-stat-item"><div class="fp-stat-label">${label}</div><div class="fp-stat-value">${val||'–'}</div></div>`;



  const profileBig = proxyImg(u.profilePicOverride||u.currentAvatarThumbnailImageUrl||u.userIcon||'');
  const avatarThumb = proxyImg(u.currentAvatarThumbnailImageUrl||'');

  view.innerHTML = `<div class="my-profile-card">
    <!-- Banner + avatar row -->
    <div class="my-profile-banner" style="position:relative;height:120px;overflow:hidden;background:var(--bg-secondary);">
      <img src="${escHtml(profileBig)}" style="width:100%;height:100%;object-fit:cover;filter:blur(6px) brightness(0.35);" onerror="this.style.display=\'none\'">
      <div style="position:absolute;inset:0;background:linear-gradient(to top,var(--bg-primary) 0%,transparent 70%);"></div>
    </div>
    <div class="my-profile-avatar-row" style="display:flex;align-items:flex-end;gap:16px;margin:-40px 0 12px;position:relative;">
      <div style="width:80px;height:80px;border-radius:50%;overflow:hidden;border:3px solid var(--bg-primary);background:var(--bg-card);flex-shrink:0;">
        <img src="${escHtml(profileBig)}" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'">
      </div>
      <div style="flex:1;min-width:0;padding-bottom:4px;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="width:11px;height:11px;border-radius:50%;background:${statusColor};flex-shrink:0;border:2px solid var(--bg-primary);"></span>
          <span style="font-size:1.1em;font-weight:700;">${escHtml(u.displayName||'')}</span>
          ${langs.map(l=>`<span>${l}</span>`).join('')}
          ${vrcP?'<span style="font-size:0.68em;background:rgba(255, 255, 255, 0.2);color:#d4d4d8;border:1px solid rgba(255, 255, 255, 0.4);padding:2px 8px;border-radius:99px;font-weight:600;">VRC+</span>':''}
        </div>
        <div style="font-size:0.75em;color:var(--text-muted);">${escHtml(u.username||'')}</div>
      </div>
      <div style="width:64px;height:64px;border-radius:10px;overflow:hidden;border:2px solid var(--border);background:var(--bg-card);flex-shrink:0;" title="当前模型">
        <img src="${escHtml(avatarThumb)}" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'">
      </div>
    </div>

    <!-- Trust + platform badges -->
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
      <span style="font-size:0.72em;font-weight:600;padding:4px 12px;border-radius:99px;background:${trust.color}22;color:${trust.color};border:1px solid ${trust.color}55;">${trust.label}</span>
      ${u.ageVerificationStatus==='18+'?'<span style="font-size:0.72em;background:rgba(255, 255, 255, 0.2);color:#d4d4d8;border:1px solid rgba(255, 255, 255, 0.3);padding:4px 12px;border-radius:99px;">18+</span>':''}
      ${platformIcon?`<span style="font-size:0.75em;color:var(--text-muted);padding:4px 10px;background:var(--bg-glass);border:1px solid var(--border);border-radius:99px;">${platformIcon}</span>`:''}
      ${u.pronouns?`<span style="font-size:0.72em;color:var(--text-muted);">${escHtml(u.pronouns)}</span>`:''}
    </div>

    <!-- Showcase badges -->
    ${showcasedBadges.length?`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">
      ${showcasedBadges.map(b=>`<img src="${escHtml(b.badgeImageUrl||'')}" title="${escHtml(b.badgeName||'')}" style="width:32px;height:32px;border-radius:6px;" onerror="this.style.display=\'none\'">`).join('')}
    </div>`:''}

    <!-- Status msg -->
    ${u.statusDescription?`<div style="font-size:0.8em;color:var(--text-secondary);margin-bottom:10px;padding:8px 12px;background:var(--bg-glass);border-radius:8px;border-left:3px solid ${statusColor};">${escHtml(u.statusDescription.replace(/\\n/g, String.fromCharCode(10)))}</div>`:''}

    <!-- Current location -->
    <div style="margin-bottom:12px;" id="myProfileLocRow">
      <div class="stat-section-label">当前位置</div>
      <div id="myProfileLocText" style="font-size:0.8em;color:var(--text-secondary);">加载中...</div>
    </div>

    <!-- Current avatar name -->
    ${u.currentAvatarName?`<div style="margin-bottom:12px;"><div class="stat-section-label">正在使用的模型</div>
      <div style="font-size:0.8em;color:var(--text-secondary);">${escHtml(u.currentAvatarName)}</div></div>`:''}

    <!-- Bio -->
    ${u.bio?`<div style="margin-bottom:12px;"><div class="stat-section-label">个人简介</div>
      <div style="font-size:0.8em;color:var(--text-secondary);white-space:pre-line;line-height:1.6;max-height:150px;overflow-y:auto;">${escHtml((u.bio||'').replace(/\\n/g, String.fromCharCode(10)))}</div></div>`:''}\n
    
    <!-- Groups -->
    <div style="margin-bottom:12px;">
      <div class="stat-section-label">所属群组 (Groups)</div>
      <div id="myProfileGroups" style="font-size:0.8em;color:var(--text-secondary);">加载中 (Loading)...</div>
    </div>
<!-- Stat grid -->
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;">
      ${statCard('账号创建日期', escHtml(u.date_joined||''))}
      ${statCard('最后活跃', u.last_activity?new Date(u.last_activity).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'')}
      ${statCard('允许克隆模型', u.allowAvatarCopying?'允许':'不允许')}
      ${u.friendCount!=null?statCard('好友数', String(u.friendCount)):''}
      ${u.offlineFriends!=null?statCard('离线好友', String(u.offlineFriends.length||0)):''}
      ${u.onlineFriends!=null?statCard('在线好友', String(u.onlineFriends.length||0)):''}
    </div>

    <!-- Player ID -->
    <div class="stat-section-label">玩家 ID</div>
    <div style="font-size:0.72em;color:var(--text-muted);font-family:monospace;display:flex;align-items:center;gap:6px;margin-top:4px;">
      ${escHtml(u.id||'')}
      <button onclick="navigator.clipboard.writeText('${escJsAttr(u.id||'')}').then(()=>this.textContent='✓').catch(()=>{})" style="background:none;border:1px solid var(--border);color:var(--text-muted);padding:2px 8px;border-radius:4px;cursor:pointer;font-size:0.9em;">复制</button>
    </div>

    <!-- Action buttons -->
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;padding-top:14px;border-top:1px solid var(--border);">
      <button class="btn btn-primary" style="padding:6px 14px;font-size:0.82em;" onclick="openEditProfileModal()">✏️ 编辑个人资料</button>
      <button class="btn btn-secondary" style="padding:6px 14px;font-size:0.82em;" onclick="fetchMyProfile(true)"><i class="fa-solid fa-rotate-right"></i> 刷新资料</button>
      <button class="btn btn-secondary" style="padding:6px 14px;font-size:0.82em;" onclick="showSelfContextMenu(event)">··· 操作菜单</button>
      <button class="btn btn-secondary" style="font-size:0.82em;" onclick="window.open('https://vrchat.com/home/user/${escJsAttr(u.id||'')}','_blank')"><i class="fa-solid fa-link"></i> VRChat 主页</button>
      <button class="btn btn-secondary" style="font-size:0.82em;" onclick="navigator.clipboard.writeText('${escJsAttr(u.id||'')}').then(()=>this.textContent='✓ 已复制').catch(()=>{})"><i class="fa-solid fa-clipboard"></i> 复制 ID</button>
    </div>
  </div>`;

  // Async: load location display — always show the row, populate after fetch
  {
    const locRow = document.getElementById('myProfileLocRow');
    const locEl = document.getElementById('myProfileLocText');
    if (locRow && locEl) {
      if (u.location && u.location !== 'offline' && u.location !== 'private') {
        locRow.style.display = '';
        getLocationDisplay(u.location).then(txt => {
          if (locEl) locEl.innerHTML = `<a href="#" onclick="openInstanceDetail('${escJsAttr(u.location)}'); event.preventDefault();" style="color:var(--accent-light);text-decoration:none;">${txt}</a>`;
        }).catch(() => { if (locEl) locEl.textContent = u.location; });
      } else if (u.location === 'private') {
        locRow.style.display = '';
        locEl.innerHTML = '<i class="fa-solid fa-lock"></i> 私人房间';
      } else {
        locRow.style.display = 'none';
      }
    }
  }

  // Fix My Profile Groups - Use showcasedGroups and representedGroup from the user object
  const el = document.getElementById('myProfileGroups');
  if (el) {
    const displayed = [];
    if (u.representedGroup) {
      displayed.push({...u.representedGroup, isRepresenting: true});
    }
    if (u.showcasedGroups && u.showcasedGroups.length) {
      u.showcasedGroups.forEach(sg => {
        if (!displayed.some(d => d.groupId === sg.id || d.id === sg.id)) {
          displayed.push(sg);
        }
      });
    }

    if (displayed.length > 0) {
      el.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">
        ${displayed.map(g => `
          <div class="group-pill" onclick="openGroupDetail('${escJsAttr(g.groupId || g.id)}')" style="cursor:pointer;display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--bg-glass);border:1px solid var(--border);border-radius:99px;font-size:0.85em;transition:all 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='var(--bg-glass)'">
            <img src="${proxyImg(g.iconUrl || g.bannerUrl || '')}" style="width:20px;height:20px;border-radius:50%;object-fit:cover;">
            <div style="display:flex;flex-direction:column;line-height:1.1;max-width:120px;">
              <span style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(g.name)}</span>
              <span style="font-size:0.7em;opacity:0.5;">${escHtml(g.shortCode)}</span>
            </div>
            ${g.isRepresenting ? '<span style="font-size:0.65em;background:rgba(52,211,153,0.2);color:#34d399;border:1px solid rgba(52,211,153,0.3);padding:1px 6px;border-radius:4px;font-weight:bold;">佩戴</span>' : ''}
          </div>
        `).join('')}
      </div>`;
    } else {
      // Fallback: check all groups if showcased/represented fields are missing
      apiCall('/api/vrc/users/' + u.id + '/groups').then(r => r.ok ? r.json() : []).then(groups => {
        const filtered = groups.filter(g => g.isRepresenting);
        if (!filtered.length) { 
          el.innerHTML = '<div style="font-size:0.9em;color:var(--text-muted);opacity:0.6;">暂无佩戴群组 (No represented group)</div>';
          return; 
        }
        filtered.sort((a, b) => (b.isRepresenting ? 1 : 0) - (a.isRepresenting ? 1 : 0));
        el.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">
          ${filtered.map(g => `
            <div class="group-pill" onclick="openGroupDetail('${escJsAttr(g.groupId)}')" style="cursor:pointer;display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--bg-glass);border:1px solid var(--border);border-radius:99px;font-size:0.85em;transition:all 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='var(--bg-glass)'">
              <img src="${proxyImg(g.iconUrl || g.bannerUrl || '')}" style="width:20px;height:20px;border-radius:50%;object-fit:cover;">
              <div style="display:flex;flex-direction:column;line-height:1.1;max-width:120px;">
                <span style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(g.name)}</span>
                <span style="font-size:0.7em;opacity:0.5;">${escHtml(g.shortCode)}</span>
              </div>
              ${g.isRepresenting ? '<span style="font-size:0.65em;background:rgba(52,211,153,0.2);color:#34d399;border:1px solid rgba(52,211,153,0.3);padding:1px 6px;border-radius:4px;font-weight:bold;">佩戴</span>' : ''}
            </div>
          `).join('')}
        </div>`;
      }).catch(() => {
        el.textContent = '加载群组失败';
      });
    }
  }
}

// Bug#2 fix: favorites endpoint returns {favoriteId: "usr_xxx", ...} NOT user objects
// Need to batch-fetch actual user profiles
// Friends list cache TTL: skip the (expensive) full re-fetch when cache is this
// fresh. Tab switches pass forceRefresh=false so they hit this fast path; the
// <i class="fa-solid fa-rotate-right"></i> refresh button passes true to bypass it.
const FRIENDS_CACHE_TTL = 60 * 1000; // 60s
async function fetchCurrentFriendCategory(forceRefresh = false) {
  const seq = ++currentGlobalFetchSeq;
  const cat = currentFriendCategory;
  const listEl = document.getElementById('friendList');
  const statsEl = document.getElementById('friendStats');
  if (!listEl) return;

  // Use a temporary map to build the fresh list while preserving existing rendering
  const friendMap = new Map();

  // ── Step 1: Load basics from cache immediately ──────────────────────────
  let cacheIsFresh = false;
  try {
    const cachedBasics = await idb.get('friend_basics') || [];
    const cacheAge = await idb.get('friend_basics_age') || 0;
    
    const cachedFavMap = await idb.get('friend_favorite_map');
    if (cachedFavMap) {
      friendFavoriteIdMap = new Map(cachedFavMap);
    }
    
    cacheIsFresh = cachedBasics.length > 0 && !forceRefresh && (Date.now() - cacheAge) < FRIENDS_CACHE_TTL;

    if (cachedBasics.length > 0) {
      // Keep last known status from cache — don't force offline, that causes filter flash
      allFriends = cachedBasics.map(b => ({
        ...b,
        status: b.status || 'unknown',
        location: b.location || '',
        state: b.state || 'unknown'
      }));
      filterFriends();
      const freshLabel = cacheIsFresh ? '缓存' : `刷新中 · ${allFriends.length} 名`;
      if (statsEl) statsEl.textContent = freshLabel;
      // Cache fresh enough — skip the big API loop entirely. Saves ~10-100
      // requests per tab switch when ping-ponging between tabs.
      if (cacheIsFresh) return;
    } else {
      listEl.innerHTML = '<div style="text-align:center;padding:40px;color:rgba(255,255,255,0.3);">正在连接 VRChat...</div>';
    }
  } catch (e) { console.error('IDB error:', e); }

  // ── Step 2: Start streaming refresh ─────────────────────────────────────
  // We don't want to wait for everything to finish. We'll fire off background tasks.
  
  let _filterDebounceTimer = null;
  // Debounced re-filter: streaming refresh used to call filterFriends() after EVERY
  // batch (50 cards/batch, ~5+ batches per refresh). Each call rebuilt the entire
  // friend list innerHTML, which reset scroll position and broke selection state.
  // Now debounced to 600ms — fires once after the burst settles instead of
  // 5+ times during it.
  const debouncedFilter = () => {
    if (_filterDebounceTimer) clearTimeout(_filterDebounceTimer);
    _filterDebounceTimer = setTimeout(() => filterFriends(), 600);
  };

  const updateFriendBatch = (batch) => {
    if (seq !== currentGlobalFetchSeq || cat !== currentFriendCategory) return;
    batch.forEach(f => {
      friendMap.set(f.id, f);
      // Also update the global allFriends array
      const idx = allFriends.findIndex(ex => ex.id === f.id);
      if (idx !== -1) allFriends[idx] = Object.assign(allFriends[idx], f);
      else allFriends.push(f);
    });
    debouncedFilter();
    // Update basics cache (persist only non-volatile fields)
    saveFriendBasics();
  };

  const saveFriendBasics = () => {
    const basics = allFriends.map(f => ({
      id: f.id,
      displayName: f.displayName,
      currentAvatarThumbnailImageUrl: f.currentAvatarThumbnailImageUrl,
      userIcon: f.userIcon,
      profilePicOverrideThumbnail: f.profilePicOverrideThumbnail,
      tags: f.tags,
      last_platform: f.last_platform,
      // Persist last known volatile fields to avoid filter flash on next load
      status: f.status,
      location: f.location,
      state: f.state
    }));
    idb.set('friend_basics', basics).catch(()=>{});
    idb.set('friend_basics_age', Date.now()).catch(()=>{});
    idb.set('friend_favorite_map', Array.from(friendFavoriteIdMap.entries())).catch(()=>{});
  };

  try {
    // 1. Fetch Online Friends (High Priority, Fast)
    let onlineOffset = 0;
    while (true) {
      if (seq !== currentGlobalFetchSeq) return;
      const r = await apiCall(`/api/vrc/auth/user/friends?n=100&offset=${onlineOffset}&offline=false`);
      if (!r.ok) break;
      const batch = await r.json();
      if (!batch || !batch.length || seq !== currentGlobalFetchSeq) break;
      updateFriendBatch(batch);
      if (batch.length < 100) break;
      onlineOffset += 100;
    }

    // 2. Fetch Favorite IDs & Refresh them in Parallel (Priority to Favorites)
    const favoriteGroups = ['group_0', 'group_1', 'group_2', 'group_3'];
    const favoriteIds = new Set();
    
    // Clear and rebuild friendFavoriteIdMap for fresh categories
    friendFavoriteIdMap.clear();

    // Get all favorite IDs across groups
    await Promise.all(favoriteGroups.map(async group => {
      let offset = 0;
      while (true) {
        if (seq !== currentGlobalFetchSeq) return;
        const r = await apiCall(`/api/vrc/favorites?type=friend&tag=${group}&n=100&offset=${offset}`);
        if (!r.ok) break;
        const batch = await r.json();
        if (!batch || !batch.length || seq !== currentGlobalFetchSeq) break;
        batch.forEach(fav => {
          favoriteIds.add(fav.favoriteId);
          // Track which groups this user belongs to
          if (!friendFavoriteIdMap.has(fav.favoriteId)) {
            friendFavoriteIdMap.set(fav.favoriteId, { favoriteId: fav.id, tags: [group] });
          } else {
            const entry = friendFavoriteIdMap.get(fav.favoriteId);
            if (!entry.tags.includes(group)) entry.tags.push(group);
          }
        });
        if (batch.length < 100) break;
        offset += 100;
      }
    }));

    // High-concurrency refresh for all Favorites (parallel fetch /users/{id})
    const fIds = [...favoriteIds];
    const CONCURRENCY = 50; 
    for (let i = 0; i < fIds.length; i += CONCURRENCY) {
      if (seq !== currentGlobalFetchSeq || cat !== currentFriendCategory) return;
      const chunk = fIds.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(chunk.map(uid => 
        apiCall(`/api/vrc/users/${uid}`).then(r => r.ok ? r.json() : null)
      ));
      if (seq !== currentGlobalFetchSeq) return;
      const freshBatch = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
      updateFriendBatch(freshBatch);
      if (statsEl) statsEl.textContent = `刷新中... (${friendMap.size} 位就绪)`;
    }


    // 3. Fetch Offline Friends (Background, Low Priority)
    if (cat === 'all' || cat === 'offline') {
      let offlineOffset = 0;
      while (offlineOffset < 3000) {
        if (cat !== currentFriendCategory) return;
        const r = await apiCall(`/api/vrc/auth/user/friends?n=100&offset=${offlineOffset}&offline=true`);
        if (!r.ok) break;
        const batch = await r.json();
        if (!batch || !batch.length) break;
        updateFriendBatch(batch);
        if (batch.length < 100) break;
        offlineOffset += 100;
        await new Promise(r => setTimeout(r, 200)); // Be nice to API
      }
    }

    if (statsEl) statsEl.textContent = `共 ${allFriends.length} 位好友`;
    friendLogMsg(`<i class="fa-solid fa-check"></i> 好友状态已全部同步`, 'success');
  } catch (e) {
    console.error('Fetch error:', e);
    friendLogMsg(`<i class="fa-solid fa-xmark"></i> 好友同步异常`, 'error');
  }
}

async function fetchNotifications() {
  const el = document.getElementById('notificationList');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:40px;color:rgba(255,255,255,0.3);">加载中...</div>';
  try {
    const r = await apiCall('/api/vrc/auth/user/notifications');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const notifications = await r.json();
    
    // Sort notifications: unread first, then newest
    notifications.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));

    const activeCount = notifications.filter(n => !n.seen).length;

    if (!notifications || !notifications.length) {
      el.innerHTML = '<div style="text-align:center;padding:40px;color:rgba(255,255,255,0.3);">暂无消息通知 (No notifications)</div>';
      updateNotificationBadge(0);
      return;
    }

    updateNotificationBadge(activeCount);

    el.innerHTML = notifications.map(n => {
      const isUnread = !n.seen;
      const date = new Date(n.created_at).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
      const sender = n.senderName || '系统';
      
      let typeLabel = '';
      let actions = `<button class="btn btn-secondary btn-xs" onclick="seeNotification('${escJsAttr(n.id)}')">标为已读</button>`;
      
      if (n.type === 'friendRequest') {
        typeLabel = '<i class="fa-solid fa-plus"></i> 好友申请';
        actions = `<button class="btn btn-primary btn-xs" onclick="handleNotification('${escJsAttr(n.id)}','accept')">接受</button>
                   <button class="btn btn-secondary btn-xs" onclick="handleNotification('${escJsAttr(n.id)}','hide')">忽略</button>`;
      } else if (n.type === 'groupInvite') {
        typeLabel = '🏘️ 群组邀请';
        actions = `<button class="btn btn-primary btn-xs" onclick="handleNotification('${escJsAttr(n.id)}','accept')">接受</button>
                   <button class="btn btn-secondary btn-xs" onclick="handleNotification('${escJsAttr(n.id)}','hide')">忽略</button>`;
      } else if (n.type === 'invite') {
        typeLabel = '✉️ 房间邀请';
      } else if (n.type === 'requestInvite') {
        typeLabel = '<i class="fa-solid fa-hand"></i> 请求邀请';
      }

      return `<div class="friend-card" style="margin-bottom:8px; border-left: 3px solid ${isUnread ? 'var(--accent)' : 'transparent'};">
        <div style="flex:1;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <span style="font-size:0.7em;font-weight:700;color:var(--accent-light);">${typeLabel}</span>
            <span style="font-size:0.65em;color:var(--text-muted);">${date}</span>
          </div>
          <div style="font-size:0.85em;font-weight:500;">来自 <span style="color:var(--text-primary); cursor:pointer;" onclick="openFriendProfileById('${escJsAttr(n.senderUserId)}')">${escHtml(sender)}</span></div>
          ${n.message ? `<div style="font-size:0.75em;color:var(--text-secondary);margin-top:4px;background:rgba(255,255,255,0.03);padding:6px;border-radius:4px;">${escHtml(n.message)}</div>` : ''}
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          ${actions}
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    if (isAbortError(e)) return;
    el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--error);">加载失败: ' + escHtml(e.message) + '</div>';
  }
}

async function handleNotification(id, action) {
  try {
    let url = `/api/vrc/auth/user/notifications/${id}/${action}`;
    const r = await apiCall(url, { method: 'PUT' });
    if (!r.ok) throw new Error(await r.text());
    const label = action === 'accept' ? '接受' : (action === 'hide' ? '忽略' : '已读');
    logMsg(`<i class="fa-solid fa-check"></i> 已${label}通知`, 'success');
    fetchNotifications();
  } catch(e) {
    showToast('操作失败: ' + e.message, 'error');
  }
}

async function seeNotification(id) {
  handleNotification(id, 'see');
}

async function seeAllNotifications() {
  if (!confirm('确定要将所有通知标记为已读吗？')) return;
  try {
    const r = await apiCall('/api/vrc/auth/user/notifications/clear', { method: 'PUT' });
    if (!r.ok) throw new Error('Failed to clear notifications');
    fetchNotifications();
  } catch(e) {
     showToast('操作失败: ' + e.message, 'error');
  }
}

function updateNotificationBadge(count) {
  const btn = document.getElementById('friendCatNotifications');
  if (!btn) return;
  if (count > 0) {
    btn.innerHTML = `<i class="fa-solid fa-bell"></i> 消息通知 <span style="background:var(--error);color:white;font-size:0.7em;padding:1px 6px;border-radius:99px;margin-left:4px;">${count}</span>`;
  } else {
    btn.innerHTML = `<i class="fa-solid fa-bell"></i> 消息通知`;
  }
}

// Global Notification Poller
// Polls for unread-notification count every 5 minutes (only when the tab is
// visible and we have a session). Keeps the sidebar badge fresh without
// hammering quota. Also catches token expiry: a 401 here clears vrcAuth so
// the next user action surfaces a relogin prompt instead of silent failures.
setInterval(() => {
  if (!vrcAuth || document.visibilityState !== 'visible') return;
  apiCall('/api/vrc/auth/user/notifications')
    .then(r => {
      if (r.status === 401) {
        // Token rejected. Drop it so subsequent calls don't keep using a
        // dead session — auth.js will redirect to login on next user action.
        vrcAuth = '';
        try { localStorage.removeItem('vrc_auth'); } catch (_) {}
        return null;
      }
      return r.ok ? r.json() : null;
    })
    .then(data => {
      if (data) {
        const activeCount = data.filter(n => !n.seen).length;
        updateNotificationBadge(activeCount);
      }
    })
    .catch(() => {});
}, 300000); // 5 min — balanced between freshness and Worker request quota

async function openFriendProfileById(userId) {
  // Open a placeholder profile immediately, then upgrade the same modal in
  // place when /users/{id} resolves. openFriendProfile() owns _fpSeq, so this
  // wrapper uses its own request id plus the post-placeholder fpSeq.
  const reqId = (window._openFriendProfileByIdReq = (window._openFriendProfileByIdReq || 0) + 1);
  const stubEl = { dataset: { friend: escAttrJson({ id: userId, displayName: '加载中… / Loading…', state: 'offline', _loading: true }) } };
  await openFriendProfile(stubEl);
  if (window._openFriendProfileByIdReq !== reqId) return;
  const fpSeq = window._fpCurrentSeq;

  try {
    const ctrl = scopedAbortControllers.get('friendProfile');
    const opts = ctrl ? { signal: ctrl.signal, noDedupe: true } : { noAbort: true, noDedupe: true };
    const r = await apiCall('/api/vrc/users/' + userId, opts);
    if (!r.ok) return;
    const u = await r.json();
    if (window._openFriendProfileByIdReq !== reqId || window._fpCurrentSeq !== fpSeq) return;
    if (ctrl && !isScopedAbortCurrent('friendProfile', ctrl)) return;
    currentFriendProfile = Object.assign({}, currentFriendProfile, u);
    await _renderFriendProfileUI(currentFriendProfile, document.getElementById('friendProfileModal'));
  } catch(e) {}
}
function filterFriends() {
  const q      = (document.getElementById('friendSearch')?.value||'').toLowerCase().trim();
  const sortBy = document.getElementById('friendSortBy')?.value || 'status';
  const cat    = currentFriendCategory;
  let list     = [...allFriends];

  // Apply Category Filter
  if (cat === 'online') {
    list = list.filter(f => f.state !== 'offline' && f.status !== 'offline');
  } else if (cat === 'offline') {
    list = list.filter(f => f.state === 'offline' || f.status === 'offline');
  } else if (cat.startsWith('fav_')) {
    const groupName = cat.slice(4);
    // Use the friendFavoriteIdMap to check membership
    list = list.filter(f => {
      const favInfo = friendFavoriteIdMap.get(f.id);
      return favInfo && favInfo.tags && favInfo.tags.includes(groupName);
    });
  }

  if (q) list = list.filter(f =>
    (f.displayName||'').toLowerCase().includes(q) ||
    (f.statusDescription||'').toLowerCase().includes(q)
  );

  const trustScore = tags => {
    if (!tags) return 0;
    if (tags.includes('system_trust_veteran')) return 5;
    if (tags.includes('system_trust_trusted')) return 4;
    if (tags.includes('system_trust_known'))   return 3;
    if (tags.includes('system_trust_basic'))   return 2;
    return 1;
  };

  // My current location (to detect co-located friends)
  const myLoc = (myProfileData && myProfileData.location) || '';
  const myWorldId = myLoc.split(':')[0]; // wrld_xxx part only

  const getStatusPriority = (f) => {
    const loc = f.location || '';
    // Offline
    if (f.status === 'offline' || !f.status || loc === 'offline') return 0;
    // In-game
    if (loc.startsWith('wrld_')) {
      // Tier 3: same instance as me (exact match)
      if (myLoc && loc === myLoc) return 4;
      // Tier 2: in the same world but different instance, or fully public/friends+ joinable
      // Also: status "join me" = joinable regardless of room type
      const isPrivate = loc.includes(':private') || loc.includes(':invite)');
      const isBusyOrAsk = f.status === 'busy' || f.status === 'ask me';
      if (!isPrivate && !isBusyOrAsk) return 3; // joinable
      if (isPrivate || isBusyOrAsk) return 2;   // in-game but private/restricted
    }
    // Web/app online but not in game instance
    if (f.status === 'busy' || f.status === 'ask me') return 1;
    return 1;
  };

  list.sort((a, b) => {
    if (sortBy === 'status') {
      const pa = getStatusPriority(a), pb = getStatusPriority(b);
      if (pa !== pb) return pb - pa;
      return (a.displayName||'').localeCompare(b.displayName||'');
    }
    if (sortBy === 'name_asc')    return (a.displayName||'').localeCompare(b.displayName||'');
    if (sortBy === 'name_desc')   return (b.displayName||'').localeCompare(a.displayName||'');
    if (sortBy === 'trust')       return trustScore(b.tags) - trustScore(a.tags);
    if (sortBy === 'last_active') return new Date(b.last_activity||0) - new Date(a.last_activity||0);
    return 0;
  });

  renderFriendList(list);
}

function renderFriendList(list) {
  const el = document.getElementById('friendList');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<div style="text-align:center;padding:40px;color:rgba(255,255,255,0.3);"><i class="fa-solid fa-user"></i> ‍<i class="fa-solid fa-handshake"></i> ‍<i class="fa-solid fa-user"></i> <br><br>暂无好友</div>';
    return;
  }
  const sortBy = document.getElementById('friendSortBy')?.value || 'status';
  if (sortBy !== 'status') {
    el.innerHTML = list.map(f => friendCardHtml(f)).join('');
    setTimeout(resolveWorldNames, 50);
    return;
  }

  // ── Group friends by shared location ──────────────────────────────────
  // Bucket 1: in-game, grouped by location (key = full location string)
  // Bucket 2: in-game, private/restricted (single)
  // Bucket 3: web-only online
  // Bucket 4: offline
  const instanceMap = new Map(); // loc → [friends]
  const webOnline   = [];
  const offline     = [];

  for (const f of list) {
    const loc = f.location || '';
    
    // In-game with a real world location (public/friends/hidden/invite instances)
    if (loc.startsWith('wrld_')) {
      if (!instanceMap.has(loc)) instanceMap.set(loc, []);
      instanceMap.get(loc).push(f);
      continue;
    }
    
    // In-game but in a private/invite room — location is literally 'private'
    if (loc === 'private' || loc === 'traveling') {
      if (!instanceMap.has('private')) instanceMap.set('private', []);
      instanceMap.get('private').push(f);
      continue;
    }
    
    // Clearly offline
    if (f.state === 'offline' || f.status === 'offline' || loc === 'offline') {
      offline.push(f);
      continue;
    }
    
    // Web/app online, unknown (cache placeholder), active, etc.
    webOnline.push(f);
  }

  // Sort instances: groups with multiple friends first (desc by count),
  // then private/restricted last within in-game
  const isRestricted = (loc, friends) =>
    loc === 'private' || loc.includes(':private') || loc.includes('~private') ||
    friends.every(f => f.status === 'busy' || f.status === 'ask me');

  const instances = [...instanceMap.entries()];
  instances.sort(([locA, fa], [locB, fb]) => {
    const rA = isRestricted(locA, fa), rB = isRestricted(locB, fb);
    if (rA !== rB) return rA ? 1 : -1;        // restricted → bottom
    if (fb.length !== fa.length) return fb.length - fa.length; // more friends → top
    return locA.localeCompare(locB);
  });

  const myLoc = (myProfileData && myProfileData.location) || '';
  const sectionDiv = (icon, label, color, top) =>
    `<div style="padding:${top?'6':'12'}px 4px 4px;font-size:0.7em;font-weight:700;color:${color};letter-spacing:.07em;text-transform:uppercase;opacity:0.85;">${icon} ${label}</div>`;

  let html = '';
  const joinableGroups = instances.filter(([loc, fs]) => fs.length > 1 && !isRestricted(loc, fs));
  const joinableSolo   = instances.filter(([loc, fs]) => fs.length === 1 && !isRestricted(loc, fs));
  const privateInsts   = instances.filter(([loc, fs]) => isRestricted(loc, fs));

  // 1. Joinable Groups
  if (joinableGroups.length) {
    html += sectionDiv('<i class="fa-solid fa-user-group"></i> ', '好友聚集的实例', '#86efac', true);
    for (const [loc, friends] of joinableGroups) {
      const isMine = myLoc && loc === myLoc;
      const isMineTag = isMine ? ' <span style="font-size:0.85em;background:rgba(255, 255, 255, 0.3);color:#d4d4d8;padding:1px 6px;border-radius:4px;"><i class="fa-solid fa-location-dot"></i> 你也在这里</span>' : '';
      const isPrivateLoc = loc === 'private' || loc.includes('~private');
      const groupInviteBtn = isPrivateLoc ? '' : `<button class="btn btn-xs" onclick="event.stopPropagation();inviteSelf('${escJsAttr(loc)}')" style="padding:2px 8px;font-size:0.8em;border-radius:4px;background:#86efac22;color:#86efac;border:1px solid #86efac44;cursor:pointer;">邀请自己</button>`;
      
      html += `<div class="loc-group-header" id="loc_${loc.split(':')[0]}" data-loc="${escHtml(loc)}" style="display:flex;align-items:center;gap:6px;padding:6px 10px;margin:4px 0 2px;background:rgba(134,239,172,0.06);border-left:2px solid #86efac;border-radius:0 6px 6px 0;font-size:0.75em;color:#86efac;">` +
        `<span><i class="fa-solid fa-user-group"></i> ${friends.length} 位好友在此</span>` +
        `<span style="opacity:0.6;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" id="lgn_${loc.split(':')[0]}">加载中...</span>` +
        isMineTag + groupInviteBtn + '</div>';
      html += friends.map(f => friendCardHtml(f)).join('');
    }
  }

  // 2. Joinable Solo
  if (joinableSolo.length) {
    html += sectionDiv('<i class="fa-solid fa-gamepad"></i> ', '游戏中 · 可加入', '#60a5fa', html === '');
    for (const [loc, friends] of joinableSolo) {
      html += friends.map(f => friendCardHtml(f)).join('');
    }
  }

  // 3. Private Rooms (Grouped)
  if (privateInsts.length) {
    html += sectionDiv('<i class="fa-solid fa-lock"></i> ', '在私人房间 / 不可加入', '#fbbf24', html === '');
    for (const [loc, friends] of privateInsts) {
      if (friends.length > 1) {
        // No data-loc on private headers — world name resolution is not applicable
        html += `<div class="loc-group-header" id="loc_${loc.split(':')[0]}" style="display:flex;align-items:center;gap:6px;padding:6px 10px;margin:4px 0 2px;background:rgba(251,191,36,0.06);border-left:2px solid #fbbf24;border-radius:0 6px 6px 0;font-size:0.75em;color:#fbbf24;">` +
          `<span><i class="fa-solid fa-user-group"></i> ${friends.length} 位好友在此</span>` +
          `<span style="opacity:0.6;flex:1;">私人房间</span>` +
          '</div>';
      }
      html += friends.map(f => friendCardHtml(f)).join('');
    }
  }

  // 4. Web Online
  if (webOnline.length) {
    html += sectionDiv('<i class="fa-solid fa-globe"></i> ', '网页在线', 'var(--text-muted)', html === '');
    html += webOnline.map(f => friendCardHtml(f)).join('');
  }

  // 5. Offline
  if (offline.length) {
    html += sectionDiv('💤', '离线', 'var(--text-muted)', false);
    html += offline.map(f => friendCardHtml(f)).join('');
  }

  el.innerHTML = html;

  // Async: resolve world names in group headers
  document.querySelectorAll('.loc-group-header[data-loc]').forEach(async div => {
    const loc = div.dataset.loc;
    const nameEl = div.querySelector('[id^="lgn_"]');
    if (!nameEl || !loc) return;
    try {
      const txt = await getLocationDisplay(loc);
      nameEl.innerHTML = txt; // getLocationDisplay returns HTML (FA icons in type label)
      // Also make the header clickable to open world detail
      div.style.cursor = 'pointer';
      div.onclick = (e) => { openWorldDetail(loc.split(':')[0]); e.stopPropagation(); };
    } catch {}
  });

  setTimeout(resolveWorldNames, 50);
}

function friendCardHtml(f) {
  const trust     = getTrustInfo(f.tags||[]);
  const isOnline  = f.status !== 'offline';
  const statusCss = {active:'online','join me':'join-me','ask me':'ask-me',busy:'busy',offline:'offline'}[f.status] || 'online';
  const loc = parseLocation(f.location);
  let locationText = '离线';
  const locSpanId = 'loc_' + (f.id || '').replace(/[^a-zA-Z0-9_-]/g,'');
  if (!loc.isOffline) {
    if (loc.isPrivate) locationText = '<i class="fa-solid fa-lock"></i> 私人房间';
    else if (loc.isTraveling) locationText = '✈️ 传送中';
    else locationText = '加载中...';
  }
  const thumb = proxyImg(f.profilePicOverrideThumbnail||f.userIcon||f.currentAvatarThumbnailImageUrl||'');
  const langs = getLanguages(f.tags||[]).join('');
  const fJson  = escAttrJson(f);

    // ~hidden = Friends+ (joinable). Only ~private is truly unjoinable.
    const isJoinable = f.location && f.location !== 'private' && f.location !== 'offline'
      && !f.location.includes('~private')
      && f.location.startsWith('wrld_');
    const joinBtn = isJoinable ? `
      <div style="display:flex;gap:4px;margin-bottom:2px;">
        <button class="btn btn-xs" onclick="event.stopPropagation();inviteSelf('${escJsAttr(f.location)}')" style="padding:2px 6px;font-size:0.7em;border-radius:4px;background:rgba(134,239,172,0.1);color:#4ade80;border:1px solid rgba(134,239,172,0.2);cursor:pointer;" title="发送邀请给自己"><i class="fa-solid fa-envelope"></i> </button>
      </div>` : '';

    return `<div class="friend-card" onclick="openFriendProfile(this);" data-friend="${fJson}">
      <div class="friend-avatar-wrap">
        ${thumb ? `<img src="${escHtml(thumb)}" alt="" onerror="this.style.display=\'none\'">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:1.3em;"><i class="fa-solid fa-user"></i> </div>'}
        <span class="friend-status-dot ${statusCss}"></span>
      </div>
      <div class="friend-info">
        <div class="friend-name" style="color:${trust.color};">${escHtml(f.displayName||'')} <span style="font-size:0.75em;opacity:0.7;">${langs}</span></div>
        <div class="friend-location" style="display:flex;align-items:center;gap:4px;">
          <span style="font-weight:600;color:var(--text-primary);">${getStatusLabel(f)}</span>
          <span style="opacity:0.6;">|</span>
          ${(f.location && f.location !== 'offline' && f.location !== 'private' && f.location.startsWith('wrld_')) 
              ? `<a href="#" id="${locSpanId}" onclick="openInstanceDetail('${escJsAttr(f.location)}'); event.stopPropagation(); event.preventDefault();" style="color:var(--accent-light);text-decoration:none;" title="查看实例详情">${escHtml(locationText)}</a>`
              : `<span>${escHtml((f.state==='online' && f.statusDescription) ? f.statusDescription : locationText)}</span>`}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex-shrink:0;">
        ${joinBtn}
        <span style="font-size:0.62em;padding:2px 7px;border-radius:99px;background:${trust.color}22;color:${trust.color};border:1px solid ${trust.color}44;">${trust.label}</span>
        <span style="font-size:0.68em;color:var(--text-muted);">${getPlatformEmoji(f.last_platform)}</span>
      </div>
    </div>`;
}

// Async resolve world names in friend cards
function resolveWorldNames() {
  document.querySelectorAll('[id^="loc_"]').forEach(async el => {
    if (el.dataset.resolved) return;
    el.dataset.resolved = '1';
    const friendCard = el.closest('.friend-card');
    if (!friendCard) return;
    try {
      const fData = parseAttrJson(friendCard.dataset.friend);
      if (fData.location && fData.location.startsWith('wrld_')) {
        const txt = await getLocationDisplay(fData.location);
        el.innerHTML = txt; // getLocationDisplay returns HTML (FA icons in type label)
      }
    } catch(e) {}
  });
}

VRCW.registerModule('friends', { initFriendsTab, switchFriendCategory, fetchMyProfile, renderMyProfile, fetchCurrentFriendCategory, fetchNotifications, handleNotification, seeNotification, seeAllNotifications, updateNotificationBadge, openFriendProfileById, filterFriends, renderFriendList, friendCardHtml, resolveWorldNames });
renderAppVersionInfo();

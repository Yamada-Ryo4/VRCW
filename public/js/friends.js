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
let myProfileFetchGeneration = 0;
let friendListRevision = 0;
let friendMembershipSnapshot = null;
let friendCacheQueue = Promise.resolve();
const removedFriends = new Map();
const friendDeletionFlights = new Map();

function isFriendRemoved(userId) {
  const session = removedFriends.get(userId);
  if (!session) return false;
  if (isAuthSessionCurrent(session)) return true;
  removedFriends.delete(userId);
  return false;
}

function isCurrentFriend(user) {
  if (!user?.id || isFriendRemoved(user.id)) return false;
  if (friendMembershipSnapshot && isAuthSessionCurrent(friendMembershipSnapshot.session)) {
    return friendMembershipSnapshot.ids.has(user.id);
  }
  return user.isFriend === true || allFriends.some(friend => friend.id === user.id);
}

async function readFriendMembership(session, current) {
  const response = await apiCall('/api/vrc/auth/user', { noCache: true, noDedupe: true });
  if (!current()) return null;
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const user = await response.json();
  if (!current()) return null;
  if (!user || user.id !== currentUserId || !Array.isArray(user.friends)
      || user.friends.some(id => typeof id !== 'string' || !id)) throw new Error('Invalid friend membership response');
  const ids = new Set(user.friends);
  for (const id of ids) {
    if (!isFriendRemoved(id)) continue;
    // A renewed friendship must be confirmed independently; stale friend pages
    // and residual favorite records alone cannot lift a deletion barrier.
    let renewed = false;
    try {
      const status = await apiCall(`/api/vrc/user/${encodeURIComponent(id)}/friendStatus`, { noCache: true, noDedupe: true });
      if (!current()) return null;
      const body = status.ok ? await status.json() : null;
      if (!current()) return null;
      renewed = body?.isFriend === true;
    } catch (error) { if (!current() || isAbortError(error)) return null; }
    if (renewed) removedFriends.delete(id);
    else ids.delete(id);
  }
  return { session, ids };
}

function friendBasicRecord(friend) {
  return {
    id: friend.id,
    displayName: friend.displayName,
    currentAvatarThumbnailImageUrl: friend.currentAvatarThumbnailImageUrl,
    userIcon: friend.userIcon,
    profilePicOverrideThumbnail: friend.profilePicOverrideThumbnail,
    tags: friend.tags,
    last_platform: friend.last_platform,
    status: friend.status,
    statusDescription: friend.statusDescription,
    location: friend.location,
    state: friend.state,
    isFriend: true,
  };
}

function persistFriendListCache(session, current, friends, favorites, age) {
  const basics = friends.map(friendBasicRecord);
  const favoriteEntries = favorites ? Array.from(favorites.entries()) : null;
  const write = friendCacheQueue.catch(() => {}).then(async () => {
    if (!isAuthSessionCurrent(session) || !current()) return;
    await idb.set('friend_basics', basics, session);
    if (!isAuthSessionCurrent(session) || !current()) return;
    await idb.set('friend_basics_age', age, session);
    if (!isAuthSessionCurrent(session) || !current() || !favoriteEntries) return;
    await idb.set('friend_favorite_map', favoriteEntries, session);
  });
  friendCacheQueue = write.catch(() => {});
  return write;
}

async function refreshFriendPersistentCache(session, revision) {
  const current = () => isAuthSessionCurrent(session) && revision === friendListRevision;
  const records = new Map();
  for (const offline of [false, true]) {
    let offset = 0;
    while (true) {
      if (!current()) return false;
      const response = await apiCall(`/api/vrc/auth/user/friends?n=100&offset=${offset}&offline=${offline}`, { noAbort: true, noCache: true, noDedupe: true });
      if (!current()) return false;
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const batch = await response.json();
      if (!current()) return false;
      if (!Array.isArray(batch) || batch.some(friend => !friend || typeof friend.id !== 'string' || !friend.id)) {
        throw new Error('Invalid friend list response');
      }
      for (const friend of batch) if (!isFriendRemoved(friend.id)) records.set(friend.id, friend);
      if (batch.length < 100) break;
      offset += batch.length;
    }
  }
  const membership = await readFriendMembership(session, current);
  if (!current() || !membership) return false;
  const cached = await idb.get('friend_basics', session);
  if (!current()) return false;
  for (const friend of Array.isArray(cached) ? cached : []) {
    if (friend?.id && membership.ids.has(friend.id) && !records.has(friend.id)) records.set(friend.id, friend);
  }
  const users = [...membership.ids].filter(id => !isFriendRemoved(id))
    .map(id => records.get(id) || { id, displayName: id, state: 'unknown', status: 'unknown' });
  await persistFriendListCache(session, current, users, null, Date.now());
  return current() ? users.length : false;
}

async function applyFriendRemoval(userId, session) {
  if (!isAuthSessionCurrent(session)) return false;
  removedFriends.set(userId, session);
  friendListRevision += 1;
  if (friendMembershipSnapshot && isAuthSessionCurrent(friendMembershipSnapshot.session)) {
    friendMembershipSnapshot.ids.delete(userId);
  }
  allFriends = allFriends.filter(friend => friend.id !== userId);
  friendFavoriteIdMap.delete(userId);
  for (const profile of [myProfileData, window.myProfileData]) {
    if (!profile || profile.id !== currentUserId) continue;
    for (const key of ['friends', 'onlineFriends', 'offlineFriends', 'activeFriends']) {
      if (Array.isArray(profile[key])) profile[key] = profile[key].filter(id => id !== userId);
    }
    if (Array.isArray(profile.friends)) profile.friendCount = profile.friends.length;
  }
  if (currentTab === 'friends') filterFriends();
  const stats = document.getElementById('friendStats');
  if (stats) stats.textContent = t('friend.totalFriends', { count: allFriends.length });

  const write = friendCacheQueue.catch(() => {}).then(async () => {
    if (!isAuthSessionCurrent(session)) return;
    const cachedBasics = await idb.get('friend_basics', session);
    if (!isAuthSessionCurrent(session)) return;
    const basics = (Array.isArray(cachedBasics) ? cachedBasics : allFriends)
      .filter(friend => friend?.id && !isFriendRemoved(friend.id)).map(friendBasicRecord);
    const cachedFavorites = await idb.get('friend_favorite_map', session);
    if (!isAuthSessionCurrent(session)) return;
    const favorites = new Map(Array.isArray(cachedFavorites) ? cachedFavorites : []);
    for (const [id, entry] of friendFavoriteIdMap) favorites.set(id, entry);
    for (const id of favorites.keys()) if (isFriendRemoved(id)) favorites.delete(id);
    await idb.set('friend_basics', basics, session);
    if (!isAuthSessionCurrent(session)) return;
    await idb.set('friend_basics_age', 0, session);
    if (!isAuthSessionCurrent(session)) return;
    await idb.set('friend_favorite_map', Array.from(favorites.entries()), session);
  });
  friendCacheQueue = write.catch(() => {});
  await write.catch(error => console.warn('Friend removal cache update failed:', error.message));
  return isAuthSessionCurrent(session);
}

async function initFriendsTab() {
  friendsLoaded = true;
  fetchMyModerations();
  await switchFriendCategory(currentFriendCategory);
}

// Helper: make a sidebar button with cat-btn + btn-secondary styling identical to Models tab

function makeCatBtn(text, onclick, id) {
  return `<button class="btn btn-secondary btn-block cat-btn" onclick="${escHtml(onclick)}" id="${escHtml(id)}">${text}</button>`;
}

function switchFriendCategory(cat) {
  currentFriendCategory = cat;
  return runPriorityTask(async () => {
    if (currentFriendCategory !== cat || currentTab !== 'friends') return;
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
  const session = makeAuthSessionToken();
  const generation = ++myProfileFetchGeneration;
  const current = () => isAuthSessionCurrent(session) && generation === myProfileFetchGeneration;
  const foreground = () => current() && currentTab === 'friends' && currentFriendCategory === 'myprofile';
  const myView = document.getElementById('friendMyProfileView');
  if (foreground() && myView) {
    myView.style.display = 'block';
    if (myProfileData) renderMyProfile(myProfileData);
    else myView.innerHTML = '<div style="text-align:center;padding:60px;color:rgba(255,255,255,0.3);">' + escHtml(t('loading')) + '</div>';
  }
  try {
    const cached = await idb.get('my_profile', session);
    if (!current()) return;
    if (cached?.id && (!currentUserId || cached.id === currentUserId) && !forceRefresh) {
      myProfileData = cached;
      window.myProfileData = cached;
      if (foreground()) renderMyProfile(cached);
      renderSidebarMiniProfile(cached);
    }

    const resp = await apiCall('/api/vrc/auth/user', { noAbort: true, noCache: true, noDedupe: true });
    if (!current()) return;
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const fresh = await resp.json();
    if (!current()) return;
    if (!fresh?.id || (currentUserId && fresh.id !== currentUserId)) throw new Error('Invalid profile response');
    myProfileData = fresh;
    window.myProfileData = fresh;
    if (foreground()) renderMyProfile(fresh);
    renderSidebarMiniProfile(fresh);
    await idb.set('my_profile', fresh, session);
    if (!current()) return;

    // auth/user can omit location; do not let this asynchronous enrichment
    // change the active category or overwrite a newer account/profile refresh.
    void apiCall('/api/vrc/users/' + encodeURIComponent(fresh.id), { noAbort: true, noCache: true, noDedupe: true })
      .then(r => r.ok ? r.json() : null).then(async full => {
        if (!current() || !full || full.id !== fresh.id) return;
        const enriched = { ...fresh };
        for (const key of ['location', 'state', 'status', 'statusDescription']) {
          if (typeof full[key] === 'string') enriched[key] = full[key];
        }
        myProfileData = enriched;
        window.myProfileData = enriched;
        if (foreground()) renderMyProfile(enriched);
        renderSidebarMiniProfile(enriched);
        await idb.set('my_profile', enriched, session);
      }).catch(() => {});
    fetchMyModerations();
  } catch (error) {
    if (!current() || isAbortError(error)) return;
    if (myProfileData) {
      if (foreground()) renderMyProfile(myProfileData);
      friendLogMsg(t('log.profileRefreshFailCached', { msg: error.message }), 'error');
    } else if (foreground() && myView) {
      myView.innerHTML = `<div style="text-align:center;padding:60px;color:var(--error);">${escHtml(t('toast.loadFailMsg', { msg: error.message }))}</div>`;
    }
  }
}

function renderMyProfile(u) {
  const view = document.getElementById('friendMyProfileView');
  if (!view) return;
  const session = makeAuthSessionToken();
  const generation = myProfileFetchGeneration;
  const current = () => isAuthSessionCurrent(session) && generation === myProfileFetchGeneration
    && currentTab === 'friends' && currentFriendCategory === 'myprofile' && myProfileData?.id === u.id;
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
      <img ${imageSrcAttrs(profileBig)} style="width:100%;height:100%;object-fit:cover;filter:blur(6px) brightness(0.35);" onerror="this.style.display=\'none\'">
      <div style="position:absolute;inset:0;background:linear-gradient(to top,var(--bg-primary) 0%,transparent 70%);"></div>
    </div>
    <div class="my-profile-avatar-row" style="display:flex;align-items:flex-end;gap:16px;margin:-40px 0 12px;position:relative;">
      <div style="width:80px;height:80px;border-radius:50%;overflow:hidden;border:3px solid var(--bg-primary);background:var(--bg-card);flex-shrink:0;">
        <img ${imageSrcAttrs(profileBig)} style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'">
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
      <div style="width:64px;height:64px;border-radius:10px;overflow:hidden;border:2px solid var(--border);background:var(--bg-card);flex-shrink:0;" title="${t('friend.currentAvatar')}">
        <img ${imageSrcAttrs(avatarThumb)} style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'">
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
      ${showcasedBadges.map(b=>`<img ${imageSrcAttrs(b.badgeImageUrl||'')} title="${escHtml(b.badgeName||'')}" style="width:32px;height:32px;border-radius:6px;" onerror="this.style.display=\'none\'">`).join('')}
    </div>`:''}

    <!-- Status msg -->
    ${u.statusDescription?`<div style="font-size:0.8em;color:var(--text-secondary);margin-bottom:10px;padding:8px 12px;background:var(--bg-glass);border-radius:8px;border-left:3px solid ${statusColor};">${escHtml(u.statusDescription.replace(/\\n/g, String.fromCharCode(10)))}</div>`:''}

    <!-- Current location -->
    <div style="margin-bottom:12px;" id="myProfileLocRow">
      <div class="stat-section-label">${t('friend.currentLocation')}</div>
      <div id="myProfileLocText" style="font-size:0.8em;color:var(--text-secondary);">${escHtml(t('loading'))}</div>
    </div>

    <!-- Current avatar name -->
    ${u.currentAvatarName?`<div style="margin-bottom:12px;"><div class="stat-section-label">${t('friend.currentAvatarInUse')}</div>
      <div style="font-size:0.8em;color:var(--text-secondary);">${escHtml(u.currentAvatarName)}</div></div>`:''}

    <!-- Bio -->
    ${u.bio?`<div style="margin-bottom:12px;"><div class="stat-section-label">${t('friend.bio')}</div>
      <div style="font-size:0.8em;color:var(--text-secondary);white-space:pre-line;line-height:1.6;max-height:150px;overflow-y:auto;">${escHtml((u.bio||'').replace(/\\n/g, String.fromCharCode(10)))}</div></div>`:''}\n

    <!-- Groups -->
    <div style="margin-bottom:12px;">
      <div class="stat-section-label">${t('friend.groups')}</div>
      <div id="myProfileGroups" style="font-size:0.8em;color:var(--text-secondary);">${escHtml(t('friend.loadingGroups'))}</div>
    </div>
<!-- Stat grid -->
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;">
      ${statCard(t('field.dateJoined'), escHtml(u.date_joined||''))}
      ${statCard(t('field.lastActivity'), u.last_activity?new Date(u.last_activity).toLocaleString(getLocale(),{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'')}
      ${statCard(t('field.allowClone'), u.allowAvatarCopying?t('label.cloneAllowed'):t('label.cloneDisallowed'))}
      ${u.friendCount!=null?statCard(t('field.friendCount'), String(u.friendCount)):''}
      ${u.offlineFriends!=null?statCard(t('field.offlineFriends'), String(u.offlineFriends.length||0)):''}
      ${u.onlineFriends!=null?statCard(t('field.onlineFriends'), String(u.onlineFriends.length||0)):''}
    </div>

    <!-- Player ID -->
    <div class="stat-section-label">${t('field.playerId')}</div>
    <div style="font-size:0.72em;color:var(--text-muted);font-family:monospace;display:flex;align-items:center;gap:6px;margin-top:4px;">
      ${escHtml(u.id||'')}
      <button onclick="navigator.clipboard.writeText('${escJsAttr(u.id||'')}').then(()=>this.textContent='✓').catch(()=>{})" style="background:none;border:1px solid var(--border);color:var(--text-muted);padding:2px 8px;border-radius:4px;cursor:pointer;font-size:0.9em;">${escHtml(t('btn.copy'))}</button>
    </div>

    <!-- Action buttons -->
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;padding-top:14px;border-top:1px solid var(--border);">
      <button class="btn btn-primary" style="padding:6px 14px;font-size:0.82em;" onclick="openEditProfileModal()">✏️ ${escHtml(t('friend.editProfile'))}</button>
      <button class="btn btn-secondary" style="padding:6px 14px;font-size:0.82em;" onclick="fetchMyProfile(true)"><i class="fa-solid fa-rotate-right"></i> ${escHtml(t('friend.refreshProfile'))}</button>
      <button class="btn btn-secondary" style="padding:6px 14px;font-size:0.82em;" onclick="showSelfContextMenu(event)">··· ${escHtml(t('friend.actionMenu'))}</button>
      <button class="btn btn-secondary" style="font-size:0.82em;" onclick="window.open('https://vrchat.com/home/user/${escJsAttr(u.id||'')}','_blank')"><i class="fa-solid fa-link"></i> ${escHtml(t('friend.vrchatHome'))}</button>
      <button class="btn btn-secondary" style="font-size:0.82em;" onclick="navigator.clipboard.writeText('${escJsAttr(u.id||'')}').then(()=>this.textContent='${escJsAttr(t('friend.copiedConfirm'))}').catch(()=>{})"><i class="fa-solid fa-clipboard"></i> ${escHtml(t('friend.copyId'))}</button>
    </div>
  </div>`;

  observeImages(view);

  // Async: load location display — always show the row, populate after fetch
  {
    const locRow = document.getElementById('myProfileLocRow');
    const locEl = document.getElementById('myProfileLocText');
    if (locRow && locEl) {
      if (u.location && u.location !== 'offline' && u.location !== 'private') {
        locRow.style.display = '';
        getLocationDisplay(u.location).then(txt => {
          if (current() && locEl.isConnected !== false) locEl.innerHTML = `<a href="#" onclick="openInstanceDetail('${escJsAttr(u.location)}'); event.preventDefault();" style="color:var(--accent-light);text-decoration:none;">${txt}</a>`;
        }).catch(() => { if (current() && locEl.isConnected !== false) locEl.textContent = u.location; });
      } else if (u.location === 'private') {
        locRow.style.display = '';
        locEl.innerHTML = t('friend.privateRoom');
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
            <img ${imageSrcAttrs(g.iconUrl || g.bannerUrl || '')} style="width:20px;height:20px;border-radius:50%;object-fit:cover;">
            <div style="display:flex;flex-direction:column;line-height:1.1;max-width:120px;">
              <span style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(g.name)}</span>
              <span style="font-size:0.7em;opacity:0.5;">${escHtml(g.shortCode)}</span>
            </div>
            ${g.isRepresenting ? '<span style="font-size:0.65em;background:rgba(52,211,153,0.2);color:#34d399;border:1px solid rgba(52,211,153,0.3);padding:1px 6px;border-radius:4px;font-weight:bold;">' + escHtml(t('friend.representing')) + '</span>' : ''}
          </div>
        `).join('')}
      </div>`;
    } else {
      // Fallback: check all groups if showcased/represented fields are missing.
      // noAbort: this is a user-initiated profile view, not a tab-load — it must
      // NOT be cancelled by switchTab's currentTabAbortController.abort().
      const fetchGroups = () => apiCall('/api/vrc/users/' + encodeURIComponent(u.id) + '/groups?n=50', { noAbort: true }).then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)));
      fetchGroups().then(groups => {
        if (!current() || el.isConnected === false) return;
        const filtered = groups.filter(g => g.isRepresenting);
        if (!filtered.length) {
          el.innerHTML = '<div style="font-size:0.9em;color:var(--text-muted);opacity:0.6;">' + escHtml(t('friend.noRepresentedGroup')) + '</div>';
          return;
        }
        filtered.sort((a, b) => (b.isRepresenting ? 1 : 0) - (a.isRepresenting ? 1 : 0));
        el.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">
          ${filtered.map(g => `
            <div class="group-pill" onclick="openGroupDetail('${escJsAttr(g.groupId)}')" style="cursor:pointer;display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--bg-glass);border:1px solid var(--border);border-radius:99px;font-size:0.85em;transition:all 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='var(--bg-glass)'">
              <img ${imageSrcAttrs(g.iconUrl || g.bannerUrl || '')} style="width:20px;height:20px;border-radius:50%;object-fit:cover;">
              <div style="display:flex;flex-direction:column;line-height:1.1;max-width:120px;">
                <span style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(g.name)}</span>
                <span style="font-size:0.7em;opacity:0.5;">${escHtml(g.shortCode)}</span>
              </div>
              ${g.isRepresenting ? '<span style="font-size:0.65em;background:rgba(52,211,153,0.2);color:#34d399;border:1px solid rgba(52,211,153,0.3);padding:1px 6px;border-radius:4px;font-weight:bold;">' + escHtml(t('friend.representing')) + '</span>' : ''}
            </div>
          `).join('')}
        </div>`;
        observeImages(el);
      }).catch(() => {
        if (!current() || el.isConnected === false) return;
        setTimeout(() => {
          if (!current() || el.isConnected === false) return;
          fetchGroups().then(groups => {
            if (!current() || el.isConnected === false) return;
            const filtered = groups.filter(g => g.isRepresenting);
            if (!filtered.length) {
              el.innerHTML = '<div style="font-size:0.9em;color:var(--text-muted);opacity:0.6;">' + escHtml(t('friend.noRepresentedGroup')) + '</div>';
              return;
            }
            filtered.sort((a, b) => (b.isRepresenting ? 1 : 0) - (a.isRepresenting ? 1 : 0));
            el.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">
              ${filtered.map(g => `
                <div class="group-pill" onclick="openGroupDetail('${escJsAttr(g.groupId)}')" style="cursor:pointer;display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--bg-glass);border:1px solid var(--border);border-radius:99px;font-size:0.85em;transition:all 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='var(--bg-glass)'">
                  <img ${imageSrcAttrs(g.iconUrl || g.bannerUrl || '')} style="width:20px;height:20px;border-radius:50%;object-fit:cover;">
                  <div style="display:flex;flex-direction:column;line-height:1.1;max-width:120px;">
                    <span style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(g.name)}</span>
                    <span style="font-size:0.7em;opacity:0.5;">${escHtml(g.shortCode)}</span>
                  </div>
                  ${g.isRepresenting ? '<span style="font-size:0.65em;background:rgba(52,211,153,0.2);color:#34d399;border:1px solid rgba(52,211,153,0.3);padding:1px 6px;border-radius:4px;font-weight:bold;">' + escHtml(t('friend.representing')) + '</span>' : ''}
                </div>
              `).join('')}
            </div>`;
            observeImages(el);
          }).catch((e) => {
            if (!current() || el.isConnected === false) return;
            el.innerHTML = '<div style="font-size:0.85em;color:var(--text-muted);opacity:0.6;">' + escHtml(t('toast.groupsLoadFail', {msg: String(e.message || e)})) + '</div>';
          });
        }, 1500);
      });
    }
    observeImages(el);
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
  const session = makeAuthSessionToken();
  const revision = friendListRevision;
  const cat = currentFriendCategory;
  const isRefreshCurrent = () => seq === currentGlobalFetchSeq
    && cat === currentFriendCategory && currentTab === 'friends'
    && revision === friendListRevision && isAuthSessionCurrent(session);
  const listEl = document.getElementById('friendList');
  const statsEl = document.getElementById('friendStats');
  if (!listEl) return;

  const friendMap = new Map();
  const nextFriendFavoriteIdMap = new Map();
  let onlineFriendSnapshotComplete = false;
  let offlineFriendSnapshotComplete = false;
  let favoriteRefreshFailed = false;
  const authoritativeFriendIds = new Set();

  // ── Step 1: Load basics from cache immediately ──────────────────────────
  let cacheIsFresh = false;
  try {
    await friendCacheQueue;
    if (!isRefreshCurrent()) return;
    const cached = await idb.get('friend_basics', session);
    const cachedBasics = Array.isArray(cached) ? cached.filter(friend => friend?.id && !isFriendRemoved(friend.id)) : [];
    if (!isRefreshCurrent()) return;
    const cacheAge = await idb.get('friend_basics_age', session) || 0;
    if (!isRefreshCurrent()) return;
    
    const cachedFavMap = await idb.get('friend_favorite_map', session);
    if (!isRefreshCurrent()) return;
    if (Array.isArray(cachedFavMap)) {
      friendFavoriteIdMap = new Map(cachedFavMap.filter(([id]) => !isFriendRemoved(id)));
    }
    
    cacheIsFresh = cachedBasics.length > 0 && !forceRefresh && (Date.now() - cacheAge) < FRIENDS_CACHE_TTL;

    if (cachedBasics.length > 0) {
      if (!isRefreshCurrent()) return;
      // Keep last known status from cache — don't force offline, that causes filter flash
      allFriends = cachedBasics.map(b => ({
        ...b,
        status: b.status || 'unknown',
        location: b.location || '',
        state: b.state || 'unknown'
      }));
      if (!isRefreshCurrent()) return;
      filterFriends();
      const freshLabel = cacheIsFresh ? t('friend.cache') : t('friend.refreshingCount', {count: allFriends.length});
      if (statsEl && isRefreshCurrent()) statsEl.textContent = freshLabel;
      // Cache fresh enough — skip the big API loop entirely. Saves ~10-100
      // requests per tab switch when ping-ponging between tabs.
      if (cacheIsFresh) return;
    } else {
      if (!isRefreshCurrent()) return;
      listEl.innerHTML = '<div style="text-align:center;padding:40px;color:rgba(255,255,255,0.3);">' + escHtml(t('friend.connectingVRC')) + '</div>';
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
    _filterDebounceTimer = setTimeout(() => {
      if (isRefreshCurrent()) filterFriends();
    }, 600);
  };

  const updateFriendBatch = (batch) => {
    if (!isRefreshCurrent()) return;
    batch.forEach(friend => {
      if (!friend?.id || isFriendRemoved(friend.id)) return;
      const fresh = { ...friend, isFriend: true };
      friendMap.set(fresh.id, fresh);
      authoritativeFriendIds.add(fresh.id);
      if (friendMembershipSnapshot && isAuthSessionCurrent(friendMembershipSnapshot.session)) {
        friendMembershipSnapshot.ids.add(fresh.id);
      }
      const idx = allFriends.findIndex(existing => existing.id === fresh.id);
      if (idx !== -1) allFriends[idx] = { ...allFriends[idx], ...fresh };
      else allFriends.push(fresh);
    });
    debouncedFilter();
  };

  const fetchFriendPages = async offline => {
    let offset = 0;
    while (true) {
      if (!isRefreshCurrent()) return false;
      const response = await apiCall(`/api/vrc/auth/user/friends?n=100&offset=${offset}&offline=${offline}`, { noCache: true, noDedupe: true });
      if (!isRefreshCurrent()) return false;
      if (!response.ok) return false;
      const batch = await response.json();
      if (!isRefreshCurrent()) return false;
      if (!Array.isArray(batch) || batch.some(friend => !friend || typeof friend.id !== 'string' || !friend.id)) return false;
      updateFriendBatch(batch);
      if (batch.length < 100) return true;
      offset += batch.length;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  };

  try {
    onlineFriendSnapshotComplete = await fetchFriendPages(false);
    if (!isRefreshCurrent()) return;
    const favoriteGroups = [...new Set(['group_0', 'group_1', 'group_2', 'group_3', ...friendFavGroups.map(group => group.name)])];
    
    // Build favorites in a temporary map. Do not clear the last known map until
    // every group page succeeds; a partial response must never look like an
    // authoritative "not favorited" result.
    await Promise.all(favoriteGroups.map(async group => {
      let offset = 0;
      while (true) {
        if (!isRefreshCurrent()) return;
        let r;
        try {
          r = await apiCall(`/api/vrc/favorites?type=friend&tag=${group}&n=100&offset=${offset}`, { noCache: true, noDedupe: true });
        } catch (_) {
          favoriteRefreshFailed = true;
          return;
        }
        if (!r.ok) { favoriteRefreshFailed = true; return; }
        let batch;
        try { batch = await r.json(); } catch (_) { favoriteRefreshFailed = true; return; }
        if (!Array.isArray(batch)) { favoriteRefreshFailed = true; return; }
        if (!batch.length) break;
        if (!isRefreshCurrent()) return;
        batch.forEach(fav => {
          if (!fav || !fav.favoriteId || !fav.id || isFriendRemoved(fav.favoriteId)) return;
          // VRChat shape: favoriteId is the target user ID; id is the
          // favorite-record ID used by DELETE /favorites/{id}.
          const entry = nextFriendFavoriteIdMap.get(fav.favoriteId);
          if (entry) {
            if (!entry.tags.includes(group)) entry.tags.push(group);
          } else {
            nextFriendFavoriteIdMap.set(fav.favoriteId, { favoriteId: fav.id, tags: [group] });
          }
        });
        if (batch.length < 100) break;
        offset += 100;
      }
    }));
    if (!isRefreshCurrent()) return;
    if (favoriteRefreshFailed) {
      console.warn('Friend favorite refresh incomplete; retaining previous map');
    }

    // Favorites are not friendship evidence: /users/{id} still resolves after
    // unfriend, and upstream favorite records can outlive the relationship.
    offlineFriendSnapshotComplete = await fetchFriendPages(true);
    if (!isRefreshCurrent()) return;
    let membership = null;
    try { membership = await readFriendMembership(session, isRefreshCurrent); }
    catch (error) { if (isRefreshCurrent()) console.warn('Friend membership unavailable:', error.message); }
    if (!isRefreshCurrent()) return;
    const complete = onlineFriendSnapshotComplete && offlineFriendSnapshotComplete && !!membership;
    if (complete) {
      friendMembershipSnapshot = membership;
      for (const id of membership.ids) authoritativeFriendIds.add(id);
      allFriends = allFriends.filter(friend => membership.ids.has(friend.id) && !isFriendRemoved(friend.id));
      const missing = [...membership.ids].filter(id => !allFriends.some(friend => friend.id === id));
      for (let i = 0; i < missing.length; i += 8) {
        const chunk = missing.slice(i, i + 8);
        const results = await Promise.allSettled(chunk.map(async id => {
          const response = await apiCall(`/api/vrc/users/${encodeURIComponent(id)}`, { noCache: true, noDedupe: true });
          if (!isRefreshCurrent() || !response.ok) return null;
          const user = await response.json();
          return isRefreshCurrent() && user?.id === id ? user : null;
        }));
        if (!isRefreshCurrent()) return;
        updateFriendBatch(results.filter(result => result.status === 'fulfilled' && result.value).map(result => result.value));
      }
      for (const id of missing) {
        if (!isFriendRemoved(id) && !allFriends.some(friend => friend.id === id)) {
          allFriends.push({ id, displayName: id, state: 'unknown', status: 'unknown', isFriend: true });
        }
      }
    }
    if (!favoriteRefreshFailed) {
      friendFavoriteIdMap = new Map([...nextFriendFavoriteIdMap.entries()]
        .filter(([id]) => !isFriendRemoved(id) && (!complete || membership.ids.has(id))));
    }
    if (_filterDebounceTimer) { clearTimeout(_filterDebounceTimer); _filterDebounceTimer = null; }
    filterFriends();
    await persistFriendListCache(session, isRefreshCurrent, allFriends,
      favoriteRefreshFailed ? null : friendFavoriteIdMap, complete ? Date.now() : 0);
    if (!isRefreshCurrent()) return;
    if (statsEl) statsEl.textContent = t('friend.totalFriends', { count: allFriends.length });
    friendLogMsg(t(complete && !favoriteRefreshFailed ? 'log.friendsSynced' : 'log.friendsSyncError'),
      complete && !favoriteRefreshFailed ? 'success' : 'error');
  } catch (error) {
    if (!isRefreshCurrent() || isAbortError(error)) return;
    console.error('Fetch error:', error);
    friendLogMsg(t('log.friendsSyncError'), 'error');
  } finally {
    if (_filterDebounceTimer) clearTimeout(_filterDebounceTimer);
  }
}

async function fetchNotifications() {
  const el = document.getElementById('notificationList');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:40px;color:rgba(255,255,255,0.3);">' + escHtml(t('loading')) + '</div>';
  try {
    const r = await apiCall('/api/vrc/auth/user/notifications');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const notifications = await r.json();
    
    // Sort notifications: unread first, then newest
    notifications.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));

    const activeCount = notifications.filter(n => !n.seen).length;

    if (!notifications || !notifications.length) {
      el.innerHTML = '<div style="text-align:center;padding:40px;color:rgba(255,255,255,0.3);">' + escHtml(t('friend.noNotifications')) + '</div>';
      updateNotificationBadge(0);
      return;
    }

    updateNotificationBadge(activeCount);

    el.innerHTML = notifications.map(n => {
      const isUnread = !n.seen;
      const date = new Date(n.created_at).toLocaleString(getLocale(), {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
      const sender = n.senderName || t('friend.system');

      let typeLabel = '';
      let actions = `<button class="btn btn-secondary btn-xs" onclick="seeNotification('${escJsAttr(n.id)}')">${escHtml(t('friend.markRead'))}</button>`;

      if (n.type === 'friendRequest') {
        typeLabel = t('friend.notifFriendRequest');
        actions = `<button class="btn btn-primary btn-xs" onclick="handleNotification('${escJsAttr(n.id)}','accept')">${escHtml(t('friend.accept'))}</button>
                   <button class="btn btn-secondary btn-xs" onclick="handleNotification('${escJsAttr(n.id)}','hide')">${escHtml(t('friend.ignore'))}</button>`;
      } else if (n.type === 'groupInvite') {
        typeLabel = t('friend.notifGroupInvite');
        actions = `<button class="btn btn-primary btn-xs" onclick="handleNotification('${escJsAttr(n.id)}','accept')">${escHtml(t('friend.accept'))}</button>
                   <button class="btn btn-secondary btn-xs" onclick="handleNotification('${escJsAttr(n.id)}','hide')">${escHtml(t('friend.ignore'))}</button>`;
      } else if (n.type === 'invite') {
        typeLabel = t('friend.notifRoomInvite');
      } else if (n.type === 'requestInvite') {
        typeLabel = t('friend.notifRequestInvite');
      }

      return `<div class="friend-card" style="margin-bottom:8px; border-left: 3px solid ${isUnread ? 'var(--accent)' : 'transparent'};">
        <div style="flex:1;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <span style="font-size:0.7em;font-weight:700;color:var(--accent-light);">${typeLabel}</span>
            <span style="font-size:0.65em;color:var(--text-muted);">${date}</span>
          </div>
          <div style="font-size:0.85em;font-weight:500;">${escHtml(t('friend.notifFrom'))}<span style="color:var(--text-primary); cursor:pointer;" onclick="openFriendProfileById('${escJsAttr(n.senderUserId)}')">${escHtml(sender)}</span></div>
          ${n.message ? `<div style="font-size:0.75em;color:var(--text-secondary);margin-top:4px;background:rgba(255,255,255,0.03);padding:6px;border-radius:4px;">${escHtml(n.message)}</div>` : ''}
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          ${actions}
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    if (isAbortError(e)) return;
    el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--error);">' + escHtml(t('toast.loadFailMsg', {msg: e.message})) + '</div>';
  }
}

async function handleNotification(id, action) {
  try {
    let url = `/api/vrc/auth/user/notifications/${id}/${action}`;
    const r = await apiCall(url, { method: 'PUT' });
    if (!r.ok) throw new Error(await r.text());
    const label = action === 'accept' ? t('friend.accept') : (action === 'hide' ? t('friend.ignore') : t('friend.actionRead'));
    logMsg(t('log.notifHandled', {label: label}), 'success');
    fetchNotifications();
  } catch(e) {
    showToast(t('toast.opFailMsg', {msg: e.message}), 'error');
  }
}

async function seeNotification(id) {
  handleNotification(id, 'see');
}

async function seeAllNotifications() {
  if (!confirm(t('confirm.markAllRead'))) return;
  try {
    const r = await apiCall('/api/vrc/auth/user/notifications/clear', { method: 'PUT' });
    if (!r.ok) throw new Error('Failed to clear notifications');
    fetchNotifications();
  } catch(e) {
     showToast(t('toast.opFailMsg', {msg: e.message}), 'error');
  }
}

function updateNotificationBadge(count) {
  const btn = document.getElementById('friendCatNotifications');
  if (!btn) return;
  if (count > 0) {
    btn.innerHTML = t('friend.notificationsBadge', {count: count});
  } else {
    btn.innerHTML = t('friend.notifications');
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
        // Token rejected — clear session and redirect to login immediately.
        // Previously we only cleared vrcAuth and left the UI in a broken state
        // where the main app was visible but every API call returned 401.
        vrcAuth = '';
        try { localStorage.removeItem('vrc_auth'); } catch (_) {}
        // Force back to login page
        const mainApp = document.getElementById('mainApp');
        const loginPage = document.getElementById('loginPage');
        if (mainApp) mainApp.classList.add('hidden');
        if (loginPage) loginPage.classList.remove('hidden');
        const errEl = document.getElementById('login-error');
        if (errEl) { errEl.textContent = 'Session expired, please login again'; errEl.style.display = 'block'; }
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
  const stubEl = { dataset: { friend: escAttrJson({ id: userId, displayName: t('friend.loadingName'), state: 'offline', _loading: true }) } };
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
  let list     = allFriends.filter(friend => !isFriendRemoved(friend.id));

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
    el.innerHTML = '<div style="text-align:center;padding:40px;color:rgba(255,255,255,0.3);"><i class="fa-solid fa-user"></i> ‍<i class="fa-solid fa-handshake"></i> ‍<i class="fa-solid fa-user"></i> <br><br>' + escHtml(t('friend.noFriends')) + '</div>';
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
    html += sectionDiv('<i class="fa-solid fa-user-group"></i> ', t('friend.groupedInstances'), '#86efac', true);
    for (const [loc, friends] of joinableGroups) {
      const isMine = myLoc && loc === myLoc;
      const isMineTag = isMine ? ' <span style="font-size:0.85em;background:rgba(255, 255, 255, 0.3);color:#d4d4d8;padding:1px 6px;border-radius:4px;"><i class="fa-solid fa-location-dot"></i> ' + escHtml(t('friend.youAreHere')) + '</span>' : '';
      const isPrivateLoc = loc === 'private' || loc.includes('~private');
      const groupInviteBtn = isPrivateLoc ? '' : `<button class="btn btn-xs" onclick="event.stopPropagation();inviteSelf('${escJsAttr(loc)}')" style="padding:2px 8px;font-size:0.8em;border-radius:4px;background:#86efac22;color:#86efac;border:1px solid #86efac44;cursor:pointer;">${escHtml(t('friend.inviteSelf'))}</button>`;
      
      html += `<div class="loc-group-header" id="loc_${loc.split(':')[0]}" data-loc="${escHtml(loc)}" style="display:flex;align-items:center;gap:6px;padding:6px 10px;margin:4px 0 2px;background:rgba(134,239,172,0.06);border-left:2px solid #86efac;border-radius:0 6px 6px 0;font-size:0.75em;color:#86efac;">` +
        `<span><i class="fa-solid fa-user-group"></i> ${t('friend.friendsHere', {count: friends.length})}</span>` +
        `<span style="opacity:0.6;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" id="lgn_${loc.split(':')[0]}">${escHtml(t('loading'))}</span>` +
        isMineTag + groupInviteBtn + '</div>';
      html += friends.map(f => friendCardHtml(f)).join('');
    }
  }

  // 2. Joinable Solo
  if (joinableSolo.length) {
    html += sectionDiv('<i class="fa-solid fa-gamepad"></i> ', t('friend.inGameJoinable'), '#60a5fa', html === '');
    for (const [loc, friends] of joinableSolo) {
      html += friends.map(f => friendCardHtml(f)).join('');
    }
  }

  // 3. Private Rooms (Grouped)
  if (privateInsts.length) {
    html += sectionDiv('<i class="fa-solid fa-lock"></i> ', t('friend.privateNotJoinable'), '#fbbf24', html === '');
    for (const [loc, friends] of privateInsts) {
      if (friends.length > 1) {
        // No data-loc on private headers — world name resolution is not applicable
        html += `<div class="loc-group-header" id="loc_${loc.split(':')[0]}" style="display:flex;align-items:center;gap:6px;padding:6px 10px;margin:4px 0 2px;background:rgba(251,191,36,0.06);border-left:2px solid #fbbf24;border-radius:0 6px 6px 0;font-size:0.75em;color:#fbbf24;">` +
          `<span><i class="fa-solid fa-user-group"></i> ${t('friend.friendsHere', {count: friends.length})}</span>` +
          `<span style="opacity:0.6;flex:1;">${escHtml(t('friend.privateRoomLabel'))}</span>` +
          '</div>';
      }
      html += friends.map(f => friendCardHtml(f)).join('');
    }
  }

  // 4. Web Online
  if (webOnline.length) {
    html += sectionDiv('<i class="fa-solid fa-globe"></i> ', t('stat.webOnline'), 'var(--text-muted)', html === '');
    html += webOnline.map(f => friendCardHtml(f)).join('');
  }

  // 5. Offline
  if (offline.length) {
    html += sectionDiv('💤', t('stat.offline'), 'var(--text-muted)', false);
    html += offline.map(f => friendCardHtml(f)).join('');
  }

  el.innerHTML = html;
  observeImages(el);

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
  let locationText = t('stat.offline');
  const locSpanId = 'loc_' + (f.id || '').replace(/[^a-zA-Z0-9_-]/g,'');
  if (!loc.isOffline) {
    if (loc.isPrivate) locationText = t('friend.privateRoom');
    else if (loc.isTraveling) locationText = t('friend.traveling');
    else locationText = t('loading');
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
        <button class="btn btn-xs" onclick="event.stopPropagation();inviteSelf('${escJsAttr(f.location)}')" style="padding:2px 6px;font-size:0.7em;border-radius:4px;background:rgba(134,239,172,0.1);color:#4ade80;border:1px solid rgba(134,239,172,0.2);cursor:pointer;" title="${t('friend.inviteSelfTitle')}"><i class="fa-solid fa-envelope"></i> </button>
      </div>` : '';

    return `<div class="friend-card" onclick="openFriendProfile(this);" data-friend="${fJson}">
      <div class="friend-avatar-wrap">
        ${thumb ? `<img ${imageSrcAttrs(thumb)} alt="" onerror="this.style.display=\'none\'">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:1.3em;"><i class="fa-solid fa-user"></i> </div>'}
        <span class="friend-status-dot ${statusCss}"></span>
      </div>
      <div class="friend-info">
        <div class="friend-name" style="color:${trust.color};">${escHtml(f.displayName||'')} <span style="font-size:0.75em;opacity:0.7;">${langs}</span></div>
        <div class="friend-location" style="display:flex;align-items:center;gap:4px;">
          <span style="font-weight:600;color:var(--text-primary);">${getStatusLabel(f)}</span>
          <span style="opacity:0.6;">|</span>
          ${(f.location && f.location !== 'offline' && f.location !== 'private' && f.location.startsWith('wrld_'))
              ? `<a href="#" id="${locSpanId}" onclick="openInstanceDetail('${escJsAttr(f.location)}'); event.stopPropagation(); event.preventDefault();" style="color:var(--accent-light);text-decoration:none;" title="${t('friend.viewInstanceDetails')}">${locationText}</a>`
              : `<span>${(f.state==='online' && f.statusDescription) ? escHtml(f.statusDescription) : locationText}</span>`}
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

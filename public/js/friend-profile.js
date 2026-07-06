/*
 * VRCW — friend-profile.js
 * 好友资料弹窗/共同好友群组/好友模型/增删好友
 *
 * 注意：本项目为「经典脚本」(非 ES module)，全部按顺序加载、共享全局作用域。
 * 函数声明会提升为全局，跨文件调用没问题；请勿改为 type="module"。
 */
function openFriendProfile(el) {
  window._fpIsSelf = false;
  // Invalidate any in-flight avatar-detail async tail so it doesn't silently
  // repaint the avatar modal (and fire fav-count network calls) behind this
  // friend profile. The two systems use separate tokens (_avatarDetailActiveToken
  // vs _fpSeq); without this, opening a friend profile from an avatar detail's
  // author link leaves the avatar tail's isUiTokenCurrent() check true.
  window._avatarDetailActiveToken = null;
  const f = parseAttrJson(el.dataset.friend);
  currentFriendProfile = f;
  // Race-condition token: bumped on every modal-open/refresh. Async tail fetches
  // (profile enrich, avatars/groups/worlds tab loaders) capture this and bail if
  // the user has since opened a different friend. Without it, "I clicked B but
  // got A's data" happens because A's slower /users/{id} resolves last and writes
  // into currentFriendProfile, then B's tab loaders read the wrong global.
  const fpSeq = (window._fpSeq = (window._fpSeq || 0) + 1);
  window._fpCurrentSeq = fpSeq;
  const detailCtrl = beginScopedAbort('friendProfile');
  const modal = document.getElementById('friendProfileModal');
  if (!modal) return;

  // Always render immediately with what we have, then upgrade with full profile
  modal.style.zIndex = modalZTop();
  if (modal.dataset.scrollLocked !== '1') { lockBodyScroll(); modal.dataset.scrollLocked = '1'; }
  _renderFriendProfileUI(f, modal);

  // Fetch full profile if date_joined or tags are missing (friends list returns LimitedUser)
  if (f.id && (!f.date_joined || !f.tags)) {
    apiCall('/api/vrc/users/' + f.id, { signal: detailCtrl.signal, noDedupe: true }).then(r => r.ok ? r.json() : null).then(full => {
      // Skip if user opened a different friend in the meantime.
      if (window._fpCurrentSeq !== fpSeq || !isScopedAbortCurrent('friendProfile', detailCtrl)) return;
      if (full && full.id) {
        currentFriendProfile = Object.assign({}, f, full);
        _renderFriendProfileUI(currentFriendProfile, modal);
      }
    }).catch(() => {});
  }
}

function getFriendProfileActionState(f) {
  const id = (f && f.id) || '';
  const myId = (typeof currentUserId !== 'undefined' && currentUserId) || (window.myProfileData && window.myProfileData.id) || '';
  const hasLocation = !!(f && f.location && f.location.startsWith('wrld_'));
  const isOnline = !!(f && (f.state === 'online' || (f.location && f.location !== 'offline')));
  const isFriend = !!(f && (f.isFriend || (window.allFriends && window.allFriends.some(af => af.id === id))));
  const isJoinable = !!(f && hasLocation
    && !f.location.includes('~private')
    && f.location !== 'traveling'
    && f.location !== 'offline'
    && f.location !== 'private');

  const hasModeration = type => myModerations.some(m => m.moderated === id && m.type === type);
  const isFriendFaved = isFriend && friendFavoriteIdMap.has(id);

  return {
    id,
    isSelf: !!id && id === myId,
    isFriend,
    isOnline,
    isJoinable,
    isFriendFaved,
    isBlocked: hasModeration('block'),
    isMuted: hasModeration('mute'),
    isShown: hasModeration('showAvatar'),
    isHidden: hasModeration('hideAvatar'),
    isInteractOff: hasModeration('interactOff'),
    friendRequestPending: !!(f && f.friendRequestPending),
  };
}


function _renderFriendProfileUI(f, modal) {
  if (!f) return;
  const id = f.id || '';
  const name = f.displayName || '';
  const fpState = getFriendProfileActionState(f);
  const { isSelf, isFriend, isBlocked, isMuted } = fpState;

  // Show modal and ensure it's on top
  modal.classList.remove('hidden');

  const bigImg = proxyImg(f.profilePicOverride||f.profilePicOverrideThumbnail||f.userIcon||f.currentAvatarThumbnailImageUrl||'');
  const avatarThumbUrl = f.currentAvatarThumbnailImageUrl || '';

  document.getElementById('fpBannerBg').src = bigImg;
  document.getElementById('fpAvatar').src   = bigImg;

  // Hide avatar thumb container when no URL
  const thumbWrap = document.getElementById('fpAvatarThumbWrap');
  if (thumbWrap) thumbWrap.style.display = avatarThumbUrl ? '' : 'none';
  document.getElementById('fpAvatarThumb').src = proxyImg(avatarThumbUrl);

  const trust     = getTrustInfo(f.tags||[]);
  const statusCss = {active:'online','join me':'join-me','ask me':'ask-me',busy:'busy',offline:'offline'}[f.status]||'online';
  const sdot = document.getElementById('fpStatusDot');
  sdot.className  = `friend-status-dot ${statusCss}`;
  sdot.style.cssText = 'position:static;width:11px;height:11px;flex-shrink:0;';
  document.getElementById('fpName').textContent = f.displayName||'';
  const vrcPlusEl = document.getElementById('fpVrcPlus');
  if (vrcPlusEl) vrcPlusEl.style.display = isVRCPlus(f.tags||[]) ? '' : 'none';
  document.getElementById('fpPronounsEl').textContent = f.pronouns ? `(${f.pronouns})` : '';
  const langsEl = document.getElementById('fpLangsEl');
  if (langsEl) langsEl.textContent = getLanguages(f.tags||[]).join(' ');
  const userEl = document.getElementById('fpUsername');
  if (userEl) userEl.textContent = f.username||'';

  const tb = document.getElementById('fpTrustBadge');
  tb.textContent = trust.label;
  tb.style.cssText = `background:${trust.color}22;color:${trust.color};border:1px solid ${trust.color}55;font-size:0.68em;font-weight:600;padding:3px 10px;border-radius:99px;`;
  const ab = document.getElementById('fpAgeBadge');
  if (ab) ab.style.display = f.ageVerificationStatus==='18+' ? '' : 'none';

  const modBadge = document.getElementById('fpModBadge');
  if (modBadge) {
    if (isBlocked) {
      modBadge.style.display = '';
      modBadge.innerHTML = t('friend.blocked');
      modBadge.style.background = 'rgba(239, 68, 68, 0.2)';
      modBadge.style.color = '#ef4444';
      modBadge.style.border = '1px solid rgba(239, 68, 68, 0.4)';
    } else if (isMuted) {
      modBadge.style.display = '';
      modBadge.innerHTML = t('friend.muted');
      modBadge.style.background = 'rgba(245, 158, 11, 0.2)';
      modBadge.style.color = '#f59e0b';
      modBadge.style.border = '1px solid rgba(245, 158, 11, 0.4)';
    } else {
      modBadge.style.display = 'none';
    }
  }
  const platb = document.getElementById('fpPlatformBadge');
  if (platb) platb.innerHTML = getPlatformEmoji(f.last_platform);

  const showcased = (f.badges||[]).filter(b=>b.showcased).slice(0,8);
  const bdRow = document.getElementById('fpBadgesRow');
  if (bdRow) bdRow.innerHTML = showcased.map(b=>
    `<img src="${escHtml(b.badgeImageUrl||'')}" title="${escHtml(b.badgeName||'')}" style="width:30px;height:30px;border-radius:5px;" onerror="this.style.display='none'">`
  ).join('') || `<span style="font-size:0.75em;color:var(--text-muted);">${t('friend.noShowcasedBadges')}</span>`;

  // Bug#1 fix: show formatted location
  const loc = parseLocation(f.location);
  const locSection = document.getElementById('fpLocationSection');
  const fpWorldInfo = document.getElementById('fpWorldInfo');
  
  const myLoc = (window.myProfileData && window.myProfileData.location) || '';
  const isMine = f.location && myLoc && f.location === myLoc && f.location !== 'offline' && f.location !== 'private';
  const isMineTag = isMine ? ` <span style="font-size:0.85em;background:rgba(255, 255, 255, 0.3);color:#d4d4d8;padding:2px 6px;border-radius:4px;margin-left:6px;vertical-align:middle;"><i class="fa-solid fa-location-dot"></i> ${t('friend.youAreHere')}</span>` : '';

  if (loc.isOffline) {
    locSection.style.display = 'none';
  } else if (loc.isPrivate || f.location === 'private') {
    locSection.style.display = '';
    fpWorldInfo.innerHTML = `<span style="opacity:0.8;">${t('friend.privateRoom')}</span>`;
  } else if (loc.isTraveling || f.location === 'traveling') {
    locSection.style.display = '';
    fpWorldInfo.innerHTML = `<span style="opacity:0.8;">${t('friend.travelingToWorld')}</span>`;
  } else {
    locSection.style.display = '';
    fpWorldInfo.innerHTML = t('friend.loadingLocation') + isMineTag;
    getLocationDisplay(f.location).then(txt => { 
      // If they have a valid world location and it's not private, they are joinable
      const isJoinable = !f.location.includes('~private');
      const btns = isJoinable ? `
        <button onclick="inviteSelf('${escJsAttr(f.location)}')" class="btn btn-xs" style="background:rgba(134,239,172,0.1);color:#4ade80;border:1px solid rgba(134,239,172,0.2);padding:2px 8px;border-radius:4px;font-size:0.75em;cursor:pointer;margin-left:8px;vertical-align:middle;" title="${t('friend.inviteSelfTitle')}"><i class="fa-solid fa-envelope"></i> ${t('friend.inviteSelf')}</button>
      ` : '';
      fpWorldInfo.innerHTML = `<a href="#" onclick="openInstanceDetail('${escJsAttr(f.location)}'); event.preventDefault();" style="color:inherit;text-decoration:none;border-bottom:1px dashed var(--accent-light);vertical-align:middle;">${txt}</a>` + isMineTag + btns; 
    }).catch(()=>{ fpWorldInfo.innerHTML = escHtml(f.location||'') + isMineTag; });
  }

  document.getElementById('fpStatusDesc').innerHTML = `<span style="font-weight:600;color:var(--text-primary);">${getStatusLabel(f)}</span> <span style="opacity:0.6">|</span> ` + escHtml(f.state==='offline' ? t('stat.offline') : (f.statusDescription||f.status||'').replace(/\\n/g, String.fromCharCode(10)));
  const bioSection = document.getElementById('fpBioSection');
  if (f.bio) { bioSection.style.display=''; document.getElementById('fpBio').textContent=(f.bio||'').replace(/\\n/g, String.fromCharCode(10)); }
  else bioSection.style.display='none';

  // bioLinks — array of URL strings the user set on their VRChat profile page
  const linksSection = document.getElementById('fpLinksSection');
  const linksContainer = document.getElementById('fpLinks');
  const bioLinks = Array.isArray(f.bioLinks) ? f.bioLinks.filter(l => l && l.trim()) : [];
  if (bioLinks.length > 0) {
    linksSection.style.display = '';
    linksContainer.innerHTML = bioLinks.map(link => {
      const safeLink = escHtml(link);
      const safeHref = /^https?:\/\//i.test(link) ? safeLink : 'https://' + safeLink;
      let icon = 'fa-solid fa-link';
      if (/twitter\.com|x\.com/i.test(link))        icon = 'fa-brands fa-x-twitter';
      else if (/twitch\.tv/i.test(link))             icon = 'fa-brands fa-twitch';
      else if (/youtube\.com|youtu\.be/i.test(link)) icon = 'fa-brands fa-youtube';
      else if (/discord\.gg|discord\.com/i.test(link)) icon = 'fa-brands fa-discord';
      else if (/patreon\.com/i.test(link))           icon = 'fa-brands fa-patreon';
      else if (/github\.com/i.test(link))            icon = 'fa-brands fa-github';
      else if (/instagram\.com/i.test(link))         icon = 'fa-brands fa-instagram';
      return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);font-size:0.78em;text-decoration:none;max-width:200px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;" title="${safeLink}"><i class="${icon}" style="flex-shrink:0;"></i><span style="overflow:hidden;text-overflow:ellipsis;">${safeLink.replace(/^https?:\/\//i,'')}</span></a>`;
    }).join('');
  } else {
    linksSection.style.display = 'none';
  }

  // Load Groups Summary (Represented & Showcased)
  _loadFriendProfileGroups(f.id, isFriend);

  const statField = (label, val, placeholder = '–') =>
    `<div class="fp-stat-item"><div class="fp-stat-label">${label}</div><div class="fp-stat-value">${escHtml(val||'')||placeholder}</div></div>`;
  
  // Format Date Joined (Account Creation)
  let joinedStr = f.date_joined || '';
  if (joinedStr) {
    const d = new Date(joinedStr);
    joinedStr = d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  } else {
    joinedStr = t('friend.dateJoinedUnknown');
  }

  document.getElementById('fpStatsGrid').innerHTML =
    statField(t('friend.accountCreatedDate'), joinedStr) +
    statField(t('field.lastActivity'), f.last_activity ? new Date(f.last_activity).toLocaleString(getLocale(),{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '') +
    statField(t('friend.allowAvatarCopy'), f.allowAvatarCopying ? t('label.allowed') : t('label.disallowed'));

  document.getElementById('fpUserId').innerHTML =
    `<span style="font-family:monospace;font-size:0.9em;">${escHtml(f.id||'')}</span>
    <button onclick="navigator.clipboard.writeText('${escJsAttr(f.id||'')}').then(()=>this.textContent='✓')" style="background:none;border:1px solid var(--border);color:var(--text-muted);padding:2px 8px;border-radius:4px;cursor:pointer;font-size:0.9em;">${t('btn.copy')}</button>`;

  const isFriendFaved = fpState.isFriendFaved;
  const isOnline = fpState.isOnline;
  const friendFavBtn = isFriend
    ? `<button class="btn ${isFriendFaved?'btn-warning':'btn-secondary'}" style="font-size:0.82em;" onclick="${isFriendFaved?'toggleFriendFavorite(\''+escJsAttr(id)+'\',\''+escJsAttr(name)+'\')':'toggleFriendFavMenu(event,\''+escJsAttr(id)+'\')'}">${isFriendFaved?t('friend.favoritedIcon'):t('avatar.favoriteBtn')}</button>`
    : '';
  
  let actionButtons = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
      <button class="btn btn-secondary" style="font-size:0.82em;padding:6px 14px;" onclick="showFriendContextMenu(event)">${t('friend.actionMenu')}</button>
      ${friendFavBtn}
      <button class="btn btn-secondary" style="font-size:0.82em;" onclick="window.open('https://vrchat.com/home/user/${escJsAttr(f.id||'')}','_blank')">${t('friend.vrchatHome')}</button>
    </div>
  `;

  if (!isSelf) {
    actionButtons += `<div style="display:flex;gap:8px;flex-wrap:wrap;">`;
    if (isFriend) {
      if (isBlocked) {
        actionButtons += `<button class="btn" style="background:rgba(34,197,94,0.15);color:#4ade80;border:1px solid rgba(34,197,94,0.3);font-size:0.82em;" onclick="unblockUser('${escJsAttr(f.id||'')}','${escJsAttr(f.displayName||'')}')">${t('friend.unblock')}</button>`;
      } else {
        actionButtons += `
          <button class="btn btn-primary" style="font-size:0.82em;" onclick="sendBoop('${escJsAttr(id)}','${escJsAttr(name)}')">${t('friend.boop')}</button>
          ${isOnline ? `<button class="btn btn-success" style="font-size:0.82em;" onclick="sendInvite('${escJsAttr(id)}','${escJsAttr(name)}')">${t('friend.invite')}</button>` : ''}
          ${isOnline ? `<button class="btn btn-secondary" style="font-size:0.82em;" onclick="requestInvite('${escJsAttr(id)}','${escJsAttr(name)}')">${t('friend.requestInvite')}</button>` : ''}
        `;
      }
      if (isMuted) {
        actionButtons += `<button class="btn btn-secondary" style="font-size:0.82em;" onclick="unmuteUser('${escJsAttr(f.id||'')}','${escJsAttr(f.displayName||'')}')">${t('friend.unmute')}</button>`;
      }
      actionButtons += `<button class="btn" style="background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.3);font-size:0.82em;" onclick="deleteFriend('${escJsAttr(f.id||'')}','${escJsAttr(f.displayName||'')}')">${t('friend.deleteFriend')}</button>`;
    } else {
      if (isBlocked) {
        actionButtons += `<button class="btn" style="background:rgba(34,197,94,0.15);color:#4ade80;border:1px solid rgba(34,197,94,0.3);font-size:0.82em;" onclick="unblockUser('${escJsAttr(f.id||'')}','${escJsAttr(f.displayName||'')}')">${t('friend.unblock')}</button>`;
      } else if (fpState.friendRequestPending) {
        actionButtons += `<button class="btn btn-secondary" style="font-size:0.82em;" onclick="cancelFriendRequest('${escJsAttr(f.id||'')}','${escJsAttr(f.displayName||'')}')">${t('friend.cancelFriendRequest')}</button>`;
      } else {
        actionButtons += `<button class="btn" style="background:rgba(34,197,94,0.15);color:#4ade80;border:1px solid rgba(34,197,94,0.3);font-size:0.82em;" onclick="sendFriendRequest('${escJsAttr(f.id||'')}','${escJsAttr(f.displayName||'')}')">${t('friend.addFriend')}</button>`;
      }
      if (isMuted) {
        actionButtons += `<button class="btn btn-secondary" style="font-size:0.82em;" onclick="unmuteUser('${escJsAttr(f.id||'')}','${escJsAttr(f.displayName||'')}')">${t('friend.unmute')}</button>`;
      }
    }
    actionButtons += `</div>`;
  }

  document.getElementById('fpActions').innerHTML = actionButtons;

  // Always restore the mutual friends tab for non-self profiles
  const mutualTabBtn = document.getElementById('fpTabMutual');
  if (mutualTabBtn) mutualTabBtn.style.display = '';

  switchFriendProfileTab('info');
  modal.classList.remove('hidden');
}

function closeFriendProfile() {
  bumpUiEpoch();
  window._fpSeq = (window._fpSeq || 0) + 1;
  window._fpCurrentSeq = window._fpSeq;
  cancelScopedAbort('friendProfile');
  const modal = document.getElementById('friendProfileModal');
  if (modal) {
    modal.classList.add('hidden');
    if (modal.dataset.scrollLocked === '1') { unlockBodyScroll(); modal.dataset.scrollLocked = ''; }
  }
  currentFriendProfile = null;
  if (typeof flushPendingAvatarCardUpdates === 'function') flushPendingAvatarCardUpdates();
}

async function _loadFriendProfileGroups(userId, isFriend) {
  const gSummaryList = document.getElementById('fpGroupsSummaryList');
  const gSummarySection = document.getElementById('fpGroupsSummarySection');
  if (!gSummaryList || !gSummarySection) return;

  // Show loading state
  gSummaryList.innerHTML = `<div style="font-size:0.75em;opacity:0.5;padding:4px 0;">${t('friend.loadingGroupsDots')}</div>`;
  gSummarySection.style.display = '';

  try {
    const r = await apiCall('/api/vrc/users/' + userId + '/groups?n=50', _friendProfileApiOpts());
    if (!_isFriendProfileScopeCurrent()) return;
    if (!r.ok) throw new Error('Failed to fetch groups');
    const groups = await r.json();
    if (!_isFriendProfileScopeCurrent()) return;

    // Filter: ONLY Representing group
    const filtered = groups.filter(g => g.isRepresenting);

    // Deduplicate by groupId just in case
    const seen = new Set();
    const finalGroups = [];
    for (const g of filtered) {
      if (!seen.has(g.groupId)) {
        seen.add(g.groupId);
        finalGroups.push(g);
      }
    }

    // Sort: Representing first
    finalGroups.sort((a, b) => (b.isRepresenting ? 1 : 0) - (a.isRepresenting ? 1 : 0));

    if (finalGroups.length === 0) {
      gSummarySection.style.display = 'none';
      return;
    }

    gSummaryList.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">
      ${finalGroups.map(g => `
        <div class="group-pill" onclick="openGroupDetail('${escJsAttr(g.groupId)}')" style="cursor:pointer;display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--bg-glass);border:1px solid var(--border);border-radius:99px;font-size:0.82em;transition:all 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='var(--bg-glass)'">
          <img src="${proxyImg(g.iconUrl || g.bannerUrl || '')}" style="width:20px;height:20px;border-radius:50%;object-fit:cover;background:rgba(0,0,0,0.2);">
          <div style="display:flex;flex-direction:column;line-height:1.1;max-width:120px;">
            <span style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(g.name)}</span>
            <span style="font-size:0.7em;opacity:0.5;">${escHtml(g.shortCode)}</span>
          </div>
          ${g.isRepresenting ? `<span style="font-size:0.65em;background:rgba(52,211,153,0.2);color:#34d399;border:1px solid rgba(52,211,153,0.3);padding:1px 6px;border-radius:4px;font-weight:bold;">${t('friend.representing')}</span>` : ''}
        </div>
      `).join('')}
    </div>`;
  } catch (e) {
    if (!_isFriendProfileScopeCurrent()) return;
    console.error('Group load failed:', e);
    gSummarySection.style.display = 'none';
  }
}

function switchFriendProfileTab(tab) {
  ['info','groups','worlds','avatars','mutual'].forEach(t => {
    const btn = document.getElementById(`fpTab${t.charAt(0).toUpperCase()+t.slice(1)}`);
    if (btn) btn.classList.toggle('active', t===tab);
    const content = document.getElementById(`fp${t.charAt(0).toUpperCase()+t.slice(1)}Tab`);
    if (content) content.style.display = t===tab ? '' : 'none';
  });
  const f = currentFriendProfile;
  if (!f) return;
  // Capture the open-modal seq token; tab loaders bail if user opened another friend.
  const seq = window._fpCurrentSeq;
  if (tab === 'groups')  fetchFriendGroups(f.id, seq);
  if (tab === 'mutual')  fetchMutualFriends(f.id, 'fpMutualList', seq);
  if (tab === 'worlds')  fetchFriendWorlds(f.id, seq);
  if (tab === 'avatars') fetchFriendAvatars(f.id, seq);
}

function _friendProfileApiOpts() {
  const ctrl = scopedAbortControllers.get('friendProfile');
  return ctrl ? { signal: ctrl.signal, noDedupe: true } : { noAbort: true, noDedupe: true };
}

function _isFriendProfileScopeCurrent() {
  const ctrl = scopedAbortControllers.get('friendProfile');
  return !ctrl || isScopedAbortCurrent('friendProfile', ctrl);
}

async function fetchFriendGroups(userId, seq) {
  const el = document.getElementById('fpGroupsList');
  if (!el) return;
  el.innerHTML = `<div style="padding:20px;color:rgba(255,255,255,0.3);text-align:center;">${t('friend.loading')}</div>`;
  try {
    const r = await apiCall('/api/vrc/users/' + userId + '/groups?n=50', _friendProfileApiOpts());
    if (seq != null && window._fpCurrentSeq !== seq) return; // user opened another friend
    if (!_isFriendProfileScopeCurrent()) return;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const groups = await r.json();
    if (seq != null && window._fpCurrentSeq !== seq) return;
    if (!_isFriendProfileScopeCurrent()) return;

    if (!groups || !groups.length) { 
      el.innerHTML = `<div style="padding:20px;color:rgba(255,255,255,0.3);">${t('friend.noPublicGroups')}</div>`;
      return; 
    }

    // Separate: owned / mutual / remaining (following VRCX pattern)
    const owned = [];
    const mutual = [];
    const remaining = [];
    for (const g of groups) {
      if (g.ownerId === userId || g.userId === userId) owned.push(g);
      else if (g.mutualGroup) mutual.push(g);
      else remaining.push(g);
    }

    const renderGroup = (g, badge) => {
      const badgeHtml = badge || '';
      return `<div onclick="openGroupDetail('${escJsAttr(g.groupId||g.id)}')" style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-glass);border-radius:8px;font-size:0.82em;cursor:pointer;border:1px solid var(--border);margin-bottom:6px;">
        <img src="${escHtml(proxyImg(g.iconUrl||g.bannerUrl||''))}" style="width:36px;height:36px;border-radius:6px;object-fit:cover;" onerror="this.style.display=\'none\'">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:500;">${escHtml(g.name||'')}${badgeHtml}</div>
          <div style="font-size:0.8em;color:var(--text-muted);">.${escHtml(g.shortCode||'')} \u00b7 \ud83d\udc65 ${g.memberCount||0}</div>
        </div>
      </div>`;
    };

    let html = '';
    if (owned.length) {
      html += `<div style="font-size:0.72em;font-weight:700;letter-spacing:.05em;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px;">${t('friend.createdGroups', {count: owned.length})}</div>`;
      html += owned.map(g => renderGroup(g, ` <span style="font-size:0.65em;background:rgba(255,255,255,0.13);color:#d4d4d8;border:1px solid rgba(255,255,255,0.27);padding:2px 5px;border-radius:99px;">${t('friend.creator')}</span>`)).join('');
      html += '<div style="border-top:1px solid var(--border);margin:10px 0;"></div>';
    }
    if (mutual.length && !window._fpIsSelf) {
      html += `<div style="font-size:0.72em;font-weight:700;letter-spacing:.05em;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px;">${t('friend.mutualGroups', {count: mutual.length})}</div>`;
      html += mutual.map(g => renderGroup(g, ` <span style="font-size:0.65em;background:rgba(34,197,94,0.15);color:#86efac;border:1px solid rgba(34,197,94,0.3);padding:2px 5px;border-radius:99px;">${t('friend.mutual')}</span>`)).join('');
      html += '<div style="border-top:1px solid var(--border);margin:10px 0;"></div>';
    }
    if (remaining.length) {
      html += `<div style="font-size:0.72em;font-weight:700;letter-spacing:.05em;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px;">${t('friend.otherGroups', {count: remaining.length})}</div>`;
      html += remaining.map(g => renderGroup(g, '')).join('');
    }
    el.innerHTML = html;
  } catch(e) {
    if (!_isFriendProfileScopeCurrent()) return;
    el.innerHTML = '<div style="padding:20px;color:var(--error);">' + escHtml(e.message) + '</div>'; 
  }
}


async function fetchFriendWorlds(userId, seq) {
  const el = document.getElementById('fpWorldsList');
  if(!el) return;
  el.innerHTML = `<div style="grid-column:1/-1;padding:20px;color:rgba(255,255,255,0.3);text-align:center;">${t('friend.loading')}</div>`;
  try {
    const r = await apiCall(`/api/vrc/worlds?userId=${userId}&releaseStatus=public&n=20&sort=updated`, _friendProfileApiOpts());
    if (seq != null && window._fpCurrentSeq !== seq) return;
    if (!_isFriendProfileScopeCurrent()) return;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const worlds = await r.json();
    if (seq != null && window._fpCurrentSeq !== seq) return;
    if (!_isFriendProfileScopeCurrent()) return;
    if (!worlds || !worlds.length) { el.innerHTML = `<div style="grid-column:1/-1;padding:20px;color:rgba(255,255,255,0.3);">${t('friend.noPublicWorlds')}</div>`; return; }
    const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    el.innerHTML = worlds.map(w => `<div class="avatar-card" style="cursor:pointer;" onclick="openWorldDetail('${escJsAttr(w.id)}')">
      <div class="avatar-thumb-wrapper img-loading">
        <img class="avatar-thumb loading" src="${BLANK}" data-src="${escHtml(proxyImg(w.thumbnailImageUrl||w.imageUrl||''))}" alt="">
        <div class="avatar-name-overlay">${escHtml(w.name||'')}</div>
      </div></div>`).join('');
    el.querySelectorAll('.avatar-thumb[data-src]').forEach(img => avatarObserver.observe(img));
  } catch(e) {
    if (!_isFriendProfileScopeCurrent()) return;
    el.innerHTML = `<div style="grid-column:1/-1;padding:20px;color:var(--error);">${escHtml(e.message)}</div>`;
  }
}

function updateAvatarNameInUI(listEl, avId, newName) {
  if (!newName || newName === 'Unknown' || newName.startsWith('Model ')) return;
  persistName(avId, newName);
  
  // Update current list object in memory
  if (window._friendAvatars) {
    const memAv = window._friendAvatars.find(a => a.id === avId);
    if (memAv) memAv.name = newName;
  }
  
  if (!listEl) return;
  const cards = listEl.querySelectorAll('.avatar-card');
  cards.forEach(card => {
    if (card.dataset.id === avId) {
      const nameEl = card.querySelector('.avatar-name-overlay');
      if (nameEl) nameEl.textContent = newName;
    }
  });
}

async function buildLocalFavoriteNameMap() {
  const map = new Map();
  try {
    const keys = await idb.keys();
    const favKeys = keys.filter(k => typeof k === 'string' && k.startsWith('avatars_avatars'));
    for (const key of favKeys) {
      const list = await idb.get(key);
      if (Array.isArray(list)) {
        list.forEach(av => {
          if (av.id && av.name && av.name !== 'Unknown') {
            map.set(av.id, av.name);
          }
        });
      }
    }
  } catch (e) { console.warn('Failed to build local name map', e); }
  return map;
}

const fpAvatarFetchCache = new Map(); // userId -> Promise

async function fetchFriendAvatars(userId, seq) {
  const el = document.getElementById('fpAvatarsList');
  if(!el) return;
  
  // Prevent duplicate concurrent loads for same user
  if (fpAvatarFetchCache.has(userId)) return fpAvatarFetchCache.get(userId);
  
  const fetchTask = (async () => {
    el.innerHTML = `<div style="grid-column:1/-1;padding:20px;color:rgba(255,255,255,0.3);text-align:center;">${t('friend.scanningDbs')}</div>`;
    
    try {
    const promises = [];
    const apiOpts = _friendProfileApiOpts();
    
    // 1. Official VRChat API (may return 401/403 for non-friends or restricted users)
    promises.push(apiCall(`/api/vrc/avatars?userId=${userId}&releaseStatus=public&n=20`, apiOpts)
      .then(async r => {
        if (!r.ok) return [];
        return await r.json() || [];
      }).catch(() => []));

    // 2. VRCX Database (via Proxy)
    promises.push(apiCall(`/api/proxy?url=${encodeURIComponent(`https://vrcx.vrcdb.com/avatars/Avatar/VRCX?authorId=${userId}`)}`, apiOpts)
      .then(async r => {
        if (!r.ok) return [];
        return await r.json() || [];
      }).catch(() => []));

    // 3. AvatarRecovery (via Proxy)
    promises.push(apiCall(`/api/proxy?url=${encodeURIComponent(`https://api.avatarrecovery.com/Avatar/vrcx?authorId=${userId}`)}`, apiOpts)
      .then(async r => {
        if (!r.ok) return [];
        return await r.json() || [];
      }).catch(() => []));
      
    // 4. AvtrDB (V3, as used in VRCX) — routed through the worker proxy so it
    // shares the SSRF allowlist and the page CSP's connect-src 'self'.
    promises.push(apiCall(`/api/proxy?url=${encodeURIComponent(`https://api.avtrdb.com/v3/avatar/search/vrcx?authorId=${userId}&n=50`)}`, apiOpts)
      .then(async r => {
        if (!r.ok) return [];
        const data = await r.json();
        return data.avatars || data || []; // Handle both {avatars: []} and []
      }).catch(() => []));

    const results = await Promise.allSettled(promises);
    if (!_isFriendProfileScopeCurrent()) return;
    const flattenedResults = results.map(r => r.status === 'fulfilled' ? r.value : []).flat();

    // Build local name map to recover from favorites
    // We now use the global window._localNameMap which is kept in sync
    const localNameMap = window._localNameMap;

    // Merge and deduplicate
    const allAvatars = [];
    const seenIds = new Set();
    
    flattenedResults.forEach(av => {
      if (!av) return;
      const id = av.id || av.Id || av.id_vrc || '';
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        
        // Comprehensive field normalization
        let name = av.name || av.Name || av.getName || av.displayName || av.AvatarName;
        
        // Check local favorites map first
        if ((!name || name === 'Unknown') && localNameMap.has(id)) {
          name = localNameMap.get(id);
        }

        // If still no name, use ID as a fallback to avoid "Unknown" for all
        if (!name || name === 'Unknown') {
          name = `Model ${id.substring(5, 13)}`; 
        }
        
        const authorName = av.authorName || av.AuthorName || av.ownerName || av.author_name || '';
        const thumb = av.thumbnailImageUrl || av.ThumbnailImageUrl || av.thumbnail_url || av.imageUrl || av.ImageUrl || av.image_url || '';
        const fullImg = av.imageUrl || av.ImageUrl || av.image_url || av.thumbnailImageUrl || av.ThumbnailImageUrl || '';
        
        allAvatars.push({
          id,
          name: name,
          authorName: authorName,
          imageUrl: fullImg,
          thumbnailImageUrl: thumb,
          releaseStatus: av.releaseStatus || av.ReleaseStatus || av.release_status || 'public',
          version: av.version || av.Version || 0,
          unityPackages: av.unityPackages || av.UnityPackages || [],
          performance: av.performance || av.Performance || null,
          compatibility: av.compatibility || av.Compatibility || []
        });
      }
    });

    if (!allAvatars.length) { 
      // If we got NO results at all, show a specific empty message
      el.innerHTML = `<div style="grid-column:1/-1;padding:20px;color:rgba(255,255,255,0.3);text-align:center;">${t('friend.noAvatarRecords')}</div>`;
      return; 
    }
    
    // Store globally so detail modal can find them if needed
    if (seq != null && window._fpCurrentSeq !== seq) return; // user opened another friend
    if (!_isFriendProfileScopeCurrent()) return;
    window._friendAvatars = allAvatars;

    const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    el.innerHTML = allAvatars.map((av, idx) => {
        const ratings = getAvatarPlatforms(av);
        const platBadges = Array.from(ratings.keys()).map(p => {
          const label = { pc: "PC", android: "Quest", ios: "Apple" }[p] || p;
          return `<span class="avtrdb-badge" style="font-size:0.8em;padding:2px 6px;">${label}</span>`;
        }).join("");

        return `<div class="avatar-card" data-id="${av.id}" style="cursor:pointer;" onclick="displayAvatarDetail(window._friendAvatars[${idx}])">
          <div class="avatar-thumb-wrapper img-loading">
            <img class="avatar-thumb loading" src="${BLANK}" data-src="${escHtml(proxyImg(av.thumbnailImageUrl||av.imageUrl||''))}" alt="">
            <div class="avatar-name-overlay">${escHtml(av.name||'')}</div>
            <div class="avatar-plat-badges" style="position:absolute;top:6px;right:6px;display:flex;gap:4px;z-index:11;">${platBadges}</div>
          </div>
        </div>`;
    }).join('');
    
    // BACKGROUND REFRESH: Queue official verification
    allAvatars.forEach(av => {
      avatarMetadataQueue.add(av.id, (data) => {
        updateAvatarPlatformsInUI(el, av.id, data);
      });
    });
    
    el.querySelectorAll('.avatar-thumb[data-src]').forEach(img => avatarObserver.observe(img));

    // ═══════════════════════════════════════════════════════════════
    // Global Queued Background Recovery (Speed Optimized)
    // ═══════════════════════════════════════════════════════════════
    const unknownAvs = allAvatars.filter(av => !av.name || av.name.startsWith('Model ') || av.name === 'Unknown').slice(0, 50);
    
    // BURST MODE: Fire the first 5 models in parallel IMMEDIATELY (no queue)
    const burst = unknownAvs.slice(0, 5);
    const remaining = unknownAvs.slice(5);
    
    burst.forEach(async av => {
       if (localNameMap.has(av.id)) {
          updateAvatarNameInUI(el, av.id, localNameMap.get(av.id));
          return;
       }
       performSingleAvatarRecovery(av.id).then(name => {
          if (name) updateAvatarNameInUI(el, av.id, name);
       }).catch(() => {});
    });

    // Queue the rest to maintain rate limit safety
    remaining.forEach(av => {
       if (localNameMap.has(av.id)) {
          updateAvatarNameInUI(el, av.id, localNameMap.get(av.id));
          return;
       }
       avatarLookupQueue.add(av.id, (name) => {
         updateAvatarNameInUI(el, av.id, name);
       });
    });
    
  } catch(e) { 
    if (isAbortError(e)) return;
    console.error('fetchFriendAvatars error:', e);
    el.innerHTML = `<div style="grid-column:1/-1;padding:20px;color:var(--text-muted);font-size:0.85em;text-align:center;">${t('friend.loadListError', {msg: escHtml(e.message)})}</div>`;
  } finally {
    fpAvatarFetchCache.delete(userId);
  }
  })();
  
  fpAvatarFetchCache.set(userId, fetchTask);
  return fetchTask;
}

async function deleteFriend(userId, name) {
  if (!confirm(t('confirm.deleteFriend', {name: name}))) return;
  try {
    const r = await apiCall(`/api/vrc/auth/user/friends/${userId}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(await r.text());
    closeFriendProfile();
    allFriends = allFriends.filter(f => f.id !== userId);
    filterFriends();
    // Persist the trimmed list to IDB so the 60s TTL can't resurrect the
    // just-deleted friend on the next reload (saveFriendBasics is a closure
    // inside loadFriendsList, so we inline an equivalent shape here).
    try {
      const basics = allFriends.map(f => ({
        id: f.id,
        displayName: f.displayName,
        currentAvatarThumbnailImageUrl: f.currentAvatarThumbnailImageUrl,
        userIcon: f.userIcon,
        profilePicOverrideThumbnail: f.profilePicOverrideThumbnail,
        tags: f.tags,
        last_platform: f.last_platform,
        status: f.status,
        location: f.location,
        state: f.state
      }));
      await idb.set('friend_basics', basics);
      await idb.set('friend_basics_age', Date.now());
    } catch (e) { /* IDB best-effort */ }
    friendLogMsg(t('log.friendDeleted', {name: name}), 'success');
  } catch(e) { friendLogMsg(t('log.deleteFriendFail', {msg: e.message}), 'error'); }
}

async function sendFriendRequest(userId, name) {
  try {
    const r = await apiCall(`/api/vrc/user/${userId}/friendRequest`, { method: 'POST' });
    if (!r.ok) throw new Error(await r.text());
    friendLogMsg(t('log.friendReqSent', {name: name}), 'success');
    // Mark the request as pending. Don't flip isFriend — that requires the
    // other side to accept. The pending flag drives the disabled
    // "请求已发送" button on next render so the user can't double-send.
    if (currentFriendProfile && currentFriendProfile.id === userId) {
      currentFriendProfile.friendRequestPending = true;
      const modal = document.getElementById('friendProfileModal');
      if (modal && !modal.classList.contains('hidden')) {
        _renderFriendProfileUI(currentFriendProfile, modal);
      }
    }
  } catch(e) { friendLogMsg(t('log.friendReqFail', {msg: e.message}), 'error'); }
}

VRCW.registerModule('friendProfile', { openFriendProfile, getFriendProfileActionState, _renderFriendProfileUI, closeFriendProfile, switchFriendProfileTab, deleteFriend, sendFriendRequest });
renderAppVersionInfo();


// --- Avatar Integration ---
async function openCurrentAvatarDetail() {
    const f = window.currentFriendProfile;
    if (!f || !f.currentAvatar) {
        showToast(t('toast.noCurrentAvatarId'), 'error');
        return;
    }
    
    const avtrId = f.currentAvatar;
    
    try {
        const resp = await apiCall('/api/vrc/avatars/' + avtrId);
        if (!resp.ok) {
            if (resp.status === 404 || resp.status === 403) throw new Error(t('toast.avatarPrivateOrDeleted'));
            throw new Error('HTTP ' + resp.status);
        }
        const av = await resp.json();
        
        if (typeof displayAvatarDetail === 'function') {
            displayAvatarDetail(av);
        } else {
            showToast(t('toast.componentNotLoaded'), 'error');
        }
    } catch (e) {
        showToast(t('toast.avatarLoadFail', {msg: e.message}), 'error');
    }
}

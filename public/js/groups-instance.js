/*
 * VRCW — groups-instance.js
 * 群组详情/群组成员/实例占用与详情/共同群组好友
 *
 * 注意：本项目为「经典脚本」(非 ES module)，全部按顺序加载、共享全局作用域。
 * 函数声明会提升为全局，跨文件调用没问题；请勿改为 type="module"。
 */


async function loadMyGroups() {
  const el = document.getElementById('friendList');
  if (el) el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">' + escHtml(t('group.loadingGroupsDetail')) + '</div>';
  try {
    const meResp = await apiCall('/api/vrc/auth/user');
    const me = await meResp.json();
    const r = await apiCall('/api/vrc/users/' + me.id + '/groups');
    if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + await r.text());
    const groups = await r.json();
    myGroupsCache = groups || [];
    if (!groups || !groups.length) {
      el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">' + escHtml(t('group.noGroups')) + '</div>';
      return;
    }
    // Sort: own groups first, then rest
    const owned = groups.filter(g => g.ownerId === me.id || g.userId === me.id);
    const other = groups.filter(g => g.ownerId !== me.id && g.userId !== me.id);
    let html = '';
    if (owned.length) {
      html += '<div style="padding:8px 0 4px;font-size:0.75em;font-weight:700;color:var(--text-muted);letter-spacing:0.05em;text-transform:uppercase;">' + escHtml(t('group.myCreatedGroups')) + '</div>';
      html += owned.map(g => groupCardHtml(g, me.id)).join('');
      html += '<div style="margin:8px 0;border-top:1px solid var(--border);"></div>';
    }
    html += other.map(g => groupCardHtml(g, me.id)).join('');
    el.innerHTML = html;
    document.getElementById('friendStats').textContent = t('group.totalGroupsCount', {count: groups.length});
  } catch(e) {
    if (isAbortError(e)) return;
    if (el) el.innerHTML = '<div style="color:var(--error);padding:20px;">' + escHtml(t('toast.loadFailMsg', {msg: e.message})) + '</div>';
  }
}

function groupCardHtml(g, myId) {
  const isOwner = g.ownerId === myId;
  return '<div class="friend-card" onclick="openGroupDetail(' + JSON.stringify(g.groupId||g.id) + ')" style="cursor:pointer;">' +
    '<div class="friend-avatar-wrap" style="border-radius:10px;">' +
      '<img src="' + escHtml(proxyImg(g.iconUrl||'')) + '" style="border-radius:10px;object-fit:cover;" onerror="this.style.display=\'none\'">' +
    '</div>' +
    '<div class="friend-info">' +
      '<div class="friend-name">' + escHtml(g.name||'') + (isOwner ? ' <span style="font-size:0.65em;background:rgba(255,255,255,0.13);color:#d4d4d8;border:1px solid rgba(255,255,255,0.27);padding:2px 6px;border-radius:99px;">' + escHtml(t('group.owner')) + '</span>' : '') + '</div>' +
      '<div class="friend-location" style="font-size:0.78em;color:var(--text-muted);">.' + escHtml(g.shortCode||'') + ' · <i class="fa-solid fa-user-group"></i> ' + (g.memberCount||0) + '</div>' +
    '</div>' +
  '</div>';
}

async function openGroupDetail(groupId) {
  bumpUiEpoch();
  const detailToken = makeUiToken('groupDetail', groupId);
  window._groupDetailActiveToken = detailToken;
  const detailCtrl = beginScopedAbort('groupDetail');
  // Stale-DOM guard: detect old structure missing the new gdIconBox container
  // (added when icon was upgraded to 80px + fallback letter). If old DOM exists,
  // force a rebuild so users don't see the broken old icon.
  const existing = document.getElementById('groupDetailModal');
  if (existing && !existing.querySelector('#gdIconBox')) {
    existing.remove();
  }

  // Ensure group modal exists
  if (!document.getElementById('groupDetailModal')) {
    const html = `<div id="groupDetailModal" class="modal hidden" onclick="if(event.target===this)closeGroupDetail()">
      <div class="modal-content" style="max-width:560px;padding:0;overflow:hidden;">
        <div id="gdBanner" style="height:120px;background:var(--bg-secondary);background-size:cover;background-position:center;position:relative;flex-shrink:0;">
          <div style="position:absolute;inset:0;background:linear-gradient(to top,var(--bg-primary) 0%,var(--bg-primary) 20%,rgba(0,0,0,0.5) 60%,rgba(0,0,0,0.15) 100%);pointer-events:none;"></div>
          <button onclick="closeGroupDetail()" style="position:absolute;top:10px;right:10px;background:rgba(0,0,0,0.55);border:none;color:#fff;border-radius:99px;width:30px;height:30px;cursor:pointer;font-size:1rem;display:flex;align-items:center;justify-content:center;z-index:3;">\u00d7</button>
        </div>
        <!-- Icon row: MUST be a sibling of gdBanner (not nested inside the scroll
             container) so its z-index:3 actually stacks above the banner's
             position:relative layer. margin-top:-40px pulls it up into the banner. -->
        <div style="display:flex;gap:16px;align-items:flex-end;margin-top:-40px;margin-bottom:0;padding:0 24px;position:relative;z-index:3;">
          <div id="gdIconBox" style="position:relative;width:80px;height:80px;border-radius:16px;overflow:hidden;border:3px solid var(--bg-primary);background:linear-gradient(135deg,#3f3f46,#27272a);flex-shrink:0;box-shadow:0 6px 16px rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;color:#fff;font-size:2em;font-weight:700;">
            <span id="gdIconFallback" style="user-select:none;text-shadow:0 2px 4px rgba(0,0,0,0.5);"></span>
            <img id="gdIcon" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none;" onload="this.style.display='block'" onerror="this.style.display='none'">
          </div>
          <div style="flex:1;padding-bottom:4px;min-width:0;">
            <div id="gdName" style="font-size:1.15rem;font-weight:700;color:var(--text-primary);text-shadow:0 2px 6px rgba(0,0,0,0.85);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
            <div id="gdShortCode" style="font-size:0.75em;color:var(--text-muted);"></div>
          </div>
        </div>
        <div style="padding:12px 24px 24px; overflow-y:auto; max-height:calc(100vh - 220px);">
          <div id="gdStats" style="display:flex;gap:8px;flex-wrap:wrap;font-size:0.8em;color:var(--text-secondary);margin-bottom:10px;"></div>
          <div id="gdActions" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;"></div>
          <div id="gdDesc" style="font-size:0.85em;color:var(--text-secondary);line-height:1.6;max-height:180px;overflow-y:auto;white-space:pre-line;margin-bottom:16px;"></div>
          
          <div class="tab-nav" style="background:transparent;border-bottom:1px solid var(--border);margin-bottom:12px;">
            <button class="tab-btn active" onclick="switchGroupDetailTab(this, 'instances')">${escHtml(t('group.tabInstances'))}</button>
            <button class="tab-btn" onclick="switchGroupDetailTab(this, 'members')">${escHtml(t('group.tabMembers'))}</button>
          </div>
          
          <div id="gdInstances" class="group-instance-list"></div>
          <div id="gdMembers" class="group-member-list" style="display:none;"></div>
        </div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }
  const modal = document.getElementById('groupDetailModal');
  modal.style.zIndex = modalZTop();
  modal.classList.remove('hidden');
  // Lock background scroll (guard against double-lock if reopened/refreshed).
  if (!modal.dataset.scrollLocked) {
    lockBodyScroll();
    modal.dataset.scrollLocked = '1';
  }
  document.getElementById('gdName').textContent = t('loading');
  document.getElementById('gdDesc').textContent = '';
  document.getElementById('gdStats').innerHTML = '';
  document.getElementById('gdBanner').style.backgroundImage = '';
  // Reset icon: hide img, clear fallback letter; populated once group data arrives.
  const _gdIconImg = document.getElementById('gdIcon');
  const _gdIconFallback = document.getElementById('gdIconFallback');
  _gdIconImg.style.display = 'none';
  _gdIconImg.removeAttribute('src');
  _gdIconFallback.textContent = '';
  document.getElementById('gdShortCode').textContent = '';
  try {
    const r = await apiCall('/api/vrc/groups/' + groupId, { signal: detailCtrl.signal, noDedupe: true });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const g = await r.json();
    if (!isUiTokenCurrent(detailToken) || !isScopedAbortCurrent('groupDetail', detailCtrl)) return;
    document.getElementById('gdBanner').style.backgroundImage = g.bannerUrl ? 'url(' + proxyImg(g.bannerUrl) + ')' : '';
    // Group icons are nullable in VRChat API. Try iconUrl, then bannerUrl, then fall
    // back to a letter avatar (first character of group name). The <img> only shows
    // on successful load; the fallback letter sits underneath it.
    const _iconSrc = g.iconUrl || g.bannerUrl || '';
    if (_iconSrc) {
      _gdIconImg.src = proxyImg(_iconSrc);
    }
    _gdIconFallback.textContent = (g.name || '?').trim().charAt(0).toUpperCase();
    document.getElementById('gdName').textContent = g.name || '';
    document.getElementById('gdShortCode').textContent = '.' + (g.shortCode || '');
    document.getElementById('gdDesc').textContent = g.description || t('group.noDesc');
    document.getElementById('gdStats').innerHTML =
      '<span><i class="fa-solid fa-user-group"></i> ' + t('group.memberCount', {count: (g.memberCount || 0)}) + '</span>' +
      '<span style="opacity:0.3;margin:0 4px;">|</span>' +
      '<span>' + (g.joinState === 'closed' ? t('group.joinClosed') : g.joinState === 'invite' ? t('group.joinInvite') : g.joinState === 'request' ? t('group.joinRequest') : t('group.joinOpen')) + '</span>' +
      (g.languages && g.languages.length ? '<span style="opacity:0.3;margin:0 4px;">|</span><span><i class="fa-solid fa-globe"></i> ' + g.languages.join(', ') + '</span>' : '');

    // Render Actions
    let actionHtml = '';
    if (g.myMember) {
      const myId = g.myMember.userId;
      const vis = g.myMember.visibility; // 'visible', 'hidden', 'friends'
      const oppVis = vis === 'visible' ? 'hidden' : 'visible';
      const visText = vis === 'visible' ? t('group.visVisible') : (vis === 'friends' ? t('group.visFriends') : t('group.visHidden'));
      actionHtml += `<button onclick="vrcGroupAction('${escJsAttr(groupId)}','visibility','${escJsAttr(myId)}','${escJsAttr(oppVis)}')" style="background:var(--bg-glass);border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:0.75em;color:var(--text-primary);cursor:pointer;" title="${t('group.clickToToggle')}">${visText}</button>`;
      actionHtml += `<button onclick="vrcGroupAction('${escJsAttr(groupId)}','leave')" style="background:#ef444422;border:1px solid #ef444444;border-radius:6px;padding:4px 10px;font-size:0.75em;color:#ef4444;cursor:pointer;">${t('group.leaveGroup')}</button>`;
    } else {
      if (g.joinState !== 'closed') {
        actionHtml += `<button onclick="vrcGroupAction('${escJsAttr(groupId)}','join')" style="background:var(--accent);border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:0.75em;color:#fff;cursor:pointer;font-weight:600;">${t('group.requestJoin')}</button>`;
      }
    }
    document.getElementById('gdActions').innerHTML = actionHtml;
    
    // Fetch extra data
    fetchGroupExtraData(groupId, g, detailToken, detailCtrl.signal);

  } catch(e) {
    if (!isUiTokenCurrent(detailToken) || !isScopedAbortCurrent('groupDetail', detailCtrl)) return;
    document.getElementById('gdName').textContent = t('toast.loadFailMsg', {msg: e.message});
  }
}

// Close the group detail modal and release the body scroll lock. Using a single
// helper (instead of inline classList.add('hidden')) keeps lock/unlock balanced.
function closeGroupDetail() {
  bumpUiEpoch();
  window._groupDetailActiveToken = null;
  cancelScopedAbort('groupDetail');
  const modal = document.getElementById('groupDetailModal');
  if (!modal) return;
  modal.classList.add('hidden');
  if (modal.dataset.scrollLocked) {
    unlockBodyScroll();
    delete modal.dataset.scrollLocked;
  }
  if (typeof flushPendingAvatarCardUpdates === 'function') flushPendingAvatarCardUpdates();
}

async function vrcGroupAction(groupId, action, myId, nextVis) {
  try {
    // NOTE: must go through apiCall() so the X-VRC-Auth header is attached.
    // A raw fetch('/api/vrc/...') sends no auth → worker treats it as logged-out
    // and join/leave/visibility silently fail. (Fixed: was `await fetch(...)`.)
    let url, opts = { method: 'POST' };
    if (action === 'leave') {
      if(!confirm(t('confirm.leaveGroup'))) return;
      url = '/api/vrc/groups/' + groupId + '/leave';
    } else if (action === 'join') {
      url = '/api/vrc/groups/' + groupId + '/join';
    } else if (action === 'visibility') {
      url = '/api/vrc/groups/' + groupId + '/members/' + myId;
      opts = { method: 'PUT', json: { visibility: nextVis } };
    } else {
      return;
    }

    const r = await apiCall(url, opts);
    if (!r.ok) throw new Error(await r.text());

    // Invalidate the cached groups list — leave/join would otherwise let the
    // sidebar keep showing the user as still in the group (or missing) for
    // up to a full reload (TTL). Clear both the mutual-groups memory cache
    // and the groups-shell IDB cache so the next open re-fetches.
    myGroupsCache = null;
    if (typeof invalidateGroupsCache === 'function') invalidateGroupsCache();

    // Refresh modal
    openGroupDetail(groupId);
  } catch(e) {
    showToast(t('toast.opFailMsg', {msg: e.message}), 'error');
  }
}

function switchGroupDetailTab(btn, tab) {
  const container = btn.closest('.modal-content');
  container.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
  document.getElementById('gdInstances').style.display = tab === 'instances' ? '' : 'none';
  document.getElementById('gdMembers').style.display = tab === 'members' ? '' : 'none';
}

async function fetchGroupExtraData(groupId, groupContext = null, token = null, signal = null) {
  fetchGroupInstances(groupId, groupContext, token, signal);
  fetchGroupMembers(groupId, token, signal);
}

function renderGroupInstancesForbidden(el, groupId, groupContext) {
  const isMember = !!(groupContext && groupContext.myMember);
  const joinState = groupContext && groupContext.joinState;
  const canRequestJoin = !isMember && joinState !== 'closed';
  const title = isMember ? t('group.forbiddenTitleMember') : t('group.forbiddenTitleNonMember');
  const body = isMember
    ? t('group.forbiddenBodyMember')
    : t('group.forbiddenBodyNonMember');
  const action = canRequestJoin
    ? `<button class="btn btn-xs btn-primary" style="margin-top:10px;padding:5px 10px;font-size:0.72rem;" onclick="vrcGroupAction('${escJsAttr(groupId)}','join')">${escHtml(t('group.joinOrRequest'))}</button>`
    : '';
  el.innerHTML = `<div style="padding:12px;color:var(--text-secondary);font-size:0.82rem;line-height:1.6;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:10px;">
    <div style="color:var(--text-primary);font-weight:700;margin-bottom:4px;">${escHtml(title)}</div>
    <div>${escHtml(body)}</div>
    ${action}
  </div>`;
}

function normalizeGroupInstanceInfo(i) {
  const world = i && i.world ? i.world : {};
  const rawInstance = String(
    (i && (i.location || i.locationId || i.id || i.instanceId || i.instanceName)) || ''
  );
  const colonIndex = rawInstance.indexOf(':');
  const worldId = (i && (i.worldId || i.world_id)) || world.id || (colonIndex > 0 ? rawInstance.slice(0, colonIndex) : '');
  const instancePart = colonIndex >= 0 ? rawInstance.slice(colonIndex + 1) : rawInstance;
  const instanceShortId = instancePart.split('~')[0] || instancePart || '';
  const params = {};
  instancePart.replace(/~([^~()]+)(?:\(([^)]*)\))?/g, (_, key, value) => {
    params[key] = value == null ? true : value;
    return '';
  });

  const regionCode = String((i && i.region) || params.region || '').toLowerCase();
  const regionLabel = ({
    us: 'US',
    use: 'US East',
    usw: 'US West',
    eu: 'Europe',
    jp: 'Japan'
  })[regionCode] || (regionCode ? regionCode.toUpperCase() : '');

  const groupAccess = String((i && (i.groupAccessType || i.group_access_type)) || params.groupAccessType || '').toLowerCase();
  const groupAccessLabel = ({
    public: t('group.accessPublic'),
    members: t('group.accessMembers'),
    friends: t('group.accessFriends'),
    private: t('group.accessPrivate')
  })[groupAccess] || (groupAccess ? t('group.accessOther', {name: groupAccess}) : '');

  let accessLabel = groupAccessLabel;
  if (!accessLabel) {
    const accessRaw = String((i && (i.accessType || i.type || i.privacy)) || '').toLowerCase();
    if (instancePart.includes('~private') || accessRaw === 'private') accessLabel = t('group.labelPrivate');
    else if (instancePart.includes('~friends+') || instancePart.includes('~hidden') || instancePart.includes('canRequestInvite')) accessLabel = t('group.labelFriendsPlus');
    else if (instancePart.includes('~friends') || accessRaw === 'friends') accessLabel = t('group.labelFriends');
    else if (params.group) accessLabel = t('group.labelGroup');
    else accessLabel = t('group.labelPublic');
  }

  const numberFrom = (...vals) => {
    for (const val of vals) {
      if (Array.isArray(val)) return val.length;
      if (typeof val === 'number' && Number.isFinite(val)) return val;
      if (typeof val === 'string' && val.trim() !== '' && Number.isFinite(Number(val))) return Number(val);
    }
    return null;
  };
  const occupants = numberFrom(i && i.n_users, i && i.userCount, i && i.user_count, i && i.playerCount, i && i.players, i && i.users) || 0;
  const capacity = numberFrom(i && i.capacity, world.capacity, i && i.worldCapacity) || 0;
  const location = rawInstance.startsWith('wrld_') ? rawInstance : (worldId && instancePart ? `${worldId}:${instancePart}` : '');
  const isJoinable = location.startsWith('wrld_') && !instancePart.includes('~private');

  return {
    worldName: world.name || (i && i.worldName) || t('world.unknownWorld'),
    instanceShortId,
    regionLabel,
    accessLabel,
    occupants,
    capacity,
    location,
    isJoinable
  };
}

async function fetchGroupInstances(groupId, groupContext = null, token = null, signal = null) {
  const el = document.getElementById('gdInstances');
  if(!el) return;
  el.innerHTML = '<div style="padding:10px;color:var(--text-muted);text-align:center;font-size:0.8em;">' + escHtml(t('group.loadingInstances')) + '</div>';
  try {
    const opts = signal ? { signal, noDedupe: true } : {};
    const r = await apiCall('/api/vrc/groups/' + groupId + '/instances', opts);
    if (token && !isUiTokenCurrent(token)) return;
    if (signal && signal.aborted) return;
    if (r.status === 403) {
      renderGroupInstancesForbidden(el, groupId, groupContext);
      return;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const insts = await r.json();
    if (token && !isUiTokenCurrent(token)) return;
    if (signal && signal.aborted) return;
    if (!insts || !insts.length) {
      el.innerHTML = '<div style="padding:10px;color:var(--text-muted);text-align:center;font-size:0.8rem;">' + escHtml(t('group.noActiveInstances')) + '</div>';
      return;
    }
    el.innerHTML = insts.map(i => {
      const info = normalizeGroupInstanceInfo(i || {});
      const metaParts = [
        info.regionLabel,
        info.instanceShortId ? `#${info.instanceShortId}` : '',
        info.accessLabel
      ].filter(Boolean);
      const joinButton = info.isJoinable
        ? `<button class="btn btn-xs btn-primary" style="padding:4px 8px;font-size:0.7em;" onclick="inviteSelf('${escJsAttr(info.location)}')">${escHtml(t('group.join'))}</button>`
        : `<button class="btn btn-xs btn-primary" style="padding:4px 8px;font-size:0.7em;" disabled>${escHtml(t('group.join'))}</button>`;
      return `<div class="group-instance-card">
        <div class="inst-info">
          <div class="inst-name">${escHtml(info.worldName)}</div>
          <div class="inst-meta">${metaParts.map(part => `<span>${escHtml(part)}</span>`).join('')}</div>
        </div>
        <div class="inst-occupants">${info.occupants} / ${info.capacity || '?'}</div>
        ${joinButton}
      </div>`;
    }).join('');
  } catch(e) {
    if (token && !isUiTokenCurrent(token)) return;
    if (signal && signal.aborted) return;
    el.innerHTML = '<div style="padding:10px;color:var(--error);font-size:0.8rem;">' + escHtml(t('group.instancesLoadFail', {msg: e.message})) + '</div>';
  }
}

async function fetchGroupMembers(groupId, token = null, signal = null) {
  const el = document.getElementById('gdMembers');
  if(!el) return;
  el.innerHTML = '<div style="padding:10px;color:var(--text-muted);text-align:center;font-size:0.8em;">' + escHtml(t('group.loadingMembers')) + '</div>';
  try {
    // Note: VRChat API limit is 100 per page. We'll just fetch the first page for now.
    const opts = signal ? { signal, noDedupe: true } : {};
    const r = await apiCall('/api/vrc/groups/' + groupId + '/members?n=50', opts);
    if (token && !isUiTokenCurrent(token)) return;
    if (signal && signal.aborted) return;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const members = await r.json();
    if (token && !isUiTokenCurrent(token)) return;
    if (signal && signal.aborted) return;
    if (!members || !members.length) {
      el.innerHTML = '<div style="padding:10px;color:var(--text-muted);text-align:center;font-size:0.8rem;">' + escHtml(t('group.noVisibleMembers')) + '</div>';
      return;
    }
    el.innerHTML = members.map(m => {
      const u = m.user || {};
      const fJson = escAttrJson(u);
      return `
        <div class="group-member-card" onclick="openFriendProfile(this)" data-friend="${fJson}" style="cursor:pointer;">
          <img src="${escHtml(getUserThumbUrl(u))}" class="member-avatar" onerror="this.onerror=null; this.src='${escHtml(blankAvatarDataUrl(u.displayName || u.username || '?'))}';">
          <div class="member-info">
            <div class="member-name" title="${escHtml(u.displayName || '')}">${escHtml(u.displayName || 'Unknown')}</div>
            <div class="member-role">${escHtml(m.roleNames?.[0] || 'Member')}</div>
          </div>
        </div>`;
    }).join('');
  } catch(e) {
    if (token && !isUiTokenCurrent(token)) return;
    if (signal && signal.aborted) return;
    el.innerHTML = '<div style="padding:10px;color:var(--error);font-size:0.8rem;">' + escHtml(t('group.membersLoadFail', {msg: e.message})) + '</div>';
  }
}


// ── Live instance occupancy (counts only; stranger roster not exposed by API) ──
async function fetchInstanceOccupancy(loc, token = null, signal = null) {
  const el = document.getElementById('insOccupancy');
  if (!el) return;
  if (loc.indexOf(':') < 0) return;
  // loc is already "worldId:instanceId(+params)" — the instance endpoint accepts it as-is
  const instancePath = loc;
  el.innerHTML = '<span style="font-size:0.72em;color:var(--text-muted);">' + escHtml(t('group.loadingOccupancy')) + '</span>';
  try {
    const opts = signal ? { signal, noDedupe: true } : {};
    const r = await apiCall('/api/vrc/instances/' + instancePath, opts);
    if (token && !isUiTokenCurrent(token)) return;
    if (signal && signal.aborted) return;
    if (!r.ok) { el.innerHTML = ''; return; }
    const ins = await r.json();
    if (token && !isUiTokenCurrent(token)) return;
    if (signal && signal.aborted) return;
    const pill = (icon, label, val) =>
      `<span style="display:inline-flex;align-items:center;gap:4px;font-size:0.72em;padding:3px 9px;border-radius:999px;background:rgba(255,255,255,0.06);border:1px solid var(--border);color:var(--text-secondary);">${icon} <b style="color:var(--text-primary);">${val}</b> ${label}</span>`;
    const parts = [];
    const userCount = (ins.userCount != null ? ins.userCount : ins.n_users);
    if (userCount != null) {
      const cap = ins.capacity != null ? ('/' + ins.capacity) : '';
      parts.push(pill('<i class="fa-solid fa-user-group"></i> ', t('group.online'), userCount + cap));
    }
    if (ins.queueSize) parts.push(pill('<i class="fa-solid fa-hourglass-half"></i> ', t('group.queue'), ins.queueSize));
    if (ins.platforms) {
      if (ins.platforms.standalonewindows) parts.push(pill('🖥️', 'PC', ins.platforms.standalonewindows));
      if (ins.platforms.android) parts.push(pill('<i class="fa-solid fa-mobile-screen"></i> ', 'Quest', ins.platforms.android));
      if (ins.platforms.ios) parts.push(pill('<i class="fa-brands fa-apple"></i> ', 'iOS', ins.platforms.ios));
    }
    if (ins.full) parts.push('<span style="font-size:0.72em;padding:3px 9px;border-radius:999px;background:rgba(239,68,68,0.18);color:#fca5a5;">' + escHtml(t('group.full')) + '</span>');
    el.innerHTML = parts.join('') ||
      '<span style="font-size:0.72em;color:var(--text-muted);">' + escHtml(t('group.instanceEmpty')) + '</span>';
  } catch (e) {
    if (token && !isUiTokenCurrent(token)) return;
    if (signal && signal.aborted) return;
    el.innerHTML = '';
  }
}

async function openInstanceDetail(loc) {
  bumpUiEpoch();
  const detailToken = makeUiToken('instanceDetail', loc);
  window._instanceDetailActiveToken = detailToken;
  const detailCtrl = beginScopedAbort('instanceDetail');
  // private / offline / ~private instances cannot be joined
  const isPrivateLoc = !loc || loc === 'private' || loc === 'offline' || loc.includes('~private');
  if (isPrivateLoc) return;
  const worldId = loc.split(':')[0];
  
  // Ensure modal exists
  if (!document.getElementById('instanceDetailModal')) {
    const html = `<div id="instanceDetailModal" class="modal hidden" onclick="if(event.target===this)closeInstanceDetail()">
      <div class="modal-content" style="max-width:560px;padding:0;overflow:hidden;display:flex;flex-direction:column;">
        <div id="insBanner" style="height:160px;background-size:cover;background-position:center;position:relative;flex-shrink:0;">
          <div style="position:absolute;inset:0;background:linear-gradient(to top, var(--bg-card), transparent);"></div>
          <button onclick="closeInstanceDetail()" style="position:absolute;top:10px;right:10px;background:rgba(0,0,0,0.5);border:none;color:#fff;border-radius:50%;width:30px;height:30px;cursor:pointer;z-index:10;">×</button>
        </div>
        <div style="padding:20px;position:relative;margin-top:-40px;overflow-y:auto;flex:1;min-height:0;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px;">
            <div style="flex:1;">
              <h2 id="insWorldName" style="margin:0;font-size:1.4em;color:var(--text-primary);">${escHtml(t('loading'))}</h2>
              <div id="insAuthorLine" style="font-size:0.85em;color:var(--text-secondary);margin-top:2px;"></div>
            </div>
            <div id="insStats" style="text-align:right;"></div>
          </div>

          <div id="insDesc" style="font-size:0.82em;color:var(--text-muted);line-height:1.5;max-height:80px;overflow-y:auto;margin-bottom:15px;white-space:pre-line;padding:10px;background:rgba(255,255,255,0.03);border-radius:8px;"></div>
          
          <div id="insTags" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:15px;"></div>

          <div id="insLoc" style="font-size:0.75em;color:var(--accent-light);margin-bottom:15px;font-family:monospace;word-break:break-all;background:rgba(255, 255, 255, 0.1);padding:6px 10px;border-radius:6px;border-left:3px solid var(--accent);"></div>

          <div id="insOccupancy" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:15px;"></div>
          
          <div style="display:flex;gap:10px;margin-bottom:20px;">
             <button id="insBtnWorld" class="btn btn-primary" style="flex:1;">${t('group.worldDetails')}</button>
             <button id="insBtnInvite" class="btn btn-success" style="flex:1;"><i class="fa-solid fa-envelope"></i> ${escHtml(t('friend.inviteSelf'))}</button>
          </div>

          <div style="font-size:0.85em;font-weight:700;margin-bottom:10px;color:var(--text-primary);display:flex;align-items:center;gap:6px;border-bottom:1px solid var(--border);padding-bottom:8px;">
            <span style="font-size:1.2em;"><i class="fa-solid fa-user-group"></i> </span> ${escHtml(t('group.friendsInInstance'))}
          </div>
          <div id="insFriendList" style="display:flex;flex-direction:column;gap:8px;max-height:240px;overflow-y:auto;padding-right:4px;"></div>
        </div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  const modal = document.getElementById('instanceDetailModal');
  modal.style.zIndex = modalZTop();
  modal.classList.remove('hidden');
  if (!modal.dataset.scrollLocked) {
    lockBodyScroll();
    modal.dataset.scrollLocked = '1';
  }
  // Always update the action buttons for the CURRENT loc/worldId (fixes stale-closure bug)
  document.getElementById('insBtnWorld').onclick = () => openWorldDetail(worldId);
  // Show 'Invite Self' only for joinable instances (not ~private)
  const inviteBtn = document.getElementById('insBtnInvite');
  const isJoinableLoc = loc && !loc.includes('~private') && loc.startsWith('wrld_');
  if (isJoinableLoc) {
    inviteBtn.style.display = '';
    inviteBtn.onclick = () => inviteSelf(loc);
  } else {
    inviteBtn.style.display = 'none';
  }
  document.getElementById('insWorldName').textContent = t('loading');
  document.getElementById('insAuthorLine').innerHTML = '';
  document.getElementById('insDesc').textContent = '';
  document.getElementById('insStats').innerHTML = '';
  document.getElementById('insTags').innerHTML = '';
  document.getElementById('insLoc').textContent = loc;
  const _occEl = document.getElementById('insOccupancy');
  if (_occEl) _occEl.innerHTML = '';
  document.getElementById('insFriendList').innerHTML = '<div style="text-align:center;padding:20px;opacity:0.5;">' + escHtml(t('group.syncing')) + '</div>';

  try {
    const wResp = await apiCall('/api/vrc/worlds/' + worldId, { signal: detailCtrl.signal, noDedupe: true });
    if (wResp.ok) {
      const w = await wResp.json();
      if (!isUiTokenCurrent(detailToken) || !isScopedAbortCurrent('instanceDetail', detailCtrl)) return;
      document.getElementById('insWorldName').textContent = w.name;
      document.getElementById('insBanner').style.backgroundImage = `url(${proxyImg(w.imageUrl)})`;
      document.getElementById('insAuthorLine').innerHTML = `by <a href="#" onclick="openFriendProfileById('${escJsAttr(w.authorId)}'); event.preventDefault();" style="color:var(--accent-light);text-decoration:none;">${escHtml(w.authorName)}</a>`;
      document.getElementById('insDesc').textContent = w.description || t('group.noWorldDesc');
      
      const region = loc.includes('~region(') ? loc.match(/~region\((.*?)\)/)[1].toUpperCase() : 'US';
      const regionIcon = {US:'🇺🇸',EU:'🇪🇺',JP:'🇯🇵'}[region] || '<i class="fa-solid fa-globe"></i> ';
      
      document.getElementById('insStats').innerHTML = `
        <div style="font-size:0.9em;font-weight:700;">${regionIcon} ${region}</div>
        <div style="font-size:0.75em;color:var(--text-muted);">${w.releaseStatus === 'labs' ? '<i class="fa-solid fa-flask"></i> Labs' : '<i class="fa-solid fa-check"></i> Public'}</div>
      `;

      // Tags
      const interestingTags = (w.tags || []).filter(t => !t.startsWith('author_tag_') && !t.startsWith('system_')).slice(0, 5);
      document.getElementById('insTags').innerHTML = interestingTags.map(t => `<span style="font-size:0.7em;padding:2px 8px;border-radius:4px;background:rgba(255,255,255,0.05);border:1px solid var(--border);color:var(--text-muted);">${escHtml(t)}</span>`).join('');
    }

    // Live instance occupancy (people count / capacity / queue / platform split).
    // The full member roster of strangers is NOT exposed by the API; only counts.
    fetchInstanceOccupancy(loc, detailToken, detailCtrl.signal);

    // Find all friends in this instance
    const friendsInIns = allFriends.filter(f => f.location === loc);

    // Check if the local user is also in this instance
    if (myProfileData && myProfileData.location === loc) {
      const selfProfile = { ...myProfileData };
      selfProfile.isSelf = true;
      friendsInIns.unshift(selfProfile);
    }

    const listEl = document.getElementById('insFriendList');
    if (!friendsInIns.length) {
      listEl.innerHTML = '<div style="text-align:center;padding:20px;opacity:0.5;font-size:0.85em;">' + escHtml(t('group.noFriendsInInstance')) + '</div>';
    } else {
      listEl.innerHTML = friendsInIns.map(f => {
        const trust = getTrustInfo(f.tags||[]);
        const safeJson = escAttrJson(f);
        return `<div class="friend-card" style="padding:10px;margin:0;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:8px;transition:all 0.2s;cursor:pointer;" onmouseover="this.style.background='rgba(255,255,255,0.06)'" onmouseout="this.style.background='rgba(255,255,255,0.03)'" onclick="openFriendProfile(this)" data-friend="${safeJson}">
          <div style="position:relative;">
            <img src="${proxyImg(f.currentAvatarThumbnailImageUrl||f.userIcon||'')}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;border:2px solid ${trust.color}44;">
          </div>
          <div style="flex:1;">
            <div style="font-size:0.95em;font-weight:600;color:${trust.color};display:flex;align-items:center;gap:6px;">
              ${escHtml(f.displayName)}
              ${f.isSelf ? '<span style="font-size:0.7em;background:rgba(255, 255, 255, 0.3);color:#d4d4d8;padding:2px 6px;border-radius:4px;">' + t('group.myself') + '</span>' : ''}
            </div>
            <div style="font-size:0.75em;opacity:0.7;color:var(--text-muted);">${getStatusLabel(f)}</div>
          </div>
          <div style="font-size:0.7em;color:var(--text-muted);">${getPlatformEmoji(f.last_platform)}</div>
        </div>`;
      }).join('');
    }
  } catch(e) {
    if (!isUiTokenCurrent(detailToken) || !isScopedAbortCurrent('instanceDetail', detailCtrl)) return;
    console.error('Instance detail error', e);
    document.getElementById('insWorldName').textContent = t('group.loadFailedShort');
    // Don't leave the friend list spinning forever ("同步中...") when the
    // initial fetch throws — replace with an error indicator so the user
    // knows to retry instead of staring at it.
    const _flEl = document.getElementById('insFriendList');
    if (_flEl) _flEl.innerHTML = `<div style="text-align:center;padding:20px;color:var(--error);font-size:0.85em;">${escHtml(t('toast.loadFailMsg', {msg: (e.message || t('group.networkError'))}))}</div>`;
  }
}

// Close the instance detail modal and release the body scroll lock.
function closeInstanceDetail() {
  bumpUiEpoch();
  window._instanceDetailActiveToken = null;
  cancelScopedAbort('instanceDetail');
  const modal = document.getElementById('instanceDetailModal');
  if (!modal) return;
  modal.classList.add('hidden');
  if (modal.dataset.scrollLocked) {
    unlockBodyScroll();
    delete modal.dataset.scrollLocked;
  }
  if (typeof flushPendingAvatarCardUpdates === 'function') flushPendingAvatarCardUpdates();
}


async function fetchMutualGroups(userId, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '<span style="color:var(--text-muted);font-size:0.8em;">' + escHtml(t('loading')) + '</span>';
  try {
    if (!myGroupsCache) {
      const meResp = await apiCall('/api/vrc/auth/user');
      const me = await meResp.json();
      const r = await apiCall('/api/vrc/users/' + me.id + '/groups');
      myGroupsCache = await r.json();
    }
    const r2 = await apiCall('/api/vrc/users/' + userId + '/groups');
    const theirGroups = await r2.json();
    const myIds = new Set((myGroupsCache||[]).map(g => g.groupId||g.id));
    const mutual = (theirGroups||[]).filter(g => myIds.has(g.groupId||g.id));
    if (!mutual.length) { el.innerHTML = '<span style="color:var(--text-muted);font-size:0.8em;">' + escHtml(t('group.noMutualGroups')) + '</span>'; return; }
    el.innerHTML = '<div style="display:flex;gap:6px;flex-wrap:wrap;">' + mutual.map(g => 
      '<div onclick="openGroupDetail(' + JSON.stringify(g.groupId||g.id) + ')" style="background:var(--bg-glass);border:1px solid var(--border);border-radius:6px;padding:4px 8px;cursor:pointer;font-size:0.75em;display:flex;align-items:center;gap:6px;">' +
        '<img src="' + escHtml(proxyImg(g.iconUrl||'')) + '" style="width:18px;height:18px;border-radius:3px;" onerror="this.style.display=\'none\'">' +
        escHtml(g.name) +
      '</div>'
    ).join('') + '</div>';
  } catch(e) {
    el.innerHTML = '<span style="color:var(--text-muted);font-size:0.8em;">' + escHtml(t('group.loadFailedShort')) + '</span>';
  }
}

function blankAvatarDataUrl(label = '?') {
  const initial = String(label || '?').trim().charAt(0).toUpperCase() || '?';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><rect width="80" height="80" rx="40" fill="#27272a"/><text x="40" y="48" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="30" font-weight="700" fill="#d4d4d8">${escHtml(initial)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function getUserThumbUrl(u) {
  if (!u) return blankAvatarDataUrl();
  const cached = u.id && (allFriends || []).find(f => f.id === u.id);
  const candidates = [
    u.profilePicOverrideThumbnail,
    u.profilePicOverride,
    u.userIcon,
    u.currentAvatarThumbnailImageUrl,
    u.currentAvatarImageUrl,
    u.currentAvatarAssetUrl,
    u.avatarThumbnailImageUrl,
    cached?.profilePicOverrideThumbnail,
    cached?.profilePicOverride,
    cached?.userIcon,
    cached?.currentAvatarThumbnailImageUrl,
    cached?.currentAvatarImageUrl
  ].filter(Boolean);
  const raw = candidates.find(url => typeof url === 'string' && !url.startsWith('file_')) || '';
  return raw ? proxyImg(raw) : blankAvatarDataUrl(u.displayName || u.username || '?');
}

async function fetchMutualFriends(userId, containerId, seq) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '<span style="color:var(--text-muted);font-size:0.8em;">' + escHtml(t('loading')) + '</span>';
  try {
    let offset = 0;
    const list = [];
    while (offset < 2000) {
      // Correct VRChat API endpoint for mutual friends (same as VRCX uses), with pagination
      const r = await apiCall(`/api/vrc/users/${userId}/mutuals/friends?n=100&offset=${offset}`);
      if (seq != null && window._fpCurrentSeq !== seq) return; // user opened another friend
      if (r.status === 403 && offset === 0) {
        // VRChat is still rolling out mutual friends - fall back to co-located friends
        await fetchMutualFriendsFallback(userId, el);
        return;
      }
      if (!r.ok) { 
        if (offset === 0) await fetchMutualFriendsFallback(userId, el);
        break; 
      }
      const json = await r.json();
      if (seq != null && window._fpCurrentSeq !== seq) return;
      const batch = Array.isArray(json) ? json : (json.mutualFriends || json.users || []);
      if (!batch || !batch.length) break;
      list.push(...batch);
      if (batch.length < 100) break;
      offset += 100;
    }
    
    if (!list.length) {
      el.innerHTML = '<span style="color:var(--text-muted);font-size:0.8em;">' + escHtml(t('group.noMutualFriends')) + '</span>';
      return;
    }
    const renderUser = u => {
      const safeJson = escAttrJson(u);
      const t = getTrustInfo(u.tags || []);
      const thumb = getUserThumbUrl(u);
      return `
        <div class="group-member-card" onclick="openFriendProfile(this);" data-friend="${safeJson}" style="cursor:pointer;width:100%;max-width:none;">
          <img src="${escHtml(thumb)}" class="member-avatar" onerror="this.onerror=null; this.src='${escHtml(blankAvatarDataUrl(u.displayName || u.username || '?'))}';">
          <div class="member-info">
            <div class="member-name" style="color:${t.color};" title="${escHtml(u.displayName || '')}">${escHtml(u.displayName || 'Unknown')}</div>
            <div class="member-role">${t.text || 'User'}</div>
          </div>
        </div>`;
    };
    el.innerHTML = `
      <div style="font-size:0.72em;font-weight:700;color:var(--text-muted);margin:0 0 10px 4px;text-transform:uppercase;letter-spacing:0.05em;">${escHtml(t('group.mutualFriendsCount', {count: list.length}))}</div>
      <div class="group-member-list">
        ${list.map(renderUser).join('')}
      </div>`;
  } catch(e) {
    el.innerHTML = '<span style="color:var(--text-muted);font-size:0.8em;">' + escHtml(t('toast.loadFailMsg', {msg: e.message})) + '</span>';
  }
}

async function fetchMutualFriendsFallback(userId, el) {
  let myFriends = window._allFriendsCache || window.allFriends || [];
  if (!myFriends.length) {
    const pages = [];
    let offset = 0;
    while (offset < 2000) {
      const r = await apiCall('/api/vrc/auth/user/friends?n=100&offset=' + offset + '&offline=true');
      if (!r.ok) break;
      const batch = await r.json();
      if (!batch || !batch.length) break;
      pages.push(...batch);
      if (batch.length < 100) break;
      offset += 100;
    }
    myFriends = pages;
    window._allFriendsCache = myFriends;
  }
  const detailR = await apiCall('/api/vrc/users/' + userId);
  const targetUser = detailR.ok ? await detailR.json() : {};
  const targetLoc = targetUser.location || '';
  const colocated = targetLoc && targetLoc.startsWith('wrld_') ? myFriends.filter(f => f.location === targetLoc) : [];
  
  const renderUser = u => {
    const safeJson = escAttrJson(u);
    const t = getTrustInfo(u.tags || []);
    const thumb = getUserThumbUrl(u);
    return `
      <div class="group-member-card" onclick="openFriendProfile(this);" data-friend="${safeJson}" style="cursor:pointer;width:100%;max-width:none;">
        <img src="${escHtml(thumb)}" class="member-avatar" onerror="this.onerror=null; this.src='${escHtml(blankAvatarDataUrl(u.displayName || u.username || '?'))}';">
        <div class="member-info">
          <div class="member-name" style="color:${t.color};" title="${escHtml(u.displayName || '')}">${escHtml(u.displayName || 'Unknown')}</div>
          <div class="member-role">${t.text || 'User'}</div>
        </div>
      </div>`;
  };

  if (colocated.length) {
    el.innerHTML = `
      <div style="font-size:0.72em;font-weight:700;color:var(--text-muted);margin:0 0 10px 4px;text-transform:uppercase;letter-spacing:0.05em;">${escHtml(t('group.colocatedFriendsCount', {count: colocated.length}))}</div>
      <div class="group-member-list">
        ${colocated.map(renderUser).join('')}
      </div>`;
  } else {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:0.8em;line-height:1.6;padding:8px 0;">' + escHtml(t('group.mutualFriendsRollout')) + '<br>' +
      (targetLoc && targetLoc.startsWith('wrld_') ? escHtml(t('group.userNotInFriendInstance')) : escHtml(t('group.userOfflineOrHidden'))) + '</div>';
  }
}


// ═══════════════════════════════════════════════════════════

VRCW.registerModule('groupsInstance', { loadMyGroups, openGroupDetail, closeGroupDetail, vrcGroupAction, switchGroupDetailTab, fetchGroupExtraData, fetchGroupInstances, fetchGroupMembers, fetchInstanceOccupancy, openInstanceDetail, closeInstanceDetail, fetchMutualGroups, fetchMutualFriends });
renderAppVersionInfo();

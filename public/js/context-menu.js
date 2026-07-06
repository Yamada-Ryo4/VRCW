/*
 * VRCW — context-menu.js
 * 右键菜单引擎/好友与自身菜单/群组邀请/举报/备注/Boop/屏蔽静音/管理
 *
 * 注意：本项目为「经典脚本」(非 ES module)，全部按顺序加载、共享全局作用域。
 * 函数声明会提升为全局，跨文件调用没问题；请勿改为 type="module"。
 */
// SIDEBAR MINI PROFILE
// ═══════════════════════════════════════════════════════════
// CONTEXT MENU ENGINE
// ═══════════════════════════════════════════════════════════
let _ctxMenuEl = null;
function closeCtxMenu() {
  if (_ctxMenuEl) { _ctxMenuEl.remove(); _ctxMenuEl = null; }
}
document.addEventListener('click', closeCtxMenu);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCtxMenu(); });

// ── Owned-avatar "more" menu (wear / fallback / impostor) ──
function showOwnedAvatarMenu(e, avtrId, name) {
  e.stopPropagation();
  buildCtxMenu([
    { label: name || t('ctx.myAvatar'), items: [
      { icon:'<i class="fa-solid fa-bolt"></i> ', label:t('ctx.switchAvatar'), action: () => switchAvatar(avtrId) },
      { icon:'<i class="fa-solid fa-person"></i> ', label:t('ctx.setFallback'), action: () => setFallbackAvatar(avtrId, name) },
    ]},
    { label:t('ctx.impostor'), items: [
      { icon:'<i class="fa-solid fa-wand-magic-sparkles"></i> ', label:t('ctx.genImpostor'), action: () => enqueueImpostor(avtrId, name) },
      { icon:'🗑️', label:t('ctx.delImpostor'), action: () => deleteImpostor(avtrId, name) },
    ]},
    { items: [
      { icon:'<i class="fa-solid fa-link"></i> ', label:t('ctx.openVrcHome'), action: () => window.open(`https://vrchat.com/home/avatar/${avtrId}`, '_blank') },
      { icon:'<i class="fa-solid fa-clipboard"></i> ', label:t('ctx.copyAvatarId'), action: () => copyToClipboard(avtrId, t('label.copyAvatarIdToast')) },
    ]},
  ]);
  positionCtxMenu(e, _ctxMenuEl);
}

function buildCtxMenu(sections) {
  closeCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  sections.forEach(section => {
    const sec = document.createElement('div');
    sec.className = 'ctx-menu-section';
    if (section.label) {
      const hdr = document.createElement('div');
      hdr.className = 'ctx-menu-header';
      hdr.textContent = section.label;
      sec.appendChild(hdr);
    }
    section.items.forEach(item => {
      if (!item) return;
      const btn = document.createElement('button');
      btn.className = 'ctx-menu-item' + (item.danger ? ' danger' : '');
      btn.innerHTML = `<span class="ctx-icon">${item.icon||''}</span><span>${item.label}</span>`;
      btn.onclick = (e) => { e.stopPropagation(); closeCtxMenu(); item.action && item.action(e); };
      sec.appendChild(btn);
    });
    menu.appendChild(sec);
  });
  document.body.appendChild(menu);
  // Float above whatever modal is currently open (ctx menus are spawned from
  // inside modals, so a fixed CSS z-index could sit behind a later modal).
  menu.style.zIndex = String(modalZPeek() + 5);
  _ctxMenuEl = menu;
  return menu;
}

function positionCtxMenu(e, menu) {
  e.stopPropagation();
  let rect;
  if (e.currentTarget && e.currentTarget.getBoundingClientRect) {
    rect = e.currentTarget.getBoundingClientRect();
  } else if (e.target && e.target.getBoundingClientRect) {
    const btn = e.target.closest('.btn') || e.target;
    rect = btn.getBoundingClientRect();
  } else {
    rect = { bottom: e.clientY, left: e.clientX, top: e.clientY };
  }
  let top = rect.bottom + 6, left = rect.left;
  const mh = menu.offsetHeight || 300, mw = menu.offsetWidth || 240;
  if (top + mh > window.innerHeight) top = (rect.top || e.clientY) - mh - 6;
  if (left + mw > window.innerWidth) left = window.innerWidth - mw - 8;
  menu.style.top = Math.max(8, top) + 'px';
  menu.style.left = Math.max(8, left) + 'px';
}

// ═══════════════════════════════════════════════════════════
// FRIEND CONTEXT MENU (VRCX-style)
// ═══════════════════════════════════════════════════════════
function showFriendContextMenu(e) {
  e.stopPropagation();
  const f = currentFriendProfile;
  if (!f) return;
  const id = f.id || '';
  const name = f.displayName || '';
  const fpState = getFriendProfileActionState(f);
  const {
    isSelf,
    isFriend,
    isOnline,
    isJoinable,
    isFriendFaved,
    isBlocked,
    isMuted,
    isShown,
    isHidden,
    isInteractOff,
    friendRequestPending,
  } = fpState;

  const sections = [
    { items: [
      { icon:'<i class="fa-solid fa-rotate-right"></i> ', label:t('ctx.refreshProfile'), action: async () => {
        // Re-fetch from API for up-to-date data
        try {
          const r = await apiCall(`/api/vrc/users/${id}`);
          if (r.ok) {
            const fresh = await r.json();
            currentFriendProfile = fresh;
            _renderFriendProfileUI(fresh, document.getElementById('friendProfileModal'));
            logMsg(t('log.profileRefreshed'), 'success');
          } else {
            // Fall back to re-open using the proper profile-by-id route
            openFriendProfileById(id);
          }
        } catch { openFriendProfileById(id); }
      }},
      { icon:'<i class="fa-solid fa-clipboard"></i> ', label:t('ctx.copyId'), action: () => navigator.clipboard.writeText(id).then(() => logMsg(t('log.idCopied'), 'info')) },
      { icon:'<i class="fa-solid fa-link"></i> ', label:t('ctx.shareVrcHome'), action: () => window.open(`https://vrchat.com/home/user/${id}`, '_blank') },
    ]},
    { label:t('ctx.sectionLocation'), items: [
      !isSelf && !isBlocked && isFriend && isJoinable ? { icon:'<i class="fa-solid fa-rocket"></i> ', label:t('ctx.requestJoin'), action: () => friendRequestJoin(id, name) } : null,
      !isSelf && !isBlocked && isFriend && isOnline ? { icon:'<i class="fa-solid fa-envelope"></i> ', label:t('ctx.requestInvite'), action: () => requestInvite(id, name) } : null,
      !isSelf && !isBlocked && isFriend && isOnline ? { icon:'<i class="fa-solid fa-envelope-open-text"></i> ', label:t('ctx.sendInvite'), action: () => sendInvite(id, name) } : null,
      !isSelf && !isBlocked && isFriend ? { icon:'<i class="fa-solid fa-hand"></i> ', label:t('ctx.sendBoop'), action: () => {
          setTimeout(() => showBoopMenu(e, id, name), 10);
      }} : null,
    ].filter(Boolean)},
    { label:t('ctx.sectionAvatar'), items: [
      !isSelf && !isBlocked ? { icon:'👁️', label: isShown ? t('ctx.resetShowAvatar') : t('ctx.showAvatar'), action: () => isShown ? resetAvatarModeration(id, name, 'showAvatar') : showAvatarUser(id, name) } : null,
      !isSelf && !isBlocked ? { icon:'🙈', label: isHidden ? t('ctx.resetHideAvatar') : t('ctx.hideAvatar'), action: () => isHidden ? resetAvatarModeration(id, name, 'hideAvatar') : hideAvatarUser(id, name) } : null,
      !isSelf && !isBlocked ? { icon:'<i class="fa-solid fa-handshake"></i> ', label: isInteractOff ? t('ctx.resetInteractOff') : t('ctx.interactOff'), action: () => isInteractOff ? resetAvatarModeration(id, name, 'interactOff') : disableAvatarInteraction(id, name) } : null,
      { icon:'<i class="fa-solid fa-user"></i> ', label:t('ctx.viewAvatarInfo'), action: () => {
        const avId = f.currentAvatarId; if (avId) window.open(`https://vrchat.com/home/avatar/${avId}`, '_blank');
        else showToast(t('toast.avatarIdInaccessible'), 'info');
      }},
    ].filter(Boolean)},
    { label:t('ctx.sectionGroup'), items: [
      !isSelf && !isBlocked && isFriend ? { icon:'🏠', label:t('ctx.inviteGroup'), action: (ev) => showGroupInviteMenu(ev, id, name) } : null,
    ]},
    { label:t('ctx.sectionManage'), items: [
      isFriend ? { icon:'<i class="fa-solid fa-star"></i> ', label: isFriendFaved ? t('ctx.favRemove') : t('ctx.favAdd'), action: (ev) => isFriendFaved ? toggleFriendFavorite(id, name) : toggleFriendFavMenu(ev, id) } : null,
      isFriend ? { icon:'<i class="fa-solid fa-pen-to-square"></i> ', label:t('ctx.editNote'), action: () => showUserNoteDialog(id, name) } : null,
      !isSelf && !isFriend && !isBlocked && !friendRequestPending ? { icon:'<i class="fa-solid fa-plus"></i> ', label:t('ctx.addFriend'), action: () => sendFriendRequest(id, name) } : null,
      !isSelf && !isFriend && friendRequestPending ? { icon:'<i class="fa-solid fa-hourglass-half"></i> ', label:t('ctx.cancelFriendReq'), action: () => cancelFriendRequest(id, name) } : null,
      !isSelf ? { icon:'<i class="fa-solid fa-volume-xmark"></i> ', label: isBlocked ? t('ctx.unblock') : t('ctx.block'), action: () => isBlocked ? unblockUser(id, name) : blockUser(id, name) } : null,
      !isSelf ? { icon:'🔕', label: isMuted ? t('ctx.unmute') : t('ctx.mute'), action: () => isMuted ? unmuteUser(id, name) : muteUser(id, name) } : null,
      !isSelf ? { icon:'<i class="fa-solid fa-flag"></i> ', label:t('ctx.report'), action: () => showReportUserDialog(id, name) } : null,
    ]},
    { items: [
      isFriend ? { icon:'🗑️', label:t('ctx.deleteFriend'), danger: true, action: () => deleteFriend(id, name) } : null,
    ]},
  ].map(section => Object.assign({}, section, { items: section.items.filter(Boolean) }))
   .filter(section => section.items.length > 0);

  const menu = buildCtxMenu(sections);
  positionCtxMenu(e, menu);
}


async function showGroupInviteMenu(ev, userId, userName) {
  // Fetch the current user's owned/member groups and show a picker
  let groups = [];
  try {
    // VRChat API: GET /users/{userId}/groups to list groups for a user
    // Use currentUserId (actual user ID, not 'me')
    const uid = currentUserId || (myProfileData && myProfileData.id);
    if (!uid) { showToast(t('toast.uidMissing'), 'error'); return; }
    const r = await apiCall(`/api/vrc/users/${uid}/groups?n=50`);
    if (r.ok) groups = await r.json();
    // VRChat returns array of LimitedGroup objects with id, name, memberCount, etc.
    // Filter to groups where the user has invite permissions
    groups = groups.filter(g => g.myMember?.permissions?.includes('group-invites-manage') ||
                               g.myMember?.roleIds?.length > 0);
  } catch {}

  if (!groups.length) {
    showToast(t('toast.noManagedGroup'), 'info');
    return;
  }

  // Build a simple modal picker
  const old = document.getElementById('_groupInvitePickerModal');
  if (old) old.remove();

  const modal = document.createElement('div');
  modal.id = '_groupInvitePickerModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:24px;min-width:min(320px,92vw);max-width:480px;max-height:70vh;display:flex;flex-direction:column;gap:12px;">
      <div style="font-weight:600;font-size:1em;">${t('ctx.inviteGroupTitle', {name: escHtml(userName)})}</div>
      <div id="_groupPickerList" style="overflow-y:auto;display:flex;flex-direction:column;gap:8px;max-height:50vh;">
        ${groups.map(g => `
          <button onclick="doGroupInvite('${escJsAttr(g.id)}','${escJsAttr(g.name)}','${escJsAttr(userId)}','${escJsAttr(userName)}')"
            style="text-align:left;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px 14px;cursor:pointer;color:#fff;">
            <div style="font-weight:500;">${escHtml(g.name)}</div>
            <div style="font-size:0.75em;color:rgba(255,255,255,0.4);">${t('ctx.groupMembers', {count: g.memberCount || 0})}</div>
          </button>`).join('')}
      </div>
      <button onclick="document.getElementById('_groupInvitePickerModal')?.remove()" style="background:rgba(255,255,255,0.08);border:none;border-radius:8px;padding:8px;cursor:pointer;color:#fff;">${t('btn.cancel')}</button>
    </div>`;
  document.body.appendChild(modal);
  // Stack above whatever modal opened it; modalZTop() stays below the toast (99999).
  modal.style.zIndex = modalZTop();
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function doGroupInvite(groupId, groupName, userId, userName) {
  document.getElementById('_groupInvitePickerModal')?.remove();
  try {
    const r = await apiCall(`/api/vrc/groups/${groupId}/invites`, {
      method: 'POST',
      json: { userId }
    });
    if (r.ok) logMsg(t('log.invitedToGroup', {name: userName, group: groupName}), 'success');
    else {
      const err = await r.json().catch(() => ({}));
      showToast(t('toast.inviteFail', {msg: err.error?.message || r.status}), 'error');
    }
  } catch(e) { showToast(t('toast.failMsg', {msg: e.message}), 'error'); }
}

function showReportUserDialog(userId, userName) {
  const old = document.getElementById('_reportUserModal');
  if (old) old.remove();

  const reasons = [
    'tos_violation', 'threatening_language', 'harassment', 'spam',
    'inappropriate_avatar', 'inappropriate_content', 'other'
  ];
  const reasonLabels = {
    tos_violation: t('report.tos'),
    threatening_language: t('report.threatening'),
    harassment: t('report.harassment'),
    spam: t('report.spam'),
    inappropriate_avatar: t('report.badAvatar'),
    inappropriate_content: t('report.badContent'),
    other: t('report.other')
  };

  const modal = document.createElement('div');
  modal.id = '_reportUserModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:24px;min-width:min(340px,92vw);max-width:480px;display:flex;flex-direction:column;gap:12px;">
      <div style="font-weight:600;">${t('ctx.reportTitle', {name: escHtml(userName)})}</div>
      <div style="font-size:0.85em;color:rgba(255,255,255,0.5);">${t('ctx.reportSelectReason')}</div>
      <select id="_reportReason" style="background:#111827;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:8px;color:#fff;">
        ${reasons.map(r => `<option value="${r}">${reasonLabels[r]}</option>`).join('')}
      </select>
      <textarea id="_reportDesc" placeholder="${t('label.reportDesc')}" maxlength="512"
        style="background:#111827;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:8px;color:#fff;resize:none;height:80px;"></textarea>
      <div style="display:flex;gap:8px;">
        <button id="_reportSubmitBtn" onclick="submitUserReport('${escJsAttr(userId)}','${escJsAttr(userName)}')"
          style="flex:1;background:#ef4444;border:none;border-radius:8px;padding:10px;cursor:pointer;color:#fff;font-weight:600;">${t('btn.submitReport')}</button>
        <button onclick="document.getElementById('_reportUserModal')?.remove()"
          style="flex:1;background:rgba(255,255,255,0.08);border:none;border-radius:8px;padding:10px;cursor:pointer;color:#fff;">${t('btn.cancel')}</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.style.zIndex = modalZTop();
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function submitUserReport(userId, userName) {
  const reason = document.getElementById('_reportReason')?.value || 'other';
  const description = document.getElementById('_reportDesc')?.value || '';
  const btn = document.getElementById('_reportSubmitBtn');
  if (btn) { btn.disabled = true; btn.textContent = t('btn.submitting'); }
  try {
    // Real moderation report via VRChat API (same endpoint VRCX uses):
    // POST /feedback/{userId}/user  { contentType, reason, type }
    const r = await apiCall(`/api/vrc/feedback/${userId}/user`, {
      method: 'POST',
      json: {
        contentType: 'user',
        reason: reason,
        type: 'report',
        description: description || undefined
      }
    });
    if (r.ok) {
      document.getElementById('_reportUserModal')?.remove();
      showToast(t('toast.reported', {name: userName}), 'success');
      logMsg(t('log.reportSubmitted', {name: userName, reason}), 'success');
    } else {
      const err = await r.json().catch(() => ({}));
      // Fallback to official site if the API rejects (e.g. not permitted for this content)
      const msg = err.error?.message || ('HTTP ' + r.status);
      if (confirm(t('confirm.reportFailApi', {msg}))) {
        window.open(`https://vrchat.com/home/user/${userId}`, '_blank');
      }
      if (btn) { btn.disabled = false; btn.textContent = t('btn.submitReport'); }
    }
  } catch(e) {
    showToast(t('toast.reportFailMsg', {msg: e.message}), 'error');
    if (btn) { btn.disabled = false; btn.textContent = t('btn.submitReport'); }
  }
}


function toggleFriendFavMenu(event, userId) {
  const menu = document.getElementById("friendFavMenu");
  // We don't have a reliable button ID here as it's coming from ctx menu, 
  // so we use the event coordinate approach for FavMenuGeneric if btn is null
  if (!menu) return;
  
  toggleFavMenuGeneric(event, menu, null, () => {
    if (friendFavGroups.length === 0) return `<div style="padding:8px 12px;font-size:0.8em;color:var(--text-muted);">${t('ctx.noFavGroups')}</div>`;
    return friendFavGroups.map(g =>
      `<button class="avtrdb-fav-group-btn" onclick="addFriendToFavorite('${escJsAttr(userId)}','${escJsAttr(g.name)}',this)">${escHtml(g.displayName || g.name)}</button>`
    ).join("");
  });
}

async function addFriendToFavorite(userId, groupName, btn) {
  const menu = document.getElementById('friendFavMenu');
  if (menu) menu.classList.add('hidden');
  if (btn) btn.disabled = true;
  try {
    const r = await apiCall('/api/vrc/favorites', {
      method: "POST",
      json: { type: "friend", favoriteId: userId, tags: [groupName] },
    });
    if (r.ok) {
      const res = await r.json();
      // Store as { favoriteId, tags } shape (matches shell.js + friends.js).
      // Previously stored a bare string here and the next refresh would
      // overwrite with the object shape — breaking toggleFriendFavorite.
      const existing = friendFavoriteIdMap.get(userId);
      if (existing && existing.tags) {
        if (!existing.tags.includes(groupName)) existing.tags.push(groupName);
      } else {
        friendFavoriteIdMap.set(userId, { favoriteId: res.id, tags: [groupName] });
      }
      logMsg(t('log.addedToFavGroup', {group: groupName}), "success");
      // Refresh the open friend profile so the <i class="fa-solid fa-star"></i> button text updates.
      const modal = document.getElementById('friendProfileModal');
      if (currentFriendProfile && modal && !modal.classList.contains('hidden')) {
        _renderFriendProfileUI(currentFriendProfile, modal);
      }
    } else {
      const err = await r.json().catch(() => ({}));
      showToast(t('toast.favAddFail', {msg: err.error?.message || r.status}), 'error');
    }
  } catch(e) { showToast(t('toast.errorMsg', {msg: e.message}), 'error'); }
  finally { if (btn) btn.disabled = false; }
}

async function toggleFriendFavorite(userId, name) {
  if (friendFavoriteIdMap.has(userId)) {
    const entry = friendFavoriteIdMap.get(userId);
    // entry is { favoriteId, tags } since the unified shape; tolerate the old
    // bare-string layout in case any persisted state wasn't migrated.
    const favId = (entry && typeof entry === 'object') ? entry.favoriteId : entry;
    if (!favId) { showToast(t('toast.favIdMissing'), 'error'); return; }
    if (!confirm(t('confirm.removeFav', {name}))) return;
    try {
      const r = await apiCall(`/api/vrc/favorites/${favId}`, {method:'DELETE'});
      if (r.ok) {
        friendFavoriteIdMap.delete(userId);
        logMsg(t('log.favRemoved', {name}), "info");
        // Refresh the open friend profile so the <i class="fa-solid fa-star"></i> button text updates.
        const modal = document.getElementById('friendProfileModal');
        if (currentFriendProfile && modal && !modal.classList.contains('hidden')) {
          _renderFriendProfileUI(currentFriendProfile, modal);
        }
      } else {
        showToast(t('toast.favRemoveFail', {status: r.status}), 'error');
      }
    } catch(e) { showToast(t('toast.errorMsg', {msg: e.message}), 'error'); }
  }
}

// ═══════════════════════════════════════════════════════════
// USER NOTES (个人备注)  — GET/POST /userNotes
// ═══════════════════════════════════════════════════════════
async function showUserNoteDialog(userId, userName) {
  document.getElementById('_userNoteModal')?.remove();

  // The user object often already carries the existing note; otherwise fetch it.
  let existing = '';
  const cached = (currentFriendProfile && currentFriendProfile.id === userId)
    ? currentFriendProfile
    : (allFriends.find(f => f.id === userId) || null);
  if (cached && typeof cached.note === 'string') existing = cached.note;

  const modal = document.createElement('div');
  modal.id = '_userNoteModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:24px;min-width:min(320px,92vw);max-width:460px;display:flex;flex-direction:column;gap:12px;">
      <div style="font-weight:600;">${t('ctx.noteTitle', {name: escHtml(userName)})}</div>
      <div style="font-size:0.8em;color:rgba(255,255,255,0.5);">${t('ctx.noteHint')}</div>
      <textarea id="_userNoteText" maxlength="256" placeholder="${t('label.userNotePlaceholder')}"
        style="background:#111827;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:10px;color:#fff;resize:none;height:90px;font-family:inherit;">${escHtml(existing)}</textarea>
      <div style="display:flex;gap:8px;">
        <button id="_userNoteSaveBtn" onclick="saveUserNote('${escJsAttr(userId)}','${escJsAttr(userName)}')"
          style="flex:1;background:var(--accent,#52525b);border:none;border-radius:8px;padding:10px;cursor:pointer;color:#fff;font-weight:600;">${t('btn.save')}</button>
        <button onclick="document.getElementById('_userNoteModal')?.remove()"
          style="flex:1;background:rgba(255,255,255,0.08);border:none;border-radius:8px;padding:10px;cursor:pointer;color:#fff;">${t('btn.cancel')}</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.style.zIndex = modalZTop();
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  setTimeout(() => document.getElementById('_userNoteText')?.focus(), 50);
}

async function saveUserNote(userId, userName) {
  const note = document.getElementById('_userNoteText')?.value || '';
  const btn = document.getElementById('_userNoteSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = t('btn.saving'); }
  try {
    const r = await apiCall('/api/vrc/userNotes', {
      method: 'POST',
      json: { targetUserId: userId, note }
    });
    if (r.ok) {
      // Keep local copies in sync so the dialog reflects the change next open
      if (currentFriendProfile && currentFriendProfile.id === userId) currentFriendProfile.note = note;
      const af = allFriends.find(f => f.id === userId);
      if (af) af.note = note;
      document.getElementById('_userNoteModal')?.remove();
      showToast(t('toast.noteSaved', {name: userName}), 'success');
      logMsg(t('log.noteUpdated', {name: userName}), 'success');
    } else {
      const err = await r.json().catch(() => ({}));
      showToast(t('toast.noteSaveFail', {msg: err.error?.message || r.status}), 'error');
      if (btn) { btn.disabled = false; btn.textContent = t('btn.save'); }
    }
  } catch(e) {
    showToast(t('toast.noteSaveFail', {msg: e.message}), 'error');
    if (btn) { btn.disabled = false; btn.textContent = t('btn.save'); }
  }
}

// ═══════════════════════════════════════════════════════════
// FRIEND STATUS / CANCEL OUTGOING REQUEST
// ═══════════════════════════════════════════════════════════
async function cancelFriendRequest(userId, name) {
  if (!confirm(t('confirm.cancelFriendReq', {name}))) return;
  try {
    const r = await apiCall(`/api/vrc/user/${userId}/friendRequest`, { method: 'DELETE' });
    if (r.ok) {
      showToast(t('toast.friendReqCanceled'), 'success');
      logMsg(t('log.friendReqCanceled', {name}), 'info');
      if (currentFriendProfile && currentFriendProfile.id === userId) {
        currentFriendProfile.friendRequestPending = false;
        _refreshFriendProfileIfOpen(userId);
      }
    } else {
      showToast(t('toast.cancelFailStatus', {status: r.status}), 'error');
    }
  } catch(e) { showToast(t('toast.errorMsg', {msg: e.message}), 'error'); }
}

async function friendRequestJoin(userId, name) {
  // Invite yourself to the user's current instance via POST /invite/myself/to/{instanceId}
  const f = currentFriendProfile;
  // Guards must mirror the menu's `isJoinable` exactly. Without `~private` /
  // explicit traveling/offline checks the API will 403 (private), 404 (offline
  // shows location 'offline'), or hang against the transit world while the
  // user is mid-teleport.
  if (!f || !f.location ||
      !f.location.startsWith('wrld_') ||
      f.location === 'offline' ||
      f.location === 'private' ||
      f.location === 'traveling' ||
      f.location.includes('~private')) {
    showToast(t('toast.notInPublicInstance'), 'info');
    return;
  }
  try {
    const r = await apiCall(`/api/vrc/invite/myself/to/${encodeURIComponent(f.location)}`, { method: 'POST' });
    if (r.ok) logMsg(t('log.joinRequested', {name}), 'success');
    else {
      const err = await r.json().catch(() => ({}));
      showToast(t('toast.failIcon', {msg: err.error?.message || r.status}), 'error');
    }
  } catch(e) { showToast(t('toast.failMsg', {msg: e.message}), 'error'); }
}

function friendRequestJoinMsg(userId, name) {
  // Invite yourself to user's instance with a custom message isn't directly supported;
  // We just do the standard self-invite
  if (!confirm(t('confirm.requestJoin', {name}))) return;
  friendRequestJoin(userId, name);
}



// Boop a user — VRChat lets you "boop" with a default emoji OR (if you're VRC+)
// one of your own uploaded emoji. Mirrors VRCX's SendBoopDialog.
async function sendBoop(userId, name) {
  document.getElementById('boopModal')?.remove();
  const z = modalZTop();

  // Default emoji grid (65 photon emojis, same set VRCX offers)
  const defaultGrid = PHOTON_EMOJIS.map(emo =>
    `<button class="boop-emoji" title="${escHtml(emo)}" data-emoji="${escJsAttr(photonEmojiId(emo))}"
       style="font-size:1.4em;padding:0;border-radius:10px;width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:var(--bg-glass);border:1px solid var(--border);cursor:pointer;transition:all 0.12s;">${PHOTON_EMOJI_ICONS[emo] || '<i class="fa-solid fa-comment"></i> '}</button>`
  ).join('');

  const modalHtml = `
  <div id="boopModal" class="modal" style="z-index:${z};" onclick="if(event.target===this)this.remove()">
    <div class="modal-content" style="max-width:420px;width:100%;display:flex;flex-direction:column;gap:12px;">
      <h3 style="margin:0;">${t('ctx.boopTitle', {name: escHtml(name)})}</h3>
      <input id="boopSearch" type="text" class="input-field" placeholder="${t('label.boopSearch')}"
        oninput="_filterBoopEmojis(this.value)" style="width:100%;">
      <div style="font-size:0.72em;color:var(--text-muted);">${t('ctx.defaultEmoji')}</div>
      <div id="boopDefaultGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(44px,1fr));gap:8px;max-height:220px;overflow-y:auto;padding:2px;">
        ${defaultGrid}
      </div>
      <div id="boopCustomWrap" style="display:none;">
        <div style="font-size:0.72em;color:var(--text-muted);margin-bottom:6px;">${t('ctx.customEmoji')}</div>
        <div id="boopCustomGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:8px;max-height:160px;overflow-y:auto;padding:2px;"></div>
      </div>
      <button class="btn btn-secondary" style="width:100%;" onclick="document.getElementById('boopModal').remove()">${t('btn.cancel')}</button>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', modalHtml);

  // Wire default emoji clicks
  const modal = document.getElementById('boopModal');
  modal.querySelectorAll('.boop-emoji').forEach(btn => {
    btn.addEventListener('mouseover', () => { btn.style.background = 'rgba(255,255,255,0.12)'; btn.style.borderColor = 'var(--border-hover)'; });
    btn.addEventListener('mouseout', () => { btn.style.background = 'var(--bg-glass)'; btn.style.borderColor = 'var(--border)'; });
    btn.addEventListener('click', () => { submitBoop(userId, btn.dataset.emoji); modal.remove(); });
  });

  // Load VRC+ custom emoji (only present for supporters; harmless 403 otherwise)
  try {
    const r = await apiCall('/api/vrc/files?tag=emoji&n=100');
    if (r.ok) {
      const files = await r.json();
      if (Array.isArray(files) && files.length && document.getElementById('boopModal') === modal) {
        const grid = document.getElementById('boopCustomGrid');
        grid.innerHTML = files.map(f => {
          const url = proxyImg(extractFileVersionUrl(f));
          return `<div class="boop-custom" data-emoji="${escJsAttr(f.id)}" title="${escHtml(f.name || '')}"
            style="cursor:pointer;border:1px solid var(--border);border-radius:8px;padding:4px;background:var(--bg-glass);display:flex;align-items:center;justify-content:center;">
            <img src="${escHtml(url)}" style="width:48px;height:48px;object-fit:contain;" loading="lazy" onerror="this.style.opacity='0.3'"></div>`;
        }).join('');
        document.getElementById('boopCustomWrap').style.display = '';
        grid.querySelectorAll('.boop-custom').forEach(el => {
          el.addEventListener('click', () => { submitBoop(userId, el.dataset.emoji); modal.remove(); });
        });
      }
    }
  } catch(_) {}
}

// Filter the default boop emoji grid by name (matches VRCX search behavior)
function _filterBoopEmojis(q) {
  q = (q || '').trim().toLowerCase();
  document.querySelectorAll('#boopDefaultGrid .boop-emoji').forEach(btn => {
    const name = (btn.getAttribute('title') || '').toLowerCase();
    btn.style.display = (!q || name.includes(q)) ? '' : 'none';
  });
}

async function submitBoop(userId, emojiId) {
  try {
    // emojiId optional: omitting it sends a plain boop. default_* or file_* both valid.
    const json = emojiId ? { emojiId } : {};
    const r = await apiCall(`/api/vrc/users/${userId}/boop`, { method: 'POST', json });
    if (r.ok) {
      logMsg(t('log.boopSent'), 'success');
      showToast(t('toast.boopSent'), 'success');
    } else {
      const err = await r.json().catch(() => ({}));
      const msg = err.error?.message || ('HTTP ' + r.status);
      // 403/400 usually means the other side has booping disabled
      showToast(t('toast.boopFail', {msg}), 'error');
    }
  } catch(e) { showToast(t('toast.failMsg', {msg: e.message}), 'error'); }
}

async function sendPoke(userId, name, emojiId = 'default_heart') {
  // Use VRChat's actual Boop endpoint
  try {
    const r = await apiCall(`/api/vrc/users/${userId}/boop`, {
      method: 'POST',
      json: { 
        emojiId: emojiId 
      }
    });
    if (r.ok) logMsg(t('log.pokeSent', {name}), 'success');
    else {
      const err = await r.json().catch(() => ({}));
      showToast(t('toast.failIcon', {msg: err.error?.message || r.status}), 'error');
    }
  } catch(e) { showToast(t('toast.failMsg', {msg: e.message}), 'error'); }
}

function showBoopMenu(e, userId, name) {
  // Reuse the shared photon emoji set (defined in core.js)
  const menuItems = PHOTON_EMOJIS.map(emo => ({
    icon: PHOTON_EMOJI_ICONS[emo] || '<i class="fa-solid fa-comment"></i> ',
    label: emo,
    action: () => sendPoke(userId, name, photonEmojiId(emo))
  }));

  const fakeEvent = {
    clientX: e.clientX,
    clientY: e.clientY,
    stopPropagation: () => {}
  };

  const menu = buildCtxMenu([
    { label: t('ctx.boopMenuLabel', {name}), items: menuItems }
  ]);
  positionCtxMenu(fakeEvent, menu);
}

async function requestInvite(userId, name) {
  // POST /api/1/requestInvite/{userId} — ask user to invite YOU to their world
  try {
    const r = await apiCall(`/api/vrc/requestInvite/${userId}`, {
      method: 'POST',
      json: { platform: 'standalonewindows', rsvp: false }
    });
    if (r.ok) logMsg(t('log.requestInviteSent', {name}), 'success');
    else {
      const err = await r.json().catch(() => ({}));
      showToast(t('toast.failIcon', {msg: err.error?.message || r.status}), 'error');
    }
  } catch(e) { showToast(t('toast.failMsg', {msg: e.message}), 'error'); }
}

async function sendInvite(userId, name) {
  // POST /api/1/invite/{userId} — invite user to YOUR current instance
  try {
    const meResp = await apiCall('/api/vrc/auth/user');
    if (!meResp.ok) throw new Error(t('err.cannotGetStatus'));
    const me = await meResp.json();
    if (!me.location || me.location === 'offline' || me.location === 'private') {
      showToast(t('toast.notInPublicForInvite'), 'info');
      return;
    }
    const r = await apiCall(`/api/vrc/invite/${userId}`, {
      method: 'POST',
      json: { instanceId: me.location }
    });
    if (r.ok) logMsg(t('log.inviteSent', {name}), 'success');
    else {
      const err = await r.json().catch(() => ({}));
      showToast(t('toast.failIcon', {msg: err.error?.message || r.status}), 'error');
    }
  } catch(e) { showToast(t('toast.failMsg', {msg: e.message}), 'error'); }
}

async function blockUser(userId, name) {
  if (!confirm(t('confirm.block', {name}))) return;
  try {
    const r = await apiCall(`/api/vrc/auth/user/playermoderations`, {method:'POST', json:{moderated:userId, type:'block'}});
    if (r.ok) {
      // Optimistic update — immediately reflect in menu on next open
      myModerations = myModerations.filter(m => !(m.moderated === userId && m.type === 'block'));
      myModerations.push({ moderated: userId, type: 'block' });
      logMsg(t('log.blocked', {name}), 'success');
      logModerationAction(userId, name, 'block', 'block');
      _refreshFriendProfileIfOpen(userId);
      fetchMyModerations(); // background sync
    } else logMsg(t('log.blockFail', {status: r.status}), 'error');
  } catch(e) { showToast(t('toast.errorMsg', {msg: e.message}), 'error'); }
}

// Helper: re-render the friend profile modal if it's open and showing this user.
// Used after any action that flips state visible in the modal (favorite, block,
// mute, show/hide avatar, interact-off). Without this the badges + button labels
// stay stale until the user manually reopens the profile.
function _refreshFriendProfileIfOpen(userId) {
  if (!currentFriendProfile || currentFriendProfile.id !== userId) return;
  const modal = document.getElementById('friendProfileModal');
  if (modal && !modal.classList.contains('hidden')) {
    _renderFriendProfileUI(currentFriendProfile, modal);
  }
}

async function unblockUser(userId, name) {
  try {
    const r = await apiCall(`/api/vrc/auth/user/unplayermoderate`, {method:'PUT', json:{moderated:userId, type:'block'}});
    if (r.ok) {
      myModerations = myModerations.filter(m => !(m.moderated === userId && m.type === 'block'));
      logMsg(t('log.unblocked', {name}), 'success');
      logModerationAction(userId, name, 'block', 'unblock');
      _refreshFriendProfileIfOpen(userId);
      fetchMyModerations();
    } else logMsg(t('log.unblockFail', {status: r.status}), 'error');
  } catch(e) { showToast(t('toast.errorMsg', {msg: e.message}), 'error'); }
}

async function muteUser(userId, name) {
  if (!confirm(t('confirm.mute', {name}))) return;
  try {
    const r = await apiCall(`/api/vrc/auth/user/playermoderations`, {method:'POST', json:{moderated:userId, type:'mute'}});
    if (r.ok) {
      myModerations = myModerations.filter(m => !(m.moderated === userId && m.type === 'mute'));
      myModerations.push({ moderated: userId, type: 'mute' });
      logMsg(t('log.muted', {name}), 'success');
      logModerationAction(userId, name, 'mute', 'mute');
      _refreshFriendProfileIfOpen(userId);
      fetchMyModerations();
    } else logMsg(t('log.muteFail', {status: r.status}), 'error');
  } catch(e) { showToast(t('toast.errorMsg', {msg: e.message}), 'error'); }
}

async function unmuteUser(userId, name) {
  try {
    const r = await apiCall(`/api/vrc/auth/user/unplayermoderate`, {method:'PUT', json:{moderated:userId, type:'mute'}});
    if (r.ok) {
      myModerations = myModerations.filter(m => !(m.moderated === userId && m.type === 'mute'));
      logMsg(t('log.unmuted', {name}), 'success');
      logModerationAction(userId, name, 'mute', 'unmute');
      _refreshFriendProfileIfOpen(userId);
      fetchMyModerations();
    } else logMsg(t('log.unmuteFail', {status: r.status}), 'error');
  } catch(e) { showToast(t('toast.errorMsg', {msg: e.message}), 'error'); }
}

async function showAvatarUser(userId, name) {
  try {
    const r = await apiCall(`/api/vrc/auth/user/playermoderations`, {method:'POST', json:{moderated:userId, type:'showAvatar'}});
    if (r.ok) {
      // Remove conflicting hideAvatar, add showAvatar
      myModerations = myModerations.filter(m => !(m.moderated === userId && (m.type === 'showAvatar' || m.type === 'hideAvatar')));
      myModerations.push({ moderated: userId, type: 'showAvatar' });
      logMsg(t('log.showAvatar', {name}), 'success');
      logModerationAction(userId, name, 'avatar', 'show');
      _refreshFriendProfileIfOpen(userId);
      fetchMyModerations();
    } else logMsg(t('log.opFail', {status: r.status}), 'error');
  } catch(e) { showToast(t('toast.errorMsg', {msg: e.message}), 'error'); }
}

async function hideAvatarUser(userId, name) {
  try {
    const r = await apiCall(`/api/vrc/auth/user/playermoderations`, {method:'POST', json:{moderated:userId, type:'hideAvatar'}});
    if (r.ok) {
      // Remove conflicting showAvatar, add hideAvatar
      myModerations = myModerations.filter(m => !(m.moderated === userId && (m.type === 'showAvatar' || m.type === 'hideAvatar')));
      myModerations.push({ moderated: userId, type: 'hideAvatar' });
      logMsg(t('log.hideAvatar', {name}), 'success');
      logModerationAction(userId, name, 'avatar', 'hide');
      _refreshFriendProfileIfOpen(userId);
      fetchMyModerations();
    } else logMsg(t('log.opFail', {status: r.status}), 'error');
  } catch(e) { showToast(t('toast.errorMsg', {msg: e.message}), 'error'); }
}

async function disableAvatarInteraction(userId, name) {
  try {
    const r = await apiCall(`/api/vrc/auth/user/playermoderations`, {method:'POST', json:{moderated:userId, type:'interactOff'}});
    if (r.ok) {
      myModerations = myModerations.filter(m => !(m.moderated === userId && m.type === 'interactOff'));
      myModerations.push({ moderated: userId, type: 'interactOff' });
      logMsg(t('log.interactOff', {name}), 'success');
      logModerationAction(userId, name, 'avatar', 'disableInteraction');
      _refreshFriendProfileIfOpen(userId);
      fetchMyModerations();
    } else logMsg(t('log.opFail', {status: r.status}), 'error');
  } catch(e) { showToast(t('toast.errorMsg', {msg: e.message}), 'error'); }
}

async function resetAvatarModeration(userId, name, type) {
  try {
    const r = await apiCall(`/api/vrc/auth/user/unplayermoderate`, {method:'PUT', json:{moderated:userId, type}});
    if (r.ok) {
      // Remove the specific moderation entry
      myModerations = myModerations.filter(m => !(m.moderated === userId && m.type === type));
      const typeText = { showAvatar:t('label.avatarModeration.showAvatar'), hideAvatar:t('label.avatarModeration.hideAvatar'), interactOff:t('label.avatarModeration.interactOff') }[type] || type;
      logMsg(t('log.resetModeration', {name, type: typeText}), 'success');
      logModerationAction(userId, name, 'avatar', 'reset_' + type);
      _refreshFriendProfileIfOpen(userId);
      fetchMyModerations();
    } else logMsg(t('log.resetFail', {status: r.status}), 'error');
  } catch(e) { showToast(t('toast.errorMsg', {msg: e.message}), 'error'); }
}

async function fetchSharedInstances(userId) {
  try {
    const r = await apiCall(`/api/vrc/user/${userId}/instances`);
    const data = r.ok ? await r.json() : null;
    if (!data || !data.length) { showToast(t('toast.noSharedRooms'), 'info'); return; }
    alert(t('alert.sharedRooms', {list: data.slice(0,10).map(i=>i.worldName||i.world||i).join('\n')}));
  } catch(e) { showToast(t('toast.loadFailMsg', {msg: e.message}), 'error'); }
}

// ═══════════════════════════════════════════════════════════
// SELF CONTEXT MENU
// ═══════════════════════════════════════════════════════════
function showSelfContextMenu(e) {
  e.stopPropagation();
  const u = myProfileData;
  if (!u) return;
  const id = u.id || '';
  const curStatus = u.status || 'active';
  const statusDots = { active: '🟢', 'join me': '🔵', 'ask me': '🟡', busy: '🔴' };

  const menu = buildCtxMenu([
    { items: [
      { icon:'<i class="fa-solid fa-rotate-right"></i> ', label:t('ctx.refreshMyProfile'), action: () => {
        myProfileData = null;
        fetchMyProfile(true).then(() => logMsg(t('log.profileRefreshed'), 'success'));
      }},
      { icon:'<i class="fa-solid fa-link"></i> ', label:t('ctx.openVrcHome'), action: () => window.open(`https://vrchat.com/home/user/${id}`, '_blank') },
      { icon:'<i class="fa-solid fa-clipboard"></i> ', label:t('ctx.copyMyId'), action: () => navigator.clipboard.writeText(id).then(() => logMsg(t('log.idCopiedIcon'), 'info')) },
    ]},
    { label:t('ctx.quickStatus'), items: [
      { icon: curStatus === 'active'  ? '<i class="fa-solid fa-check"></i> ' : statusDots['active'],  label:'Online (Active)',        action: () => quickSetStatus('active') },
      { icon: curStatus === 'join me' ? '<i class="fa-solid fa-check"></i> ' : statusDots['join me'], label:'Join Me',                action: () => quickSetStatus('join me') },
      { icon: curStatus === 'ask me'  ? '<i class="fa-solid fa-check"></i> ' : statusDots['ask me'],  label:'Ask Me',                 action: () => quickSetStatus('ask me') },
      { icon: curStatus === 'busy'    ? '<i class="fa-solid fa-check"></i> ' : statusDots['busy'],    label:t('ctx.statusBusy'),             action: () => quickSetStatus('busy') },
    ]},
    { label:t('ctx.sectionAvatarInfo'), items: [
      { icon:'<i class="fa-solid fa-user"></i> ', label:t('ctx.showCurrentAvatar'), action: () => {
        const avId = u.currentAvatarId || u.currentAvatar;
        if (!avId) { showToast(t('toast.avatarIdUnavailable'), 'error'); return; }
        openAvtrdbDetail({ vrc_id: avId, name: u.currentAvatarName || avId,
          image_url: u.currentAvatarThumbnailImageUrl || '' });
      }},
      { icon:'<i class="fa-solid fa-user"></i> ', label:t('ctx.showFallbackAvatar'), action: () => showFallbackAvatarInfo() },
      { icon:'🖼️', label:t('ctx.goToAvatars'), action: () => switchTab('download') },
    ]},
    { label:t('ctx.sectionAccount'), items: [
      { icon:'✏️', label:t('ctx.editBio'), action: () => openEditProfileModal() },
      { icon:'<i class="fa-solid fa-lock"></i> ', label:t('ctx.toggleClone'), action: () => toggleAvatarCopying() },
    ]},
  ]);
  positionCtxMenu(e, menu);
}

async function quickSetStatus(newStatus) {
  const u = myProfileData;
  if (!u || !u.id) return;
  const labels = { active: 'Online', 'join me': 'Join Me', 'ask me': 'Ask Me', busy: 'Busy' };
  try {
    const r = await apiCall(`/api/vrc/users/${u.id}`, { method: 'PUT', json: { status: newStatus } });
    if (r.ok) {
      myProfileData.status = newStatus;
      logMsg(t('log.statusSwitched', {status: labels[newStatus] || newStatus}), 'success');
      fetchMyProfile(true);
    } else {
      const err = await r.json().catch(() => ({}));
      showToast(t('toast.statusSwitchFail', {msg: err.error?.message || r.status}), 'error');
    }
  } catch(ex) { showToast(t('toast.failMsg', {msg: ex.message}), 'error'); }
}

async function showFallbackAvatarInfo() {
  const u = myProfileData;
  if (!u) return;
  const fallbackId = u.fallbackAvatar;
  if (!fallbackId) {
    alert(t('alert.noFallback'));
    return;
  }
  try {
    const r = await apiCall(`/api/vrc/avatars/${fallbackId}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const av = await r.json();
    openAvtrdbDetail({
      vrc_id: av.id,
      name: av.name || fallbackId,
      image_url: av.thumbnailImageUrl || av.imageUrl || '',
      author: { name: av.authorName || 'Unknown', id: av.authorId },
      description: av.description || '',
      unityPackages: av.unityPackages || [],
      performance: av.performance || {},
      created_at: av.created_at || av.createdAt,
      updated_at: av.updated_at || av.updatedAt,
    });
  } catch(ex) { showToast(t('toast.fallbackLoadFail', {msg: ex.message}), 'error'); }
}

async function toggleAvatarCopying() {
  const u = myProfileData;
  if (!u || !u.id) return;
  const newVal = !u.allowAvatarCopying;
  if (!confirm(t('confirm.toggleClone', {val: newVal ? t('label.cloneAllowed') : t('label.cloneDisallowed')}))) return;
  try {
    const r = await apiCall(`/api/vrc/users/${u.id}`, { method: 'PUT', json: { allowAvatarCopying: newVal } });
    if (r.ok) {
      myProfileData.allowAvatarCopying = newVal;
      logMsg(t('log.cloneSet', {val: newVal ? t('label.cloneAllowed') : t('label.cloneDisallowed')}), 'success');
      fetchMyProfile(true);
    } else {
      const err = await r.json().catch(() => ({}));
      showToast(t('toast.failIcon', {msg: err.error?.message || r.status}), 'error');
    }
  } catch(ex) { showToast(t('toast.failMsg', {msg: ex.message}), 'error'); }
}



// ═══════════════════════════════════════════════════════════
// GALLERY ONLY (VRC+ 相册, no prints)
// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════

VRCW.registerModule('contextMenu', { closeCtxMenu, showOwnedAvatarMenu, buildCtxMenu, positionCtxMenu, showFriendContextMenu, showGroupInviteMenu, doGroupInvite, showReportUserDialog, submitUserReport, toggleFriendFavMenu, addFriendToFavorite, toggleFriendFavorite, showUserNoteDialog, saveUserNote, cancelFriendRequest, friendRequestJoin, friendRequestJoinMsg, sendBoop, submitBoop, sendPoke, showBoopMenu, requestInvite, sendInvite, blockUser, unblockUser, muteUser, unmuteUser, showAvatarUser, hideAvatarUser, disableAvatarInteraction, resetAvatarModeration, fetchSharedInstances, showSelfContextMenu, quickSetStatus, showFallbackAvatarInfo, toggleAvatarCopying });
renderAppVersionInfo();

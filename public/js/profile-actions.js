/*
 * VRCW - profile-actions.js
 * Cross-page profile, invite, and moderation actions.
 */

async function inviteSelf(locationId) {
  if (!locationId || locationId === 'private' || locationId === 'offline') {
    friendLogMsg(t('log.inviteSelfFail'), 'error');
    return;
  }
  try {
    friendLogMsg(t('log.inviteSelfSending', {loc: locationId}), 'info');
    const r = await apiCall(`/api/vrc/invite/myself/to/${locationId}`, { method: 'POST' });
    if (r.ok) {
      friendLogMsg(t('log.inviteSelfSent'), 'success');
    } else {
      const err = await r.json();
      throw new Error(err.error?.message || t('error.sendFail'));
    }
  } catch(e) {
    friendLogMsg(t('log.inviteSelfError', {msg: e.message}), 'error');
  }
}

async function renderModerationLog() {
  const container = document.getElementById('modLogList');
  if (!container) return;
  try {
    const logs = await idb.getAllLogs('mod_logs');
    if (!logs || !logs.length) {
      container.innerHTML = '<div style="text-align:center;padding:40px;color:rgba(255,255,255,0.3);">'+t('modlog.empty')+'</div>';
      return;
    }
    // Sort by timestamp descending
    logs.sort((a,b) => b.timestamp - a.timestamp);
    container.innerHTML = logs.map(log => {
      const date = new Date(log.timestamp).toLocaleString();
      let icon = '🛡️', color = 'var(--text-secondary)';
      if (log.type === 'block') { icon = '<i class="fa-solid fa-ban"></i> '; color = '#ef4444'; }
      if (log.type === 'mute')  { icon = '<i class="fa-solid fa-volume-xmark"></i> '; color = '#f59e0b'; }
      if (log.type === 'avatar') { icon = log.action === 'show' ? '👁️' : '<i class="fa-solid fa-glasses"></i> '; color = '#10b981'; }
      const actionText = {
        block: t('modlog.block'), unblock: t('modlog.unblock'),
        mute: t('modlog.mute'), unmute: t('modlog.unmute'),
        show: t('modlog.show'), hide: t('modlog.hide')
      }[log.action] || log.action;
      return `
        <div class="glass-card" style="padding:12px 16px;margin-bottom:8px;display:flex;align-items:center;gap:12px;border:1px solid var(--border);border-radius:12px;">
          <div style="font-size:1.5em;">${icon}</div>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <strong style="color:var(--text-primary);font-size:0.95em;">${escHtml(log.displayName)}</strong>
              <span style="font-size:0.75em;color:rgba(255,255,255,0.3);">${date}</span>
            </div>
            <div style="font-size:0.85em;color:${color};margin-top:2px;">${actionText}</div>
            <div style="font-size:0.7em;color:rgba(255,255,255,0.2);margin-top:2px;">ID: ${log.userId}</div>
          </div>
        </div>`;
    }).join('');
  } catch(e) {
    if (isAbortError(e)) return;
    container.innerHTML = '<div style="color:var(--text-danger);text-align:center;padding:20px;">'+t('modlog.loadFail', {msg: escHtml(e.message)})+'</div>';
  }
}

async function clearModerationLog() {
  if (!confirm(t('confirm.clearModlog'))) return;
  await idb.clearLogs('mod_logs');
  renderModerationLog();
}

async function logModerationAction(userId, displayName, type, action) {
  try {
    const log = {
      userId,
      displayName,
      type, // 'block', 'mute', 'avatar'
      action, // 'block', 'unblock', 'mute', 'unmute', 'show', 'hide'
      timestamp: Date.now()
    };
    await idb.addLog('mod_logs', log);
  } catch(e) { console.error('logModerationAction error:', e); }
}

async function fetchMyModerations() {
  try {
    const r = await apiCall('/api/vrc/auth/user/playermoderations');
    if (r.ok) {
      myModerations = await r.json();
      // Don't re-render the friend modal here. The previous code rebuilt the
      // entire friend profile UI (including snapping back to the info tab),
      // breaking the user's flow if they were reading another sub-tab. The
      // moderations data is read on next user interaction.
    }
  } catch(e) { console.error('fetchMyModerations error:', e); }
}

async function openEditProfileModal() {
  const u = myProfileData;
  if (!u) {
    showToast(t('toast.loadingProfile'), 'info');
    return;
  }
  
  const modal = document.createElement('div');
  modal.className = 'modal';
  // Use modalZTop() so this modal stacks above any already-open modal (was hard-
  // coded to 2000, which sits at the bottom of the modal range and got covered).
  modal.style.zIndex = modalZTop();
  modal.dataset.scrollLocked = '1';
  lockBodyScroll();
  // Click-on-overlay closes the modal (matches the rest of the app).
  modal.onclick = (e) => { if (e.target === modal) { modal.remove(); cleanup(); } };
  // Esc closes too. The handler is one-shot — it tears itself down once the modal
  // goes away, so opening the dialog repeatedly doesn't pile up listeners.
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      modal.remove();
      cleanup();
    }
  };
  function cleanup() {
    document.removeEventListener('keydown', escHandler);
    if (modal.dataset.scrollLocked === '1') { unlockBodyScroll(); modal.dataset.scrollLocked = ''; }
  }
  document.addEventListener('keydown', escHandler);
  modal.innerHTML = `
    <div class="modal-content glass" style="max-width:500px;padding:24px;width:90%;border:1px solid var(--border);border-radius:16px;">
      <h3 style="margin-bottom:20px;display:flex;align-items:center;gap:10px;font-size:1.1em;">
        <span>✏️</span> ${t('profile.editTitle')}
      </h3>
      <div style="display:flex;flex-direction:column;gap:16px;">
        <div class="form-group" style="display:flex;flex-direction:column;gap:6px;">
          <label style="font-size:0.85em;color:var(--text-secondary);">${t('profile.statusLabel')}</label>
          <select id="editProfileStatus" class="glass-input" style="width:100%;padding:10px;border-radius:8px;background:rgba(255,255,255,0.05);color:var(--text-primary);border:1px solid var(--border);outline:none;">
            <option value="active" ${u.status === 'active' ? 'selected' : ''} style="background:var(--bg-card);color:var(--text-primary);">Online (🟢 Active)</option>
            <option value="join me" ${u.status === 'join me' ? 'selected' : ''} style="background:var(--bg-card);color:var(--text-primary);">Join Me (🔵 Join)</option>
            <option value="ask me" ${u.status === 'ask me' ? 'selected' : ''} style="background:var(--bg-card);color:var(--text-primary);">Ask Me (🟡 Ask)</option>
            <option value="busy" ${u.status === 'busy' ? 'selected' : ''} style="background:var(--bg-card);color:var(--text-primary);">Busy (🔴 Busy)</option>
          </select>
        </div>
        <div class="form-group" style="display:flex;flex-direction:column;gap:6px;">
          <label style="font-size:0.85em;color:var(--text-secondary);">${t('profile.statusDescLabel')}</label>
          <input type="text" id="editStatusDesc" class="glass-input" style="width:100%;padding:10px;border-radius:8px;background:rgba(255,255,255,0.05);color:var(--text-primary);border:1px solid var(--border);" value="${escHtml(u.statusDescription || '')}" placeholder="${escHtml(t('profile.statusDescPlaceholder'))}">
        </div>
        <div class="form-group" style="display:flex;flex-direction:column;gap:6px;">
          <label style="font-size:0.85em;color:var(--text-secondary);">${t('profile.pronounsLabel')}</label>
          <input type="text" id="editPronouns" class="glass-input" style="width:100%;padding:10px;border-radius:8px;background:rgba(255,255,255,0.05);color:var(--text-primary);border:1px solid var(--border);" value="${escHtml(u.pronouns || '')}" placeholder="He/Him, She/Her...">
        </div>
        <div class="form-group" style="display:flex;flex-direction:column;gap:6px;">
          <label style="font-size:0.85em;color:var(--text-secondary);">${t('profile.bioLabel')}</label>
          <textarea id="editBio" class="glass-input" style="width:100%;height:140px;resize:none;padding:10px;border-radius:8px;background:rgba(255,255,255,0.05);color:var(--text-primary);border:1px solid var(--border);font-family:inherit;font-size:0.9em;line-height:1.5;">${escHtml(u.bio || '').replace(/\\n/g, '\n')}</textarea>
        </div>
        <div style="display:flex;gap:12px;margin-top:10px;">
          <button class="btn btn-primary" style="flex:1;padding:12px;" id="btnUpdateProfile">${t('profile.save')}</button>
          <button class="btn btn-secondary" style="flex:1;padding:12px;" id="btnCancelEditProfile">${t('btn.cancel')}</button>
        </div>
      </div>
    </div>`;
  
  document.body.appendChild(modal);

  document.getElementById('btnCancelEditProfile').onclick = () => { modal.remove(); cleanup(); };

  document.getElementById('btnUpdateProfile').onclick = async () => {
    const btn = document.getElementById('btnUpdateProfile');
    btn.disabled = true;
    btn.textContent = t('profile.saving');
    try {
      const payload = {
        status: document.getElementById('editProfileStatus').value,
        statusDescription: document.getElementById('editStatusDesc').value,
        pronouns: document.getElementById('editPronouns').value,
        bio: document.getElementById('editBio').value
      };
      // VRChat users PUT endpoint
      const r = await apiCall(`/api/vrc/users/${u.id}`, { method: 'PUT', json: payload });
      if (r.ok) {
        // Toast instead of native alert — closing the modal first lets the
        // toast appear over the (now-refreshing) page rather than chaining
        // two click-to-dismiss dialogs.
        modal.remove();
        cleanup();
        showToast(t('toast.profileUpdated'), 'success');
        fetchMyProfile(true);
      } else {
        const err = await r.json().catch(() => ({}));
        showToast(t('toast.profileUpdateFail', {msg: err.error?.message || ('HTTP ' + r.status)}), 'error');
        btn.disabled = false;
        btn.textContent = t('profile.save');
      }
    } catch(e) {
      showToast(t('toast.errorOccurred', {msg: e.message}), 'error');
      btn.disabled = false;
      btn.textContent = t('profile.save');
    }
  };
}

VRCW.registerModule('profileActions', {
  inviteSelf,
  renderModerationLog,
  clearModerationLog,
  logModerationAction,
  fetchMyModerations,
  openEditProfileModal,
});
renderAppVersionInfo();

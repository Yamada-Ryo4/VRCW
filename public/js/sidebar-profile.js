/*
 * VRCW - sidebar-profile.js
 * Resident sidebar mini-profile renderer used by friends/profile startup flows.
 */

function renderSidebarMiniProfile(u) {
  const el = document.getElementById('sidebarMyMiniProfile');
  if (!el || !u) return;
  const statusColor = { active: '#3b82f6', 'join me': '#52525b', 'ask me': '#f59e0b', busy: '#ef4444', offline: '#475569' }[u.status] || '#22c55e';
  const vrcP = isVRCPlus && isVRCPlus(u.tags || []);
  const thumb = proxyImg(u.profilePicOverrideThumbnail || u.userIcon || u.currentAvatarThumbnailImageUrl || '');
  const statusText = u.statusDescription || u.bio || '????????';
  el.innerHTML = `
    <div class="mini-dot" style="background:${statusColor};"></div>
    <img class="mini-avatar" ${imageSrcAttrs(thumb)} onerror="this.style.display='none'">
    <div class="mini-profile-text">
      <div class="mini-name" title="${escHtml(u.displayName || '')}">${escHtml(u.displayName || '')}${vrcP ? ' <span class="mini-vrc-plus">VRC+</span>' : ''}</div>
      <div class="mini-status" title="${escHtml(statusText)}">${escHtml(statusText)}</div>
    </div>
  `;
  observeImages(el, { lazy: false });
  el.onclick = () => fetchMyProfile();
}

VRCW.registerModule('sidebarProfile', {
  renderSidebarMiniProfile,
});
renderAppVersionInfo();

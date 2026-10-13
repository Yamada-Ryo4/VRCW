/*
 * VRCW - sidebar-profile.js
 * Resident sidebar mini-profile renderer used by friends/profile startup flows.
 */

function renderSidebarMiniProfile(u) {
  const el = document.getElementById('sidebarMyMiniProfile');
  if (!el || !u) return;
  const statusColor = { active: '#22c55e', 'join me': '#1A75FF', 'ask me': '#f59e0b', busy: '#ef4444', offline: '#475569' }[u.status] || '#475569';
  const vrcP = isVRCPlus && isVRCPlus(u.tags || []);
  const thumb = proxyImg(u.profilePicOverrideThumbnail || u.userIcon || u.currentAvatarThumbnailImageUrl || '');
  const statusText = (typeof u.statusDescription === 'string' ? u.statusDescription.trim() : '')
    || (typeof getStatusLabel === 'function' ? getStatusLabel(u) : '')
    || u.status
    || t('stat.offline');
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', t('myProfile'));
  el.innerHTML = `
    <div class="mini-dot" style="background:${statusColor};"></div>
    <img class="mini-avatar" ${imageSrcAttrs(thumb)} onerror="this.style.display='none'">
    <div class="mini-profile-text">
      <div class="mini-name" title="${escHtml(u.displayName || '')}">${escHtml(u.displayName || '')}${vrcP ? ' <span class="mini-vrc-plus">VRC+</span>' : ''}</div>
      <div class="mini-status" title="${escHtml(statusText)}">${escHtml(statusText)}</div>
    </div>
  `;
  observeImages(el, { lazy: false });
  const openProfile = () => switchFriendCategory('myprofile');
  el.onclick = openProfile;
  el.onkeydown = event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openProfile();
    }
  };
}

VRCW.registerModule('sidebarProfile', {
  renderSidebarMiniProfile,
});
renderAppVersionInfo();

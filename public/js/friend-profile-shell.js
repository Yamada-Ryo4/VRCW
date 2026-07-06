/*
 * VRCW - friend-profile-shell.js
 * Resident wrappers for the heavier friend profile modal implementation.
 */

function _loadFriendProfileModule() {
  if (VRCW.modules.friendProfile) return Promise.resolve(VRCW.modules.friendProfile);
  return loadScriptOnce('js/friend-profile.js?v=' + APP_CACHE_VERSION).then(() => {
    if (!VRCW.modules.friendProfile) throw new Error('Friend profile module did not register');
    return VRCW.modules.friendProfile;
  });
}

function _callFriendProfile(name, args) {
  return _loadFriendProfileModule().then(module => {
    const fn = module && module[name];
    if (typeof fn !== 'function') throw new Error('Friend profile function not available: ' + name);
    return fn.apply(window, args);
  }).catch(err => {
    console.error(err);
    showToast(t('toast.friendProfileModuleLoadFail', {msg: err.message}), 'error');
  });
}

function openFriendProfile(el) { return _callFriendProfile('openFriendProfile', arguments); }
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
function _renderFriendProfileUI(f, modal) { return _callFriendProfile('_renderFriendProfileUI', arguments); }
function closeFriendProfile() { return _callFriendProfile('closeFriendProfile', arguments); }
function switchFriendProfileTab(tab) { return _callFriendProfile('switchFriendProfileTab', arguments); }
function deleteFriend(userId, name) { return _callFriendProfile('deleteFriend', arguments); }
function sendFriendRequest(userId, name) { return _callFriendProfile('sendFriendRequest', arguments); }

VRCW.registerModule('friendProfileShell', {
  load: _loadFriendProfileModule,
});
renderAppVersionInfo();

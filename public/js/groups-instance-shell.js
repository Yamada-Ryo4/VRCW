/*
 * VRCW - groups-instance-shell.js
 * Resident wrappers for group detail, instance detail, and mutual friend loaders.
 */

function _loadGroupsInstanceModule() {
  if (VRCW.modules.groupsInstance) return Promise.resolve(VRCW.modules.groupsInstance);
  return loadScriptOnce('js/groups-instance.js?v=' + APP_CACHE_VERSION).then(() => {
    if (!VRCW.modules.groupsInstance) throw new Error('Groups/instance module did not register');
    return VRCW.modules.groupsInstance;
  });
}

function _callGroupsInstance(name, args) {
  return _loadGroupsInstanceModule().then(module => {
    const fn = module && module[name];
    if (typeof fn !== 'function') throw new Error('Groups/instance function not available: ' + name);
    return fn.apply(window, args);
  }).catch(err => {
    console.error(err);
    showToast(t('toast.groupsInstanceModuleLoadFail', {msg: err.message}), 'error');
  });
}

function loadMyGroups() { return _callGroupsInstance('loadMyGroups', arguments); }
function openGroupDetail(groupId) { return _callGroupsInstance('openGroupDetail', arguments); }
function closeGroupDetail() { return _callGroupsInstance('closeGroupDetail', arguments); }
function vrcGroupAction(groupId, action, myId, nextVis) { return _callGroupsInstance('vrcGroupAction', arguments); }
function switchGroupDetailTab(btn, tab) { return _callGroupsInstance('switchGroupDetailTab', arguments); }
function fetchGroupExtraData(groupId, groupContext, token) { return _callGroupsInstance('fetchGroupExtraData', arguments); }
function fetchGroupInstances(groupId, groupContext, token) { return _callGroupsInstance('fetchGroupInstances', arguments); }
function fetchGroupMembers(groupId, token) { return _callGroupsInstance('fetchGroupMembers', arguments); }
function fetchInstanceOccupancy(loc, token) { return _callGroupsInstance('fetchInstanceOccupancy', arguments); }
function openInstanceDetail(loc) { return _callGroupsInstance('openInstanceDetail', arguments); }
function closeInstanceDetail() { return _callGroupsInstance('closeInstanceDetail', arguments); }
function fetchMutualGroups(userId, containerId) { return _callGroupsInstance('fetchMutualGroups', arguments); }
function fetchMutualFriends(userId, containerId, seq) { return _callGroupsInstance('fetchMutualFriends', arguments); }

VRCW.registerModule('groupsInstanceShell', {
  load: _loadGroupsInstanceModule,
});
renderAppVersionInfo();

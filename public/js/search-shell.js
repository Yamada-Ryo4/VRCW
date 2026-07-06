/*
 * VRCW - search-shell.js
 * Lightweight resident wrappers for the heavy search module.
 */

function _loadSearchModule() {
  if (VRCW.modules.search) return Promise.resolve(VRCW.modules.search);
  return loadScriptOnce('js/search.js?v=' + APP_CACHE_VERSION).then(() => {
    if (!VRCW.modules.search) throw new Error('Search module did not register');
    return VRCW.modules.search;
  });
}

function _callSearch(name, args) {
  return _loadSearchModule().then(module => {
    const fn = module && module[name];
    if (typeof fn !== 'function') throw new Error('Search function not available: ' + name);
    return fn.apply(window, args);
  }).catch(err => {
    console.error(err);
    showToast(t('toast.searchModuleLoadFail', {msg: err.message}), 'error');
  });
}

function onSearchCategoryChange() { return _callSearch('onSearchCategoryChange', arguments); }
function onAvtrdbInput() { return _callSearch('onAvtrdbInput', arguments); }
function doAvtrdbSearch() { return _callSearch('doAvtrdbSearch', arguments); }
function avtrdbLoadMore() { return _callSearch('avtrdbLoadMore', arguments); }
function setAvtrdbSort(mode) { return _callSearch('setAvtrdbSort', arguments); }
function setAvtrdbMatchField(field) { return _callSearch('setAvtrdbMatchField', arguments); }
function openAvtrdbDetail(av) { return _callSearch('openAvtrdbDetail', arguments); }
function closeAvtrdbDetail() { return _callSearch('closeAvtrdbDetail', arguments); }
function toggleAvatarFavGridMenu(event, id, name, btn) { return _callSearch('toggleAvatarFavGridMenu', arguments); }
function toggleAvtrdbFavMenu(event) { return _callSearch('toggleAvtrdbFavMenu', arguments); }
function addToFavorite(avtrId, groupName, btn) { return _callSearch('addToFavorite', arguments); }
function unfavoriteFromGroup(avtrId, groupName, btn) { return _callSearch('unfavoriteFromGroup', arguments); }
function _refreshDetailAfterFavChange(avtrId) { return _callSearch('_refreshDetailAfterFavChange', arguments); }
function saveCurrentDetailToLocal() { return _callSearch('saveCurrentDetailToLocal', arguments); }
function openLocalDetail(id) { return _callSearch('openLocalDetail', arguments); }
function openInVRCX(avtrId) { return _callSearch('openInVRCX', arguments); }
function switchAvatar(avtrId) { return _callSearch('switchAvatar', arguments); }
function setFallbackAvatar(avtrId, name) { return _callSearch('setFallbackAvatar', arguments); }
function enqueueImpostor(avtrId, name) { return _callSearch('enqueueImpostor', arguments); }
function deleteImpostor(avtrId, name) { return _callSearch('deleteImpostor', arguments); }

VRCW.registerModule('searchShell', {
  load: _loadSearchModule,
});
renderAppVersionInfo();

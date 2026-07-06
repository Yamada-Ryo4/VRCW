/*
 * VRCW - worlds-shell.js
 * Lightweight resident world wrappers and favorite group sidebar rendering.
 */

let worldsLoaded = false;
let currentWorldCategory = 'recent';

function renderWorldFavGroupButtons(message) {
  const container = document.getElementById('worldFavGroupList');
  if (!container) return;

  const groups = Array.isArray(worldFavGroups) ? worldFavGroups : [];
  const groupByName = new Map(groups.filter(g => g && g.name).map(g => [g.name, g]));
  const myTags = (typeof myProfileData !== 'undefined' && myProfileData && myProfileData.tags) || [];
  const hasVrcPlus = typeof isVRCPlus === 'function' && isVRCPlus(myTags);
  const slotNames = ['worlds1', 'worlds2', 'worlds3', 'worlds4'];
  if (hasVrcPlus) slotNames.push('vrcPlusWorlds1', 'vrcPlusWorlds2', 'vrcPlusWorlds3', 'vrcPlusWorlds4');

  const rendered = new Set();
  let html = slotNames.map(name => {
    const g = groupByName.get(name) || { name, displayName: name };
    rendered.add(name);
    const isPlus = name.startsWith('vrcPlusWorlds') || g.type === 'vrcPlusWorld';
    const count = worldFavGroupCounts.get(name);
    const countLabel = Number.isFinite(count) ? ` (${count}/100)` : '';
    const icon = isPlus ? 'VRC+' : '*';
    return makeCatBtn(`${icon} ${escHtml(g.displayName || g.name)}${countLabel}`, `switchWorldCategory('fav_${name}')`, `worldCatFav_${name}`);
  }).join('');

  html += groups
    .filter(g => g && g.name && !rendered.has(g.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map(g => {
      const icon = (g.name.startsWith('vrcPlusWorlds') || g.type === 'vrcPlusWorld') ? 'VRC+' : '*';
      return makeCatBtn(`${icon} ${escHtml(g.displayName || g.name)}`, `switchWorldCategory('fav_${escJsAttr(g.name)}')`, `worldCatFav_${g.name}`);
    }).join('');

  html += makeCatBtn('My Worlds', "switchWorldCategory('mine')", 'worldCatMine');
  if (message) html = `<div style="font-size:0.75em;color:var(--text-muted);padding:4px 0 8px;line-height:1.5;">${escHtml(message)}</div>` + html;
  container.innerHTML = html || '<div style="font-size:0.75em;color:var(--text-muted);padding:4px 0;">No favorite groups</div>';
}

async function loadWorldFavGroups() {
  const container = document.getElementById('worldFavGroupList');
  if (container) container.innerHTML = '<div style="font-size:0.75em;color:var(--text-muted);padding:4px 0;">Loading...</div>';
  try {
    const [standardResp, plusResp] = await Promise.all([
      apiCall('/api/vrc/favorite/groups?type=world&n=50', { noAbort: true }),
      apiCall('/api/vrc/favorite/groups?type=vrcPlusWorld&n=50', { noAbort: true }),
    ]);
    const standard = standardResp.ok ? (await standardResp.json() || []) : [];
    const plus = plusResp.ok ? (await plusResp.json() || []) : [];
    worldFavGroups = [...standard, ...plus]
      .filter(g => g && g.name && (g.name.startsWith('worlds') || g.name.startsWith('vrcPlusWorlds') || g.type === 'world' || g.type === 'vrcPlusWorld'))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const failed = [];
    if (!standardResp.ok) failed.push('world');
    if (!plusResp.ok && plusResp.status !== 403 && plusResp.status !== 404) failed.push('VRC+');
    renderWorldFavGroupButtons(failed.length ? `${failed.join(', ')} groups failed to load.` : '');
    return worldFavGroups;
  } catch (e) {
    console.warn('loadWorldFavGroups', e);
    renderWorldFavGroupButtons('World favorite groups failed to load.');
    return worldFavGroups;
  }
}

function _loadWorldsModule() {
  if (VRCW.modules.worlds) return Promise.resolve(VRCW.modules.worlds);
  return loadScriptOnce('js/worlds.js?v=' + APP_CACHE_VERSION).then(() => {
    if (!VRCW.modules.worlds) throw new Error('Worlds module did not register');
    return VRCW.modules.worlds;
  });
}

function _callWorld(name, args) {
  return _loadWorldsModule().then(module => {
    const fn = module && module[name];
    if (typeof fn !== 'function') throw new Error('World function not available: ' + name);
    return fn.apply(window, args);
  }).catch(err => {
    console.error(err);
    showToast(t('toast.worldModuleLoadFail', {msg: err.message}), 'error');
  });
}

function initWorldsTab() { return _callWorld('initWorldsTab', arguments); }
function switchWorldCategory(cat) { return _callWorld('switchWorldCategory', arguments); }
function fetchWorlds(category, forceRefresh) { return _callWorld('fetchWorlds', arguments); }
function filterWorlds() { return _callWorld('filterWorlds', arguments); }
function cleanupInvalidWorlds() { return _callWorld('cleanupInvalidWorlds', arguments); }
function cleanInvalidWorlds() { return _callWorld('cleanInvalidWorlds', arguments); }
function selectAllWorlds() { return _callWorld('selectAllWorlds', arguments); }
function unfavoriteSelectedWorlds() { return _callWorld('unfavoriteSelectedWorlds', arguments); }
function toggleSelectWorld(id, e) { return _callWorld('toggleSelectWorld', arguments); }
function switchWorldDetailTab(tab) { return _callWorld('switchWorldDetailTab', arguments); }
function openWorldDetail(worldId, worldObj) { return _callWorld('openWorldDetail', arguments); }
function closeWorldDetail() { return _callWorld('closeWorldDetail', arguments); }
function deleteCurrentWorld() { return _callWorld('deleteCurrentWorld', arguments); }
function showCacheClearModal() { return _callWorld('showCacheClearModal', arguments); }
function joinWorldInstance() { return _callWorld('joinWorldInstance', arguments); }
function joinSpecificInstance(worldId, instanceId) { return _callWorld('joinSpecificInstance', arguments); }
function addWorldToFavorite(worldId, groupName, btn) { return _callWorld('addWorldToFavorite', arguments); }
function toggleWorldFavMenu(event) { return _callWorld('toggleWorldFavMenu', arguments); }
function toggleWorldFavorite() { return _callWorld('toggleWorldFavorite', arguments); }

VRCW.registerModule('worldsShell', {
  load: _loadWorldsModule,
  renderWorldFavGroupButtons,
  fetchWorlds,
  loadWorldFavGroups,
});
renderAppVersionInfo();

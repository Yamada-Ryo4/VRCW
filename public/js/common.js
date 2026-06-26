/*
 * VRCW — common.js
 * 信任/平台/位置/proxyImg/日期等通用助手
 *
 * 注意：本项目为「经典脚本」(非 ES module)，全部按顺序加载、共享全局作用域。
 * 函数声明会提升为全局，跨文件调用没问题；请勿改为 type="module"。
 */
// ── Init ──
document.addEventListener("DOMContentLoaded", () => {
  setLang(currentLang);
  renderSavedAccounts();
  // Auto-login if we have saved auth
  if (vrcAuth) {
    apiCall("/api/vrc/auth/user")
      .then((r) => {
        if (r.ok) {
          showMainApp();
          fetchMyModerations();
        } else {
          // Saved token rejected — focus the username field so the user can
          // immediately type a fresh login.
          requestAnimationFrame(() => document.getElementById('username')?.focus());
        }
      })
      .catch(() => {
        requestAnimationFrame(() => document.getElementById('username')?.focus());
      });
  } else {
    // No saved auth — focus the username field so the user can start typing
    // right away. Wrapped in rAF so the focus happens after layout settles
    // (otherwise mobile browsers ignore programmatic focus before paint).
    requestAnimationFrame(() => document.getElementById('username')?.focus());
  }
});

// ═══════════════════════════════════════════════════════════════
// ── Common Tools ──
// ═══════════════════════════════════════════════════════════════

function getStatusLabel(f) {
  if (!f) return '离线';
  if (f.state === 'active') return '网页在线';
  if (f.state === 'online') return '游戏中';
  if (f.location && f.location !== 'offline') return '游戏中';
  return '离线';
}

function getTrustInfo(tags = []) {
  if (tags.includes('system_trust_veteran'))    return { label: 'Trusted User', color: '#B18FFF', cls: 'veteran' };
  if (tags.includes('system_trust_trusted'))    return { label: 'Known User',  color: '#FF7B42', cls: 'trusted' };
  if (tags.includes('system_trust_known'))      return { label: 'User',        color: '#2BCF5C', cls: 'known' };
  if (tags.includes('system_trust_basic'))      return { label: 'New User',    color: '#1172B5', cls: 'basic' };
  return { label: 'Visitor', color: '#CCCCCC', cls: 'visitor' };
}

function isVRCPlus(tags = []) {
  return tags.includes('system_supporter');
}

function getPlatformEmoji(platform) {
  const map = { standalonewindows: '🖥️ PC', android: '<i class="fa-solid fa-vr-cardboard"></i> Quest', ios: '<i class="fa-solid fa-mobile-screen"></i> iOS', web: '<i class="fa-solid fa-globe"></i> Web' };
  return map[platform] || platform || '';
}

// Bug#1 fix: parse location AND cache world name for display
const worldNameCache = new Map();
// Load persisted world names from IDB on startup
idb.get('world_name_cache').then(saved => {
  if (saved && typeof saved === 'object') {
    Object.entries(saved).forEach(([k, v]) => worldNameCache.set(k, v));
  }
}).catch(() => {});

let _saveWorldNameCacheTimer = null;
function _saveWorldNameCache() {
  clearTimeout(_saveWorldNameCacheTimer);
  _saveWorldNameCacheTimer = setTimeout(() => {
    const obj = {};
    worldNameCache.forEach((v, k) => { obj[k] = v; });
    idb.set('world_name_cache', obj).catch(() => {});
  }, 2000); // Debounced: batch all lookups into one IDB write
}

async function getLocationDisplay(location, worldId) {
  if (!location || location === 'offline') return '离线';
  if (location === 'private')   return '<i class="fa-solid fa-lock"></i> 私人房间';
  if (location === 'traveling') return '✈️ 传送中';

  const [wid, rest = ''] = location.split(':');
  let type = '公开';
  if (rest.includes('~private'))        type = '<i class="fa-solid fa-lock"></i> 私人';
  else if (rest.includes('~friends+')) type = '<i class="fa-solid fa-user-group"></i> 好友+';
  else if (rest.includes('~friends'))  type = '<i class="fa-solid fa-user-group"></i> 好友';
  else if (rest.includes('~hidden'))   type = '<i class="fa-solid fa-user-group"></i> 好友+';
  else if (rest.includes('group('))    type = '🏠 群组';

  const regionMatch = rest.match(/region\(([^)]+)\)/);
  const region = regionMatch ? regionMatch[1].toUpperCase() : '';
  const regionFlag = { JP:'🇯🇵', US:'🇺🇸', EU:'🇪🇺', USE:'🇺🇸', USW:'🇺🇸' }[region] || (region ? `[${region}]` : '');

  let worldName = worldNameCache.get(wid);
  if (!worldName && wid && wid.startsWith('wrld_')) {
    try {
      const r = await apiCall(`/api/vrc/worlds/${wid}`);
      if (r.ok) {
        const w = await r.json();
        worldName = w.name;
        worldNameCache.set(wid, worldName);
        _saveWorldNameCache(); // Persist to IDB for next session
      }
    } catch(_) {}
  }
  return `${regionFlag} ${worldName || wid} · ${type}`;
}

function parseLocation(location) {
  if (!location || location === 'offline') return { isOffline: true };
  if (location === 'private') return { isPrivate: true };
  if (location === 'traveling') return { isTraveling: true };
  const [worldId, rest = ''] = location.split(':');
  let type = 'public';
  if (rest.includes('~private'))        type = 'private';
  else if (rest.includes('~friends'))   type = 'friends';
  else if (rest.includes('~hidden'))    type = 'hidden';
  else if (rest.includes('group('))     type = 'group';
  return { worldId, instanceId: rest.split('~')[0], type };
}

function getLanguages(tags = []) {
  const langMap = { zho:'🇨🇳', eng:'🇺🇸', jpn:'🇯🇵', kor:'🇰🇷', deu:'🇩🇪', fra:'🇫🇷', spa:'🇪🇸',
                    por:'🇧🇷', rus:'🇷🇺', swe:'🇸🇪', ces:'🇨🇿', pol:'🇵🇱', tur:'🇹🇷', fin:'🇫🇮',
                    nld:'🇳🇱', ita:'🇮🇹', tha:'🇹🇭', vie:'🇻🇳', zho_tw:'🇹🇼' };
  return tags.filter(t => t.startsWith('language_')).map(t => langMap[t.replace('language_','')]||'').filter(Boolean);
}

function friendLogMsg(msg, type = 'info') {
  const el = document.getElementById('friendConsole');
  if (!el) return;
  const d = document.createElement('div'); d.className = `log-${type}`;
  d.innerHTML = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(d); el.scrollTop = el.scrollHeight;
  while (el.children.length > 200) el.removeChild(el.firstChild);
}

function worldLogMsg(msg, type = 'info') {
  const el = document.getElementById('worldConsole');
  if (!el) return;
  const d = document.createElement('div'); d.className = `log-${type}`;
  d.innerHTML = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(d); el.scrollTop = el.scrollHeight;
  while (el.children.length > 200) el.removeChild(el.firstChild);
}

function proxyImg(url) {
  if (!url) return '';
  // All VRChat images go through Worker proxy (SW caches them after first view)
  if (url.includes('vrchat.cloud') || url.includes('vrchat.com'))
    return `${API_BASE}/api/image?url=${encodeURIComponent(url)}&auth=${encodeURIComponent(vrcAuth || '')}&bucket=${encodeURIComponent(_apiAuthBucket())}`;
  return url;
}

function formatDate(d) {
  if (!d) return "-";
  return new Date(d).toLocaleString("zh-CN", { 
    year: "numeric", 
    month: "2-digit", 
    day: "2-digit", 
    hour: "2-digit", 
    minute: "2-digit" 
  });
}

VRCW.registerModule('common', { getStatusLabel, getTrustInfo, isVRCPlus, getPlatformEmoji, getLocationDisplay, parseLocation, getLanguages, friendLogMsg, worldLogMsg, proxyImg, formatDate });
renderAppVersionInfo();

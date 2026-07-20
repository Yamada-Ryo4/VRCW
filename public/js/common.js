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
  if (!f) return t('stat.offline');
  if (f.state === 'active') return t('stat.webOnline');
  if (f.state === 'online') return t('stat.inGame');
  if (f.location && f.location !== 'offline') return t('stat.inGame');
  return t('stat.offline');
}

function getTrustInfo(tags = []) {
  if (tags.includes('system_trust_veteran'))    return { label: t('trust.veteran'), color: '#B18FFF', cls: 'veteran' };
  if (tags.includes('system_trust_trusted'))    return { label: t('trust.trusted'), color: '#FF7B42', cls: 'trusted' };
  if (tags.includes('system_trust_known'))      return { label: t('trust.known'),   color: '#2BCF5C', cls: 'known' };
  if (tags.includes('system_trust_basic'))      return { label: t('trust.basic'),   color: '#1172B5', cls: 'basic' };
  return { label: t('trust.visitor'), color: '#CCCCCC', cls: 'visitor' };
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
  if (!location || location === 'offline') return t('loc.offline');
  if (location === 'private')   return t('loc.privateRoom');
  if (location === 'traveling') return t('loc.traveling');

  const [wid, rest = ''] = location.split(':');
  let type = t('loc.public');
  if (rest.includes('~private'))        type = t('loc.private');
  else if (rest.includes('~friends+')) type = t('loc.friendsPlus');
  else if (rest.includes('~friends'))  type = t('loc.friends');
  else if (rest.includes('~hidden'))   type = t('loc.friendsPlus');
  else if (rest.includes('group('))    type = t('loc.group');

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
  return `${regionFlag} ${escHtml(worldName || wid)} · ${type}`;
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
  appendIconText(d, msg, `[${new Date().toLocaleTimeString(getLocale())}] `);
  el.appendChild(d); el.scrollTop = el.scrollHeight;
  while (el.children.length > 200) el.removeChild(el.firstChild);
}

function worldLogMsg(msg, type = 'info') {
  const el = document.getElementById('worldConsole');
  if (!el) return;
  const d = document.createElement('div'); d.className = `log-${type}`;
  appendIconText(d, msg, `[${new Date().toLocaleTimeString(getLocale())}] `);
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

// 根据当前 i18n 语言返回 BCP 47 locale,供 toLocaleString 使用
function getLocale() {
  return { zh: 'zh-CN', ja: 'ja-JP', en: 'en-US' }[currentLang] || 'zh-CN';
}

function formatDate(d) {
  if (!d) return "-";
  return new Date(d).toLocaleString(getLocale(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

VRCW.registerModule('common', { getStatusLabel, getTrustInfo, isVRCPlus, getPlatformEmoji, getLocationDisplay, parseLocation, getLanguages, friendLogMsg, worldLogMsg, proxyImg, formatDate, getLocale });
renderAppVersionInfo();

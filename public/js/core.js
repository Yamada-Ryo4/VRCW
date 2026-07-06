/*
 * VRCW — core.js
 * 配置/全局状态/idb/工具(escHtml,clipboard,toast)/动画表情/i18n/apiCall
 *
 * 注意：本项目为「经典脚本」(非 ES module)，全部按顺序加载、共享全局作用域。
 * 函数声明会提升为全局，跨文件调用没问题；请勿改为 type="module"。
 */
/**
 * VRChat Avatar Manager — Frontend (Workers Edition)
 * Browser-direct S3 uploads: no server middleman!
 */

// ── Config ──
const APP_BUILD_LABEL = "Workers Edition";
const APP_CACHE_VERSION = (() => {
  try {
    const src = document.currentScript?.src || "";
    return new URL(src, location.href).searchParams.get("v") || "80";
  } catch (_) {
    return "82";
  }
})();
const API_BASE = location.origin; // Worker serves from same origin
const VRCW = (() => {
  const existing = window.VRCW || {};
  const registry = existing.registry || {};
  const services = existing.services || {};
  const modules = existing.modules || {};
  const runtime = existing.runtime || {};
  const loadedScripts = existing.loadedScripts || new Map();

  function registerService(name, service) {
    if (!name || !service) return service;
    services[name] = Object.freeze({ ...(services[name] || {}), ...service });
    return services[name];
  }

  function registerModule(name, module) {
    if (!name || !module) return module;
    modules[name] = Object.freeze({ ...(modules[name] || {}), ...module });
    return modules[name];
  }

  return Object.assign(existing, {
    version: `v${APP_CACHE_VERSION}`,
    build: APP_BUILD_LABEL,
    registry,
    services,
    modules,
    runtime,
    loadedScripts,
    registerService,
    registerModule,
  });
})();
window.VRCW = VRCW;
let vrcAuth = localStorage.getItem("vrc_auth") || "";
let avatars = [];
let selectedIds = new Set();
let uploadFiles = [];
let currentLang = localStorage.getItem("vrc_lang") || "zh";
let saveDirHandle = null; // File System Access API directory handle
let visibleAvatars = [];
let currentTab = "download"; // Track active tab
let currentUserId = ""; // Current logged-in user's VRChat ID
let currentGlobalFetchSeq = 0; // Sequence to abort stale background tasks globally
let currentWorldFetchSeq  = 0; // Separate seq for world fetches — not shared with friend syncs
let currentUiEpoch = 0; // Bumped when the foreground UI changes; stale async tails must not repaint.
let selectedWorldIds = new Set(); // Selected world IDs for batch operations
let isPriorityTaskRunning = false; // "Foveated" loading lock
let backgroundLoadQueue = []; // Queue for deferred non-visible tasks
let myModerations = []; // Player moderations (mute/block)
let favoriteGroups = []; // Avatar favorite groups
let worldFavGroups  = []; // World favorite groups
let friendFavGroups = []; // Friend favorite groups
let favoriteIdMap = new Map(); // avatarId -> favoriteId (kept per current category)
let avatarFavTagMap = new Map(); // avatarId -> Set<groupName> (which groups this avatar is in)
let worldFavoriteIdMap = new Map(); // worldId -> favoriteId (kept per current category)
let worldFavGroupCounts = new Map(); // groupName -> count (populated by syncAllFavoriteIds)
let avatarFavGroupCounts = new Map(); // groupName -> count
let friendFavoriteIdMap = new Map(); // userId -> favoriteId
window._localNameMap = new Map(); // GLOBAL CACHE: avatarId -> name (for recovery)
let localAvatarFavs = []; // Local favorites collection (max 200)
let localAvatarIdMap = new Map(); // avatarId -> true (for UI binary check)

function bumpUiEpoch() {
  currentUiEpoch += 1;
  return currentUiEpoch;
}

function makeUiToken(scope, id) {
  return { epoch: currentUiEpoch, scope, id: id || '' };
}

function isUiTokenCurrent(token) {
  return !!token
    && token.epoch === currentUiEpoch
    && token.scope
    && window[`_${token.scope}ActiveToken`] === token;
}

function renderAppVersionInfo() {
  const versionLabel = `v${APP_CACHE_VERSION}`;
  const sidebarBadge = document.getElementById('appVersionBadge');
  if (sidebarBadge) sidebarBadge.textContent = versionLabel;
  document.querySelectorAll('[data-app-version]').forEach(el => { el.textContent = versionLabel; });
  document.querySelectorAll('[data-app-build]').forEach(el => { el.textContent = APP_BUILD_LABEL; });
  document.documentElement.dataset.vrcwVersion = versionLabel;
  document.documentElement.dataset.vrcwServices = Object.keys(VRCW.services).sort().join(',');
  document.documentElement.dataset.vrcwModules = Object.keys(VRCW.modules).sort().join(',');
  document.documentElement.dataset.vrcwLazyScripts = Array.from(VRCW.loadedScripts.keys()).sort().join(',');
}

document.addEventListener('DOMContentLoaded', renderAppVersionInfo);

function scriptUrlWithVersion(src) {
  const url = new URL(src, location.href);
  if (!url.searchParams.has('v')) url.searchParams.set('v', APP_CACHE_VERSION);
  return url.pathname + url.search;
}

function loadScriptOnce(src) {
  const versionedSrc = scriptUrlWithVersion(src);
  if (VRCW.loadedScripts.has(versionedSrc)) return VRCW.loadedScripts.get(versionedSrc);

  const existing = Array.from(document.scripts).find((script) => {
    if (!script.src) return false;
    const u = new URL(script.src, location.href);
    return u.pathname + u.search === versionedSrc;
  });
  if (existing) {
    const loaded = Promise.resolve(existing);
    VRCW.loadedScripts.set(versionedSrc, loaded);
    renderAppVersionInfo();
    return loaded;
  }

  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = versionedSrc;
    script.defer = true;
    script.dataset.vrcwLazy = '1';
    script.onload = () => {
      renderAppVersionInfo();
      resolve(script);
    };
    script.onerror = () => {
      VRCW.loadedScripts.delete(versionedSrc);
      renderAppVersionInfo();
      reject(new Error(`Failed to load ${versionedSrc}`));
    };
    document.body.appendChild(script);
  });
  VRCW.loadedScripts.set(versionedSrc, promise);
  renderAppVersionInfo();
  return promise;
}

// ── Global Avatar Lookup Queue (Strict Rate Limiting & 429 Backoff) ──
const avatarLookupQueue = {
  pending: [],
  active: 0,
  max: 2,
  paused: false,
  add(id, onFound) {
    if (this.pending.some(p => p.id === id)) return;
    this.pending.push({ id, onFound });
    this.next();
  },
  async next() {
    if (this.paused || this.active >= this.max || !this.pending.length) return;
    // FOVEATED: Suspend avatar metadata lookup if a high-priority UI fetch is active
    if (isPriorityTaskRunning) {
        setTimeout(() => this.next(), 1000);
        return;
    }
    this.active++;
    const { id, onFound } = this.pending.shift();
    try {
      const name = await performSingleAvatarRecovery(id);
      if (name) onFound(name);
    } catch (e) {
      if (e.message.includes('429')) {
        this.paused = true;
        this.pending.unshift({ id, onFound });
        setTimeout(() => { this.paused = false; this.next(); }, 3000);
      }
    } finally {
      this.active--;
      this.next();
    }
  }
};

async function fetchOfficialAvatarData(id, options = {}) {
  // Only use official VRChat API for per-ID verification.
  // Third-party per-ID endpoints (AvtrDB v3, AvatarRecovery) cause 429/500 storms — removed.
  try {
    const r = await apiCall(`/api/vrc/avatars/${id}`, options);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}


// Global Avatar Platform Cache (sessionStorage-backed, survives tab switches)
const avatarPlatCache = {
  _prefix: 'vrc_plat_',
  get(id) {
    try { 
      const v = sessionStorage.getItem(this._prefix + id);
      return v ? JSON.parse(v) : null;
    } catch { return null; }
  },
  set(id, data) {
    try { sessionStorage.setItem(this._prefix + id, JSON.stringify(data)); } catch {}
  },
  has(id) { return !!sessionStorage.getItem(this._prefix + id); }
};

// Global Avatar Metadata/Platform Queue — 10 concurrent, 100ms gap, with cache
const avatarMetadataQueue = {
  pending: [],
  active: 0,
  max: 10, // 10 concurrent requests
  paused: false,
  callbacks: new Map(), // id -> [callbacks]
  add(id, onUpdated) {
    if (!id) return;

    // CACHE HIT: Serve immediately from session cache
    const cached = avatarPlatCache.get(id);
    if (cached) {
      if (onUpdated) setTimeout(() => onUpdated(cached), 0);
      return;
    }

    // Track callbacks per id (multiple cards may request same id)
    if (!this.callbacks.has(id)) {
      this.callbacks.set(id, []);
    }
    if (onUpdated) this.callbacks.get(id).push(onUpdated);

    // Avoid duplicate queue entries
    if (this.pending.some(p => p.id === id)) return;
    this.pending.push({ id });
    this.next();
  },
  async next() {
    if (this.paused || this.active >= this.max || !this.pending.length) return;
    this.active++;
    const { id } = this.pending.shift();
    // Kick off next slot immediately (parallel!)
    this.next();
    try {
      const data = await fetchOfficialAvatarData(id);
      if (data) {
        avatarPlatCache.set(id, data);
        const cbs = this.callbacks.get(id) || [];
        this.callbacks.delete(id);
        cbs.forEach(cb => { try { cb(data); } catch {} });
        window.dispatchEvent(new CustomEvent('vrc_avatar_updated', { detail: { id, data } }));
      }
    } catch (e) {
      if (e.message?.includes('429')) {
        this.paused = true;
        this.pending.unshift({ id });
        setTimeout(() => { this.paused = false; this.next(); }, 8000);
      }
    } finally {
      this.active--;
      setTimeout(() => this.next(), 100); // 100ms gap per slot

    }
  }
};

async function performSingleAvatarRecovery(id) {
  const data = await fetchOfficialAvatarData(id);
  return data ? (data.name || data.displayName) : null;
}

function avatarIdOf(av) {
  return av?.vrc_id || av?.id || av?.avatarId || "";
}

function isUsefulAvatarSnapshot(av) {
  const id = avatarIdOf(av);
  if (!id) return false;
  const name = av?.name || av?.avatarName || av?.lastKnownName || "";
  const thumb = av?.thumbnailImageUrl || av?.imageUrl || av?.image_url || av?.lastKnownThumbnailImageUrl || av?.lastKnownImageUrl || "";
  const hasDates = !!(av?.created_at || av?.createdAt || av?.updated_at || av?.updatedAt);
  return !!(name || thumb || hasDates || av?.description);
}

async function rememberAvatarDetailSnapshot(av) {
  const id = avatarIdOf(av);
  if (!id || !isUsefulAvatarSnapshot(av)) return;
  const snapshot = Object.assign({}, av, {
    id,
    cachedAt: Date.now()
  });
  try { await idb.set('avatar_detail_' + id, snapshot); } catch (_) {}
  const name = snapshot.name || snapshot.avatarName || snapshot.lastKnownName;
  if (name && !String(name).startsWith(t('fav.invalidPrefix'))) persistName(id, name);
}

async function findCachedAvatarSnapshot(id) {
  if (!id) return null;
  try {
    const direct = await idb.get('avatar_detail_' + id);
    if (direct && isUsefulAvatarSnapshot(direct)) return Object.assign({ id }, direct, { source: direct.source || 'local-detail-cache' });

    const keys = await idb.keys();
    const fullKeys = keys.filter(k => typeof k === 'string' && k.startsWith('avatars_'));
    for (const key of fullKeys) {
      const list = await idb.get(key);
      if (!Array.isArray(list)) continue;
      const hit = list.find(a => avatarIdOf(a) === id);
      if (hit && isUsefulAvatarSnapshot(hit)) return Object.assign({ id }, hit, { source: key });
    }

    const basicKeys = keys.filter(k => typeof k === 'string' && k.startsWith('avatar_basics_'));
    for (const key of basicKeys) {
      const list = await idb.get(key);
      if (!Array.isArray(list)) continue;
      const hit = list.find(a => avatarIdOf(a) === id);
      if (hit && isUsefulAvatarSnapshot(hit)) return Object.assign({ id }, hit, { source: key });
    }

    const knownName = window._localNameMap?.get(id);
    if (knownName) return { id, name: knownName, source: 'persistent_avatar_names' };
  } catch (e) {
    console.warn('findCachedAvatarSnapshot failed', e);
  }
  return null;
}


// ── Unified Platform/Performance Helper ──
function getAvatarPlatforms(av) {
  const ratings = new Map();

  const addPlat = (rawPlat, rawPerf, isFallback = false) => {
    if (!rawPlat || typeof rawPlat !== 'string') return;
    const plat = rawPlat.toLowerCase() === 'standalonewindows' ? 'pc' : rawPlat.toLowerCase();
    if (!['pc', 'android', 'ios'].includes(plat)) return;
    
    // PC EXCEPTION: Always allow PC from compatibility lists even without rating, 
    // as it's rarely an "Impostor-only" platform in these DBs.
    if (plat === 'pc' && isFallback) {
      if (!ratings.has('pc')) ratings.set('pc', null); // null = platform exists, no rating data
      return;
    }

    // STRICT RULE for Android/iOS: Require a valid rating to filter out auto-generated Impostors.
    if (!rawPerf || rawPerf === "None" || rawPerf === "Unknown") {
      return;
    }
    
    ratings.set(plat, rawPerf);
  };

  // 1. unityPackages (Preferred - Official VRChat API)
  if (Array.isArray(av.unityPackages)) {
    av.unityPackages.forEach(p => addPlat(p.platform, p.performanceRating));
  }

  // 2. performance object (Old Avtrdb/VRCX fallback)
  if (av.performance) {
    if (av.performance.pc_rating) addPlat('pc', av.performance.pc_rating);
    if (av.performance.android_rating) addPlat('android', av.performance.android_rating);
    if (av.performance.ios_rating) addPlat('ios', av.performance.ios_rating);
  }

  // 3. compatibility array (Final fallback for PC ONLY)
  const otherPlats = av.compatibility || av.platforms || [];
  if (Array.isArray(otherPlats)) {
    otherPlats.forEach(p => addPlat(p, null, true));
  }

  return ratings;
}

// ── Local IndexedDB Cache ──
const idb = {
  db: null,
  _initPromise: null,
  async init() {
    if (this.db) return;
    if (this._initPromise) return this._initPromise;
    this._initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open("vrcw_DB", 4); // Upgrade to v4 for image cache
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("cache"))
          db.createObjectStore("cache");
        if (!db.objectStoreNames.contains("mod_logs"))
          db.createObjectStore("mod_logs", { keyPath: "id", autoIncrement: true });
        if (!db.objectStoreNames.contains("local_avatars"))
          db.createObjectStore("local_avatars", { keyPath: "id" });
        if (!db.objectStoreNames.contains("images"))
          db.createObjectStore("images"); // Persistent Blob Cache
      };
    });
    return this._initPromise;
  },
  async initAndLoadMap() {
    await this.init();
    await initLocalNameMap();
  },
  async get(key) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("cache", "readonly");
      const req = tx.objectStore("cache").get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async getImage(url) {
    await this.init();
    return new Promise((resolve) => {
      const tx = this.db.transaction("images", "readonly");
      const req = tx.objectStore("images").get(url);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  },
  async setImage(url, blob) {
    await this.init();
    return new Promise((resolve) => {
      const tx = this.db.transaction("images", "readwrite");
      const req = tx.objectStore("images").put(blob, url);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  },
  async set(key, value) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("cache", "readwrite");
      const req = tx.objectStore("cache").put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
  async del(key) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("cache", "readwrite");
      const req = tx.objectStore("cache").delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
  async keys() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("cache", "readonly");
      const req = tx.objectStore("cache").getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async addLog(store, data) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, "readwrite");
      const s = tx.objectStore(store);
      const req = s.add(data);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async getAllLogs(store) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, "readonly");
      const s = tx.objectStore(store);
      const req = s.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async clearLogs(store) {
    await this.init();
    const tx = this.db.transaction(store, "readwrite");
    tx.objectStore(store).clear();
  },
  async getLocalAvatars() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("local_avatars", "readonly");
      const req = tx.objectStore("local_avatars").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },
  async saveLocalAvatar(av) {
    await this.init();
    const tx = this.db.transaction("local_avatars", "readwrite");
    tx.objectStore("local_avatars").put(av);
  },
  async removeLocalAvatar(id) {
    await this.init();
    const tx = this.db.transaction("local_avatars", "readwrite");
    tx.objectStore("local_avatars").delete(id);
  }
};

// ── Persistent avatar name cache (id → name) ──
// MUST be defined here in core.js, NOT in friend-profile.js, because idb.initAndLoadMap()
// (called immediately below) invokes initLocalNameMap(). With classic-script load order,
// friend-profile.js loads 9 scripts later, so a faster microtask resolution can hit
// `ReferenceError: initLocalNameMap is not defined` and break the entire login bootstrap.
async function initLocalNameMap() {
  const map = window._localNameMap;
  try {
    // 1. Load the shared persistent cache first (fastest)
    const shared = await idb.get('persistent_avatar_names');
    if (shared && typeof shared === 'object') {
       Object.entries(shared).forEach(([id, name]) => map.set(id, name));
    }

    // 2. Scan favorites as backup/override
    const keys = await idb.keys();
    const favKeys = keys.filter(k => typeof k === 'string' && k.startsWith('avatars_avatars'));
    const lists = await Promise.all(favKeys.map(k => idb.get(k)));
    lists.forEach(list => {
      if (Array.isArray(list)) {
        list.forEach(av => {
          if (av.id && av.name && av.name !== 'Unknown') {
            map.set(av.id, av.name);
          }
        });
      }
    });
  } catch (e) { console.warn('initLocalNameMap failed', e); }
}

let namePersistenceTimeout = null;
async function persistName(id, name) {
   if (!id || !name || name === 'Unknown' || name.startsWith('Model ')) return;
   window._localNameMap.set(id, name);
   // Throttle IDB writes to once every 2 seconds
   if (namePersistenceTimeout) return;
   namePersistenceTimeout = setTimeout(async () => {
      try {
         const exportMap = {};
         window._localNameMap.forEach((v, k) => {
            if (v && v !== 'Unknown' && !v.startsWith('Model ')) exportMap[k] = v;
         });
         await idb.set('persistent_avatar_names', exportMap);
      } catch(e) {}
      namePersistenceTimeout = null;
   }, 2000);
}

idb.initAndLoadMap().then(() => syncLocalFavorites());

async function syncLocalFavorites() {
  try {
    localAvatarFavs = await idb.getLocalAvatars();
    localAvatarIdMap.clear();
    localAvatarFavs.forEach(av => localAvatarIdMap.set(av.id, true));
    const btn = document.getElementById("cat-local");
    if (btn) btn.innerHTML = t('fav.localCount', {count: localAvatarFavs.length});
  } catch(e) { console.error("syncLocalFavorites", e); }
}

async function saveToLocalFavorite(av) {
  if (localAvatarFavs.length >= 200) {
    alert(t('toast.localFavFull'));
    return;
  }
  if (localAvatarIdMap.has(av.id)) return;
  localAvatarFavs.push(av);
  localAvatarIdMap.set(av.id, true);
  await idb.saveLocalAvatar(av);
  syncLocalFavorites();
  // INSTANT UI: flip the unified card-fav-quick toggle from ☆ to ★ on the
  // currently-rendered card so the user sees the favorite land immediately.
  const card = document.getElementById("card-" + av.id);
  if (card) {
    const fq = card.querySelector('.card-fav-quick');
    if (fq) {
      fq.innerHTML = '<i class="fa-solid fa-star"></i> ';
      fq.title = t('fav.favorited');
    }
  }
  logMsg(t('toast.savedToLocal', {name: av.name}), "info");
  // Refresh the detail modal button if it's showing this avatar
  if (typeof _refreshDetailAfterFavChange === 'function') _refreshDetailAfterFavChange(av.id);
}

async function removeFromLocalFavorite(id) {
  // Confirm before destructive action — `localAvatarFavs` and the IDB record
  // are both wiped here, so a misclick on a card's badge would otherwise lose
  // the entry silently.
  const av = localAvatarFavs.find(a => a.id === id);
  const name = av?.name || id;
  if (!confirm(t('confirm.removeLocalFav', {name}))) return;
  localAvatarFavs = localAvatarFavs.filter(a => a.id !== id);
  localAvatarIdMap.delete(id);
  // Drop from any pending bulk selection too — leaving it here makes the
  // "已选 N" chip lie about what's actually selectable.
  if (typeof selectedIds !== 'undefined' && selectedIds.delete) selectedIds.delete(id);
  const ssChip = document.getElementById('statSelected');
  if (ssChip) ssChip.textContent = (typeof selectedIds !== 'undefined') ? selectedIds.size : '0';
  await idb.removeLocalAvatar(id);
  syncLocalFavorites();
  // Surgical card removal beats a full switchCategory() reload — that would
  // re-fetch & re-render the whole list and drop any in-flight thumbnails.
  if (currentCategory === 'local') {
    const card = document.getElementById('card-' + id);
    if (card) card.remove();
    const totalChip = document.getElementById('statTotal');
    if (totalChip) totalChip.textContent = String(localAvatarFavs.length);
  }
  logMsg(t('toast.removedFromLocal'), "info");
  // Refresh the detail modal button if it's showing this avatar
  if (typeof _refreshDetailAfterFavChange === 'function') _refreshDetailAfterFavChange(id);
}

// ── HTML escape helper (prevent XSS) ──
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── JS-in-attribute escape helper (prevent XSS via inline handlers) ──
// When a value is interpolated into an inline handler like
//   onclick="doThing('VALUE')"
// the browser HTML-decodes the attribute FIRST and then parses it as JS.
// escHtml() alone is unsafe here: its &#39; decodes back to ' and breaks out
// of the JS string. This helper escapes for the JS single-quoted string layer
// first (\, ', newlines) and then HTML-encodes so it also survives the
// double-quoted attribute layer. Always use this for data inside on*="...('X')".
function escJsAttr(str) {
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Abort detection helper ──
// When the user switches tabs, the previous tab's in-flight requests are aborted
// via AbortController. This is normal internal behavior — NOT a user-facing error.
// Use this in catch blocks to suppress "加载失败: The user aborted a request."
function isAbortError(e) {
  if (!e) return false;
  if (e.name === 'AbortError') return true;
  const m = (e.message || '').toLowerCase();
  return m.includes('abort') || m.includes('http 499');
}

// ── JSON-in-attribute helpers (for data-friend="..." round-trips) ──
// Cards stash a whole object in a double-quoted attribute, then openFriendProfile
// reads it back. The only chars that can break a double-quoted attribute are " and
// & (entity ambiguity), so encode exactly those — and in this order so decode is a
// clean inverse. The previous hand-rolled variants were inconsistent (some escaped
// \\ which corrupted names with backslashes, some never encoded &), causing parse
// failures / mojibake for unusual display names. Always use these as a matched pair.
function escAttrJson(obj) {
  return JSON.stringify(obj).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
function parseAttrJson(str) {
  return JSON.parse(String(str).replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

// ── Clipboard helper (referenced by inline onclick in index.html) ──
// Copies text and shows brief feedback. Falls back to a hidden textarea when
// the async Clipboard API is unavailable (insecure context / older browsers).
function copyToClipboard(text, label) {
  const value = String(text == null ? "" : text);
  const done = () => {
    try { logMsg(t('toast.copiedWithLabel', {label: label || t('toast.copied'), value}), "info"); } catch {}
    try { showToast(t('toast.copiedCheck', {label: label || t('toast.copied')})); } catch {}
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(value).then(done).catch(() => fallbackCopy(value, done));
  } else {
    fallbackCopy(value, done);
  }
}

function fallbackCopy(value, onOk) {
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0;";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    if (onOk) onOk();
  } catch (e) {
    alert(t('toast.copyFail', {value}));
  }
}

// ── Lightweight debounce for input-driven filters ─────────────────────────
// applyFilters/filterFriends/filterWorlds rebuild their entire grids and re-
// observe images. Calling them on every keystroke (the previous behavior with
// `oninput="applyFilters()"`) lags noticeably with 100+ items. The wrappers
// below coalesce successive keystrokes inside a single ~120ms window so the
// UI only re-renders once the user pauses.
//
// 120ms is short enough to feel instant but long enough to absorb a normal
// typing burst (most people peak around 5-6 keys/sec = 167ms gap).
const _filterDebounceTimers = {};
function _debounceFilter(name, ms = 120) {
  return function () {
    clearTimeout(_filterDebounceTimers[name]);
    _filterDebounceTimers[name] = setTimeout(() => {
      const fn = window[name];
      if (typeof fn === 'function') fn();
    }, ms);
  };
}
// Globals exposed to inline oninput handlers — these MUST be function declarations
// (or window-attached) because top-level let/const aren't accessible from inline
// HTML attributes (see BUG-9 in §5).
window.applyFiltersDebounced = _debounceFilter('applyFilters');
window.filterFriendsDebounced = _debounceFilter('filterFriends');
window.filterWorldsDebounced = _debounceFilter('filterWorlds');

// ── Lightweight toast (non-blocking feedback for actions) ──
// Replaces native `alert()` for the common "operation succeeded/failed"
// message. alert() blocks the entire page and forces a click — a death by
// a thousand cuts when every favorite/unfavorite/edit triggers one. Toasts
// fade in/out at the bottom and stack on top of any modal (z-index 99999).
//
// The optional `duration` lets error messages stay long enough to actually
// read (default 2.2s for info/success, 4s for errors).
let _toastTimer = null;
function showToast(msg, type = "info", duration) {
  let el = document.getElementById("_vrcwToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "_vrcwToast";
    // role=status + aria-live=polite makes screen readers announce success/info
    // toasts; aria-atomic ensures the *whole* new message is read (not just the
    // diff). Errors get role=alert (more assertive) by upgrading later when type
    // changes.
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    el.style.cssText =
      "position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:99999;" +
      "padding:10px 18px;border-radius:10px;font-size:0.85em;font-weight:500;color:#fff;" +
      "box-shadow:0 8px 24px rgba(0,0,0,0.4);cursor:pointer;opacity:0;transition:opacity 0.2s;max-width:80vw;text-align:center;";
    // Click to dismiss — for errors that need acknowledgment without blocking.
    el.addEventListener('click', () => { el.style.opacity = '0'; clearTimeout(_toastTimer); });
    document.body.appendChild(el);
  }
  // Errors get more urgent ARIA semantics so assistive tech reads them first.
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  const bg = { info: "rgba(30,30,46,0.96)", success: "rgba(22,101,52,0.96)", error: "rgba(153,27,27,0.96)" }[type] || "rgba(30,30,46,0.96)";
  el.style.background = bg;
  el.textContent = msg;
  el.style.opacity = "1";
  clearTimeout(_toastTimer);
  // Errors get longer to read (network failures often need re-attempt).
  const ms = duration != null ? duration : (type === 'error' ? 4000 : 2200);
  _toastTimer = setTimeout(() => { el.style.opacity = "0"; }, ms);
}

// ── Global "Esc closes top modal" handler ─────────────────────────────────
// Standard expectation: pressing Esc dismisses the topmost open modal/overlay.
// Most of our modals already close on backdrop-click, but we never wired Esc
// for the main ones (friend profile, world detail, group detail, instance
// detail, edit avatar, search detail, cleanup, boop, group invite picker,
// report, user note, cache clear). One global listener picks the highest
// z-index visible overlay and triggers its close.
//
// We try, in order: a `closeXxx()` helper bound on the element, an explicit
// onclick="closeXxx()" pattern in the DOM, then a click on the element's
// own onclick (for backdrop-style modals), and finally `.remove()` for ad-hoc
// modals that just live on the DOM until clicked away.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Don't fight with text-entry: typing Esc in an input/textarea should still
  // bubble through, but only after we let the modal close. We allow it.
  // Skip if a contenteditable element is focused (rare but possible).
  const ae = document.activeElement;
  if (ae && ae.isContentEditable) return;

  // Collect all visible modal-ish overlays. Anything with class "modal" or
  // "modal-overlay" that isn't .hidden and isn't display:none.
  const candidates = Array.from(document.querySelectorAll(
    '.modal:not(.hidden), .modal-overlay:not(.hidden), [id$="Modal"]:not(.hidden), [id^="_"][id$="Modal"]'
  )).filter(el => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && el.offsetParent !== null;
  });
  if (!candidates.length) return;

  // Topmost = highest z-index (fall back to DOM order).
  const top = candidates.reduce((best, el) => {
    const z = parseInt(getComputedStyle(el).zIndex, 10) || 0;
    return (!best || z >= best._z) ? Object.assign(el, { _z: z }) : best;
  }, null);
  if (!top) return;

  // Strategy 1: known close helpers by id
  const id = top.id || '';
  const closers = {
    'worldDetailModal': 'closeWorldDetail',
    'friendProfileModal': 'closeFriendProfile',
    'groupDetailModal': 'closeGroupDetail',
    'instanceDetailModal': 'closeInstanceDetail',
    'editModal': 'closeEditModal',
    'avtrdbDetailModal': 'closeAvtrdbDetail',
    'cleanupModal': null,        // ad-hoc, just remove
    'cacheClearModal': null,
    'boopModal': null,
    '_groupInvitePickerModal': null,
    '_reportUserModal': null,
    '_userNoteModal': null,
    '_wqfMenu': null,
  };
  if (id && Object.prototype.hasOwnProperty.call(closers, id)) {
    const fn = closers[id];
    if (fn && typeof window[fn] === 'function') { window[fn](); e.preventDefault(); return; }
    if (top.dataset.scrollLocked) { unlockBodyScroll(); delete top.dataset.scrollLocked; }
    top.remove(); e.preventDefault(); return;
  }

  // Strategy 2: hide via .hidden class (matches the rest of our modal pattern)
  if (top.classList.contains('modal')) {
    top.classList.add('hidden');
    if (top.dataset.scrollLocked) { unlockBodyScroll(); delete top.dataset.scrollLocked; }
    e.preventDefault();
    return;
  }

  // Strategy 3: ad-hoc overlays (modal-overlay class, dynamically inserted)
  if (top.classList.contains('modal-overlay')) {
    if (top.dataset.scrollLocked) { unlockBodyScroll(); delete top.dataset.scrollLocked; }
    top.remove();
    e.preventDefault();
  }
});

// ── Centralized modal/overlay stacking + scroll lock ───────────────────────
// Bug class fixed here: nested modals appearing BEHIND an already-open modal
// (fixed CSS z-index:1000 collided with profile modals), and body scroll-lock
// leaking when a modal was dismissed via backdrop instead of its close fn.
//
// modalZTop(): returns an ever-increasing z-index so each newly opened overlay
//   sits above whatever is currently shown.
// lockBodyScroll()/unlockBodyScroll(): refcounted so closing one of several
//   stacked modals doesn't prematurely restore page scrolling.
let _modalZ = 2000;            // base above .modal(1000)/ctx-menu(3000 handled separately)
function modalZTop() {
  _modalZ += 1;
  // Keep clear of the toast (99999); wrap if it somehow climbs too high.
  if (_modalZ > 90000) _modalZ = 2000;
  return _modalZ;
}
// Current highest modal z WITHOUT consuming a new one (for transient layers
// like context menus that must float just above whatever modal is open).
function modalZPeek() { return _modalZ; }

let _scrollLockCount = 0;
let _savedBodyOverflow = "";
function lockBodyScroll() {
  // body already has overflow:clip (CSS), so background can't scroll.
  // Setting overflow:hidden here would create a scroll container and
  // swallow wheel/touch events — causing the "need to click background
  // to scroll" freeze. Just count the locks for unlock symmetry.
  _scrollLockCount++;
}
function unlockBodyScroll() {
  _scrollLockCount = Math.max(0, _scrollLockCount - 1);
  // No inline style to restore — body overflow is handled purely by CSS.
}
// Hard reset — used as a safety net when fully closing UI (e.g. logout).
function resetBodyScroll() {
  _scrollLockCount = 0;
  // Ensure no leftover inline overflow (e.g. from an older code path).
  document.body.style.overflow = "";
}

// ── Boop default emoji set (mirrors VRCX src/shared/constants/photon.js) ──
// VRChat boop emojiId for a default emoji = `default_<name lowercased, spaces→_>`.
const PHOTON_EMOJIS = [
  'Angry','Blushing','Crying','Frown','Hand Wave','Hang Ten','In Love',
  'Jack O Lantern','Kiss','Laugh','Skull','Smile','Spooky Ghost','Stoic',
  'Sunglasses','Thinking','Thumbs Down','Thumbs Up','Tongue Out','Wow',
  'Arrow Point',"Can't see",'Hourglass','Keyboard','No Headphones','No Mic',
  'Portal','Shush','Bats','Cloud','Fire','Snow Fall','Snowball','Splash',
  'Web','Beer','Candy','Candy Cane','Candy Corn','Champagne','Drink',
  'Gingerbread','Ice Cream','Pineapple','Pizza','Tomato','Beachball','Coal',
  'Confetti','Gift','Gifts','Life Ring','Mistletoe','Money','Neon Shades',
  'Sun Lotion','Boo','Broken Heart','Exclamation','Go','Heart','Music Note',
  'Question','Stop','Zzz'
];
const PHOTON_EMOJI_ICONS = {
  'Angry':'😠','Blushing':'<i class="fa-solid fa-face-smile"></i> ','Crying':'😭','Frown':'☹️','Hand Wave':'<i class="fa-solid fa-hand"></i> ','Hang Ten':'🤙','In Love':'😍',
  'Jack O Lantern':'🎃','Kiss':'😘','Laugh':'😂','Skull':'💀','Smile':'🙂','Spooky Ghost':'👻','Stoic':'😐',
  'Sunglasses':'😎','Thinking':'🤔','Thumbs Down':'👎','Thumbs Up':'👍','Tongue Out':'😛','Wow':'😮',
  'Arrow Point':'👉',"Can't see":'🙈','Hourglass':'<i class="fa-solid fa-hourglass-half"></i> ','Keyboard':'⌨️','No Headphones':'🔕','No Mic':'<i class="fa-solid fa-volume-xmark"></i> ',
  'Portal':'🌀','Shush':'🤫','Bats':'🦇','Cloud':'☁️','Fire':'<i class="fa-solid fa-fire" style="color: #ff4757;"></i> ','Snow Fall':'🌨️','Snowball':'⛄','Splash':'💦',
  'Web':'🕸️','Beer':'🍺','Candy':'🍬','Candy Cane':'🍭','Candy Corn':'🌽','Champagne':'🍾','Drink':'🍹',
  'Gingerbread':'🍪','Ice Cream':'🍦','Pineapple':'🍍','Pizza':'🍕','Tomato':'🍅','Beachball':'🏖️','Coal':'🪨',
  'Confetti':'🎊','Gift':'<i class="fa-solid fa-gift"></i> ','Gifts':'<i class="fa-solid fa-shop"></i> ','Life Ring':'🛟','Mistletoe':'🌿','Money':'<i class="fa-solid fa-sack-dollar"></i> ','Neon Shades':'<i class="fa-solid fa-vr-cardboard"></i> ',
  'Sun Lotion':'🧴','Boo':'👻','Broken Heart':'💔','Exclamation':'❗','Go':'🟢','Heart':'<i class="fa-solid fa-heart"></i> ','Music Note':'🎵',
  'Question':'❓','Stop':'🛑','Zzz':'💤'
};
// default emojiId for a named photon emoji
function photonEmojiId(name) {
  return `default_${String(name).replace(/ /g, '_').toLowerCase()}`;
}

// ── Search relevance scoring (used by avatar/world/user/group search) ──
// Returns a higher score for closer matches to the query. Tiers:
//   exact name           → 1000
//   name starts with q   → 600
//   whole-word match     → 450
//   substring in name    → 300 (earlier position scores higher)
//   author/tags match    → +120 / +40
//   fuzzy subsequence    → 80 (letters of q appear in order)
// Plus small boosts for completeness (has platform metadata) and recency.
function relevanceScore(item, q) {
  if (!q) return 1;
  q = q.toLowerCase().trim();
  const name = String(item.name || item.displayName || item.avatarName || '').toLowerCase();
  const author = String(item.authorName || (item.author && item.author.name) || '').toLowerCase();
  const tags = Array.isArray(item.tags) ? item.tags.join(' ').toLowerCase() : '';
  const desc = String(item.description || '').toLowerCase();
  let score = 0;

  if (name) {
    if (name === q) score += 1000;
    else if (name.startsWith(q)) score += 600;
    else {
      // whole-word match (e.g. "neko" in "cute neko avatar")
      const wb = new RegExp('(^|[^a-z0-9])' + _escapeReg(q) + '([^a-z0-9]|$)', 'i');
      if (wb.test(name)) score += 450;
      else {
        const idx = name.indexOf(q);
        if (idx >= 0) score += 300 - Math.min(idx, 150); // earlier = better
        else if (_isSubsequence(q, name)) score += 80;    // fuzzy
      }
    }
    // shorter names that match rank slightly higher (less padding)
    if (score > 0 && name.length) score += Math.max(0, 20 - Math.floor(name.length / 4));
  }
  if (author && (author === q || author.includes(q))) score += 120;
  if (tags && tags.includes(q)) score += 40;
  if (desc && desc.includes(q)) score += 10;

  return score;
}

function _escapeReg(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function _isSubsequence(q, text) {
  let i = 0;
  for (let j = 0; j < text.length && i < q.length; j++) if (text[j] === q[i]) i++;
  return i === q.length;
}

// Quality/recency tiebreakers applied AFTER relevance (so equally-relevant
// results show the richest, newest, most cross-platform first).
function qualityScore(item) {
  let s = 0;
  const plats = (typeof getAvatarPlatforms === 'function') ? getAvatarPlatforms(item) : null;
  if (plats) {
    s += plats.size * 8;                          // more platforms = better
    if (plats.has('pc') && plats.has('android')) s += 20; // cross-platform bonus
  } else if (Array.isArray(item.unityPackages)) {
    s += item.unityPackages.length * 4;
  }
  if (item.image_url || item.imageUrl || item.thumbnailImageUrl) s += 10; // has thumbnail
  const t = item.updated_at || item.updatedAt || item.created_at || item.createdAt;
  if (t) {
    const ageDays = (Date.now() - new Date(t).getTime()) / 86400000;
    if (ageDays >= 0) s += Math.max(0, 30 - ageDays / 30); // newer ranks higher, decays ~2.5yr
  }
  return s;
}

// ── Animated emoji rendering (VRChat spritesheet → CSS steps animation) ──
// VRChat stores animated emoji as one 1024×1024 spritesheet. The file object
// carries frames / framesOverTime(fps) / loopStyle. We replicate VRCX's approach:
// a fixed-size element steps through background-position frames.
const _emojiKeyframesInjected = new Set();
function ensureEmojiKeyframes(frameCount, framesPerLine, frameSize) {
  const key = `${frameCount}_${framesPerLine}_${frameSize}`;
  if (_emojiKeyframesInjected.has(key)) return `vrcw-emoji-${key}`;
  const rows = Math.ceil(frameCount / framesPerLine);
  let steps = '';
  for (let i = 0; i < frameCount; i++) {
    const col = i % framesPerLine;
    const row = Math.floor(i / framesPerLine);
    const pct = (i / frameCount) * 100;
    steps += `${pct.toFixed(3)}% { background-position: -${col * frameSize}px -${row * frameSize}px; }\n`;
  }
  const styleEl = document.getElementById('_vrcwEmojiKeyframes') || (() => {
    const s = document.createElement('style');
    s.id = '_vrcwEmojiKeyframes';
    document.head.appendChild(s);
    return s;
  })();
  styleEl.appendChild(document.createTextNode(`@keyframes vrcw-emoji-${key} {\n${steps}}\n`));
  void rows;
  _emojiKeyframesInjected.add(key);
  return `vrcw-emoji-${key}`;
}

// Returns an inline-style string for an animated emoji tile of the given display size.
function animatedEmojiStyle(url, fps, frameCount, loopStyle, displaySize) {
  let framesPerLine = 2;
  if (frameCount > 4) framesPerLine = 4;
  if (frameCount > 16) framesPerLine = 8;
  const frameSize = 1024 / framesPerLine;             // px in the source sheet
  const scale = displaySize / frameSize;              // fit into display box
  const durationMs = (1000 / (fps || 10)) * frameCount;
  const animName = ensureEmojiKeyframes(frameCount, framesPerLine, frameSize);
  const direction = loopStyle === 'pingpong' ? 'alternate' : 'normal';
  return `width:${frameSize}px;height:${frameSize}px;` +
    `transform:scale(${scale});transform-origin:top left;` +
    `background-image:url('${url}');background-repeat:no-repeat;` +
    `animation:${durationMs}ms steps(1) 0s infinite ${direction} running ${animName};`;
}

// Read animation metadata from a VRChat file object (or its versions[].file.* meta).
function getEmojiAnimMeta(f) {
  // Newer files expose these at the top level; older ones inside the version metadata.
  let frames = f.frames, fps = f.framesOverTime, loopStyle = f.loopStyle;
  if (frames == null && Array.isArray(f.versions)) {
    for (let i = f.versions.length - 1; i >= 0; i--) {
      const md = f.versions[i] && (f.versions[i].metadata || f.versions[i].file);
      if (md && md.frames != null) { frames = md.frames; fps = md.framesOverTime; loopStyle = md.loopStyle; break; }
    }
  }
  if (!frames || frames < 2) return null;
  return { frames, fps: fps || 10, loopStyle: loopStyle || 'linear' };
}


// ── API Helper ──
let currentTabAbortController = null;
const scopedAbortControllers = new Map();

function beginScopedAbort(scope) {
  if (!scope) return new AbortController();
  const prev = scopedAbortControllers.get(scope);
  if (prev) {
    try { prev.abort(); } catch (_) {}
  }
  const ctrl = new AbortController();
  scopedAbortControllers.set(scope, ctrl);
  return ctrl;
}

function cancelScopedAbort(scope, ctrl = null) {
  if (!scope) return;
  const cur = scopedAbortControllers.get(scope);
  if (!cur || (ctrl && cur !== ctrl)) return;
  try { cur.abort(); } catch (_) {}
  scopedAbortControllers.delete(scope);
}

function isScopedAbortCurrent(scope, ctrl) {
  return !!(scope && ctrl && scopedAbortControllers.get(scope) === ctrl && !ctrl.signal.aborted);
}

const apiCache = new Map();
const inFlightGetRequests = new Map();
// Endpoints whose data changes constantly — never serve these from the 5s
// micro-cache or the UI shows stale notifications / online state after actions.
const NO_CACHE_PATTERNS = [
  "/notifications",
  "/auth/user/friends",
  "/instances/",
  "/invite",
];
const API_MICRO_CACHE_MS = 15000;
const API_SLOW_LOG_MS = 2500;

function _apiAuthBucket() {
  const raw = vrcAuth || '';
  if (!raw) return 'anon';
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return `auth:${Math.abs(hash)}`;
}

function clearApiMemoryCache() {
  apiCache.clear();
  inFlightGetRequests.clear();
}

async function apiCall(path, options = {}) {
  const method = options.method || 'GET';
  const isGet = method === 'GET';
  const wantsNoStore = options.cache === 'no-store' || options.noCache === true;
  const noDedupe = options.noDedupe === true;
  const requestBody = options.json !== undefined ? JSON.stringify(options.json) : options.body;
  const cacheBodyKey = typeof requestBody === 'string' ? requestBody : '';
  const cacheKey = `${_apiAuthBucket()}::${path}::${cacheBodyKey}`;
  const cacheable = isGet && !wantsNoStore && !noDedupe && !NO_CACHE_PATTERNS.some(p => path.includes(p));

  // Return from memory cache if recent to prevent burst requests when users
  // quickly bounce between panels or detail modals on slow VRChat responses.
  if (cacheable && apiCache.has(cacheKey)) {
    const entry = apiCache.get(cacheKey);
    if (Date.now() - entry.time < API_MICRO_CACHE_MS) {
      return entry.resp.clone();
    }
  }
  if (cacheable && inFlightGetRequests.has(cacheKey)) {
    const shared = await inFlightGetRequests.get(cacheKey);
    return shared.clone();
  }

  const headers = { ...(options.headers || {}) };
  if (vrcAuth) headers["X-VRC-Auth"] = vrcAuth;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  
  // Attach current tab's abort signal unless explicitly overridden
  const signal = options.signal || (!options.noAbort && currentTabAbortController ? currentTabAbortController.signal : undefined);
  
  const startedAt = Date.now();
  const fetchOptions = { ...options, method, headers, body: requestBody, signal };
  delete fetchOptions.json;
  delete fetchOptions.noAbort;
  delete fetchOptions.noCache;
  delete fetchOptions.noDedupe;
  const requestPromise = fetch(`${API_BASE}${path}`, fetchOptions);
  if (cacheable) {
    inFlightGetRequests.set(cacheKey, requestPromise.then(resp => resp.clone()));
  }

  try {
    const resp = await requestPromise;
    const elapsed = Date.now() - startedAt;
    if (elapsed > API_SLOW_LOG_MS) {
      console.debug('[api slow]', `${elapsed}ms`, path);
    }
    // Update auth from response
    const newAuth = resp.headers.get("X-VRC-Auth");
    if (newAuth) {
      if (newAuth !== vrcAuth) clearApiMemoryCache();
      vrcAuth = newAuth;
      localStorage.setItem("vrc_auth", vrcAuth);
    }
    
    // Cache GET responses
    if (cacheable && resp.ok) {
      apiCache.set(cacheKey, { resp: resp.clone(), time: Date.now() });
    }
    if (!isGet && resp.ok) {
      apiCache.clear();
    }

    return resp;
  } catch (err) {
    if (err.name === 'AbortError') {
      // Return a Response-shaped stub for aborted requests so callers that read
      // .headers / .clone() (not just .ok / .json) don't throw.
      return new Response(JSON.stringify({ error: 'Aborted' }), {
        status: 499,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw err;
  } finally {
    if (cacheable) inFlightGetRequests.delete(cacheKey);
  }
}

VRCW.registerService('api', {
  call: apiCall,
  clearMemoryCache: clearApiMemoryCache,
  getAuthBucket: _apiAuthBucket,
});

VRCW.registerService('ui', {
  bumpEpoch: bumpUiEpoch,
  makeToken: makeUiToken,
  isTokenCurrent: isUiTokenCurrent,
  renderVersion: renderAppVersionInfo,
});

VRCW.registerModule('core', {
  apiCall,
  clearApiMemoryCache,
  renderAppVersionInfo,
});

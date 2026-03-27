/**
 * VRChat Avatar Manager — Frontend (Workers Edition)
 * Browser-direct S3 uploads: no server middleman!
 */

// ── Config ──
const API_BASE = location.origin; // Worker serves from same origin
let vrcAuth = localStorage.getItem("vrc_auth") || "";
let avatars = [];
let selectedIds = new Set();
let uploadFiles = [];
let currentLang = localStorage.getItem("vrc_lang") || "zh";
let saveDirHandle = null; // File System Access API directory handle
let visibleAvatars = [];
let currentUserId = ""; // Current logged-in user's VRChat ID
let favoriteGroups = []; // Avatar favorite groups from API (dynamic)
let favoriteIdMap = new Map(); // avatarId -> favoriteId (for unfavoriting)
window._localNameMap = new Map(); // GLOBAL CACHE: avatarId -> name (for recovery)

// ── Local IndexedDB Cache ──
const idb = {
  db: null,
  _initPromise: null,
  async init() {
    if (this.db) return;
    if (this._initPromise) return this._initPromise;
    this._initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open("vrcw_DB", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("cache"))
          db.createObjectStore("cache");
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
  async set(key, value) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("cache", "readwrite");
      const req = tx.objectStore("cache").put(value, key);
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
  }
};
idb.initAndLoadMap();

// ── HTML escape helper (prevent XSS) ──
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── i18n ──
const I18N = {
  en: {
    loginSubtitle: "Sign in with your VRChat account",
    labelUser: "Username or Email",
    labelPass: "Password",
    btnSignIn: "Sign In",
    tfa2faRequired: "Two-factor authentication required",
    labelCode: "Verification Code",
    btnVerify: "Verify",
    tabDownload: "Mine",
    tabUpload: "Upload",
    btnSignOut: "Sign Out",
    statTotal: "Total",
    statSelected: "Selected",
    actions: "Actions",
    btnSelectAll: "Select All",
    btnDownload: "Download Selected",
    btnRefresh: "Refresh",
    console: "Console",
    ready: "Ready.",
    btnPickDir: "Choose Save Location",
    dirNotSupported: "Your browser does not support directory picker",
    dirSelected: "Save to: ",
    dirCleared: "Save location cleared, using browser default",
    downloading: "Downloading",
    uploadMode: "Upload Mode",
    modeNew: "Create New",
    modeUpdate: "Update Existing",
    dropText: "Click or drag .vrca files here",
    dropHint: "Max 500 MB per file",
    avatarName: "Avatar Name",
    selectAvatar: "Select Avatar to Update",
    btnUpload: "Upload",
    uploading: "Uploading...",
    uploadOk: "Upload successful!",
    uploadFail: "Upload failed: ",
    confirmDelete: "Are you sure you want to delete this avatar?\n\n",
    deleted: "Deleted ",
    deleteFail: "Failed to delete: ",
    editTitle: "Edit Avatar",
    editDesc: "Description",
    editStatus: "Release Status",
    editTags: "Tags (comma separated)",
    btnCancel: "Cancel",
    btnSave: "Save",
    editSuccess: "Successfully updated ",
    editFail: "Failed to update: ",
    category: "Category",
    catMine: "My Avatars",
    catFav1: "Favorites 1",
    searchPlaceholder: "Search name, desc, tags...",
    filterAllStatus: "All Status",
    filterPublic: "Public",
    filterPrivate: "Private",
    filterAllPlatform: "All Platforms",
    filterCross: "Cross-Platform",
    filterPC: "Contains PC",
    filterQuest: "Contains Quest",
    filterApple: "Contains Apple",
    filterPCQuest: "PC + Quest",
    filterPCQuestApple: "PC + Quest + Apple",
    filterPCQuestAppleShort: "PC + Q + A",
    editName: "Resource Name",
    friendSortStatus: "Sort by Status",
    friendSortName: "Sort by Name",
    friendSortActivity: "Recently Active",
    myProfile: "My Profile",
    coLocatedFriends: "Friends here",
    loading: "Loading...",
  },
  zh: {
    loginSubtitle: "使用 VRChat 账号登录",
    labelUser: "用户名或邮箱",
    labelPass: "密码",
    btnSignIn: "登录",
    tfa2faRequired: "需要两步验证",
    labelCode: "验证码",
    btnVerify: "验证",
    tabDownload: "我的",
    tabUpload: "上传",
    btnSignOut: "退出登录",
    statTotal: "总数",
    statSelected: "已选",
    actions: "操作",
    btnSelectAll: "全选",
    btnDownload: "下载选中",
    btnRefresh: "刷新",
    console: "控制台",
    ready: "就绪。",
    btnPickDir: "选择保存位置",
    dirNotSupported: "您的浏览器不支持选择文件夹",
    dirSelected: "保存到：",
    dirCleared: "已清除保存位置，使用浏览器默认下载",
    downloading: "下载中",
    uploadMode: "上传模式",
    modeNew: "新建",
    modeUpdate: "更新已有",
    dropText: "点击或拖拽 .vrca 文件到这里",
    dropHint: "每个文件最大 500 MB",
    avatarName: "模型名称",
    selectAvatar: "选择要更新的模型",
    btnUpload: "上传",
    uploading: "上传中...",
    uploadOk: "上传成功！",
    uploadFail: "上传失败：",
    confirmDelete: "确定要删除此模型吗？（这会将其从此列表中隐藏）\n\n",
    deleted: "已删除 ",
    deleteFail: "删除失败：",
    editTitle: "编辑模型信息",
    editDesc: "描述",
    editStatus: "发布状态",
    editTags: "标签 (逗号分隔)",
    btnCancel: "取消",
    btnSave: "保存",
    editSuccess: "成功更新 ",
    editFail: "更新失败：",
    category: "分类",
    catMine: "我的模型",
    catFav1: "收藏夹 1",
    searchPlaceholder: "搜索名称、简介、标签...",
    filterAllStatus: "所有状态",
    filterPublic: "公开",
    filterPrivate: "私有",
    filterAllPlatform: "所有平台",
    filterCross: "双端兼容 (PC+Quest)",
    filterPC: "含 PC",
    filterQuest: "含 Quest",
    filterApple: "含 Apple",
    filterPCQuest: "含 PC + Quest",
    filterPCQuestApple: "PC + Quest + Apple",
    filterPCQuestAppleShort: "PC + Q + A",
    editName: "资源名称",
    friendSortStatus: "在线优先",
    friendSortName: "名字 A→Z",
    friendSortActivity: "最近活跃",
    myProfile: "我的资料",
    coLocatedFriends: "在此实例的好友",
    loading: "加载中...",
  },
  ja: {
    loginSubtitle: "VRChatアカウントでログイン",
    labelUser: "ユーザー名またはメール",
    labelPass: "パスワード",
    btnSignIn: "サインイン",
    tfa2faRequired: "二段階認証が必要です",
    labelCode: "認証コード",
    btnVerify: "認証",
    tabDownload: "マイアバター",
    tabUpload: "アップロード",
    btnSignOut: "サインアウト",
    statTotal: "合計",
    statSelected: "選択済み",
    actions: "アクション",
    btnSelectAll: "全選択",
    btnDownload: "選択をダウンロード",
    btnRefresh: "更新",
    console: "コンソール",
    ready: "準備完了。",
    btnPickDir: "保存先を選択",
    dirNotSupported: "お使いのブラウザはフォルダ選択に対応していません",
    dirSelected: "保存先：",
    dirCleared: "保存先をクリアしました。ブラウザのデフォルトを使用します",
    downloading: "ダウンロード中",
    uploadMode: "アップロードモード",
    modeNew: "新規作成",
    modeUpdate: "既存を更新",
    dropText: ".vrcaファイルをここにドラッグ",
    dropHint: "最大500MB",
    avatarName: "アバター名",
    selectAvatar: "更新するアバターを選択",
    btnUpload: "アップロード",
    uploading: "アップロード中...",
    uploadOk: "アップロード成功！",
    uploadFail: "アップロード失敗：",
    confirmDelete: "このアバターを削除してもよろしいですか？\n\n",
    deleted: "削除しました ",
    deleteFail: "削除に失敗しました：",
    editTitle: "アバターを編集",
    editDesc: "説明",
    editStatus: "公開ステータス",
    editTags: "タグ (カンマ区切り)",
    btnCancel: "キャンセル",
    btnSave: "保存",
    editSuccess: "更新しました ",
    editFail: "更新に失敗しました：",
    category: "カテゴリー",
    catMine: "マイアバター",
    catFav1: "お気に入り 1",
    searchPlaceholder: "名前、説明、タグを検索...",
    filterAllStatus: "すべての状態",
    filterPublic: "公開",
    filterPrivate: "非公開",
    filterAllPlatform: "すべてのプラットフォーム",
    filterCross: "クロスプラットフォーム",
    friendSortStatus: "オンライン優先",
    friendSortName: "名前順",
    friendSortActivity: "最近のアクティビティ",
    myProfile: "マイプロフィール",
    coLocatedFriends: "このインスタンスのフレンド",
    loading: "読み込み中...",
  },
};

function t(key) {
  return (I18N[currentLang] || I18N.en)[key] || I18N.en[key] || key;
}

function setLang(lang) {
  currentLang = lang;
  localStorage.setItem("vrc_lang", lang);
  applyI18n();
  
  document.querySelectorAll(".lang-btn").forEach((b) =>
    b.classList.toggle(
      "active",
      b.textContent.trim() ===
        ({ en: "EN", zh: "中文", ja: "日本語" }[lang] || "")
    )
  );
}

function applyI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const val = t(key);
    if (val) el.textContent = val;
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    const val = t(key);
    if (val) el.placeholder = val;
  });
}

// ── API Helper ──
let currentTabAbortController = null;

async function apiCall(path, options = {}) {
  const headers = options.headers || {};
  if (vrcAuth) headers["X-VRC-Auth"] = vrcAuth;
  if (options.json) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.json);
    delete options.json;
  }
  
  // Attach current tab's abort signal unless explicitly overridden
  if (!options.signal && !options.noAbort && currentTabAbortController) {
    options.signal = currentTabAbortController.signal;
  }
  
  try {
    const resp = await fetch(`${API_BASE}${path}`, { ...options, headers });
    // Update auth from response
    const newAuth = resp.headers.get("X-VRC-Auth");
    if (newAuth) {
      vrcAuth = newAuth;
      localStorage.setItem("vrc_auth", vrcAuth);
    }
    return resp;
  } catch (err) {
    if (err.name === 'AbortError') {
      // Return a dummy failed response for aborted requests
      return { ok: false, status: 499, json: async () => ({ error: 'Aborted' }), text: async () => 'Aborted' };
    }
    throw err;
  }
}

// ── Polled Asynchronous Image Loading ──
const imageQueue = [];
let runningLoads = 0;
const MAX_CONCURRENT_IMAGES = 6;
const loadedImageUrls = new Set();

function processImageQueue() {
  while (runningLoads < MAX_CONCURRENT_IMAGES && imageQueue.length > 0) {
    runningLoads++;
    const { img, src } = imageQueue.shift();
    const wrapper = img.parentElement;

    // Mark as actively loading (CSS spinner on wrapper)
    img.classList.add("loading");
    if (wrapper) wrapper.classList.add("img-loading");

    img.onload = () => {
      img.onload = img.onerror = null;
      img.classList.remove("loading");
      if (wrapper) wrapper.classList.remove("img-loading");
      loadedImageUrls.add(src);
      runningLoads--;
      processImageQueue();
    };
    img.onerror = () => {
      img.onload = img.onerror = null;
      const retryCount = parseInt(img.dataset.retry || "0");
      if (retryCount < 2) {
        img.dataset.retry = retryCount + 1;
        imageQueue.push({ img, src });
      } else {
        img.classList.remove("loading");
        img.classList.add("failed");
        if (wrapper) {
          wrapper.classList.remove("img-loading");
          wrapper.classList.add("img-failed");
        }
      }
      runningLoads--;
      processImageQueue();
    };

    img.src = src;
  }
}

const avatarObserver = new IntersectionObserver(
  (entries, observer) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const img = entry.target;
        const src = img.getAttribute("data-src");
        if (src) {
          img.removeAttribute("data-src");
          imageQueue.push({ img, src });
          observer.unobserve(img);
          processImageQueue();
        }
      }
    });
  },
  { rootMargin: "300px" },
);

// ── Batch Image Prefetch ──
// Sends thumbnail URLs to the Worker's batch endpoint so it can
// download them from VRC's servers at edge speed and cache them.
function prefetchThumbnails(avatarList) {
  const rawUrls = avatarList
    .map(av => av.thumbnailImageUrl || av.imageUrl || "")
    .filter(u => u && (u.includes("api.vrchat.cloud") || u.includes("files.vrchat.cloud")));

  // Skip URLs already in the browser's memory cache
  const proxyUrls = rawUrls.map(u =>
    `${API_BASE}/api/image?url=${encodeURIComponent(u)}&auth=${encodeURIComponent(vrcAuth || "")}`
  );
  const uncached = rawUrls.filter((_, i) => !loadedImageUrls.has(proxyUrls[i]));
  if (!uncached.length) return;

  // Chunk into batches of 50 (CF Worker subrequest limit)
  const BATCH_SIZE = 50;
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    const batch = uncached.slice(i, i + BATCH_SIZE);
    apiCall("/api/images/prefetch", {
      method: "POST",
      json: { urls: batch },
    })
      .then(r => r.json())
      .then(d => {
        if (d.fetched > 0) logMsg(`⚡ Prefetched ${d.fetched} thumbnails at edge`, "info");
      })
      .catch(() => {}); // Silent fail
  }
}

// ── Mobile Sidebar Toggle ──
window.toggleSidebar = function (forceState) {
  const activePanel = document.querySelector(".download-panel.active") || document.querySelector(".upload-panel.active");
  if (!activePanel) return;
  const sidebar = activePanel.querySelector(".sidebar");
  if (!sidebar) return;

  const overlay = document.getElementById("sidebarOverlay");
  const btn     = document.getElementById("mobileSidebarBtn");
  
  const isOpening = forceState !== undefined ? forceState : !sidebar.classList.contains("open");

  if (isOpening) {
    sidebar.classList.add("open");
    overlay?.classList.add("active");
  } else {
    document.querySelectorAll(".sidebar.open").forEach(s => s.classList.remove("open"));
    overlay?.classList.remove("active");
  }

  btn?.classList.toggle("active", isOpening);
  if (btn) btn.textContent = isOpening ? "✕" : "☰";
};

// ── Login & Account Management ──
let lastAttemptUser = "";

function renderSavedAccounts() {
  const container = document.getElementById("savedAccountsContainer");
  if (!container) return;
  const accs = JSON.parse(localStorage.getItem("vrc_accounts") || "[]");
  if (accs.length === 0) {
    container.innerHTML = "";
    return;
  }

  let html = `<div style="margin-top: 20px; margin-bottom: 8px; font-size: 0.9em; color: rgba(255,255,255,0.6);">Saved Accounts</div>`;
  html += '<div style="display: flex; flex-wrap: wrap; gap: 8px;">';
  accs.forEach((acc, i) => {
    html += `<button class="btn btn-secondary" style="flex: 1; min-width: 100px; padding: 6px;" onclick="loginSaved(${i})">${escHtml(acc.username)}</button>`;
  });
  html += "</div>";
  container.innerHTML = html;
}

window.loginSaved = async function (idx) {
  const accs = JSON.parse(localStorage.getItem("vrc_accounts") || "[]");
  if (accs[idx]) {
    vrcAuth = accs[idx].auth;
    localStorage.setItem("vrc_auth", vrcAuth);
    // Verify the saved token is still valid
    try {
      const r = await apiCall("/api/vrc/auth/user");
      if (r.ok) {
        showMainApp();
      } else {
        // Token expired — remove from saved and show error
        accs.splice(idx, 1);
        localStorage.setItem("vrc_accounts", JSON.stringify(accs));
        renderSavedAccounts();
        vrcAuth = "";
        localStorage.removeItem("vrc_auth");
        const errEl = document.getElementById("login-error");
        errEl.textContent = "Session expired, please login again";
        errEl.style.display = "block";
      }
    } catch (e) {
      const errEl = document.getElementById("login-error");
      errEl.textContent = "Network error";
      errEl.style.display = "block";
    }
  }
};

function saveAccountInfo(username) {
  if (!username || !vrcAuth) return;
  let accs = JSON.parse(localStorage.getItem("vrc_accounts") || "[]");
  accs = accs.filter((a) => a.username !== username);
  accs.unshift({ username, auth: vrcAuth });
  localStorage.setItem("vrc_accounts", JSON.stringify(accs));
  renderSavedAccounts();
}

async function doLogin() {
  const user = document.getElementById("username").value.trim();
  const pass = document.getElementById("password").value.trim();
  if (!user || !pass) return;

  lastAttemptUser = user;
  const btn = document.getElementById("btnLogin");
  btn.disabled = true;
  const errEl = document.getElementById("login-error");
  errEl.style.display = "none";

  try {
    const resp = await apiCall("/api/login", {
      method: "POST",
      json: { username: user, password: pass },
    });
    const data = await resp.json();
    if (data.ok) {
      if (data.needs2FA) {
        document.getElementById("tfa-section").classList.add("active");
      } else {
        saveAccountInfo(user);
        showMainApp();
      }
    } else {
      errEl.textContent = data.message || "Login failed";
      errEl.style.display = "block";
    }
  } catch (e) {
    errEl.textContent = "Network error";
    errEl.style.display = "block";
  }
  btn.disabled = false;
}

async function doVerify2FA() {
  const code = document.getElementById("tfaCode").value.trim();
  if (!code) return;
  const btn = document.querySelector("#tfa-section button");
  if (btn) btn.disabled = true;
  try {
    const resp = await apiCall("/api/2fa", { method: "POST", json: { code } });
    const data = await resp.json();
    if (data.ok) {
      if (lastAttemptUser) saveAccountInfo(lastAttemptUser);
      showMainApp();
    } else {
      alert(data.message || "Invalid code");
    }
  } catch (e) {
    alert("Network error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function doLogout() {
  vrcAuth = "";
  localStorage.removeItem("vrc_auth");
  renderSavedAccounts();
  document.getElementById("loginPage").classList.remove("hidden");
  document.getElementById("mainApp").classList.add("hidden");
}

function showMainApp() {
  document.getElementById("loginPage").classList.add("hidden");
  document.getElementById("mainApp").classList.remove("hidden");
  // Fetch current user + favorite groups in parallel
  apiCall("/api/vrc/auth/user")
    .then(async (r) => {
      if (r.ok) {
        const user = await r.json();
        currentUserId = user.id || "";
      }
    })
    .catch(() => {});
  fetchFavoriteGroups();
  fetchAvatars();
  syncAllFavoriteIds(); // Fetch all favorite statuses globally
}

// ── Sync All Favorites Globally ──
async function syncAllFavoriteIds() {
  let offset = 0;
  // Don't clear, just merge (in case fetchAvatars already populated some)
  try {
    while (true) {
      const resp = await apiCall(`/api/vrc/favorites?type=avatar&n=100&offset=${offset}`);
      if (!resp.ok) break;
      const favs = await resp.json();
      if (!favs || favs.length === 0 || favs.error) break;
      favs.forEach((f) => favoriteIdMap.set(f.favoriteId, f.id));
      if (favs.length < 100) break;
      offset += 100;
      await new Promise((r) => setTimeout(r, 100)); // Rate limit protection
    }
    logMsg(`✅ 已同步 ${favoriteIdMap.size} 个全局收藏状态`, "info");
  } catch (e) {
    console.warn("Failed to sync favorite IDs globally", e);
  }
}

// ── Favorite Groups (dynamic sidebar) ──
async function fetchFavoriteGroups() {
  try {
    const resp = await apiCall("/api/vrc/favorite/groups?type=avatar&n=50");
    if (!resp.ok) throw new Error("failed");
    const groups = await resp.json();
    favoriteGroups = (groups || [])
      .filter((g) => g.name && g.name.startsWith("avatars"))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
    renderFavoriteGroupButtons();
    preloadAllFavorites(favoriteGroups.map((g) => g.name));
  } catch (e) {
    // Fallback: show avatars1 only (already in HTML)
    console.warn("Could not fetch favorite groups", e);
  }
}

async function preloadAllFavorites(groups) {
  // Delay to not compete with the initial fetchAvatars on login
  await new Promise((r) => setTimeout(r, 3000));
  for (const g of groups) {
    // Skip currently active category - already fetched by fetchAvatars
    if (g === currentCategory) continue;
    // Skip if we already have cache for this group (avoid overwriting user changes)
    try {
      const existing = await idb.get("avatars_" + g);
      if (existing && existing.length > 0) continue;
    } catch (_) {}
    try {
      let offset = 0;
      let allFetched = [];
      while (true) {
        const resp = await apiCall(
          `/api/vrc/avatars/favorites?n=100&offset=${offset}&tag=${g}`,
        );
        if (!resp.ok) break;
        const batch = await resp.json();
        if (!batch || batch.length === 0) break;
        allFetched = allFetched.concat(batch);
        if (batch.length < 100) break;
        offset += 100;
      }
      if (allFetched.length > 0) {
        await idb.set("avatars_" + g, allFetched);
        // Incremental update to global map
        allFetched.forEach(av => {
          if (av.id && av.name && av.name !== 'Unknown') {
            window._localNameMap.set(av.id, av.name);
          }
        });
        logMsg(`✓ Preloaded ${allFetched.length} for ${g}`, "info");
      }
      // Small delay between groups to prevent rate limiting
      await new Promise((r) => setTimeout(r, 500));
    } catch (e) {
      console.warn("preload failed for", g, e);
    }
  }
}

function renderFavoriteGroupButtons() {
  const container = document.getElementById("favGroupBtns");
  if (!container) return;
  // avatars1 is already the static button in HTML; dynamic ones start from index 1
  // Actually render ALL detected groups to keep it consistent
  // First, update the static avatars1 button display name if group has a custom displayName
  const g1 = favoriteGroups.find((g) => g.name === "avatars1");
  const btn1 = document.getElementById("cat-avatars1");
  if (btn1 && g1) {
    btn1.textContent = g1.displayName || "Favorites 1";
  }
  // Render avatars2+ dynamically
  container.innerHTML = "";
  favoriteGroups
    .filter((g) => g.name !== "avatars1")
    .forEach((g) => {
      const btn = document.createElement("button");
      btn.className = "btn btn-secondary btn-block cat-btn";
      btn.id = "cat-" + g.name;
      btn.textContent =
        g.displayName || g.name.replace("avatars", "Favorites ");
      btn.onclick = () => switchCategory(g.name);
      container.appendChild(btn);
    });
}

// ── Tabs ──
function switchTab(tab) {
  if (window.innerWidth <= 768) toggleSidebar(false);
  
  if (currentTabAbortController) currentTabAbortController.abort();
  currentTabAbortController = new AbortController();
  
  // Legacy tab-btn support
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelector(`.tab-btn[onclick*="'${tab}'"]`)?.classList.add("active");
  
  // New global nav items - foolproof selection via onclick attribute
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".nav-item-icon").forEach((b) => b.classList.remove("active"));
  
  document.querySelector(`.nav-item[onclick*="'${tab}'"]`)?.classList.add("active");
  document.querySelector(`.nav-item-icon[onclick*="'${tab}'"]`)?.classList.add("active");

  const tabTitles = { download:"头像模型", upload:"上传", search:"全站搜索", friends:"社交与好友", worlds:"虚拟世界", groups:"群组", assets:"虚拟资产" };
  const topTitle = document.querySelector('.mobile-top-title');
  if (topTitle && tabTitles[tab]) topTitle.textContent = "VRCW - " + tabTitles[tab];

  document
    .getElementById("downloadPanel")
    .classList.toggle("active", tab === "download");
  document
    .getElementById("uploadPanel")
    .classList.toggle("active", tab === "upload");
  const searchPanel = document.getElementById("searchPanel");
  if (searchPanel) searchPanel.classList.toggle("active", tab === "search");
  const friendsPanel = document.getElementById("friendsPanel");
  if (friendsPanel) {
    friendsPanel.classList.toggle("active", tab === "friends");
    if (tab === "friends" && !friendsLoaded) initFriendsTab();
  }
  const worldsPanel = document.getElementById("worldsPanel");
  if (worldsPanel) {
    worldsPanel.classList.toggle("active", tab === "worlds");
    if (tab === "worlds" && !worldsLoaded) initWorldsTab();
  }
  const groupsPanel = document.getElementById("groupsPanel");
  if (groupsPanel) {
    groupsPanel.classList.toggle("active", tab === "groups");
    if (tab === "groups") loadGroupsPage('mine');
  }
  const assetsPanel = document.getElementById("assetsPanel");
  if (assetsPanel) {
    assetsPanel.classList.toggle("active", tab === "assets");
    if (tab === "assets") initAssetsTab();
  }
}

// ── Categories ──
let currentCategory = "mine";

function switchCategory(cat) {
  currentCategory = cat;
  document.querySelectorAll(".cat-btn").forEach((btn) => {
    btn.classList.remove("active", "btn-primary");
    btn.classList.add("btn-secondary");
  });
  const activeBtn = document.getElementById("cat-" + cat);
  if (activeBtn) {
    activeBtn.classList.remove("btn-secondary");
    activeBtn.classList.add("btn-primary", "active");
  }

  // Immediately update context-dependent sidebar buttons
  const isFavoriteView = cat !== "mine";
  document.getElementById("btnCleanFavs")?.classList.toggle("hidden", !isFavoriteView);
  document.getElementById("btnUnfavoriteSelected")?.classList.toggle("hidden", !isFavoriteView);
  document.getElementById("btnSelectAll")?.classList.remove("hidden"); // Always visible
  document.getElementById("saveDirGroup")?.classList.toggle("hidden", isFavoriteView);
  document.querySelector('button[onclick="downloadSelected()"]')?.classList.toggle("hidden", isFavoriteView);

  // Close sidebar on mobile after selection
  document.getElementById("appSidebar")?.classList.remove("open");
  document.getElementById("sidebarOverlay")?.classList.remove("active");

  fetchAvatars();
}

// ── Selected Count Helper ──
function updateSelectedCount() {
  const el = document.getElementById("statSelected");
  if (el) el.textContent = selectedIds.size;
}

// ── Avatars ──
let fetchSeq = 0; // Track latest fetch to avoid stale renders
async function fetchAvatars(forceRefresh = false) {
  const seq = ++fetchSeq;
  logMsg(`Fetching avatars for ${currentCategory}...`, "info");

  // Immediately clear previous state to prevent UI from showing stale data (the "list jumping" bug)
  avatars = [];
  selectedIds.clear();
  updateSelectedCount();
  applyFilters(); // Renders empty grid until cache/API returns

  // Quick render from cache ONLY if not force-refreshing
  try {
    const cacheKey = "avatars_" + currentCategory;
    if (forceRefresh) {
      // Clear cache so we always get fresh data; show loading state
      await idb.set(cacheKey, null);
      const grid = document.getElementById("avatarGrid");
      if (grid) grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:60px;color:rgba(255,255,255,0.4);">刷新中... / Refreshing...</div>`;
      logMsg(`Refreshing ${currentCategory} from server...`, "info");
    } else {
      const cached = await idb.get(cacheKey);
      if (cached && cached.length > 0 && seq === fetchSeq) {
        avatars = cached;
        applyFilters();
        logMsg(`Loaded ${avatars.length} from cache. Click Refresh to update.`, "success");
        return;
      }
    }
  } catch (e) {
    console.warn("Cache load failed", e);
  }

  try {
    let allFetched = [];

    if (currentCategory === "mine") {
      const resp = await apiCall("/api/avatars");
      if (!resp.ok) throw new Error("Failed to fetch avatars");
      allFetched = await resp.json();
    } else {
      // VRC+ favorites max is around 256. Fetch sequentially to avoid rate-limiting (429 errors)
      let offset = 0;
      while (true) {
        const resp = await apiCall(`/api/vrc/avatars/favorites?n=100&offset=${offset}&tag=${currentCategory}`);
        if (!resp.ok) break;
        const batch = await resp.json();
        if (!batch || batch.length === 0) break;
        allFetched = allFetched.concat(batch);
        if (batch.length < 100) break;
        offset += 100;
        if (offset >= 400) break; // Maximum safety ceiling for favorites
      }

      // Deduplicate by ID just in case
      const seen = new Set();
      allFetched = allFetched.filter(av => {
        if (seen.has(av.id)) return false;
        seen.add(av.id);
        return true;
      });
    }

    // If views changed while we waited, abandon stale render
    if (seq !== fetchSeq) return;

    avatars = allFetched;
    applyFilters();
    logMsg(`Found ${avatars.length} avatars`, "success");

    // Fire background batch prefetch — Worker downloads all thumbnails concurrently
    // from VRC servers at edge speed and caches them, so browser image loads are instant
    prefetchThumbnails(allFetched);

    try {
      await idb.set("avatars_" + currentCategory, allFetched);
    } catch (e) {}

    // If viewing a favorites category, also fetch the Favorite objects
    // so we have the favoriteId needed to unfavorite each avatar.
    if (currentCategory !== "mine") {
      try {
        const favPromises = [0, 100, 200, 300].map(offset =>
          apiCall(`/api/vrc/favorites?type=avatar&tag=${currentCategory}&n=100&offset=${offset}`)
            .then(r => (r.ok ? r.json() : []))
            .catch(() => [])
        );
        const favResults = await Promise.all(favPromises);
        favResults.forEach(favList => {
          if (favList && favList.length > 0 && !favList.error) {
            favList.forEach(fav => favoriteIdMap.set(fav.favoriteId, fav.id));
          }
        });
      } catch (e) {
        console.warn("Could not fetch favoriteIds", e);
      }
      // Update only the unfavorite buttons on existing cards (no full re-render)
      document.querySelectorAll('.avatar-card').forEach(card => {
        const id = card.id.replace('card-', '');
        const updateFavBtn = card.querySelector('.btn-action.unfavorite');
        if (updateFavBtn && !favoriteIdMap.has(id)) {
          // favoriteId still not found, mark as unresolvable
          updateFavBtn.title = 'Cannot unfavorite (ID not found)';
          updateFavBtn.style.opacity = '0.4';
        }
      });
    }

    // Also populate upload avatar select (custom glass select)
    const selOptions = document.getElementById("avatarSelectOptions");
    if (selOptions) {
      selOptions.innerHTML = '<div class="glass-option" onclick="selectGlassOption(event, this, \'\')">-- Select --</div>';
      avatars.forEach((a) => {
        const opt = document.createElement("div");
        opt.className = "glass-option";
        opt.textContent = a.name;
        opt.onclick = (e) => selectGlassOption(e, opt, a.id);
        selOptions.appendChild(opt);
      });
    }
  } catch (e) {
    logMsg("Error: " + e.message, "error");
  }
}

function applyFilters() {
  const q = document.getElementById("searchInput")?.value.toLowerCase().trim() || "";
  const state = document.getElementById("filterStatus")?.value || "all";
  const plat = document.getElementById("filterPlatform")?.value || "all";

  // When searching in any favorites category, search across ALL favorites groups
  const isFavoritesSearch = q && currentCategory !== "mine";
  if (isFavoritesSearch) {
    applyFiltersAcrossAllFavorites(q, state, plat);
    return;
  }

  _applyFiltersToList(avatars, q, state, plat);
}

// Search across all cached favorites groups combined
async function applyFiltersAcrossAllFavorites(q, state, plat) {
  const groups = favoriteGroups.map(g => g.name);
  if (groups.length === 0) {
    // Fallback: just filter current avatars
    _applyFiltersToList(avatars, q, state, plat);
    return;
  }

  // Load all favorites from IDB cache and combine
  let combined = [...avatars]; // Start with already-loaded current group
  const currentGroupSet = new Set(avatars.map(a => a.id));

  for (const g of groups) {
    if (g === currentCategory) continue; // Already included
    try {
      const cached = await idb.get("avatars_" + g);
      if (cached && cached.length > 0) {
        // Deduplicate by id
        cached.forEach(av => { if (!currentGroupSet.has(av.id)) { combined.push(av); currentGroupSet.add(av.id); } });
      }
    } catch (_) {}
  }

  _applyFiltersToList(combined, q, state, plat);
}

function _platformCheck(av) {
  // 根据性能评级来更精准地判断平台兼容性（如果某个平台没有评级或是 None，则认为不支持）
  const pkgs = av.unityPackages || [];
  const hasPC = pkgs.some(p => p.platform === "standalonewindows" && p.performanceRating && p.performanceRating !== "None");
  const hasQuest = pkgs.some(p => p.platform === "android" && p.performanceRating && p.performanceRating !== "None");
  const hasApple = pkgs.some(p => p.platform === "ios" && p.performanceRating && p.performanceRating !== "None");
  return { hasPC, hasQuest, hasApple };
}

function _applyFiltersToList(list, q, state, plat) {
  let filtered = list
    .map((av) => {
      let score = 0;

      // Match status
      if (state !== "all" && av.releaseStatus !== state) return null;

      // Match platform — inclusive: "PC Only" means has PC, "PC+Quest" means has both, etc.
      if (plat !== "all") {
        const { hasPC, hasQuest, hasApple } = _platformCheck(av);
        if (plat === "pc" && !hasPC) return null;
        if (plat === "pc-quest" && (!hasPC || !hasQuest)) return null;
        if (plat === "pc-quest-apple" && (!hasPC || !hasQuest || !hasApple)) return null;
      }

      // Match Query (Fuzzy Search & Relevance Scoring)
      if (q) {
        const name = (av.name || "").toLowerCase();
        const desc = (av.description || "").toLowerCase();
        const tags = (av.tags || []).join(" ").toLowerCase();

        if (name === q) score += 100;
        else if (name.includes(q)) score += 50;

        if (tags.includes(q)) score += 30;
        if (desc.includes(q)) score += 10;

        // Allow loose typos in name using simple check (e.g., if query letters appear in order)
        if (score === 0) {
          let qIdx = 0;
          for (let i = 0; i < name.length; i++) {
            if (name[i] === q[qIdx]) qIdx++;
            if (qIdx === q.length) break;
          }
          if (qIdx === q.length) score += 5; // Fuzzy match
        }

        if (score === 0) return null;
      } else {
        score = 1; // Base score
      }

      return { avatar: av, score };
    })
    .filter((x) => x !== null);

  // Sort by relevance (score descending), then by updated_at (newest first)
  filtered.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (
      new Date(b.avatar.updatedAt || b.avatar.updated_at || 0) -
      new Date(a.avatar.updatedAt || a.avatar.updated_at || 0)
    );
  });

  visibleAvatars = filtered.map((x) => x.avatar);
  renderGrid(visibleAvatars);
}

function renderGrid(list) {
  const grid = document.getElementById("avatarGrid");
  if (!grid) return;

  // Unobserve all stale images before clearing the grid
  grid
    .querySelectorAll(".avatar-thumb[data-src]")
    .forEach((img) => avatarObserver.unobserve(img));
    
  // Clear the image queue to prevent fetching a backlog of ghost images
  imageQueue.length = 0; 

  grid.innerHTML = "";

  // Show empty state when no avatars
  if (list.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;height:300px;color:rgba(255,255,255,0.4);gap:12px;">
      <div style="font-size:3em;">🎭</div>
      <div style="font-size:1.1em;">暂无模型 / No avatars found</div>
      <div style="font-size:0.85em;">点击「刷新」按钮重新加载 / Click Refresh to reload</div>
    </div>`;
    document.getElementById("statTotal").textContent = 0;
    return;
  }
  const isFavoriteView = currentCategory !== "mine";

  // Toggle Action Buttons based on context
  document.getElementById("btnCleanFavs")?.classList.toggle("hidden", !isFavoriteView);
  document.getElementById("btnUnfavoriteSelected")?.classList.toggle("hidden", !isFavoriteView);
  document.getElementById("btnSelectAll")?.classList.remove("hidden"); // Always visible
  document.getElementById("saveDirGroup")?.classList.toggle("hidden", isFavoriteView);
  document.querySelector('button[onclick="downloadSelected()"]')?.classList.toggle("hidden", isFavoriteView);

  list.forEach((av) => {
    let thumb = av.thumbnailImageUrl || av.imageUrl || "";
    if (
      thumb &&
      (thumb.includes("api.vrchat.cloud") ||
        thumb.includes("files.vrchat.cloud"))
    ) {
      thumb = `${API_BASE}/api/image?url=${encodeURIComponent(thumb)}&auth=${encodeURIComponent(vrcAuth || "")}`;
    }

    const safeId = escHtml(av.id);
    const isOwner = currentUserId && av.authorId === currentUserId;
    const card = document.createElement("div");

    // Both mine and favorites support selection now
    card.className = "avatar-card" + (selectedIds.has(av.id) ? " selected" : "");

    // Build action buttons: edit/delete only for owner; unfavorite only in favorites view
    let actionBtns = "";
    if (isOwner) {
      actionBtns += `<button class="btn-action edit" title="Edit" onclick="event.stopPropagation(); editAvatar('${safeId}')">✏️</button>`;
      actionBtns += `<button class="btn-action delete" title="Delete" onclick="event.stopPropagation(); deleteAvatar('${safeId}', '${escHtml(av.name).replace(/'/g, "\\'")}')">🗑️</button>`;
    }
    if (isFavoriteView) {
      actionBtns += `<button class="btn-action unfavorite" title="移出收藏" onclick="event.stopPropagation(); unfavorite('${safeId}', '${escHtml(av.name).replace(/'/g, "\\'")}')">&times;</button>`;
    }

    // Apply memory cache for instant render if already loaded previously
    const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const isCached = loadedImageUrls.has(thumb);
    const imgHtml = isCached 
        ? `<img class="avatar-thumb clickable-thumb" src="${escHtml(thumb)}" alt="${escHtml(av.name)}" onclick="event.stopPropagation(); openLocalDetail('${safeId}')" title="点击查看详情">`
        : `<img class="avatar-thumb loading clickable-thumb" src="${BLANK}" data-src="${escHtml(thumb)}" alt="" onclick="event.stopPropagation(); openLocalDetail('${safeId}')" title="点击查看详情">`;

    card.innerHTML = `
            ${actionBtns ? `<div class="avatar-actions">${actionBtns}</div>` : ""}
            <div class="avatar-checkbox" onclick="event.stopPropagation(); toggleSelect('${safeId}')" title="选中/取消选中">✓</div>
            <div class="avatar-thumb-wrapper ${isCached ? '' : 'img-loading'}">
                ${imgHtml}
                <div class="avatar-name-overlay">${escHtml(av.name || "失效模型 (Invalid / Deleted)")}</div>
            </div>
        `;
    card.id = "card-" + av.id;
    grid.appendChild(card);
  });

  // Lazy loaded async image queue
  const imgs = grid.querySelectorAll(".avatar-thumb[data-src]");
  imgs.forEach((img) => avatarObserver.observe(img));

  document.getElementById("statTotal").textContent = list.length;
}

// ── Unfavorite ──
async function unfavorite(avatarId, avatarName) {
  const favoriteId = favoriteIdMap.get(avatarId);
  if (!favoriteId) {
    logMsg(`⚠ Cannot unfavorite ${avatarName}: favoriteId not found`, "error");
    return;
  }
  if (!confirm(`⚠️ 即将移出收藏夹\n\n「${avatarName}」\n\n此操作不可撤销，确定继续吗？`)) return;
  try {
    logMsg(`Removing ${avatarName} from favorites...`, "info");
    const resp = await apiCall(`/api/vrc/favorites/${favoriteId}`, {
      method: "DELETE",
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(err);
    }
    logMsg(`✓ Removed ${avatarName} from favorites`, "success");
    // Remove from local data
    favoriteIdMap.delete(avatarId);
    avatars = avatars.filter((a) => a.id !== avatarId);
    visibleAvatars = visibleAvatars.filter((a) => a.id !== avatarId);
    selectedIds.delete(avatarId);
    // Update IDB cache to reflect removal
    try { await idb.set("avatars_" + currentCategory, avatars); } catch (_) {}
    
    // Update Modal UI if it's currently showing this avatar
    const modal = document.getElementById("avtrdbDetailModal");
    const favBtn = document.getElementById("avtrdbDetailFavBtn");
    if (modal && !modal.classList.contains("hidden")) {
       const displayedId = document.getElementById("avtrdbDetailId").textContent;
       if (displayedId === avatarId) {
           favBtn.innerHTML = "⭐ 收藏";
           favBtn.className = "btn btn-secondary";
           favBtn.onclick = toggleAvtrdbFavMenu;
           const favList = document.getElementById("avtrdbFavGroupList");
           if (favList && favoriteGroups.length > 0) {
             favList.innerHTML = favoriteGroups.map(g =>
               `<button class="avtrdb-fav-group-btn" onclick="addToFavorite('${escHtml(avatarId)}','${escHtml(g.name)}',this)">${escHtml(g.displayName || g.name)}</button>`
             ).join("");
           }
       }
    }

    // Animate card removal
    const card = document.getElementById("card-" + avatarId);
    if (card) {
      card.style.transform = "scale(0.9)";
      card.style.opacity = "0";
      card.style.transition = "all 0.2s ease";
      setTimeout(() => card.remove(), 200);
    }
    document.getElementById("statTotal").textContent = visibleAvatars.length;
    document.getElementById("statSelected").textContent = selectedIds.size;
  } catch (e) {
    logMsg(`✗ Failed to unfavorite ${avatarName}: ${e.message}`, "error");
  }
}

// ── Batch Unfavorite Selected ──
async function unfavoriteSelected() {
  if (selectedIds.size === 0) {
    logMsg("未选择任何模型 (No avatars selected)", "error");
    return;
  }
  const count = selectedIds.size;
  if (!confirm(`确定要将选中的 ${count} 个模型移出收藏夹吗？\nRemove ${count} selected avatar(s) from favorites?`)) return;

  const ids = [...selectedIds];
  logMsg(`开始批量移除 ${count} 个收藏...`, "info");
  let successCount = 0, failCount = 0;

  for (const avatarId of ids) {
    const fid = favoriteIdMap.get(avatarId);
    if (!fid) { failCount++; continue; }
    try {
      const resp = await apiCall(`/api/vrc/favorites/${fid}`, { method: "DELETE" });
      if (!resp.ok) throw new Error(await resp.text());
      favoriteIdMap.delete(avatarId);
      avatars = avatars.filter((a) => a.id !== avatarId);
      visibleAvatars = visibleAvatars.filter((a) => a.id !== avatarId);
      selectedIds.delete(avatarId);
      const card = document.getElementById("card-" + avatarId);
      if (card) {
        card.style.transform = "scale(0.9)";
        card.style.opacity = "0";
        card.style.transition = "all 0.15s ease";
        setTimeout(() => card.remove(), 150);
      }
      successCount++;
    } catch (e) {
      logMsg(`✗ 移除失败: ${e.message}`, "error");
      failCount++;
    }
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }

  // Update IDB cache
  try { await idb.set("avatars_" + currentCategory, avatars); } catch (_) {}
  document.getElementById("statTotal").textContent = visibleAvatars.length;
  document.getElementById("statSelected").textContent = 0;
  logMsg(`✓ 批量移除完成: 成功 ${successCount}, 失败 ${failCount}`, successCount > 0 ? "success" : "error");
}

async function cleanInvalidFavorites() {
  if (currentCategory === "mine") return;
  // Only flag avatars with empty/missing name or explicitly unavailable/hidden status
  // Do NOT flag avatars just because imageUrl is empty - it may still be loading
  const invalidIds = avatars
    .filter(
      (av) =>
        !av.name ||
        av.releaseStatus === "hidden" ||
        av.releaseStatus === "unavailable",
    )
    .map((av) => av.id);
  if (invalidIds.length === 0) {
    logMsg("未发现失效收藏。 (No invalid models found)", "success");
    return;
  }
  if (
    !confirm(
      `共发现 ${invalidIds.length} 个失效模型。确定要全部移除收藏吗？\nFound ${invalidIds.length} invalid models. Remove them all?`,
    )
  )
    return;

  logMsg(`准备清理 ${invalidIds.length} 个失效模型...`, "info");
  let failCount = 0;

  for (const id of invalidIds) {
    const fid = favoriteIdMap.get(id);
    if (!fid) {
      failCount++;
      continue;
    }
    try {
      await apiCall(`/api/vrc/favorites/${fid}`, { method: "DELETE" });
    } catch (e) {
      failCount++;
    }
    await new Promise(r => setTimeout(r, 200)); // Avoid rate limiting
  }

  logMsg(
    `清理完毕。成功: ${invalidIds.length - failCount}, 失败: ${failCount}`,
    "success",
  );
  // Clear IDB cache so the list reloads fresh from server
  try { await idb.set("avatars_" + currentCategory, []); } catch (_) {}
  fetchAvatars(true); // Force refresh from server
}

// ── Open Local Avatar Detail Modal ──
function openLocalDetail(id) { 
  const av = visibleAvatars.find(a => a.id === id);
  if (av) displayAvatarDetail(av); 
}

function renderAvatars() {
  applyFilters();
}

function toggleSelect(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  const card = document.getElementById("card-" + id);
  if (card) card.classList.toggle("selected", selectedIds.has(id));
  document.getElementById("statSelected").textContent = selectedIds.size;
}

function selectAll() {
  const allSelected = selectedIds.size > 0 && selectedIds.size === visibleAvatars.length;
  selectedIds.clear();
  if (!allSelected) visibleAvatars.forEach((a) => selectedIds.add(a.id));
  // Toggle CSS class on existing cards — DO NOT call renderAvatars() which rebuilds the DOM
  visibleAvatars.forEach((a) => {
    const card = document.getElementById("card-" + a.id);
    if (card) card.classList.toggle("selected", selectedIds.has(a.id));
  });
  document.getElementById("statSelected").textContent = selectedIds.size;
}

// ── Edit & Delete Avatar ──
let currentEditId = null;

function editAvatar(id) {
  const av = avatars.find((a) => a.id === id);
  if (!av) return;
  currentEditId = id;
  document.getElementById("editName").value = av.name || "";
  document.getElementById("editDesc").value = av.description || "";
  document.getElementById("editStatus").value = av.releaseStatus || "private";
  document.getElementById("editTags").value = (av.tags || [])
    .filter((t) => !t.startsWith("author_tag"))
    .join(", ");

  // Show current thumbnail preview
  const thumb = av.thumbnailImageUrl || av.imageUrl || "";
  const preview = document.getElementById("editThumbPreview");
  const note = document.getElementById("editThumbNote");
  const input = document.getElementById("editThumbInput");
  if (preview) {
    preview.src = thumb
      ? `${API_BASE}/api/image?url=${encodeURIComponent(thumb)}&auth=${encodeURIComponent(vrcAuth || "")}`
      : "";
  }
  if (note) note.textContent = "";
  if (input) input.value = ""; // Reset file picker

  document.getElementById("editModal").classList.remove("hidden");
}

// Handle thumbnail file selection — show local preview
function onEditThumbSelected(input) {
  const file = input.files[0];
  if (!file) return;
  const preview = document.getElementById("editThumbPreview");
  const note = document.getElementById("editThumbNote");
  if (preview) preview.src = URL.createObjectURL(file);
  if (note) note.textContent = `✓ ${file.name} (${(file.size / 1024).toFixed(0)} KB) — 保存时上传 / will upload on save`;
}

function closeEditModal() {
  document.getElementById("editModal").classList.add("hidden");
  currentEditId = null;
}

async function saveEditAvatar() {
  if (!currentEditId) return;
  const name = document.getElementById("editName").value.trim();
  if (!name) return alert("Name is required");
  const desc = document.getElementById("editDesc").value.trim();
  const status = document.getElementById("editStatus").value;
  const tagsStr = document.getElementById("editTags").value;
  const tags = tagsStr
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t);

  const btn = document.getElementById("btnSaveEdit");
  const oldText = btn.textContent;
  btn.textContent = "...";
  btn.disabled = true;

  try {
    // Upload new thumbnail if selected
    let newImageUrl = null;
    const thumbInput = document.getElementById("editThumbInput");
    if (thumbInput && thumbInput.files.length > 0) {
      btn.textContent = "图片上传中...";
      logMsg(`🖼️ Uploading new thumbnail for ${name}...`, "info");
      newImageUrl = await uploadImageToVRChat(thumbInput.files[0], name);
    }

    btn.textContent = "保存中...";
    logMsg(`✏️ Updating ${name}...`, "info");
    const payload = {
      name,
      description: desc,
      releaseStatus: status,
      tags,
    };
    if (newImageUrl) payload.imageUrl = newImageUrl;

    const resp = await apiCall(`/api/vrc/avatars/${currentEditId}`, {
      method: "PUT",
      json: payload,
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(err);
    }

    // Update local object
    const updatedAv = await resp.json();
    const idx = avatars.findIndex((a) => a.id === currentEditId);
    if (idx !== -1) avatars[idx] = updatedAv;

    // Update IDB cache
    try { await idb.set("avatars_" + currentCategory, avatars); } catch (_) {}

    // Update the card's name overlay + thumbnail in-place (no full re-render)
    const card = document.getElementById("card-" + currentEditId);
    if (card) {
      const nameOverlay = card.querySelector(".avatar-name-overlay");
      if (nameOverlay) nameOverlay.textContent = updatedAv.name || "";
      if (newImageUrl) {
        const img = card.querySelector(".avatar-thumb");
        if (img) {
          const proxyUrl = `${API_BASE}/api/image?url=${encodeURIComponent(newImageUrl)}&auth=${encodeURIComponent(vrcAuth || "")}`;
          img.classList.remove("failed");
          img.src = proxyUrl;
          loadedImageUrls.add(proxyUrl);
        }
      }
    }
    closeEditModal();
    logMsg(`✓ ${t("editSuccess")} ${name}`, "success");
  } catch (e) {
    logMsg(`✗ ${t("editFail")} ${name} - ${e.message}`, "error");
    alert(e.message);
  } finally {
    btn.textContent = oldText;
    btn.disabled = false;
  }
}

async function deleteAvatar(id, name) {
  if (!confirm(t("confirmDelete") + name)) return;
  try {
    logMsg(`🗑️ Deleting ${name}...`, "info");
    const resp = await apiCall(`/api/vrc/avatars/${id}`, { method: "DELETE" });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(err);
    }
    logMsg(`✓ ${t("deleted")} ${name}`, "success");

    // Remove from all local arrays and selection
    avatars = avatars.filter((a) => a.id !== id);
    visibleAvatars = visibleAvatars.filter((a) => a.id !== id);
    selectedIds.delete(id);

    // Update IDB cache
    try { await idb.set("avatars_" + currentCategory, avatars); } catch (_) {}

    // Remove from DOM with animation
    const card = document.getElementById("card-" + id);
    if (card) {
      card.style.transform = "scale(0.9)";
      card.style.opacity = "0";
      setTimeout(() => card.remove(), 200);
    }

    // Update stats to reflect filtered count
    document.getElementById("statTotal").textContent = visibleAvatars.length;
    document.getElementById("statSelected").textContent = selectedIds.size;
  } catch (e) {
    logMsg(`✗ ${t("deleteFail")} ${name} - ${e.message}`, "error");
  }
}

// ── Save Location Picker ──
async function pickSaveDir() {
  if (!("showDirectoryPicker" in window)) {
    logMsg(t("dirNotSupported"), "error");
    return;
  }
  try {
    saveDirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    const dirLabel = document.getElementById("saveDirLabel");
    if (dirLabel) {
      dirLabel.textContent = t("dirSelected") + saveDirHandle.name;
      dirLabel.style.display = "block";
    }
    const clearBtn = document.getElementById("clearDirBtn");
    if (clearBtn) clearBtn.style.display = "block";
    logMsg(t("dirSelected") + saveDirHandle.name, "success");
  } catch (e) {
    if (e.name !== "AbortError") logMsg("Error: " + e.message, "error");
  }
}

function clearSaveDir() {
  saveDirHandle = null;
  const dirLabel = document.getElementById("saveDirLabel");
  if (dirLabel) {
    dirLabel.textContent = "";
    dirLabel.style.display = "none";
  }
  const clearBtn = document.getElementById("clearDirBtn");
  if (clearBtn) clearBtn.style.display = "none";
  logMsg(t("dirCleared"), "info");
}

// ── Download ──
async function downloadSelected() {
  if (selectedIds.size === 0) {
    logMsg("No avatars selected", "error");
    return;
  }
  // Use visibleAvatars so we download what's actually selected in the current filtered view
  const toDownload = visibleAvatars.filter((a) => selectedIds.has(a.id));

  // Verify directory permission is still valid
  if (saveDirHandle) {
    try {
      const perm = await saveDirHandle.queryPermission({ mode: "readwrite" });
      if (perm !== "granted") {
        const req = await saveDirHandle.requestPermission({
          mode: "readwrite",
        });
        if (req !== "granted") {
          saveDirHandle = null;
          logMsg("Directory permission denied, using browser default", "info");
        }
      }
    } catch {
      saveDirHandle = null;
    }
  }

  // Start concurrent download queue
  const CONCURRENT_DOWNLOADS = 4;
  let queue = [...toDownload];
  let activeCount = 0;

  logMsg(
    `Started downloading ${toDownload.length} avatars (${CONCURRENT_DOWNLOADS} concurrent)...`,
    "info",
  );

  return new Promise((resolve) => {
    function next() {
      if (queue.length === 0 && activeCount === 0) {
        logMsg("All downloads finished.", "success");
        resolve();
        return;
      }
      while (activeCount < CONCURRENT_DOWNLOADS && queue.length > 0) {
        const av = queue.shift();
        activeCount++;
        downloadSingleAvatar(av).finally(() => {
          activeCount--;
          next();
        });
      }
    }
    next();
  });
}

async function downloadSingleAvatar(av) {
  const card = document.getElementById("card-" + av.id);
  if (card) card.classList.add("downloading");

  // Collect all candidate URLs (prefer no-variant first, then security, skip impostor)
  const candidateUrls = [];
  for (const pkg of av.unityPackages || []) {
    if (
      (pkg.platform === "standalonewindows" || pkg.platform === "pc") &&
      pkg.assetUrl
    ) {
      if (pkg.variant && pkg.variant.includes("impostor")) continue;
      if (!pkg.variant || pkg.variant === "") {
        candidateUrls.unshift(pkg.assetUrl); // top priority
      } else {
        candidateUrls.push(pkg.assetUrl);
      }
    }
  }

  if (candidateUrls.length === 0) {
    logMsg(`⚠ ${av.name}: No PC asset URL found`, "skip");
    if (card) {
      card.classList.remove("downloading");
      card.classList.add("skipped");
    }
    return;
  }

  const safeName = av.name.replace(/[\\/*?:"<>|]/g, "_");
  const filename = `${safeName}_${av.id}.vrca`;

  try {
    logMsg(`⬇ ${t("downloading")} ${av.name}...`, "info");

    if (saveDirHandle) {
      // Check if file already exists → skip
      try {
        await saveDirHandle.getFileHandle(filename, { create: false });
        logMsg(`⏭ ${av.name}: Already exists, skipped`, "skip");
        if (card) {
          card.classList.remove("downloading");
          card.classList.add("success");
        }
        return;
      } catch {
        /* file doesn't exist, proceed with download */
      }

      // ── File System Access API: try each candidate URL ──
      let downloaded = false;
      for (let urlIdx = 0; urlIdx < candidateUrls.length; urlIdx++) {
        const proxyUrl = `${API_BASE}/api/download?url=${encodeURIComponent(candidateUrls[urlIdx])}&filename=${encodeURIComponent(filename)}&auth=${encodeURIComponent(vrcAuth)}`;
        try {
          const resp = await fetch(proxyUrl);
          if (!resp.ok) {
            const errText = await resp
              .text()
              .catch(() => `HTTP ${resp.status}`);
            if (urlIdx < candidateUrls.length - 1) {
              logMsg(
                `  ↳ URL ${urlIdx + 1}/${candidateUrls.length} failed (${resp.status}), trying next...`,
                "info",
              );
              continue;
            }
            throw new Error(
              `Server error ${resp.status}: ${errText.substring(0, 200)}`,
            );
          }
          const ct = resp.headers.get("Content-Type") || "";
          if (ct.includes("text/html") || ct.includes("application/json")) {
            const body = await resp.text();
            if (urlIdx < candidateUrls.length - 1) {
              logMsg(
                `  ↳ URL ${urlIdx + 1}/${candidateUrls.length} returned error page, trying next...`,
                "info",
              );
              continue;
            }
            throw new Error(
              "Got error page instead of file: " + body.substring(0, 200),
            );
          }
          const blob = await resp.blob();
          if (blob.size < 10240) {
            if (urlIdx < candidateUrls.length - 1) {
              logMsg(
                `  ↳ URL ${urlIdx + 1}/${candidateUrls.length} too small (${blob.size}B), trying next...`,
                "info",
              );
              continue;
            }
            throw new Error(
              `File too small (${blob.size} bytes), likely an error response`,
            );
          }
          const fileHandle = await saveDirHandle.getFileHandle(filename, {
            create: true,
          });
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
          logMsg(
            `✓ ${av.name}: Saved → ${saveDirHandle.name}/${filename} (${(blob.size / 1048576).toFixed(1)} MB)`,
            "success",
          );
          downloaded = true;
          if (card) {
            card.classList.remove("downloading");
            card.classList.add("success");
          }
          break;
        } catch (e) {
          if (urlIdx < candidateUrls.length - 1) {
            logMsg(
              `  ↳ URL ${urlIdx + 1}/${candidateUrls.length} failed: ${e.message}, trying next...`,
              "info",
            );
            continue;
          }
          throw e;
        }
      }
      if (!downloaded) throw new Error("All candidate URLs failed");
    } else {
      // ── Fallback: browser native <a> download (uses first URL) ──
      const proxyUrl = `${API_BASE}/api/download?url=${encodeURIComponent(candidateUrls[0])}&filename=${encodeURIComponent(filename)}&auth=${encodeURIComponent(vrcAuth)}`;
      const a = document.createElement("a");
      a.href = proxyUrl;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      logMsg(`✓ ${av.name}: Download started → ${filename}`, "success");
      if (card) {
        card.classList.remove("downloading");
        card.classList.add("success");
      }
    }
  } catch (e) {
    logMsg(`✗ ${av.name}: ${e.message}`, "error");
    if (card) {
      card.classList.remove("downloading");
      card.classList.add("skipped");
    }
  }
}

// ── Console ──
function logMsg(msg, type = "info") {
  const el = document.getElementById("logConsole");
  const span = document.createElement("div");
  span.className = `log-${type}`;
  span.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
  // Limit to 500 entries to prevent DOM bloat
  while (el.children.length > 500) el.removeChild(el.firstChild);
}

// ── Upload Mode Toggle ──
document.querySelectorAll('input[name="uploadMode"]').forEach((r) => {
  r.addEventListener("change", function () {
    document
      .getElementById("newFields")
      .classList.toggle("hidden", this.value !== "new");
    document
      .getElementById("updateFields")
      .classList.toggle("hidden", this.value !== "update");
  });
});

// ── File Selection / Drag ──
const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");

if (dropZone) {
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () =>
    dropZone.classList.remove("dragover"),
  );
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    addFiles(
      Array.from(e.dataTransfer.files).filter((f) => f.name.endsWith(".vrca")),
    );
  });
}
if (fileInput) {
  fileInput.addEventListener("change", () => {
    addFiles(Array.from(fileInput.files));
    fileInput.value = "";
  });
}

function addFiles(files) {
  files.forEach((f) => {
    if (!uploadFiles.some((u) => u.name === f.name)) uploadFiles.push(f);
  });
  renderFileList();
  document.getElementById("btnUpload").disabled = uploadFiles.length === 0;
}

function renderFileList() {
  const container = document.getElementById("file-list-container");
  const list = document.getElementById("file-list");
  if (uploadFiles.length === 0) {
    container.classList.add("hidden");
    return;
  }
  container.classList.remove("hidden");
  list.innerHTML = uploadFiles
    .map(
      (f, i) => `
        <div class="file-list-item" id="upload-item-${i}">
            <span class="file-name">${escHtml(f.name)}</span>
            <span class="file-size">${(f.size / 1048576).toFixed(1)} MB</span>
            <span class="file-status" id="upload-status-${i}"></span>
            <button class="file-remove" onclick="removeFile(${i})">×</button>
        </div>
    `,
    )
    .join("");
}

function removeFile(i) {
  uploadFiles.splice(i, 1);
  renderFileList();
  document.getElementById("btnUpload").disabled = uploadFiles.length === 0;
}

// (proxy input removed — CF Workers version uploads via /api/s3proxy)

// ── MD5 (using SubtleCrypto isn't available for MD5, use simple implementation) ──
function md5(buffer) {
  // Simple MD5 implementation for ArrayBuffer → base64
  const bytes = new Uint8Array(buffer);
  // Using SparkMD5-like approach inline
  return sparkMD5ArrayBuffer(bytes);
}

// Minimal MD5 for ArrayBuffer (adapted from SparkMD5)
function sparkMD5ArrayBuffer(uint8) {
  function md5cycle(x, k) {
    let a = x[0],
      b = x[1],
      c = x[2],
      d = x[3];
    a = ff(a, b, c, d, k[0], 7, -680876936);
    d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);
    b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);
    d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341);
    b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);
    d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);
    b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682);
    d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290);
    b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510);
    d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);
    b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);
    d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335);
    b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);
    d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);
    b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467);
    d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);
    b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558);
    d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562);
    b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);
    d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);
    b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);
    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);
    b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);
    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);
    b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844);
    d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905);
    b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);
    d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);
    b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359);
    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);
    b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);
    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);
    b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]);
    x[1] = add32(b, x[1]);
    x[2] = add32(c, x[2]);
    x[3] = add32(d, x[3]);
  }
  function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t));
    return add32((a << s) | (a >>> (32 - s)), b);
  }
  function ff(a, b, c, d, x, s, t) {
    return cmn((b & c) | (~b & d), a, b, x, s, t);
  }
  function gg(a, b, c, d, x, s, t) {
    return cmn((b & d) | (c & ~d), a, b, x, s, t);
  }
  function hh(a, b, c, d, x, s, t) {
    return cmn(b ^ c ^ d, a, b, x, s, t);
  }
  function ii(a, b, c, d, x, s, t) {
    return cmn(c ^ (b | ~d), a, b, x, s, t);
  }
  function add32(a, b) {
    return (a + b) & 0xffffffff;
  }

  const n = uint8.length;
  let state = [1732584193, -271733879, -1732584194, 271733878];
  let i;
  for (i = 64; i <= n; i += 64) {
    const words = new Int32Array(uint8.buffer, uint8.byteOffset + i - 64, 16);
    md5cycle(state, words);
  }
  const tail = new Uint8Array(64);
  const remaining = n - (i - 64);
  for (let j = 0; j < remaining; j++) tail[j] = uint8[i - 64 + j];
  tail[remaining] = 0x80;
  if (remaining > 55) {
    md5cycle(state, new Int32Array(tail.buffer, 0, 16));
    tail.fill(0);
  }
  const bits = new DataView(tail.buffer);
  bits.setUint32(56, (n * 8) >>> 0, true);
  bits.setUint32(60, Math.floor(n / 0x20000000) & 0xffffffff, true);
  md5cycle(state, new Int32Array(tail.buffer, 0, 16));

  const result = new Uint8Array(16);
  for (let j = 0; j < 4; j++) {
    result[j * 4] = state[j] & 0xff;
    result[j * 4 + 1] = (state[j] >> 8) & 0xff;
    result[j * 4 + 2] = (state[j] >> 16) & 0xff;
    result[j * 4 + 3] = (state[j] >> 24) & 0xff;
  }
  return btoa(String.fromCharCode(...result));
}

// ── Gzip Compress ──
async function gzipCompress(data) {
  if (typeof CompressionStream !== "undefined") {
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    writer.write(data);
    writer.close();
    const chunks = [];
    const reader = cs.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    let totalLen = chunks.reduce((s, c) => s + c.length, 0);
    let result = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
  // Fallback: return as-is (no compression)
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

// ── Rsync Signature (BLAKE2 format) ──
async function computeRsyncSignature(fileData) {
  const blockSize = 2048;
  const strongSumLen = 32;
  const headerSize = 12;
  const numBlocks = Math.ceil(fileData.length / blockSize);
  const sigSize = headerSize + numBlocks * (4 + strongSumLen);
  const sig = new Uint8Array(sigSize);
  const view = new DataView(sig.buffer);

  // Header: magic(BLAKE2), block_size, strong_sum_len
  view.setUint32(0, 0x72730137);
  view.setUint32(4, blockSize);
  view.setUint32(8, strongSumLen);

  let offset = headerSize;
  for (let i = 0; i < fileData.length; i += blockSize) {
    const block = fileData.subarray(
      i,
      Math.min(i + blockSize, fileData.length),
    );

    // Weak checksum (adler32-like, matching Python implementation)
    let s1 = 0,
      s2 = 0;
    for (let j = 0; j < block.length; j++) {
      s1 = (s1 + block[j] + 31) % 65536;
      s2 = (s2 + s1) % 65536;
    }
    const weak = ((s2 & 0xffff) << 16) | (s1 & 0xffff);
    view.setUint32(offset, weak);
    offset += 4;

    // Strong checksum (BLAKE2b-256) — use SubtleCrypto SHA-256 as fallback
    // Note: SubtleCrypto doesn't have BLAKE2, so we match the Python BLAKE2 output
    // For VRChat compatibility, we need actual BLAKE2b
    const hash = await blake2b256(block);
    sig.set(hash, offset);
    offset += strongSumLen;
  }
  return sig.subarray(0, offset);
}

// Minimal BLAKE2b-256 implementation
async function blake2b256(data) {
  // BLAKE2b constants
  const IV = new BigUint64Array([
    0x6a09e667f3bcc908n,
    0xbb67ae8584caa73bn,
    0x3c6ef372fe94f82bn,
    0xa54ff53a5f1d36f1n,
    0x510e527fade682d1n,
    0x9b05688c2b3e6c1fn,
    0x1f83d9abfb41bd6bn,
    0x5be0cd19137e2179n,
  ]);
  const SIGMA = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  ];

  const outLen = 32;
  let h = new BigUint64Array(IV);
  h[0] ^= BigInt(0x01010000 ^ outLen);

  const blockSize = 128;
  let t = 0n;
  const pad = new Uint8Array(blockSize);

  function G(v, a, b, c, d, x, y) {
    v[a] = v[a] + v[b] + x;
    v[d] = rotr64(v[d] ^ v[a], 32n);
    v[c] = v[c] + v[d];
    v[b] = rotr64(v[b] ^ v[c], 24n);
    v[a] = v[a] + v[b] + y;
    v[d] = rotr64(v[d] ^ v[a], 16n);
    v[c] = v[c] + v[d];
    v[b] = rotr64(v[b] ^ v[c], 63n);
  }
  function rotr64(x, n) {
    return ((x >> n) | (x << (64n - n))) & 0xffffffffffffffffn;
  }

  function compress(block, t, last) {
    const m = new BigUint64Array(16);
    const dv = new DataView(block.buffer, block.byteOffset, blockSize);
    for (let i = 0; i < 16; i++) m[i] = dv.getBigUint64(i * 8, true);

    const v = new BigUint64Array(16);
    for (let i = 0; i < 8; i++) {
      v[i] = h[i];
      v[i + 8] = IV[i];
    }
    v[12] ^= t & 0xffffffffffffffffn;
    v[13] ^= (t >> 64n) & 0xffffffffffffffffn;
    if (last) v[14] ^= 0xffffffffffffffffn;

    for (let round = 0; round < 12; round++) {
      const s = SIGMA[round % 10];
      G(v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
      G(v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
      G(v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
      G(v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
      G(v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
      G(v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
      G(v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
      G(v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
  }

  let pos = 0;
  while (pos + blockSize <= data.length) {
    if (pos + blockSize < data.length) {
      t += BigInt(blockSize);
      compress(data.subarray(pos, pos + blockSize), t, false);
      pos += blockSize;
    } else {
      // Exact multiple: this is the final full block
      t += BigInt(blockSize);
      compress(data.subarray(pos, pos + blockSize), t, true);
      pos += blockSize;
      // Return early — no partial block needed
      const out = new Uint8Array(outLen);
      const outView = new DataView(out.buffer);
      for (let i = 0; i < 4; i++) outView.setBigUint64(i * 8, h[i], true);
      return out;
    }
  }

  // Final block
  pad.fill(0);
  const remaining = data.length - pos;
  for (let i = 0; i < remaining; i++) pad[i] = data[pos + i];
  t += BigInt(remaining);
  compress(pad, t, true);

  const out = new Uint8Array(outLen);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) outView.setBigUint64(i * 8, h[i], true);
  return out;
}

// ── Upload Logic ──
function setUploadStatus(msg, type = "") {
  const el = document.getElementById("upload-status");
  el.textContent = msg;
  el.className = "upload-status" + (type ? " " + type : "");
}

function setProgress(pct, text) {
  const container = document.getElementById("upload-progress");
  const fill = document.getElementById("upload-progress-fill");
  const txt = document.getElementById("upload-progress-text");
  container.classList.toggle("active", pct >= 0);
  fill.style.width = pct + "%";
  if (text) txt.textContent = text;
}

// ── Resize image to 1200x900 (4:3) using Canvas ──
async function resizeImageTo4x3(file) {
  const TARGET_W = 1200,
    TARGET_H = 900;
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objUrl);
      const canvas = document.createElement("canvas");
      canvas.width = TARGET_W;
      canvas.height = TARGET_H;
      const ctx = canvas.getContext("2d");

      // Fill black background, then draw image centered/cropped to 4:3
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, TARGET_W, TARGET_H);

      // Calculate crop: cover the 4:3 area
      const srcRatio = img.width / img.height;
      const dstRatio = TARGET_W / TARGET_H;
      let sx = 0,
        sy = 0,
        sw = img.width,
        sh = img.height;
      if (srcRatio > dstRatio) {
        // Source is wider — crop sides
        sw = img.height * dstRatio;
        sx = (img.width - sw) / 2;
      } else {
        // Source is taller — crop top/bottom
        sh = img.width / dstRatio;
        sy = (img.height - sh) / 2;
      }

      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, TARGET_W, TARGET_H);

      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error("Canvas toBlob failed"));
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)));
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(objUrl);
      reject(new Error("Failed to load image"));
    };
    img.src = objUrl;
  });
}

// ── Upload Image to VRChat File API ──
// Resizes to 1200x900 (4:3), uploads via File API, returns VRChat file URL
async function uploadImageToVRChat(file, namePrefix) {
  logMsg("Resizing image to 1200x900 (4:3)...", "info");
  const fileData = await resizeImageTo4x3(file);
  logMsg(`Image resized: ${fileData.length} bytes`, "info");

  if (fileData.length > 10 * 1024 * 1024)
    throw new Error("Image too large after resize (max 10MB).");
  const fileMd5 = md5(fileData);

  // 1. Create file record
  const rFile = await apiCall("/api/vrc/file", {
    method: "POST",
    json: {
      name: namePrefix + " Image",
      mimeType: "image/png",
      extension: "png",
      tags: [],
    },
  });
  if (!rFile.ok)
    throw new Error("Failed to create image file: " + (await rFile.text()));
  const imgFileId = (await rFile.json()).id;

  // 2. Create version
  const rVer = await apiCall(`/api/vrc/file/${imgFileId}`, {
    method: "POST",
    json: {
      signatureMd5: "",
      signatureSizeInBytes: 0,
      fileMd5,
      fileSizeInBytes: fileData.length,
    },
  });
  if (!rVer.ok)
    throw new Error("Failed to create image version: " + (await rVer.text()));
  const imgVersionId = (await rVer.json()).versions?.slice(-1)[0]?.version ?? 1;

  // 3. Start file upload (Simple Mode)
  const rPartStart = await apiCall(
    `/api/vrc/file/${imgFileId}/${imgVersionId}/file/start?partNumber=1`,
    { method: "PUT" },
  );
  if (!rPartStart.ok)
    throw new Error("Image start failed: " + (await rPartStart.text()));
  const partUrl = (await rPartStart.json()).url;

  // 4. Upload to S3 via proxy
  const rPartPut = await fetch(`${API_BASE}/api/s3proxy`, {
    method: "PUT",
    body: fileData,
    headers: {
      "X-S3-Url": partUrl,
      "X-VRC-Auth": vrcAuth,
      "X-S3-content-md5": fileMd5,
    },
  });
  if (!rPartPut.ok)
    throw new Error("Image S3 upload failed: " + (await rPartPut.text()));

  // 5. Finish upload (Simple mode: no etags)
  const rFinish = await apiCall(
    `/api/vrc/file/${imgFileId}/${imgVersionId}/file/finish`,
    {
      method: "PUT",
      json: { nextPartNumber: "0", maxParts: "0" },
    },
  );
  if (!rFinish.ok)
    throw new Error("Image finalize failed: " + (await rFinish.text()));

  // 6. Poll for completion (images are usually fast)
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    const rStatus = await apiCall(`/api/vrc/file/${imgFileId}`);
    if (rStatus.ok) {
      const ver = ((await rStatus.json()).versions || []).find(
        (v) => v.version === parseInt(imgVersionId),
      );
      if (ver && ver.status === "complete") {
        const url = `https://api.vrchat.cloud/api/1/file/${imgFileId}/${imgVersionId}/file`;
        logMsg(`Image uploaded: ${url}`, "success");
        return url;
      }
    }
  }
  throw new Error("Image processing timed out.");
}

// ── Patch Blueprint ID in .vrca AssetBundle ──
// VRChat embeds the avatar's Blueprint ID (avtr_xxx) inside the .vrca file via VRCPipelineManager.
// Security check fails if the embedded ID doesn't belong to the uploading user.
// This function finds and replaces all avtr_ UUIDs in the binary data.
function patchBlueprintId(vrcaBytes, newAvatarId) {
  // avtr_ + UUID = 41 bytes: "avtr_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  const AVTR_PREFIX = [0x61, 0x76, 0x74, 0x72, 0x5f]; // "avtr_"
  const AVTR_LEN = 41; // avtr_ (5) + UUID (36)
  const newIdBytes = new TextEncoder().encode(newAvatarId);
  if (newIdBytes.length !== AVTR_LEN) {
    logMsg(
      `Warning: new avatar ID length ${newIdBytes.length} != expected ${AVTR_LEN}`,
      "error",
    );
  }

  let patchCount = 0;
  const data = new Uint8Array(vrcaBytes); // work on a copy

  for (let i = 0; i < data.length - AVTR_LEN; i++) {
    // Check for "avtr_" prefix
    if (
      data[i] === 0x61 &&
      data[i + 1] === 0x76 &&
      data[i + 2] === 0x74 &&
      data[i + 3] === 0x72 &&
      data[i + 4] === 0x5f
    ) {
      // Verify this looks like a UUID: avtr_ + 8-4-4-4-12 hex pattern
      const candidate = new TextDecoder().decode(
        data.subarray(i, i + AVTR_LEN),
      );
      if (
        /^avtr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          candidate,
        )
      ) {
        const oldId = candidate;
        // Replace with new ID
        for (let j = 0; j < newIdBytes.length; j++) {
          data[i + j] = newIdBytes[j];
        }
        patchCount++;
        logMsg(`Patched BlueprintId: ${oldId} → ${newAvatarId}`, "info");
      }
    }
  }

  logMsg(
    `Patched ${patchCount} BlueprintId occurrence(s)`,
    patchCount > 0 ? "success" : "error",
  );
  return data;
}

async function startUpload() {
  if (uploadFiles.length === 0) return;
  const btn = document.getElementById("btnUpload");
  btn.disabled = true;
  const isNew = document.getElementById("modeNew").checked;

  setUploadStatus(t("uploading"));
  setProgress(0, "");

  for (let idx = 0; idx < uploadFiles.length; idx++) {
    const file = uploadFiles[idx];
    const itemEl = document.getElementById("upload-item-" + idx);
    const statusEl = document.getElementById("upload-status-" + idx);
    if (itemEl) itemEl.classList.add("uploading");
    if (statusEl) statusEl.textContent = "⏳";

    try {
      setUploadStatus(`Processing ${file.name}...`);
      let fileData = new Uint8Array(await file.arrayBuffer());

      // 1. Use raw file data directly (no gzip — VRChat security scanner needs raw AssetBundle)
      // NOTE: rawData and sigBytes/sigMd5 may be reassigned in update mode after patching
      let rawData = fileData;
      const fileMd5 = md5(rawData);
      logMsg(
        `File: ${rawData.length} bytes, MD5: ${fileMd5.substring(0, 16)}...`,
        "info",
      );

      // 2. Compute rsync signature (based on raw data)
      setProgress(10, "Computing signature...");
      let sigBytes = await computeRsyncSignature(rawData);
      let sigMd5 = md5(sigBytes);

      // 3. Create file & version via Worker proxy
      setProgress(15, "Creating file version...");
      let fileId, versionId;

      if (isNew) {
        let name =
          uploadFiles.length === 1
            ? document.getElementById("avatarName").value.trim()
            : "";
        if (!name) name = file.name.replace(/\.vrca$/i, "");

        // Create file record
        const rFile = await apiCall("/api/vrc/file", {
          method: "POST",
          json: {
            name,
            mimeType: "application/x-avatar",
            extension: "vrca",
            tags: [],
          },
        });
        if (!rFile.ok)
          throw new Error("Failed to create file: " + (await rFile.text()));
        const fileData2 = await rFile.json();
        fileId = fileData2.id;

        // Create version
        const rVer = await apiCall(`/api/vrc/file/${fileId}`, {
          method: "POST",
          json: {
            signatureMd5: sigMd5,
            signatureSizeInBytes: sigBytes.length,
            fileMd5: fileMd5,
            fileSizeInBytes: rawData.length,
          },
        });
        if (!rVer.ok)
          throw new Error("Failed to create version: " + (await rVer.text()));
        const verData = await rVer.json();
        versionId = verData.versions[verData.versions.length - 1].version;
      } else {
        const selAvatarId = document.getElementById("avatarSelect").value;
        if (!selAvatarId) throw new Error("No avatar selected");

        // Patch BlueprintId in .vrca to match the target avatar
        fileData = patchBlueprintId(fileData, selAvatarId);
        // Recalculate MD5 and signature after patching
        const patchedMd5 = md5(fileData);
        const patchedSig = await computeRsyncSignature(fileData);
        const patchedSigMd5 = md5(patchedSig);

        // Point rawData to the patched bytes so the upload loop sends patched data
        rawData = fileData;

        // Get avatar info to find file ID
        const rAv = await apiCall(`/api/vrc/avatars/${selAvatarId}`);
        const avData = await rAv.json();
        for (const pkg of avData.unityPackages || []) {
          if (["standalonewindows", "pc"].includes(pkg.platform)) {
            const m = (pkg.assetUrl || "").match(/file\/(file_[a-f0-9-]+)\//);
            if (m) {
              fileId = m[1];
              break;
            }
          }
        }
        if (!fileId) throw new Error("Could not find file ID");

        const rVer = await apiCall(`/api/vrc/file/${fileId}`, {
          method: "POST",
          json: {
            signatureMd5: patchedSigMd5,
            signatureSizeInBytes: patchedSig.length,
            fileMd5: patchedMd5,
            fileSizeInBytes: fileData.length,
          },
        });
        if (!rVer.ok)
          throw new Error("Failed to create version: " + (await rVer.text()));
        const verData = await rVer.json();
        versionId = verData.versions[verData.versions.length - 1].version;

        // Store patched sig info so signature upload below uses correct values
        sigBytes = patchedSig;
        sigMd5 = patchedSigMd5;
      }

      // 4. Upload signature via Worker proxy (avoids S3 CORS)
      setProgress(20, "Uploading signature...");
      const rSigStart = await apiCall(
        `/api/vrc/file/${fileId}/${versionId}/signature/start`,
        { method: "PUT" },
      );
      if (!rSigStart.ok)
        throw new Error(
          "Failed to start sig upload: " + (await rSigStart.text()),
        );
      const sigUrl = (await rSigStart.json()).url;

      // Proxy S3 PUT through Worker to bypass CORS
      const rSigPut = await fetch(`${API_BASE}/api/s3proxy`, {
        method: "PUT",
        body: sigBytes,
        headers: {
          "X-S3-Url": sigUrl,
          "X-S3-content-md5": sigMd5,
          "X-S3-content-type": "application/x-rsync-signature",
          "X-VRC-Auth": vrcAuth,
        },
      });
      if (!rSigPut.ok) {
        const errText = await rSigPut.text();
        throw new Error(
          "Signature S3 upload failed: " + errText.substring(0, 200),
        );
      }

      // Finish signature
      const rSigFinish = await apiCall(
        `/api/vrc/file/${fileId}/${versionId}/signature/finish`,
        {
          method: "PUT",
          json: { nextPartNumber: "0", maxParts: "0" },
        },
      );
      if (!rSigFinish.ok) {
        // Retry with empty etags
        const retry = await apiCall(
          `/api/vrc/file/${fileId}/${versionId}/signature/finish`,
          {
            method: "PUT",
            json: { etags: [], nextPartNumber: "0", maxParts: "0" },
          },
        );
        if (!retry.ok)
          throw new Error(
            "Failed to finalize signature: " + (await retry.text()),
          );
      }

      // 5. Upload file (multipart, 10MB chunks) — DIRECT TO S3!
      setProgress(25, "Uploading file...");
      const CHUNK_SIZE = 10 * 1024 * 1024;
      const totalParts = Math.ceil(rawData.length / CHUNK_SIZE);
      const etags = [];

      for (let partNum = 1; partNum <= totalParts; partNum++) {
        const pOffset = (partNum - 1) * CHUNK_SIZE;
        const chunk = rawData.subarray(
          pOffset,
          Math.min(pOffset + CHUNK_SIZE, rawData.length),
        );

        const rPartStart = await apiCall(
          `/api/vrc/file/${fileId}/${versionId}/file/start?partNumber=${partNum}`,
          { method: "PUT" },
        );
        if (!rPartStart.ok)
          throw new Error(
            `Part ${partNum} start failed: ` + (await rPartStart.text()),
          );
        const partUrl = (await rPartStart.json()).url;

        // Proxy S3 PUT through Worker (no direct S3 CORS needed)
        const pctBefore = 25 + ((partNum - 1) / totalParts) * 70;
        const pctAfter = 25 + (partNum / totalParts) * 70;
        const uploadedBefore = pOffset / 1048576;
        const totalMB = rawData.length / 1048576;
        setProgress(
          pctBefore,
          `Part ${partNum}/${totalParts}: ${uploadedBefore.toFixed(1)}/${totalMB.toFixed(1)} MB`,
        );

        // Calculate Content-MD5 for this chunk (S3 requires it per X-Amz-SignedHeaders)
        const chunkMd5 = md5(chunk);

        const rPartPut = await fetch(`${API_BASE}/api/s3proxy`, {
          method: "PUT",
          body: chunk,
          headers: {
            "X-S3-Url": partUrl,
            "X-VRC-Auth": vrcAuth,
            "X-S3-content-md5": chunkMd5,
          },
        });
        if (!rPartPut.ok) {
          const errText = await rPartPut.text();
          throw new Error(
            `S3 part ${partNum} failed: ` + errText.substring(0, 200),
          );
        }
        const partJson = await rPartPut.json();
        if (partJson.etag) etags.push(partJson.etag);

        setProgress(
          pctAfter,
          `Part ${partNum}/${totalParts}: ${((pOffset + chunk.length) / 1048576).toFixed(1)}/${totalMB.toFixed(1)} MB`,
        );
      }

      // 6. Finish file upload
      // CRITICAL: Only include etags for multipart uploads (totalParts > 1).
      // For simple uploads (1 part), VRChat uses S3 PutObject (not multipart).
      // Sending etags triggers CompleteMultipartUpload which fails with 500 since
      // there's no multipart session (uploadId is empty, category is "simple").
      setProgress(95, "Finalizing...");
      const finishBody = { nextPartNumber: "0", maxParts: "0" };
      if (totalParts > 1) finishBody.etags = etags;
      const rFileFinish = await apiCall(
        `/api/vrc/file/${fileId}/${versionId}/file/finish`,
        {
          method: "PUT",
          json: finishBody,
        },
      );
      if (!rFileFinish.ok)
        throw new Error(
          "Failed to finalize file: " + (await rFileFinish.text()),
        );

      // 7. Wait for file status to become 'complete' before creating avatar
      // NOTE: GET /file/{fileId}/{versionId} returns 302 redirect (download URL), NOT status!
      // Must use GET /file/{fileId} which returns all versions with their status.
      setProgress(97, "Waiting for file to be processed...");
      let fileReady = false;
      const maxAttempts = 60; // 60 × 5s = 5 minutes max
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise((r) => setTimeout(r, 5000));
        const rStatus = await apiCall(`/api/vrc/file/${fileId}`);
        if (rStatus.ok) {
          const fileObj = await rStatus.json();
          // Find our version in the versions array
          const ver = (fileObj.versions || []).find(
            (v) => v.version === parseInt(versionId),
          );
          const status = ver ? ver.status : "unknown";
          const elapsed = (attempt + 1) * 5;
          logMsg(
            `Attempt ${attempt + 1}/${maxAttempts} (${elapsed}s) — status: ${status}`,
            "info",
          );
          if (status === "complete") {
            fileReady = true;
            break;
          }
          if (status === "error") {
            throw new Error(`File processing failed with status: error`);
          }
        } else {
          logMsg(
            `Attempt ${attempt + 1}/${maxAttempts} — poll failed (${rStatus.status})`,
            "info",
          );
        }
      }
      if (!fileReady)
        throw new Error(
          "File not ready after 5 minutes. It may still be processing — wait and try Update mode.",
        );

      // 8. Create avatar
      if (isNew && fileId) {
        setProgress(98, "Creating avatar record...");
        let name =
          uploadFiles.length === 1
            ? document.getElementById("avatarName").value.trim()
            : "";
        if (!name) name = file.name.replace(/\.vrca$/i, "");

        // Upload thumbnail image if selected
        let finalImageUrl = "";
        const imgInput = document.getElementById("avatarImage");
        if (imgInput && imgInput.files.length > 0) {
          try {
            finalImageUrl = await uploadImageToVRChat(
              imgInput.files[0],
              name || "Avatar",
            );
          } catch (err) {
            logMsg("Failed to upload thumbnail: " + err.message, "error");
          }
        }
        if (!finalImageUrl) {
          for (const av of avatars) {
            if (av.imageUrl) {
              finalImageUrl = av.imageUrl;
              break;
            }
            if (av.thumbnailImageUrl) {
              finalImageUrl = av.thumbnailImageUrl;
              break;
            }
          }
        }
        if (!finalImageUrl)
          finalImageUrl = `https://api.vrchat.cloud/api/1/file/${fileId}/${versionId}/file`;

        const rAvatar = await apiCall("/api/vrc/avatars", {
          method: "POST",
          json: {
            name,
            assetUrl: `https://api.vrchat.cloud/api/1/file/${fileId}/${versionId}/file`,
            imageUrl: finalImageUrl,
            releaseStatus: "private",
            unityPackageUrl: "",
            unityVersion: "2022.3.22f1",
            platform: "standalonewindows",
            description: "Uploaded via VRCW",
            tags: [],
          },
        });
        if (!rAvatar.ok)
          throw new Error("Failed to create avatar: " + (await rAvatar.text()));
        logMsg(`Avatar created: ${(await rAvatar.json()).id}`, "success");
      }

      setProgress(100, "Done!");
      if (statusEl) statusEl.textContent = "✓";
      if (itemEl) {
        itemEl.classList.remove("uploading");
        itemEl.classList.add("done");
      }
      setUploadStatus(t("uploadOk"), "success");
    } catch (e) {
      if (statusEl) statusEl.textContent = "✗";
      if (itemEl) {
        itemEl.classList.remove("uploading");
        itemEl.classList.add("error");
      }
      setUploadStatus(t("uploadFail") + e.message, "error");
    }
  }
  btn.disabled = false;
}

// ── avtrDB Public Avatar Search ──
// ── Custom Glass Select Managers ──
function toggleGlassSelect(e, el) {
  e.stopPropagation();
  // Close others
  document.querySelectorAll('.glass-select').forEach(s => {
    if (s !== el) s.classList.remove('active');
  });
  el.classList.toggle('active');
}

function selectGlassOption(e, el, val, callbackName) {
  e.stopPropagation();
  const select = el.closest('.glass-select');
  const input = select.querySelector('input[type="hidden"]');
  const label = select.querySelector('.selected-label');
  
  // Update state
  input.value = val;
  label.textContent = el.textContent;
  
  // Handle translation attribute if present
  const i18nKey = el.getAttribute('data-i18n');
  if (i18nKey) {
    label.setAttribute('data-i18n', i18nKey);
    // Explicitly re-translate the label text from the key
    const translated = t(i18nKey);
    if (translated) label.textContent = translated;
  } else {
    label.removeAttribute('data-i18n');
  }
  
  // Update visual selection
  select.querySelectorAll('.glass-option').forEach(opt => opt.classList.remove('selected'));
  el.classList.add('selected');
  
  // Close
  select.classList.remove('active');
  
  // Trigger callback
  if (callbackName && typeof window[callbackName] === 'function') {
    window[callbackName]();
  }
}

// Global click closer
document.addEventListener('click', () => {
  document.querySelectorAll('.glass-select').forEach(s => s.classList.remove('active'));
});

// Original Avtrdb Logic
let avtrdbPage = 0;
let avtrdbCurrentQuery = "";
let avtrdbCurrentPlatform = "";
let avtrdbDebounceTimer = null;
let avtrdbTotalLoaded = 0;

function onSearchCategoryChange() {
  const cat = document.getElementById("searchCategory")?.value;
  const platWrap = document.querySelector(".search-platform-select");

  if (cat === "avatars") {
    if (platWrap) platWrap.style.display = "block";
  } else {
    if (platWrap) platWrap.style.display = "none";
  }
  doAvtrdbSearch();
}

function onAvtrdbInput() {
  clearTimeout(avtrdbDebounceTimer);
  avtrdbDebounceTimer = setTimeout(doAvtrdbSearch, 600);
}


async function doAvtrdbSearch() {
  const query = document.getElementById("avtrdbSearch")?.value.trim() || "";
  const cat = document.getElementById("searchCategory")?.value || "avatars";
  const platform = document.getElementById("avtrdbPlatform")?.value || "";
  
  if (!query) return;
  avtrdbCurrentQuery = query;
  avtrdbCurrentPlatform = platform;
  window.searchCurrentCat = cat;
  
  avtrdbPage = 0;
  avtrdbTotalLoaded = 0;
  const grid = document.getElementById("avtrdbGrid");
  grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:rgba(255,255,255,0.4);">搜索中...</div>`;
  document.getElementById("avtrdbStats").textContent = "";
  document.getElementById("avtrdbLoadMore").style.display = "none";
  
  if (cat === 'avatars') {
    await avtrdbFetch(false);
  } else {
    await vrcdbFetch(cat, query);
  }
}

async function vrcdbFetch(cat, query) {
  const grid = document.getElementById("avtrdbGrid");
  const stats = document.getElementById("avtrdbStats");
  
  try {
    let url = '';
    if (cat === 'users') url = `/api/vrc/users?search=${encodeURIComponent(query)}&n=50`;
    else if (cat === 'worlds') url = `/api/vrc/worlds?search=${encodeURIComponent(query)}&n=50`;
    else if (cat === 'groups') url = `/api/vrc/groups?query=${encodeURIComponent(query)}&n=50`;
    
    const resp = await apiCall(url);
    const data = await resp.json();
    
    if (!data || data.length === 0) {
      grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:rgba(255,255,255,0.4);padding:40px;">未找到结果 (No results)</div>';
      return;
    }
    stats.textContent = `找到 ${data.length} 个结果`;
    
    // Filter by platform if applicable
    const plat = document.getElementById("avtrdbPlatform")?.value || "";
    let filteredData = data;
    if (plat && cat === 'worlds') {
      const required = plat.split('+');
      filteredData = data.filter(w => {
        const wPlats = w.platforms || (w.unityPackages ? w.unityPackages.map(p => p.platform) : []);
        return required.every(p => wPlats.includes(p));
      });
      stats.textContent = `找到 ${data.length} 个结果 (过滤后 ${filteredData.length})`;
    }

    if (cat === 'users') {
      grid.innerHTML = filteredData.map(u => {
        const fJson = JSON.stringify(u).replace(/\\\\/g,'\\\\\\\\').replace(/"/g,'&quot;');
        return `<div class="friend-card" onclick="openFriendProfile(this);" data-friend="${fJson}">
          <div class="friend-avatar-wrap">
            <img src="${escHtml(proxyImg(u.userIcon||u.profilePicOverride||u.currentAvatarThumbnailImageUrl||''))}" onerror="this.style.display=\'none\'">
          </div>
          <div class="friend-info">
            <div class="friend-name">${escHtml(u.displayName)}</div>
            <div class="friend-location" style="font-size:0.75em;color:var(--text-muted);">${escHtml(u.statusDescription||'')}</div>
          </div>
        </div>`;
      }).join('');
    } else if (cat === 'worlds') {
      grid.innerHTML = filteredData.map(w => {
        return `<div class="avatar-card" onclick="showWorldDetail('${w.id}')">
          <img src="${escHtml(proxyImg(w.thumbnailImageUrl))}" class="avatar-thumb" style="aspect-ratio:16/9;" onerror="this.style.display=\'none\'">
          <div class="avatar-info">
            <div class="avatar-name" style="font-size:1em;margin-bottom:4px;">${escHtml(w.name)}</div>
            <div class="avatar-author">👥 ${w.occupants||0} | ⭐ ${w.favorites||0}</div>
          </div>
        </div>`;
      }).join('');
    } else if (cat === 'groups') {
      grid.innerHTML = filteredData.map(g => {
        return `<div class="friend-card" style="box-shadow: 0 4px 12px rgba(0,0,0,0.5);border:1px solid var(--border);">
          <div class="friend-avatar-wrap" style="border-radius:12px;">
            <img src="${escHtml(proxyImg(g.iconUrl||''))}" style="border-radius:12px;" onerror="this.style.display=\'none\'">
          </div>
          <div class="friend-info">
            <div class="friend-name">${escHtml(g.name)} <span style="font-size:0.7em;opacity:0.6;">${escHtml(g.shortCode)}</span></div>
            <div class="friend-location" style="font-size:0.8em;">👥 ${g.memberCount||0} Members</div>
          </div>
        </div>`;
      }).join('');
    }
  } catch(e) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--error);padding:40px;">搜索失败: ${e.message}</div>`;
  }
}

async function avtrdbLoadMore() {
  avtrdbPage++;
  await avtrdbFetch(true);
}

async function avtrdbFetch(append) {
  const grid = document.getElementById("avtrdbGrid");
  const stats = document.getElementById("avtrdbStats");
  const loadMoreBtn = document.getElementById("avtrdbLoadMore");

  if (!append) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:rgba(255,255,255,0.4);">搜索中...</div>`;
  }

  try {
    let combinedResults = [];
    let hasMoreGlobal = false;

    // We only aggregate all 3 on the first page or if explicitly requested.
    // For "Load More", we usually follow avtrdb's pagination.
    const promises = [];
    
    // 1. AvtrDB (Full data)
    const requiredPlats = avtrdbCurrentPlatform ? avtrdbCurrentPlatform.split("+") : [];
    let avtrdbUrl = `https://api.avtrdb.com/v2/avatar/search?query=${encodeURIComponent(avtrdbCurrentQuery)}&page_size=50&page=${avtrdbPage}`;
    if (requiredPlats.length > 0) avtrdbUrl += `&compatibility=${requiredPlats[0]}`;
    promises.push(fetch(avtrdbUrl).then(r => r.json()).then(data => ({
      source: 'avtrdb',
      list: (data.avatars || []).map(av => ({ ...av, image_url: av.image_url, compatibility: av.compatibility || [] })),
      hasMore: data.has_more || false
    })).catch(() => ({ list: [], hasMore: false })));

    // 2. VRCX compatible sources (Only on first page)
    if (avtrdbPage === 0) {
      const dbUrls = [
        { name: 'vrcdb', url: `/api/proxy?url=${encodeURIComponent(`https://vrcx.vrcdb.com/avatars/Avatar/VRCX?search=${encodeURIComponent(avtrdbCurrentQuery)}`)}` },
        { name: 'avatarrecovery', url: `/api/proxy?url=${encodeURIComponent(`https://api.avatarrecovery.com/Avatar/vrcx?search=${encodeURIComponent(avtrdbCurrentQuery)}`)}` }
      ];
      dbUrls.forEach(db => {
        promises.push(fetch(db.url).then(r => r.json()).then(data => ({
          source: db.name,
          list: (data || []).map(av => ({
            vrc_id: av.id,
            name: av.name || av.avatarName || "未知模型",
            author: { name: av.authorName || "Unknown", id: av.authorId },
            image_url: av.imageUrl || av.thumbnailImageUrl || "",
            performance: av.performance || {},
            compatibility: av.compatibility || (av.imageUrl ? ["pc"] : []),
            description: av.description || ""
          })),
          hasMore: false
        })).catch(() => ({ list: [], hasMore: false })));
      });
    }

    const settled = await Promise.all(promises);
    
    // Deduplication & Aggregation
    const dedupMap = new Map();
    settled.forEach(res => {
      if (res.source === 'avtrdb') hasMoreGlobal = res.hasMore;
      res.list.forEach(av => {
        const id = av.vrc_id;
        if (!id) return;
        if (!dedupMap.has(id)) {
          dedupMap.set(id, av);
        } else {
          // Merge logic: prefer avtrdb data for better performance metadata
          const existing = dedupMap.get(id);
          const hasPerf = o => o.performance?.pc_rating || o.performance?.android_rating;
          if (!hasPerf(existing) && hasPerf(av)) {
            dedupMap.set(id, av);
          }
        }
      });
    });

    const finalResultsList = Array.from(dedupMap.values());

    // Post-filter for compatibility
    const actualRequiredPlats = avtrdbCurrentPlatform ? avtrdbCurrentPlatform.split("+") : [];
    const filteredList = actualRequiredPlats.length > 0
      ? finalResultsList.filter(av => actualRequiredPlats.every(p => (av.compatibility || []).includes(p)))
      : finalResultsList;

    if (!append) grid.innerHTML = "";

    avtrdbTotalLoaded += filteredList.length;

    if (filteredList.length === 0) {
      if (!append) {
        stats.textContent = "未找到符合条件的模型 / No matching avatars found";
        grid.innerHTML = `<div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;height:200px;color:rgba(255,255,255,0.4);gap:12px;">
        <div style="font-size:3em;">🔍</div>
        <div>未找到相关模型 / No avatars found</div>
      </div>`;
      } else {
        // Append mode but no results passed client filter on this page — hide load more
        loadMoreBtn.style.display = "none";
      }
      return;
    }

    const platLabelMap = { pc:"PC", android:"Quest", ios:"Apple", "pc+android":"PC + Quest", "pc+android+ios":"PC + Quest + Apple" };
    const platLabel = avtrdbCurrentPlatform ? (platLabelMap[avtrdbCurrentPlatform] || avtrdbCurrentPlatform) : "全平台";
    stats.textContent = `已显示 ${avtrdbTotalLoaded} 个结果（${platLabel}）${hasMoreGlobal ? " · 还有更多" : " · 全部加载完毕"}`;

    filteredList.forEach(av => {
      const card = document.createElement("div");
      card.className = "avatar-card";
      card.style.cursor = "pointer";
      card.title = "点击查看详情";
      card.addEventListener("click", () => openAvtrdbDetail(av));

      const perf = av.performance || {};
      const actualPlats = (av.compatibility || []).filter(p => {
        if (p === "pc") return !!perf.pc_rating;
        if (p === "android") return !!perf.android_rating;
        if (p === "ios") return !!perf.ios_rating;
        return true;
      });

      const platBadges = actualPlats.map(p => {
        const label = { pc: "PC", android: "Quest", ios: "Apple" }[p] || p;
        return `<span class="avtrdb-badge">${label}</span>`;
      }).join("");

      card.innerHTML = `
        <div class="avatar-thumb-wrapper">
          <img class="avatar-thumb" src="${escHtml(av.image_url || "")}"
               alt="${escHtml(av.name || "")}"
               onerror="this.style.opacity='0.3'">
          <div class="avatar-name-overlay">${escHtml(av.name || "未知模型")}</div>
        </div>
        <div style="padding:8px 6px 4px;font-size:0.7em;color:rgba(255,255,255,0.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          by ${escHtml(av.author?.name || "Unknown")}
        </div>
        <div style="padding:0 6px 10px;display:flex;gap:4px;flex-wrap:wrap;">${platBadges}</div>
      `;
      grid.appendChild(card);
    });

    loadMoreBtn.style.display = hasMoreGlobal ? "inline-block" : "none";

  } catch (e) {
    if (!append) grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:#ef4444;">搜索失败: ${escHtml(e.message)}</div>`;
  }
}

function displayAvatarDetail(av) {
  const modal = document.getElementById("avtrdbDetailModal");
  if (!modal) return;

  // 1. Normalize fields (handle both VRChat API and AvtrDB/VRCX formats)
  const id = av.vrc_id || av.id || "";
  let name = av.name || av.avatarName || "";
  
  // Recovery: Check global favorites map
  if ((!name || name === 'Unknown' || name.startsWith('Model ')) && window._localNameMap?.has(id)) {
    name = window._localNameMap.get(id);
    av.name = name; // Update memory
  }
  if (!name || name === 'Unknown') name = `Model ${id.substring(5, 13)}`;
  const author = av.author?.name || av.authorName || "Unknown";
  const desc = av.description || "";
  let thumb = av.image_url || av.thumbnailImageUrl || av.imageUrl || "";
  
  // Proxy VRChat images
  if (thumb && (thumb.includes("api.vrchat.cloud") || thumb.includes("files.vrchat.cloud"))) {
    thumb = `${API_BASE}/api/image?url=${encodeURIComponent(thumb)}&auth=${encodeURIComponent(vrcAuth || "")}`;
  }

  const createdAt = av.created_at || av.createdAt;
  const updatedAt = av.updated_at || av.updatedAt;

  // 2. Populate UI
  document.getElementById("avtrdbDetailImg").src = thumb;
  document.getElementById("avtrdbDetailName").textContent = name;
  document.getElementById("avtrdbDetailAuthor").textContent = author;
  document.getElementById("avtrdbDetailId").textContent = id;

  const fmt = d => d ? new Date(d).toLocaleString("zh-CN", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" }) : "-";
  document.getElementById("avtrdbDetailCreated").textContent = fmt(createdAt);
  document.getElementById("avtrdbDetailUpdated").textContent = fmt(updatedAt);

  // 3. Platform & Performance Logic
  const platMap = { pc: "PC", android: "Quest", ios: "Apple", standalonewindows: "PC" };
  const ratingColor = r => ({ VeryPoor:"#ef4444", Poor:"#f59e0b", Medium:"#eab308", Good:"#22c55e", Excellent:"#a3e635" }[r] || "#64748b");
  const ratingHtml = (label, r) => r && r !== "None" ? `<span style="font-size:0.75em;color:${ratingColor(r)};background:rgba(255,255,255,0.05);padding:2px 8px;border-radius:4px;border:1px solid ${ratingColor(r)}40;">${label}: ${r}</span>` : "";

  let plats = new Set();
  let perfumes = [];

  if (av.unityPackages) {
    // VRChat API format
    av.unityPackages.forEach(p => {
       if (p.platform && p.performanceRating && p.performanceRating !== "None") {
         plats.add(p.platform);
         perfumes.push(ratingHtml(platMap[p.platform] || p.platform, p.performanceRating));
       }
    });
  } else if (av.performance) {
    // AvtrDB/VRCX format
    if (av.performance.pc_rating) { plats.add("pc"); perfumes.push(ratingHtml("PC", av.performance.pc_rating)); }
    if (av.performance.android_rating) { plats.add("android"); perfumes.push(ratingHtml("Quest", av.performance.android_rating)); }
    if (av.performance.ios_rating) { plats.add("ios"); perfumes.push(ratingHtml("Apple", av.performance.ios_rating)); }
    // Fallback platforms from compatibility
    if (av.compatibility) av.compatibility.forEach(p => plats.add(p));
  }

  const platBadges = Array.from(plats).map(p =>
    `<span class="avtrdb-badge" style="font-size:0.85em;padding:3px 10px;">${platMap[p] || p}</span>`
  ).join("") || "<span style='color:rgba(255,255,255,0.4)'>-</span>";
  document.getElementById("avtrdbDetailPlats").innerHTML = platBadges;

  const perfHtml = perfumes.filter(Boolean).join(" ") || "<span style='color:rgba(255,255,255,0.4)'>-</span>";
  document.getElementById("avtrdbDetailPerf").innerHTML = perfHtml;

  const descRow = document.getElementById("avtrdbDetailDescRow");
  document.getElementById("avtrdbDetailDesc").textContent = desc;
  descRow.style.display = desc ? "" : "none";

  // 4. Favorites Status
  document.getElementById("avtrdbFavStatus").textContent = "";
  document.getElementById("avtrdbFavMenu")?.classList.add("hidden");

  const favBtn = document.getElementById("avtrdbDetailFavBtn");
  if (favoriteIdMap.has(id)) {
     favBtn.innerHTML = "⭐ 移除收藏";
     favBtn.className = "btn btn-danger-full";
     favBtn.onclick = (e) => { e.stopPropagation(); unfavorite(id, name); };
  } else {
     favBtn.innerHTML = "⭐ 收藏";
     favBtn.className = "btn btn-secondary";
     favBtn.onclick = toggleAvtrdbFavMenu;
     const favList = document.getElementById("avtrdbFavGroupList");
     if (favList) {
        if (favoriteGroups.length === 0) favList.innerHTML = `<div style="padding:8px 12px;font-size:0.8em;color:var(--text-muted);">请先加载收藏夹</div>`;
        else favList.innerHTML = favoriteGroups.map(g =>
          `<button class="avtrdb-fav-group-btn" onclick="addToFavorite('${escHtml(id)}','${escHtml(g.name)}',this)">${escHtml(g.displayName || g.name)}</button>`
        ).join("");
     }
  }

  // 5. Actions
  const switchBtn = document.getElementById("avtrdbDetailSwitchBtn");
  if (switchBtn) switchBtn.onclick = () => switchAvatar(id);

  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function openAvtrdbDetail(av) { displayAvatarDetail(av); }
function openLocalDetail(id) { 
  const av = visibleAvatars.find(a => a.id === id);
  if (av) displayAvatarDetail(av); 
}


function closeAvtrdbDetail() {
  document.getElementById("avtrdbDetailModal")?.classList.add("hidden");
  document.getElementById("avtrdbFavMenu")?.classList.add("hidden");
}

function toggleAvtrdbFavMenu(event) {
  event.stopPropagation();
  const menu = document.getElementById("avtrdbFavMenu");
  if (!menu) return;

  if (!menu.classList.contains("hidden")) {
    menu.classList.add("hidden");
    return;
  }

  // Position the fixed menu above the button using viewport coords
  const btn = document.getElementById("avtrdbDetailFavBtn");
  const rect = btn.getBoundingClientRect();
  menu.style.left = rect.left + "px";
  menu.style.top = (rect.top - menu.offsetHeight - 6) + "px";
  menu.classList.remove("hidden");

  // Recalculate after render (height may not be known before display)
  requestAnimationFrame(() => {
    menu.style.top = (rect.top - menu.offsetHeight - 6) + "px";
  });

  // Close on outside click
  const close = (e) => {
    if (!document.getElementById("avtrdbFavWrapper")?.contains(e.target) && !menu.contains(e.target)) {
      menu.classList.add("hidden");
      document.removeEventListener("click", close);
    }
  };
  setTimeout(() => document.addEventListener("click", close), 0);
}

async function addToFavorite(avtrId, groupName, btn) {
  document.getElementById("avtrdbFavMenu")?.classList.add("hidden");
  const statusEl = document.getElementById("avtrdbFavStatus");
  statusEl.style.color = "var(--text-muted)";
  statusEl.textContent = `正在收藏到 ${groupName}...`;
  if (btn) { btn.disabled = true; btn.style.opacity = "0.6"; }

  try {
    const resp = await apiCall("/api/vrc/favorites", {
      method: "POST",
      json: { type: "avatar", favoriteId: avtrId, tags: [groupName] },
    });
    if (resp.ok) {
      statusEl.style.color = "var(--success)";
      statusEl.textContent = `✓ 已收藏到 ${groupName}`;
      // Invalidate IDB cache for that group so next load fetches fresh
      try { await idb.set("avatars_" + groupName, null); } catch (_) {}
    } else {
      const err = await resp.json().catch(() => ({}));
      statusEl.style.color = "var(--error)";
      statusEl.textContent = `✗ 收藏失败：${err.error?.message || resp.status}`;
    }
  } catch (e) {
    statusEl.style.color = "var(--error)";
    statusEl.textContent = `✗ 网络错误：${e.message}`;
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ""; }
  }
}

function openInVRCX(avtrId) {
  window.open(`vrcx://avatar/${avtrId}`, "_self");
}

async function switchAvatar(avtrId) {
  const btn = document.getElementById("avtrdbDetailSwitchBtn");
  const originalText = btn ? btn.innerHTML : "⚡ 切换模型";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = "⚡ 正在切换...";
  }

  try {
    const resp = await apiCall(`/api/vrc/avatars/${avtrId}/select`, {
      method: "PUT"
    });
    const result = await resp.json().catch(() => ({}));
    if (resp.ok && !result.error) {
      logMsg("✅ 模型切换成功 (Avatar switched successfully)！", "success");
      if (btn) btn.innerHTML = "✅ 已切换";
    } else {
      throw new Error(result.error?.message || "未知错误");
    }
  } catch (e) {
    logMsg(`❌ 模型切换失败 (Failed to switch): ${e.message}`, "error");
    if (btn) btn.innerHTML = "❌ 切换失败";
  } finally {
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalText;
      }
    }, 2000);
  }
}


// ── Init ──
document.addEventListener("DOMContentLoaded", () => {
  setLang(currentLang);
  renderSavedAccounts();
  // Auto-login if we have saved auth
  if (vrcAuth) {
    apiCall("/api/vrc/auth/user")
      .then((r) => {
        if (r.ok) showMainApp();
      })
      .catch(() => {});
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
  const map = { standalonewindows: '🖥️ PC', android: '🥽 Quest', ios: '📱 iOS', web: '🌐 Web' };
  return map[platform] || platform || '';
}

// Bug#1 fix: parse location AND cache world name for display
const worldNameCache = new Map();
async function getLocationDisplay(location, worldId) {
  if (!location || location === 'offline') return '离线';
  if (location === 'private')   return '🔒 私人房间';
  if (location === 'traveling') return '✈️ 传送中';

  const [wid, rest = ''] = location.split(':');
  let type = '公开';
  if (rest.includes('~private'))        type = '🔒 私人';
  else if (rest.includes('~friends+')) type = '👥 好友+';
  else if (rest.includes('~friends'))  type = '👥 好友';
  else if (rest.includes('~hidden'))   type = '👁 隐藏';
  else if (rest.includes('group('))    type = '🏠 群组';

  const regionMatch = rest.match(/region\(([^)]+)\)/);
  const region = regionMatch ? regionMatch[1].toUpperCase() : '';
  const regionFlag = { JP:'🇯🇵', US:'🇺🇸', EU:'🇪🇺', USE:'🇺🇸', USW:'🇺🇸' }[region] || (region ? `[${region}]` : '');

  let worldName = worldNameCache.get(wid);
  if (!worldName && wid && wid.startsWith('wrld_')) {
    try {
      const r = await apiCall(`/api/vrc/worlds/${wid}`);
      if (r.ok) { const w = await r.json(); worldName = w.name; worldNameCache.set(wid, worldName); }
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
  d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(d); el.scrollTop = el.scrollHeight;
  while (el.children.length > 200) el.removeChild(el.firstChild);
}

function worldLogMsg(msg, type = 'info') {
  const el = document.getElementById('worldConsole');
  if (!el) return;
  const d = document.createElement('div'); d.className = `log-${type}`;
  d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(d); el.scrollTop = el.scrollHeight;
  while (el.children.length > 200) el.removeChild(el.firstChild);
}

function proxyImg(url) {
  if (!url) return '';
  if (url.includes('api.vrchat.cloud') || url.includes('files.vrchat.cloud'))
    return `${API_BASE}/api/image?url=${encodeURIComponent(url)}&auth=${encodeURIComponent(vrcAuth || '')}`;
  return url;
}

// ═══════════════════════════════════════════════════════════════
// ── FRIENDS TAB ──
// ═══════════════════════════════════════════════════════════════

let allFriends       = [];
let currentFriendCategory = 'myprofile';
let friendsLoaded    = false;
let friendFavGroups  = [];
let currentFriendProfile = null;
let myProfileData    = null;

async function initFriendsTab() {
  friendsLoaded = true;
  await loadFriendFavGroups();
  switchFriendCategory('myprofile');
}

// Helper: make a sidebar button with cat-btn + btn-secondary styling identical to Models tab
function makeCatBtn(text, onclick, id) {
  return `<button class="btn btn-secondary btn-block cat-btn" onclick="${escHtml(onclick)}" id="${escHtml(id)}">${text}</button>`;
}

async function loadFriendFavGroups() {
  try {
    const resp = await apiCall('/api/vrc/favorite/groups?type=friend&n=10');
    if (!resp.ok) return;
    friendFavGroups = await resp.json() || [];
    const container = document.getElementById('friendFavGroupList');
    if (!container) return;
    if (!friendFavGroups.length) {
      container.innerHTML = '<div style="font-size:0.75em;color:var(--text-muted);padding:4px 0;">无收藏夹</div>';
      return;
    }
    container.innerHTML = friendFavGroups.map(g =>
      makeCatBtn(`⭐ ${escHtml(g.displayName || g.name)}`, `switchFriendCategory('fav_${g.name}')`, `friendCatFav_${g.name}`)
    ).join('');
  } catch(e) { console.warn('loadFriendFavGroups', e); }
}

function switchFriendCategory(cat) {
  currentFriendCategory = cat;
  document.querySelectorAll('#friendsPanel .cat-btn, #friendsPanel .category-btn').forEach(b => {
    b.classList.remove('active','btn-primary');
    b.classList.add('btn-secondary');
  });
  const btnId = cat.startsWith('fav_')
    ? `friendCatFav_${cat.slice(4)}`
    : `friendCat${cat.charAt(0).toUpperCase()+cat.slice(1)}`;
  const btn = document.getElementById(btnId);
  if (btn) { btn.classList.remove('btn-secondary'); btn.classList.add('active','btn-primary'); }

  const myView   = document.getElementById('friendMyProfileView');
  const listView = document.getElementById('friendListView');
  if (cat === 'myprofile') {
    myView.style.display = 'block'; listView.style.display = 'none';
    fetchMyProfile();
  } else {
    myView.style.display = 'none'; listView.style.display = 'flex';
    fetchCurrentFriendCategory();
  }
}

async function fetchMyProfile(forceRefresh = false) {
  // Show the inline view (not modal) in the right panel
  const myView = document.getElementById('friendMyProfileView');
  const listView = document.getElementById('friendListView');
  if (myView)   { myView.style.display = ''; myView.innerHTML = '<div style="text-align:center;padding:60px;color:rgba(255,255,255,0.3);">加载中...</div>'; }
  if (listView) listView.style.display = 'none';
  // Highlight the nav entry
  document.querySelectorAll('#friendsPanel .cat-btn').forEach(b => b.classList.remove('active','btn-primary'));
  const catBtn = document.getElementById('friendCatMyprofile');
  if (catBtn) { catBtn.classList.add('active','btn-primary'); catBtn.style.display = ''; }
  try {
    if (!forceRefresh && !myProfileData) {
      const cached = await idb.get('my_profile');
      if (cached) myProfileData = cached;
    }
    if (forceRefresh || !myProfileData) {
      const resp = await apiCall('/api/vrc/auth/user');
      if (!resp.ok) throw new Error('Failed to fetch profile');
      myProfileData = await resp.json();
      await idb.set('my_profile', myProfileData);
    }
    const u = myProfileData;
    // Render profile INLINE into the right panel area
    renderMyProfile(u);
    // Update the sidebar mini-profile card
    renderSidebarMiniProfile(u);
  } catch(e) {
    if (myView) myView.innerHTML = `<div style="text-align:center;padding:60px;color:var(--error);">加载失败: ${escHtml(e.message)}</div>`;
  }
}

function renderMyProfile(u) {
  const view = document.getElementById('friendMyProfileView');
  const trust  = getTrustInfo(u.tags || []);
  const vrcP   = isVRCPlus(u.tags || []);
  const langs  = getLanguages(u.tags || []);
  const showcasedBadges = (u.badges || []);

  const statusColor = {active:'#22c55e','join me':'#1A75FF','ask me':'#f59e0b',busy:'#ef4444',offline:'#475569'}[u.status] || '#22c55e';
  const platformIcon = {standalonewindows:'🖥️',android:'🥽',ios:'📱'}[u.last_platform] || '';
  const statCard = (label, val) =>
    `<div class="fp-stat-item"><div class="fp-stat-label">${label}</div><div class="fp-stat-value">${val||'–'}</div></div>`;

  const profileBig = proxyImg(u.profilePicOverride||u.currentAvatarThumbnailImageUrl||u.userIcon||'');
  const avatarThumb = proxyImg(u.currentAvatarThumbnailImageUrl||'');

  view.innerHTML = `<div class="my-profile-card">
    <!-- Banner + avatar row -->
    <div class="my-profile-banner" style="position:relative;height:120px;overflow:hidden;background:var(--bg-secondary);">
      <img src="${escHtml(profileBig)}" style="width:100%;height:100%;object-fit:cover;filter:blur(6px) brightness(0.35);" onerror="this.style.display=\'none\'">
      <div style="position:absolute;inset:0;background:linear-gradient(to top,var(--bg-primary) 0%,transparent 70%);"></div>
    </div>
    <div class="my-profile-avatar-row" style="display:flex;align-items:flex-end;gap:16px;margin:-40px 0 12px;position:relative;">
      <div style="width:80px;height:80px;border-radius:50%;overflow:hidden;border:3px solid var(--bg-primary);background:var(--bg-card);flex-shrink:0;">
        <img src="${escHtml(profileBig)}" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'">
      </div>
      <div style="flex:1;min-width:0;padding-bottom:4px;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="width:11px;height:11px;border-radius:50%;background:${statusColor};flex-shrink:0;border:2px solid var(--bg-primary);"></span>
          <span style="font-size:1.1em;font-weight:700;">${escHtml(u.displayName||'')}</span>
          ${langs.map(l=>`<span>${l}</span>`).join('')}
          ${vrcP?'<span style="font-size:0.68em;background:rgba(167,139,250,0.2);color:#a78bfa;border:1px solid rgba(167,139,250,0.4);padding:2px 8px;border-radius:99px;font-weight:600;">VRC+</span>':''}
        </div>
        <div style="font-size:0.75em;color:var(--text-muted);">${escHtml(u.username||'')}</div>
      </div>
      <div style="width:64px;height:64px;border-radius:10px;overflow:hidden;border:2px solid var(--border);background:var(--bg-card);flex-shrink:0;" title="当前模型">
        <img src="${escHtml(avatarThumb)}" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'">
      </div>
    </div>

    <!-- Trust + platform badges -->
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
      <span style="font-size:0.72em;font-weight:600;padding:4px 12px;border-radius:99px;background:${trust.color}22;color:${trust.color};border:1px solid ${trust.color}55;">${trust.label}</span>
      ${u.ageVerificationStatus==='18+'?'<span style="font-size:0.72em;background:rgba(99,102,241,0.2);color:#a5b4fc;border:1px solid rgba(99,102,241,0.3);padding:4px 12px;border-radius:99px;">18+</span>':''}
      ${platformIcon?`<span style="font-size:0.75em;color:var(--text-muted);padding:4px 10px;background:var(--bg-glass);border:1px solid var(--border);border-radius:99px;">${platformIcon}</span>`:''}
      ${u.pronouns?`<span style="font-size:0.72em;color:var(--text-muted);">${escHtml(u.pronouns)}</span>`:''}
    </div>

    <!-- Showcase badges -->
    ${showcasedBadges.length?`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">
      ${showcasedBadges.map(b=>`<img src="${escHtml(b.badgeImageUrl||'')}" title="${escHtml(b.badgeName||'')}" style="width:32px;height:32px;border-radius:6px;" onerror="this.style.display=\'none\'">`).join('')}
    </div>`:''}

    <!-- Status msg -->
    ${u.statusDescription?`<div style="font-size:0.8em;color:var(--text-secondary);margin-bottom:10px;padding:8px 12px;background:var(--bg-glass);border-radius:8px;border-left:3px solid ${statusColor};">${escHtml(u.statusDescription.replace(/\\n/g, String.fromCharCode(10)))}</div>`:''}

    <!-- Current location -->
    ${(u.location&&u.location!=='offline'&&u.location!=='private')?`<div style="margin-bottom:12px;" id="myProfileLocRow">
      <div class="stat-section-label">当前位置</div>
      <div id="myProfileLocText" style="font-size:0.8em;color:var(--text-secondary);">加载中...</div>
    </div>`:''}

    <!-- Current avatar name -->
    ${u.currentAvatarName?`<div style="margin-bottom:12px;"><div class="stat-section-label">正在使用的模型</div>
      <div style="font-size:0.8em;color:var(--text-secondary);">${escHtml(u.currentAvatarName)}</div></div>`:''}

    <!-- Bio -->
    ${u.bio?`<div style="margin-bottom:12px;"><div class="stat-section-label">个人简介</div>
      <div style="font-size:0.8em;color:var(--text-secondary);white-space:pre-line;line-height:1.6;max-height:150px;overflow-y:auto;">${escHtml((u.bio||'').replace(/\\n/g, String.fromCharCode(10)))}</div></div>`:''}\n
    
    <!-- Groups -->
    <div style="margin-bottom:12px;">
      <div class="stat-section-label">所属群组 (Groups)</div>
      <div id="myProfileGroups" style="font-size:0.8em;color:var(--text-secondary);">加载中 (Loading)...</div>
    </div>
<!-- Stat grid -->
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;">
      ${statCard('账号创建日期', escHtml(u.date_joined||''))}
      ${statCard('最后活跃', u.last_activity?new Date(u.last_activity).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'')}
      ${statCard('允许克隆模型', u.allowAvatarCopying?'允许':'不允许')}
      ${u.friendCount!=null?statCard('好友数', String(u.friendCount)):''}
      ${u.offlineFriends!=null?statCard('离线好友', String(u.offlineFriends.length||0)):''}
      ${u.onlineFriends!=null?statCard('在线好友', String(u.onlineFriends.length||0)):''}
    </div>

    <!-- Player ID -->
    <div class="stat-section-label">玩家 ID</div>
    <div style="font-size:0.72em;color:var(--text-muted);font-family:monospace;display:flex;align-items:center;gap:6px;margin-top:4px;">
      ${escHtml(u.id||'')}
      <button onclick="navigator.clipboard.writeText('${escHtml(u.id||'')}').then(()=>this.textContent='✓').catch(()=>{})" style="background:none;border:1px solid var(--border);color:var(--text-muted);padding:2px 8px;border-radius:4px;cursor:pointer;font-size:0.9em;">复制</button>
    </div>

    <!-- Action buttons -->
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;padding-top:14px;border-top:1px solid var(--border);">
      <button class="btn btn-primary" style="padding:6px 14px;font-size:0.82em;" onclick="fetchMyProfile(true)">🔄 刷新资料</button>
      <button class="btn btn-secondary" style="padding:6px 14px;font-size:0.82em;" onclick="showSelfContextMenu(event)">··· 操作菜单</button>
      <button class="btn btn-secondary" style="font-size:0.82em;" onclick="window.open('https://vrchat.com/home/user/${escHtml(u.id||'')}','_blank')">🔗 VRChat 主页</button>
      <button class="btn btn-secondary" style="font-size:0.82em;" onclick="navigator.clipboard.writeText('${escHtml(u.id||'')}').then(()=>this.textContent='✓ 已复制').catch(()=>{})">📋 复制 ID</button>
    </div>
  </div>`;

  // Async: load location display
  if (u.location && u.location !== 'offline' && u.location !== 'private') {
    getLocationDisplay(u.location).then(txt => {
      const el = document.getElementById('myProfileLocText');
      if (el) el.innerHTML = `<a href="#" onclick="showWorldDetail('${u.location.split(':')[0]}'); event.preventDefault();" style="color:var(--accent-light);text-decoration:none;">${txt}</a>`;
    }).catch(() => {});
  }
}

// Bug#2 fix: favorites endpoint returns {favoriteId: "usr_xxx", ...} NOT user objects
// Need to batch-fetch actual user profiles
async function fetchCurrentFriendCategory(forceRefresh = false) {
  const cat    = currentFriendCategory;
  const listEl = document.getElementById('friendList');
  const statsEl = document.getElementById('friendStats');
  if (!listEl) return;
  listEl.innerHTML = '<div style="text-align:center;padding:40px;color:rgba(255,255,255,0.3);">加载中...</div>';
  if (statsEl) statsEl.textContent = '加载中...';

  try {
    let friendsList = [];
    let cacheKey = '';

    if (cat.startsWith('fav_')) {
      const groupName = cat.slice(4);
      cacheKey = 'friends_fav_' + groupName;
      if (!forceRefresh) {
        const cached = await idb.get(cacheKey);
        if (cached && cached.length > 0) {
          allFriends = cached; filterFriends();
          if (statsEl) statsEl.textContent = `${cached.length} 位好友 (缓存)`;
          return;
        }
      }
      // Step 1: get favorite records (just IDs)
      let favRecords = [];
      let offset = 0;
      while (true) {
        const r = await apiCall(`/api/vrc/favorites?type=friend&tag=${encodeURIComponent(groupName)}&n=100&offset=${offset}`);
        if (!r.ok) break;
        const batch = await r.json();
        if (!batch || !batch.length) break;
        favRecords = favRecords.concat(batch);
        if (batch.length < 100) break;
        offset += 100;
        await new Promise(r => setTimeout(r, 300));
      }
      // Step 2: fetch actual user profiles from favoriteId
      const userIds = favRecords.map(f => f.favoriteId).filter(Boolean);
      const users   = [];
      for (let i = 0; i < userIds.length; i += 10) {
        const chunk = userIds.slice(i, i+10);
        const results = await Promise.allSettled(
          chunk.map(uid => apiCall(`/api/vrc/users/${uid}`).then(r => r.ok ? r.json() : null))
        );
        results.forEach(res => { if (res.status==='fulfilled' && res.value) users.push(res.value); });
        if (i + 10 < userIds.length) await new Promise(r => setTimeout(r, 400));
      }
      friendsList = users;
    } else {
      const onlineOnly = (cat === 'online');
      cacheKey = 'friends_' + cat;
      if (!forceRefresh) {
        const cached = await idb.get(cacheKey);
        if (cached && cached.length > 0) {
          allFriends = cached; filterFriends();
          if (statsEl) statsEl.textContent = `${cached.length} 位好友 (缓存)`;
          return;
        }
      }
      let offset  = 0;
      // Always fetch online friends first
      while (true) {
        const r = await apiCall(`/api/vrc/auth/user/friends?n=100&offset=${offset}&offline=false`);
        if (!r.ok) break;
        const batch = await r.json();
        if (!batch || !batch.length || batch.error) break;
        friendsList = friendsList.concat(batch);
        if (batch.length < 100) break;
        offset += 100;
        await new Promise(r => setTimeout(r, 300));
      }
      // If "all", also fetch offline
      if (!onlineOnly) {
        offset = 0;
        while (offset < 3000) {
          const r = await apiCall(`/api/vrc/auth/user/friends?n=100&offset=${offset}&offline=true`);
          if (!r.ok) break;
          const batch = await r.json();
          if (!batch || !batch.length || batch.error) break;
          friendsList = friendsList.concat(batch);
          if (batch.length < 100) break;
          offset += 100;
          await new Promise(r => setTimeout(r, 300));
        }
      }
    }
    if (cat !== currentFriendCategory) return; // Cancel if changed
    allFriends = friendsList;
    if (cacheKey) await idb.set(cacheKey, friendsList);
    filterFriends();
    if (statsEl) statsEl.textContent = `共 ${allFriends.length} 位好友`;
    friendLogMsg(`✅ 加载了 ${allFriends.length} 位好友`, 'success');
  } catch(e) {
    if (cat !== currentFriendCategory) return;
    listEl.innerHTML = `<div style="text-align:center;padding:40px;color:var(--error);">加载失败: ${escHtml(e.message)}</div>`;
    if (statsEl) statsEl.textContent = '加载失败';
    friendLogMsg('❌ ' + e.message, 'error');
  }
}

function filterFriends() {
  const q      = (document.getElementById('friendSearch')?.value||'').toLowerCase().trim();
  const sortBy = document.getElementById('friendSortBy')?.value || 'status';
  let list     = [...allFriends];

  if (q) list = list.filter(f =>
    (f.displayName||'').toLowerCase().includes(q) ||
    (f.statusDescription||'').toLowerCase().includes(q)
  );

  const trustScore = tags => {
    if (!tags) return 0;
    if (tags.includes('system_trust_veteran')) return 5;
    if (tags.includes('system_trust_trusted')) return 4;
    if (tags.includes('system_trust_known'))   return 3;
    if (tags.includes('system_trust_basic'))   return 2;
    return 1;
  };

  // My current location (to detect co-located friends)
  const myLoc = (myProfileData && myProfileData.location) || '';
  const myWorldId = myLoc.split(':')[0]; // wrld_xxx part only

  const getStatusPriority = (f) => {
    const loc = f.location || '';
    // Offline
    if (f.status === 'offline' || !f.status || loc === 'offline') return 0;
    // In-game
    if (loc.startsWith('wrld_')) {
      // Tier 3: same instance as me (exact match)
      if (myLoc && loc === myLoc) return 4;
      // Tier 2: in the same world but different instance, or fully public/friends+ joinable
      // Also: status "join me" = joinable regardless of room type
      const isPrivate = loc.includes(':private') || loc.includes(':invite)');
      const isBusyOrAsk = f.status === 'busy' || f.status === 'ask me';
      if (!isPrivate && !isBusyOrAsk) return 3; // joinable
      if (isPrivate || isBusyOrAsk) return 2;   // in-game but private/restricted
    }
    // Web/app online but not in game instance
    if (f.status === 'busy' || f.status === 'ask me') return 1;
    return 1;
  };

  list.sort((a, b) => {
    if (sortBy === 'status') {
      const pa = getStatusPriority(a), pb = getStatusPriority(b);
      if (pa !== pb) return pb - pa;
      return (a.displayName||'').localeCompare(b.displayName||'');
    }
    if (sortBy === 'name_asc')    return (a.displayName||'').localeCompare(b.displayName||'');
    if (sortBy === 'name_desc')   return (b.displayName||'').localeCompare(a.displayName||'');
    if (sortBy === 'trust')       return trustScore(b.tags) - trustScore(a.tags);
    if (sortBy === 'last_active') return new Date(b.last_activity||0) - new Date(a.last_activity||0);
    return 0;
  });

  renderFriendList(list);
}

function renderFriendList(list) {
  const el = document.getElementById('friendList');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<div style="text-align:center;padding:40px;color:rgba(255,255,255,0.3);">🧑‍🤝‍🧑<br><br>暂无好友</div>';
    return;
  }
  const sortBy = document.getElementById('friendSortBy')?.value || 'status';
  if (sortBy !== 'status') {
    el.innerHTML = list.map(f => friendCardHtml(f)).join('');
    setTimeout(resolveWorldNames, 50);
    return;
  }

  // ── Group friends by shared location ──────────────────────────────────
  // Bucket 1: in-game, grouped by location (key = full location string)
  // Bucket 2: in-game, private/restricted (single)
  // Bucket 3: web-only online
  // Bucket 4: offline
  const instanceMap = new Map(); // loc → [friends]
  const webOnline   = [];
  const offline     = [];

  for (const f of list) {
    const loc = f.location || '';
    const isOffline = f.state === 'offline' || !f.state;
    if (isOffline) { offline.push(f); continue; }
    
    // state 'active' usually means web/mobile. 
    // state 'online' means in-game.
    if (f.state === 'active') { webOnline.push(f); continue; }
    if (!instanceMap.has(loc)) instanceMap.set(loc, []);
    instanceMap.get(loc).push(f);
  }

  // Sort instances: groups with multiple friends first (desc by count),
  // then private/restricted last within in-game
  const isRestricted = (loc, friends) =>
    loc.includes(':private') || loc.includes(':invite)') ||
    friends.every(f => f.status === 'busy' || f.status === 'ask me');

  const instances = [...instanceMap.entries()];
  instances.sort(([locA, fa], [locB, fb]) => {
    const rA = isRestricted(locA, fa), rB = isRestricted(locB, fb);
    if (rA !== rB) return rA ? 1 : -1;        // restricted → bottom
    if (fb.length !== fa.length) return fb.length - fa.length; // more friends → top
    return locA.localeCompare(locB);
  });

  const myLoc = (myProfileData && myProfileData.location) || '';
  const sectionDiv = (icon, label, color, top) =>
    `<div style="padding:${top?'6':'12'}px 4px 4px;font-size:0.7em;font-weight:700;color:${color};letter-spacing:.07em;text-transform:uppercase;opacity:0.85;">${icon} ${label}</div>`;

  let html = '';
  let shownGroupHeader = false;
  let shownSoloHeader  = false;
  let shownRestHeader  = false;

  for (const [loc, friends] of instances) {
    const restricted = isRestricted(loc, friends);
    const isMine     = myLoc && loc === myLoc;
    const multi      = friends.length > 1;

    if (!restricted) {
      if (multi && !shownGroupHeader) {
        html += sectionDiv('👥', '好友聚集的实例', '#86efac', true);
        shownGroupHeader = true;
      } else if (!multi && !shownSoloHeader && !multi && shownGroupHeader) {
        html += sectionDiv('🎮', '游戏中 · 可加入', '#60a5fa', false);
        shownSoloHeader = true;
      } else if (!multi && !shownGroupHeader && !shownSoloHeader) {
        html += sectionDiv('🎮', '游戏中 · 可加入', '#60a5fa', true);
        shownSoloHeader = true;
      }
      // Instance header for multi-friend instances
      if (multi) {
        const isMineTag = isMine ? ' <span style="font-size:0.85em;background:rgba(167,139,250,0.3);color:#c4b5fd;padding:1px 6px;border-radius:4px;">📍 你也在这里</span>' : '';
        html += `<div class="loc-group-header" id="loc_${loc.split(':')[0]}" data-loc="${escHtml(loc)}" style="display:flex;align-items:center;gap:6px;padding:6px 10px;margin:4px 0 2px;background:rgba(134,239,172,0.06);border-left:2px solid #86efac;border-radius:0 6px 6px 0;font-size:0.75em;color:#86efac;">` +
          `<span>👥 ${friends.length} 位好友在此</span>` +
          `<span style="opacity:0.6;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" id="lgn_${loc.split(':')[0]}">加载中...</span>` +
          isMineTag + '</div>';
      }
    } else {
      if (!shownRestHeader) {
        html += sectionDiv('🔒', '游戏中 · 私人/限制', '#fbbf24', !shownGroupHeader && !shownSoloHeader);
        shownRestHeader = true;
      }
    }
    html += friends.map(f => friendCardHtml(f)).join('');
  }

  if (webOnline.length) {
    html += sectionDiv('🌐', '网页在线', 'var(--text-muted)', !shownGroupHeader && !shownSoloHeader && !shownRestHeader);
    html += webOnline.map(f => friendCardHtml(f)).join('');
  }
  if (offline.length) {
    html += sectionDiv('💤', '离线', 'var(--text-muted)', false);
    html += offline.map(f => friendCardHtml(f)).join('');
  }

  el.innerHTML = html;

  // Async: resolve world names for group headers
  document.querySelectorAll('.loc-group-header[data-loc]').forEach(async div => {
    const loc = div.dataset.loc;
    const nameEl = div.querySelector('[id^="lgn_"]');
    if (!nameEl || !loc) return;
    try {
      const txt = await getLocationDisplay(loc);
      nameEl.textContent = txt;
      // Also make the header clickable to open world detail
      div.style.cursor = 'pointer';
      div.onclick = (e) => { showWorldDetail(loc.split(':')[0]); e.stopPropagation(); };
    } catch {}
  });

  setTimeout(resolveWorldNames, 50);
}

function friendCardHtml(f) {
  const trust     = getTrustInfo(f.tags||[]);
  const isOnline  = f.status !== 'offline';
  const statusCss = {active:'online','join me':'join-me','ask me':'ask-me',busy:'busy',offline:'offline'}[f.status] || 'online';
  const loc = parseLocation(f.location);
  let locationText = '离线';
  const locSpanId = 'loc_' + (f.id || '').replace(/[^a-zA-Z0-9_-]/g,'');
  if (!loc.isOffline) {
    if (loc.isPrivate) locationText = '🔒 私人房间';
    else if (loc.isTraveling) locationText = '✈️ 传送中';
    else locationText = '加载中...';
  }
  const thumb = proxyImg(f.profilePicOverrideThumbnail||f.userIcon||f.currentAvatarThumbnailImageUrl||'');
  const langs = getLanguages(f.tags||[]).join('');
  const fJson  = JSON.stringify(f).replace(/\\/g,'\\\\').replace(/"/g,'&quot;');

  return `<div class="friend-card" onclick="openFriendProfile(this);" data-friend="${fJson}">
    <div class="friend-avatar-wrap">
      ${thumb ? `<img src="${escHtml(thumb)}" alt="" onerror="this.style.display=\'none\'">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:1.3em;">👤</div>'}
      <span class="friend-status-dot ${statusCss}"></span>
    </div>
    <div class="friend-info">
      <div class="friend-name" style="color:${trust.color};">${escHtml(f.displayName||'')} <span style="font-size:0.75em;opacity:0.7;">${langs}</span></div>
      <div class="friend-location" style="display:flex;align-items:center;gap:4px;">
        <span style="font-weight:600;color:var(--text-primary);">${getStatusLabel(f)}</span>
        <span style="opacity:0.6;">|</span>
        ${(f.location && f.location !== 'offline' && f.location !== 'private' && f.location.startsWith('wrld_')) 
            ? `<a href="#" id="${locSpanId}" onclick="showWorldDetail('${f.location.split(':')[0]}'); event.stopPropagation(); event.preventDefault();" style="color:var(--accent-light);text-decoration:none;" title="查看世界">${escHtml(locationText)}</a>` 
            : `<span>${escHtml((f.state==='online' && f.statusDescription) ? f.statusDescription : locationText)}</span>`}
      </div>
    </div>
    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;">
      <span style="font-size:0.62em;padding:2px 7px;border-radius:99px;background:${trust.color}22;color:${trust.color};border:1px solid ${trust.color}44;">${trust.label}</span>
      <span style="font-size:0.68em;color:var(--text-muted);">${getPlatformEmoji(f.last_platform)}</span>
    </div>
  </div>`;
}

// Async resolve world names in friend cards
function resolveWorldNames() {
  document.querySelectorAll('[id^="loc_"]').forEach(async el => {
    if (el.dataset.resolved) return;
    el.dataset.resolved = '1';
    const friendCard = el.closest('.friend-card');
    if (!friendCard) return;
    try {
      const fData = JSON.parse(friendCard.dataset.friend.replace(/&quot;/g,'"').replace(/&amp;/g,'&'));
      if (fData.location && fData.location.startsWith('wrld_')) {
        const txt = await getLocationDisplay(fData.location);
        el.textContent = txt;
      }
    } catch(e) {}
  });
}

function openFriendProfile(el) {
  window._fpIsSelf = false;
  const f = JSON.parse(el.dataset.friend.replace(/&quot;/g,'"').replace(/&amp;/g,'&'));
  currentFriendProfile = f;
  const modal = document.getElementById('friendProfileModal');
  if (!modal) return;

  // If this is a LimitedUser (missing tags = from mutuals/search), fetch full profile first
  if (!f.tags && f.id) {
    _renderFriendProfileUI(f, modal); // render what we have immediately
    apiCall('/api/vrc/users/' + f.id).then(r => r.ok ? r.json() : null).then(full => {
      if (full && full.id) {
        currentFriendProfile = full;
        _renderFriendProfileUI(full, modal);
      }
    }).catch(() => {});
    return;
  }

  _renderFriendProfileUI(f, modal);
}

function _renderFriendProfileUI(f, modal) {
  // Show modal
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  const bigImg = proxyImg(f.profilePicOverride||f.profilePicOverrideThumbnail||f.userIcon||f.currentAvatarThumbnailImageUrl||'');
  const avatarThumbUrl = f.currentAvatarThumbnailImageUrl || '';

  document.getElementById('fpBannerBg').src = bigImg;
  document.getElementById('fpAvatar').src   = bigImg;

  // Hide avatar thumb container when no URL
  const thumbWrap = document.getElementById('fpAvatarThumbWrap');
  if (thumbWrap) thumbWrap.style.display = avatarThumbUrl ? '' : 'none';
  document.getElementById('fpAvatarThumb').src = proxyImg(avatarThumbUrl);

  const trust     = getTrustInfo(f.tags||[]);
  const statusCss = {active:'online','join me':'join-me','ask me':'ask-me',busy:'busy',offline:'offline'}[f.status]||'online';
  const sdot = document.getElementById('fpStatusDot');
  sdot.className  = `friend-status-dot ${statusCss}`;
  sdot.style.cssText = 'position:static;width:11px;height:11px;flex-shrink:0;';
  document.getElementById('fpName').textContent = f.displayName||'';
  const vrcPlusEl = document.getElementById('fpVrcPlus');
  if (vrcPlusEl) vrcPlusEl.style.display = isVRCPlus(f.tags||[]) ? '' : 'none';
  document.getElementById('fpPronounsEl').textContent = f.pronouns ? `(${f.pronouns})` : '';
  const langsEl = document.getElementById('fpLangsEl');
  if (langsEl) langsEl.textContent = getLanguages(f.tags||[]).join(' ');
  const userEl = document.getElementById('fpUsername');
  if (userEl) userEl.textContent = f.username||'';

  const tb = document.getElementById('fpTrustBadge');
  tb.textContent = trust.label;
  tb.style.cssText = `background:${trust.color}22;color:${trust.color};border:1px solid ${trust.color}55;font-size:0.68em;font-weight:600;padding:3px 10px;border-radius:99px;`;
  const ab = document.getElementById('fpAgeBadge');
  if (ab) ab.style.display = f.ageVerificationStatus==='18+' ? '' : 'none';
  const platb = document.getElementById('fpPlatformBadge');
  if (platb) platb.textContent = getPlatformEmoji(f.last_platform);

  const showcased = (f.badges||[]).filter(b=>b.showcased).slice(0,8);
  const bdRow = document.getElementById('fpBadgesRow');
  if (bdRow) bdRow.innerHTML = showcased.map(b=>
    `<img src="${escHtml(b.badgeImageUrl||'')}" title="${escHtml(b.badgeName||'')}" style="width:30px;height:30px;border-radius:5px;" onerror="this.style.display='none'">`
  ).join('') || '<span style="font-size:0.75em;color:var(--text-muted);">无展示徽章</span>';

  // Bug#1 fix: show formatted location
  const loc = parseLocation(f.location);
  const locSection = document.getElementById('fpLocationSection');
  if (!loc.isOffline && !loc.isPrivate) {
    locSection.style.display = '';
    const fpWorldInfo = document.getElementById('fpWorldInfo');
    fpWorldInfo.textContent = '加载位置...';
    getLocationDisplay(f.location).then(txt => { fpWorldInfo.textContent = txt; }).catch(()=>{ fpWorldInfo.textContent = f.location||''; });
  } else {
    locSection.style.display = 'none';
  }

  document.getElementById('fpStatusDesc').innerHTML = `<span style="font-weight:600;color:var(--text-primary);">${getStatusLabel(f)}</span> <span style="opacity:0.6">|</span> ` + escHtml(f.state==='offline' ? '离线' : (f.statusDescription||f.status||'').replace(/\\n/g, String.fromCharCode(10)));
  const bioSection = document.getElementById('fpBioSection');
  if (f.bio) { bioSection.style.display=''; document.getElementById('fpBio').textContent=(f.bio||'').replace(/\\n/g, String.fromCharCode(10)); }
  else bioSection.style.display='none';

  const statField = (label, val, placeholder = '–') =>
    `<div class="fp-stat-item"><div class="fp-stat-label">${label}</div><div class="fp-stat-value">${escHtml(val||'')||placeholder}</div></div>`;
  
  // Format Date Joined (Account Creation)
  let joinedStr = f.date_joined || '';
  if (joinedStr) {
    const d = new Date(joinedStr);
    joinedStr = d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  } else {
    joinedStr = '未知 (非好友可见性限制)';
  }

  document.getElementById('fpStatsGrid').innerHTML =
    statField('账号创建日期', joinedStr) +
    statField('最后活跃', f.last_activity ? new Date(f.last_activity).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '') +
    statField('允许克隆模型', f.allowAvatarCopying ? '允许' : '不允许');

  document.getElementById('fpUserId').innerHTML =
    `<span style="font-family:monospace;font-size:0.9em;">${escHtml(f.id||'')}</span>
    <button onclick="navigator.clipboard.writeText('${escHtml(f.id||'')}').then(()=>this.textContent='✓')" style="background:none;border:1px solid var(--border);color:var(--text-muted);padding:2px 8px;border-radius:4px;cursor:pointer;font-size:0.9em;">复制</button>`;

  const isSelf = f.id === (window._myUser && window._myUser.id);
  const isFriend = f.isFriend || (allFriends && allFriends.some(af => af.id === f.id));
  
  let actionButtons = `
    <button class="btn btn-secondary" style="font-size:0.82em;padding:6px 14px;" onclick="showFriendContextMenu(event)">··· 操作菜单</button>
    <button class="btn btn-secondary" style="font-size:0.82em;" onclick="window.open('https://vrchat.com/home/user/${escHtml(f.id||'')}','_blank')">🔗 VRChat 主页</button>
  `;

  if (!isSelf) {
    if (isFriend) {
      actionButtons += `<button class="btn" style="background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.3);font-size:0.82em;" onclick="deleteFriend('${escHtml(f.id||'')}','${escHtml(f.displayName||'')}')">🗑️ 删除好友</button>`;
    } else {
      actionButtons += `<button class="btn" style="background:rgba(34,197,94,0.15);color:#4ade80;border:1px solid rgba(34,197,94,0.3);font-size:0.82em;" onclick="sendFriendRequest('${escHtml(f.id||'')}','${escHtml(f.displayName||'')}')">➕ 添加好友</button>`;
    }
  }

  document.getElementById('fpActions').innerHTML = actionButtons;

  // Always restore the mutual friends tab for non-self profiles
  const mutualTabBtn = document.getElementById('fpTabMutual');
  if (mutualTabBtn) mutualTabBtn.style.display = '';

  switchFriendProfileTab('info');
  modal.classList.remove('hidden');
}

function closeFriendProfile() {
  document.getElementById('friendProfileModal')?.classList.add('hidden');
  currentFriendProfile = null;
}

function switchFriendProfileTab(tab) {
  ['info','groups','worlds','avatars','mutual'].forEach(t => {
    const btn = document.getElementById(`fpTab${t.charAt(0).toUpperCase()+t.slice(1)}`);
    if (btn) btn.classList.toggle('active', t===tab);
    const content = document.getElementById(`fp${t.charAt(0).toUpperCase()+t.slice(1)}Tab`);
    if (content) content.style.display = t===tab ? '' : 'none';
  });
  const f = currentFriendProfile;
  if (!f) return;
  if (tab === 'groups')  fetchFriendGroups(f.id);
  if (tab === 'mutual')  fetchMutualFriends(f.id, 'fpMutualList');
  if (tab === 'worlds')  fetchFriendWorlds(f.id);
  if (tab === 'avatars') fetchFriendAvatars(f.id);
}

async function fetchFriendGroups(userId) {
  const el = document.getElementById('fpGroupsList');
  if (!el) return;
  el.innerHTML = '<div style="padding:20px;color:rgba(255,255,255,0.3);text-align:center;">加载中...</div>';
  try {
    const r = await apiCall('/api/vrc/users/' + userId + '/groups');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const groups = await r.json();

    if (!groups || !groups.length) { 
      el.innerHTML = '<div style="padding:20px;color:rgba(255,255,255,0.3);">暂无公开群组</div>'; 
      return; 
    }

    // Separate: owned / mutual / remaining (following VRCX pattern)
    const owned = [];
    const mutual = [];
    const remaining = [];
    for (const g of groups) {
      if (g.ownerId === userId || g.userId === userId) owned.push(g);
      else if (g.mutualGroup) mutual.push(g);
      else remaining.push(g);
    }

    const renderGroup = (g, badge) => {
      const badgeHtml = badge || '';
      return `<div onclick="openGroupDetail('${g.groupId||g.id}')" style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-glass);border-radius:8px;font-size:0.82em;cursor:pointer;border:1px solid var(--border);margin-bottom:6px;">
        <img src="${escHtml(proxyImg(g.iconUrl||g.bannerUrl||''))}" style="width:36px;height:36px;border-radius:6px;object-fit:cover;" onerror="this.style.display=\'none\'">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:500;">${escHtml(g.name||'')}${badgeHtml}</div>
          <div style="font-size:0.8em;color:var(--text-muted);">.${escHtml(g.shortCode||'')} \u00b7 \ud83d\udc65 ${g.memberCount||0}</div>
        </div>
      </div>`;
    };

    let html = '';
    if (owned.length) {
      html += '<div style="font-size:0.72em;font-weight:700;letter-spacing:.05em;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px;">创建的群组 (' + owned.length + ')</div>';
      html += owned.map(g => renderGroup(g, ' <span style="font-size:0.65em;background:#6366f122;color:#a5b4fc;border:1px solid #6366f144;padding:2px 5px;border-radius:99px;">创建者</span>')).join('');
      html += '<div style="border-top:1px solid var(--border);margin:10px 0;"></div>';
    }
    if (mutual.length && !window._fpIsSelf) {
      html += '<div style="font-size:0.72em;font-weight:700;letter-spacing:.05em;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px;">共同群组 (' + mutual.length + ')</div>';
      html += mutual.map(g => renderGroup(g, ' <span style="font-size:0.65em;background:rgba(34,197,94,0.15);color:#86efac;border:1px solid rgba(34,197,94,0.3);padding:2px 5px;border-radius:99px;">共同</span>')).join('');
      html += '<div style="border-top:1px solid var(--border);margin:10px 0;"></div>';
    }
    if (remaining.length) {
      html += '<div style="font-size:0.72em;font-weight:700;letter-spacing:.05em;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px;">其他群组 (' + remaining.length + ')</div>';
      html += remaining.map(g => renderGroup(g, '')).join('');
    }
    el.innerHTML = html;
  } catch(e) { 
    el.innerHTML = '<div style="padding:20px;color:var(--error);">' + escHtml(e.message) + '</div>'; 
  }
}


async function fetchFriendWorlds(userId) {
  const el = document.getElementById('fpWorldsList');
  if(!el) return;
  el.innerHTML = '<div style="grid-column:1/-1;padding:20px;color:rgba(255,255,255,0.3);text-align:center;">加载中...</div>';
  try {
    const r = await apiCall(`/api/vrc/worlds?userId=${userId}&releaseStatus=public&n=20&sort=updated`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const worlds = await r.json();
    if (!worlds || !worlds.length) { el.innerHTML = '<div style="grid-column:1/-1;padding:20px;color:rgba(255,255,255,0.3);">暂无公开世界</div>'; return; }
    const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    el.innerHTML = worlds.map(w => `<div class="avatar-card" style="cursor:pointer;" onclick="openWorldDetail('${escHtml(w.id)}')">
      <div class="avatar-thumb-wrapper img-loading">
        <img class="avatar-thumb loading" src="${BLANK}" data-src="${escHtml(proxyImg(w.thumbnailImageUrl||w.imageUrl||''))}" alt="">
        <div class="avatar-name-overlay">${escHtml(w.name||'')}</div>
      </div></div>`).join('');
    el.querySelectorAll('.avatar-thumb[data-src]').forEach(img => avatarObserver.observe(img));
  } catch(e) { el.innerHTML = `<div style="grid-column:1/-1;padding:20px;color:var(--error);">${escHtml(e.message)}</div>`; }
}

function updateAvatarNameInUI(listEl, avId, newName) {
  // Update current list object in memory
  if (window._friendAvatars) {
    const memAv = window._friendAvatars.find(a => a.id === avId);
    if (memAv) memAv.name = newName;
  }
  
  if (!listEl) return;
  const cards = listEl.querySelectorAll('.avatar-card');
  cards.forEach(card => {
    if (card.dataset.id === avId) {
      const nameEl = card.querySelector('.avatar-name-overlay');
      if (nameEl) nameEl.textContent = newName;
    }
  });
}

// Build a global map of ID -> Name from all locally cached favorites
async function initLocalNameMap() {
  const map = window._localNameMap;
  try {
    const keys = await idb.keys();
    const favKeys = keys.filter(k => typeof k === 'string' && k.startsWith('avatars_avatars'));
    // Fetch all favorite groups in parallel
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

async function buildLocalFavoriteNameMap() {
  const map = new Map();
  try {
    const keys = await idb.keys();
    const favKeys = keys.filter(k => typeof k === 'string' && k.startsWith('avatars_avatars'));
    for (const key of favKeys) {
      const list = await idb.get(key);
      if (Array.isArray(list)) {
        list.forEach(av => {
          if (av.id && av.name && av.name !== 'Unknown') {
            map.set(av.id, av.name);
          }
        });
      }
    }
  } catch (e) { console.warn('Failed to build local name map', e); }
  return map;
}

const fpAvatarFetchCache = new Map(); // userId -> Promise

async function fetchFriendAvatars(userId) {
  const el = document.getElementById('fpAvatarsList');
  if(!el) return;
  
  // Prevent duplicate concurrent loads for same user
  if (fpAvatarFetchCache.has(userId)) return fpAvatarFetchCache.get(userId);
  
  const fetchTask = (async () => {
    el.innerHTML = '<div style="grid-column:1/-1;padding:20px;color:rgba(255,255,255,0.3);text-align:center;">正在通过 4 个数据库跨服搜寻模型 (Scanning 4 DBs)...</div>';
    
    try {
    const promises = [];
    
    // 1. Official VRChat API (may return 401/403 for non-friends or restricted users)
    promises.push(apiCall(`/api/vrc/avatars?userId=${userId}&releaseStatus=public&n=20`)
      .then(async r => {
        if (!r.ok) return [];
        return await r.json() || [];
      }).catch(() => []));

    // 2. VRCX Database (via Proxy)
    promises.push(apiCall(`/api/proxy?url=${encodeURIComponent(`https://vrcx.vrcdb.com/avatars/Avatar/VRCX?authorId=${userId}`)}`)
      .then(async r => {
        if (!r.ok) return [];
        return await r.json() || [];
      }).catch(() => []));

    // 3. AvatarRecovery (via Proxy)
    promises.push(apiCall(`/api/proxy?url=${encodeURIComponent(`https://api.avatarrecovery.com/Avatar/vrcx?authorId=${userId}`)}`)
      .then(async r => {
        if (!r.ok) return [];
        return await r.json() || [];
      }).catch(() => []));
      
    // 4. AvtrDB (V3, as used in VRCX)
    promises.push(fetch(`https://api.avtrdb.com/v3/avatar/search/vrcx?authorId=${userId}&n=50`)
      .then(async r => {
        if (!r.ok) return [];
        const data = await r.json();
        return data.avatars || data || []; // Handle both {avatars: []} and []
      }).catch(() => []));

    const results = await Promise.allSettled(promises);
    const flattenedResults = results.map(r => r.status === 'fulfilled' ? r.value : []).flat();

    // Build local name map to recover from favorites
    // We now use the global window._localNameMap which is kept in sync
    const localNameMap = window._localNameMap;

    // Merge and deduplicate
    const allAvatars = [];
    const seenIds = new Set();
    
    flattenedResults.forEach(av => {
      if (!av) return;
      const id = av.id || av.Id || av.id_vrc || '';
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        
        // Comprehensive field normalization
        let name = av.name || av.Name || av.getName || av.displayName || av.AvatarName;
        
        // Check local favorites map first
        if ((!name || name === 'Unknown') && localNameMap.has(id)) {
          name = localNameMap.get(id);
        }

        // If still no name, use ID as a fallback to avoid "Unknown" for all
        if (!name || name === 'Unknown') {
          name = `Model ${id.substring(5, 13)}`; 
        }
        
        const authorName = av.authorName || av.AuthorName || av.ownerName || av.author_name || '';
        const thumb = av.thumbnailImageUrl || av.ThumbnailImageUrl || av.thumbnail_url || av.imageUrl || av.ImageUrl || av.image_url || '';
        const fullImg = av.imageUrl || av.ImageUrl || av.image_url || av.thumbnailImageUrl || av.ThumbnailImageUrl || '';
        
        allAvatars.push({
          id,
          name: name,
          authorName: authorName,
          imageUrl: fullImg,
          thumbnailImageUrl: thumb,
          releaseStatus: av.releaseStatus || av.ReleaseStatus || av.release_status || 'public',
          version: av.version || av.Version || 0,
          unityPackages: av.unityPackages || av.UnityPackages || []
        });
      }
    });

    if (!allAvatars.length) { 
      // If we got NO results at all, show a specific empty message
      el.innerHTML = '<div style="grid-column:1/-1;padding:20px;color:rgba(255,255,255,0.3);text-align:center;">暂无公开模型记录 (No database records found)</div>'; 
      return; 
    }
    
    // Store globally so detail modal can find them if needed
    window._friendAvatars = allAvatars;

    const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    el.innerHTML = allAvatars.map((av, idx) => {
        return `<div class="avatar-card" data-id="${av.id}" style="cursor:pointer;" onclick="displayAvatarDetail(window._friendAvatars[${idx}])">
          <div class="avatar-thumb-wrapper img-loading">
            <img class="avatar-thumb loading" src="${BLANK}" data-src="${escHtml(proxyImg(av.thumbnailImageUrl||av.imageUrl||''))}" alt="">
            <div class="avatar-name-overlay">${escHtml(av.name||'')}</div>
          </div></div>`;
    }).join('');
    
    el.querySelectorAll('.avatar-thumb[data-src]').forEach(img => avatarObserver.observe(img));

    // ═══════════════════════════════════════════════════════════════
    // Bounded Parallel Background Recovery (Deduplicated & Fast)
    // ═══════════════════════════════════════════════════════════════
    const unknownAvs = allAvatars.filter(av => !av.name || av.name.startsWith('Model ') || av.name === 'Unknown').slice(0, 30);
    const BATCH_SIZE = 5; // Process 5 at a time for speed vs safety balance
    
    for (let i = 0; i < unknownAvs.length; i += BATCH_SIZE) {
      const batch = unknownAvs.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map(async (av) => {
        try {
          // 1. Check local favorites map (built during initial render)
          if (localNameMap && localNameMap.has(av.id)) {
            updateAvatarNameInUI(el, av.id, localNameMap.get(av.id));
            return;
          }

          // 2. Try AvatarRecovery search by ID (Proxy)
          const arUrl = `https://api.avatarrecovery.com/Avatar/vrcx?search=${av.id}`;
          const arResp = await apiCall(`/api/proxy?url=${encodeURIComponent(arUrl)}`);
          if (arResp.ok) {
            const arData = await arResp.json();
            const found = Array.isArray(arData) ? arData.find(x => x.id === av.id) : arData;
            if (found && found.name && found.name !== 'Unknown') {
              updateAvatarNameInUI(el, av.id, found.name);
              return;
            }
          }
          
          // 3. Try AvtrDB by ID (V3)
          const avtrUrl = `https://api.avtrdb.com/v3/avatar/search/vrcx?search=${av.id}`;
          const avtrResp = await apiCall(`/api/proxy?url=${encodeURIComponent(avtrUrl)}`);
          if (avtrResp.ok) {
            const avtrData = await avtrResp.json();
            const found = avtrData.avatars && avtrData.avatars[0] ? avtrData.avatars[0] : (Array.isArray(avtrData) ? avtrData[0] : avtrData);
            if (found && found.name && found.name !== 'Unknown') {
              updateAvatarNameInUI(el, av.id, found.name);
              return;
            }
          }
          
          // 4. Fallback to official API detail (Proxy)
          const r = await apiCall(`/api/vrc/avatars/${av.id}`);
          if (r.ok) {
            const det = await r.json();
            if (det.name && det.name !== 'Unknown') {
              updateAvatarNameInUI(el, av.id, det.name);
            }
          }
        } catch (e) { /* silent fail */ }
      }));
      // Small pause between batches
      if (i + BATCH_SIZE < unknownAvs.length) await new Promise(r => setTimeout(r, 200));
    }
    
  } catch(e) { 
    console.error('fetchFriendAvatars error:', e);
    el.innerHTML = `<div style="grid-column:1/-1;padding:20px;color:var(--text-muted);font-size:0.85em;text-align:center;">读取列表时出错: ${escHtml(e.message)}</div>`; 
  } finally {
    fpAvatarFetchCache.delete(userId);
  }
  })();
  
  fpAvatarFetchCache.set(userId, fetchTask);
  return fetchTask;
}

async function deleteFriend(userId, name) {
  if (!confirm(`确定要删除好友「${name}」吗？`)) return;
  try {
    const r = await apiCall(`/api/vrc/auth/user/friends/${userId}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(await r.text());
    closeFriendProfile();
    allFriends = allFriends.filter(f => f.id !== userId);
    filterFriends();
    friendLogMsg(`✓ 已删除好友 ${name}`, 'success');
  } catch(e) { friendLogMsg(`✗ 删除失败: ${e.message}`, 'error'); }
}

async function sendFriendRequest(userId, name) {
  try {
    const r = await apiCall(`/api/vrc/user/${userId}/friendRequest`, { method: 'POST' });
    if (!r.ok) throw new Error(await r.text());
    friendLogMsg(`✓ 已向 ${name} 发送好友申请`, 'success');
    _renderFriendProfileUI(currentFriendProfile, document.getElementById('friendProfileModal')); // Refresh UI
  } catch(e) { friendLogMsg(`✗ 发送失败: ${e.message}`, 'error'); }
}


// ═══════════════════════════════════════════════════════════════
// ── WORLDS TAB ──
// ═══════════════════════════════════════════════════════════════

let allWorlds           = [];
let worldsLoaded        = false;
let currentWorldCategory = 'recent';
let worldFavGroups      = [];
let worldFavoriteIdMap  = new Map();
let currentWorldDetail  = null;

async function initWorldsTab() {
  worldsLoaded = true;
  await loadWorldFavGroups();
  // Default: first fav group or recent
  if (worldFavGroups.length > 0) {
    switchWorldCategory('fav_' + worldFavGroups[0].name);
  } else {
    switchWorldCategory('recent');
  }
}

// Bug#3 fix: world favorites - also add "我上传的世界" and handle VRC+ worlds1
async function loadWorldFavGroups() {
  try {
    // Fetch both standard world groups AND VRC+ exclusive groups in parallel
    const [r1, r2] = await Promise.all([
      apiCall('/api/vrc/favorite/groups?type=world&n=50'),
      apiCall('/api/vrc/favorite/groups?type=vrcPlusWorld&n=50')
    ]);
    const standard  = r1.ok ? (await r1.json() || []) : [];
    const vrcPlus   = r2.ok ? (await r2.json() || []) : [];
    worldFavGroups  = [...standard, ...vrcPlus];

    const container = document.getElementById('worldFavGroupList');
    if (!container) return;

    const vrcPlusNames = new Set(vrcPlus.map(g => g.name));
    let html = worldFavGroups.map(g => {
      const isVrcPlus = vrcPlusNames.has(g.name);
      const icon = isVrcPlus ? '💎' : '⭐';
      return makeCatBtn(`${icon} ${escHtml(g.displayName || g.name)}`, `switchWorldCategory('fav_${g.name}')`, `worldCatFav_${g.name}`);
    }).join('');

    // Add "我上传的世界" button
    html += makeCatBtn('📤 我上传的世界', "switchWorldCategory('mine')", 'worldCatMine');

    container.innerHTML = html || '<div style="font-size:0.75em;color:var(--text-muted);padding:4px 0;">无收藏夹</div>';
  } catch(e) { console.warn('loadWorldFavGroups', e); }
}

function switchWorldCategory(cat) {
  currentWorldCategory = cat;
  document.querySelectorAll('#worldsPanel .cat-btn, #worldsPanel .category-btn').forEach(b => {
    b.classList.remove('active','btn-primary');
    b.classList.add('btn-secondary');
  });
  const btnId = cat.startsWith('fav_')
    ? `worldCatFav_${cat.slice(4)}`
    : `worldCat${cat.charAt(0).toUpperCase()+cat.slice(1)}`;
  const btn = document.getElementById(btnId);
  if (btn) { btn.classList.remove('btn-secondary'); btn.classList.add('active','btn-primary'); }

  fetchWorlds(cat);
}

async function fetchWorlds(category, forceRefresh = false) {
  currentWorldCategory = category;
  const gridEl  = document.getElementById('worldGrid');
  const statsEl = document.getElementById('worldStats');
  if (!gridEl) return;
  allWorlds = []; // Clear previous results immediately
  gridEl.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:60px;color:rgba(255,255,255,0.3);">加载中...</div>';
  if (statsEl) {
      statsEl.textContent = '加载中...';
      statsEl.style.color = 'var(--accent)'; // Make it stand out during load
  }

  if (!forceRefresh) {
    try {
      const cached = await idb.get('worlds_' + category);
      if (cached && cached.length > 0) {
        allWorlds = cached; filterWorlds();
        if (statsEl) statsEl.textContent = `${allWorlds.length} 个世界 (缓存)`;
        return;
      }
    } catch(_) {}
  }

  try {
    let worlds = [];
    if (category.startsWith('fav_')) {
      const groupName = category.slice(4);
      // VRC+ exclusive groups have names starting with "vrcPlusWorlds"
      const isVrcPlusGroup = groupName.startsWith('vrcPlusWorlds');
      const favType = isVrcPlusGroup ? 'vrcPlusWorld' : 'world';
      worldFavoriteIdMap.clear();
      let offset = 0;
      while (true) {
        const r = await apiCall(`/api/vrc/favorites?type=${favType}&tag=${encodeURIComponent(groupName)}&n=100&offset=${offset}`);
        if (!r.ok) break;
        const batch = await r.json();
        if (!batch || !batch.length) break;
        // favoriteId is the actual world ID
        const worldIds = batch.map(b => b.favoriteId).filter(Boolean);
        batch.forEach(b => { if (b.id && b.favoriteId) worldFavoriteIdMap.set(b.favoriteId, b.id); });
        // fetch world details in parallel chunks
        for (let i = 0; i < worldIds.length; i += 10) {
          const chunk = worldIds.slice(i, i+10);
          const results = await Promise.allSettled(
            chunk.map(wid => apiCall(`/api/vrc/worlds/${wid}`).then(r => r.ok ? r.json() : null))
          );
          results.forEach(res => { if (res.status==='fulfilled' && res.value) worlds.push(res.value); });
          if (i+10 < worldIds.length) await new Promise(r => setTimeout(r, 300));
        }
        if (batch.length < 100) break;
        offset += 100;
      }
    } else if (category === 'mine') {
      // Bug#3: fetch user's own worlds
      const resp = await apiCall('/api/vrc/auth/user');
      if (resp.ok) {
        const user = await resp.json();
        const r = await apiCall(`/api/vrc/worlds?userId=${user.id}&releaseStatus=all&n=100&sort=updated`);
        if (r.ok) worlds = await r.json() || [];
      }
    } else if (category === 'recent') {
      const r = await apiCall('/api/vrc/worlds/recent?n=100');
      if (r.ok) worlds = await r.json() || [];
    } else if (category === 'active') {
      const r = await apiCall('/api/vrc/worlds/active?n=100&sort=popularity&order=descending&releaseStatus=public');
      if (r.ok) worlds = await r.json() || [];
    }

    if (category !== currentWorldCategory) return;
    allWorlds = Array.isArray(worlds) ? worlds : [];
    await idb.set('worlds_' + category, allWorlds);
    filterWorlds();
    if (statsEl) {
        statsEl.textContent = `${allWorlds.length} 个世界`;
        statsEl.style.color = ''; 
    }
    worldLogMsg(`✅ 加载了 ${allWorlds.length} 个世界`, 'success');
  } catch(e) {
    if (category !== currentWorldCategory) return;
    gridEl.innerHTML = `<div style="grid-column:1/-1;padding:60px;text-align:center;color:var(--error);">${escHtml(e.message)}</div>`;
    if (statsEl) statsEl.textContent = '加载失败';
    worldLogMsg('❌ ' + e.message, 'error');
  }
}

function filterWorlds() {
  const q = (document.getElementById('worldSearch')?.value||'').toLowerCase().trim();
  const plat = document.getElementById('worldFilterPlatform')?.value || 'all';
  let list = allWorlds;

  if (q) list = list.filter(w => (w.name||'').toLowerCase().includes(q)||(w.description||'').toLowerCase().includes(q));

  if (plat !== 'all') {
    list = list.filter(w => {
      const wPlats = w.platforms || (w.unityPackages ? w.unityPackages.map(p => p.platform) : []);
      return wPlats.includes(plat);
    });
  }

  renderWorldGrid(list);
}

function renderWorldGrid(list) {
  const gridEl = document.getElementById('worldGrid');
  if (!gridEl) return;
  if (!list.length) {
    gridEl.innerHTML = '<div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;height:300px;color:rgba(255,255,255,0.3);gap:12px;"><div style="font-size:3em;">🌍</div><div>暂无世界</div></div>';
    return;
  }
  gridEl.innerHTML = '';
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  list.forEach(w => {
    const thumb = proxyImg(w.thumbnailImageUrl||w.imageUrl||'');
    const pc  = w.occupants || 0;
    const card = document.createElement('div');
    card.className = 'avatar-card'; card.style.cursor = 'pointer';
    card.onclick = () => openWorldDetail(w.id, w);
    const isCached = loadedImageUrls.has(thumb);
    card.innerHTML = `<div class="avatar-thumb-wrapper ${isCached?'':'img-loading'}">
      ${isCached ? `<img class="avatar-thumb" src="${escHtml(thumb)}" alt="">` : `<img class="avatar-thumb loading" src="${BLANK}" data-src="${escHtml(thumb)}" alt="">`}
      <div class="avatar-name-overlay">${escHtml(w.name||'未知世界')}</div>
      ${pc>0 ? `<div class="world-player-badge">👥 ${pc}</div>` : ''}
    </div>`;
    gridEl.appendChild(card);
    if (!isCached && thumb) {
      const img = card.querySelector('.avatar-thumb[data-src]');
      if (img) avatarObserver.observe(img);
    }
  });
}

async function openWorldDetail(worldId, worldObj = null) {
  const modal = document.getElementById('worldDetailModal');
  if (!modal) return;
  document.getElementById('worldDetailName').textContent  = '加载中...';
  document.getElementById('worldDetailAuthor').textContent = '';
  document.getElementById('worldDetailInstances').innerHTML = '<div style="color:rgba(255,255,255,0.3);font-size:0.8em;padding:8px;">加载实例中...</div>';
  document.getElementById('worldDetailPlayerBadge').textContent = '';
  document.getElementById('worldDetailFavStatus').textContent  = '';
  if (worldObj) document.getElementById('worldDetailImg').src = proxyImg(worldObj.thumbnailImageUrl||worldObj.imageUrl||'');
  modal.classList.remove('hidden');

  try {
    const r = await apiCall(`/api/vrc/worlds/${worldId}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const w = await r.json();
    currentWorldDetail = w;

    document.getElementById('worldDetailImg').src    = proxyImg(w.thumbnailImageUrl||w.imageUrl||'');
    document.getElementById('worldDetailName').textContent   = w.name||'';
    document.getElementById('worldDetailAuthor').textContent = `by ${w.authorName||'Unknown'}`;

    // Bug#1 fix: instances = [[instanceStr, count], ...]
    const instances    = Array.isArray(w.instances) ? w.instances : [];
    const totalPlayers = w.occupants || instances.reduce((s,[,c])=>s+(c||0),0);
    document.getElementById('worldDetailPlayerBadge').textContent = totalPlayers>0 ? `👥 ${totalPlayers} 在线` : '';

    const tags = (w.tags||[]).filter(t=>!t.startsWith('author_tag')&&!t.startsWith('system_'));
    document.getElementById('worldDetailTags').innerHTML = tags.slice(0,6).map(t=>`<span class="avtrdb-badge">${escHtml(t)}</span>`).join('');

    const descRow = document.getElementById('worldDetailDescRow');
    const descEl  = document.getElementById('worldDetailDesc');
    if (descEl) descEl.textContent = w.description||'';
    if (descRow) descRow.style.display = w.description ? '' : 'none';

    const instContainer = document.getElementById('worldDetailInstances');
    // Bug#1: instance entry format is [instanceString, occupantCount]
    // e.g. ["12345~region(jp)", 3] or ["12345~friends(usr_xxx)~canRequestInvite~region(jp)~strict", 5]
    const activeInst = instances.filter(([,c])=>c>0).sort(([,a],[,b])=>b-a);
    if (!activeInst.length) {
      instContainer.innerHTML = '<div style="color:rgba(255,255,255,0.3);font-size:0.8em;padding:8px;">暂无玩家在线</div>';
    } else {
      instContainer.innerHTML = activeInst.slice(0,10).map(([instStr, count]) => {
        let typeLabel = '公开', typeColor = '#64748b';
        if (instStr.includes('~private'))   { typeLabel='🔒 私人'; typeColor='#f59e0b'; }
        else if (instStr.includes('~friends+') || instStr.includes('canRequestInvite')) { typeLabel='👥 好友+'; typeColor='#22c55e'; }
        else if (instStr.includes('~friends')) { typeLabel='👥 好友'; typeColor='#22c55e'; }
        else if (instStr.includes('~hidden')) { typeLabel='👁 隐藏'; typeColor='#8b5cf6'; }
        else if (instStr.includes('group(')) { typeLabel='🏠 群组'; typeColor='#3b82f6'; }

        const regionMatch = instStr.match(/region\(([^)]+)\)/);
        const region = regionMatch ? regionMatch[1].toUpperCase() : '';
        const regionFlag = {JP:'🇯🇵',US:'🇺🇸',EU:'🇪🇺',USE:'🇺🇸',USW:'🇺🇸'}[region] || (region?`[${region}]`:'');

        const instShortId = instStr.split('~')[0];
        return `<div class="world-instance-item">
          <span style="flex:1;font-size:0.78em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${regionFlag} ${escHtml(instShortId)}</span>
          <span style="font-size:0.68em;padding:2px 7px;border-radius:99px;background:${typeColor}22;color:${typeColor};border:1px solid ${typeColor}44;">${typeLabel}</span>
          <span class="inst-players">👥 ${count}/${w.capacity||'∞'}</span>
          <button class="btn btn-primary inst-join-btn" onclick="joinSpecificInstance('${escHtml(w.id)}','${escHtml(instShortId)}')">加入</button>
        </div>`;
      }).join('');
    }

    const favBtn  = document.getElementById('worldDetailFavBtn');
    const isFaved = worldFavoriteIdMap.has(w.id) || !!w.favoriteId;
    if (isFaved && w.favoriteId) worldFavoriteIdMap.set(w.id, w.favoriteId);
    if (favBtn) {
      favBtn.innerHTML  = isFaved ? '⭐ 取消收藏' : '⭐ 收藏';
      favBtn.className  = isFaved ? 'btn btn-warning' : 'btn btn-secondary';
    }
  } catch(e) {
    document.getElementById('worldDetailName').textContent = '加载失败';
    document.getElementById('worldDetailInstances').innerHTML = `<div style="color:var(--error);padding:8px;">${escHtml(e.message)}</div>`;
  }
}

function closeWorldDetail() {
  document.getElementById('worldDetailModal')?.classList.add('hidden');
  currentWorldDetail = null;
}

function joinWorldInstance() {
  if (!currentWorldDetail) return;
  window.open(`https://vrchat.com/home/world/${currentWorldDetail.id}`, '_blank');
}

function joinSpecificInstance(worldId, instanceId) {
  window.open(`vrchat://launch?ref=vrchat.com&id=${encodeURIComponent(worldId+':'+instanceId)}`, '_self');
}

async function toggleWorldFavorite() {
  if (!currentWorldDetail) return;
  const w       = currentWorldDetail;
  const favBtn  = document.getElementById('worldDetailFavBtn');
  const statusEl = document.getElementById('worldDetailFavStatus');
  const isFaved = worldFavoriteIdMap.has(w.id);
  if (favBtn) favBtn.disabled = true;
  if (statusEl) statusEl.textContent = '处理中...';
  try {
    if (isFaved) {
      const favId = worldFavoriteIdMap.get(w.id);
      const r = await apiCall(`/api/vrc/favorites/${favId}`, {method:'DELETE'});
      if (!r.ok) throw new Error(await r.text());
      worldFavoriteIdMap.delete(w.id);
      if (favBtn) { favBtn.innerHTML='⭐ 收藏'; favBtn.className='btn btn-secondary'; }
      if (statusEl) { statusEl.textContent='✓ 已取消收藏'; statusEl.style.color='var(--text-muted)'; }
      if (currentWorldCategory.startsWith('fav_')) {
        allWorlds = allWorlds.filter(aw => aw.id!==w.id);
        await idb.set('worlds_'+currentWorldCategory, allWorlds);
        filterWorlds();
      }
    } else {
      const groupName = worldFavGroups.length>0 ? worldFavGroups[0].name : 'worlds1';
      const r = await apiCall('/api/vrc/favorites',{method:'POST',json:{type:'world',favoriteId:w.id,tags:[groupName]}});
      if (!r.ok) throw new Error(await r.text());
      const res = await r.json();
      worldFavoriteIdMap.set(w.id, res.id);
      if (favBtn) { favBtn.innerHTML='⭐ 取消收藏'; favBtn.className='btn btn-warning'; }
      if (statusEl) { statusEl.textContent='✓ 已收藏'; statusEl.style.color='var(--success)'; }
    }
  } catch(e) {
    if (statusEl) { statusEl.textContent = '✗ '+e.message; statusEl.style.color='var(--error)'; }
  } finally {
    if (favBtn) favBtn.disabled = false;
    setTimeout(()=>{ if(statusEl) statusEl.textContent=''; }, 3000);
  }
}


// ── Global Nav Sidebar Toggle ──
function toggleGlobalNav() {
  const nav     = document.getElementById("globalNav");
  const navCol  = document.getElementById("globalNavCollapsed");
  if (!nav || !navCol) return;
  const isOpen = !nav.classList.contains("hidden");
  nav.classList.toggle("hidden", isOpen);
  navCol.classList.toggle("hidden", !isOpen);
  try { localStorage.setItem("navCollapsed", isOpen ? "1" : "0"); } catch(_) {}
}
document.addEventListener("DOMContentLoaded", () => {
  try {
    if (localStorage.getItem("navCollapsed") === "1") {
      document.getElementById("globalNav")?.classList.add("hidden");
      document.getElementById("globalNavCollapsed")?.classList.remove("hidden");
    }
  } catch(_) {}
});

// ══════════════════════════════════════════════
// 💰 Assets & Economy Panel 
// ══════════════════════════════════════════════

// ════════════════ VRC Upload Functions ════════════════

// Helper: extract best image URL from a VRChat File object's versions array
function extractFileVersionUrl(f) {
  if (!f || !f.versions || !f.versions.length) return '';
  // Find the latest version with status=complete and a file URL
  for (let i = f.versions.length - 1; i >= 0; i--) {
    const v = f.versions[i];
    if (v.status === 'complete' && v.file && v.file.url) return v.file.url;
  }
  // Fallback: any version with a file URL
  for (let i = f.versions.length - 1; i >= 0; i--) {
    const v = f.versions[i];
    if (v.file && v.file.url) return v.file.url;
  }
  return '';
}

async function uploadToVRC(tag, fileInput, onDone) {
  if (!fileInput || !fileInput.files || !fileInput.files[0]) {
    alert('请选择一个图片文件');
    return;
  }
  const file = fileInput.files[0];
  if (!file.type.startsWith('image/')) {
    alert('仅支持图片文件 (PNG/JPEG/WebP)');
    return;
  }
  // Size limits: icon/gallery < 10MB, emoji/sticker < 10MB and must be < 1024×1024
  const MAX_SIZE = 10 * 1024 * 1024;
  if (file.size > MAX_SIZE) {
    alert('文件过大！VRChat 限制图片最大 10MB。');
    return;
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('tag', tag);

  const statusEl = document.getElementById('uploadStatus_' + tag);
  if (statusEl) { statusEl.textContent = '上传中...'; statusEl.style.color = 'var(--text-muted)'; }

  try {
    const r = await fetch('/api/vrc/file/image', {
      method: 'POST',
      headers: { 'X-VRC-Auth': localStorage.getItem('vrc_auth') || '' },
      body: formData,
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error('HTTP ' + r.status + ': ' + errText.substring(0, 200));
    }
    if (statusEl) { statusEl.textContent = '✅ 上传成功！'; statusEl.style.color = 'var(--success)'; }
    fileInput.value = '';
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
    if (onDone) onDone();
  } catch(e) {
    if (statusEl) { statusEl.textContent = '❌ ' + e.message; statusEl.style.color = 'var(--error)'; }
    console.error('Upload failed:', e);
  }
}


// ════════════════ Groups Tab ════════════════

function switchGroupsCategory(cat) {
  document.querySelectorAll('#groupsPanel .cat-btn').forEach(b => {
    b.classList.remove('active', 'btn-primary');
    b.classList.add('btn-secondary');
  });
  const btn = document.getElementById('gpCat' + cat.charAt(0).toUpperCase() + cat.slice(1));
  if (btn) { btn.classList.remove('btn-secondary'); btn.classList.add('active', 'btn-primary'); }
  loadGroupsPage(cat);
}

async function loadGroupsPage(cat) {
  const area = document.getElementById('groupsContentArea');
  if (!area) return;
  area.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">加载中...</div>';
  try {
    if (cat === 'search') {
      area.innerHTML = '<h2 style="font-size:1.2rem;margin-bottom:12px;">🔍 搜索群组</h2>' +
        '<div style="display:flex;gap:8px;margin-bottom:16px;">' +
          '<input type="text" id="groupSearchInput" class="input-field" placeholder="输入群组名称或 shortCode..." style="flex:1;">' +
          '<button class="btn btn-primary" onclick="searchGroups()">搜索</button>' +
        '</div>' +
        '<div id="groupSearchResults"></div>';
      return;
    }
    const me = await (await apiCall('/api/vrc/auth/user')).json();
    const r = await apiCall('/api/vrc/users/' + me.id + '/groups');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const groups = await r.json();
    
    let filtered = groups || [];
    let title = '';
    if (cat === 'mine') {
      // Created by me: check ownerId
      filtered = filtered.filter(g => g.ownerId === me.id || g.userId === me.id);
      title = "👑 我创建的群组 (" + filtered.length + ")";
    } else {
      // Joined: not created by me
      filtered = filtered.filter(g => g.ownerId !== me.id && g.userId !== me.id);
      title = '📋 已加入的群组 (' + filtered.length + ')';
    }
    
    if (!filtered.length) {
      area.innerHTML = '<h2 style="font-size:1.2rem;margin-bottom:12px;">' + title + '</h2><div style="color:var(--text-muted);">暂无群组</div>';
      return;
    }
    
    area.innerHTML = '<h2 style="font-size:1.2rem;margin-bottom:16px;">' + title + '</h2>';
    area.innerHTML += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;">' +
      filtered.map(g => {
        const icon = proxyImg(g.iconUrl || g.bannerUrl || '');
        return '<div onclick="openGroupDetail(\'' + (g.groupId || g.id) + '\')" style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg-glass);border:1px solid var(--border);border-radius:10px;cursor:pointer;">' +
          '<img src="' + escHtml(icon) + '" style="width:44px;height:44px;border-radius:8px;object-fit:cover;flex-shrink:0;" onerror="this.style.display=\'none\'">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-weight:600;font-size:0.9em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(g.name || '') + '</div>' +
            '<div style="font-size:0.75em;color:var(--text-muted);">.' + escHtml(g.shortCode || '') + ' · 👥 ' + (g.memberCount || 0) + '</div>' +
          '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  } catch(e) {
    area.innerHTML = '<div style="color:var(--error);padding:20px;">加载失败: ' + e.message + '</div>';
  }
}

async function searchGroups() {
  const input = document.getElementById('groupSearchInput');
  const results = document.getElementById('groupSearchResults');
  if (!input || !results) return;
  const q = input.value.trim();
  if (!q) return;
  results.innerHTML = '<div style="color:var(--text-muted);">搜索中...</div>';
  try {
    const r = await apiCall('/api/vrc/groups?query=' + encodeURIComponent(q) + '&n=20');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const groups = await r.json();
    if (!groups || !groups.length) {
      results.innerHTML = '<div style="color:var(--text-muted);">未找到结果</div>';
      return;
    }
    results.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;">' +
      groups.map(g => {
        const icon = proxyImg(g.iconUrl || g.bannerUrl || '');
        return '<div onclick="openGroupDetail(\'' + (g.id || '') + '\')" style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg-glass);border:1px solid var(--border);border-radius:10px;cursor:pointer;">' +
          '<img src="' + escHtml(icon) + '" style="width:44px;height:44px;border-radius:8px;object-fit:cover;flex-shrink:0;" onerror="this.style.display=\'none\'">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-weight:600;font-size:0.9em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(g.name || '') + '</div>' +
            '<div style="font-size:0.75em;color:var(--text-muted);">.' + escHtml(g.shortCode || '') + ' · 👥 ' + (g.memberCount || 0) + '</div>' +
          '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  } catch(e) {
    results.innerHTML = '<div style="color:var(--error);">搜索失败: ' + e.message + '</div>';
  }
}

function initAssetsTab() {
  document.querySelectorAll('#assetsPanel .cat-btn').forEach(b => b.classList.remove('active', 'btn-primary'));
  const btn = document.getElementById('cat-assets-balance');
  if (btn) {
    btn.classList.add('active', 'btn-primary');
    switchAssetsPage('balance');
  }
}

let _assetsGen = 0;  // incremented each time a sub-tab is clicked

function switchAssetsPage(page) {
  document.querySelectorAll('#assetsPanel .cat-btn').forEach(b => b.classList.remove('active', 'btn-primary'));
  const btn = document.getElementById('cat-assets-' + page);
  if (btn) btn.classList.add('active', 'btn-primary');

  const content = document.getElementById('assetsContentArea');
  content.innerHTML = '<div style="color:var(--text-muted);margin:20px;">加载中... (Loading...)</div>';

  const gen = ++_assetsGen;  // capture current generation
  if (page === 'balance') fetchBalance(content, gen);
  else if (page === 'store') fetchStore(content, gen);
  else if (page === 'tx') fetchTransactions(content, gen);
  else if (page === 'sub') fetchSubscriptions(content, gen);
  else if (page === 'gallery') fetchGalleryOnly(content, gen);
  else if (page === 'prints') fetchPrints(content, gen);
  else if (page === 'emoji') fetchEmoji(content, gen);
}

async function fetchBalance(container, gen) {
  try {
    const me = await (await apiCall('/api/vrc/auth/user')).json();
    if (_assetsGen !== gen) return;
    if (!me || !me.id) throw new Error("Not logged in");
    const bal = await (await apiCall(`/api/vrc/user/${me.id}/balance`)).json();
    if (_assetsGen !== gen) return;
    container.innerHTML = `
      <h2 style="margin-bottom:16px;">👛 钱包余额</h2>
      <div class="my-profile-card" style="display:flex;align-items:center;gap:20px;max-width:400px;">
        <div style="width:60px;height:60px;background:var(--bg-glass);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:2rem;color:var(--warning);">🪙</div>
        <div>
          <div style="font-size:0.8rem;color:var(--text-muted);">当前 VRChat 点数 / Credits</div>
          <div style="font-size:1.8rem;font-weight:700;color:var(--text-primary);">${bal.balance||0} <span style="font-size:0.5em;color:var(--text-muted);">VRC</span></div>
        </div>
      </div>
      <p style="margin-top:12px;color:var(--text-muted);font-size:0.85rem;">可在 VRChat 内购买创作者经济商品或订阅。</p>
    `;
  } catch(e) {
    container.innerHTML = `<div style="color:var(--error);">Failed to load balance: ${e.message}</div>`;
  }
}

async function fetchStore(container, gen) {
  try {
    container.innerHTML = '<div style="color:var(--text-muted);margin:20px;">加载商店中...</div>';
    const [balResp, listResp] = await Promise.all([
      apiCall('/api/vrc/economy/balance'),
      apiCall('/api/vrc/economy/listings?n=20&offset=0')
    ]);
    if (_assetsGen !== gen) return;

    let balHtml = '';
    if (balResp.ok) {
      const bal = await balResp.json();
      const credits = bal.balance ?? bal.credits ?? bal.amount ?? '—';
      balHtml = `<div style="display:flex;align-items:center;gap:12px;padding:14px 18px;background:linear-gradient(135deg,rgba(167,139,250,0.15),rgba(99,102,241,0.1));border:1px solid rgba(167,139,250,0.3);border-radius:12px;margin-bottom:20px;">
        <span style="font-size:1.6em;">💎</span>
        <div>
          <div style="font-size:0.75em;color:var(--text-muted);font-weight:600;letter-spacing:.05em;text-transform:uppercase;">VRChat Credits</div>
          <div style="font-size:1.4em;font-weight:700;color:#a78bfa;">${escHtml(String(credits))}</div>
        </div>
        <a href="https://vrchat.com/home/marketplace/storefront" target="_blank" class="btn btn-secondary" style="margin-left:auto;font-size:0.8em;">🛒 打开商店</a>
      </div>`;
    }

    let listingsHtml = '';
    if (listResp.ok) {
      const data = await listResp.json();
      const items = Array.isArray(data) ? data : (data.listings || data.results || []);
      if (items.length) {
        listingsHtml = '<h3 style="font-size:0.9rem;margin-bottom:12px;">🏷️ 商店商品</h3>' +
          '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;">' +
          items.map(item => {
            const img = proxyImg(item.thumbnailImageUrl || item.imageUrl || '');
            const name = escHtml(item.displayName || item.name || item.id || '商品');
            const price = item.priceTokens != null ? `💎 ${item.priceTokens}` : (item.price ? `$${(item.price/100).toFixed(2)}` : '');
            const type = escHtml(item.productType || item.type || '');
            return `<div style="background:var(--bg-glass);border:1px solid var(--border);border-radius:10px;overflow:hidden;cursor:pointer;" onclick="window.open('https://vrchat.com/home/marketplace','_blank')">
              ${img ? `<img src="${img}" style="width:100%;aspect-ratio:4/3;object-fit:cover;" loading="lazy" onerror="this.style.display='none'">` : '<div style="width:100%;aspect-ratio:4/3;background:var(--bg-secondary);"></div>'}
              <div style="padding:8px 10px;">
                <div style="font-size:0.85em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${name}</div>
                <div style="font-size:0.72em;color:var(--text-muted);">${type}</div>
                ${price ? `<div style="font-size:0.8em;color:#a78bfa;font-weight:600;margin-top:4px;">${price}</div>` : ''}
              </div>
            </div>`;
          }).join('') + '</div>';
      } else {
        listingsHtml = '<div style="color:var(--text-muted);font-size:0.85em;">暂无上架商品，或此功能需要 VRC+ Creator 权限。</div>';
      }
    } else {
      // Listings may require special perms - just link to website
      listingsHtml = `<div style="padding:20px;text-align:center;background:var(--bg-glass);border:1px solid var(--border);border-radius:10px;">
        <div style="font-size:2em;margin-bottom:8px;">🏪</div>
        <div style="font-size:0.85em;color:var(--text-muted);margin-bottom:12px;">商品列表需要在 VRChat 网站查看</div>
        <a href="https://vrchat.com/home/marketplace/storefront" target="_blank" class="btn btn-primary" style="font-size:0.85em;">🔗 打开 VRChat 商店</a>
      </div>`;
    }

    container.innerHTML = '<h2 style="margin-bottom:16px;">🏪 商店浏览</h2>' + balHtml + listingsHtml;
  } catch(e) {
    container.innerHTML = '<div style="color:var(--error);">加载失败: ' + e.message + '</div>';
  }
}

async function fetchTransactions(container) {
  try {
    const r = await apiCall('/api/vrc/Steam/transactions');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const tx = await r.json();
    container.innerHTML = '<h2 style="margin-bottom:16px;">💸 交易记录</h2>';
    if (!tx || (Array.isArray(tx) && tx.length === 0)) {
      container.innerHTML += '<div style="color:var(--text-muted);">暂无交易记录</div>';
      return;
    }
    const items = Array.isArray(tx) ? tx : [tx];
    const statusColors = {succeeded:'#86efac',expired:'#fbbf24',failed:'#f87171'};
    const statusLabels = {succeeded:'✅ 成功',expired:'⏰ 已过期',failed:'❌ 失败'};
    container.innerHTML += items.map(t => {
      const sub = t.subscription || {};
      const amt = sub.amount ? (sub.amount / 100).toFixed(2) : '—';
      const created = t.created_at ? new Date(t.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}) : '';
      const st = t.status || 'unknown';
      const stColor = statusColors[st] || 'var(--text-muted)';
      const stLabel = statusLabels[st] || st;
      const giftTo = t.isGift && t.targetDisplayName ? ' → 🎁 ' + escHtml(t.targetDisplayName) : '';
      const bulkLabel = t.isBulkGift ? ' (批量礼物)' : '';
      return '<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg-glass);border:1px solid var(--border);border-radius:8px;margin-bottom:8px;">' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-weight:500;font-size:0.88em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(sub.description || t.id) + giftTo + bulkLabel + '</div>' +
          '<div style="font-size:0.75em;color:var(--text-muted);margin-top:2px;">' + created + '</div>' +
        '</div>' +
        '<div style="text-align:right;flex-shrink:0;">' +
          '<div style="font-size:0.85em;font-weight:600;">$' + amt + ' USD</div>' +
          '<div style="font-size:0.72em;font-weight:600;color:' + stColor + ';">' + stLabel + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch(e) {
    container.innerHTML = '<div style="color:var(--error);">加载失败: ' + e.message + '</div>';
  }
}

async function fetchSubscriptions(container) {
  try {
    const subs = await (await apiCall('/api/vrc/auth/user/subscription')).json();
    container.innerHTML = '<h2 style="margin-bottom:16px;">⭐ VRC+ 订阅</h2>';
    if (!subs || subs.length === 0) {
      container.innerHTML += '<div style="color:var(--text-muted);">当前无有效的 VRC+ 订阅 (No active subscriptions)</div>';
      return;
    }
    container.innerHTML += subs.map(s => `<div class="my-profile-card" style="margin-bottom:12px;">
      <h3 style="color:#a78bfa;margin-bottom:4px;">${escHtml(s.description || s.tier || 'VRChat Plus')}</h3>
      <div style="font-size:0.8rem;color:var(--text-secondary);">
        状态: <span style="color:var(--success);">${s.status||'active'}</span><br>
        类型: ${s.store||'Unknown'}<br>
        过期时间: ${s.expires ? new Date(s.expires).toLocaleString() : '永久'}
      </div>
    </div>`).join('');
  } catch(e) {
    container.innerHTML = `<div style="color:var(--error);">Failed to load subscriptions: ${e.message}</div>`;
  }
}

async function fetchGallery(container, gen) {
  try {
    const me = await (await apiCall('/api/vrc/auth/user')).json();
    if (_assetsGen !== gen) return;
    const [rGallery, rPrints] = await Promise.all([
      apiCall('/api/vrc/files?tag=gallery&n=60'),
      apiCall('/api/vrc/prints/user/' + me.id + '?n=60&offset=0'),
    ]);
    if (_assetsGen !== gen) return;
    const galleryFiles = rGallery.ok ? await rGallery.json() : [];
    const prints = rPrints.ok ? await rPrints.json() : [];

    container.innerHTML = '<h2 style="margin-bottom:16px;">🖼️ 相册与文件</h2>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;padding:12px;background:var(--bg-glass);border:1px solid var(--border);border-radius:8px;flex-wrap:wrap;">' +
        '<label style="font-size:0.85em;color:var(--text-secondary);">📤 上传到 VRC+ 相册:</label>' +
        '<input type="file" id="galleryUploadInput" accept="image/*" style="font-size:0.8em;color:var(--text-muted);">' +
        '<button class="btn btn-primary" onclick="uploadToVRC(\'gallery\', document.getElementById(\'galleryUploadInput\'), () => switchAssetsPage(\'gallery\'))" style="font-size:0.8em;padding:4px 12px;">上传</button>' +
        '<span id="uploadStatus_gallery" style="font-size:0.75em;"></span>' +
      '</div>';

    // Gallery images section
    container.innerHTML += '<h3 style="font-size:0.95rem;margin-bottom:10px;">📸 VRC+ 相册 (' + galleryFiles.length + ')</h3>';
    if (galleryFiles.length) {
      container.innerHTML += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;margin-bottom:24px;">' +
        galleryFiles.map(f => {
          // Find the latest complete version with a file URL
          const imgUrl = proxyImg(extractFileVersionUrl(f));
          return '<div style="border-radius:8px;overflow:hidden;background:var(--bg-glass);border:1px solid var(--border);cursor:pointer;" onclick="if(this.querySelector(\'img\').src)window.open(this.querySelector(\'img\').src,\'_blank\')">' +
            '<img src="' + escHtml(imgUrl) + '" style="width:100%;aspect-ratio:1/1;object-fit:cover;display:block;" loading="lazy" onerror="this.style.display=\'none\'">' +

            '<div style="padding:4px 6px;font-size:0.68em;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(f.name || '') + '</div>' +
          '</div>';
        }).join('') +
      '</div>';
    } else {
      container.innerHTML += '<div style="color:var(--text-muted);font-size:0.85em;margin-bottom:24px;">暂无 VRC+ 相册图片（需在游戏内或官网上传）</div>';
    }

    // Prints (polaroid photos) section
    container.innerHTML += '<h3 style="font-size:0.95rem;margin-bottom:10px;">🎞️ 拍立得照片 (' + prints.length + ')</h3>';
    if (prints.length) {
      container.innerHTML += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;">' +
        prints.map(p => {
          // VRChat API /prints/user/{id}: image is at p.files.image
          const rawUrl = (p.files && p.files.image) ? p.files.image
                        : (p.imageUrl || p.thumbnailImageUrl || '');
          const imgUrl = proxyImg(rawUrl);
          const world = p.worldName || p.worldId || '';
          const author = p.ownerDisplayName || '';
          const date = p.createdAt ? new Date(p.createdAt).toLocaleDateString('zh-CN') : '';
          // Polaroid-style card
          return '<div onclick="window.open(\'' + escHtml(imgUrl) + '\',\'_blank\')" style="cursor:pointer;background:#fff;border-radius:4px;padding:10px 10px 20px;box-shadow:0 4px 16px rgba(0,0,0,0.4);transition:transform 0.15s;" onmouseover="this.style.transform=\'scale(1.03)\'" onmouseout="this.style.transform=\'\'">'+
            '<img src="' + escHtml(imgUrl) + '" style="width:100%;aspect-ratio:4/3;object-fit:cover;display:block;border-radius:2px;" loading="lazy" onerror="this.style.display=\'none\'">' +

            '<div style="margin-top:8px;">' +
              '<div style="font-size:0.7em;color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:sans-serif;">' + escHtml(world) + '</div>' +
              '<div style="font-size:0.65em;color:#888;font-family:sans-serif;display:flex;justify-content:space-between;">' +
                '<span>' + escHtml(author) + '</span><span>' + date + '</span>' +
              '</div>' +
            '</div>' +
          '</div>';
        }).join('') +
      '</div>';
    } else {
      container.innerHTML += '<div style="color:var(--text-muted);font-size:0.85em;">暂无拍立得照片（需要 VRC+ 并在游戏中拍摄）</div>';
    }
  } catch(e) {
    container.innerHTML = '<div style="color:var(--error);">加载失败: ' + e.message + '</div>';
  }
}


async function fetchEmoji(container, gen) {
  try {
    container.innerHTML = '<div style="color:var(--text-muted);margin:20px;">加载中...</div>';
    const [rEmoji, rEmojiAnim, rSticker] = await Promise.all([
      apiCall('/api/vrc/files?tag=emoji&n=100'),
      apiCall('/api/vrc/files?tag=emojianimated&n=100'),
      apiCall('/api/vrc/files?tag=sticker&n=100'),
    ]);
    const emojis = rEmoji.ok ? await rEmoji.json() : [];
    const emojisAnim = rEmojiAnim.ok ? await rEmojiAnim.json() : [];
    const stickers = rSticker.ok ? await rSticker.json() : [];
    if (_assetsGen !== gen) return;
    const allEmojis = emojis.concat(emojisAnim);

    const renderFileGrid = (files, emptyText) => {
      if (!files || !files.length) return '<div style="color:var(--text-muted);font-size:0.85em;margin-bottom:20px;">' + emptyText + '</div>';
      return '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:10px;margin-bottom:20px;">' +
        files.map(f => {
          const imgUrl = proxyImg(extractFileVersionUrl(f));
          const isAnimated = f.tags && f.tags.includes('emojianimated');
          return '<div title="' + escHtml(f.name || f.id) + '" style="background:var(--bg-glass);border:1px solid var(--border);border-radius:8px;overflow:hidden;display:flex;flex-direction:column;align-items:center;padding:6px;gap:4px;position:relative;">' +
            (isAnimated ? '<span style="position:absolute;top:4px;right:4px;font-size:0.55em;background:#6366f1;color:#fff;padding:1px 4px;border-radius:3px;">GIF</span>' : '') +
            '<img src="' + escHtml(imgUrl) + '" style="width:56px;height:56px;object-fit:contain;" loading="lazy" onerror="this.parentElement.style.opacity=\'0.4\'; this.style.display=\'none\'; this.insertAdjacentHTML(\'afterend\', \'<span style=\'font-size:1.8rem;\'>📦</span>\')">' +
            '<div style="font-size:0.6em;color:var(--text-muted);text-align:center;width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(f.name || '') + '</div>' +
          '</div>';
        }).join('') +
      '</div>';
    };

    container.innerHTML = '<h2 style="margin-bottom:16px;">�� 表情与贴纸</h2>' +
      '<div class="vrc-upload-row">' +
        makeUploadCard({title:'😊 上传静态表情', hint:'PNG · 最大 10MB · 最大 1024×1024', tag:'emoji', accept:'image/png,image/jpeg,image/webp', refreshPage:'emoji'}) +
        makeUploadCard({title:'🎞️ 上传动态表情 (GIF)', hint:'GIF → 自动转精灵图 · 最大 10MB', tag:'emojianimated', accept:'image/gif', refreshPage:'emoji'}) +
        makeUploadCard({title:'🏷️ 上传贴纸', hint:'PNG · 最大 10MB · 最大 1024×1024', tag:'sticker', accept:'image/png,image/jpeg,image/webp', refreshPage:'emoji'}) +
      '</div>' +
      '<h3 style="font-size:0.9rem;margin-bottom:10px;">自定义表情 (' + allEmojis.length + ')</h3>' +
      renderFileGrid(allEmojis, '暂无自定义表情（需要 VRC+，可在官网或此处上传）') +
      '<h3 style="font-size:0.9rem;margin-bottom:10px;">贴纸 (' + stickers.length + ')</h3>' +
      renderFileGrid(stickers, '暂无贴纸（需要 VRC+，可在官网或此处上传）');
  } catch(e) {
    container.innerHTML = '<div style="color:var(--error);">加载失败: ' + e.message + '</div>';
  }
}



async function loadMyGroups() {
  const el = document.getElementById('friendList');
  if (el) el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">加载群组中...</div>';
  try {
    const meResp = await apiCall('/api/vrc/auth/user');
    const me = await meResp.json();
    const r = await apiCall('/api/vrc/users/' + me.id + '/groups');
    if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + await r.text());
    const groups = await r.json();
    myGroupsCache = groups || [];
    if (!groups || !groups.length) {
      el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">暂无群组</div>';
      return;
    }
    // Sort: own groups first, then rest
    const owned = groups.filter(g => g.ownerId === me.id || g.userId === me.id);
    const other = groups.filter(g => g.ownerId !== me.id && g.userId !== me.id);
    let html = '';
    if (owned.length) {
      html += '<div style="padding:8px 0 4px;font-size:0.75em;font-weight:700;color:var(--text-muted);letter-spacing:0.05em;text-transform:uppercase;">我创建的群组</div>';
      html += owned.map(g => groupCardHtml(g, me.id)).join('');
      html += '<div style="margin:8px 0;border-top:1px solid var(--border);"></div>';
    }
    html += other.map(g => groupCardHtml(g, me.id)).join('');
    el.innerHTML = html;
    document.getElementById('friendStats').textContent = '共 ' + groups.length + ' 个群组';
  } catch(e) {
    if (el) el.innerHTML = '<div style="color:var(--error);padding:20px;">加载失败: ' + e.message + '</div>';
  }
}

function groupCardHtml(g, myId) {
  const gJson = JSON.stringify(g).replace(/\\/g,'\\\\').replace(/"/g,'&quot;');
  const isOwner = g.ownerId === myId;
  return '<div class="friend-card" onclick="openGroupDetail(' + JSON.stringify(g.groupId||g.id) + ')" style="cursor:pointer;">' +
    '<div class="friend-avatar-wrap" style="border-radius:10px;">' +
      '<img src="' + escHtml(proxyImg(g.iconUrl||'')) + '" style="border-radius:10px;object-fit:cover;" onerror="this.style.display=\'none\'">' +
    '</div>' +
    '<div class="friend-info">' +
      '<div class="friend-name">' + escHtml(g.name||'') + (isOwner ? ' <span style="font-size:0.65em;background:#6366f122;color:#a5b4fc;border:1px solid #6366f144;padding:2px 6px;border-radius:99px;">创建者</span>' : '') + '</div>' +
      '<div class="friend-location" style="font-size:0.78em;color:var(--text-muted);">.' + escHtml(g.shortCode||'') + ' · 👥 ' + (g.memberCount||0) + '</div>' +
    '</div>' +
  '</div>';
}

async function openGroupDetail(groupId) {
  // Ensure group modal exists
  if (!document.getElementById('groupDetailModal')) {
    const html = `<div id="groupDetailModal" class="modal hidden" onclick="if(event.target===this)this.classList.add('hidden')">
      <div class="modal-content" style="max-width:560px;padding:0;overflow:hidden;">
        <div id="gdBanner" style="height:120px;background:var(--bg-secondary);background-size:cover;background-position:center;position:relative;">
          <button onclick="document.getElementById('groupDetailModal').classList.add('hidden')" style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.6);border:none;color:#fff;border-radius:99px;width:28px;height:28px;cursor:pointer;font-size:1rem;">\u00d7</button>
        </div>
        <div style="padding:0 24px 24px;">
          <div style="display:flex;gap:16px;align-items:flex-end;margin:-28px 0 12px;position:relative;z-index:2;">
            <div style="width:56px;height:56px;border-radius:10px;overflow:hidden;border:2px solid var(--bg-primary);background:var(--bg-card);flex-shrink:0;">
              <img id="gdIcon" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'">
            </div>
            <div style="flex:1;">
              <div id="gdName" style="font-size:1.1rem;font-weight:700;"></div>
              <div id="gdShortCode" style="font-size:0.75em;color:var(--text-muted);"></div>
            </div>
          </div>
          <div id="gdStats" style="display:flex;gap:8px;flex-wrap:wrap;font-size:0.8em;color:var(--text-secondary);margin-bottom:10px;"></div>
          <div id="gdActions" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;"></div>
          <div id="gdDesc" style="font-size:0.85em;color:var(--text-secondary);line-height:1.6;max-height:180px;overflow-y:auto;white-space:pre-line;"></div>
        </div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }
  const modal = document.getElementById('groupDetailModal');
  modal.classList.remove('hidden');
  document.getElementById('gdName').textContent = '加载中...';
  document.getElementById('gdDesc').textContent = '';
  document.getElementById('gdStats').innerHTML = '';
  document.getElementById('gdBanner').style.backgroundImage = '';
  document.getElementById('gdIcon').src = '';
  document.getElementById('gdShortCode').textContent = '';
  try {
    const r = await apiCall('/api/vrc/groups/' + groupId);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const g = await r.json();
    document.getElementById('gdBanner').style.backgroundImage = g.bannerUrl ? 'url(' + proxyImg(g.bannerUrl) + ')' : '';
    document.getElementById('gdIcon').src = proxyImg(g.iconUrl || '');
    document.getElementById('gdName').textContent = g.name || '';
    document.getElementById('gdShortCode').textContent = '.' + (g.shortCode || '');
    document.getElementById('gdDesc').textContent = g.description || '暂无简介';
    document.getElementById('gdStats').innerHTML =
      '<span>👥 ' + (g.memberCount || 0) + ' 成员</span>' +
      '<span style="opacity:0.3;margin:0 4px;">|</span>' +
      '<span>' + (g.joinState === 'closed' ? '🔒 闭门' : g.joinState === 'invite' ? '✉️ 邀请' : g.joinState === 'request' ? '✋ 申请' : '🔓 公开') + '</span>' +
      (g.languages && g.languages.length ? '<span style="opacity:0.3;margin:0 4px;">|</span><span>🌐 ' + g.languages.join(', ') + '</span>' : '');

    // Render Actions
    let actionHtml = '';
    if (g.myMember) {
      const myId = g.myMember.userId;
      const vis = g.myMember.visibility; // 'visible', 'hidden', 'friends'
      const oppVis = vis === 'visible' ? 'hidden' : 'visible';
      const visText = vis === 'visible' ? '👁️ 个人资料可见' : (vis === 'friends' ? '👥 仅好友可见' : '👻 资料页隐藏');
      actionHtml += `<button onclick="vrcGroupAction('${groupId}','visibility','${myId}','${oppVis}')" style="background:var(--bg-glass);border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:0.75em;color:var(--text-primary);cursor:pointer;" title="点击切换">${visText}</button>`;
      actionHtml += `<button onclick="vrcGroupAction('${groupId}','leave')" style="background:#ef444422;border:1px solid #ef444444;border-radius:6px;padding:4px 10px;font-size:0.75em;color:#ef4444;cursor:pointer;">🚪 退出群组</button>`;
    } else {
      actionHtml += `<button onclick="vrcGroupAction('${groupId}','join')" style="background:linear-gradient(135deg,var(--accent),var(--accent-light));border:none;border-radius:6px;padding:4px 10px;font-size:0.75em;color:#fff;cursor:pointer;font-weight:600;">➕ 申请加入</button>`;
    }
    document.getElementById('gdActions').innerHTML = actionHtml;

  } catch(e) {
    document.getElementById('gdName').textContent = '加载失败: ' + e.message;
  }
}

async function vrcGroupAction(groupId, action, myId, nextVis) {
  try {
    let url, method = 'POST', body = null;
    if (action === 'leave') {
      if(!confirm('确定要退出该群组吗？')) return;
      url = '/api/vrc/groups/' + groupId + '/leave';
    } else if (action === 'join') {
      url = '/api/vrc/groups/' + groupId + '/join';
    } else if (action === 'visibility') {
      url = '/api/vrc/groups/' + groupId + '/members/' + myId;
      method = 'PUT';
      body = JSON.stringify({ visibility: nextVis });
    }
    
    let opts = { method };
    if (body) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = body;
    }
    
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(await r.text());
    
    // Refresh modal
    openGroupDetail(groupId);
  } catch(e) {
    alert('操作失败: ' + e.message);
  }
}


async function fetchMutualGroups(userId, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '<span style="color:var(--text-muted);font-size:0.8em;">加载中...</span>';
  try {
    if (!myGroupsCache) {
      const me = await apiCall('/api/vrc/auth/user');
      const r = await apiCall('/api/vrc/users/' + me.id + '/groups');
      myGroupsCache = await r.json();
    }
    const r2 = await apiCall('/api/vrc/users/' + userId + '/groups');
    const theirGroups = await r2.json();
    const myIds = new Set((myGroupsCache||[]).map(g => g.groupId||g.id));
    const mutual = (theirGroups||[]).filter(g => myIds.has(g.groupId||g.id));
    if (!mutual.length) { el.innerHTML = '<span style="color:var(--text-muted);font-size:0.8em;">暂无共同群组</span>'; return; }
    el.innerHTML = '<div style="display:flex;gap:6px;flex-wrap:wrap;">' + mutual.map(g => 
      '<div onclick="openGroupDetail(' + JSON.stringify(g.groupId||g.id) + ')" style="background:var(--bg-glass);border:1px solid var(--border);border-radius:6px;padding:4px 8px;cursor:pointer;font-size:0.75em;display:flex;align-items:center;gap:6px;">' +
        '<img src="' + escHtml(proxyImg(g.iconUrl||'')) + '" style="width:18px;height:18px;border-radius:3px;" onerror="this.style.display=\'none\'">' +
        escHtml(g.name) +
      '</div>'
    ).join('') + '</div>';
  } catch(e) {
    el.innerHTML = '<span style="color:var(--text-muted);font-size:0.8em;">加载失败</span>';
  }
}

async function fetchMutualFriends(userId, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '<span style="color:var(--text-muted);font-size:0.8em;">加载中...</span>';
  try {
    // Correct VRChat API endpoint for mutual friends (same as VRCX uses)
    const r = await apiCall('/api/vrc/users/' + userId + '/mutuals/friends');
    if (r.status === 403) {
      // VRChat is still rolling out mutual friends - fall back to co-located friends
      await fetchMutualFriendsFallback(userId, el);
      return;
    }
    if (!r.ok) { await fetchMutualFriendsFallback(userId, el); return; }
    const json = await r.json();
    const list = Array.isArray(json) ? json : (json.mutualFriends || json.users || []);
    if (!list.length) {
      el.innerHTML = '<span style="color:var(--text-muted);font-size:0.8em;">暂无共同好友</span>';
      return;
    }
    const renderUser = u => {
      const safeJson = JSON.stringify(u).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
      const t = getTrustInfo(u.tags || []);
      const thumb = proxyImg(u.profilePicOverrideThumbnail || u.userIcon || u.currentAvatarThumbnailImageUrl || '');
      return '<div onclick="openFriendProfile(this);" data-friend="' + safeJson + '" style="display:flex;align-items:center;gap:8px;width:155px;padding:6px 8px;border-radius:8px;background:var(--bg-glass);border:1px solid var(--border);cursor:pointer;">' +
        '<img src="' + escHtml(thumb) + '" style="width:28px;height:28px;border-radius:50%;flex-shrink:0;object-fit:cover;" onerror="this.style.display=\'none\'">' +
        '<div style="flex:1;min-width:0;"><div style="font-size:0.78em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:' + t.color + ';">' + escHtml(u.displayName || '') + '</div></div></div>';
    };
    el.innerHTML = '<div style="font-size:0.72em;font-weight:700;color:var(--text-muted);margin-bottom:8px;">共同好友 (' + list.length + ')</div><div style="display:flex;flex-wrap:wrap;gap:6px;">' + list.map(renderUser).join('') + '</div>';
  } catch(e) {
    el.innerHTML = '<span style="color:var(--text-muted);font-size:0.8em;">加载失败: ' + e.message + '</span>';
  }
}

async function fetchMutualFriendsFallback(userId, el) {
  let myFriends = window._allFriendsCache || window.allFriends || [];
  if (!myFriends.length) {
    const pages = [];
    let offset = 0;
    while (offset < 2000) {
      const r = await apiCall('/api/vrc/auth/user/friends?n=100&offset=' + offset + '&offline=true');
      if (!r.ok) break;
      const batch = await r.json();
      if (!batch || !batch.length) break;
      pages.push(...batch);
      if (batch.length < 100) break;
      offset += 100;
    }
    myFriends = pages;
    window._allFriendsCache = myFriends;
  }
  const detailR = await apiCall('/api/vrc/users/' + userId);
  const targetUser = detailR.ok ? await detailR.json() : {};
  const targetLoc = targetUser.location || '';
  const colocated = targetLoc && targetLoc.startsWith('wrld_') ? myFriends.filter(f => f.location === targetLoc) : [];
  const renderUser = u => {
    const safeJson = JSON.stringify(u).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
    const t = getTrustInfo(u.tags || []);
    const thumb = proxyImg(u.profilePicOverrideThumbnail || u.userIcon || u.currentAvatarThumbnailImageUrl || '');
    return '<div onclick="openFriendProfile(this);" data-friend="' + safeJson + '" style="display:flex;align-items:center;gap:8px;width:155px;padding:6px 8px;border-radius:8px;background:var(--bg-glass);border:1px solid var(--border);cursor:pointer;">' +
      '<img src="' + escHtml(thumb) + '" style="width:28px;height:28px;border-radius:50%;flex-shrink:0;object-fit:cover;" onerror="this.style.display=\'none\'">' +
      '<div style="flex:1;min-width:0;"><div style="font-size:0.78em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:' + t.color + ';">' + escHtml(u.displayName || '') + '</div></div></div>';
  };
  if (colocated.length) {
    el.innerHTML = '<div style="font-size:0.72em;font-weight:700;color:var(--text-muted);margin-bottom:8px;">同在此实例的好友 (' + colocated.length + ')</div><div style="display:flex;flex-wrap:wrap;gap:6px;">' + colocated.map(renderUser).join('') + '</div>';
  } else {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:0.8em;line-height:1.6;padding:8px 0;">ℹ️ VRChat 正在逐步向所有用户开放共同好友功能（/users/{id}/mutuals 端点），你的账号可能暂未激活此功能<br>' +
      (targetLoc && targetLoc.startsWith('wrld_') ? '此用户当前不在你任何好友所在的实例。' : '此用户不在线或位置不可见。') + '</div>';
  }
}


// ═══════════════════════════════════════════════════════════
// SIDEBAR MINI PROFILE
// ═══════════════════════════════════════════════════════════
function renderSidebarMiniProfile(u) {
  const el = document.getElementById('sidebarMyMiniProfile');
  if (!el) return;
  const statusColor = {active:'#3b82f6','join me':'#a855f7','ask me':'#f59e0b',busy:'#ef4444',offline:'#475569'}[u.status] || '#22c55e';
  const vrcP = isVRCPlus && isVRCPlus(u.tags||[]);
  const thumb = proxyImg(u.profilePicOverrideThumbnail||u.userIcon||u.currentAvatarThumbnailImageUrl||'');
  el.innerHTML = `
    <div class="mini-dot" style="background:${statusColor};"></div>
    <img class="mini-avatar" src="${escHtml(thumb)}" onerror="this.style.display='none'">
    <div style="flex:1;min-width:0;">
      <div class="mini-name">${escHtml(u.displayName||'')}${vrcP?' <span style="font-size:0.65em;background:rgba(167,139,250,0.2);color:#a78bfa;border:1px solid rgba(167,139,250,0.4);padding:1px 5px;border-radius:99px;">VRC+</span>':''}</div>
      <div class="mini-status">${escHtml(u.username||'')} · 点击查看资料</div>
    </div>
  `;
  el.onclick = () => fetchMyProfile();
}

// ═══════════════════════════════════════════════════════════
// CONTEXT MENU ENGINE
// ═══════════════════════════════════════════════════════════
let _ctxMenuEl = null;
function closeCtxMenu() {
  if (_ctxMenuEl) { _ctxMenuEl.remove(); _ctxMenuEl = null; }
}
document.addEventListener('click', closeCtxMenu);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCtxMenu(); });

function buildCtxMenu(sections) {
  closeCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  sections.forEach(section => {
    const sec = document.createElement('div');
    sec.className = 'ctx-menu-section';
    if (section.label) {
      const hdr = document.createElement('div');
      hdr.className = 'ctx-menu-header';
      hdr.textContent = section.label;
      sec.appendChild(hdr);
    }
    section.items.forEach(item => {
      if (!item) return;
      const btn = document.createElement('button');
      btn.className = 'ctx-menu-item' + (item.danger ? ' danger' : '');
      btn.innerHTML = `<span class="ctx-icon">${item.icon||''}</span><span>${item.label}</span>`;
      btn.onclick = (e) => { e.stopPropagation(); closeCtxMenu(); item.action && item.action(); };
      sec.appendChild(btn);
    });
    menu.appendChild(sec);
  });
  document.body.appendChild(menu);
  _ctxMenuEl = menu;
  return menu;
}

function positionCtxMenu(e, menu) {
  e.stopPropagation();
  let rect;
  if (e.currentTarget && e.currentTarget.getBoundingClientRect) {
    rect = e.currentTarget.getBoundingClientRect();
  } else if (e.target && e.target.getBoundingClientRect) {
    const btn = e.target.closest('.btn') || e.target;
    rect = btn.getBoundingClientRect();
  } else {
    rect = { bottom: e.clientY, left: e.clientX, top: e.clientY };
  }
  let top = rect.bottom + 6, left = rect.left;
  const mh = menu.offsetHeight || 300, mw = menu.offsetWidth || 240;
  if (top + mh > window.innerHeight) top = (rect.top || e.clientY) - mh - 6;
  if (left + mw > window.innerWidth) left = window.innerWidth - mw - 8;
  menu.style.top = Math.max(8, top) + 'px';
  menu.style.left = Math.max(8, left) + 'px';
}

// ═══════════════════════════════════════════════════════════
// FRIEND CONTEXT MENU (VRCX-style)
// ═══════════════════════════════════════════════════════════
function showFriendContextMenu(e) {
  e.stopPropagation();
  const f = currentFriendProfile;
  if (!f) return;
  const id = f.id || '';
  const name = f.displayName || '';
  const hasLocation = f.location && f.location.startsWith('wrld_');

  const menu = buildCtxMenu([
    { items: [
      { icon:'🔄', label:'刷新资料', action: () => {
        currentFriendProfile = null; const el = document.createElement('div');
        el.dataset.friend = JSON.stringify(f).replace(/&/g,'&amp;');
        openFriendProfile(el);
      }},
      { icon:'📋', label:'复制 ID', action: () => navigator.clipboard.writeText(id) },
      { icon:'🔗', label:'分享 VRChat 主页', action: () => window.open(`https://vrchat.com/home/user/${id}`, '_blank') },
    ]},
    { label:'位置互动', items: [
      hasLocation ? { icon:'📩', label:'申请加入实例', action: () => friendRequestJoin(id, name) } : null,
      hasLocation ? { icon:'📨', label:'发送带消息的申请', action: () => friendRequestJoinMsg(id, name) } : null,
      { icon:'👋', label:'发送戳一戳', action: () => sendPoke(id, name) },
    ].filter(Boolean)},
    { label:'群组', items: [
      { icon:'🏠', label:'邀请加入群组', action: () => alert('请在游戏内操作邀请加入群组') },
    ]},
    { label:'模型信息', items: [
      { icon:'🧑', label:'显示模型信息', action: () => {
        const avId = f.currentAvatarId; if (avId) window.open(`https://vrchat.com/home/avatar/${avId}`, '_blank');
      }},
      { icon:'👤', label:'显示备用模型信息', action: () => alert('备用模型信息在 VRChat 内查看') },
      { icon:'🛒', label:'显示正在使用的道具', action: () => alert('暂时没有任何道具信息') },
    ]},
    { label:'管理', items: [
      { icon:'🔇', label:'屏蔽', action: () => blockUser(id, name) },
      { icon:'🔕', label:'静音', action: () => muteUser(id, name) },
      { icon:'🚩', label:'举报作弊/盗模行为', action: () => window.open(`https://vrchat.com/home/user/${id}`, '_blank') },
    ]},
    { items: [
      { icon:'🗑️', label:'删除好友', danger: true, action: () => deleteFriend(id, name) },
    ]},
  ]);
  positionCtxMenu(e, menu);
}

async function friendRequestJoin(userId, name) {
  try {
    const r = await apiCall(`/api/vrc/user/${userId}/friendRequest`, {method:'POST'});
    alert(r.ok ? `✅ 已发送加入申请给 ${name}` : `❌ 发送失败：${r.status}`);
  } catch(e) { alert('失败: ' + e.message); }
}

function friendRequestJoinMsg(userId, name) {
  const msg = prompt(`发送带消息的加入申请给 ${name}：`);
  if (msg === null) return;
  apiCall(`/api/vrc/user/${userId}/friendRequest`, {method:'POST', json:{message:msg}})
    .then(r => alert(r.ok ? '✅ 申请已发送' : '❌ 发送失败'));
}

async function sendPoke(userId, name) {
  try {
    const r = await apiCall('/api/vrc/notification', {method:'POST', json:{receiverUserId:userId, type:'requestInvite', message:'戳一戳！'}});
    alert(r.ok ? `✅ 已向 ${name} 发送戳一戳` : `❌ 失败 ${r.status}`);
  } catch(e) { alert('失败: ' + e.message); }
}

async function blockUser(userId, name) {
  if (!confirm(`确认屏蔽 ${name}?`)) return;
  try {
    const r = await apiCall(`/api/vrc/auth/user/playermoderations`, {method:'POST', json:{moderated:userId, type:'block'}});
    if (r.ok) alert(`✅ 已成功屏蔽 ${name}`);
    else alert(`❌ 屏蔽失败: ${r.status}`);
  } catch(e) { alert('发生错误: ' + e.message); }
}

async function muteUser(userId, name) {
  if (!confirm(`确认静音 ${name}?`)) return;
  try {
    const r = await apiCall(`/api/vrc/auth/user/playermoderations`, {method:'POST', json:{moderated:userId, type:'mute'}});
    if (r.ok) alert(`✅ 已成功静音 ${name}`);
    else alert(`❌ 静音失败: ${r.status}`);
  } catch(e) { alert('发生错误: ' + e.message); }
}

async function fetchSharedInstances(userId) {
  try {
    const r = await apiCall(`/api/vrc/user/${userId}/instances`);
    const data = r.ok ? await r.json() : null;
    if (!data || !data.length) { alert('暂无共同进入过的房间记录'); return; }
    alert('共同进入过的房间:\n' + data.slice(0,10).map(i=>i.worldName||i.world||i).join('\n'));
  } catch(e) { alert('加载失败: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════
// SELF CONTEXT MENU
// ═══════════════════════════════════════════════════════════
function showSelfContextMenu(e) {
  e.stopPropagation();
  const u = myProfileData;
  if (!u) return;
  const id = u.id || '';
  const name = u.displayName || '';
  const menu = buildCtxMenu([
    { items: [
      { icon:'🔄', label:'刷新我的资料', action: () => { myProfileData=null; fetchMyProfile(); }},
      { icon:'🔗', label:'打开 VRChat 主页', action: () => window.open(`https://vrchat.com/home/user/${id}`, '_blank') },
      { icon:'📋', label:'复制 ID', action: () => navigator.clipboard.writeText(id).then(()=>{}) },
    ]},
    { label:'模型信息', items: [
      { icon:'🧑', label:'显示模型信息', action: () => {
        const avId = myProfileData && myProfileData.currentAvatarId;
        if (avId) window.open(`https://vrchat.com/home/avatar/${avId}`, '_blank');
        else alert('模型 ID 不可用');
      }},
      { icon:'👤', label:'显示备用模型信息', action: () => alert('请在游戏内查看备用模型') },
    ]},
    { label:'编辑资料', items: [
      { icon:'✏️', label:'社交状态', action: () => window.open('https://vrchat.com/home/profile', '_blank') },
      { icon:'🌍', label:'语言', action: () => window.open('https://vrchat.com/home/profile', '_blank') },
      { icon:'📝', label:'个人简介', action: () => window.open('https://vrchat.com/home/profile', '_blank') },
      { icon:'🏷️', label:'人称代词', action: () => window.open('https://vrchat.com/home/profile', '_blank') },
    ]},
  ]);
  positionCtxMenu(e, menu);
}

// ═══════════════════════════════════════════════════════════
// GALLERY ONLY (VRC+ 相册, no prints)
// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// GIF → PNG Spritesheet Converter (for emojianimated)
// ═══════════════════════════════════════════════════════════
async function gifToSpritesheet(file, fpsOverride) {
  // Parse GIF using gifuct-js
  const buf = await file.arrayBuffer();
  let frames;
  try {
    const gif = window.parseGIF(buf);
    frames = window.decompressFrames(gif, true);
  } catch(e) {
    throw new Error('无法解析 GIF: ' + e.message);
  }
  if (!frames || frames.length < 2) throw new Error('GIF 至少需要 2 帧！');

  // Auto-detect FPS from GIF frame delays (delay is in centiseconds)
  // gifuct-js exposes frame.delay in centiseconds (1/100 s)
  const avgDelayCentisec = frames.reduce((s, f) => s + (f.delay || 10), 0) / frames.length;
  const detectedFps = Math.round(100 / avgDelayCentisec);  // centisec → fps
  const fps = fpsOverride !== undefined ? Math.min(Math.max(fpsOverride, 1), 64) : Math.min(Math.max(detectedFps, 1), 64);

  // Clamp frames to VRChat limit (max 64)
  const SHEET_SIZE = 1024;
  const totalFrames = Math.min(frames.length, 64);
  // Pick best grid: 2x2 (4), 4x4 (16), 8x8 (64)
  let cols;
  if (totalFrames <= 4)  { cols = 2; }
  else if (totalFrames <= 16) { cols = 4; }
  else { cols = 8; }
  const rows = cols;
  const frameSize = SHEET_SIZE / cols;  // 512, 256, or 128

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SHEET_SIZE;
  const ctx = canvas.getContext('2d');

  // Patch all frames onto the canvas grid
  for (let i = 0; i < cols * rows && i < totalFrames; i++) {
    const f = frames[i];
    // Draw gifuct frame to a temp canvas
    const tmp = document.createElement('canvas');
    tmp.width = f.dims.width; tmp.height = f.dims.height;
    const tmpCtx = tmp.getContext('2d');
    const id = tmpCtx.createImageData(f.dims.width, f.dims.height);
    id.data.set(f.patch);
    tmpCtx.putImageData(id, 0, 0);
    const col = i % cols;
    const row = Math.floor(i / cols);
    ctx.drawImage(tmp, col * frameSize, row * frameSize, frameSize, frameSize);
  }

  // Export as PNG Blob
  const pngBlob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  return { blob: pngBlob, frames: totalFrames, framesOverTime: fps, detectedFps };
}

function makeUploadCard(opts) {
  // opts: { id, title, hint, tag, accept, refreshPage, showFps }
  const uniqueId = 'upl_' + opts.tag + '_' + Date.now();
  const isAnimated = opts.tag === 'emojianimated';
  return `<div class="vrc-upload-card">
    <h4>${opts.title}</h4>
    <div class="vrc-upload-zone" id="zone_${uniqueId}"
      ondragover="event.preventDefault();this.classList.add('dragover')"
      ondragleave="this.classList.remove('dragover')"
      ondrop="event.preventDefault();this.classList.remove('dragover');document.getElementById('${uniqueId}').files=event.dataTransfer.files;onUploadFileSelected('${uniqueId}','${opts.tag}')">
      <span class="upload-icon">${isAnimated ? '🎞️' : '📤'}</span>
      <span class="upload-label">点击或拖拽文件</span>
      <span class="upload-hint">${opts.hint}</span>
      <span class="upload-selected" id="sel_${uniqueId}">未选择文件</span>
      <span class="upload-dim" id="dim_${uniqueId}" style="font-size:0.72em;color:var(--text-muted);"></span>
      <input type="file" id="${uniqueId}" accept="${opts.accept}"
        onchange="onUploadFileSelected('${uniqueId}','${opts.tag}')">
    </div>
    ${isAnimated ? `<label style="font-size:0.78em;color:var(--text-muted);display:flex;align-items:center;gap:8px;margin-top:6px;">动画 FPS：<input type="range" id="fps_${uniqueId}" min="1" max="64" value="12" style="flex:1;"><span id="fpsval_${uniqueId}">12</span></label>` : ''}
    <button class="vrc-upload-btn" id="btn_${uniqueId}" disabled
      onclick="uploadToVRCStyled('${uniqueId}','${opts.tag}','${opts.refreshPage}')">上传</button>
    <div class="vrc-upload-status" id="status_${uniqueId}"></div>
  </div>`;
}

async function onUploadFileSelected(inputId, tag) {
  const input  = document.getElementById(inputId);
  const sel    = document.getElementById('sel_' + inputId);
  const dim    = document.getElementById('dim_' + inputId);
  const btn    = document.getElementById('btn_' + inputId);
  const fpsEl  = document.getElementById('fpsval_' + inputId);
  const fpsSl  = document.getElementById('fps_' + inputId);
  if (!input || !input.files || !input.files[0]) return;
  const f = input.files[0];
  const tooBig = f.size > 10 * 1024 * 1024;
  sel.textContent = f.name + ' (' + (f.size/1024/1024).toFixed(2) + ' MB)';
  sel.style.color = tooBig ? '#f87171' : 'var(--accent-light)';
  // Sync FPS slider label
  if (fpsEl && fpsSl) {
    fpsSl.oninput = () => fpsEl.textContent = fpsSl.value;
  }
  // For static emoji/sticker—show dimension warning if needed
  if (tag === 'emoji' || tag === 'sticker') {
    const img = new Image();
    img.onload = () => {
      const ok = img.width <= 1024 && img.height <= 1024;
      if (dim) dim.textContent = img.width + '×' + img.height + (ok ? '' : ' ⚠️ 超出 1024×1024！');
      if (dim) dim.style.color = ok ? 'var(--text-muted)' : '#f87171';
      btn.disabled = tooBig || !ok;
    };
    img.onerror = () => { btn.disabled = tooBig; };
    img.src = URL.createObjectURL(f);
  } else if (tag === 'emojianimated') {
    // For GIFs, auto-detect FPS from frame delays
    if (f.type === 'image/gif') {
      if (dim) { dim.textContent = '⏳ 正在读取 GIF 帧速...'; dim.style.color = 'var(--text-muted)'; }
      const buf = await f.arrayBuffer();
      try {
        const gif = window.parseGIF(buf);
        const gifFrames = window.decompressFrames(gif, false);
        const avgDelay = gifFrames.reduce((s, fr) => s + (fr.delay || 10), 0) / gifFrames.length;
        const detectedFps = Math.min(Math.max(Math.round(100 / avgDelay), 1), 64);
        if (fpsSl) { fpsSl.value = detectedFps; }
        if (fpsEl) { fpsEl.textContent = detectedFps; }
        if (dim) {
          dim.textContent = `✅ ${gifFrames.length} 帧，自动检测 ${detectedFps} fps`;
          dim.style.color = 'var(--accent-light)';
        }
      } catch(e) {
        if (dim) { dim.textContent = '⚠️ 无法解析 GIF，手动设置 FPS'; dim.style.color = '#f87171'; }
      }
    } else {
      if (dim) dim.textContent = '⚠️ 动态表情请上传 GIF';
      if (dim) dim.style.color = '#f87171';
    }
    btn.disabled = tooBig;
  } else {
    btn.disabled = tooBig;
  }
}

async function uploadToVRCStyled(inputId, tag, refreshPage) {
  const input    = document.getElementById(inputId);
  const btn      = document.getElementById('btn_' + inputId);
  const statusEl = document.getElementById('status_' + inputId);
  const fpsSl    = document.getElementById('fps_' + inputId);
  if (!input || !input.files || !input.files[0]) { statusEl.textContent = '请先选择文件'; return; }
  let file = input.files[0];
  if (file.size > 10*1024*1024) { statusEl.textContent = '❌ 文件超过 10MB'; statusEl.style.color='#f87171'; return; }

  btn.disabled = true;
  statusEl.style.color = 'var(--text-muted)';

  const fd = new FormData();

  try {
    if (tag === 'emojianimated') {
      // GIF → Spritesheet conversion
      statusEl.textContent = '⏳ 正在转换 GIF → 精灵图（可能需要几秒）...';
      if (file.type !== 'image/gif') throw new Error('动态表情必须上传 GIF 文件！');
      const fps = fpsSl ? parseInt(fpsSl.value) || 12 : 12;
      const { blob, frames, framesOverTime } = await gifToSpritesheet(file, fps);
      fd.append('filestring', blob, 'spritesheet.png');
      fd.append('tagstring', 'emojianimated');
      fd.append('frames', String(frames));
      fd.append('framesOverTime', String(framesOverTime));
      statusEl.textContent = `⏳ 上传精灵图（${frames} 帧，${framesOverTime}fps）...`;
    } else if (tag === 'emoji' || tag === 'sticker') {
      // Static emoji/sticker — validate 1024×1024
      statusEl.textContent = '⏳ 检查尺寸...';
      await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => {
          if (img.width > 1024 || img.height > 1024) rej(new Error(`图片尺寸 ${img.width}×${img.height} 超出上限 1024×1024`));
          else res();
        };
        img.onerror = res; // if can't load dimensions, proceed anyway
        img.src = URL.createObjectURL(file);
      });
      fd.append('filestring', file, file.name);
      fd.append('tagstring', tag);
      statusEl.textContent = '⏳ 上传中...';
    } else {
      // gallery, icon, prints preview
      fd.append('filestring', file, file.name);
      fd.append('tagstring', tag);
      statusEl.textContent = '⏳ 上传中...';
    }

    const r = await fetch('/api/vrc/file/image', {
      method: 'POST',
      headers: { 'X-VRC-Auth': localStorage.getItem('vrc_auth') || '' },
      body: fd
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error('HTTP ' + r.status + ': ' + txt.substring(0, 200));
    }
    statusEl.textContent = '✅ 上传成功！';
    statusEl.style.color = '#86efac';
    input.value = '';
    const selEl = document.getElementById('sel_' + inputId);
    if (selEl) selEl.textContent = '未选择文件';
    const dimEl = document.getElementById('dim_' + inputId);
    if (dimEl) dimEl.textContent = '';
    setTimeout(() => { if (refreshPage) switchAssetsPage(refreshPage); }, 1800);
  } catch(e) {
    statusEl.textContent = '❌ ' + e.message;
    statusEl.style.color = '#f87171';
    btn.disabled = false;
  }
}

async function fetchGalleryOnly(container) {
  try {
    container.innerHTML = '<div style="color:var(--text-muted);margin:20px;">加载中...</div>';
    const r = await apiCall('/api/vrc/files?tag=gallery&n=60');
    const files = r.ok ? await r.json() : [];
    container.innerHTML = '<h2 style="margin-bottom:16px;">🖼️ VRC+ 相册</h2>';
    container.innerHTML += '<div class="vrc-upload-row">' + makeUploadCard({
      title:'📤 上传到 VRC+ 相册', hint:'PNG/JPG/GIF · 最大 10MB',
      tag:'gallery', accept:'image/*', refreshPage:'gallery', id:'gallery'
    }) + '</div>';
    container.innerHTML += '<h3 style="font-size:0.92rem;margin-bottom:12px;">📸 我的相册 (' + files.length + ')</h3>';
    if (files.length) {
      container.innerHTML += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;">' +
        files.map(f => {
          const imgUrl = proxyImg(extractFileVersionUrl(f));
          return '<div style="border-radius:8px;overflow:hidden;background:var(--bg-glass);border:1px solid var(--border);cursor:pointer;" onclick="if(this.querySelector(\'img\').src)window.open(this.querySelector(\'img\').src,\'_blank\')">' +
            '<img src="' + escHtml(imgUrl) + '" style="width:100%;aspect-ratio:1/1;object-fit:cover;display:block;" loading="lazy" onerror="this.style.display=\'none\'">' +
            '<div style="padding:4px 6px;font-size:0.68em;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(f.name||'') + '</div>' +
          '</div>';
        }).join('') + '</div>';
    } else {
      container.innerHTML += '<div style="color:var(--text-muted);font-size:0.85em;">暂无 VRC+ 相册图片（需要 VRC+，可在游戏内或此处上传）</div>';
    }
  } catch(e) {
    container.innerHTML = '<div style="color:var(--error);">加载失败: ' + e.message + '</div>';
  }
}

// ═══════════════════════════════════════════════════════════
// PRINTS (拍立得照片) - separate page
// ═══════════════════════════════════════════════════════════
async function fetchPrints(container) {
  try {
    container.innerHTML = '<div style="color:var(--text-muted);margin:20px;">加载中...</div>';
    const me = await (await apiCall('/api/vrc/auth/user')).json();
    const r = await apiCall('/api/vrc/prints/user/' + me.id + '?n=100&offset=0');
    const prints = r.ok ? await r.json() : [];
    const printUploadId = 'printUpl_' + Date.now();
    container.innerHTML = '<h2 style="margin-bottom:12px;">🎞️ 拍立得照片</h2>' +
      '<div class="vrc-upload-card" style="max-width:420px;margin-bottom:20px;">' +
        '<h4>📤 上传拍立得照片</h4>' +
        '<div class="vrc-upload-zone" id="zone_' + printUploadId + '"' +
          ' ondragover="event.preventDefault();this.classList.add(\'dragover\')"' +
          ' ondragleave="this.classList.remove(\'dragover\')"' +
          ' ondrop="event.preventDefault();this.classList.remove(\'dragover\');document.getElementById(\'' + printUploadId + '\').files=event.dataTransfer.files;onPrintFileSelected(\'' + printUploadId + '\')">' +
          '<span class="upload-icon">📷</span>' +
          '<span class="upload-label">点击或拖拽照片 (PNG/JPG)</span>' +
          '<span class="upload-hint">最大 10MB · 推荐 1920×1080 · 需要 VRC+</span>' +
          '<span class="upload-selected" id="sel_' + printUploadId + '">未选择文件</span>' +
          '<input type="file" id="' + printUploadId + '" accept="image/*" onchange="onPrintFileSelected(\'' + printUploadId + '\')">' +
        '</div>' +
        '<input type="text" id="note_' + printUploadId + '" class="input-field" placeholder="备注 / Caption（选填）" style="font-size:0.8em;padding:6px 10px;margin-top:4px;">' +
        '<button class="vrc-upload-btn" id="btn_' + printUploadId + '" disabled onclick="uploadPrint(\'' + printUploadId + '\')">上传</button>' +
        '<div class="vrc-upload-status" id="status_' + printUploadId + '"></div>' +
      '</div>';
    if (!prints.length) {
      container.innerHTML += '<div style="color:var(--text-muted);font-size:0.85em;padding:40px;text-align:center;">暂无拍立得照片</div>';
      return;
    }
    container.innerHTML += '<div style="font-size:0.78em;color:var(--text-muted);margin-bottom:16px;">共 ' + prints.length + ' 张</div>';
    container.innerHTML += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:18px;">' +
      prints.map(p => {
        const rawUrl = (p.files && p.files.image) ? p.files.image : (p.imageUrl || p.thumbnailImageUrl || '');
        const imgUrl = proxyImg(rawUrl);
        const world = p.worldName || p.worldId || '';
        const author = p.ownerDisplayName || '';
        const date = p.createdAt ? new Date(p.createdAt).toLocaleDateString('zh-CN') : '';
        return '<div onclick="window.open(\'' + escHtml(imgUrl) + '\',\'_blank\')" style="cursor:pointer;background:#fff;border-radius:4px;padding:10px 10px 20px;box-shadow:0 4px 18px rgba(0,0,0,0.45);transition:transform 0.15s;" onmouseover="this.style.transform=\'scale(1.03)\'" onmouseout="this.style.transform=\'\'">' +
          '<img src="' + escHtml(imgUrl) + '" style="width:100%;aspect-ratio:4/3;object-fit:cover;display:block;border-radius:2px;" loading="lazy" onerror="this.style.display=\'none\'">' +
          '<div style="margin-top:8px;">' +
            '<div style="font-size:0.7em;color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:sans-serif;">' + escHtml(world) + '</div>' +
            '<div style="font-size:0.65em;color:#888;font-family:sans-serif;display:flex;justify-content:space-between;">' +
              '<span>' + escHtml(author) + '</span><span>' + date + '</span>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
  } catch(e) {
    container.innerHTML = '<div style="color:var(--error);">加载失败: ' + e.message + '</div>';
  }
}

// ═══════════════════════════════════════════════════════════
// PRINT UPLOAD (POST /prints with image + timestamp)
// ═══════════════════════════════════════════════════════════
function onPrintFileSelected(inputId) {
  const input = document.getElementById(inputId);
  const sel   = document.getElementById('sel_' + inputId);
  const btn   = document.getElementById('btn_' + inputId);
  if (!input || !input.files || !input.files[0]) return;
  const f = input.files[0];
  sel.textContent = f.name + ' (' + (f.size/1024/1024).toFixed(2) + ' MB)';
  sel.style.color  = f.size > 10*1024*1024 ? '#f87171' : 'var(--accent-light)';
  btn.disabled = f.size > 10*1024*1024;
}

async function uploadPrint(inputId) {
  const input    = document.getElementById(inputId);
  const btn      = document.getElementById('btn_' + inputId);
  const statusEl = document.getElementById('status_' + inputId);
  const noteEl   = document.getElementById('note_' + inputId);
  if (!input || !input.files || !input.files[0]) { statusEl.textContent = '请先选择文件'; return; }
  const file = input.files[0];
  if (file.size > 10*1024*1024) { statusEl.textContent = '❌ 文件超过 10MB'; statusEl.style.color='#f87171'; return; }
  btn.disabled = true;
  statusEl.textContent = '⏳ 上传中 (处理图片...)';
  statusEl.style.color = 'var(--text-muted)';
  try {
    // VRCX ALWAYS converts prints to PNG before uploading.
    // The VRChat POST /prints API strictly expects a PNG blob.
    const imgUrl = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('无法解析图片'));
      img.src = imgUrl;
    });
    
    // Draw to canvas and convert to PNG blob
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const pngBlob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    URL.revokeObjectURL(imgUrl);

    statusEl.textContent = '⏳ 上传中 (发送到 VRChat...)';
    const fd = new FormData();
    fd.append('image', pngBlob, 'image.png');
    fd.append('timestamp', new Date().toISOString());
    if (noteEl && noteEl.value.trim()) fd.append('note', noteEl.value.trim());

    const r = await fetch('/api/vrc/prints', { method: 'POST', body: fd });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error('HTTP ' + r.status + ': ' + txt);
    }
    statusEl.textContent = '✅ 上传成功！';
    statusEl.style.color = '#86efac';
    if (input) input.value = '';
    const sel = document.getElementById('sel_' + inputId);
    if (sel) sel.textContent = '未选择文件';
    setTimeout(() => switchAssetsPage('prints'), 2000);
  } catch(e) {
    statusEl.textContent = '❌ ' + e.message;
    statusEl.style.color = '#f87171';
    btn.disabled = false;
  }
}

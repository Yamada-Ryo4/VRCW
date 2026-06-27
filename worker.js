/**
 * VRChat Avatar Manager — Cloudflare Worker
 * Proxies VRChat API calls to bypass CORS restrictions.
 * The browser handles S3 uploads directly for maximum speed.
 */

const VRC_API = "https://api.vrchat.cloud/api/1";
const API_KEY = "JlGlobalv959ay9puS6p99En0asKuAk";
const USER_AGENT = "VRCX/1.6.4 (vrcxml@gmail.com)";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-VRC-Auth, X-S3-Url, X-S3-content-md5, X-S3-content-type",
    "Access-Control-Expose-Headers": "X-VRC-Auth",
};

function calculateDatingGradientScore(wanted, actual, type) {
    // Normalize legacy wildcard values
    const isWildcard = (v) => !v || v === '不限' || v === '不限 / 皆可' || v === '全时段' || v === '全天' || v === '未知' || v === '随缘';

    // ── Time: overlap-based scoring ──
    // Data format: comma-separated 2-hour slots like "18:00--20:00,22:00--24:00"
    // or a wildcard ("不限"/"全天"/etc.) meaning "any time".
    // Score = 15 * (overlap_count / max(wanted_slots, actual_slots))
    // If either side is wildcard → full 15 (matches anyone).
    if (type === 'time') {
        if (isWildcard(wanted) || isWildcard(actual)) return 15;
        const wSlots = String(wanted).split(',').map(s => s.trim()).filter(Boolean);
        const aSlots = String(actual).split(',').map(s => s.trim()).filter(Boolean);
        if (wSlots.length === 0 || aSlots.length === 0) return 15; // empty → treat as wildcard
        const wSet = new Set(wSlots);
        let overlap = 0;
        for (const s of aSlots) { if (wSet.has(s)) overlap++; }
        if (overlap === 0) return 0;
        return Math.round(15 * (overlap / Math.max(wSlots.length, aSlots.length)));
    }

    // ── Non-time types: exact-match or wildcard ──
    if (wanted === actual || isWildcard(wanted)) {
        if (type === 'voice') return 30;
        if (type === 'model') return 30;
        if (type === 'inc') return 15;
        if (type === 'gender') return 10;
        return 0;
    }

    if (type === 'voice') {
        const groups = [
            ['萝莉音', '少女音', '夹子音', '少御音', '御姐音'],
            ['正太音', '少年音', '青年音', '大叔音']
        ];
        for (const group of groups) {
            const wIdx = group.indexOf(wanted);
            const aIdx = group.indexOf(actual);
            if (wIdx !== -1 && aIdx !== -1) {
                const diff = Math.abs(wIdx - aIdx);
                return Math.max(0, 30 - diff * 3);
            }
        }
        return 0;
    }

    if (type === 'model') {
        const groups = [
            ['萝莉', '少女', '少御', '御姐', '巨乳系'],
            ['正太', '少年', '成男'],
            ['机甲', '写实', '福瑞', '小动物']
        ];
        for (const group of groups) {
            const wIdx = group.indexOf(wanted);
            const aIdx = group.indexOf(actual);
            if (wIdx !== -1 && aIdx !== -1) {
                const diff = Math.abs(wIdx - aIdx);
                return Math.max(0, 30 - diff * 3);
            }
        }
        return 0;
    }

    return 0;
}

function calculateDatingPairScores(myProfile, theirProfile) {
    let score = 0;
    score += calculateDatingGradientScore(myProfile.target_time, theirProfile.pref_time, 'time');
    score += calculateDatingGradientScore(myProfile.target_inclination, theirProfile.pref_inclination, 'inc');
    score += calculateDatingGradientScore(myProfile.target_voice, theirProfile.pref_voice, 'voice');
    score += calculateDatingGradientScore(myProfile.target_model, theirProfile.pref_model, 'model');
    score += calculateDatingGradientScore(myProfile.target_gender, theirProfile.pref_gender, 'gender');

    let theirScore = 0;
    theirScore += calculateDatingGradientScore(theirProfile.target_time, myProfile.pref_time, 'time');
    theirScore += calculateDatingGradientScore(theirProfile.target_inclination, myProfile.pref_inclination, 'inc');
    theirScore += calculateDatingGradientScore(theirProfile.target_voice, myProfile.pref_voice, 'voice');
    theirScore += calculateDatingGradientScore(theirProfile.target_model, myProfile.pref_model, 'model');
    theirScore += calculateDatingGradientScore(theirProfile.target_gender, myProfile.pref_gender, 'gender');

    return { score, theirScore, totalScore: (score + theirScore) / 2 };
}

/**
 * SSRF guard — only allow the worker to proxy/fetch known VRChat + community
 * avatar-database hosts. Without this, /api/proxy, /api/image, /api/download and
 * /api/resolve-url are open proxies that anyone can abuse to hit arbitrary
 * (incl. internal) addresses or burn the account's CF bandwidth quota.
 *
 * Matching is by exact host or by a registrable-domain suffix (".example.com").
 */
const ALLOWED_HOST_SUFFIXES = [
    ".vrchat.cloud",
    ".vrchat.com",
    ".avtrdb.com",
    ".vrcdb.com",
    ".avatarrecovery.com",
    ".cute.bet",
    ".nekosunevr.co.uk",
    // S3 / CDN hosts that VRChat file URLs redirect to
    ".amazonaws.com",
    ".cloudfront.net",
];
const ALLOWED_HOSTS = new Set([
    "vrchat.cloud",
    "vrchat.com",
    "avtrdb.com",
    "vrcdb.com",
    "avatarrecovery.com",
    "cute.bet",
    "nekosunevr.co.uk",
]);

function isAllowedTarget(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return false;
    }
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (ALLOWED_HOSTS.has(host)) return true;
    return ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function isAllowedUploadTarget(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return false;
    }
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (!host.endsWith(".amazonaws.com") && !host.endsWith(".cloudfront.net")) return false;
    return parsed.searchParams.has("X-Amz-Signature") || parsed.searchParams.has("X-Amz-Credential");
}

function sanitizeDownloadFilename(filename) {
    return String(filename || "avatar.vrca")
        .replace(/[\r\n\"]/g, "_")
        .replace(/[\\/]/g, "_")
        .slice(0, 180) || "avatar.vrca";
}

function jsonResp(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
    });
}

/**
 * Forward a request to VRChat API, preserving auth cookies.
 * Auth cookies are passed via X-VRC-Auth header (base64-encoded cookie string)
 * since Workers can't share browser cookies cross-origin.
 */
async function vrcFetch(path, options = {}, authCookies = "") {
    const url = `${VRC_API}${path}${path.includes("?") ? "&" : "?"}apiKey=${API_KEY}`;
    const headers = {
        "User-Agent": USER_AGENT,
        ...(options.headers || {}),
    };
    if (authCookies) {
        headers["Cookie"] = authCookies;
    }
    if (options.json) {
        headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(options.json);
        delete options.json;
    }

    const resp = await fetch(url, {
        method: options.method || "GET",
        headers,
        body: options.body,
        redirect: "manual",
        signal: options.signal || AbortSignal.timeout(30000),
    });

    // Collect set-cookie headers to pass back
    const setCookies = resp.headers.getAll
        ? resp.headers.getAll("set-cookie")
        : [resp.headers.get("set-cookie")].filter(Boolean);

    return { resp, setCookies };
}

function getAuth(request) {
    const header = request.headers.get("X-VRC-Auth") || "";
    if (!header) return "";
    try {
        return atob(header);
    } catch {
        return header;
    }
}

function mergeCookies(existing, newCookies) {
    const map = {};
    // Parse existing
    if (existing) {
        existing.split(";").forEach((c) => {
            const [k, ...v] = c.trim().split("=");
            if (k) map[k.trim()] = v.join("=");
        });
    }
    // Parse new set-cookie headers
    newCookies.forEach((sc) => {
        const [pair] = sc.split(";");
        const [k, ...v] = pair.split("=");
        if (k) map[k.trim()] = v.join("=");
    });
    return Object.entries(map)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
}

function authBucket(authCookies) {
    if (!authCookies) return "anon";
    let hash = 0;
    for (let i = 0; i < authCookies.length; i++) {
        hash = ((hash << 5) - hash + authCookies.charCodeAt(i)) | 0;
    }
    return `auth:${Math.abs(hash)}`;
}

// ── Dating identity verification ──────────────────────────────────────────
// The /api/dating/* routes used to trust a client-supplied `vrc_id` body/query
// field for *who the caller is*. That was an IDOR: anyone could POST
// `/api/dating/profile` with someone else's vrc_id and overwrite their dating
// profile, or rate people on their behalf. We now resolve the caller's real
// VRChat id by replaying their X-VRC-Auth cookie against VRChat /auth/user and
// use THAT as the authoritative identity for every dating write (and for reads
// of private data like history / my_ratings / blocklist).
//
// _identityCache: authCookie string -> { at, id, age18 }  (30s TTL; VRChat
// sessions are long-lived so a half-minute old answer is safe and saves an
// upstream round-trip per dating request.)
const _identityCache = new Map();
const IDENTITY_CACHE_TTL_MS = 30_000;
async function resolveVrcIdentity(request, env) {
    const auth = getAuth(request);
    if (!auth) return null;
    const cached = _identityCache.get(auth);
    if (cached && (Date.now() - cached.at) < IDENTITY_CACHE_TTL_MS) {
        return cached;
    }
    try {
        const { resp } = await vrcFetch("/auth/user", { method: "GET" }, auth);
        if (!resp.ok) return null;
        const user = await resp.json();
        if (!user || !user.id) return null;
        const age18 = user.ageVerificationStatus === "18+" || user.ageVerified === true;
        const entry = { at: Date.now(), id: user.id, age18, displayName: user.displayName || "" };
        _identityCache.set(auth, entry);
        return entry;
    } catch (_) {
        return null;
    }
}

// Bearer-style helper for dating routes that MUST be authenticated.
// Returns { identity, response }. `response` is null when the caller is
// authenticated; otherwise it's a ready-to-return 401 JSON.
async function requireDatingAuth(request, env) {
    const identity = await resolveVrcIdentity(request, env);
    if (!identity) {
        return { identity: null, response: jsonResp({ error: "Authentication required" }, 401) };
    }
    return { identity, response: null };
}

// Admin auth — verifies X-Admin-Token header against the ADMIN_SECRET env var.
// ADMIN_SECRET is set in wrangler secrets / CF Dashboard secrets and is NOT
// committed to git. Returns { ok: true } or { ok: false, response }.
async function requireAdminAuth(request, env) {
    const token = request.headers.get('X-Admin-Token');
    const secret = env.ADMIN_SECRET;
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';

    if (!secret) {
        // Admin not configured — fail closed.
        return { ok: false, response: jsonResp({ error: "Admin not configured (ADMIN_SECRET missing)" }, 503) };
    }

    // Check existing IP block before token comparison. If the admin_ip_blocks
    // table hasn't been migrated yet, fail open for rate-limiting only (token
    // validation below still protects the admin API).
    try {
        const block = await executeD1Query(env, 'SELECT fail_count, blocked_until FROM admin_ip_blocks WHERE ip = ?', [ip], 'first');
        if (block && block.blocked_until) {
            const until = new Date(String(block.blocked_until).replace(' ', 'T') + 'Z');
            if (!isNaN(until.getTime()) && until.getTime() > Date.now()) {
                return { ok: false, response: jsonResp({ error: "IP blocked", blocked_until: block.blocked_until }, 429) };
            }
        }
    } catch (_) {}

    if (!token || token !== secret) {
        let remaining = null;
        let blockedUntil = null;
        try {
            const row = await executeD1Query(env, 'SELECT fail_count FROM admin_ip_blocks WHERE ip = ?', [ip], 'first');
            const nextFail = ((row && row.fail_count) ? Number(row.fail_count) : 0) + 1;
            if (nextFail >= 5) {
                await executeD1Query(env, `INSERT INTO admin_ip_blocks (ip, fail_count, blocked_until, last_failed_at)
                    VALUES (?, ?, datetime('now', '+24 hours'), CURRENT_TIMESTAMP)
                    ON CONFLICT(ip) DO UPDATE SET fail_count=excluded.fail_count, blocked_until=excluded.blocked_until, last_failed_at=CURRENT_TIMESTAMP`, [ip, nextFail], 'run');
                const b = await executeD1Query(env, 'SELECT blocked_until FROM admin_ip_blocks WHERE ip = ?', [ip], 'first');
                blockedUntil = b?.blocked_until || null;
                return { ok: false, response: jsonResp({ error: "IP blocked", blocked_until: blockedUntil }, 429) };
            } else {
                await executeD1Query(env, `INSERT INTO admin_ip_blocks (ip, fail_count, blocked_until, last_failed_at)
                    VALUES (?, ?, NULL, CURRENT_TIMESTAMP)
                    ON CONFLICT(ip) DO UPDATE SET fail_count=excluded.fail_count, blocked_until=NULL, last_failed_at=CURRENT_TIMESTAMP`, [ip, nextFail], 'run');
                remaining = Math.max(0, 5 - nextFail);
            }
        } catch (_) {}
        return { ok: false, response: jsonResp({ error: "Forbidden", remaining }, 403) };
    }

    // Successful login clears previous failures for this IP.
    try { await executeD1Query(env, 'DELETE FROM admin_ip_blocks WHERE ip = ?', [ip], 'run'); } catch (_) {}
    return { ok: true, response: null };
}

// Returns true if the given vrc_id is in the banned_users table.
async function isUserBanned(env, vrcId) {
    if (!vrcId) return false;
    try {
        const row = await executeD1Query(env, 'SELECT vrc_id FROM banned_users WHERE vrc_id = ?', [vrcId], 'first');
        return !!row;
    } catch (_) {
        // If banned_users table doesn't exist yet (migration not run), don't
        // block everyone — treat as not banned.
        return false;
    }
}

// Server-side 18+ check from a DOB string ("YYYY-MM-DD"). Mirrors the client
// logic in shell.js verifyDatingAge() so a tampered client can't bypass it.
function isAdultFromDob(dobStr) {
    if (!dobStr) return false;
    const dob = new Date(dobStr);
    if (isNaN(dob.getTime())) return false;
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const m = today.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
    return age >= 18;
}

// Unified D1 access layer. Tries a direct `env.DB` binding first (when the
// worker is deployed on the same account as the D1 database), and falls back
// to the external D1 proxy (D1_PROXY_URL + secret) for cross-account / git-
// deployed workers that can't bind the database directly. All dating routes
// call this single function, so switching between direct/proxy is transparent.
async function executeD1Query(env, query, params = [], type = 'all') {
    // ── Direct D1 binding (preferred) ──
    if (env.DB) {
        try {
            const stmt = env.DB.prepare(query).bind(...params);
            let result;
            if (type === 'first') {
                result = await stmt.first();
                return result; // null or a row object — same as proxy
            } else if (type === 'run') {
                result = await stmt.run();
                return result; // { meta, ... } — proxy returns the same shape
            } else {
                result = await stmt.all();
                // Return in proxy-compatible shape { results: [...] } so all
                // call sites that read .results work identically whether D1 is
                // accessed directly or via the external proxy.
                return { results: result.results || [], meta: result.meta };
            }
        } catch (e) {
            console.error(`[D1 Direct] query failed: ${e.message}`);
            throw new Error(`数据库查询失败`);
        }
    }

    // ── External D1 proxy fallback ──
    if (!env.D1_PROXY_URL || !env.D1_PROXY_SECRET) {
        throw new Error("数据库未配置：需要 env.DB 直连绑定或 D1_PROXY_URL/SECRET。");
    }
    const res = await fetch(env.D1_PROXY_URL + '/query', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.D1_PROXY_SECRET}`
        },
        body: JSON.stringify({ query, params, type })
    });
    if (!res.ok) {
        const text = await res.text();
        // Log the full error server-side for debugging, but throw a generic
        // message so SQL schema details (table/column names, partial SQL) don't
        // leak to the client response (W4: information disclosure).
        console.error(`[D1 Proxy] ${res.status}: ${text}`);
        throw new Error(`数据库查询失败 (HTTP ${res.status})`);
    }
    const data = await res.json();
    if (!data.success) {
        console.error(`[D1 Proxy] query failed: ${data.error}`);
        throw new Error(`数据库查询失败`);
    }
    return data.result;
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        // Handle CORS preflight
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        // ── Static assets ──
        // Any non-API path (/, /index.html, /admin.html, /style.css, /js/*.js,
        // /dating/, /favicon.ico, etc.) is served by the Cloudflare Workers
        // Static Assets binding. We must hand these off BEFORE the API route
        // block, otherwise they'd fall through to the 404 at the end.
        if (!path.startsWith('/api/')) {
            if (!env.ASSETS) return new Response("Static assets require env.ASSETS binding", { status: 500 });
            const assetResp = await env.ASSETS.fetch(request);
            // Admin is an operational console; never let browser/edge cache keep
            // an old JS bundle around while debugging fixes.
            if (path === '/admin' || path === '/admin.html') {
                const headers = new Headers(assetResp.headers);
                headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
                headers.set('Pragma', 'no-cache');
                return new Response(assetResp.body, { status: assetResp.status, statusText: assetResp.statusText, headers });
            }
            return assetResp;
        }

        // ── API Routes ──
        const auth = getAuth(request);

        // POST /api/login (PERSISTENT FINGERPRINT + OPTIONAL VPS PROXY)
        if (path === "/api/login" && request.method === "POST") {
            const body = await request.json();
            const safeBtoa = (str) => {
                try { return btoa(str); } catch (e) { return "ERROR_ENCODING"; }
            };

            // Use the persistent device fingerprint sent by the client, fallback if missing
            const fp = body.fingerprint || {
                mac: "00:11:22:33:44:55",
                hwid: "default_fallback_hwid_string",
                version: "1.24.0"
            };

            const doVrcLogin = async (authStr) => {
                const headers = {
                    "User-Agent":       `VRChat/${fp.version} Win32`,
                    "Authorization":    `Basic ${safeBtoa(authStr)}`,
                    "Accept":           "application/json",
                    "X-MacAddress":     fp.mac,
                    "X-Client-Version": fp.version,
                    "X-Platform":       "standalonewindows",
                    "X-SDK-Version":    "VRCSDK3-2024.01.22.18.33",
                    "X-HWID":           fp.hwid,
                    "X-Forwarded-For":  request.headers.get("CF-Connecting-IP") || ""
                };

                // Check if user has configured their private VPS Proxy in Worker Env variables
                const proxyUrl = env.VPS_PROXY_URL || "";
                const proxySecret = env.VPS_PROXY_SECRET || "";

                if (proxyUrl && proxySecret) {
                    headers["X-Proxy-Secret"] = proxySecret;
                    return await fetch(`${proxyUrl}/api/1/auth/user`, {
                        method: "GET",
                        headers: headers
                    });
                } else {
                    // Fallback to Cloudflare direct fetch (unproxied)
                    return await fetch(`${VRC_API}/auth/user`, {
                        method: "GET",
                        headers: headers
                    });
                }
            };

            const authEncoded = `${encodeURIComponent(body.username)}:${encodeURIComponent(body.password)}`;
            let vrcResp = await doVrcLogin(authEncoded);

            let respText = await vrcResp.text();
            let vrcData;
            try { vrcData = JSON.parse(respText); } catch { vrcData = respText; }

            // Fallback for some accounts that don't like encoding
            const errorMsg = (vrcData.error?.message || "").toLowerCase();
            if (vrcResp.status === 401 && errorMsg.includes("invalid")) {
                const authRaw = `${body.username}:${body.password}`;
                const altResp = await doVrcLogin(authRaw);
                // Adopt the retry result if it did better than the encoded attempt.
                if (altResp.status !== 401) {
                    vrcResp = altResp;
                    respText = await altResp.text();
                    try { vrcData = JSON.parse(respText); } catch { vrcData = respText; }
                }
            }

            const setCookies = vrcResp.headers.getAll ? vrcResp.headers.getAll("set-cookie") : [vrcResp.headers.get("set-cookie")].filter(Boolean);
            const responseHeaders = new Headers(CORS_HEADERS);
            if (setCookies.length > 0) {
                responseHeaders.set("X-VRC-Auth", btoa(mergeCookies("", setCookies)));
            }

            // Detect IP rate-limit
            const retryAfter = vrcResp.headers.get("retry-after");
            if (retryAfter && vrcResp.status === 401) {
                return jsonResp({
                    vrcResponse: vrcData,
                    vrcStatus: 429,
                    rateLimited: true,
                    retryAfterSeconds: parseInt(retryAfter)
                }, 200, Object.fromEntries(responseHeaders));
            }

            // NOTE: never echo credentials, raw auth strings, or upstream set-cookie
            // headers back to the client — they end up in browser consoles and CF logs.
            return jsonResp({
                vrcResponse: vrcData,
                vrcStatus: vrcResp.status
            }, 200, Object.fromEntries(responseHeaders));
        }

        // POST /api/2fa
        if (path === "/api/2fa" && request.method === "POST") {
            try {
                const body = await request.json();
                const code = body.code || "";
                const type = body.type || "totp";

                const vrcPath = type === "emailotp"
                    ? "/auth/twofactorauth/emailotp/verify"
                    : "/auth/twofactorauth/totp/verify";

                const { resp, setCookies } = await vrcFetch(
                    vrcPath,
                    { method: "POST", json: { code }, headers: {} },
                    auth
                );

                const data = await resp.json();
                const cookies = mergeCookies(auth, setCookies);

                if (resp.status === 200 && data.verified) {
                    return jsonResp({ ok: true }, 200, { "X-VRC-Auth": btoa(cookies) });
                }
                return jsonResp({ ok: false, message: "Invalid code" }, 400);
            } catch (e) {
                return jsonResp({ ok: false, message: "驂证失败：服务器异常 (" + e.message + ")" }, 500);
            }
        }

        // GET /api/image?url=...&auth=...
        // Proxies image requests through the worker, following redirects, to bypass browser CORS / Referer blocks.
        // Uses Cache API for instant hits after batch prefetch.
        if (path === "/api/image" && request.method === "GET") {
            const targetUrl = url.searchParams.get("url");
            let imgAuth = auth;
            const authParam = url.searchParams.get("auth");
            if (!imgAuth && authParam) {
                try { imgAuth = atob(authParam); } catch { imgAuth = authParam; }
            }
            const imageBucket = authBucket(imgAuth);
            if (!targetUrl) return new Response("Missing url", { status: 400 });
            if (!isAllowedTarget(targetUrl)) {
                return new Response("Target host not allowed", { status: 403, headers: CORS_HEADERS });
            }

            // Check CF Cache API first
            const cacheKey = new Request(new URL(`/api/image?bucket=${encodeURIComponent(imageBucket)}&url=${encodeURIComponent(targetUrl)}`, request.url).toString(), { method: "GET" });
            const cache = caches.default;
            let cached = await cache.match(cacheKey);
            if (cached) return cached;

            try {
                const headers = {
                    "User-Agent": USER_AGENT,
                    "Referer": "https://vrchat.com/"
                };
                if (imgAuth) headers["Cookie"] = imgAuth;

                // 20s deadline so a slow/hung VRC CDN origin can't hold the
                // Worker subrequest open indefinitely and starve the client's
                // image queue (the "some images time out" symptom).
                const imgResp = await fetch(targetUrl, {
                    method: "GET",
                    headers,
                    redirect: "follow",
                    signal: AbortSignal.timeout(20000)
                });

                if (!imgResp.ok) {
                    return new Response("Image fetch failed", { status: imgResp.status, headers: CORS_HEADERS });
                }

                // Clone and cache the response
                const resp = new Response(imgResp.body, {
                    status: 200,
                    headers: {
                        "Content-Type": imgResp.headers.get("content-type") || "image/jpeg",
                        "Cache-Control": "public, max-age=604800, immutable",
                        ...CORS_HEADERS
                    }
                });
                // Cache a clone (can't consume body twice)
                const respClone = resp.clone();
                // Ensure caching completes in the background without killing the worker or hanging the stream
                ctx.waitUntil(cache.put(cacheKey, respClone));
                return resp;
            } catch (e) {
                return new Response("Image proxy failed: " + e.message, { status: 500, headers: CORS_HEADERS });
            }
        }

        // GET /api/proxy?url=...
        // Generic proxy to bypass CORS for third-party JSON API endpoints.
        if (path === "/api/proxy" && request.method === "GET") {
            const targetUrl = url.searchParams.get("url");
            if (!targetUrl) return jsonResp({ error: "Missing url" }, 400);
            if (!isAllowedTarget(targetUrl)) {
                return jsonResp({ error: "Target host not allowed" }, 403);
            }

            try {
                const proxyResp = await fetch(targetUrl, {
                    method: "GET",
                    headers: { "User-Agent": USER_AGENT },
                });

                const respBody = await proxyResp.arrayBuffer();
                return new Response(respBody, {
                    status: proxyResp.status,
                    headers: {
                        "Content-Type": proxyResp.headers.get("content-type") || "application/json",
                        ...CORS_HEADERS
                    }
                });
            } catch (e) {
                return jsonResp({ error: e.message }, 500);
            }
        }

        // POST /api/images/prefetch
        // Batch-downloads images from VRC servers using Worker's high-speed edge bandwidth,
        // storing them in CF Cache API so subsequent /api/image requests are instant cache hits.
        if (path === "/api/images/prefetch" && request.method === "POST") {
            let body;
            try {
                body = await request.json();
            } catch (_) {
                return jsonResp({ error: "Invalid JSON" }, 400);
            }
            const urls = (body.urls || []).filter(isAllowedTarget);
            const imageBucket = authBucket(auth);
            if (!urls.length) return jsonResp({ ok: true, cached: 0 });

            const cache = caches.default;
            let cachedCount = 0;
            let fetchedCount = 0;
            const MAX_BATCH = 40; // CF Worker subrequest limit safety (each img = 1 fetch + cache ops)
            const batch = urls.slice(0, MAX_BATCH);

            // Fire all fetches concurrently
            const promises = batch.map(async (rawUrl) => {
                const cacheKey = new Request(new URL(`/api/image?bucket=${encodeURIComponent(imageBucket)}&url=${encodeURIComponent(rawUrl)}`, request.url).toString(), { method: "GET" });
                // Skip if already cached
                const existing = await cache.match(cacheKey);
                if (existing) { cachedCount++; return; }

                try {
                    const headers = {
                        "User-Agent": USER_AGENT,
                        "Referer": "https://vrchat.com/"
                    };
                    if (auth) headers["Cookie"] = auth;

                    const imgResp = await fetch(rawUrl, {
                        method: "GET",
                        headers,
                        redirect: "follow"
                    });

                    if (imgResp.ok) {
                        const resp = new Response(imgResp.body, {
                            status: 200,
                            headers: {
                                "Content-Type": imgResp.headers.get("content-type") || "image/jpeg",
                                "Cache-Control": "public, max-age=86400",
                                ...CORS_HEADERS
                            }
                        });
                        await cache.put(cacheKey, resp);
                        fetchedCount++;
                    }
                } catch (e) {
                    // Silent fail for individual images
                }
            });

            await Promise.all(promises);
            return jsonResp({ ok: true, cached: cachedCount, fetched: fetchedCount, total: batch.length });
        }

        // Proxy any /api/vrc/* to VRChat API
        if (path.startsWith("/api/vrc/")) {
            const vrcPath = path.replace("/api/vrc", "");
            const method = request.method;
            let body = null;
            let headers = {};

            if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
                const ct = request.headers.get("content-type") || "";
                if (ct.includes("application/json")) {
                    body = await request.text();
                    headers["Content-Type"] = "application/json";
                } else if (ct.includes("multipart/form-data")) {
                    // Pass through multipart body for file uploads (gallery, emoji, sticker)
                    body = await request.arrayBuffer();
                    headers["Content-Type"] = ct; // preserve boundary
                } else if (ct) {
                    body = await request.arrayBuffer();
                    headers["Content-Type"] = ct;
                }
            }

            const { resp, setCookies } = await vrcFetch(
                vrcPath + url.search,
                { method, body, headers },
                auth
            );

            // Fetch exactly as Raw Buffer to prevent surrogate-pair (emojis) and UTF-8 charset
            // stripping by CF's text() if header is purely application/json.
            const respBody = await resp.arrayBuffer();
            const cookies = mergeCookies(auth, setCookies);

            // ── Auto-sync VRChat 18+ status to D1 ──
            // When the client fetches /auth/user (on login / page load), if VRChat
            // says this user is 18+, write age_verified=1 to their dating profile
            // so the admin panel reflects their real status — even if they never
            // went through the DOB flow. This runs fire-and-forget so it doesn't
            // slow down the response. Also sync display_name + photo_url so the
            // admin list isn't full of "(无名)".
            if (vrcPath === '/auth/user' && resp.status === 200 && env.DB) {
                try {
                    const userJson = JSON.parse(new TextDecoder().decode(respBody));
                    if (userJson && userJson.id) {
                        const age18 = userJson.ageVerificationStatus === "18+" || userJson.ageVerified === true;
                        const displayName = userJson.displayName || null;
                        const photoUrl = userJson.currentAvatarThumbnailImageUrl || userJson.profilePicThumbnailImageUrl || null;
                        // Only upsert if user already has a dating profile (don't create
                        // empty rows for non-dating users). If they have a row, update
                        // display_name + photo_url + age_verified.
                        const hasRow = await executeD1Query(env, 'SELECT vrc_id FROM profiles WHERE vrc_id = ?', [userJson.id], 'first');
                        if (hasRow) {
                            ctx.waitUntil(executeD1Query(env,
                                'UPDATE profiles SET display_name = COALESCE(?, display_name), photo_url = COALESCE(?, photo_url), age_verified = CASE WHEN ? = 1 THEN 1 ELSE age_verified END WHERE vrc_id = ?',
                                [displayName, photoUrl, age18 ? 1 : 0, userJson.id], 'run'
                            ).catch(() => {}));
                        } else if (age18) {
                            // 18+ user with no profile yet — create a stub so admin
                            // can see them. They'll fill in the rest when they open E了吗.
                            ctx.waitUntil(executeD1Query(env,
                                'INSERT INTO profiles (vrc_id, display_name, photo_url, age_verified) VALUES (?, ?, ?, 1) ON CONFLICT(vrc_id) DO UPDATE SET display_name = COALESCE(excluded.display_name, profiles.display_name), photo_url = COALESCE(excluded.photo_url, profiles.photo_url), age_verified = 1',
                                [userJson.id, displayName, photoUrl], 'run'
                            ).catch(() => {}));
                        }
                    }
                } catch (_) {}
            }

            return new Response(respBody, {
                status: resp.status,
                headers: {
                    "Content-Type": resp.headers.get("content-type") || "application/json",
                    ...CORS_HEADERS,
                    "X-VRC-Auth": btoa(cookies),
                },
            });
        }
        // GET /api/download?url=...&filename=... — Proxy download with correct filename
        // Since this response is same-origin, browser `a.download` attribute works correctly.
        if (path === "/api/download" && request.method === "GET") {
            const vrcUrl = url.searchParams.get("url");
            const filename = sanitizeDownloadFilename(url.searchParams.get("filename") || "avatar.vrca");
            // Auth passed as query param since <a>.click() cannot send custom headers
            const authParam = url.searchParams.get("auth");
            let downloadAuth = auth; // from X-VRC-Auth header (normal apiCall)
            if (!downloadAuth && authParam) {
                try { downloadAuth = atob(authParam); } catch { downloadAuth = authParam; }
            }
            if (!vrcUrl) return jsonResp({ error: "Missing url param" }, 400);
            if (!isAllowedTarget(vrcUrl)) return jsonResp({ error: "Target host not allowed" }, 403);

            // Step 1: Resolve VRChat file URL → S3 CDN URL (follows redirect chain with auth)
            async function resolveRedirects(startUrl, authCookies) {
                let resolved = startUrl;
                let currentUrl = startUrl;
                for (let i = 0; i < 5; i++) {
                    if (!isAllowedTarget(currentUrl)) return { error: 403 };
                    const step = await fetch(currentUrl, {
                        method: "GET",
                        headers: { "User-Agent": USER_AGENT, ...(authCookies ? { "Cookie": authCookies } : {}) },
                        redirect: "manual",
                    });
                    if (step.status === 301 || step.status === 302 || step.status === 303 || step.status === 307 || step.status === 308) {
                        const location = step.headers.get("Location");
                        if (!location) break;
                        currentUrl = new URL(location, currentUrl).toString();
                        if (!isAllowedTarget(currentUrl)) return { error: 403 };
                        resolved = currentUrl;
                        continue;
                    }
                    if (step.status === 401) {
                        return { error: 401 };
                    }
                    break;
                }
                return { url: resolved };
            }

            let resolved = await resolveRedirects(vrcUrl, downloadAuth);
            if (resolved.error === 401) return jsonResp({ error: "VRChat auth expired" }, 401);
            if (resolved.error === 403) return jsonResp({ error: "Redirect target not allowed" }, 403);
            let cdnUrl = resolved.url;
            if (!isAllowedTarget(cdnUrl)) return jsonResp({ error: "CDN target not allowed" }, 403);

            // Step 2: Fetch from CDN and stream back with Content-Disposition
            let cdnResp = await fetch(cdnUrl, {
                method: "GET",
                headers: { "User-Agent": USER_AGENT },
                redirect: "manual",
                signal: AbortSignal.timeout(30000),
            });

            // Retry on 403: the pre-signed S3 URL may have expired, re-resolve from scratch
            if (cdnResp.status === 403) {
                resolved = await resolveRedirects(vrcUrl, downloadAuth);
                if (resolved.error === 401) return jsonResp({ error: "VRChat auth expired" }, 401);
                if (resolved.error === 403) return jsonResp({ error: "Redirect target not allowed" }, 403);
                cdnUrl = resolved.url;
                if (!isAllowedTarget(cdnUrl)) return jsonResp({ error: "CDN target not allowed" }, 403);
                cdnResp = await fetch(cdnUrl, {
                    method: "GET",
                    headers: { "User-Agent": USER_AGENT },
                    redirect: "manual",
                    signal: AbortSignal.timeout(30000),
                });
            }

            if (!cdnResp.ok) return jsonResp({ error: `CDN fetch failed: ${cdnResp.status}` }, cdnResp.status);

            // Prevent proxying a Cloudflare challenge HTML page or JSON error as the .vrca file
            const contentType = cdnResp.headers.get("Content-Type") || "";
            if (contentType.includes("text/html") || contentType.includes("application/json")) {
                const errBody = await cdnResp.text();
                return jsonResp({ error: "CDN returned HTML/JSON instead of binary. Likely Cloudflare challenge or API error.", details: errBody.substring(0, 500) }, 502);
            }

            const safeFilename = encodeURIComponent(filename);
            const downloadHeaders = {
                "Content-Type": "application/octet-stream",
                "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${safeFilename}`,
                ...CORS_HEADERS,
            };
            // Only set Content-Length when the CDN actually reported one — an empty
            // header value is rejected by some runtimes/clients.
            const cdnLen = cdnResp.headers.get("Content-Length");
            if (cdnLen) downloadHeaders["Content-Length"] = cdnLen;

            return new Response(cdnResp.body, {
                status: 200,
                headers: downloadHeaders,
            });
        }

        // PUT /api/s3proxy — Proxy S3 uploads (bypass CORS)
        // CRITICAL: CF Workers fetch() auto-adds "Content-Type: application/octet-stream" for ArrayBuffer body.
        // If content-type is NOT in X-Amz-SignedHeaders, this extra header breaks S3 signature → 403.
        // Fix: wrap body in Blob with empty type to suppress automatic Content-Type injection.
        if (path === "/api/s3proxy" && request.method === "PUT") {
            if (!auth) return jsonResp({ error: "Missing auth" }, 401);
            const s3Url = request.headers.get("X-S3-Url");
            if (!s3Url) return jsonResp({ error: "Missing X-S3-Url header" }, 400);
            if (!isAllowedUploadTarget(s3Url)) return jsonResp({ error: "Upload target not allowed" }, 403);

            // Buffer body to avoid Transfer-Encoding:chunked
            const bodyBuffer = await request.arrayBuffer();

            // Parse X-Amz-SignedHeaders from presigned URL
            const s3Headers = new Headers();
            let signedHeadersList = [];
            try {
                const parsedUrl = new URL(s3Url);
                const sh = parsedUrl.searchParams.get("X-Amz-SignedHeaders");
                if (sh) signedHeadersList = sh.split(";");
            } catch (_) { }

            // Map each signed header to its value from X-S3-{name}
            for (const h of signedHeadersList) {
                if (h === "host") continue; // fetch sets Host
                let value = request.headers.get(`X-S3-${h}`);
                // Auto-fill sha256 with standard value for presigned URLs
                if (!value && h === "x-amz-content-sha256") value = "UNSIGNED-PAYLOAD";
                if (value) s3Headers.set(h, value);
            }

            // If Content-Type is in URL query string, remove from headers (S3 rule: can't be in both)
            if (s3Url.includes("Content-Type=") || s3Url.includes("content-type=")) {
                s3Headers.delete("content-type");
                s3Headers.delete("Content-Type");
            }

            // CRITICAL: Wrap in Blob with empty type to prevent CF Workers from injecting
            // "Content-Type: application/octet-stream" automatically.
            // If content-type IS required by signing, we already set it in s3Headers above.
            const bodyBlob = new Blob([bodyBuffer]);

            const s3Resp = await fetch(s3Url, {
                method: "PUT",
                headers: s3Headers,
                body: bodyBlob,
                redirect: "manual",
                signal: AbortSignal.timeout(30000),
            });

            const etag = s3Resp.headers.get("ETag") || "";
            if (s3Resp.ok) {
                // Strip quotes from ETag (Python version does .strip('"'), VRChat expects no quotes)
                return jsonResp({ ok: true, etag: etag.replace(/"/g, "") }, 200);
            } else {
                const errText = await s3Resp.text();
                return jsonResp({
                    ok: false, status: s3Resp.status,
                    error: errText.substring(0, 500),
                    debug: { signedHeaders: signedHeadersList, sentHeaders: [...s3Headers.entries()] }
                }, s3Resp.status);
            }
        }


        // ── Dating Platform API ──
        if (path === '/api/dating/settings' && request.method === 'GET') {
            const vrcId = url.searchParams.get('vrc_id');
            const row = await executeD1Query(env, 'SELECT age_verified, dob FROM profiles WHERE vrc_id = ?', [vrcId], 'first');
            return jsonResp(row || { age_verified: 0, dob: null });
        }

        if (path === '/api/dating/settings' && request.method === 'POST') {
            // Age-gate is enforced server-side: the caller must prove (via their
            // live VRChat session) who they are, and either be 18+ on VRChat or
            // supply a DOB that resolves to 18+. A client could previously POST
            // { vrc_id: "<victim>", age_verified: true } with no auth at all.
            const { identity, response: authResp } = await requireDatingAuth(request, env);
            if (authResp) return authResp;
            const body = await request.json();
            const dob = body.dob || null;
            // Trust VRChat's 18+ flag; otherwise require a valid 18+ DOB.
            const verified = identity.age18 || isAdultFromDob(dob);
            if (!verified) {
                return jsonResp({ error: '此功能仅限年满18岁的用户使用' }, 403);
            }
            // Use the authenticated caller's id, NOT a client-supplied vrc_id.
            await executeD1Query(env, 'INSERT INTO profiles (vrc_id, age_verified, dob) VALUES (?, ?, ?) ON CONFLICT(vrc_id) DO UPDATE SET age_verified=excluded.age_verified, dob=excluded.dob', [identity.id, 1, dob], 'run');
            return jsonResp({ success: true });
        }

        if (path === '/api/dating/preferences' && request.method === 'POST') {
            const { identity, response: authResp } = await requireDatingAuth(request, env);
            if (authResp) return authResp;
            const body = await request.json();
            await executeD1Query(env, `
                UPDATE profiles 
                SET match_with_friends = ?, default_world_id = ?, default_region = ?, updated_at = CURRENT_TIMESTAMP
                WHERE vrc_id = ?
            `, [
                body.match_with_friends ? 1 : 0, 
                body.default_world_id || '', 
                body.default_region || '' , 
                identity.id
            ], 'run');
            return jsonResp({ success: true });
        }

        if (path === '/api/dating/profile' && request.method === 'GET') {
            const url = new URL(request.url);
            const vrcId = url.searchParams.get('vrc_id');
            if (!vrcId) {
                return jsonResp({ error: 'vrc_id is required' }, 400);
            }
            const profile = await executeD1Query(env, 'SELECT * FROM profiles WHERE vrc_id = ?', [vrcId], 'first');
            
            if (profile) {
                const ratingStats = await executeD1Query(env, 'SELECT AVG(score) as avgScore, COUNT(id) as ratingCount FROM ratings WHERE ratee_id = ?', [vrcId], 'first');
                profile.avgScore = ratingStats && ratingStats.avgScore ? Math.round(ratingStats.avgScore * 10) / 10 : 0;
                profile.ratingCount = ratingStats ? ratingStats.ratingCount : 0;
                
                const tagRows = await executeD1Query(env, 'SELECT tags, comment, is_pinned FROM ratings WHERE ratee_id = ? ORDER BY is_pinned DESC, created_at DESC', [vrcId], 'all');
                let tagCounts = {};
                let recentComments = [];
                if (tagRows && tagRows.results) {
                    for (let row of tagRows.results) {
                        try {
                            if (row.tags) {
                                const tags = JSON.parse(row.tags);
                                for (let t of tags) {
                                    tagCounts[t] = (tagCounts[t] || 0) + 1;
                                }
                            }
                        } catch(e){}
                        if (row.comment && row.comment.trim() !== '') {
                            recentComments.push({ text: row.comment, pinned: row.is_pinned });
                        }
                    }
                }
                profile.topTags = Object.entries(tagCounts).sort((a,b)=>b[1]-a[1]).slice(0, 5).map(e=>e[0]);
                profile.recentComments = recentComments.slice(0, 5); // Take top 5 (pinned first)
            }
            
            return jsonResp(profile || { not_found: true });
        }

        if (path === '/api/dating/profile' && request.method === 'POST') {
            // Writing a profile is identity-scoped: ignore any client-supplied
            // vrc_id and bind the row to the authenticated caller. This stops a
            // user from overwriting someone else's dating profile.
            const { identity, response: authResp } = await requireDatingAuth(request, env);
            if (authResp) return authResp;
            if (await isUserBanned(env, identity.id)) return jsonResp({ error: 'banned' }, 403);
            // Only let 18+-verified users maintain a dating profile at all.
            const mySettings = await executeD1Query(env, 'SELECT age_verified FROM profiles WHERE vrc_id = ?', [identity.id], 'first');
            const ageOk = (mySettings && mySettings.age_verified === 1) || identity.age18;
            if (!ageOk) {
                return jsonResp({ error: '请先完成 18+ 年龄验证' }, 403);
            }
            const body = await request.json();
            const galleryUrlsStr = Array.isArray(body.gallery_urls) ? JSON.stringify(body.gallery_urls) : (body.gallery_urls || '[]');

            await executeD1Query(env, `
                INSERT INTO profiles (vrc_id, display_name, photo_url, bio, pref_time, pref_inclination, pref_voice, pref_model, pref_gender, target_time, target_inclination, target_voice, target_model, target_gender, fbt_type, erp_model_type, succubus_type, phantom_touch, erp_kinks, erp_toys, gallery_urls, favorite_world_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(vrc_id) DO UPDATE SET
                display_name=excluded.display_name, photo_url=excluded.photo_url, bio=excluded.bio,
                pref_time=excluded.pref_time, pref_inclination=excluded.pref_inclination, pref_voice=excluded.pref_voice, pref_model=excluded.pref_model, pref_gender=excluded.pref_gender,
                target_time=excluded.target_time, target_inclination=excluded.target_inclination, target_voice=excluded.target_voice, target_model=excluded.target_model, target_gender=excluded.target_gender,
                fbt_type=excluded.fbt_type, erp_model_type=excluded.erp_model_type, succubus_type=excluded.succubus_type, phantom_touch=excluded.phantom_touch, erp_kinks=excluded.erp_kinks, erp_toys=excluded.erp_toys,
                gallery_urls=excluded.gallery_urls, favorite_world_id=excluded.favorite_world_id,
                updated_at=CURRENT_TIMESTAMP
            `, [
                identity.id, body.display_name, body.photo_url ?? '', body.bio ?? '',
                body.pref_time ?? '', body.pref_inclination ?? '', body.pref_voice ?? '', body.pref_model ?? '', body.pref_gender ?? '',
                body.target_time ?? '', body.target_inclination ?? '', body.target_voice ?? '', body.target_model ?? '', body.target_gender ?? '',
                body.fbt_type ?? '', body.erp_model_type ?? '', body.succubus_type ?? '', body.phantom_touch ?? '', body.erp_kinks ?? '', body.erp_toys ?? '',
                galleryUrlsStr, body.favorite_world_id ?? ''
            ], 'run');
            return jsonResp({ success: true });
        }

        if (path === '/api/dating/join' && request.method === 'POST') {
            // Authenticate: myId must come from the session, not the request body.
            const { identity, response: authResp } = await requireDatingAuth(request, env);
            if (authResp) return authResp;
            const myId = identity.id;
            if (await isUserBanned(env, myId)) return jsonResp({ error: 'banned' }, 403);
            const body = await request.json();
            const excludedFriends = Array.isArray(body.exclude_friends) ? body.exclude_friends : [];

            const myProfile = await executeD1Query(env, 'SELECT * FROM profiles WHERE vrc_id = ?', [myId], 'first');
            if (!myProfile) return jsonResp({ error: '请先完善交友档案！' }, 400);
            // 18+ gate: never let an unverified user join the match pool.
            if (!(myProfile.age_verified === 1 || identity.age18)) {
                return jsonResp({ error: '请先完成 18+ 年龄验证' }, 403);
            }

            const myStatus = await executeD1Query(env, 'SELECT * FROM match_pool WHERE vrc_id = ?', [myId], 'first');
            if (myStatus && myStatus.status === 'matched') {
                return jsonResp({ success: true, matched: true, matched_with: myStatus.matched_with });
            }

            // Batch-load everything we need ONCE instead of one query per
            // waiting user (the old N+1 fired 2 subqueries × pool size, which
            // against D1's per-Worker subrequest cap could abort mid-scan on a
            // busy pool).
            const pool = await executeD1Query(env, 'SELECT * FROM match_pool WHERE status = ? AND vrc_id != ?', ['waiting', myId], 'all');
            const waitingIds = (pool.results || []).map(r => r.vrc_id);

            const excludedSet = new Set(excludedFriends);
            // My blacklist (either direction) — one row per blocked pair.
            const blockRows = await executeD1Query(env, 'SELECT user_id, blocked_id FROM blacklist WHERE user_id = ? OR blocked_id = ?', [myId, myId], 'all');
            const blockedSet = new Set();
            for (const r of (blockRows.results || [])) {
                if (r.user_id === myId) blockedSet.add(r.blocked_id);
                if (r.blocked_id === myId) blockedSet.add(r.user_id);
            }

            // All candidate profiles in one query.
            let profileMap = new Map();
            if (waitingIds.length > 0) {
                const placeholders = waitingIds.map(() => '?').join(',');
                const profRows = await executeD1Query(env, `SELECT * FROM profiles WHERE vrc_id IN (${placeholders})`, [...waitingIds], 'all');
                for (const p of (profRows.results || [])) profileMap.set(p.vrc_id, p);
            }

            let bestMatch = null;
            let bestScore = -1;
            let bestMatchScore = 0;
            let bestMatchTheirScore = 0;

            for (const waitingUser of (pool.results || [])) {
                const theirId = waitingUser.vrc_id;
                if (excludedSet.has(theirId)) continue;
                if (blockedSet.has(theirId)) continue;

                const theirProfile = profileMap.get(theirId);
                if (!theirProfile) continue;

                const { score, theirScore } = calculateDatingPairScores(myProfile, theirProfile);

                if (score >= 60 && theirScore >= 60) {
                    if (score + theirScore > bestScore) {
                        bestScore = score + theirScore;
                        bestMatch = theirId;
                        bestMatchScore = score;
                        bestMatchTheirScore = theirScore;
                    }
                }
            }

            if (bestMatch) {
                // Optimistic lock: only match if target is STILL waiting.
                // AND status = "waiting" prevents two simultaneous /join requests
                // from both claiming the same waiting user.
                const grab = await executeD1Query(env, 'UPDATE match_pool SET status = "matched", matched_with = ? WHERE vrc_id = ? AND status = "waiting"', [myId, bestMatch], 'run');
                
                // D1 direct returns { meta: { changes: N } }.
                // D1 proxy may or may not include meta; fall back to a SELECT verify
                // if changes info is unavailable (fail-safe rather than fail-crash).
                let grabbed = true;
                if (grab && grab.meta && typeof grab.meta.changes === 'number') {
                    grabbed = grab.meta.changes > 0;
                } else {
                    // Proxy path: verify by reading back
                    const verify = await executeD1Query(env, 'SELECT matched_with FROM match_pool WHERE vrc_id = ? AND status = "matched"', [bestMatch], 'first');
                    grabbed = !!(verify && verify.matched_with === myId);
                }

                if (!grabbed) {
                    // Target was grabbed by someone else in the same millisecond.
                    // Put ourselves back into waiting pool; client will poll again.
                    await executeD1Query(env, 'INSERT INTO match_pool (vrc_id, status, matched_with) VALUES (?, "waiting", NULL) ON CONFLICT(vrc_id) DO UPDATE SET status="waiting", matched_with=NULL', [myId], 'run');
                    return jsonResp({ success: true, matched: false, mode: 'public' });
                }

                // Record the match for BOTH users via single-row upserts.
                await executeD1Query(env, 'INSERT INTO match_pool (vrc_id, status, matched_with) VALUES (?, ?, ?) ON CONFLICT(vrc_id) DO UPDATE SET status=excluded.status, matched_with=excluded.matched_with', [myId, 'matched', bestMatch], 'run');
                // The target was already UPDATE'd above, but we run this UPSERT just to be consistent and resilient.
                await executeD1Query(env, 'INSERT INTO match_pool (vrc_id, status, matched_with) VALUES (?, ?, ?) ON CONFLICT(vrc_id) DO UPDATE SET status=excluded.status, matched_with=excluded.matched_with', [bestMatch, 'matched', myId], 'run');

                // Add to history for both users
                const sessionId = crypto.randomUUID();
                await executeD1Query(env, 'INSERT INTO match_history (user_id, matched_with, session_id) VALUES (?, ?, ?)', [myId, bestMatch, sessionId], 'run');
                await executeD1Query(env, 'INSERT INTO match_history (user_id, matched_with, session_id) VALUES (?, ?, ?)', [bestMatch, myId, sessionId], 'run');

                return jsonResp({ success: true, matched: true, matched_with: bestMatch, score: bestMatchScore, theirScore: bestMatchTheirScore });
            } else {
                if (body.mode === 'invisible') {
                    await executeD1Query(env, 'DELETE FROM match_pool WHERE vrc_id = ?', [myId], 'run');
                    return jsonResp({ success: true, matched: false, mode: 'invisible' });
                } else {
                    await executeD1Query(env, 'INSERT INTO match_pool (vrc_id, status, matched_with) VALUES (?, "waiting", NULL) ON CONFLICT(vrc_id) DO UPDATE SET status="waiting", matched_with=NULL', [myId], 'run');
                    return jsonResp({ success: true, matched: false, mode: 'public' });
                }
            }
        }

        if (path === '/api/dating/stream' && request.method === 'GET') {
            const { identity, response: authResp } = await requireDatingAuth(request, env);
            if (authResp) return authResp;
            const myId = identity.id;

            const { readable, writable } = new TransformStream();
            const writer = writable.getWriter();
            const encoder = new TextEncoder();

            ctx.waitUntil((async () => {
                try {
                    let iterations = 0;
                    while (!request.signal.aborted) {
                        const record = await executeD1Query(env, 'SELECT * FROM match_pool WHERE vrc_id = ?', [myId], 'first');
                        if (!record) {
                            await writer.write(encoder.encode(`data: {"waiting":false,"matched":false}\n\n`));
                            break;
                        }

                        if (record.status === 'matched') {
                            const target = await executeD1Query(env, 'SELECT * FROM profiles WHERE vrc_id = ?', [record.matched_with], 'first');
                            await writer.write(encoder.encode(`data: {"waiting":false,"matched":true,"target":${JSON.stringify(target)}}\n\n`));
                            break;
                        }

                        // Heartbeat to keep connection alive
                        await writer.write(encoder.encode(`:\n\n`));

                        iterations++;
                        let delay = 3000;
                        if (iterations > 10) delay = 5000;  // 30s后，降到5秒查一次
                        if (iterations > 22) delay = 8000;  // ~1.5分钟后，降到8秒查一次
                        if (iterations > 35) delay = 15000; // ~3分钟后，降到15秒查一次，大幅节省D1查询
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                } catch (e) {
                    console.error("SSE Error:", e);
                } finally {
                    await writer.close().catch(() => {});
                }
            })());

            return new Response(readable, {
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                }
            });
        }

        if (path === '/api/dating/status' && request.method === 'GET') {
            // Private: returns who I matched with + their full profile.
            const { identity, response: authResp } = await requireDatingAuth(request, env);
            if (authResp) return authResp;
            const record = await executeD1Query(env, 'SELECT * FROM match_pool WHERE vrc_id = ?', [identity.id], 'first');
            if (!record) return jsonResp({ waiting: false, matched: false });

            if (record.status === 'matched') {
                const myProfile = await executeD1Query(env, 'SELECT * FROM profiles WHERE vrc_id = ?', [identity.id], 'first');
                const target = await executeD1Query(env, 'SELECT * FROM profiles WHERE vrc_id = ?', [record.matched_with], 'first');
                // Re-calculate scores so the frontend can display the authoritative
                // match percentage (avoids the frontend's stale/local recalculation).
                const { score, theirScore } = (myProfile && target)
                    ? calculateDatingPairScores(myProfile, target)
                    : { score: 0, theirScore: 0 };
                return jsonResp({ waiting: false, matched: true, target, score, theirScore });
            }
            return jsonResp({ waiting: true, matched: false });
        }

        if (path === '/api/dating/leave' && request.method === 'POST') {
            const { identity, response: authResp } = await requireDatingAuth(request, env);
            if (authResp) return authResp;
            const myId = identity.id;
            const myRecord = await executeD1Query(env, 'SELECT * FROM match_pool WHERE vrc_id = ?', [myId], 'first');
            if (myRecord && myRecord.status === 'matched' && myRecord.matched_with) {
                 await executeD1Query(env, 'UPDATE match_pool SET status = ?, matched_with = NULL WHERE vrc_id = ?', ['waiting', myRecord.matched_with], 'run');
            }
            await executeD1Query(env, 'DELETE FROM match_pool WHERE vrc_id = ?', [myId], 'run');
            return jsonResp({ success: true });
        }
        if (path === '/api/dating/cancel_match' && request.method === 'POST') {
            const { identity, response: authResp } = await requireDatingAuth(request, env);
            if (authResp) return authResp;
            const myId = identity.id;
            const myRecord = await executeD1Query(env, 'SELECT * FROM match_pool WHERE vrc_id = ?', [myId], 'first');
            if (myRecord && myRecord.status === 'matched' && myRecord.matched_with) {
                 await executeD1Query(env, 'UPDATE match_pool SET status = ?, matched_with = NULL WHERE vrc_id = ? OR vrc_id = ?', ['waiting', myId, myRecord.matched_with], 'run');
            } else {
                 await executeD1Query(env, 'UPDATE match_pool SET status = ?, matched_with = NULL WHERE vrc_id = ?', ['waiting', myId], 'run');
            }
            return jsonResp({ success: true });
        }

        // DELETE /api/dating/delete_account — user self-service data wipe ("跑路")
        // Removes ALL of the caller's dating data from every table. Irreversible.
        if (path === '/api/dating/delete_account' && request.method === 'DELETE') {
            const { identity, response: authResp } = await requireDatingAuth(request, env);
            if (authResp) return authResp;
            const myId = identity.id;
            await executeD1Query(env, 'DELETE FROM profiles WHERE vrc_id = ?', [myId], 'run');
            await executeD1Query(env, 'DELETE FROM match_pool WHERE vrc_id = ? OR matched_with = ?', [myId, myId], 'run');
            await executeD1Query(env, 'DELETE FROM match_history WHERE user_id = ? OR matched_with = ?', [myId, myId], 'run');
            await executeD1Query(env, 'DELETE FROM e_friends WHERE user_id = ? OR friend_id = ?', [myId, myId], 'run');
            await executeD1Query(env, 'DELETE FROM ratings WHERE rater_id = ? OR ratee_id = ?', [myId, myId], 'run');
            await executeD1Query(env, 'DELETE FROM blacklist WHERE user_id = ? OR blocked_id = ?', [myId, myId], 'run');
            return jsonResp({ success: true });
        }

        if (path === '/api/dating/block' && request.method === 'POST') {
            const { identity, response: authResp } = await requireDatingAuth(request, env);
            if (authResp) return authResp;
            const myId = identity.id;
            const body = await request.json();
            const blockedId = body.blocked_id;
            if (!blockedId || blockedId === myId) return jsonResp({ error: "Invalid blocked_id" }, 400);
            await executeD1Query(env, 'INSERT OR IGNORE INTO blacklist (user_id, blocked_id) VALUES (?, ?)', [myId, blockedId], 'run');
            await executeD1Query(env, 'UPDATE match_pool SET status = ?, matched_with = NULL WHERE vrc_id = ? OR vrc_id = ?', ['waiting', myId, blockedId], 'run');
            return jsonResp({ success: true });
        }

        if (path === '/api/dating/block' && request.method === 'GET') {
            const { identity, response: authResp } = await requireDatingAuth(request, env);
            if (authResp) return authResp;
            const list = await executeD1Query(env, `
                SELECT b.blocked_id, p.display_name, p.photo_url
                FROM blacklist b
                LEFT JOIN profiles p ON b.blocked_id = p.vrc_id
                WHERE b.user_id = ?
            `, [identity.id], 'all');
            return jsonResp({ success: true, list: list.results });
        }

        if (path === '/api/dating/confirm_match' && request.method === 'POST') {
            const { identity, response: authResp } = await requireDatingAuth(request, env);
            if (authResp) return authResp;
            const body = await request.json();
            const sessionId = body.session_id;
            if (!sessionId) return jsonResp({ error: "Missing fields" }, 400);

            await executeD1Query(env, 'UPDATE match_history SET confirmed_by_me = 1 WHERE user_id = ? AND session_id = ?', [identity.id, sessionId], 'run');
            return jsonResp({ success: true });
        }

        if (path === '/api/dating/rate' && request.method === 'POST') {
            const { identity, response: authResp } = await requireDatingAuth(request, env);
            if (authResp) return authResp;
            const body = await request.json();
            const raterId = identity.id;
            const rateeId = body.ratee_id;
            const sessionId = body.session_id;
            const score = parseInt(body.score);
            const tags = JSON.stringify(Array.isArray(body.tags) ? body.tags : []);
            let comment = body.comment || "";

            if (!rateeId || !sessionId || isNaN(score) || score < 1 || score > 10) {
                return jsonResp({ error: "Invalid input" }, 400);
            }

            if (comment.length > 100) {
                comment = comment.substring(0, 100);
            }

            // Check if both confirmed THIS specific session
            const h1 = await executeD1Query(env, 'SELECT confirmed_by_me as c FROM match_history WHERE user_id = ? AND session_id = ?', [raterId, sessionId], 'first');
            const h2 = await executeD1Query(env, 'SELECT confirmed_by_me as c FROM match_history WHERE user_id = ? AND session_id = ?', [rateeId, sessionId], 'first');

            if (!h1 || !h2 || !h1.c || !h2.c) {
                return jsonResp({ error: "Both users must confirm they met before rating." }, 403);
            }

            await executeD1Query(env, `
                INSERT INTO ratings (rater_id, ratee_id, score, tags, comment, session_id)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(rater_id, session_id) DO UPDATE SET score=excluded.score, tags=excluded.tags, comment=excluded.comment, created_at=CURRENT_TIMESTAMP
            `, [raterId, rateeId, score, tags, comment, sessionId], 'run');

            return jsonResp({ success: true });
        }

        if (path === '/api/dating/my_ratings' && request.method === 'GET') {
            const { identity, response: authResp } = await requireDatingAuth(request, env);
            if (authResp) return authResp;
            const vrcId = identity.id;

            const givenRaw = await executeD1Query(env, `
                SELECT r.id, r.ratee_id, p.display_name, r.score, r.tags, r.comment, r.created_at
                FROM ratings r
                LEFT JOIN profiles p ON r.ratee_id = p.vrc_id
                WHERE r.rater_id = ?
                ORDER BY r.created_at DESC
            `, [vrcId], 'all');

            const receivedRaw = await executeD1Query(env, `
                SELECT id, score, tags, comment, is_pinned, created_at
                FROM ratings
                WHERE ratee_id = ?
                ORDER BY created_at DESC
            `, [vrcId], 'all');

            return jsonResp({
                given: givenRaw && givenRaw.results ? givenRaw.results : [],
                received: receivedRaw && receivedRaw.results ? receivedRaw.results : []
            });
        }

        if (path === '/api/dating/pin_rating' && request.method === 'POST') {
            const { identity, response: authResp } = await requireDatingAuth(request, env);
            if (authResp) return authResp;
            const body = await request.json();
            const vrcId = identity.id;
            const ratingId = body.rating_id;
            const pinned = body.pinned ? 1 : 0;

            if (!ratingId) return jsonResp({ error: "Missing fields" }, 400);

            if (pinned) {
                const countRes = await executeD1Query(env, 'SELECT COUNT(id) as c FROM ratings WHERE ratee_id = ? AND is_pinned = 1', [vrcId], 'first');
                if (countRes && countRes.c >= 3) {
                    return jsonResp({ error: "最多只能展示 3 条评价在主页" }, 400);
                }
            }

            await executeD1Query(env, 'UPDATE ratings SET is_pinned = ? WHERE id = ? AND ratee_id = ?', [pinned, ratingId, vrcId], 'run');
            return jsonResp({ success: true });
        }

        if (path === '/api/dating/block' && request.method === 'DELETE') {
            const { identity, response: authResp } = await requireDatingAuth(request, env);
            if (authResp) return authResp;
            const body = await request.json();
            const blockedId = body.blocked_id;
            await executeD1Query(env, 'DELETE FROM blacklist WHERE user_id = ? AND blocked_id = ?', [identity.id, blockedId], 'run');
            return jsonResp({ success: true });
        }

        if (path === '/api/dating/history' && request.method === 'GET') {
            // Private: only the authenticated caller may read their own history.
            const { identity, response: authResp } = await requireDatingAuth(request, env);
            if (authResp) return authResp;
            const list = await executeD1Query(env, `
                SELECT h.matched_with as id, p.display_name, p.photo_url, p.bio, p.pref_gender, p.pref_time, p.pref_voice, p.favorite_world_id, h.created_at as last_matched,
                h.confirmed_by_me,
                h.session_id,
                (SELECT confirmed_by_me FROM match_history h2 WHERE h2.session_id = h.session_id AND h2.user_id = h.matched_with) as confirmed_by_them,
                (SELECT score FROM ratings r WHERE r.session_id = h.session_id AND r.rater_id = h.user_id) as my_rating,
                (SELECT score FROM ratings r WHERE r.session_id = h.session_id AND r.rater_id = h.matched_with) as their_rating
                FROM match_history h
                LEFT JOIN profiles p ON h.matched_with = p.vrc_id
                WHERE h.user_id = ?
                ORDER BY h.created_at DESC
                LIMIT 500
            `, [identity.id], 'all');
            return jsonResp({ success: true, list: list.results });
        }

        if (path === '/api/dating/friends' && request.method === 'GET') {
            const { identity, response: authResp } = await requireDatingAuth(request, env);
            if (authResp) return authResp;
            const list = await executeD1Query(env, `
                SELECT f.friend_id as id, p.display_name, p.photo_url, p.bio, p.pref_gender, p.pref_time, p.pref_voice, p.favorite_world_id, f.created_at
                FROM e_friends f
                LEFT JOIN profiles p ON f.friend_id = p.vrc_id
                WHERE f.user_id = ?
                ORDER BY f.created_at DESC
            `, [identity.id], 'all');

            // 顺便把 ID 列表单独提出来，方便前端判断是否已收藏
            const ids = list.results.map(r => r.id);
            return jsonResp({ success: true, list: list.results, friend_ids: ids });
        }

        if (path === '/api/dating/friends' && request.method === 'POST') {
            const { identity, response: authResp } = await requireDatingAuth(request, env);
            if (authResp) return authResp;
            const body = await request.json();
            const myId = identity.id;
            const friendId = body.friend_id;
            const action = body.action; // 'add' or 'remove'
            if (!friendId) return jsonResp({ error: "Missing friend_id" }, 400);

            if (action === 'add') {
                await executeD1Query(env, 'INSERT OR IGNORE INTO e_friends (user_id, friend_id) VALUES (?, ?)', [myId, friendId], 'run');
            } else if (action === 'remove') {
                await executeD1Query(env, 'DELETE FROM e_friends WHERE user_id = ? AND friend_id = ?', [myId, friendId], 'run');
            }
            return jsonResp({ success: true });
        }

        if (path === '/api/dating/backup/export' && request.method === 'GET') {
            const authHeader = request.headers.get('Authorization');
            const expectedToken = env.BACKUP_SECRET || "u)1X^4@wuyjhc,2Da*GL";
            if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
                return jsonResp({ error: "Unauthorized backup request" }, 401);
            }

            try {
                // Fetch data from all relevant D1 tables.
                // executeD1Query returns an array in direct-DB mode (no .results)
                // but an object with .results in proxy mode. Normalize both.
                const norm = (r) => Array.isArray(r) ? r : (r && r.results) ? r.results : [];
                const profiles = norm(await executeD1Query(env, 'SELECT * FROM profiles', [], 'all'));
                const matchPool = norm(await executeD1Query(env, 'SELECT * FROM match_pool', [], 'all'));
                const history = norm(await executeD1Query(env, 'SELECT * FROM match_history', [], 'all'));
                const blacklist = norm(await executeD1Query(env, 'SELECT * FROM blacklist', [], 'all'));
                const friends = norm(await executeD1Query(env, 'SELECT * FROM e_friends', [], 'all'));
                const ratings = norm(await executeD1Query(env, 'SELECT * FROM ratings', [], 'all'));

                // Organize data by user
                const userMap = {};
                for (const p of profiles) {
                    userMap[p.vrc_id] = {
                        profile_info: p,
                        active_in_pool: null,
                        e_friends: [],
                        match_history: [],
                        ratings_given: [],
                        ratings_received: [],
                        blacklist: []
                    };
                }

                const ensureUser = (id) => {
                    if (!userMap[id]) userMap[id] = { profile_info: { vrc_id: id, note: "User not in profiles table" }, active_in_pool: null, e_friends: [], match_history: [], ratings_given: [], ratings_received: [], blacklist: [] };
                };

                for (const m of matchPool) {
                    ensureUser(m.vrc_id);
                    userMap[m.vrc_id].active_in_pool = m;
                }
                for (const h of history) {
                    ensureUser(h.user_id);
                    userMap[h.user_id].match_history.push(h);
                }
                for (const f of friends) {
                    ensureUser(f.user_id);
                    userMap[f.user_id].e_friends.push(f);
                }
                for (const b of blacklist) {
                    ensureUser(b.user_id);
                    userMap[b.user_id].blacklist.push(b);
                }
                for (const r of ratings) {
                    ensureUser(r.rater_id);
                    userMap[r.rater_id].ratings_given.push(r);
                    ensureUser(r.ratee_id);
                    userMap[r.ratee_id].ratings_received.push(r);
                }

                const backupData = {
                    timestamp: new Date().toISOString(),
                    total_users: Object.keys(userMap).length,
                    users: Object.values(userMap)
                };

                return new Response(JSON.stringify(backupData, null, 4), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Disposition': `attachment; filename="vrc_db_backup_${new Date().toISOString().split('T')[0]}.json"`
                    }
                });
            } catch (e) {
                return jsonResp({ error: "Backup failed: " + e.message }, 500);
            }
        }

        // ── Admin API ──────────────────────────────────────────────────────
        // All /api/admin/* routes require X-Admin-Token header matching ADMIN_SECRET.
        if (path.startsWith('/api/admin/')) {
            const { ok, response: authFail } = await requireAdminAuth(request, env);
            if (!ok) return authFail;

            // GET /api/admin/stats — dashboard summary
            if (path === '/api/admin/stats' && request.method === 'GET') {
                const totalUsers = await executeD1Query(env, 'SELECT COUNT(*) as c FROM profiles', [], 'first');
                const inPool = await executeD1Query(env, 'SELECT COUNT(*) as c FROM match_pool', [], 'first');
                const banned = await executeD1Query(env, 'SELECT COUNT(*) as c FROM banned_users', [], 'first');
                const totalMatches = await executeD1Query(env, 'SELECT COUNT(*) as c FROM match_history', [], 'first');
                const todayStart = new Date().toISOString().split('T')[0] + 'T00:00:00';
                const todayNew = await executeD1Query(env, 'SELECT COUNT(*) as c FROM profiles WHERE updated_at >= ?', [todayStart], 'first');
                return jsonResp({
                    totalUsers: totalUsers?.c || 0,
                    inPool: inPool?.c || 0,
                    banned: banned?.c || 0,
                    totalMatches: totalMatches?.c || 0,
                    todayNew: todayNew?.c || 0
                });
            }

            // GET /api/admin/match-pool — list everyone currently in the pool
            if (path === '/api/admin/match-pool' && request.method === 'GET') {
                const rows = await executeD1Query(env, `
                    SELECT m.vrc_id, m.status, m.matched_with, m.created_at,
                           p.display_name, p.photo_url
                    FROM match_pool m
                    LEFT JOIN profiles p ON m.vrc_id = p.vrc_id
                    ORDER BY m.created_at DESC
                `, [], 'all');
                const pool = rows.results || [];
                // Attach banned status
                const ids = pool.map(r => r.vrc_id).filter(Boolean);
                let bannedSet = new Set();
                if (ids.length > 0) {
                    const placeholders = ids.map(() => '?').join(',');
                    const br = await executeD1Query(env, `SELECT vrc_id FROM banned_users WHERE vrc_id IN (${placeholders})`, ids, 'all');
                    bannedSet = new Set((br.results || []).map(r => r.vrc_id));
                }
                return jsonResp({ pool: pool.map(r => ({ ...r, is_banned: bannedSet.has(r.vrc_id) })) });
            }

            // GET /api/admin/users?page=1&search=keyword
            if (path === '/api/admin/users' && request.method === 'GET') {
                const url = new URL(request.url);
                const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
                const pageSize = Math.min(100, parseInt(url.searchParams.get('pageSize') || '20'));
                const search = (url.searchParams.get('search') || '').trim();
                const offset = (page - 1) * pageSize;

                let query, params;
                if (search) {
                    query = `SELECT vrc_id, display_name, photo_url, bio, age_verified, dob, default_region, updated_at FROM profiles WHERE display_name LIKE ? OR vrc_id LIKE ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
                    params = [`%${search}%`, `%${search}%`, pageSize, offset];
                } else {
                    query = `SELECT vrc_id, display_name, photo_url, bio, age_verified, dob, default_region, updated_at FROM profiles ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
                    params = [pageSize, offset];
                }
                const rows = await executeD1Query(env, query, params, 'all');
                const countRow = await executeD1Query(env, search ? 'SELECT COUNT(*) as c FROM profiles WHERE display_name LIKE ? OR vrc_id LIKE ?' : 'SELECT COUNT(*) as c FROM profiles', search ? [`%${search}%`, `%${search}%`] : [], 'first');
                // Fetch banned status for the returned users
                const userIds = (rows.results || []).map(r => r.vrc_id);
                let bannedSet = new Set();
                if (userIds.length > 0) {
                    const placeholders = userIds.map(() => '?').join(',');
                    const bannedRows = await executeD1Query(env, `SELECT vrc_id FROM banned_users WHERE vrc_id IN (${placeholders})`, userIds, 'all');
                    bannedSet = new Set((bannedRows.results || []).map(r => r.vrc_id));
                }
                const users = (rows.results || []).map(r => ({ ...r, is_banned: bannedSet.has(r.vrc_id) }));
                return jsonResp({ users, total: countRow?.c || 0, page, pageSize });
            }

            // GET /api/admin/users/:id — full user data
            if (path.startsWith('/api/admin/users/') && request.method === 'GET') {
                const targetId = path.split('/').pop();
                const profile = await executeD1Query(env, 'SELECT * FROM profiles WHERE vrc_id = ?', [targetId], 'first');
                if (!profile) return jsonResp({ error: "User not found" }, 404);
                const poolRow = await executeD1Query(env, 'SELECT * FROM match_pool WHERE vrc_id = ?', [targetId], 'first');
                const history = await executeD1Query(env, 'SELECT * FROM match_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [targetId], 'all');
                const eFriends = await executeD1Query(env, 'SELECT * FROM e_friends WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [targetId], 'all');
                const ratingsGiven = await executeD1Query(env, 'SELECT * FROM ratings WHERE rater_id = ? ORDER BY created_at DESC LIMIT 50', [targetId], 'all');
                const ratingsReceived = await executeD1Query(env, 'SELECT * FROM ratings WHERE ratee_id = ? ORDER BY created_at DESC LIMIT 50', [targetId], 'all');
                const blacklist = await executeD1Query(env, 'SELECT * FROM blacklist WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [targetId], 'all');
                const banned = await executeD1Query(env, 'SELECT * FROM banned_users WHERE vrc_id = ?', [targetId], 'first');
                return jsonResp({ profile, pool: poolRow, history: history.results, eFriends: eFriends.results, ratingsGiven: ratingsGiven.results, ratingsReceived: ratingsReceived.results, blacklist: blacklist.results, banned });
            }

            // DELETE /api/admin/users/:id — delete all user data
            if (path.startsWith('/api/admin/users/') && request.method === 'DELETE') {
                const targetId = path.split('/').pop();
                await executeD1Query(env, 'DELETE FROM profiles WHERE vrc_id = ?', [targetId], 'run');
                await executeD1Query(env, 'DELETE FROM match_pool WHERE vrc_id = ? OR matched_with = ?', [targetId, targetId], 'run');
                await executeD1Query(env, 'DELETE FROM match_history WHERE user_id = ? OR matched_with = ?', [targetId, targetId], 'run');
                await executeD1Query(env, 'DELETE FROM e_friends WHERE user_id = ? OR friend_id = ?', [targetId, targetId], 'run');
                await executeD1Query(env, 'DELETE FROM ratings WHERE rater_id = ? OR ratee_id = ?', [targetId, targetId], 'run');
                await executeD1Query(env, 'DELETE FROM blacklist WHERE user_id = ? OR blocked_id = ?', [targetId, targetId], 'run');
                await executeD1Query(env, 'DELETE FROM banned_users WHERE vrc_id = ?', [targetId], 'run');
                return jsonResp({ success: true });
            }

            // POST /api/admin/users/:id/ban — ban/unban
            if (path.startsWith('/api/admin/users/') && path.endsWith('/ban') && request.method === 'POST') {
                const targetId = path.split('/')[4]; // /api/admin/users/:id/ban
                const body = await request.json().catch(() => ({}));
                if (body.unban) {
                    await executeD1Query(env, 'DELETE FROM banned_users WHERE vrc_id = ?', [targetId], 'run');
                    return jsonResp({ success: true, banned: false });
                }
                const reason = body.reason || '';
                const nameSnap = body.display_name || '';
                await executeD1Query(env, 'INSERT OR REPLACE INTO banned_users (vrc_id, reason, display_name_snapshot, banned_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)', [targetId, reason, nameSnap], 'run');
                // Kick from match pool and release anyone matched with them.
                await executeD1Query(env, 'DELETE FROM match_pool WHERE vrc_id = ?', [targetId], 'run');
                await executeD1Query(env, 'UPDATE match_pool SET status = "waiting", matched_with = NULL WHERE matched_with = ?', [targetId], 'run');
                return jsonResp({ success: true, banned: true });
            }

            // PATCH /api/admin/users/:id — edit fields
            if (path.startsWith('/api/admin/users/') && request.method === 'PATCH') {
                const targetId = path.split('/').pop();
                const exists = await executeD1Query(env, 'SELECT vrc_id FROM profiles WHERE vrc_id = ?', [targetId], 'first');
                if (!exists) return jsonResp({ error: "User not found" }, 404);
                const body = await request.json().catch(() => ({}));
                const allowedFields = ['age_verified', 'display_name', 'bio', 'pref_time', 'pref_inclination', 'pref_voice', 'pref_model', 'pref_gender', 'target_time', 'target_inclination', 'target_voice', 'target_model', 'target_gender', 'match_with_friends', 'default_region', 'default_world_id', 'favorite_world_id'];
                const updates = [];
                const params = [];
                for (const [k, v] of Object.entries(body)) {
                    if (allowedFields.includes(k)) {
                        updates.push(`${k} = ?`);
                        params.push(v);
                    }
                }
                if (updates.length === 0) return jsonResp({ error: "No valid fields to update" }, 400);
                updates.push('updated_at = CURRENT_TIMESTAMP');
                params.push(targetId);
                await executeD1Query(env, `UPDATE profiles SET ${updates.join(', ')} WHERE vrc_id = ?`, params, 'run');
                return jsonResp({ success: true });
            }

            // GET /api/admin/banned — list banned users
            if (path === '/api/admin/banned' && request.method === 'GET') {
                const rows = await executeD1Query(env, 'SELECT * FROM banned_users ORDER BY banned_at DESC', [], 'all');
                return jsonResp({ banned: rows.results });
            }
        }

        return jsonResp({ error: "Not found" }, 404);
    },
};

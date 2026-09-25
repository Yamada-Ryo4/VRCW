/**
 * VRChat Avatar Manager — Cloudflare Worker
 * Proxies VRChat API calls to bypass CORS restrictions.
 * The browser handles S3 uploads directly for maximum speed.
 */

const VRC_API = "https://api.vrchat.cloud/api/1";
const API_KEY = "JlGlobalv959ay9puS6p99En0asKuAk";
const USER_AGENT = "VRCX/1.6.4 (vrcxml@gmail.com)";
// avatarrecovery.com explicitly bans the old VRCX-mimicking UA string above
// ("This User-Agent is banned"), while Cloudflare fronting rejects non-VRCX
// user agents outright. A current VRCX release string is accepted by both.
const COMMUNITY_USER_AGENT = "VRCX/2026.09.01";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-VRC-Auth, X-S3-Url, X-S3-content-md5, X-S3-content-type",
    "Access-Control-Expose-Headers": "X-VRC-Auth",
};

function bytesToBase64Url(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
    // avtr.icu is a community avatar index whose thumbnail URLs point at its
    // own /proxy/ endpoint; it 302s to its R2-backed image cache (zuxi.dev).
    ".avtr.icu",
    ".zuxi.dev",
];
const DELIVERY_CDN_SUFFIXES = [
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
    "avtr.icu",
]);
// Only these exact VRChat origins may receive a user's Cookie. Community
// services remain valid proxy targets, but can never authorize delivery-CDN
// redirects or receive VRChat credentials.
const CREDENTIAL_ALLOWED_HOSTS = new Set([
    "api.vrchat.cloud",
    "files.vrchat.cloud",
    "vrchat.cloud",
]);

function isSafeProxyUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return null;
    }
    if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password) return null;
    return parsed;
}

function isAllowedTarget(rawUrl) {
    const parsed = isSafeProxyUrl(rawUrl);
    if (!parsed) return false;
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_HOSTS.has(host) || ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function isAllowedDeliveryCdnTarget(rawUrl) {
    const parsed = isSafeProxyUrl(rawUrl);
    return !!parsed && DELIVERY_CDN_SUFFIXES.some((suffix) => parsed.hostname.toLowerCase().endsWith(suffix));
}

function isAllowedImageContentType(contentType) {
    const mime = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
    return mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp' || mime === 'image/gif';
}

function isAllowedJsonContentType(contentType) {
    const mime = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
    return mime === 'application/json' || mime.endsWith('+json');
}

function isCredentialAllowedTarget(rawUrl) {
    const parsed = isSafeProxyUrl(rawUrl);
    return !!parsed && CREDENTIAL_ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
}

function headersForProxyHop(options, currentUrl) {
    const headers = new Headers(options.headers || {});
    // Cookie is a VRChat credential. Rebuild headers for every hop and only
    // attach it to the exact VRChat hosts that require it; community hosts and
    // delivery CDNs must never receive it.
    if (!isCredentialAllowedTarget(currentUrl)) {
        headers.delete('Cookie');
        // Community API operators (avatarrecovery.com) ban the VRChat-login UA
        // string; community fetches identify with a current VRCX release
        // instead. VRChat hops keep the login-proven USER_AGENT untouched.
        headers.set('User-Agent', COMMUNITY_USER_AGENT);
    }
    return headers;
}

async function fetchAllowedWithRedirects(initialUrl, options = {}, maxHops = 3) {
    let current = new URL(initialUrl);
    let redirectedFromCredentialHost = false;
    for (let hop = 0; hop <= maxHops; hop++) {
        const allowed = isAllowedTarget(current.toString())
            || (redirectedFromCredentialHost && isAllowedDeliveryCdnTarget(current.toString()));
        if (!allowed) throw new Error('Target host not allowed');
        const hopOptions = { ...options, headers: headersForProxyHop(options, current), redirect: 'manual' };
        const response = await fetch(current.toString(), hopOptions);
        if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: current };
        const location = response.headers.get('location');
        if (!location || hop === maxHops) throw new Error('Invalid redirect');
        redirectedFromCredentialHost = isCredentialAllowedTarget(current.toString());
        current = new URL(location, current);
    }
    throw new Error('Too many redirects');
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

function sanitizeWorldDownloadFilename(worldName, worldId) {
    let base = String(worldName || "world")
        .normalize('NFKC')
        .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
        .replace(/[. ]+$/g, '')
        .trim()
        .slice(0, 100);
    if (!base || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base = 'world';
    const suffix = String(worldId || '').slice(-8);
    return `${base}_${suffix}_windows.vrcw`;
}

function asciiDownloadFilename(filename) {
    return String(filename || 'download.vrcw')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\x20-\x7e]/g, '_')
        .replace(/[\r\n"]/g, '_')
        .replace(/[\\/]/g, '_')
        .slice(0, 180) || 'download.vrcw';
}

function isOfficialWorldFileUrl(rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return false; }
    return parsed.protocol === 'https:'
        && parsed.hostname.toLowerCase() === 'api.vrchat.cloud'
        && !parsed.port && !parsed.username && !parsed.password
        && /^\/api\/1\/file\/file_[0-9a-f-]{36}\/\d+\/file$/i.test(parsed.pathname);
}

async function readBodyLimited(stream, maxBytes) {
    if (!stream) return null;
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
}

function getLatestWindowsWorldPackage(world) {
    const packages = Array.isArray(world?.unityPackages) ? world.unityPackages : [];
    return packages.filter(pkg => pkg && pkg.platform === 'standalonewindows'
        && typeof pkg.assetUrl === 'string'
        && !pkg.assetUrl.includes('/variant/')
        && isOfficialWorldFileUrl(pkg.assetUrl))
        .reduce((best, pkg) => !best || (Number(pkg.assetVersion) || 0) > (Number(best.assetVersion) || 0) ? pkg : best, null);
}

async function proxyWorldDownloadAsset(fileUrl, filename, authCookies) {
    if (!isOfficialWorldFileUrl(fileUrl)) return jsonResp({ error: 'World package URL not allowed' }, 403);
    let current = new URL(fileUrl);
    let redirectedFromCredentialHost = false;
    let response = null;
    for (let hop = 0; hop <= 5; hop++) {
        const allowed = isOfficialWorldFileUrl(current.toString())
            || (redirectedFromCredentialHost && isAllowedDeliveryCdnTarget(current.toString()));
        if (!allowed) return jsonResp({ error: 'Redirect target not allowed' }, 403);
        const headers = new Headers({ 'User-Agent': USER_AGENT });
        if (authCookies && isCredentialAllowedTarget(current.toString())) headers.set('Cookie', authCookies);
        response = await fetch(current.toString(), { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('Location');
        if (!location || hop === 5) return jsonResp({ error: 'Invalid redirect' }, 502);
        redirectedFromCredentialHost = isCredentialAllowedTarget(current.toString());
        current = new URL(location, current);
    }
    if (!response?.ok) return jsonResp({ error: `World package fetch failed: ${response?.status || 502}` }, response?.status || 502);
    const type = (response.headers.get('Content-Type') || '').toLowerCase();
    if (type.includes('text/html') || type.includes('application/json')) return jsonResp({ error: 'World package response is not binary' }, 502);
    const safeFilename = encodeURIComponent(filename);
    const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename=\"${asciiDownloadFilename(filename)}\"; filename*=UTF-8''${safeFilename}`,
        'Cache-Control': 'no-store',
        ...CORS_HEADERS,
    };
    const length = response.headers.get('Content-Length');
    if (length && /^\d+$/.test(length)) headers['Content-Length'] = length;
    return new Response(response.body, { status: 200, headers });
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

// Check the caller's full VRChat friend list. The online and offline views are
// separate upstream result sets, so both must be paged before returning false.
// Any upstream failure throws: callers must fail closed rather than treating an
// unknown relationship as permission to send a duplicate friend request.
async function isVrcFriend(authCookies, targetId) {
    if (!authCookies || !/^usr_[A-Za-z0-9_-]+$/.test(targetId || '')) {
        throw new Error('Friend status unavailable');
    }
    for (const offline of [false, true]) {
        let offset = 0;
        while (offset < 3000) {
            const { resp } = await vrcFetch(`/auth/user/friends?n=100&offset=${offset}&offline=${offline}`, { method: 'GET' }, authCookies);
            if (!resp.ok) throw new Error('Friend status unavailable');
            const batch = await resp.json();
            if (!Array.isArray(batch)) throw new Error('Friend status unavailable');
            if (batch.some(friend => friend && friend.id === targetId)) return true;
            if (batch.length < 100) break;
            offset += 100;
        }
    }
    return false;
}

function decodeAuthValue(value) {
    const encoded = String(value || "");
    if (!encoded) return "";
    try { return atob(encoded); } catch { return encoded; }
}

function getAuth(request) {
    return decodeAuthValue(request.headers.get("X-VRC-Auth") || "");
}

function shouldReturnRefreshedAuth(resp, setCookies) {
    return !!(resp && resp.ok && Array.isArray(setCookies) && setCookies.length);
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

async function authBucket(authCookies) {
    if (!authCookies) return "anon:v2";
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(String(authCookies))
    );
    return `auth:v2:${bytesToBase64Url(new Uint8Array(digest))}`;
}

// ── VRChat identity resolution ────────────────────────────────────────────
// Resolve the caller's real VRChat id by replaying their X-VRC-Auth cookie
// against VRChat /auth/user. This is the authoritative identity for
// authenticated Worker endpoints (e.g. /api/s3proxy): a client-supplied id
// or header alone is never proof of who the caller is.
//
// _identityCache: authCookie string -> { at, id, age18 }  (30s TTL; VRChat
// sessions are long-lived so a half-minute old answer is safe and saves an
// upstream round-trip per request.)
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

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        // Handle CORS preflight
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        // ── Static assets ──
        // Any non-API path (/, /index.html, /style.css, /js/*.js,
        // /favicon.ico, etc.) is served by the Cloudflare Workers
        // Static Assets binding. We must hand these off BEFORE the API route
        // block, otherwise they'd fall through to the 404 at the end.
        if (!path.startsWith('/api/')) {
            // In production the ASSETS binding always exists and serves (or
            // 404s) static assets itself. Some local-dev modes invoke the
            // worker on asset-miss paths without the binding; fall back to a
            // plain 404 instead of erroring.
            if (!env.ASSETS) return new Response("Not found", { status: 404, headers: CORS_HEADERS });
            const assetResp = await env.ASSETS.fetch(request);
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
            // Only return auth cookies on a successful login (HTTP 200).
            // Returning Set-Cookie on 401/2FA-required/rate-limited responses
            // would persist half-baked session cookies that interfere with the
            // next login attempt.
            if (vrcResp.status === 200 && setCookies.length > 0) {
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

                if (resp.status === 200 && data.verified) {
                    const refreshedAuth = shouldReturnRefreshedAuth(resp, setCookies)
                        ? btoa(mergeCookies(auth, setCookies))
                        : null;
                    return jsonResp({ ok: true }, 200, refreshedAuth ? { "X-VRC-Auth": refreshedAuth } : {});
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
            const imageBucket = await authBucket(imgAuth);
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
                // The VRChat credential may only travel to VRChat hosts —
                // community image hosts (avtr.icu etc.) are fetched cookie-free.
                if (imgAuth && isCredentialAllowedTarget(targetUrl)) headers["Cookie"] = imgAuth;

                // 20s deadline so a slow/hung VRC CDN origin can't hold the
                // Worker subrequest open indefinitely and starve the client's
                // image queue (the "some images time out" symptom).
                const { response: imgResp } = await fetchAllowedWithRedirects(targetUrl, {
                    method: "GET",
                    headers,
                    signal: AbortSignal.timeout(20000)
                });

                if (!imgResp.ok) {
                    return new Response("Image fetch failed", { status: imgResp.status, headers: CORS_HEADERS });
                }
                if (!isAllowedImageContentType(imgResp.headers.get('content-type'))) {
                    return new Response("Image type not allowed", { status: 415, headers: CORS_HEADERS });
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
                const status = e && e.name === 'TimeoutError' ? 504 : 502;
                return new Response("Image proxy unavailable", { status, headers: CORS_HEADERS });
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
                const { response: proxyResp } = await fetchAllowedWithRedirects(targetUrl, {
                    method: "GET",
                    headers: { "User-Agent": USER_AGENT },
                });
                if (!isAllowedJsonContentType(proxyResp.headers.get('content-type'))) {
                    return jsonResp({ error: "Unsupported content type from upstream" }, 415);
                }
                const respBody = await proxyResp.arrayBuffer();
                return new Response(respBody, {
                    status: proxyResp.status,
                    headers: {
                        "Content-Type": proxyResp.headers.get("content-type") || "application/json",
                        ...CORS_HEADERS
                    }
                });
            } catch (e) {
                const status = e && e.name === 'TimeoutError' ? 504 : 502;
                return jsonResp({ error: "Upstream unavailable" }, status);
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
            const imageBucket = await authBucket(auth);
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
                    if (auth && isCredentialAllowedTarget(rawUrl)) headers["Cookie"] = auth;

                    const { response: imgResp, url: finalUrl } = await fetchAllowedWithRedirects(rawUrl, {
                        method: "GET",
                        headers,
                    });
                    if (imgResp.ok && isAllowedImageContentType(imgResp.headers.get('content-type'))) {
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
            const friendRequestMatch = vrcPath.match(/^\/user\/(usr_[A-Za-z0-9_-]+)\/friendRequest$/);
            if (friendRequestMatch && method === 'POST') {
                try {
                    if (await isVrcFriend(auth, friendRequestMatch[1])) {
                        return jsonResp({ success: true, already_friends: true });
                    }
                } catch (_) {
                    return jsonResp({ error: 'Friend status unavailable' }, 503);
                }
            }
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
            // stripping by CF's text() if header is purely application/json. Fetch
            // forbids a body on 204/205/304, so preserve a null body for those statuses.
            const respBody = [204, 205, 304].includes(resp.status) ? null : await resp.arrayBuffer();
            const refreshedAuth = shouldReturnRefreshedAuth(resp, setCookies)
                ? btoa(mergeCookies(auth, setCookies))
                : null;

            return new Response(respBody, {
                status: resp.status,
                headers: {
                    "Content-Type": resp.headers.get("content-type") || "application/json",
                    "Cache-Control": "no-store",
                    ...(resp.headers.get("retry-after") ? { "Retry-After": resp.headers.get("retry-after") } : {}),
                    ...(resp.headers.get("etag") ? { "ETag": resp.headers.get("etag") } : {}),
                    ...(resp.headers.get("last-modified") ? { "Last-Modified": resp.headers.get("last-modified") } : {}),
                    ...CORS_HEADERS,
                    ...(refreshedAuth ? { "X-VRC-Auth": refreshedAuth } : {}),
                },
            });
        }
        // POST /api/world-download — resolve and stream the current Windows world package.
        // Only a world ID and auth credential are accepted; package URL and filename
        // always come from fresh official VRChat world metadata.
        if (path === "/api/world-download" && request.method === "POST") {
            const contentType = request.headers.get('content-type') || '';
            if (!/^application\/json\s*(?:;|$)/i.test(contentType)) return jsonResp({ error: 'Invalid download request' }, 400);
            const MAX_WORLD_DOWNLOAD_BODY_BYTES = 1024;
            const contentLength = Number(request.headers.get('content-length') || 0);
            if (Number.isFinite(contentLength) && contentLength > MAX_WORLD_DOWNLOAD_BODY_BYTES) return jsonResp({ error: 'Download request too large' }, 413);
            const bodyBytes = await readBodyLimited(request.body, MAX_WORLD_DOWNLOAD_BODY_BYTES);
            if (!bodyBytes) return jsonResp({ error: 'Download request too large' }, 413);
            let body;
            try { body = JSON.parse(new TextDecoder().decode(bodyBytes)); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
            const worldId = typeof body?.worldId === 'string' ? body.worldId : '';
            if (!/^wrld_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(worldId)) return jsonResp({ error: 'Invalid world ID' }, 400);
            if (!body || Object.keys(body).some(key => key !== 'worldId')) return jsonResp({ error: 'Unexpected download request fields' }, 400);
            const downloadAuth = auth;
            if (!downloadAuth) return jsonResp({ error: 'Authentication required' }, 401);
            const identity = await resolveVrcIdentity(request, env);
            if (!identity) return jsonResp({ error: 'Authentication required' }, 401);

            try {
                const { resp: worldResp } = await vrcFetch(`/worlds/${encodeURIComponent(worldId)}`, { method: 'GET' }, downloadAuth);
                if (!worldResp.ok) return jsonResp({ error: 'World lookup failed' }, worldResp.status);
                const world = await worldResp.json();
                if (!world || world.id !== worldId || !Array.isArray(world.unityPackages)) return jsonResp({ error: 'Invalid world metadata' }, 502);
                const pkg = getLatestWindowsWorldPackage(world);
                if (!pkg) return jsonResp({ error: 'Windows world package unavailable' }, 404);
                return proxyWorldDownloadAsset(pkg.assetUrl, sanitizeWorldDownloadFilename(world.name, worldId), downloadAuth);
            } catch (error) {
                const status = error?.name === 'TimeoutError' ? 504 : 502;
                return jsonResp({ error: 'World package unavailable' }, status);
            }
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
                let redirectedFromCredentialHost = false;
                for (let i = 0; i < 5; i++) {
                    const allowed = isAllowedTarget(currentUrl)
                        || (redirectedFromCredentialHost && isAllowedDeliveryCdnTarget(currentUrl));
                    if (!allowed) return { error: 403 };
                    const headers = new Headers({ "User-Agent": USER_AGENT });
                    if (authCookies && isCredentialAllowedTarget(currentUrl)) headers.set("Cookie", authCookies);
                    const step = await fetch(currentUrl, {
                        method: "GET",
                        headers,
                        redirect: "manual",
                    });
                    if (step.status === 301 || step.status === 302 || step.status === 303 || step.status === 307 || step.status === 308) {
                        const location = step.headers.get("Location");
                        if (!location) break;
                        redirectedFromCredentialHost = isCredentialAllowedTarget(currentUrl);
                        currentUrl = new URL(location, currentUrl).toString();
                        if (!isAllowedTarget(currentUrl) && !(redirectedFromCredentialHost && isAllowedDeliveryCdnTarget(currentUrl))) return { error: 403 };
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
            if (!isAllowedTarget(cdnUrl) && !isAllowedDeliveryCdnTarget(cdnUrl)) return jsonResp({ error: "CDN target not allowed" }, 403);

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
                if (!isAllowedTarget(cdnUrl) && !isAllowedDeliveryCdnTarget(cdnUrl)) return jsonResp({ error: "CDN target not allowed" }, 403);
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
            // A non-empty header is not authentication. Resolve the live VRChat
            // identity before using this Worker as a signed-upload relay.
            const identity = await resolveVrcIdentity(request, env);
            if (!identity) return jsonResp({ error: "Authentication required" }, 401);
            const s3Url = request.headers.get("X-S3-Url");
            if (!s3Url) return jsonResp({ error: "Missing X-S3-Url header" }, 400);
            if (!isAllowedUploadTarget(s3Url)) return jsonResp({ error: "Upload target not allowed" }, 403);
            const contentLength = Number(request.headers.get('content-length') || 0);
            const MAX_S3_PROXY_BYTES = 50 * 1024 * 1024;
            if (Number.isFinite(contentLength) && contentLength > MAX_S3_PROXY_BYTES) {
                return jsonResp({ error: "Upload too large" }, 413);
            }

            // Buffer body to avoid Transfer-Encoding:chunked.
            const bodyBuffer = await request.arrayBuffer();
            if (bodyBuffer.byteLength > MAX_S3_PROXY_BYTES) return jsonResp({ error: "Upload too large" }, 413);

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

        return jsonResp({ error: "Not found" }, 404);
    },
};

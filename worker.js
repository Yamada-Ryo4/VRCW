/**
 * VRChat Avatar Manager — Cloudflare Worker
 * Proxies VRChat API calls to bypass CORS restrictions.
 * The browser handles S3 uploads directly for maximum speed.
 */

const VRC_API = "https://api.vrchat.cloud/api/1";
const API_KEY = "JlGlobalv959ay9puS6p99En0asKuAk";
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-VRC-Auth, X-S3-Url, X-S3-content-md5, X-S3-content-type",
    "Access-Control-Expose-Headers": "X-VRC-Auth",
};

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

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        // Handle CORS preflight
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        // Serve index.html for root
        if (path === "/" || path === "/index.html") {
            // In production, this would be served from Workers Sites / Pages
            // For local dev, wrangler serves static files from the bucket
            return env.ASSETS
                ? env.ASSETS.fetch(request)
                : new Response("Serve index.html via wrangler pages or static site", { status: 200 });
        }

        // ── API Routes ──
        const auth = getAuth(request);

        // POST /api/login
        if (path === "/api/login" && request.method === "POST") {
            const body = await request.json();
            const basicAuth = btoa(`${body.username}:${body.password}`);

            const { resp, setCookies } = await vrcFetch("/auth/user", {
                method: "GET",
                headers: { Authorization: `Basic ${basicAuth}` },
            });

            const data = await resp.json();
            const cookies = mergeCookies("", setCookies);

            if (resp.status === 200) {
                const needs2FA =
                    data.requiresTwoFactorAuth && data.requiresTwoFactorAuth.length > 0;
                return jsonResp(
                    { ok: true, needs2FA, user: data },
                    200,
                    { "X-VRC-Auth": btoa(cookies) }
                );
            }
            return jsonResp({ ok: false, message: data.error?.message || "Login failed" }, resp.status);
        }

        // POST /api/2fa
        if (path === "/api/2fa" && request.method === "POST") {
            const body = await request.json();
            const code = body.code || "";
            const type = body.type || "totp"; // 'totp' or 'emailotp'
            
            const vrcPath = type === "emailotp"
                ? "/auth/twofactorauth/emailotp/verify"
                : "/auth/twofactorauth/totp/verify";

            const { resp, setCookies } = await vrcFetch(
                vrcPath,
                {
                    method: "POST",
                    json: { code },
                    headers: {},
                },
                auth
            );

            const data = await resp.json();
            const cookies = mergeCookies(auth, setCookies);

            if (resp.status === 200 && data.verified) {
                return jsonResp({ ok: true }, 200, { "X-VRC-Auth": btoa(cookies) });
            }
            return jsonResp({ ok: false, message: "Invalid code" }, 400);
        }

        // GET /api/avatars
        if (path === "/api/avatars" && request.method === "GET") {
            // Get current user first
            const { resp: userResp } = await vrcFetch("/auth/user", {}, auth);
            if (userResp.status !== 200) {
                return jsonResp({ error: "Not authenticated" }, 401);
            }

            const user = await userResp.json();
            const avatarIds = user.currentAvatarAssetUrl
                ? [user.currentAvatar, ...(user.fallbackAvatar ? [user.fallbackAvatar] : [])]
                : [];

            // Fetch all owned avatars
            let allAvatars = [];
            let offset = 0;
            const limit = 100;
            while (true) {
                const { resp } = await vrcFetch(
                    `/avatars?releaseStatus=all&user=me&n=${limit}&offset=${offset}`,
                    {},
                    auth
                );
                if (resp.status !== 200) break;
                const batch = await resp.json();
                if (!batch || batch.length === 0) break;
                allAvatars = allAvatars.concat(batch);
                if (batch.length < limit) break;
                if (offset >= 2000) break; // Security limit to prevent infinite loops
                offset += limit;
            }

            return jsonResp(allAvatars, 200);
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
            if (!targetUrl) return new Response("Missing url", { status: 400 });

            // Check CF Cache API first
            const cacheKey = new Request(new URL(`/api/image?url=${encodeURIComponent(targetUrl)}`, request.url).toString(), { method: "GET" });
            const cache = caches.default;
            let cached = await cache.match(cacheKey);
            if (cached) return cached;

            try {
                const headers = { 
                    "User-Agent": USER_AGENT,
                    "Referer": "https://vrchat.com/"
                };
                if (imgAuth) headers["Cookie"] = imgAuth;

                const imgResp = await fetch(targetUrl, {
                    method: "GET",
                    headers,
                    redirect: "follow"
                });

                if (!imgResp.ok) {
                    return new Response("Image fetch failed", { status: imgResp.status, headers: CORS_HEADERS });
                }

                // Clone and cache the response
                const resp = new Response(imgResp.body, {
                    status: 200,
                    headers: {
                        "Content-Type": imgResp.headers.get("content-type") || "image/jpeg",
                        "Cache-Control": "public, max-age=86400",
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
            const body = await request.json();
            const urls = body.urls || [];
            if (!urls.length) return jsonResp({ ok: true, cached: 0 });

            const cache = caches.default;
            let cachedCount = 0;
            let fetchedCount = 0;
            const MAX_BATCH = 50; // CF Worker subrequest limit safety
            const batch = urls.slice(0, MAX_BATCH);

            // Fire all fetches concurrently
            const promises = batch.map(async (rawUrl) => {
                const cacheKey = new Request(new URL(`/api/image?url=${encodeURIComponent(rawUrl)}`, request.url).toString(), { method: "GET" });
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

            if (["POST", "PUT", "PATCH"].includes(method)) {
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
            const filename = url.searchParams.get("filename") || "avatar.vrca";
            // Auth passed as query param since <a>.click() cannot send custom headers
            const authParam = url.searchParams.get("auth");
            let downloadAuth = auth; // from X-VRC-Auth header (normal apiCall)
            if (!downloadAuth && authParam) {
                try { downloadAuth = atob(authParam); } catch { downloadAuth = authParam; }
            }
            if (!vrcUrl) return jsonResp({ error: "Missing url param" }, 400);

            // Step 1: Resolve VRChat file URL → S3 CDN URL (follows redirect chain with auth)
            async function resolveRedirects(startUrl, authCookies) {
                let resolved = startUrl;
                let currentUrl = startUrl;
                for (let i = 0; i < 5; i++) {
                    const step = await fetch(currentUrl, {
                        method: "GET",
                        headers: { "User-Agent": USER_AGENT, ...(authCookies ? { "Cookie": authCookies } : {}) },
                        redirect: "manual",
                    });
                    if (step.status === 301 || step.status === 302) {
                        currentUrl = step.headers.get("Location") || currentUrl;
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
            let cdnUrl = resolved.url;

            // Step 2: Fetch from CDN and stream back with Content-Disposition
            let cdnResp = await fetch(cdnUrl, {
                method: "GET",
                headers: { "User-Agent": USER_AGENT },
            });

            // Retry on 403: the pre-signed S3 URL may have expired, re-resolve from scratch
            if (cdnResp.status === 403) {
                resolved = await resolveRedirects(vrcUrl, downloadAuth);
                if (resolved.error === 401) return jsonResp({ error: "VRChat auth expired" }, 401);
                cdnUrl = resolved.url;
                cdnResp = await fetch(cdnUrl, {
                    method: "GET",
                    headers: { "User-Agent": USER_AGENT },
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
            return new Response(cdnResp.body, {
                status: 200,
                headers: {
                    "Content-Type": "application/octet-stream",
                    "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${safeFilename}`,
                    "Content-Length": cdnResp.headers.get("Content-Length") || "",
                    ...CORS_HEADERS,
                },
            });
        }

        // POST /api/resolve-url — Resolve a VRChat file URL to a real CDN URL (follows redirects with auth)
        if (path === "/api/resolve-url" && request.method === "POST") {
            const body = await request.json();
            const vrcUrl = body.url;
            if (!vrcUrl) return jsonResp({ error: "Missing url" }, 400);

            // Fetch with auth cookies; VRChat /file/.../file returns 302 -> S3 presigned URL
            const resp = await fetch(vrcUrl, {
                method: "GET",
                headers: {
                    "User-Agent": USER_AGENT,
                    ...(auth ? { "Cookie": auth } : {}),
                },
                redirect: "manual",   // Don't auto-follow — grab the Location header
            });

            // Expect a 302 redirect to the real CDN URL
            if (resp.status === 302 || resp.status === 301) {
                const cdnUrl = resp.headers.get("Location");
                if (cdnUrl) return jsonResp({ cdnUrl }, 200);
            }

            // Some older URLs redirect multiple times — follow once more
            if (resp.status >= 200 && resp.status < 300) {
                // Directly returned the file — shouldn't happen but handle gracefully
                return jsonResp({ cdnUrl: vrcUrl }, 200);
            }

            if (resp.status === 401) return jsonResp({ error: "VRChat auth expired, please log out and back in" }, 401);

            return jsonResp({ error: `VRChat returned ${resp.status}` }, resp.status);
        }

        // PUT /api/s3proxy — Proxy S3 uploads (bypass CORS)
        // CRITICAL: CF Workers fetch() auto-adds "Content-Type: application/octet-stream" for ArrayBuffer body.
        // If content-type is NOT in X-Amz-SignedHeaders, this extra header breaks S3 signature → 403.
        // Fix: wrap body in Blob with empty type to suppress automatic Content-Type injection.
        if (path === "/api/s3proxy" && request.method === "PUT") {
            const s3Url = request.headers.get("X-S3-Url");
            if (!s3Url) return jsonResp({ error: "Missing X-S3-Url header" }, 400);

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

            // Debug: log what we're sending (visible in CF Workers dashboard logs)
            console.log("[s3proxy] signedHeaders:", signedHeadersList.join(";"));
            console.log("[s3proxy] sending headers:", [...s3Headers.entries()].map(([k, v]) => `${k}: ${v}`).join(", ") || "(none)");
            console.log("[s3proxy] bodySize:", bodyBuffer.byteLength);

            const s3Resp = await fetch(s3Url, {
                method: "PUT",
                headers: s3Headers,
                body: bodyBlob,
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

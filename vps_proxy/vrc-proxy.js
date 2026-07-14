const http = require('http');
const https = require('https');
const PORT = 6790;
const AUTH_SECRET = process.env.VPS_PROXY_SECRET;
const PROXY_TIMEOUT_MS = 30000;
const REQUEST_STRIP_HEADERS = new Set([
    'host', 'x-proxy-secret', 'content-length',
    'cf-connecting-ip', 'cf-ray', 'cf-ipcountry', 'cf-visitor',
    'x-forwarded-for', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto',
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'cdn-loop'
]);
const RESPONSE_STRIP_HEADERS = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'cdn-loop'
]);

function parseVrcPath(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) return null;
    try {
        const parsed = new URL(rawUrl, 'https://api.vrchat.cloud');
        if (parsed.origin !== 'https://api.vrchat.cloud') return null;
        return parsed.href;
    } catch (_) {
        return null;
    }
}
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    if (!AUTH_SECRET) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "VPS_PROXY_SECRET is not configured" }));
        return;
    }
    if (req.headers['x-proxy-secret'] !== AUTH_SECRET) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Forbidden: Invalid secret" }));
        return;
    }
    const targetUrl = parseVrcPath(req.url);
    if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Invalid request URL" }));
        return;
    }
    console.log(`[${new Date().toISOString()}] Proxying ${req.method} ${targetUrl}`);
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (!REQUEST_STRIP_HEADERS.has(key.toLowerCase())) headers[key] = value;
    }
    const vrcReq = https.request(targetUrl, {
        method: req.method,
        headers: headers,
        timeout: PROXY_TIMEOUT_MS
    }, (vrcRes) => {
        const resHeaders = { ...vrcRes.headers };
        for (const h of RESPONSE_STRIP_HEADERS) delete resHeaders[h];
        res.writeHead(vrcRes.statusCode, resHeaders);
        vrcRes.pipe(res);
    });
    vrcReq.setTimeout(PROXY_TIMEOUT_MS, () => {
        vrcReq.destroy(new Error('Upstream timeout'));
    });
    vrcReq.on('error', (err) => {
        console.error('Proxy error:', err);
        if (!res.headersSent) res.writeHead(err.message === 'Upstream timeout' ? 504 : 502, { 'Content-Type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify({ error: 'Upstream unavailable' }));
    });
    req.pipe(vrcReq);
});
server.listen(PORT, () => {
    console.log(`VRChat Proxy Server is running on port ${PORT}`);
});

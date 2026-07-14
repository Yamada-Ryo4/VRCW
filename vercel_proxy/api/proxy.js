import https from 'https';

export const config = {
    api: { bodyParser: false }
};

const REQUEST_STRIP_HEADERS = new Set([
    'host', 'x-proxy-secret', 'content-length',
    'cf-connecting-ip', 'cf-ray', 'cf-ipcountry',
    'cf-visitor', 'x-forwarded-for', 'x-real-ip',
    'x-vercel-id', 'x-vercel-ip-country', 'x-vercel-ip-city',
    'x-vercel-ip-timezone', 'x-vercel-ip-latitude', 'x-vercel-ip-longitude',
    'x-forwarded-host', 'x-forwarded-proto',
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'cdn-loop'
]);
const RESPONSE_STRIP_HEADERS = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'cdn-loop'
]);
const PROXY_ORIGIN = 'https://api.vrchat.cloud';

function parseVrcPath(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) return null;
    try {
        const parsed = new URL(rawUrl, PROXY_ORIGIN);
        if (parsed.origin !== PROXY_ORIGIN) return null;
        return parsed.href;
    } catch (_) {
        return null;
    }
}
const PROXY_TIMEOUT_MS = 30000;

export default function handler(req, res) {
    const secret = process.env.VPS_PROXY_SECRET;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');

    if (req.method === 'OPTIONS') {
        res.status(200).end(); return;
    }

    if (!secret) {
        return res.status(500).json({ error: "Proxy secret is not configured" });
    }

    // [集成测试界面] 浏览器直接 GET 根路径时展示测试 UI
    if (req.method === 'GET' && (req.url === '/' || req.url === '/api/proxy')) {
        const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Vercel 代理连通性测试</title>
    <style>
        body { font-family: system-ui, sans-serif; padding: 2rem; background: #0d0d0f; color: #fff; max-width: 600px; margin: 0 auto; }
        button { padding: 12px 24px; font-size: 16px; cursor: pointer; background: #2563eb; color: #fff; border: none; border-radius: 6px; font-weight: bold; width: 100%; transition: 0.2s; }
        button:hover { background: #1d4ed8; }
        button:disabled { background: #4b5563; cursor: not-allowed; }
        pre { background: #18181b; padding: 1rem; border-radius: 6px; white-space: pre-wrap; word-wrap: break-word; border: 1px solid #27272a; min-height: 100px; margin-top: 0.5rem; }
        .success { color: #22c55e; font-weight: bold; font-size: 1.1em; }
        .error { color: #ef4444; font-weight: bold; font-size: 1.1em; }
        .warn { color: #eab308; font-weight: bold; }
        h2 { margin-bottom: 0.5rem; }
        p { color: #a1a1aa; margin-top: 0; }
    </style>
</head>
<body>
    <h2>🌐 Vercel 代理节点连通性测试</h2>
    <p>点击下方按钮，将通过 Vercel（AWS 节点）向 VRChat API 发送测试请求。<br>返回 <b>401</b> = Vercel IP 干净可用；返回 <b>403/1003</b> = Vercel IP 被封。</p>
    <button id="testBtn" onclick="testProxy()">🔍 测试 VRChat 连通性</button>
    <h3 style="margin-top:1.5rem;margin-bottom:0.25rem">测试结果：</h3>
    <pre id="output"><span style="color:#52525b">点击按钮开始测试...</span></pre>
    <script>
        async function testProxy() {
            const btn = document.getElementById('testBtn');
            const out = document.getElementById('output');
            btn.disabled = true;
            btn.innerText = '⏳ 正在测试...';
            out.innerHTML = '<span style="color:#a1a1aa">正在连接 VRChat API，请稍候...</span>';
            try {
                const start = Date.now();
                const res = await fetch('/api/1/auth/user', {
                    method: 'GET',
                    headers: {
                        'x-proxy-secret': '<set VPS_PROXY_SECRET in request header>',
                        'Authorization': 'Basic dGVzdDp0ZXN0',
                        'User-Agent': 'VRChat/1.24.0 Win32'
                    }
                });
                const text = await res.text();
                const time = Date.now() - start;
                let resultHtml = 'HTTP 状态码: ' + res.status + '\\n';
                resultHtml += '耗时: ' + time + 'ms\\n\\n';
                resultHtml += text + '\\n\\n';
                if (res.status === 401 || res.status === 200) {
                    resultHtml += '<span class="success">✅ 成功！Vercel 当前节点 IP 未被 VRChat 封锁。<br>（401 是正常的，因为测试凭证错误，但代理转发正常工作）</span>';
                } else if (res.status === 403 || res.status === 429) {
                    resultHtml += '<span class="error">❌ 失败！Vercel 当前 AWS IP 被 VRChat 封锁了。<br>建议继续使用 VPS + WARP 方案。</span>';
                } else {
                    resultHtml += '<span class="warn">⚠️ 未知状态码 ' + res.status + '，请检查响应内容。</span>';
                }
                out.innerHTML = resultHtml;
            } catch (e) {
                out.innerHTML = '<span class="error">❌ 请求出错: ' + e.message + '</span>';
            } finally {
                btn.disabled = false;
                btn.innerText = '🔄 再次测试';
            }
        }
    </script>
</body>
</html>`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(html);
    }

    // [实际代理逻辑] 所有其他路径按照 x-proxy-secret 验证后转发
    if (req.headers['x-proxy-secret'] !== secret) {
        return res.status(403).json({ error: "Forbidden: Invalid secret" });
    }

    const targetUrl = parseVrcPath(req.url);
    if (!targetUrl) {
        return res.status(400).json({ error: 'Invalid request URL' });
    }

    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (!REQUEST_STRIP_HEADERS.has(key.toLowerCase())) {
            headers[key] = value;
        }
    }

    const vrcReq = https.request(targetUrl, { method: req.method, headers, timeout: PROXY_TIMEOUT_MS }, (vrcRes) => {
        const resHeaders = { ...vrcRes.headers };
        for (const h of RESPONSE_STRIP_HEADERS) delete resHeaders[h];
        res.writeHead(vrcRes.statusCode, resHeaders);
        vrcRes.pipe(res);
    });

    vrcReq.setTimeout(PROXY_TIMEOUT_MS, () => {
        vrcReq.destroy(new Error('Upstream timeout'));
    });

    vrcReq.on('error', (err) => {
        if (!res.headersSent) res.status(err.message === 'Upstream timeout' ? 504 : 502).json({ error: 'Upstream unavailable' });
        else res.end();
    });
    
    req.pipe(vrcReq);
}

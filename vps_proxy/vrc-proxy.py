import http.server
import json
import os
import requests
import socket
from urllib.parse import urlsplit

PORT = 6790
SECRET = os.environ.get("VPS_PROXY_SECRET", "")
UPSTREAM_ORIGIN = "https://api.vrchat.cloud"
SAFE_RETRY_METHODS = {'GET', 'HEAD'}
WARP_PROXIES = {
    'http': 'socks5h://127.0.0.1:40000',
    'https': 'socks5h://127.0.0.1:40000',
}
REQUEST_STRIP_HEADERS = {
    'host', 'x-proxy-secret', 'content-length',
    'cf-connecting-ip', 'cf-ray', 'cf-ipcountry',
    'cf-visitor', 'x-forwarded-for', 'x-real-ip',
    'connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer',
    'transfer-encoding', 'upgrade', 'cdn-loop'
}
RESPONSE_STRIP_HEADERS = {
    'connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer',
    'transfer-encoding', 'upgrade', 'cdn-loop'
}


def parse_vrc_path(raw_path):
    if not isinstance(raw_path, str) or not raw_path.startswith('/') or raw_path.startswith('//'):
        return None
    parsed = urlsplit(raw_path)
    if parsed.scheme or parsed.netloc:
        return None
    return UPSTREAM_ORIGIN + raw_path


def is_warp_available():
    try:
        # Check if WARP SOCKS5 proxy is listening
        with socket.create_connection(("127.0.0.1", 40000), timeout=1):
            return True
    except OSError:
        return False


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', '*')
        self.end_headers()

    def send_error_response(self, code, msg):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps({"error": msg}).encode())

    def handle_proxy(self):
        if not SECRET:
            self.send_error_response(503, "Proxy unavailable")
            return
        if self.headers.get('x-proxy-secret') != SECRET:
            self.send_error_response(403, "Forbidden")
            return
        if self.headers.get('Transfer-Encoding'):
            self.send_error_response(400, "Chunked request bodies are not supported")
            return

        target_url = parse_vrc_path(self.path)
        if not target_url:
            self.send_error_response(400, "Invalid request URL")
            return

        try:
            content_length = int(self.headers.get('Content-Length', 0))
            if content_length < 0:
                raise ValueError
        except ValueError:
            self.send_error_response(400, "Invalid content length")
            return
        body = self.rfile.read(content_length) if content_length > 0 else None
        req_headers = {k: v for k, v in self.headers.items() if k.lower() not in REQUEST_STRIP_HEADERS}

        def make_request(use_warp):
            proxies = WARP_PROXIES if use_warp else None
            return requests.request(
                self.command, target_url,
                headers=req_headers, data=body,
                proxies=proxies, timeout=20,
                allow_redirects=False, stream=True
            )

        safe_to_retry = self.command in {'GET', 'HEAD'}
        try:
            resp = make_request(use_warp=False)
            # WARP is a read-only fallback. Never repeat a write after the
            # upstream might already have received it.
            if safe_to_retry and resp.status_code in (403, 429) and is_warp_available():
                resp.close()
                resp = make_request(use_warp=True)
        except requests.exceptions.Timeout:
            if safe_to_retry and is_warp_available():
                try:
                    resp = make_request(use_warp=True)
                except requests.exceptions.Timeout:
                    self.send_error_response(504, "Upstream unavailable")
                    return
                except requests.exceptions.RequestException:
                    self.send_error_response(502, "Upstream unavailable")
                    return
            else:
                self.send_error_response(504, "Upstream unavailable")
                return
        except requests.exceptions.RequestException:
            if safe_to_retry and is_warp_available():
                try:
                    resp = make_request(use_warp=True)
                except requests.exceptions.Timeout:
                    self.send_error_response(504, "Upstream unavailable")
                    return
                except requests.exceptions.RequestException:
                    self.send_error_response(502, "Upstream unavailable")
                    return
            else:
                self.send_error_response(502, "Upstream unavailable")
                return

        try:
            self.send_response(resp.status_code)
            for key, value in resp.headers.items():
                if key.lower() not in RESPONSE_STRIP_HEADERS and key.lower() != 'set-cookie':
                    self.send_header(key, value)
            # requests collapses duplicate Set-Cookie values in resp.headers;
            # preserve each upstream header through urllib3's raw collection.
            for cookie in resp.raw.headers.getlist('Set-Cookie'):
                self.send_header('Set-Cookie', cookie)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            if self.command != 'HEAD':
                resp.raw.decode_content = False
                for chunk in resp.raw.stream(64 * 1024, decode_content=False):
                    self.wfile.write(chunk)
        except (requests.exceptions.RequestException, OSError):
            # The response may already be streaming. Do not append an error body
            # that could corrupt a successful upstream response.
            pass
        finally:
            resp.close()

    def do_GET(self): self.handle_proxy()
    def do_HEAD(self): self.handle_proxy()
    def do_POST(self): self.handle_proxy()
    def do_PUT(self): self.handle_proxy()
    def do_PATCH(self): self.handle_proxy()
    def do_DELETE(self): self.handle_proxy()


if __name__ == '__main__':
    server = http.server.HTTPServer(('0.0.0.0', PORT), ProxyHandler)
    print(f"VRChat Proxy (Auto fallback to WARP) running on port {PORT}")
    server.serve_forever()

"""Tiny static file server for API-Tizer.

Serves the app with no-cache headers so updated HTML/CSS/JS (including
ES modules) are always re-fetched — avoiding stale-cache bugs after edits.
Everything stays local; nothing is uploaded anywhere.
"""
import http.server
import socketserver
import socket
import sys
import ipaddress

PORT = 8753


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    # Serve ES modules (.mjs — including the bundled pdf.js under vendor/) with a JS MIME
    # type. Browsers refuse to execute a module sent as application/octet-stream, and some
    # Python versions don't map .mjs by default, so pin it (and .js) explicitly.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, *args):
        pass  # keep the console quiet


# Threading server so a hung/streaming request never blocks Ctrl+C.
class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def lan_ip():
    """Best-effort local network IP (the address phones on the same Wi-Fi use)."""
    candidates = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # no packets are actually sent
        candidates.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass

    try:
        for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            candidates.append(item[4][0])
    except OSError:
        pass

    for ip in dict.fromkeys(candidates):
        addr = ipaddress.ip_address(ip)
        if addr.is_private and not addr.is_loopback:
            return ip
    return None


def main():
    httpd = Server(("", PORT), NoCacheHandler)
    ip = lan_ip()
    print("=" * 52)
    print(f"  API-Tizer 서버 실행 중")
    print(f"  이 PC:      http://localhost:{PORT}")
    if ip:
        print(f"  같은 와이파이의 휴대폰:  http://{ip}:{PORT}")
    print("-" * 52)
    print("  안내")
    print("    권장 접속: https://abandonships.github.io/API-tizer/")
    print("    배포 주소는 HTTPS라 로그인·암호화·온라인 동기화가 바로 동작합니다.")
    print("    같은 와이파이 주소는 모바일 화면 확인용으로는 유용하지만,")
    print("    일반 HTTP라 로그인·암호화가 제한될 수 있습니다.")
    print("    로컬 서버를 휴대폰에서 로그인까지 테스트하려면 HTTPS 터널")
    print("    (cloudflared/ngrok 등)을 사용하세요. 자세한 내용은 README 참고.")
    print("-" * 52)
    print("  종료하려면 Ctrl+C")
    print("=" * 52)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n서버를 종료합니다.")
    finally:
        httpd.shutdown()
        httpd.server_close()
        sys.exit(0)


if __name__ == "__main__":
    main()

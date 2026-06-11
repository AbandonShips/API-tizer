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
    print("  ⚠ 휴대폰(또는 다른 기기)에서 위 주소로 접속하면")
    print("    로그인/암호화가 동작하지 않을 수 있습니다.")
    print("    브라우저 보안 정책상 localhost 가 아닌 일반 http")
    print("    주소에서는 암호화 기능(Web Crypto)이 막힙니다.")
    print("    휴대폰에서 제대로 쓰려면 HTTPS 터널이 필요합니다")
    print("    (예: cloudflared, ngrok). 자세한 내용은 README 참고.")
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

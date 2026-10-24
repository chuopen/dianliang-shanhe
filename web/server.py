"""《点亮山河》本地开发服务器：禁用缓存，保证刷新即最新。"""
import functools
import http.server

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, *a):
        pass

if __name__ == "__main__":
    server = http.server.HTTPServer(("127.0.0.1", 8765), functools.partial(NoCacheHandler, directory="."))
    print("serving http://127.0.0.1:8765 (no-store)")
    server.serve_forever()

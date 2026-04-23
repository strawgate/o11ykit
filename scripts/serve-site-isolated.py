#!/usr/bin/env python3

from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import unquote, urlsplit
import posixpath


ROOT = Path(__file__).resolve().parents[1]
PREFIX = "/o11ykit"


class IsolatedSiteHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        path = urlsplit(path).path
        path = unquote(path)
        if path == PREFIX:
            path = f"{PREFIX}/"
        if path.startswith(f"{PREFIX}/"):
            path = f"/site{path[len(PREFIX):]}"

        path = posixpath.normpath(path)
        parts = [part for part in path.split("/") if part and part not in (".", "..")]
        full = ROOT
        for part in parts:
            full /= part
        return str(full)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 8011), IsolatedSiteHandler)
    print("Serving isolated site on http://127.0.0.1:8011")
    server.serve_forever()


if __name__ == "__main__":
    main()

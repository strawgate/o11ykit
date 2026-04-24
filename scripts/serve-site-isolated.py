#!/usr/bin/env python3

from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import unquote, urlsplit
import posixpath


ROOT = Path(__file__).resolve().parents[1]
SITE_ROOT = ROOT / "site"
PREFIX = "/o11ykit"


class IsolatedSiteHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        path = urlsplit(path).path
        path = unquote(path)
        if path == PREFIX:
            path = f"{PREFIX}/"
        if not path.startswith(f"{PREFIX}/"):
            return str(SITE_ROOT / "__missing__")

        rel = posixpath.normpath(path[len(PREFIX):] or "/").lstrip("/")
        full = (SITE_ROOT / rel).resolve()
        if full != SITE_ROOT and SITE_ROOT not in full.parents:
            return str(SITE_ROOT / "__missing__")
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

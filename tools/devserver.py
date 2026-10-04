"""Static dev server for SetFrameR with caching disabled (ES modules are otherwise cached by the browser).

    python3 tools/devserver.py [port]
"""
import http.server
import sys
from functools import partial
from pathlib import Path


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
root = Path(__file__).resolve().parent.parent
http.server.ThreadingHTTPServer(("127.0.0.1", port), partial(NoCache, directory=str(root))).serve_forever()

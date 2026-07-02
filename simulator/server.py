"""Local dev HTTP server: exposes live state + player controls without auth.

Only used for local development (the deployed frontend reads the same shape via
authenticated Rayfin GraphQL in the Fabric portal). Endpoints:

  GET  /state             -> latest snapshot {scenario, wind, crews, incidents}
  POST /control           -> { action: play|pause|reset|speed, value? }
  POST /dispatch          -> { incident_id, crew_id, action? }
"""

from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable


def make_handler(get_snapshot: Callable[[], dict], on_control: Callable[[dict], dict]):
    class Handler(BaseHTTPRequestHandler):
        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def _json(self, code: int, body: dict):
            data = json.dumps(body).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self):
            if self.path.startswith("/state"):
                self._json(200, get_snapshot())
            else:
                self._json(404, {"error": "not found"})

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b"{}"
            try:
                payload = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                self._json(400, {"error": "invalid json"})
                return
            payload["_path"] = self.path
            self._json(200, on_control(payload))

        def log_message(self, *args):
            pass  # quiet

    return Handler


def start_server(port: int, get_snapshot, on_control) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(get_snapshot, on_control))
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd

"""
Vercel Serverless Function Entrypoint.
Exposes the FastAPI application to Vercel's Python runtime.
Handles Vercel URL path rewrites and headers so all routes (/, /api/*, /webhook/*) resolve correctly.
"""

import sys
import os

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from server import app as fastapi_app

class VercelPathNormalizer:
    """
    ASGI middleware that normalizes the request path on Vercel.
    Ensures that rewritten paths like '/api/index' or '/api/index/api/contacts'
    or header 'x-matched-path' are resolved to the actual intended route.
    """
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            raw_path = scope.get("path", "")
            headers = dict(scope.get("headers", []))

            # If Vercel passed original matched path in header
            matched = headers.get(b"x-matched-path", b"").decode("utf-8")
            if matched and not matched.startswith("/api/index"):
                scope["path"] = matched
            elif raw_path in ("/api/index", "/api/index/"):
                scope["path"] = "/"
            elif raw_path.startswith("/api/index/"):
                scope["path"] = raw_path[len("/api/index"):]

        await self.app(scope, receive, send)

app = VercelPathNormalizer(fastapi_app)

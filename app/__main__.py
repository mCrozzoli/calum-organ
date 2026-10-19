"""Entry point: starts the local HTTP server and opens the browser."""
from __future__ import annotations

import argparse
import sys
import threading
import webbrowser

from .server import STATE, serve


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=0,
                    help="0 = pick a free port automatically")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--share-bind", default="0.0.0.0",
                    help="interface for guests when sharing (default: all)")
    args = ap.parse_args()

    STATE.sharing.bind = args.share_bind
    server = serve(args.host, args.port)
    host, port = server.server_address[0], server.server_address[1]
    url = f"http://{host}:{port}/"
    print(f"[Organ] serving on {url}")

    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()      # returns after Quit in the browser
    except KeyboardInterrupt:
        print()
    print("[Organ] stopping the organ and shutting down")
    STATE.stop_organ()
    STATE.sharing.stop()
    server.server_close()
    print("[Organ] bye — you can close this window")
    return 0


if __name__ == "__main__":
    sys.exit(main())

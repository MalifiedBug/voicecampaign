#!/usr/bin/env python3
"""
Voice Campaign Launcher Script.
Launches both the FastAPI Webhook & Audio Server (port 8000) and the Streamlit UI (port 8501).
"""

import sys
import os
import socket
import subprocess
import time

def is_port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.1)
        return s.connect_ex(("127.0.0.1", port)) == 0

def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(base_dir)

    # Determine python and streamlit binaries
    venv_python = os.path.join(base_dir, ".venv", "bin", "python")
    py_cmd = venv_python if os.path.exists(venv_python) else sys.executable

    venv_streamlit = os.path.join(base_dir, ".venv", "bin", "streamlit")
    streamlit_cmd = venv_streamlit if os.path.exists(venv_streamlit) else "streamlit"

    server_proc = None
    if not is_port_in_use(8000):
        server_cmd = [
            py_cmd,
            "-m", "uvicorn",
            "server:app",
            "--host", "0.0.0.0",
            "--port", "8000",
            "--log-level", "warning"
        ]
        server_proc = subprocess.Popen(server_cmd)

    cmd = [
        streamlit_cmd,
        "run",
        "app.py",
        "--server.port=8501",
        "--server.headless=true",
        "--browser.gatherUsageStats=false"
    ]

    print("=" * 60)
    print("🎙️ Starting Voice Campaign: Vobiz Automated Calling Platform")
    print("👉 Streamlit UI: http://localhost:8501")
    print("👉 Webhook & Audio Server: http://localhost:8000")
    print("=" * 60)

    try:
        subprocess.run(cmd)
    except KeyboardInterrupt:
        print("\nShutting down Voice Campaign...")
    finally:
        if server_proc and server_proc.poll() is None:
            server_proc.terminate()

if __name__ == "__main__":
    main()



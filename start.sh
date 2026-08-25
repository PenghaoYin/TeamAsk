#!/usr/bin/env bash
set -e

cd "$(dirname "${BASH_SOURCE[0]}")"
PORT="${PORT:-8000}"

echo "TeamAsk 已启动"
echo "本机地址: http://localhost:${PORT}"
echo "局域网地址: http://$(hostname -I | awk '{print $1}'):${PORT}"
echo "按 Ctrl+C 停止服务"

python3 server.py

#!/bin/bash
# 启动 llm-gateway（后台）
cd "$(dirname "$0")"
if [ -f gateway.pid ] && kill -0 "$(cat gateway.pid)" 2>/dev/null; then
  echo "已在运行 pid=$(cat gateway.pid)"
  exit 0
fi
nohup node gateway.mjs >> gateway.log 2>&1 &
echo $! > gateway.pid
sleep 1
curl -s http://127.0.0.1:8787/health && echo

#!/bin/bash
# 停止 llm-gateway
cd "$(dirname "$0")"
if [ -f gateway.pid ]; then
  kill "$(cat gateway.pid)" 2>/dev/null
  rm -f gateway.pid
  echo "已停止"
else
  echo "没有 pid 文件，可能未在运行"
fi

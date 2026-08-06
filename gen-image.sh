#!/bin/bash
# 智谱 cogview-3-flash 免费生图
# 用法: ./gen-image.sh "提示词" [输出路径]
# 例:   ./gen-image.sh "一只戴红色贝雷帽的柴犬，卡通插画，白底"
set -e
cd "$(dirname "$0")"
PROMPT="$1"
OUT="${2:-/tmp/gen-$(date +%s).png}"
[ -z "$PROMPT" ] && { echo "用法: ./gen-image.sh \"提示词\" [输出路径]"; exit 1; }

KEY=$(grep '^VISION_API_KEY=' .env | cut -d= -f2)
URL=$(curl -s --max-time 300 https://open.bigmodel.cn/api/paas/v4/images/generations \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"cogview-3-flash\",\"prompt\":\"$PROMPT\",\"size\":\"1024x1024\"}" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['data'][0]['url'])")

curl -s --max-time 120 -o "$OUT" "$URL"
# 智谱返回的可能是 JPEG 内容，统一转成 PNG
sips -s format png "$OUT" --out "$OUT" >/dev/null 2>&1 || true
open "$OUT"
echo "已生成: $OUT"

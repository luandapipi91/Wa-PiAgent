#!/usr/bin/env bash
# agents presets API 集成测试（需运行中的 kernel）
# 用法：./scripts/agents-presets-api-it.sh   或   BASE_URL=http://127.0.0.1:9778 ./scripts/agents-presets-api-it.sh
set -u
BASE="${BASE_URL:-http://127.0.0.1:9776}"
AGENT_NAME="IT预设智能体-可删除"
PASS=0; FAIL=0
rm -f /tmp/apit-create.json

check() { # check <描述> <实际> <预期>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ✓ $1";
  else FAIL=$((FAIL+1)); echo "  ✗ $1：预期 [$3] 实际 [$2]"; fi
}

# 中文名需 URL 编码（Windows Git Bash 下 URL 中的中文会被 GBK 转码）；
# 用 od 逐字节转 %HH（纯 shell，不依赖 JS 运行时）
urlencode() {
  local s="$1" out=""
  local i=0 len=${#s}
  while [ $i -lt $len ]; do
    local c="${s:$i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) local bytes; bytes=$(printf '%s' "$c" | od -An -tx1 | tr -d ' \n')
         local j=0
         while [ $j -lt ${#bytes} ]; do
           out+="%${bytes:$j:2}"; j=$((j+2))
         done ;;
    esac
    i=$((i+1))
  done
  printf '%s' "$out"
}
AGENT_NAME_ENC=$(urlencode "$AGENT_NAME")
# POST body 从 UTF-8 临时文件读取（bash 内建 printf 按字节输出，不做 GBK 转码）
printf '{"id":"engineering-code-reviewer","displayName":"%s"}' "$AGENT_NAME" > /tmp/apit-body.json

echo "== GET /api/agents/presets =="
BODY=$(curl -s "$BASE/api/agents/presets")
check "返回 presets 数组" "$(echo "$BODY" | grep -c '"presets"')" "1"
check "包含工程部预设" "$(echo "$BODY" | grep -c 'engineering-frontend-developer')" "1"
check "元数据不含 body 字段" "$(echo "$BODY" | grep -c '"body"')" "0"

echo "== POST /api/agents/from-preset 成功路径 =="
CODE=$(curl -s -o /tmp/apit-create.json -w '%{http_code}' -X POST "$BASE/api/agents/from-preset" \
  -H 'content-type: application/json' \
  --data-binary @/tmp/apit-body.json)
check "创建返回 200" "$CODE" "200"
check "返回 agent.displayName" "$(grep -c "$AGENT_NAME" /tmp/apit-create.json)" "1"
check "正文注入名字" "$(curl -s "$BASE/api/agents/$AGENT_NAME_ENC/config" | grep -c "你的名字是「$AGENT_NAME」。")" "1"

echo "== 错误路径 =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/agents/from-preset" \
  -H 'content-type: application/json' \
  --data-binary @/tmp/apit-body.json)
check "重名返回 409" "$CODE" "409"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/agents/from-preset" \
  -H 'content-type: application/json' \
  -d '{"id":"not-exist-id","displayName":"任意名字"}')
check "未知 id 返回 404" "$CODE" "404"

echo "== 清理 =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/agents/$AGENT_NAME_ENC")
check "删除测试智能体" "$CODE" "200"
rm -f /tmp/apit-create.json /tmp/apit-body.json

echo "结果：$PASS 通过，$FAIL 失败"
[ "$FAIL" -eq 0 ]

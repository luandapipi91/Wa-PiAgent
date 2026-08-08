#!/usr/bin/env bash
# agents presets API 集成测试（需运行中的 kernel）
# 用法：./scripts/agents-presets-api-it.sh   或   BASE_URL=http://127.0.0.1:9778 ./scripts/agents-presets-api-it.sh
set -u
BASE="${BASE_URL:-http://127.0.0.1:9776}"
AGENT_NAME="IT预设智能体-可删除"
PASS=0; FAIL=0

check() { # check <描述> <实际> <预期>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ✓ $1";
  else FAIL=$((FAIL+1)); echo "  ✗ $1：预期 [$3] 实际 [$2]"; fi
}

echo "== GET /api/agents/presets =="
BODY=$(curl -s "$BASE/api/agents/presets")
check "返回 presets 数组" "$(echo "$BODY" | grep -c '"presets"')" "1"
check "包含工程部预设" "$(echo "$BODY" | grep -c 'engineering-frontend-developer')" "1"
check "元数据不含 body 字段" "$(echo "$BODY" | grep -c '"body"')" "0"

echo "== POST /api/agents/from-preset 成功路径 =="
CODE=$(curl -s -o /tmp/apit-create.json -w '%{http_code}' -X POST "$BASE/api/agents/from-preset" \
  -H 'content-type: application/json' \
  -d "{\"id\":\"engineering-code-reviewer\",\"displayName\":\"$AGENT_NAME\"}")
check "创建返回 200" "$CODE" "200"
check "返回 agent.displayName" "$(grep -c "$AGENT_NAME" /tmp/apit-create.json)" "1"
check "正文注入名字" "$(curl -s "$BASE/api/agents/$AGENT_NAME/config" | grep -c "你的名字是「$AGENT_NAME」。")" "1"

echo "== 错误路径 =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/agents/from-preset" \
  -H 'content-type: application/json' \
  -d "{\"id\":\"engineering-code-reviewer\",\"displayName\":\"$AGENT_NAME\"}")
check "重名返回 409" "$CODE" "409"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/agents/from-preset" \
  -H 'content-type: application/json' \
  -d '{"id":"not-exist-id","displayName":"任意名字"}')
check "未知 id 返回 404" "$CODE" "404"

echo "== 清理 =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/agents/$AGENT_NAME")
check "删除测试智能体" "$CODE" "200"
rm -f /tmp/apit-create.json

echo "结果：$PASS 通过，$FAIL 失败"
[ "$FAIL" -eq 0 ]

#!/usr/bin/env bash
# IM 渠道 API 集成验收：需先以 mock 模式启动 kernel：
#   WA_PI_CHANNELS_MOCK=1 WA_PI_DIR=$(mktemp -d) bun run --filter @wa-pi/kernel dev
set -euo pipefail
BASE="${1:-http://localhost:9776}"
fail() { echo "❌ $1"; exit 1; }

# 1) 缺 botId → 400
code=$(curl -s -o /tmp/ch-res.json -w "%{http_code}" -X POST "$BASE/api/channels" \
	-H "Content-Type: application/json" \
	-d '{"channel":{"type":"mock","name":"x","enabled":true,"credentials":{"botId":"","secret":"s"},"agentName":"","model":"p/m","extraSystemPrompt":"","replyGranularity":"standard"}}')
[ "$code" = "400" ] || fail "缺 botId 应返回 400，实际 $code"
grep -q "Bot ID" /tmp/ch-res.json || fail "错误信息应含 Bot ID"

# 2) 正常创建 → 200 且返回 id
curl -s -X POST "$BASE/api/channels" -H "Content-Type: application/json" \
	-d '{"channel":{"type":"mock","name":"验收机器人","enabled":true,"credentials":{"botId":"b1","secret":"secret-1234"},"agentName":"","model":"p/m","extraSystemPrompt":"","replyGranularity":"standard"}}' \
	> /tmp/ch-res.json
# 从返回 JSON 提取首个渠道 id（纯 shell 解析，避免依赖 JS 运行时）
CH_ID=$(grep -o '"id":"ch_[^"]*"' /tmp/ch-res.json | head -1 | sed 's/"id":"//;s/"//')
[ -n "$CH_ID" ] || fail "创建后应返回渠道 id"

# 3) 列表脱敏
curl -s "$BASE/api/channels" > /tmp/ch-res.json
grep -q '\*\*\*\*1234' /tmp/ch-res.json || fail "secret 应脱敏为 ****1234"
grep -q "secret-1234\"" /tmp/ch-res.json && fail "明文 secret 泄漏"

# 4) 重复 Bot ID → 409
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/channels" \
	-H "Content-Type: application/json" \
	-d '{"channel":{"type":"mock","name":"y","enabled":true,"credentials":{"botId":"b1","secret":"s"},"agentName":"","model":"p/m","extraSystemPrompt":"","replyGranularity":"simple"}}')
[ "$code" = "409" ] || fail "重复 Bot ID 应返回 409，实际 $code"

# 5) 更新名称 → 200
code=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE/api/channels/$CH_ID" \
	-H "Content-Type: application/json" -d '{"channel":{"name":"验收机器人2"}}')
[ "$code" = "200" ] || fail "更新应返回 200，实际 $code"

# 6) 智能体引用计数（本脚本创建的渠道 agentName 为空，应为 0）
# 中文名需 URL 编码；用 printf 逐字节转 %HH（纯 shell，不依赖 JS 运行时）
urlencode() {
  local s="$1" out=""
  local i=0 len=${#s}
  while [ $i -lt $len ]; do
    local c="${s:$i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) printf -v hex '%02X' "'$c" 2>/dev/null
         # 多字节 UTF-8：printf '%02X' "'$c" 在某些 shell 只给首字节；
         # 用 od 逐字节编码更可靠
         local bytes; bytes=$(printf '%s' "$c" | od -An -tx1 | tr -d ' \n')
         local j=0
         while [ $j -lt ${#bytes} ]; do
           out+="%${bytes:$j:2}"; j=$((j+2))
         done ;;
    esac
    i=$((i+1))
  done
  printf '%s' "$out"
}
AGENT_USAGE_NAME_ENC=$(urlencode '前端开发者')
curl -s "$BASE/api/channels/agent-usage/$AGENT_USAGE_NAME_ENC" > /tmp/ch-res.json
grep -q '"count":0' /tmp/ch-res.json || fail "agent-usage 应返回 count:0"

# 7) mock 进站 → outbox 有回复（无真实模型，预期为错误/配置类回复，链路通即可）
curl -s -X POST "$BASE/api/channels/$CH_ID/mock-inbound" -H "Content-Type: application/json" \
	-d '{"chatId":"u-it","text":"你好"}' > /dev/null
sleep 3
curl -s "$BASE/api/channels/$CH_ID/mock-outbox" > /tmp/ch-res.json
grep -q '"text"' /tmp/ch-res.json || fail "mock-outbox 应有回复记录"

# 8) 会话列表出现该对话
curl -s "$BASE/api/channel-conversations" > /tmp/ch-res.json
grep -q "u-it" /tmp/ch-res.json || fail "会话列表应包含 u-it"

# 9) 删除 → 列表为空
curl -s -X DELETE "$BASE/api/channels/$CH_ID" > /tmp/ch-res.json
# channels 数组应为空（无 "id":"ch_ 字样）
! grep -q '"id":"ch_' /tmp/ch-res.json || fail "删除后列表应为空"

echo "✅ 渠道 API 集成验收全部通过"

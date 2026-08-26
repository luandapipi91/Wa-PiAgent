#!/usr/bin/env bash
# 定时任务文件夹化 REST API 集成验收（自含起停临时 kernel）
#
# 与 channels-api-it.sh 假设外部已起 kernel 不同，本脚本自己拉起一个隔离的临时 kernel：
#   - WA_PI_DIR 用 mktemp -d 隔离（不触碰真实 ~/.pi/agent 与宿主 9776/9778）
#   - 端口用唯一值（默认从 9900 起，用 lsof 探测一个空闲端口）
#   - 脚本结束经 trap 清理（kill kernel + rm -rf 临时目录）
# 数据唯一来源：各项目 cwd 下 .wa-pi/scheduled-tasks/；默认工作区 __system__ → $WA_PI_DIR/workdir。
set -euo pipefail

# 从脚本位置推导 kernel 目录，保证从任意 cwd 都能跑
KERNEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../packages/kernel" && pwd)"

RESP="$(mktemp -d)"       # 响应体临时目录（trap 清理）
WORK_DIR="$(mktemp -d)"   # 隔离的 WA_PI_DIR
KPID=""
PORT=""

fail() { echo "❌ $1"; exit 1; }

# 找一个空闲端口（避免与宿主 9776/9778 及其它测试撞上）；lsof 不可用时回退给基值
pick_port() {
  local base=9900
  local p=$base
  if command -v lsof >/dev/null 2>&1; then
    while [ $p -lt $((base + 60)) ]; do
      if ! lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then printf '%s' "$p"; return 0; fi
      p=$((p + 1))
    done
    return 1
  fi
  printf '%s' "$base"
}

PORT="$(pick_port)" || fail "找不到可用端口（9900-9959 全被占用）"

# 退出清理：kill 临时 kernel + 删临时目录（先杀进程再删数据，避免部分文件被重建）
cleanup() {
  local rc=$?
  set +e
  trap - EXIT INT TERM
  if [ -n "$KPID" ] && kill -0 "$KPID" 2>/dev/null; then
    # 第一层：先给 kernel 发 TERM（优雅退出），再顺手杀它的直接子进程（如 run 触发时
    # agentManager.ensureStarted 实际 spawn 的 pi 子进程），兜底那些因 resolveTaskModel
    # 无 provider 抛错、catch 只置 failed 而未被内核回收的孤儿 pi（不用 setsid——macOS 无此命令）。
    kill -TERM "$KPID" 2>/dev/null
    pkill -TERM -P "$KPID" 2>/dev/null
    # 宽限 4s：kernel 收到 SIGTERM 后走优雅退出（shutdown → agentManager.disposeAll() 会
    # 回收所有 pi 子进程）；太短（原 1s）会把这套回收打断、留下孤儿，太长则拖慢测试收尾。
    sleep 4
    # 第二层：宽限期后仍存活（优雅退出被卡住）则强制 KILL 兜底。
    kill -0 "$KPID" 2>/dev/null && kill -KILL "$KPID" 2>/dev/null
  fi
  [ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR"
  [ -n "$RESP" ] && rm -rf "$RESP"
  exit $rc
}
trap cleanup EXIT

# —— 启动临时 kernel（pushd+简单命令后台化，$! 才是 kernel 真实 pid）——
cd "$KERNEL_DIR"
WA_PI_DIR="$WORK_DIR" WA_PI_WS_PORT="$PORT" bun run src/desktop-server.ts > "$RESP/kernel.log" 2>&1 &
KPID=$!
cd - >/dev/null 2>&1 || true

# 就绪探测：轮询 /api/scheduled-tasks 直到 200，或进程死亡/超时即失败
ready=0
for i in $(seq 1 40); do
  # 未就绪时 curl 可能 connection refused（退出码非 0），|| true 避免在 set -e 下提前终止
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/scheduled-tasks" 2>/dev/null || true)
  [ "$code" = "200" ] && { ready=1; echo "✅ 临时 kernel 就绪（${i}s，端口 $PORT）"; break; }
  kill -0 "$KPID" 2>/dev/null || fail "kernel 启动失败（端口 $PORT），日志见 $RESP/kernel.log"
  sleep 1
done
[ "$ready" = "1" ] || fail "kernel 就绪超时（40s），端口 $PORT"

BASE="http://127.0.0.1:$PORT"
TASKDIR="$WORK_DIR/workdir/.wa-pi/scheduled-tasks/tasks"

# 中文/保留字符 URL 编码（纯 shell，逐字节 %HH，不依赖 JS 运行时）
urlencode() {
  local s="$1" out=""
  local i=0 len=${#s}
  while [ $i -lt $len ]; do
    local c="${s:$i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *)
        local bytes; bytes=$(printf '%s' "$c" | od -An -tx1 | tr -d ' \n')
        local j=0
        while [ $j -lt ${#bytes} ]; do out+="%${bytes:$j:2}"; j=$((j + 2)); done
        ;;
    esac
    i=$((i + 1))
  done
  printf '%s' "$out"
}

list() { curl -s "$BASE/api/scheduled-tasks"; }

# ===== 场景 1：POST 建任务（省略 projectId → 落到默认工作区 __system__）=====
curl -s -X POST "$BASE/api/scheduled-tasks" -H "Content-Type: application/json" \
  -d '{"name":"每日巡检","schedule":{"type":"daily","time":"09:30"},"agentId":"前端开发者","prompt":"请检查项目状态并输出摘要。"}' \
  > "$RESP/create.json"
TASK_A_ID=$(grep -o '"id":"[^"]*"' "$RESP/create.json" | head -1 | sed 's/"id":"//;s/"//')
[ -n "$TASK_A_ID" ] || fail "创建任务应返回非空 task.id"
[ -f "$TASKDIR/${TASK_A_ID}.md" ] || fail "任务文件应落盘: $TASKDIR/${TASK_A_ID}.md"
echo "✅ 场景1 建任务并落盘（id=$TASK_A_ID）"

# ===== 场景 2：GET 列表含该任务，errors 为空数组 =====
list > "$RESP/list.json"
grep -q "$TASK_A_ID" "$RESP/list.json" || fail "列表应含任务 $TASK_A_ID"
grep -q '"errors":\[\]' "$RESP/list.json" || fail "当前 errors 应为空数组"
echo "✅ 场景2 列表含任务且 errors 为空"

# ===== 场景 3：模拟 agent/CLI 外部写入合法 md → watcher 热加载 =====
cat > "$TASKDIR/外部巡检.md" << 'EOF'
---
name: "外部巡检"
schedule: {"type":"daily","time":"08:00"}
agentId: "前端开发者"
enabled: true
---

请执行外部巡检
EOF
sleep 1 # 等 watcher 防抖（DEBOUNCE_MS=300）
list > "$RESP/list3.json"
grep -q "外部巡检" "$RESP/list3.json" || fail "watcher 应热加载外部写入的 外部巡检"
grep -q '"errors":\[\]' "$RESP/list3.json" || fail "外部合法文件不应产生 errors"
echo "✅ 场景3 外部写入被 watcher 热加载"

# ===== 场景 4：写坏文件（缺 key / 非法 JSON）→ errors 含该 taskId =====
cat > "$TASKDIR/坏任务.md" << 'EOF'
---
schedule: {type:
---
EOF
sleep 1
list > "$RESP/list4.json"
grep -q '"taskId":"坏任务"' "$RESP/list4.json" || fail "errors 应含坏文件 taskId=坏任务"
echo "✅ 场景4 坏文件进入 errors"

# ===== 场景 5：PUT 修复坏文件 → 200，errors 清空（upsert 覆盖写）=====
# 注意：文件 id 仍是 坏任务（文件名），改的是 name 字段 → 修复后任务 id 不变
BAD_ID=$(urlencode "坏任务")
code=$(curl -s -o "$RESP/put.json" -w "%{http_code}" -X PUT "$BASE/api/scheduled-tasks/$BAD_ID" \
  -H "Content-Type: application/json" \
  -d '{"name":"修复坏任务","schedule":{"type":"daily","time":"10:00"},"agentId":"前端开发者","prompt":"修复后的提示词"}')
[ "$code" = "200" ] || fail "PUT 修复坏文件应返回 200，实际 $code"
list > "$RESP/list5.json"
grep -q '"errors":\[\]' "$RESP/list5.json" || fail "PUT 修复后 errors 应清空"
grep -q "修复坏任务" "$RESP/list5.json" || fail "修复后的任务应在列表可见"
echo "✅ 场景5 PUT 修复坏文件，errors 清空"

# ===== 场景 6：POST run → 200（fire-and-forget，触发即返回，只断言 200）=====
RUN_ID=$(urlencode "$TASK_A_ID")
code=$(curl -s -o "$RESP/run.json" -w "%{http_code}" -X POST "$BASE/api/scheduled-tasks/$RUN_ID/run")
[ "$code" = "200" ] || fail "run 应返回 200，实际 $code"
grep -q '"ok":true' "$RESP/run.json" || fail "run 响应应含 ok:true"
echo "✅ 场景6 run 返回 200"

# ===== 场景 7：执行记录（fire-and-forget 可能有竞态，短等待/重试）=====
REC=""
for _ in 1 2 3 4 5 6 7 8; do
  sleep 1
  curl -s "$BASE/api/execution-records?taskId=$RUN_ID" > "$RESP/rec.json"
  grep -q '"status":"' "$RESP/rec.json" && { REC="$RESP/rec.json"; break; }
done
[ -n "$REC" ] || fail "run 后应产生至少一条带 status 的执行记录"
grep -q "\"taskId\":\"$TASK_A_ID\"" "$RESP/rec.json" || fail "记录应归属 taskId=$TASK_A_ID"
echo "✅ 场景7 执行记录存在且带 status"

# ===== 场景 8：DELETE → 200，文件消失 =====
DEL_ID=$(urlencode "外部巡检")
code=$(curl -s -o "$RESP/del.json" -w "%{http_code}" -X DELETE "$BASE/api/scheduled-tasks/$DEL_ID")
[ "$code" = "200" ] || fail "DELETE 应返回 200，实际 $code"
[ -f "$TASKDIR/外部巡检.md" ] && fail "DELETE 后文件应消失"
echo "✅ 场景8 DELETE 后文件消失"

# ===== 场景 9：错误路径（POST 缺 name → 400；PUT 不存在 id → 404）=====
code=$(curl -s -o "$RESP/e1.json" -w "%{http_code}" -X POST "$BASE/api/scheduled-tasks" \
  -H "Content-Type: application/json" \
  -d '{"schedule":{"type":"daily","time":"09:00"},"agentId":"a","prompt":"p"}')
[ "$code" = "400" ] || fail "POST 缺 name 应返回 400，实际 $code"
grep -q "name 不能为空" "$RESP/e1.json" || fail "400 错误信息应含 name 不能为空"
code=$(curl -s -o "$RESP/e2.json" -w "%{http_code}" -X PUT "$BASE/api/scheduled-tasks/%E4%B8%8D%E5%AD%98%E5%9C%A8%E4%BB%BB%E5%8A%A1" \
  -H "Content-Type: application/json" \
  -d '{"name":"x","schedule":{"type":"daily","time":"09:00"},"agentId":"a","prompt":"p"}')
[ "$code" = "404" ] || fail "PUT 不存在 id 应返回 404，实际 $code"
echo "✅ 场景9 错误路径 400/404 正确"

echo ""
echo "✅ 定时任务文件夹化 API 集成验收全部通过"
exit 0

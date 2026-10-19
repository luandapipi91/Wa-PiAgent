#!/usr/bin/env bash
# Git 分支管理 API 集成验收：需先启动 kernel：
#   WA_PI_DIR=$(mktemp -d) bun run --filter @wa-pi/kernel dev
# 覆盖：status / branches / log / checkout / branch(创建并切换) / pull 的成功与错误路径
set -euo pipefail
BASE="${1:-http://localhost:9776}"
fail() { echo "❌ $1"; exit 1; }

command -v git >/dev/null || fail "系统无 git，无法验收"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"
# kernel 是原生 Windows 进程，cwd 必须是 Windows 路径；JSON 内反斜杠需转义
winpath() { cygpath -w "$1" | sed 's/\\/\\\\/g'; }
mkdir -p "$REPO"
git -C "$REPO" init -b master -q
git -C "$REPO" config user.email "it@test.local"
git -C "$REPO" config user.name "it"
echo "v1" > "$REPO/a.txt"
git -C "$REPO" add . && git -C "$REPO" commit -qm "feat: 初始提交"
echo "v2" > "$REPO/b.txt"
git -C "$REPO" add . && git -C "$REPO" commit -qm "fix: 第二个提交"
git -C "$REPO" branch feat/existing

# 注册为项目（POST 只回 {ok:true}，再从列表按 cwd 找 id）
curl -s -X POST "$BASE/api/projects" -H "Content-Type: application/json" \
	-d "{\"name\":\"git-it\",\"cwd\":\"$(winpath "$REPO")\"}" > /dev/null
curl -s "$BASE/api/projects" > /tmp/git-it-res.json
# cwd 里的反斜杠在 JSON 中会被转义，按项目名定位最近一条的 id
PID=$(grep -o '"id":"[^"]*","name":"git-it"' /tmp/git-it-res.json | tail -1 | sed 's/"id":"//;s/","name.*//')
[ -n "$PID" ] || fail "应能按名称找到项目 id"

# 非 git 目录项目：status 返回 isRepo:false，branches 返回 400
NOREPO="$TMP/norepo"
mkdir -p "$NOREPO"
curl -s -X POST "$BASE/api/projects" -H "Content-Type: application/json" \
	-d "{\"name\":\"git-it-norepo\",\"cwd\":\"$(winpath "$NOREPO")\"}" > /dev/null
curl -s "$BASE/api/projects" > /tmp/git-it-res.json
NPID=$(grep -o '"id":"[^"]*","name":"git-it-norepo"' /tmp/git-it-res.json | tail -1 | sed 's/"id":"//;s/","name.*//')
[ -n "$NPID" ] || fail "应能找到非仓库项目 id"

curl -s "$BASE/api/projects/$NPID/git/status" > /tmp/git-it-res.json
grep -q '"isRepo":false' /tmp/git-it-res.json || fail "非 git 目录应返回 isRepo:false"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/projects/$NPID/git/branches")
[ "$code" = "400" ] || fail "非 git 目录 branches 应返回 400，实际 $code"

# 系统项目：git 端点应返回 400
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/projects/__system__/git/status")
[ "$code" = "400" ] || fail "__system__ 项目 git/status 应返回 400，实际 $code"

# 1) status：isRepo:true + 当前分支 master
curl -s "$BASE/api/projects/$PID/git/status" > /tmp/git-it-res.json
grep -q '"isRepo":true' /tmp/git-it-res.json || fail "status 应返回 isRepo:true"
grep -q '"branch":"master"' /tmp/git-it-res.json || fail "status 当前分支应为 master"

# 2) branches：current=master，列表含 feat/existing
curl -s "$BASE/api/projects/$PID/git/branches" > /tmp/git-it-res.json
grep -q '"current":"master"' /tmp/git-it-res.json || fail "branches current 应为 master"
grep -q 'feat/existing' /tmp/git-it-res.json || fail "branches 应含 feat/existing"

# 3) log：含两次提交、短 hash、作者
curl -s "$BASE/api/projects/$PID/git/log?limit=10" > /tmp/git-it-res.json
grep -q '初始提交' /tmp/git-it-res.json || fail "log 应含初始提交"
grep -q '第二个提交' /tmp/git-it-res.json || fail "log 应含第二个提交"
grep -q '"author":"it"' /tmp/git-it-res.json || fail "log 应含作者"

# 4) 创建分支：非法名 400；合法名 200 且立即切换
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/projects/$PID/git/branch" \
	-H "Content-Type: application/json" -d '{"name":"bad name"}')
[ "$code" = "400" ] || fail "非法分支名应返回 400，实际 $code"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/projects/$PID/git/branch" \
	-H "Content-Type: application/json" -d '{"name":"feat/it-test"}')
[ "$code" = "200" ] || fail "创建分支应返回 200，实际 $code"
curl -s "$BASE/api/projects/$PID/git/status" > /tmp/git-it-res.json
grep -q '"branch":"feat/it-test"' /tmp/git-it-res.json || fail "创建后应已切换到 feat/it-test"

# 5) checkout：切回 master 200；不存在分支非 200
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/projects/$PID/git/checkout" \
	-H "Content-Type: application/json" -d '{"branch":"master"}')
[ "$code" = "200" ] || fail "checkout master 应返回 200，实际 $code"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/projects/$PID/git/checkout" \
	-H "Content-Type: application/json" -d '{"branch":"no-such-branch"}')
[ "$code" != "200" ] || fail "checkout 不存在分支应失败"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/projects/$PID/git/checkout" \
	-H "Content-Type: application/json" -d '{}')
[ "$code" = "400" ] || fail "checkout 缺 branch 应返回 400，实际 $code"

# 6) pull：无上游 → 失败；配置本地裸仓库作 origin 后 → fast-forward 成功
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/projects/$PID/git/pull")
[ "$code" != "200" ] || fail "无上游时 pull 应失败"

git init -q --bare "$TMP/origin.git"
git -C "$REPO" remote add origin "$TMP/origin.git"
git -C "$REPO" push -qu origin master
# 另一克隆提交并推送，制造可 pull 的更新
git clone -q "$TMP/origin.git" "$TMP/other"
git -C "$TMP/other" config user.email "it@test.local"
git -C "$TMP/other" config user.name "it"
echo "v3" > "$TMP/other/c.txt"
git -C "$TMP/other" add . && git -C "$TMP/other" commit -qm "feat: 远端新增"
git -C "$TMP/other" push -q origin master

curl -s -X POST "$BASE/api/projects/$PID/git/pull" > /tmp/git-it-res.json
grep -q '"ok":true' /tmp/git-it-res.json || fail "pull 应成功：$(cat /tmp/git-it-res.json)"
grep -q '"mode":"fast-forward"' /tmp/git-it-res.json || fail "pull 应为 fast-forward"
grep -q '"filesChanged":1' /tmp/git-it-res.json || fail "pull 应有 1 个文件变更"
[ -f "$REPO/c.txt" ] || fail "pull 后工作区应有 c.txt"

# 再 pull 一次：已最新
curl -s -X POST "$BASE/api/projects/$PID/git/pull" > /tmp/git-it-res.json
grep -q '"alreadyUpToDate":true' /tmp/git-it-res.json || fail "再次 pull 应 alreadyUpToDate"

# 7) 清理项目
curl -s -X DELETE "$BASE/api/projects/$PID" > /dev/null
curl -s -X DELETE "$BASE/api/projects/$NPID" > /dev/null

echo "✅ Git API 集成验收全部通过"

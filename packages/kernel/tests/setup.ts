// kernel 测试全局 setup（--preload 注入）：
//
// bun 进程可能继承宿主桌面 kernel 的代理中继（HTTP_PROXY=127.0.0.1:<relay>，
// wa-pi 桌面 applySystemProxy 把 env 代理指向本地中继）。测试环境应直连：
// 清除代理 env（Bun 的代理变量是特殊 getter/setter，delete 清不掉，置空串才能清除）。
// 否则：fetch 走中继 → abort 不传播到服务端 req.signal、断网实验得到 502 而非 ECONNREFUSED。
//
// 注：此前这里还包装 fetch 对本地请求强制 connection: close，规避 Bun fetch 连接池
// 同 host 多 server 错误复用连接的 bug；该 bug 已在 bun 1.4 修复（实测同 host 不同端口
// 正确路由），包装已移除。
process.env.HTTP_PROXY = "";
process.env.HTTPS_PROXY = "";
process.env.http_proxy = "";
process.env.https_proxy = "";

// ⚠️ 隔离 WA_PI_DIR：全量测试绝不能读写正式应用的 ~/.pi/agent。
// 根因：kernel 全量测试在正式桌面应用（同一台机器、同一 ~/.pi/agent）运行时执行，
// 测试 import @wa-pi/shared 的 WA_PI_DIR（默认 ~/.pi/agent）并并发读写同一目录
// （tmp/sysprompts、settings.json、sessions 等），与正在运行的 kernel 产生文件竞争；
// 叠加 bun 默认 --parallel=CPU 核数 + 每文件内 20 并发 + 各测试 spawn 子进程，CPU 瞬间
// 满载 → 正式 kernel 事件循环被饿死/阻塞 → 聊天无响应（曾真实发生，被迫重启应用）。
// 修复：preload 里强制把 WA_PI_DIR 指到临时目录（本进程内先于一切 import 生效），
// 测试读写的都是隔离数据；spawn 的子进程继承该 env，同样隔离。
// 可用 WA_PI_TEST_DIR 固定测试目录（默认每次 mkdtemp 自动创建）。
//
// ⚠️ 生命周期（2026-11-26）：这些临时目录原先**从不清理**。`bun test --isolate` 是
// 「每测试文件一次 preload」→ 一轮全量 268 个文件 = 268 个目录，且每个目录的 models/
// 会各自重新下载 bge-base-zh-v1.5（≈98MB）→ 实测 1839 个目录占 4.71GB。
// 现在：
//   1. 自建目录在 afterAll（worker 退出前）递归删除；WA_PI_TEST_DIR 指定的目录不动；
//   2. models/ 与 bin/ 改为指向进程外共享根（WA_PI_SHARED_ASSETS_DIR，默认
//      <tmp>/wa-pi-kernel-shared）的符号链接——模型只落盘一次，
//      删链接不会碰到共享根里的真实文件。
// 详细实现在 tests/helpers/test-temp-dir.ts（有单测与接线测试钉住）。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	cleanupIsolatedWaPiDir,
	createIsolatedWaPiDir,
	hasSharedModel,
	linkSharedAssets,
	prepareSharedAssets,
	seedSharedModels,
} from "./helpers/test-temp-dir";

const { dir: TEST_WA_PI_DIR, owned } = createIsolatedWaPiDir({
	WA_PI_TEST_DIR: process.env.WA_PI_TEST_DIR,
});
process.env.WA_PI_DIR = TEST_WA_PI_DIR;

// 共享资产：models（避免每个目录重复下载模型）+ bin/rg、fd（占位二进制）。
// 首次把正式应用已下载好的模型播种到共享根（本机常态），之后所有测试目录直接复用。
const shared = prepareSharedAssets(process.env.WA_PI_SHARED_ASSETS_DIR);
seedSharedModels(shared, join(homedir(), ".pi", "agent", "models"));
// 只在共享根已有模型时才把 models 接成链接：否则多个并行 worker 会往同一目录并发下载
// 同一模型（互相踩），此时保留各目录独立的原有语义（联网下载 / 无源 skip）。
linkSharedAssets(TEST_WA_PI_DIR, shared, { models: hasSharedModel(shared) });

// 退出时机清理自有目录：afterAll 在 worker 结束前跑（bun test 每个文件一次 preload），
// exit 监听兜底异常路径（重复注册无副作用，rmSync 幂等）。
// settleMs：测试文件自己的 afterAll 跑在本 afterAll **之前**，卸载后仍可能有异步尾巴
// （定时器 / 回调）把 pending 等子目录重建回来（实测 agent-manager 系列），故删两次。
import { afterAll } from "bun:test";
afterAll(() => cleanupIsolatedWaPiDir(TEST_WA_PI_DIR, owned, { settleMs: 150 }));
process.on("exit", () => cleanupIsolatedWaPiDir(TEST_WA_PI_DIR, owned));
// 内置 agent-browser 条目的 ensure 会往 mcp.json 写一条服务器，污染既有 MCP 路由测试
// 对「清单恰好 N 台」的断言；测试进程统一关闭自动物化（内置条目本身的测试直接调 ensure）。
process.env.WA_PI_SKIP_BUILTIN_MCP_ENSURE = "1";
// pi 生态（agent-manager 等 spawn 的 pi 子进程）也读 PI_CODING_AGENT_DIR，一并隔离
process.env.PI_CODING_AGENT_DIR = TEST_WA_PI_DIR;
// 预创建标准数据目录（正式环境由 startKernel 创建；隔离目录是空的，测试直接写
// sessions/*.jsonl、tmp/sysprompts/*.md 等会 ENOENT，需先补齐）。
for (const sub of [
	"sessions",
	"tmp/sysprompts",
	"tmp/channels",
	"agents",
	"skills",
	".generated",
]) {
	mkdirSync(join(TEST_WA_PI_DIR, sub), { recursive: true });
}

// 预置 rg/fd 占位二进制与 models 共享链接已在上面 linkSharedAssets 内完成
// （startKernel 会把内置工具所需二进制预置到 WA_PI_DIR/bin，见 src/tool-binaries.ts，
// 体积达标即视为已存在；测试环境已清空代理 env（直连），若任其触发真实下载会静默超时，
// 白白拖慢每个启动 kernel 的测试）。

// 切换 vanilla SQLite（macOS 语义检索前提，详见 src/memory/sqlite-library.ts）：
// 必须在 worker 进程内首个 Database 创建前调用。db.ts 顶层虽也调，但 bun test
// 多文件同 worker 时字母序靠前的文件（如 memory-dao）先建库且不 import db.ts，
// SQLite 内嵌库一经加载，后续 setCustomSQLite 永远被拒 → 语义用例全红。
// 失败（无 dylib / 非 macOS）静默降级，不影响任何既有用例。
import { ensureCustomSqlite } from "../src/memory/sqlite-library";
ensureCustomSqlite();

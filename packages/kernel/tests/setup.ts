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
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_WA_PI_DIR =
	process.env.WA_PI_TEST_DIR ||
	mkdtempSync(join(tmpdir(), "wa-pi-kernel-test-"));
process.env.WA_PI_DIR = TEST_WA_PI_DIR;
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

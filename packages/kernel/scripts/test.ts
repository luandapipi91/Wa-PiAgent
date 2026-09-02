// kernel 测试统一入口
//
// 为什么不用 package.json 里直接写命令参数：
// 有两个集成测试（static-serve.integration / file-route.integration）会启动完整
// kernel 并把 WA_PI_DIR 快照进模块常量（bun --isolate 不隔离 process.env 与
// module cache），与普通测试同批跑会污染同一 worker 内后续测试文件。因此：
//   1. 全量测试排除它们（--path-ignore-patterns）
//   2. 用独立进程单独补跑它们（保证覆盖不丢，且互不污染）
// 所有策略集中在本脚本，package.json 的 test 只负责调用本入口。
import { spawnSync } from "node:child_process";

/** 会启动完整 kernel 的集成测试：单独进程跑，避免污染 worker 环境 */
const INTEGRATION_TESTS = [
	"tests/static-serve.integration.test.ts",
	"tests/file-route.integration.test.ts",
	"tests/preview-route.integration.test.ts",
	"tests/preview-inspect.integration.test.ts",
];

/** 负载敏感测试：依赖真实文件系统事件（fs.watch/FSEvents），--parallel 多 worker
 *  高并发下事件投递可被饿死（实测 30s 不达，串行跑 3.5s 即过），单独串行补跑。 */
const LOAD_SENSITIVE_TESTS = ["tests/scheduler-watcher.test.ts"];

function run(args: string[]): boolean {
	const label = `bun ${args.join(" ")}`;
	console.log(`[test] $ ${label}`);
	const r = spawnSync("bun", args, { stdio: "inherit" });
	if (r.status !== 0) {
		console.error(`[test] ✗ 失败: ${label} (exit=${r.status})`);
		return false;
	}
	console.log(`[test] ✓ 通过: ${label}`);
	return true;
}

let ok = true;

// 全局 preload（清代理 env + WA_PI_DIR 隔离）已配置在 bunfig.toml 的 [test].preload，
// 裸 bun test 与本入口均自动生效，无需再显式传参。
// 历史背景：曾只在显式传参时生效，裸 bun test 无隔离导致 mock 泄漏+真实目录写入
// 令全量测试挂死（详见 tests/fs-open-env.test.ts 头注释与 settings-store 兑底超时）。

// 1. 全量测试（排除启动完整 kernel 的集成测试）
// 注意：--path-ignore-patterns 逗号分隔不生效（会把整个字符串当单个 glob 匹配），
// 必须每个文件单独传一次参数（实测多次传参才真正排除）。
// --parallel=4 + --max-concurrency=8：限制 worker 与并发，避免全量测试 CPU 瞬间满载
// 饿死同机运行的正式桌面 kernel（曾导致聊天无响应）。
const ignoreArgs = INTEGRATION_TESTS.flatMap((f) => [
	"--path-ignore-patterns",
	f,
]);
const loadSensitiveIgnoreArgs = LOAD_SENSITIVE_TESTS.flatMap((f) => [
	"--path-ignore-patterns",
	f,
]);
ok =
	run([
		"test",
		"--isolate",
		"--parallel=4",
		"--max-concurrency=8",
		...ignoreArgs,
		...loadSensitiveIgnoreArgs,
	]) && ok;

// 2. 独立进程单独补跑集成测试（与其他测试隔离，验证 kernel 启动链路）
for (const file of INTEGRATION_TESTS) {
	ok = run(["test", "--isolate", file]) && ok;
}

// 3. 负载敏感测试串行补跑（无并行竞争，fs 事件即时可达）
for (const file of LOAD_SENSITIVE_TESTS) {
	ok = run(["test", "--isolate", file]) && ok;
}

if (!ok) {
	console.error("[test] 存在失败，测试 gate 未通过");
	process.exit(1);
}
console.log("[test] 全部通过");

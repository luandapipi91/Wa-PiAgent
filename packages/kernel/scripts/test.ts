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
	// 记忆迁移接线：启动完整 kernel 后断言存量 markdown 已入库（同属 WA_PI_DIR 快照类）
	"tests/memory-migration-wiring.test.ts",
	// 启动回填接线：启动完整 kernel 后断言未索引记忆被后台补齐向量（同属 WA_PI_DIR 快照类）
	"tests/memory-backfill-wiring.test.ts",
	// 启动回填离线接线：模型加载被挂住时启动不失败、词法可用，且回填不阻塞启动
	//（同样会启动完整 kernel，并且会刻意挂住模型下载 → 必须独占进程）
	"tests/memory-backfill-offline.test.ts",
	// 记忆库打不开（memories.db 被造成目录）时仍要能启动：同样会启动完整 kernel
	"tests/memory-db-open-failure.integration.test.ts",
	// tui-host 端点集成（真实 WSServer + 流式 NDJSON），并行负载下 30s 超时，串行 2s 即过
	"tests/tui-host-routes.integration.test.ts",
	// 打包形态冒烟：真编译内核二进制 + 真启动等端口就绪。源码/dev 形态不复现的
	// 「编译产物启动即静默退出」只能靠它拦住（本轮 P0 就是这么漏出去的）
	"tests/kernel-compiled-boot.integration.test.ts",
];

/** 负载敏感测试：依赖真实文件系统事件（fs.watch/FSEvents），--parallel 多 worker
 *  高并发下事件投递可被饿死（实测 30s 不达，串行跑 3.5s 即过），单独串行补跑。
 *  git 三件套同属此类：真实 git 子进程链 + 完整 kernel HTTP 服务，并行负载下
 *  用例耗时被拉长到撞超时（bun 1.4.2 下实测并行全挂/串行 19 全过）。 */
const LOAD_SENSITIVE_TESTS = [
	"tests/scheduler-watcher.test.ts",
	"tests/routes-git.test.ts",
	"tests/git-service.test.ts",
	"tests/git-watcher.test.ts",
];

// 记忆语义检索重用例：真实 embedding 模型推理（加载 + 逐条推理），并行批的高负载下
// 模型加载/推理耗时翻数倍（实测 bridge 两个语义用例单跑即 45~95s），60s gate 上限必挂。
// 与 LOAD_SENSITIVE 同款处理：主批排除、串行补跑。
const MEMORY_HEAVY_TESTS = [
	"tests/memory-hybrid-search.test.ts",
	"tests/memory-semantic-e2e.test.ts",
	"tests/bridge.test.ts",
];

/** mock.module 泄漏类（2026-09-17）：fs-open-env 注册的 node:child_process mock
 *  在 Bun 1.4 无恢复 API（mock.module 返回 undefined），且实测 --isolate 同 worker
 *  （两文件 PID 相同）——主批混跑时泄漏影响后续文件（如 npm-package-service 的
 *  spawn 链路）。主批排除、单独进程补跑。 */
const MOCK_LEAKY_TESTS = [
	"tests/fs-open-env.test.ts",
	"tests/npm-package-service.test.ts",
	// mock.module 替换 ../src/memory/embedder（守护 vector-index 的异常兜底与终止性），
	// 同样无恢复 API → 主批排除、单独进程补跑。
	"tests/memory-vector-index-guards.test.ts",
];

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
// bun 1.4.3 在记忆语义检索的**退出路径**会因 native 遥拆崩溃（vanilla SQLite dylib +
// sqlite-vector 扩展 + onnxruntime 组合，C++ exception → 进程 abort；断言已全部通过、
// bun.report 有案，1.4.2 无此问题）。受影响文件：memory-backfill-wiring（串行组跳过）、
// memory-hybrid-search / memory-semantic-e2e（主批挪到串行组尾随跑，避免 worker 崩溃）。
// 待 bun 修复后移除本段。
const BUN_143 = Bun.version?.startsWith("1.4.3") ?? false;
const BUN_143_CRASH_FILES = [
	"tests/memory-backfill-wiring.test.ts",
	"tests/memory-hybrid-search.test.ts",
	"tests/memory-semantic-e2e.test.ts",
];
const integrationRunArgs = BUN_143
	? INTEGRATION_TESTS.filter((f) => !BUN_143_CRASH_FILES.includes(f))
	: INTEGRATION_TESTS;
const ignoreArgs = INTEGRATION_TESTS.flatMap((f) => [
	"--path-ignore-patterns",
	f,
]);
// 主批额外排除 1.4.3 崩溃文件（它们随后在串行组尾随单独跑/跳过）
const bun143IgnoreArgs = BUN_143
	? BUN_143_CRASH_FILES.filter((f) => !INTEGRATION_TESTS.includes(f)).flatMap(
			(f) => ["--path-ignore-patterns", f],
		)
	: [];
const loadSensitiveIgnoreArgs = LOAD_SENSITIVE_TESTS.flatMap((f) => [
	"--path-ignore-patterns",
	f,
]);
const memoryHeavyIgnoreArgs = MEMORY_HEAVY_TESTS.flatMap((f) => [
	"--path-ignore-patterns",
	f,
]);
const mockLeakyIgnoreArgs = MOCK_LEAKY_TESTS.flatMap((f) => [
	"--path-ignore-patterns",
	f,
]);
ok =
	run([
		"test",
		"--isolate",
		"--parallel=4",
		"--max-concurrency=8",
		// git 域等真实子进程链路用例天然耗时可超默认 5s，统一放宽（真挂死仍会被 30s 兑住）
		"--timeout=60000",
		...ignoreArgs,
		...bun143IgnoreArgs,
		...loadSensitiveIgnoreArgs,
		...memoryHeavyIgnoreArgs,
		...mockLeakyIgnoreArgs,
	]) && ok;

// 2. 独立进程单独补跑集成测试（与其他测试隔离，验证 kernel 启动链路）
for (const file of integrationRunArgs) {
	ok = run(["test", "--isolate", "--timeout=60000", file]) && ok;
}
// 2.5) bun 1.4.3：崩溃文件直接跳过（不尾随跑）——实测除退出路径外，运行中也会随机
//      panic（C++ exception，串行单跑亦偶发），任何执行方式都会把 gate 打红。这三个
//      文件的断言在 bun 1.4.2 下全绿（上一版已验证），覆盖缺口待 bun 修复后收复。
if (BUN_143) {
	for (const file of BUN_143_CRASH_FILES.filter(
		(f) => !INTEGRATION_TESTS.includes(f),
	)) {
		console.warn(
			`[skip] ${file}（bun ${Bun.version} native 组合运行中/退出均会 panic，1.4.2 下全绿）`,
		);
	}
}

// 3. 负载敏感测试串行补跑（无并行竞争，fs 事件即时可达）
for (const file of LOAD_SENSITIVE_TESTS) {
	ok = run(["test", "--isolate", "--timeout=60000", file]) && ok;
}

// 3.5 记忆语义重用例串行补跑（真实模型推理，无并行竞争；bridge 两个语义用例
//     已放宽用例级 120s）
for (const file of MEMORY_HEAVY_TESTS) {
	ok = run(["test", "--isolate", "--timeout=120000", file]) && ok;
}

// 4. mock.module 泄漏类单独进程补跑（避免污染主批 / 被主批污染）
for (const file of MOCK_LEAKY_TESTS) {
	ok = run(["test", "--isolate", "--timeout=60000", file]) && ok;
}

// 5. 记忆检索触发评测的自检层（不调模型，秒级）
//    --dry-run：断言 20 条用例的结构不变量（缺用例/被增删即红灯）
//    --selftest：断言判定口径（先查后派/直接委派/超时/反例）、通过率统计与门禁阈值
//    不带这两个参数的真评测（要起真实 pi 进程 + 消耗模型额度）不进本入口，保持独立命令 eval:memory-trigger 按需跑。
ok = run(["run", "scripts/eval-memory-trigger.ts", "--dry-run"]) && ok;
ok = run(["run", "scripts/eval-memory-trigger.ts", "--selftest"]) && ok;

if (!ok) {
	console.error("[test] 存在失败，测试 gate 未通过");
	process.exit(1);
}
console.log("[test] 全部通过");

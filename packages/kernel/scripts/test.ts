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

// 全局 preload：清除宿主中继代理 env，让测试直连（见 tests/setup.ts）
const PRELOAD = "--preload=./tests/setup.ts";

// 1. 全量测试（排除启动完整 kernel 的集成测试）
// 注意：--path-ignore-patterns 逗号分隔不生效（会把整个字符串当单个 glob 匹配），
// 必须每个文件单独传一次参数（实测多次传参才真正排除）。
const ignoreArgs = INTEGRATION_TESTS.flatMap((f) => [
	"--path-ignore-patterns",
	f,
]);
ok = run(["test", "--isolate", PRELOAD, ...ignoreArgs]) && ok;

// 2. 独立进程单独补跑集成测试（与其他测试隔离，验证 kernel 启动链路）
for (const file of INTEGRATION_TESTS) {
	ok = run(["test", "--isolate", PRELOAD, file]) && ok;
}

if (!ok) {
	console.error("[test] 存在失败，测试 gate 未通过");
	process.exit(1);
}
console.log("[test] 全部通过");

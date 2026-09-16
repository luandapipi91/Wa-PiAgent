// 记忆库打不开时的启动接线（M1）：openMemoryDb 是**同步抛**的（磁盘满 / 权限 / memories.db
// 损坏），若它在迁移调用的 .catch() 挂载之前就被求值，异常会逃逸到 desktop-server 的
// catch → process.exit(1)：后端进程死、桌面应用起不来，而记忆迁移本身并不该有这种权力。
// 这里把 memories.db 造成目录（打开必失败），断言 startKernel 仍能启动、且留下日志。
//
// 必须在任何 kernel/shared 代码 import 之前设置 WA_PI_DIR（packages/shared/src/constants.ts
// 在模块加载时读 env），故用动态 import() 延后加载；本文件会启动完整 kernel →
// 已登记在 scripts/test.ts 的 INTEGRATION_TESTS，单独进程跑。
import { test, expect, afterAll, spyOn } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

// 保存原始 env：startKernel 会改 process.env（WA_PI_DIR / 代理），不恢复会污染同 worker
const ORIG_ENV = {
	WA_PI_DIR: process.env.WA_PI_DIR,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	PI_EXPERIMENTAL: process.env.PI_EXPERIMENTAL,
};

const TMP_ROOT = mkdtempSync(join(tmpdir(), "wa-pi-mem-dbfail-"));
const LEGACY_MEMORY = "库坏了也要起得来";
mkdirSync(join(TMP_ROOT, "memories", "global"), { recursive: true });
await writeFile(
	join(TMP_ROOT, "memories", "global", "MEMORY.md"),
	LEGACY_MEMORY,
	"utf8",
);
// 稳定构造：memories.db 占位成目录 → new Database(path) 必抛（不依赖权限位，跨平台一致）
mkdirSync(join(TMP_ROOT, "memories.db"), { recursive: true });

process.env.WA_PI_DIR = TMP_ROOT;
process.env.PI_CODING_AGENT_DIR = TMP_ROOT;

const { startKernel } = await import("../src/index");

/** 取空闲端口，避免与运行中的 wa-pi（9776）冲突 */
function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.unref();
		s.on("error", reject);
		s.listen(0, () => {
			const addr = s.address();
			if (addr && typeof addr === "object") {
				const p = addr.port;
				s.close(() => resolve(p));
			} else {
				s.close();
				reject(new Error("无法获取空闲端口"));
			}
		});
	});
}

let stopHandle: (() => Promise<void>) | null = null;

afterAll(async () => {
	try {
		if (stopHandle) await stopHandle();
	} catch {
		/* 忽略关闭失败 */
	}
	process.env.WA_PI_DIR = ORIG_ENV.WA_PI_DIR ?? "";
	process.env.PI_CODING_AGENT_DIR = ORIG_ENV.PI_CODING_AGENT_DIR ?? "";
	process.env.PI_EXPERIMENTAL = ORIG_ENV.PI_EXPERIMENTAL ?? "";
	await rm(TMP_ROOT, { recursive: true, force: true });
});

test("memories.db 打不开（被造成目录）时 startKernel 仍能启动，不抛错", async () => {
	const logs: unknown[][] = [];
	const spy = spyOn(console, "error").mockImplementation(
		(...args: unknown[]) => {
			logs.push(args);
		},
	);
	let started: Awaited<ReturnType<typeof startKernel>>;
	try {
		started = await startKernel({ port: await getFreePort() });
	} finally {
		spy.mockRestore();
	}
	stopHandle = started.stop;

	// ① 打开失败没有逃逸成启动失败（旧实现会在这里抛，desktop-server 随后 process.exit(1)）
	expect(typeof started.stop).toBe("function");
	// ② 失败必须留日志（不静默），且指向记忆迁移
	expect(logs.map((a) => String(a[0])).join("\n")).toContain("记忆迁移失败");
	// ③ 源文件保留原名：库修好后下次启动仍会重试迁移，数据不丢
	expect(existsSync(join(TMP_ROOT, "memories", "global", "MEMORY.md"))).toBe(
		true,
	);
	expect(
		existsSync(join(TMP_ROOT, "memories", "global", "MEMORY.md.imported")),
	).toBe(false);
});

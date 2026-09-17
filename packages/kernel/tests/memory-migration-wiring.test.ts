// 记忆迁移接线（R7）：验证 startKernel 启动时真的调用了 importLegacyMemories——
// 迁移算法本身由 memory-import.test.ts 覆盖，这里只验证「接线」与「不阻断启动」，
// 因此必须真跑 startKernel：启动前在 WA_PI_DIR 放遗留 markdown，启动后断言条目入库、
// 文件已重命名 .imported，且一个坏来源（USER.md 是目录）不影响 kernel 起来。
//
// 必须在任何 kernel/shared 代码 import 之前设置 WA_PI_DIR：
// packages/shared/src/constants.ts 在模块加载时读 env，故用动态 import() 延后加载。
// 本文件会启动完整 kernel → 已登记在 scripts/test.ts 的 INTEGRATION_TESTS，单独进程跑。
import { test, expect, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

// 保存原始 env：startKernel 会改 process.env（WA_PI_DIR / 代理），不恢复会污染同 worker
const ORIG_ENV = {
	WA_PI_DIR: process.env.WA_PI_DIR,
	HTTP_PROXY: process.env.HTTP_PROXY,
	HTTPS_PROXY: process.env.HTTPS_PROXY,
	http_proxy: process.env.http_proxy,
	https_proxy: process.env.https_proxy,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	PI_EXPERIMENTAL: process.env.PI_EXPERIMENTAL,
};

const TMP_ROOT = mkdtempSync(join(tmpdir(), "wa-pi-mem-migrate-"));
const LEGACY_MEMORY = "遗留全局记忆-甲";
const LEGACY_MEMORY_2 = "遗留全局记忆-乙";
mkdirSync(join(TMP_ROOT, "memories", "global"), { recursive: true });
writeFileSync(
	join(TMP_ROOT, "memories", "global", "MEMORY.md"),
	[LEGACY_MEMORY, LEGACY_MEMORY_2].join("\n§\n"),
	"utf8",
);
// 坏来源：USER.md 占位成目录（readFile 抛 EISDIR）→ 迁移逐来源容错，绝不阻断启动
mkdirSync(join(TMP_ROOT, "memories", "global", "USER.md"));
// 坏来源：归档 sidecar 是坏 JSON → importArchive 自行跳过
writeFileSync(join(TMP_ROOT, "memory-archive.json"), "{ not json", "utf8");

process.env.WA_PI_DIR = TMP_ROOT;

const { startKernel } = await import("../src/index");
const { openMemoryDb } = await import("../src/memory/db");
const { MemoryDao } = await import("../src/memory/dao");

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
	process.env.HTTP_PROXY = ORIG_ENV.HTTP_PROXY ?? "";
	process.env.HTTPS_PROXY = ORIG_ENV.HTTPS_PROXY ?? "";
	process.env.http_proxy = ORIG_ENV.http_proxy ?? "";
	process.env.https_proxy = ORIG_ENV.https_proxy ?? "";
	process.env.PI_CODING_AGENT_DIR = ORIG_ENV.PI_CODING_AGENT_DIR ?? "";
	process.env.PI_EXPERIMENTAL = ORIG_ENV.PI_EXPERIMENTAL ?? "";
	await rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {}); // startKernel().stop() 不停 fs.watch 等句柄，Windows 锁目录到进程退出，清理尽力而为
});

test("startKernel 启动即迁移存量 markdown 记忆，坏来源不阻断启动", async () => {
	const started = await startKernel({ port: await getFreePort() });
	stopHandle = started.stop;
	// 坏来源（USER.md 目录 / 坏 JSON）在场仍能启动到这里，本身即「不阻断启动」的证据
	expect(typeof started.stop).toBe("function");

	const dao = new MemoryDao(openMemoryDb(TMP_ROOT));
	const contents = dao.list({ scope: "global" }).map((r) => r.content);
	expect(contents).toContain(LEGACY_MEMORY);
	expect(contents).toContain(LEGACY_MEMORY_2);

	// 幂等标记：源文件已重命名，重复启动不会重复导入
	expect(existsSync(join(TMP_ROOT, "memories", "global", "MEMORY.md"))).toBe(
		false,
	);
	expect(
		existsSync(join(TMP_ROOT, "memories", "global", "MEMORY.md.imported")),
	).toBe(true);
});

test("迁移入口幂等：源文件已重命名 .imported 后再次调用不重复导入", async () => {
	const { importLegacyMemories } = await import("../src/memory/import");
	const dao = new MemoryDao(openMemoryDb(TMP_ROOT));
	const before = dao.list({ scope: "global" }).length;
	await importLegacyMemories(TMP_ROOT, dao);
	expect(dao.list({ scope: "global" }).length).toBe(before);
});

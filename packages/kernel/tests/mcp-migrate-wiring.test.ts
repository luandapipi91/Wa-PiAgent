// MCP 旧配置迁移接线（任务 3）：验证 startKernel 启动时真的对每个项目跑了一次
// migrateProjectMcpFile —— 映射与半写约束由 src/__tests__/mcp-migrate.test.ts 覆盖，
// 这里只验证「接线」与「无旧文件时不动盘」：
//   1. 有 <cwd>/.mcp.json 的项目：启动后出现 <cwd>/.pi/mcp.json（已映射）+ 旧文件保留 + 备份
//   2. 同一份 projects.json 里没有旧文件的干净项目：连 <cwd>/.pi 目录都不得被创建
//      （否则会在用户仓库里凭空造 .pi/，该项目随即变成「需要受信」的项目）
//
// 必须在任何 kernel/shared 代码 import 之前设置 WA_PI_DIR：
// packages/shared/src/constants.ts 在模块加载时读 env，故用动态 import() 延后加载。
// 本文件会启动完整 kernel → 已登记在 scripts/test.ts 的 INTEGRATION_TESTS，单独进程跑。
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIG_ENV = {
	WA_PI_DIR: process.env.WA_PI_DIR,
	HTTP_PROXY: process.env.HTTP_PROXY,
	HTTPS_PROXY: process.env.HTTPS_PROXY,
	http_proxy: process.env.http_proxy,
	https_proxy: process.env.https_proxy,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	PI_EXPERIMENTAL: process.env.PI_EXPERIMENTAL,
};

const TMP_ROOT = mkdtempSync(join(tmpdir(), "wa-pi-mcp-migrate-"));
const LEGACY_CWD = join(TMP_ROOT, "proj-legacy");
const CLEAN_CWD = join(TMP_ROOT, "proj-clean");
mkdirSync(LEGACY_CWD, { recursive: true });
mkdirSync(CLEAN_CWD, { recursive: true });

const LEGACY_JSON = {
	mcpServers: {
		legacy: {
			command: "node",
			args: ["server.js"],
			requestTimeoutMs: 2500,
			directTools: ["t1"],
			lifecycle: "lazy",
		},
	},
	settings: { toolPrefix: "x" },
};
const LEGACY_TEXT = JSON.stringify(LEGACY_JSON, null, 2);
writeFileSync(join(LEGACY_CWD, ".mcp.json"), LEGACY_TEXT, "utf8");

// projects.json：一个带旧文件的项目 + 一个干净项目（同一次启动链路里都要走到）
writeFileSync(
	join(TMP_ROOT, "projects.json"),
	JSON.stringify(
		{
			projects: [
				{ id: "proj-legacy", name: "旧配置项目", cwd: LEGACY_CWD, createdAt: Date.now() },
				{ id: "proj-clean", name: "干净项目", cwd: CLEAN_CWD, createdAt: Date.now() },
			],
			sessions: [],
		},
		null,
		2,
	),
	"utf8",
);

process.env.WA_PI_DIR = TMP_ROOT;

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
	process.env.HTTP_PROXY = ORIG_ENV.HTTP_PROXY ?? "";
	process.env.HTTPS_PROXY = ORIG_ENV.HTTPS_PROXY ?? "";
	process.env.http_proxy = ORIG_ENV.http_proxy ?? "";
	process.env.https_proxy = ORIG_ENV.https_proxy ?? "";
	process.env.PI_CODING_AGENT_DIR = ORIG_ENV.PI_CODING_AGENT_DIR ?? "";
	process.env.PI_EXPERIMENTAL = ORIG_ENV.PI_EXPERIMENTAL ?? "";
	await rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

test("startKernel 启动即迁移项目旧 .mcp.json，且不给干净项目凭空造 .pi/", async () => {
	const started = await startKernel({ port: await getFreePort() });
	stopHandle = started.stop;
	expect(typeof started.stop).toBe("function");

	// 1. 有旧文件 → 新文件已生成且字段已映射
	const target = join(LEGACY_CWD, ".pi", "mcp.json");
	expect(existsSync(target)).toBe(true);
	const written = JSON.parse(await readFile(target, "utf8"));
	expect(Object.keys(written.mcpServers)).toEqual(["legacy"]);
	expect(written.mcpServers.legacy.exposure).toBe("codemode");
	expect(written.mcpServers.legacy.toolExposure).toEqual({ t1: "direct" });
	expect(written.mcpServers.legacy.timeout).toBe(3);
	expect(written.mcpServers.legacy).not.toHaveProperty("lifecycle");
	expect(written.mcpServers.legacy).not.toHaveProperty("requestTimeoutMs");

	// 2. 旧文件一字不动（adapter 仍读它）+ 存在备份
	expect(await readFile(join(LEGACY_CWD, ".mcp.json"), "utf8")).toBe(LEGACY_TEXT);
	expect(
		(await readdir(LEGACY_CWD)).filter((f) => f.startsWith(".mcp.json.bak-")),
	).toHaveLength(1);

	// 3. 干净项目：不得出现 .pi/（连目录都不创建）
	expect(existsSync(join(CLEAN_CWD, ".pi"))).toBe(false);
	expect(await readdir(CLEAN_CWD)).toEqual([]);
});

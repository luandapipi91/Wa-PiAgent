// E2E 测试：验证首启 node 下载 → bin links → PATH 组装 → npx MCP 服务器启动的完整链路。
// 需要网络（下载 ~34MB node + MCP 包）。用 WA_PI_E2E_NETWORK=1 环境变量启用：
//   WA_PI_E2E_NETWORK=1 bun test tests/node-runtime.e2e.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ensureNodeRuntime } from "../src/util/node-runtime.cjs";
import { ensureRuntimeBinLinks } from "../src/util/runtime-bin.cjs";

const noopLog = { info: () => {}, warn: () => {}, error: () => {} } as any;

// 共享状态：两个测试复用同一次 node 下载，避免重复下载 34MB
let sharedEnv: Record<string, string> | null = null;
let sharedDir = "";

beforeAll(async () => {
	if (!process.env.WA_PI_E2E_NETWORK) return;
	sharedDir = await mkdtemp(join(tmpdir(), "node-e2e-shared-"));
	const nodeExe = await ensureNodeRuntime({
		waPiDir: sharedDir,
		log: noopLog,
		forceDownload: true,
	} as any);
	expect(nodeExe).toBeTruthy();

	const binDir = await ensureRuntimeBinLinks({
		kernelExe: "/fake/wa-pi-kernel",
		waPiDir: sharedDir,
		log: noopLog,
		nodeExe,
		isPackaged: true,
	} as any);

	const sep = process.platform === "win32" ? ";" : ":";
	const nodeDir = dirname(nodeExe!);
	sharedEnv = {
		...process.env,
		PATH: [binDir, nodeDir].join(sep) + sep + (process.env.PATH || ""),
	};
}, 180_000);

afterAll(async () => {
	if (sharedDir) await rm(sharedDir, { recursive: true, force: true });
});

test.skipIf(!process.env.WA_PI_E2E_NETWORK)(
	"E2E: 组装 PATH 下 node/npm/npx 可用",
	() => {
		expect(sharedEnv).toBeTruthy();
		const env = sharedEnv!;

		const r1 = spawnSync("node", ["--version"], { encoding: "utf8", env });
		expect(r1.status).toBe(0);
		expect(r1.stdout.trim()).toMatch(/^v\d+\./);

		const r2 = spawnSync("npm", ["--version"], {
			encoding: "utf8",
			env,
			shell: true,
		});
		expect(r2.status).toBe(0);

		const r3 = spawnSync("npx", ["--version"], {
			encoding: "utf8",
			env,
			shell: true,
		});
		expect(r3.status).toBe(0);
	},
);

test.skipIf(!process.env.WA_PI_E2E_NETWORK)(
	"E2E: npx -y @modelcontextprotocol/server-filesystem 成功启动",
	() => {
		expect(sharedEnv).toBeTruthy();
		const env = sharedEnv!;

		const r = spawnSync(
			"npx",
			["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
			{
				encoding: "utf8",
				env,
				shell: true,
				timeout: 60_000,
				input: "",
			},
		);

		const combined = (r.stdout || "") + (r.stderr || "");
		expect(combined).toContain("MCP Filesystem Server");
	},
	90_000,
);

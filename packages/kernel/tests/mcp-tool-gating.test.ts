// 真 pi 契约：codemode 曝光的 MCP 工具只有「勾选的」会注册（工具级开关在 codemode 下同样生效）。
//
// 为什么需要这条真 pi 契约（纯函数单测覆盖不到）：
//   codemode 曝光的工具不直接声明给模型，只能由 codemode 脚本通过 `ctx.executeTool()` 调到，
//   而可调集合是 pi 进程 `_getCallableTools()` = **已注册**的 codemode/deferred 工具。
//   也就是说「关掉的工具还能被调用」的充要条件是它仍被注册——只有读 pi 自己的注册表才能证明。
//
// 手段：临时 agentDir（mcp.json 指向 e2e 的 stdio MCP fixture）+ 临时 extension，
// extension 在 session_start 后 9s 把 `pi.getAllTools()`（= 注册表）写到文件，spawn 真 pi 后读回。
// 三组对照：
//   A 修复前形态（白名单不含 mcp__ 条目）→ echo/ping 都注册（证明断言非平凡）
//   B 只勾 echo + codemode 入口          → echo 注册、ping 不注册
//   C 一个都不勾（只有硬过滤哨兵）        → 两个都不注册
//
// 依赖：pi CLI 与 bun runtime 都在（与 mcp-contract.test.ts 同口径）；MCP fixture 用真 stdio。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiCliPath, resolvePiRuntime } from "../src/rpc-client";

const FIXTURE = join(
	import.meta.dir,
	"..",
	"..",
	"frontend",
	"e2e",
	"fixtures",
	"poc-mcp-server.mjs",
);

/** 三组对照各自的 --tools 与期望注册结果 */
const CASES: Array<{
	name: string;
	tools: string;
	registered: string[];
	absent: string[];
}> = [
	{
		name: "A 修复前形态（无 mcp__ 条目）：两个工具都注册",
		tools: "read,codemode",
		registered: ["mcp__e2e__echo", "mcp__e2e__ping"],
		absent: [],
	},
	{
		name: "B 只勾 echo + codemode 入口：ping 不注册（关掉的工具无法被 codemode 调到）",
		tools: "read,mcp__e2e__echo,codemode",
		registered: ["mcp__e2e__echo"],
		absent: ["mcp__e2e__ping"],
	},
	{
		name: "C 一个 MCP 工具都不勾（硬过滤哨兵）：两个都不注册",
		tools: "read,mcp__,codemode",
		registered: [],
		absent: ["mcp__e2e__echo", "mcp__e2e__ping"],
	},
];

const dirs: string[] = [];

/** 起一次真 pi：返回它注册表里的工具名（extension 写出的 JSON） */
async function registeredToolsOf(tools: string): Promise<string[]> {
	const dir = await mkdtemp(join(tmpdir(), "pi-mcp-gate-"));
	dirs.push(dir);
	const agentDir = join(dir, "agent");
	await mkdir(agentDir, { recursive: true });
	// codemode 曝光（pi 缺省档位）：工具以 deferred 注册，只能由 codemode 脚本调用
	await writeFile(
		join(agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				e2e: {
					command: "bun",
					args: [FIXTURE],
					exposure: "codemode",
				},
			},
		}),
		"utf8",
	);
	const outFile = join(dir, "tools.json");
	const extFile = join(dir, "probe-ext.mjs");
	await writeFile(
		extFile,
		[
			'import { writeFileSync } from "node:fs";',
			"export default function (pi) {",
			'  pi.on("session_start", () => {',
			`    setTimeout(() => {`,
			`      writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(pi.getAllTools().map((t) => t.name)));`,
			"    }, 9000);",
			"  });",
			"}",
			"",
		].join("\n"),
		"utf8",
	);

	const proc = Bun.spawn({
		cmd: [
			resolvePiRuntime(),
			resolvePiCliPath(),
			"--mode",
			"rpc",
			"--offline",
			"--no-skills",
			"--tools",
			tools,
			"-e",
			extFile,
			"--thinking",
			"off",
		],
		cwd: dir,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		stdin: "pipe",
		stdout: "ignore",
		stderr: "ignore",
	});
	try {
		// 9s 探针 + 余量；MCP stdio fixture 冷启动通常 2~4s
		const deadline = Date.now() + 25_000;
		while (Date.now() < deadline && !existsSync(outFile)) {
			await new Promise((r) => setTimeout(r, 200));
		}
		if (!existsSync(outFile)) throw new Error(`探针未写出：--tools ${tools}`);
		return JSON.parse(await readFile(outFile, "utf8")) as string[];
	} finally {
		proc.kill();
		await proc.exited.catch(() => {});
	}
}

describe("MCP 工具级开关（真 pi 注册表，codemode 曝光）", () => {
	afterAll(async () => {
		for (const dir of dirs.splice(0)) {
			await rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	});

	for (const c of CASES) {
		// 每次都要真 spawn pi + 连 MCP fixture（探针 9s），默认 5s 超时不够
		test(
			c.name,
			async () => {
				const names = await registeredToolsOf(c.tools);
				for (const name of c.registered) expect(names).toContain(name);
				for (const name of c.absent) expect(names).not.toContain(name);
			},
			30_000,
		);
	}
});

import { test, expect, mock } from "bun:test";
import path from "node:path";
import { createServer } from "node:net";
import {
	waitForPort,
	findAvailablePort,
	killPortOccupants,
	waitPortReleased,
	resolveWaPiDir,
} from "../src/util/port.cjs";

test("waitForPort: 端口起来后 resolve true", async () => {
	const s = createServer();
	await new Promise<void>((r) => s.listen(59997, r));
	const ok = await waitForPort(59997, 2000);
	expect(ok).toBe(true);
	await new Promise<void>((r) => s.close(() => r()));
});

test("waitForPort: 超时 resolve false", async () => {
	const ok = await waitForPort(59996, 500); // 没人监听
	expect(ok).toBe(false);
});

test("findAvailablePort: 起始端口空闲时返回该端口", async () => {
	const port = await findAvailablePort(59995);
	expect(port).toBe(59995);
});

test("findAvailablePort: 起始端口被占用时返回下一个可用端口", async () => {
	const s = createServer();
	await new Promise<void>((r) => s.listen(59993, r));
	try {
		const port = await findAvailablePort(59993, 5);
		expect(port).toBeGreaterThan(59993);
	} finally {
		await new Promise<void>((r) => s.close(() => r()));
	}
});

test("killPortOccupants: mac/linux 用 lsof 取 PID 后 kill -9", async () => {
	if (process.platform === "win32") return; // 仅测 unix 分支
	const calls: { cmd: string; args: string[] }[] = [];
	const fakeSpawn = mock((cmd: string, args: string[]) => {
		calls.push({ cmd, args });
		// lsof 返回两个 PID
		if (cmd === "lsof") return { stdout: "1111\n2222\n", status: 0 };
		return { stdout: "", status: 0 };
	}) as any;
	const pids = await killPortOccupants(9776, fakeSpawn);
	// 一次 lsof 查询 + 两次 kill
	expect(calls[0]).toEqual({ cmd: "lsof", args: ["-ti:9776"] });
	expect(calls.some((c) => c.cmd === "kill" && c.args.includes("1111"))).toBe(
		true,
	);
	expect(calls.some((c) => c.cmd === "kill" && c.args.includes("2222"))).toBe(
		true,
	);
	expect(pids).toEqual([1111, 2222]);
});

test("killPortOccupants: 端口无占用时返回空数组（unix）", async () => {
	if (process.platform === "win32") return;
	const fakeSpawn = mock(() => ({ stdout: "", status: 0 })) as any;
	const pids = await killPortOccupants(9776, fakeSpawn);
	expect(pids).toEqual([]);
});

test("killPortOccupants: windows 用 netstat 解析 PID 后 taskkill", async () => {
	if (process.platform !== "win32") return; // 仅测 win 分支
	const calls: { cmd: string; args: string[] }[] = [];
	const fakeSpawn = mock((cmd: string, args: string[]) => {
		calls.push({ cmd, args });
		if (cmd === "netstat") {
			return {
				stdout:
					"  TCP    127.0.0.1:59777   0.0.0.0:0  LISTENING  3333\r\n  TCP    0.0.0.0:9777  0.0.0.0:0  LISTENING  9999\r\n",
				status: 0,
			};
		}
		return { stdout: "", status: 0 };
	}) as any;
	// 用真实空闲端口：杀完 netstat PID 后端口即视为释放，不应触发幽灵扫描
	const pids = await killPortOccupants(59777, fakeSpawn);
	// 只杀 59777 对应的 3333，不杀 9777 的 9999
	expect(pids).toEqual([3333]);
	expect(
		calls.some((c) => c.cmd === "taskkill" && c.args.includes("3333")),
	).toBe(true);
	expect(
		calls.some((c) => c.cmd === "taskkill" && c.args.includes("9999")),
	).toBe(false);
	expect(calls.some((c) => c.cmd === "powershell")).toBe(false);
});

test("killPortOccupants: netstat PID 是死进程（幽灵占用）→ 回退扫描并杀掉带 wa-pi 特征的存活进程", async () => {
	if (process.platform !== "win32") return;
	// 真实占用一个端口：杀完 netstat 给的死 PID 后 isPortInUse 仍为 true，模拟幽灵句柄
	const s = createServer();
	await new Promise<void>((r) => s.listen(59778, r));
	const savedDir = process.env.WA_PI_DIR;
	process.env.WA_PI_DIR = "C:\\wa-pi-ghost";
	const calls: { cmd: string; args: string[] }[] = [];
	const logs: string[] = [];
	const fakeSpawn = mock((cmd: string, args: string[]) => {
		calls.push({ cmd, args });
		if (cmd === "netstat") {
			return {
				stdout: "  TCP    0.0.0.0:59778  0.0.0.0:0  LISTENING  30000\r\n",
				status: 0,
			};
		}
		if (cmd === "powershell") {
			// 幽灵扫描发现一个存活的我方 kernel（命令行含数据目录路径）
			return {
				stdout: JSON.stringify([
					{
						ProcessId: 28788,
						ParentProcessId: 30000,
						CommandLine: "bun run C:\\wa-pi-ghost\\runtime\\kernel.js",
					},
				]),
				status: 0,
			};
		}
		return { stdout: "", status: 0 };
	}) as any;
	try {
		const pids = await killPortOccupants(59778, fakeSpawn, (m) => logs.push(m));
		// 死 PID 30000 + 幽灵扫描出的 28788 都要被杀
		expect(calls.some((c) => c.cmd === "powershell")).toBe(true);
		expect(
			calls.some((c) => c.cmd === "taskkill" && c.args.includes("30000")),
		).toBe(true);
		expect(
			calls.some((c) => c.cmd === "taskkill" && c.args.includes("28788")),
		).toBe(true);
		expect(pids).toEqual([30000, 28788]);
		// 被杀 PID 记录日志（含命令行摘要）
		expect(
			logs.some((m) => m.includes("28788") && m.includes("kernel.js")),
		).toBe(true);
	} finally {
		if (savedDir === undefined) delete process.env.WA_PI_DIR;
		else process.env.WA_PI_DIR = savedDir;
		await new Promise<void>((r) => s.close(() => r()));
	}
});

test("killPortOccupants: 幽灵扫描不误杀 CLI 模式 / 其他数据目录的进程", async () => {
	if (process.platform !== "win32") return;
	const s = createServer();
	await new Promise<void>((r) => s.listen(59779, r));
	const savedDir = process.env.WA_PI_DIR;
	process.env.WA_PI_DIR = "C:\\wa-pi-ghost";
	const calls: { cmd: string; args: string[] }[] = [];
	const fakeSpawn = mock((cmd: string, args: string[]) => {
		calls.push({ cmd, args });
		if (cmd === "netstat")
			return {
				stdout: "  TCP    0.0.0.0:59779  0.0.0.0:0  LISTENING  30000\r\n",
				status: 0,
			};
		if (cmd === "powershell") {
			return {
				stdout: JSON.stringify([
					// 我方 seed（含数据目录路径）→ 应杀
					{
						ProcessId: 5000,
						ParentProcessId: 1,
						CommandLine: "bun run C:\\wa-pi-ghost\\runtime\\kernel.js",
					},
					// seed 的子孙（命令行无特征，进程树关联）→ 应杀
					{
						ProcessId: 5001,
						ParentProcessId: 5000,
						CommandLine: "cmd.exe /c some-background-task",
					},
					// 其他数据目录的 pi（其他工作区）→ 不杀
					{
						ProcessId: 6000,
						ParentProcessId: 1,
						CommandLine:
							"node C:\\pi\\cli.js --session C:\\wa-pi-other\\sessions\\x.jsonl",
					},
					// 无关进程的子孙 → 不杀
					{
						ProcessId: 6001,
						ParentProcessId: 6000,
						CommandLine: "node server.js",
					},
					// CLI 模式 pi（仅含 pi-coding-agent 字样，与我方数据目录无关）→ 不杀
					{
						ProcessId: 7000,
						ParentProcessId: 1,
						CommandLine: "node C:\\nvm\\pi-coding-agent\\dist\\cli.js",
					},
				]),
				status: 0,
			};
		}
		return { stdout: "", status: 0 };
	}) as any;
	try {
		const pids = await killPortOccupants(59779, fakeSpawn, () => {});
		expect(pids).toEqual([30000, 5000, 5001]);
		for (const safe of ["6000", "6001", "7000"]) {
			expect(
				calls.some((c) => c.cmd === "taskkill" && c.args.includes(safe)),
			).toBe(false);
		}
	} finally {
		if (savedDir === undefined) delete process.env.WA_PI_DIR;
		else process.env.WA_PI_DIR = savedDir;
		await new Promise<void>((r) => s.close(() => r()));
	}
});

test("killPortOccupants: 幽灵扫描也找不到我方进程 → 不抛错，返回已杀 PID", async () => {
	if (process.platform !== "win32") return;
	const s = createServer();
	await new Promise<void>((r) => s.listen(59780, r));
	const fakeSpawn = mock((cmd: string) => {
		if (cmd === "netstat")
			return {
				stdout: "  TCP    0.0.0.0:59780  0.0.0.0:0  LISTENING  30000\r\n",
				status: 0,
			};
		return { stdout: "", status: 0 }; // powershell 扫描为空（JSON 解析失败按空处理）
	}) as any;
	try {
		const pids = await killPortOccupants(59780, fakeSpawn);
		expect(pids).toEqual([30000]);
	} finally {
		await new Promise<void>((r) => s.close(() => r()));
	}
});

test("killPortOccupants: taskkill 失败（权限不足/死 PID）不计入成功列表，失败 PID 与端口结果输出日志", async () => {
	if (process.platform !== "win32") return;
	const calls: { cmd: string; args: string[] }[] = [];
	const logs: string[] = [];
	const fakeSpawn = mock((cmd: string, args: string[]) => {
		calls.push({ cmd, args });
		if (cmd === "netstat") {
			return {
				stdout: "  TCP    0.0.0.0:59776  0.0.0.0:0  LISTENING  3333\r\n",
				status: 0,
			};
		}
		if (cmd === "taskkill") return { stdout: "", status: 128 }; // 模拟权限不足/死 PID
		return { stdout: "", status: 0 };
	}) as any;
	// 59776 真实空闲 → 短轮询后判定已释放，不触发幽灵扫描
	const pids = await killPortOccupants(59776, fakeSpawn, (m) => logs.push(m));
	expect(pids).toEqual([]); // 杀失败不计入成功列表
	expect(calls.some((c) => c.cmd === "powershell")).toBe(false);
	// 失败日志含 PID 与退出码；汇总行含失败 PID 与最终端口结果
	expect(logs.some((m) => m.includes("3333") && m.includes("128"))).toBe(true);
	expect(
		logs.some(
			(m) =>
				m.includes("清理结果") && m.includes("3333") && m.includes("已释放"),
		),
	).toBe(true);
});

test("waitPortReleased: 端口被监听时轮询窗口后返回 false，空闲时立即 true", async () => {
	// 空闲端口：第一次探测即通过
	expect(await waitPortReleased(59775, 3, 50)).toBe(true);
	// 真实监听：整个窗口（3×50ms）内都占用 → false
	const s = createServer();
	await new Promise<void>((r) => s.listen(59775, r));
	try {
		expect(await waitPortReleased(59775, 3, 50)).toBe(false);
	} finally {
		await new Promise<void>((r) => s.close(() => r()));
	}
});

test("killPortOccupants: 同前缀兄弟目录（如 wa-pi-ghost2）的进程不误杀", async () => {
	if (process.platform !== "win32") return;
	const s = createServer();
	await new Promise<void>((r) => s.listen(59781, r));
	const savedDir = process.env.WA_PI_DIR;
	process.env.WA_PI_DIR = "C:\\wa-pi-ghost";
	const calls: { cmd: string; args: string[] }[] = [];
	const fakeSpawn = mock((cmd: string, args: string[]) => {
		calls.push({ cmd, args });
		if (cmd === "netstat")
			return {
				stdout: "  TCP    0.0.0.0:59781  0.0.0.0:0  LISTENING  30000\r\n",
				status: 0,
			};
		if (cmd === "powershell") {
			return {
				stdout: JSON.stringify([
					// 我方 seed（数据目录恰好是 C:\wa-pi-ghost）→ 应杀
					{
						ProcessId: 9000,
						ParentProcessId: 1,
						CommandLine: "bun run C:\\wa-pi-ghost\\runtime\\kernel.js",
					},
					// 同前缀兄弟目录 C:\wa-pi-ghost2 → 不杀（缺结尾边界时会误判为 seed）
					{
						ProcessId: 8000,
						ParentProcessId: 1,
						CommandLine: "bun run C:\\wa-pi-ghost2\\runtime\\kernel.js",
					},
					// 兄弟目录进程的子孙 → 不杀
					{
						ProcessId: 8001,
						ParentProcessId: 8000,
						CommandLine: "node server.js",
					},
				]),
				status: 0,
			};
		}
		return { stdout: "", status: 0 };
	}) as any;
	try {
		const pids = await killPortOccupants(59781, fakeSpawn, () => {});
		expect(pids).toEqual([30000, 9000]);
		for (const safe of ["8000", "8001"]) {
			expect(
				calls.some((c) => c.cmd === "taskkill" && c.args.includes(safe)),
			).toBe(false);
		}
	} finally {
		if (savedDir === undefined) delete process.env.WA_PI_DIR;
		else process.env.WA_PI_DIR = savedDir;
		await new Promise<void>((r) => s.close(() => r()));
	}
});

// 数据目录默认值必须与 kernel 侧一致（~/.pi/agent）。迁移前 main.cjs/port.cjs 硬编码
// ~/.wa-pi，与 kernel 的 ~/.pi/agent 分裂——日志/runtime 写旧目录、内核读新目录。
test("resolveWaPiDir: 默认 ~/.pi/agent（与 kernel WA_PI_DIR 一致），env 可覆盖", () => {
	const prev = process.env.WA_PI_DIR;
	try {
		delete process.env.WA_PI_DIR;
		expect(resolveWaPiDir()).toContain(path.join(".pi", "agent"));
		expect(resolveWaPiDir()).not.toContain(".wa-pi");
		process.env.WA_PI_DIR = "/custom/dir";
		expect(resolveWaPiDir()).toBe("/custom/dir");
	} finally {
		if (prev === undefined) delete process.env.WA_PI_DIR;
		else process.env.WA_PI_DIR = prev;
	}
});

// kernel 编译产物全链路集成测试（Layer 3，固化 2026-08-21 POC）。
// 流程：bun --compile 编译 → BUN_BE_BUN=1 装磁盘依赖 → 净化 PATH spawn 产物
// （强制 resolvePiRuntime 回退 process.execPath=编译产物，复现打包环境）→
// 探活端口 → REST+SSE agent:prompt 到「未选择模型」终点（kernel 已去 WS 化：
// 无 WebSocket 端点，error 帧经 SSE 总线 /api/events 广播），断言无 Cannot find module / ENOENT。
// 同时是运行时依赖审计：probe 报 Cannot find module <pkg> → 把 <pkg> 补进
// build-kernel-sidecar.ts 的 RUNTIME_DEPENDENCIES 重跑（原生包另补 compile-binary.ts
// 的 EXTERNAL_PACKAGES）。
// 运行：bun run scripts/kernel-compile-it.ts（耗时数分钟：编译 ~1-2min + install；不进 bun test）
import { spawn, spawnSync, type Subprocess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	compileKernelBinary,
	kernelBinaryName,
} from "../packages/kernel/scripts/compile-binary";
import kernelPkg from "../packages/kernel/package.json" with { type: "json" };

const PORT = 9871; // 避开开发机 9778
// 与 build-kernel-sidecar.ts 的运行时依赖保持一致（审计调整时两边同步）
// 版本统一从 packages/kernel/package.json 读取（单一来源）：升级依赖时无需手动同步硬编码版本串
const RUNTIME_DEPENDENCIES: Record<string, string> = {
	"@earendil-works/pi-coding-agent":
		kernelPkg.dependencies["@earendil-works/pi-coding-agent"],
	"@napi-rs/keyring": kernelPkg.dependencies["@napi-rs/keyring"],
	"pi-web-access": kernelPkg.dependencies["pi-web-access"],
	"pi-mcp-adapter": kernelPkg.dependencies["pi-mcp-adapter"],
};

function fail(msg: string): never {
	// 抛 Error 而非 process.exit：让 main() 的 try/finally 先 taskkill kernel + rmSync(base)，
	// 再由 main().catch 兜底打印并 exit(1)。避免失败路径泄漏子进程/临时目录。
	throw new Error(`[it] ❌ ${msg}`);
}

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve) => {
		const tryOnce = () => {
			fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })
				.then(() => resolve(true))
				.catch(() => {
					if (Date.now() > deadline) resolve(false);
					else setTimeout(tryOnce, 500);
				});
		};
		tryOnce();
	});
}

/** 净化 PATH：剔除含 bun 的条目，强制 resolvePiRuntime 回退 process.execPath（复现打包环境） */
function sanitizedPath(): string {
	const sep = process.platform === "win32" ? ";" : ":";
	return (process.env.PATH || "")
		.split(sep)
		.filter((p) => !p.toLowerCase().includes("bun"))
		.join(sep);
}

/** SSE 总线 /api/events 帧（data: <JSON>\n\n）上等「未选择模型」error，或捕获模块解析错误 */
function sseProbe(
	port: number,
	onFrame: (blob: string) => void,
	onClose: (reason: string) => void,
): void {
	fetch(`http://127.0.0.1:${port}/api/events`)
		.then(async (res) => {
			const reader = res.body!.getReader();
			const dec = new TextDecoder();
			let buf = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let idx: number;
				while ((idx = buf.indexOf("\n\n")) >= 0) {
					const frame = buf.slice(0, idx);
					buf = buf.slice(idx + 2);
					for (const line of frame.split("\n")) {
						if (!line.startsWith("data: ")) continue;
						onFrame(line.slice(6));
					}
				}
			}
			onClose("SSE_CLOSED");
		})
		.catch(() => onClose("SSE_ERROR"));
}

async function main() {
	const base = mkdtempSync(join(tmpdir(), "kernel-compile-it-"));
	const runtimeDir = join(base, "runtime");
	const dataDir = join(base, "data");
	let kernel: Subprocess | null = null;
	try {
		// 1. 编译
		const bin = join(runtimeDir, kernelBinaryName());
		compileKernelBinary(bin);

		// 2. BUN_BE_BUN=1 装磁盘依赖（编译产物充当 bun CLI）
		writeFileSync(
			join(runtimeDir, "package.json"),
			JSON.stringify(
				{
					name: "wa-pi-kernel-sidecar",
					private: true,
					dependencies: RUNTIME_DEPENDENCIES,
				},
				null,
				2,
			),
		);
		console.log("[it] BUN_BE_BUN=1 install ...");
		const inst = spawnSync(
			bin,
			["install", "--production", "--ignore-scripts", "--cwd", runtimeDir],
			{
				env: { ...process.env, BUN_BE_BUN: "1" },
				stdio: "inherit",
			},
		);
		if (inst.status !== 0) fail(`install 退出码 ${inst.status}`);

		// 3. 净化 PATH spawn 产物（WA_PI_DIR 隔离数据目录）
		console.log(`[it] spawn 编译产物 @${PORT} ...`);
		kernel = spawn(bin, [], {
			cwd: runtimeDir,
			env: {
				...process.env,
				PATH: sanitizedPath(),
				WA_PI_WS_PORT: String(PORT),
				WA_PI_DIR: dataDir,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stderrTail: string[] = [];
		kernel.stdout!.on("data", (d) =>
			console.log(`[kernel] ${d.toString().trim()}`),
		);
		kernel.stderr!.on("data", (d) => {
			const t = d.toString().trim();
			console.error(`[kernel:err] ${t}`);
			stderrTail.push(t);
		});

		// 4. 探活
		const ready = await waitForPort(PORT, 60_000);
		if (!ready) fail(`kernel 60s 未就绪 @${PORT}`);

		// 5. REST+SSE probe：GET /api/projects 取项目 → POST agent:prompt（不传 model，
		//    prompt() 抛「未选择模型」）→ SSE 广播 error 帧断言到「未选择模型」终点。
		console.log("[it] REST+SSE probe: agent:prompt ...");
		const projectsRes = await fetch(`http://127.0.0.1:${PORT}/api/projects`);
		const projectsBody = await projectsRes.json().catch(() => null);
		const pid = (projectsBody as any)?.projects?.[0]?.id;
		if (!pid)
			fail(
				`projects:list 无项目可发 prompt: ${JSON.stringify(projectsBody).slice(0, 200)}`,
			);

		const result = await new Promise<string>((resolve) => {
			const timer = setTimeout(() => resolve("TIMEOUT"), 90_000);
			let done = false;
			const finish = (v: string) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve(v);
			};
			const check = (blob: string) => {
				if (blob.includes("未选择模型")) finish("OK");
				else if (/Cannot find module|ENOENT.*node_modules/.test(blob))
					finish(`MODULE_ERROR: ${blob.slice(0, 300)}`);
			};
			// SSE 先于 POST 打开：ensureStarted 失败 / prompt 未选模型都经 broadcast 上 SSE
			sseProbe(PORT, check, (reason) => finish(reason));
			fetch(
				`http://127.0.0.1:${PORT}/api/agents/${encodeURIComponent(pid)}/compile-it-probe/prompt`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ agentName: "dev", text: "say hi in one word" }),
				},
			).catch(() => {});
		});

		// 6. 断言
		const stderrBlob = stderrTail.join("\n");
		if (/Cannot find module|ENOENT.*node_modules/.test(stderrBlob)) {
			fail(`stderr 出现模块解析错误：\n${stderrBlob.slice(-800)}`);
		}
		if (result !== "OK") fail(`probe 未到「未选择模型」终点: ${result}`);
		console.log(
			"[it] ✅ 编译产物全链路通过（compile → install → spawn → agent:prompt → 未选择模型）",
		);
	} finally {
		if (kernel) {
			if (process.platform === "win32")
				spawnSync("taskkill", ["/PID", String(kernel.pid), "/T", "/F"], {
					stdio: "ignore",
				});
			else kernel.kill("SIGTERM");
		}
		rmSync(base, { recursive: true, force: true });
	}
}

main().catch((e) => {
	// catch 内不再调 fail（fail 已改 throw，catch 内 throw 会变 unhandled rejection）：
	// 直接打印（fail 抛出的消息自带 [it] ❌ 前缀）并保持 exit(1)。
	console.error(e?.message ?? String(e));
	process.exit(1);
});

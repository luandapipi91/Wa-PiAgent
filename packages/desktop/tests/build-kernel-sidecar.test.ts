// build-kernel-sidecar 纯函数测试：运行时依赖清单（精简 external 清单，无 patchedDependencies）
// + kernel 校验清单（壳/核一致性自检的真相源）。
// 不真的跑编译/下载（那是 Task 6 集成测试与 Task 8 打包冒烟的职责）。
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildRuntimeManifest,
	buildKernelManifest,
} from "../scripts/build-kernel-sidecar";
import kernelPkg from "../../kernel/package.json" with { type: "json" };

// 应用版本单一真相源：kernel 侧 version 必须跟随它（壳/核一致性自检依赖二者可比对）
const DESKTOP_PKG = JSON.parse(
	readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
) as { version: string };

test("buildRuntimeManifest: 精简清单——仅磁盘必需依赖，无 patchedDependencies", () => {
	const m = buildRuntimeManifest(DESKTOP_PKG.version) as any;
	expect(m.name).toBe("wa-pi-kernel-sidecar");
	expect(m.private).toBe(true);
	// patch 编译期已生效（内联进 exe），磁盘副本供 -e 扩展加载，无需 patch
	expect(m.patchedDependencies).toBeUndefined();
	// pi-coding-agent：pi RPC 子进程入口 cli.js 必须在磁盘（子进程读不到父进程虚拟 FS）
	expect(m.dependencies["@earendil-works/pi-coding-agent"]).toBeString();
	// keyring：原生 .node 无法内联，external 从磁盘加载
	expect(m.dependencies["@napi-rs/keyring"]).toBeString();
	// 内置 npm 扩展已清空：pi-mcp-adapter / pi-web-access 均已移除，不得再回到清单里
	// （web 工具由自研 web-access 扩展提供，源码随内核 bundle 走 --asset，无需磁盘依赖）
	expect(m.dependencies["pi-mcp-adapter"]).toBeUndefined();
	expect(m.dependencies["pi-web-access"]).toBeUndefined();
	expect(m.dependencies["@earendil-works/pi-coding-agent"]).toBe(
		kernelPkg.dependencies["@earendil-works/pi-coding-agent"],
	);
	expect(m.dependencies["@napi-rs/keyring"]).toBe(
		kernelPkg.dependencies["@napi-rs/keyring"],
	);
	// 其余内联进 exe 的包不再出现（jiti 在虚拟 FS 内解析）
	expect(m.dependencies["@amaster.ai/pi-memory"]).toBeUndefined();
});

test("buildRuntimeManifest 含 agent-browser（首启依赖安装会装平台原生二进制）", () => {
	const m = buildRuntimeManifest(DESKTOP_PKG.version) as any;
	// 浏览器能力改由内置 agent-browser MCP 提供：平台二进制必须随 runtime 安装
	expect(m.dependencies["agent-browser"]).toBeString();
	expect(m.dependencies["agent-browser"]).toBe(
		kernelPkg.dependencies["agent-browser"],
	);
});

test("buildRuntimeManifest: version 必须跟随应用版本（拒绝恒定旧值导致壳/核不一致无从发现）", () => {
	// 2026-11-15 事故：kernel package.json version 恒 0.1.5，NSIS 升级漏装新内核后
	// 壳 0.10.3 / 核 0.10.1 静默共存数天无人察觉。version 是一致性自检的比对源，
	// 必须与 desktop package.json（发版唯一升版点）同源。
	const m = buildRuntimeManifest(DESKTOP_PKG.version) as any;
	expect(m.version).toBe(DESKTOP_PKG.version);
	expect(m.version).not.toBe("0.1.5");
});

test("buildKernelManifest: 校验清单字段完整（version/exe.name/exe.size/exe.sha256）", () => {
	const m = buildKernelManifest({
		version: "0.10.4",
		exeName: "WaPiKernel.exe",
		exeSize: 133196288,
		exeSha256: "abc123",
	});
	expect(m.version).toBe("0.10.4");
	expect(m.exe.name).toBe("WaPiKernel.exe");
	expect(m.exe.size).toBe(133196288);
	expect(m.exe.sha256).toBe("abc123");
});

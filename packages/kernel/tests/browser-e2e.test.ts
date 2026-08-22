// browser-e2e.test.ts —— Layer 4 E2E 测试（spec §6 第 4 层）。
//
// 1. 真实 bridge 链路 E2E：加载真实扩展源码（wa-pi-bridge.extension.ts），browser_*
//    工具 execute 经真实 HTTP POST /bridge/tool → ws-server → bridge-registry →
//    真实 AgentManager.handleTool（ensureStarted 会话注册的 bridgeCtx）→
//    生产默认 new BrowserManager()（不注入 NOOP）→ 真实 Bun.WebView，覆盖
//    browser_navigate → browser_evaluate → browser_screenshot(path) → browser_close
//    全流程。这等价于「agent:prompt 引导 LLM 调用工具」的结果（LLM 决策在测试中
//    不可靠，仓库先例 bridge.test.ts 全链路测试同此模式）。
//    引擎不可用（非 macOS 且无 Chrome/Edge，或 BUN_CHROME_PATH 无效）时跳过并
//    console.log 标注——不算失败（spec §6 明确）。
// 2. 白名单验证：agent tools 显式白名单不含 browser_* 时，pi spawn 的 --tools 不含
//    browser_*（read/bash 保留）；反向白名单含 browser_navigate 时 --tools 含之。
//    不测真实浏览器：注入 NOOP_BROWSER_MANAGER，只断言 spawn 参数。
//
// 清理：截图按返回的 path 精确删除；server.stop + disposeAll 关 WebView；扩展临时
// 文件用 mkdtemp 独立目录、import 后立即删除；测试目录 / 项目 store / 系统提示词
// 临时文件 afterEach 统一清理（含失败路径）。
import { test, expect, mock, afterEach } from "bun:test";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentManager } from "../src/agent-manager";
import { ProjectStore } from "../src/project-store";
import { ProviderStore } from "../src/provider-store";
import { SkillManager } from "../src/skill-manager";
import { ExtensionManager } from "../src/extension-manager";
import { WSServer } from "../src/ws-server";
import {
	getBridgeToken,
	getBridgeSession,
	unregisterBridgeSession,
} from "../src/bridge-registry";
import { generateBridgeExtension } from "../src/bridge-extension";
import {
	FakeSessionClient,
	fakeClientFactory,
} from "./fixtures/fake-session-client";
import { NOOP_BROWSER_MANAGER } from "./helpers/fake-browser-manager";
import { WA_PI_DIR } from "@wa-pi/shared";

const BROWSER_TOOLS = [
	"browser_navigate",
	"browser_evaluate",
	"browser_screenshot",
	"browser_close",
];

// 本地静态页：data: URL（避免端口冲突）
const TEST_HTML = `<h1>e2e</h1>`;
const TEST_URL = "data:text/html," + encodeURIComponent(TEST_HTML);

/** 探测真实引擎可用性：构造 + 导航 + evaluate + 关闭，任何一步失败即不可用 */
async function probeEngineAvailable(): Promise<boolean> {
	try {
		const view = new Bun.WebView({ width: 160, height: 120, backend: "chrome" });
		try {
			await view.navigate(TEST_URL);
			const h1 = await view.evaluate(
				`document.querySelector("h1")?.textContent`,
			);
			return h1 === "e2e";
		} finally {
			// 构造成功后才进入此 try：navigate/evaluate 抛错也关闭 WebView，
			// 避免底层浏览器进程残留；构造本身抛错时 view 未赋值，无泄漏
			view.close();
		}
	} catch (err) {
		console.log(
			`[Layer 4] 真实引擎不可用，跳过真实 bridge 链路测试：${err instanceof Error ? err.message : String(err)}（非 macOS 平台需要已安装 Chrome/Chromium/Edge/Brave，或设置 BUN_CHROME_PATH）`,
		);
		return false;
	}
}

// 顶层 await 探测（Bun 原生支持），模块加载期确定引擎可用性
const engineAvailable = await probeEngineAvailable();
// 引擎不可用时真实链路测试直接跳过（skipIf 的别名写法）；白名单测试不依赖引擎，始终运行
const testReal = engineAvailable ? test : test.skip;

/** 把 bridge 扩展源码 + tool-schemas/file-snapshot 依赖写到独立 mkdtemp 目录并动态
 *  import，返回捕获到的全部 registerTool 定义。用独立目录而非固定 tests/ 文件名，
 *  避免与 bridge.test.ts 的 tests/tool-schemas.ts 固定路径并发竞争。 */
async function loadBridgeTools(env?: Record<string, string>): Promise<any[]> {
	for (const [k, v] of Object.entries(env ?? {})) process.env[k] = v;
	const dir = mkdtempSync(join(import.meta.dir, ".tmp-bridge-e2e-"));
	try {
		// 静态 bridge 扩展 import "./tool-schemas.ts" 与 "./file-snapshot.ts"，复制到同目录
		copyFileSync(
			join(import.meta.dir, "..", "..", "shared", "src", "tool-schemas.ts"),
			join(dir, "tool-schemas.ts"),
		);
		copyFileSync(
			join(import.meta.dir, "..", "src", "file-snapshot.ts"),
			join(dir, "file-snapshot.ts"),
		);
		const file = join(dir, "wa-pi-bridge-e2e.ts");
		writeFileSync(file, generateBridgeExtension(), "utf8");
		const mod = await import(pathToFileURL(file).href);
		const tools: any[] = [];
		mod.default({
			registerTool: (def: any) => tools.push(def),
			// bridge 扩展注册的内部命令（__!wa_pi_reload 热重载）——测试桩不收集命令
			registerCommand: () => {},
			on: () => {},
		});
		return tools;
	} finally {
		// import 已完成、模块图在内存缓存，磁盘文件不再需要，立即删除
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---- 模块级清理（含失败路径） ----
const managers: AgentManager[] = [];
const tmpDirs: string[] = [];
const syspromptSessionIds: string[] = [];
// 测试产生的截图文件（从 screenshot 返回的 path 精确记录，绝不多删）
let createdScreenshots: string[] = [];

function syspromptPath(sessionId: string): string {
	return join(WA_PI_DIR, "tmp", "sysprompts", `${sessionId}.md`);
}

afterEach(async () => {
	for (const f of createdScreenshots.splice(0)) {
		try {
			rmSync(f, { force: true });
		} catch {
			// 尽力清理截图，失败静默
		}
	}
	for (const am of managers.splice(0)) await am.disposeAll().catch(() => {});
	for (const d of tmpDirs.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// 尽力清理临时目录，失败静默
		}
	}
	for (const id of syspromptSessionIds.splice(0)) {
		try {
			rmSync(syspromptPath(id), { force: true });
		} catch {
			// 尽力清理系统提示词临时文件，失败静默
		}
	}
	delete process.env.WA_PI_BRIDGE_URL;
	delete process.env.WA_PI_BRIDGE_TOKEN;
	delete process.env.WA_PI_SESSION_ID;
});

/** 取参数数组中某 flag 的全部值（如 --tools a --tools b → [a, b]） */
function argValues(args: string[], flag: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === flag && i + 1 < args.length) out.push(args[i + 1]);
	}
	return out;
}

// ─── 测试 1：真实 bridge 链路 E2E ──────────────────────────────────────────────

testReal(
	"真实 bridge 链路：browser_navigate → evaluate → screenshot(path) → close 经扩展 execute → 真实 HTTP → 真实 AgentManager/BrowserManager/WebView",
	async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "browser-e2e-"));
		tmpDirs.push(tmpDir);
		const dataDir = join(tmpDir, "ws-data");
		const projectStore = new ProjectStore(join(tmpDir, "project.json"));
		const configStore = {
			getAgent: mock(async () => ({ displayName: "dev", tools: [] })),
		} as any;

		// 真实 AgentManager：不注入 NOOP_BROWSER_MANAGER → 生产默认 new BrowserManager()
		//（mkdirSync 截图目录 + new Bun.WebView({ backend: "chrome" })，真实浏览器后端）。
		// createClientFn 注入 fake 只是避免 spawn 真实 pi 子进程（pi 子进程与浏览器无关）
		const fakes: FakeSessionClient[] = [];
		const am = new AgentManager({
			projectStore,
			configStore,
			onEvent: () => {},
			createClientFn: fakeClientFactory(fakes),
		});
		managers.push(am);

		const server = new WSServer({
			configStore,
			projectStore,
			providerStore: new ProviderStore(join(tmpDir, "providers.json")),
			skillManager: new SkillManager(join(tmpDir, "skills")),
			extensionManager: new ExtensionManager(dataDir),
			memoryStore: null as any,
			mcpStore: null as any,
			dataDir,
			agentManager: am,
			channelManager: null,
			port: 0,
		});

		let sessionId = "";
		try {
			await server.start();

			const project = await projectStore.createProject({
				name: "测试",
				cwd: join(tmpDir, "repo"),
			});
			const session = await projectStore.createSession({
				projectId: project.id,
				primaryAgent: "dev",
				title: "测试",
			});
			sessionId = session.id;
			syspromptSessionIds.push(session.id);

			// ensureStarted → _createSession 已用真实 AgentManager 的 handleTool
			//（含 browser_* 分派到 browserManager）注册 bridge 会话
			await am.ensureStarted(project.id, "dev", session.id);
			const ctx = getBridgeSession(session.id);
			expect(ctx).toBeDefined();

			// 加载真实扩展源码并配 env：browser_* execute 经真实 HTTP 到 kernel
			const tools = await loadBridgeTools({
				WA_PI_BRIDGE_URL: `http://127.0.0.1:${server.actualPort}`,
				WA_PI_BRIDGE_TOKEN: getBridgeToken(),
				WA_PI_SESSION_ID: session.id,
			});
			const find = (name: string) => {
				const t = tools.find((x: any) => x.name === name);
				expect(t, `扩展应注册 ${name}`).toBeDefined();
				return t;
			};
			const assertNoEngineError = (label: string, text: string) => {
				expect(text, `${label} 返回文本`).not.toContain("Cannot find module");
				expect(text, `${label} 返回文本`).not.toContain("engine_unavailable");
				expect(text, `${label} 返回文本`).not.toContain("引擎不可用");
			};

			// 1) browser_navigate：data: URL 本地静态页
			const nav = await find("browser_navigate").execute(
				"tc-nav",
				{ url: TEST_URL },
				undefined,
			);
			expect(nav.details?.error).toBeUndefined();
			const navText = nav.content[0].text;
			const navParsed = JSON.parse(navText) as {
				ok: boolean;
				url: string;
				title: string;
				loading: boolean;
			};
			expect(navParsed.ok).toBe(true);
			expect(navParsed.url).toContain("data:text/html");
			expect(navParsed.loading).toBe(false);
			assertNoEngineError("browser_navigate", navText);

			// 2) browser_evaluate：eval 读 h1 文本
			const evalRes = await find("browser_evaluate").execute(
				"tc-eval",
				{
					action: "eval",
					script: `document.querySelector("h1")?.textContent`,
				},
				undefined,
			);
			expect(evalRes.details?.error).toBeUndefined();
			const evalText = evalRes.content[0].text;
			expect(evalText).toContain('"e2e"');
			assertNoEngineError("browser_evaluate", evalText);

			// 3) browser_screenshot：path 模式落盘到 ${WA_PI_DIR}/tmp/browser-screenshots
			const shot = await find("browser_screenshot").execute(
				"tc-shot",
				{ format: "png" },
				undefined,
			);
			expect(shot.details?.error).toBeUndefined();
			const shotText = shot.content[0].text;
			const shotParsed = JSON.parse(shotText) as {
				ok: boolean;
				path: string;
				sizeBytes: number;
			};
			// 解析出 path 立即登记删除（后续断言失败也不泄漏落盘文件）
			createdScreenshots.push(shotParsed.path);
			expect(shotParsed.ok).toBe(true);
			expect(typeof shotParsed.path).toBe("string");
			expect(shotParsed.sizeBytes).toBeGreaterThan(0);
			// 断言截图目录前缀（BrowserManager 默认 screenshotDir）
			expect(shotParsed.path).toStartWith(
				join(WA_PI_DIR, "tmp", "browser-screenshots"),
			);
			expect(existsSync(shotParsed.path)).toBe(true);
			expect(statSync(shotParsed.path).size).toBe(shotParsed.sizeBytes);
			expect(readFileSync(shotParsed.path).length).toBeGreaterThan(0);
			assertNoEngineError("browser_screenshot", shotText);

			// 4) browser_close：销毁视图
			const closeRes = await find("browser_close").execute(
				"tc-close",
				{},
				undefined,
			);
			expect(closeRes.details?.error).toBeUndefined();
			const closeText = closeRes.content[0].text;
			const closeParsed = JSON.parse(closeText) as { ok: boolean };
			expect(closeParsed.ok).toBe(true);
			assertNoEngineError("browser_close", closeText);
		} finally {
			// 清理：停 server（内部 disposeAll → closeSession/WebView.close 关真实视图），
			// 注销 bridge 会话；截图文件 afterEach 按精确 path 删除
			if (server.actualPort > 0) await server.stop().catch(() => {});
			if (sessionId) unregisterBridgeSession(sessionId);
		}
	},
);

// ─── 测试 2：白名单验证（--tools 参数）────────────────────────────────────────

/** 造测试项目 + 会话 + fake client 的 AgentManager（NOOP_BROWSER_MANAGER：不测真实浏览器） */
async function startWhitelistedAgent(tools: string[]) {
	const tmpDir = mkdtempSync(join(tmpdir(), "browser-e2e-wl-"));
	tmpDirs.push(tmpDir);
	const projectStore = new ProjectStore(join(tmpDir, "project.json"));
	const project = await projectStore.createProject({
		name: "测试",
		cwd: join(tmpDir, "repo"),
	});
	const session = await projectStore.createSession({
		projectId: project.id,
		primaryAgent: "dev",
		title: "测试",
	});
	syspromptSessionIds.push(session.id);
	const configStore = {
		getAgent: mock(async () => ({ displayName: "dev", tools })),
	} as any;
	const fakes: FakeSessionClient[] = [];
	const am = new AgentManager({
		projectStore,
		configStore,
		onEvent: () => {},
		createClientFn: fakeClientFactory(fakes),
		browserManager: NOOP_BROWSER_MANAGER,
	});
	managers.push(am);
	await am.ensureStarted(project.id, "dev", session.id);
	return { fakes };
}

test("白名单：agent tools 显式配置 read/bash（不含 browser_*）时 --tools 不含 browser_*", async () => {
	const { fakes } = await startWhitelistedAgent(["read", "bash"]);

	const tools = argValues(fakes[0].opts.args ?? [], "--tools").flatMap((v) =>
		v.split(","),
	);
	// 白名单解析结果保留 read/bash
	expect(tools).toContain("read");
	expect(tools).toContain("bash");
	// 4 个 browser_* 均不得出现在 --tools 中（未勾选即不可见）
	for (const t of BROWSER_TOOLS) {
		expect(tools, `--tools 不应含 ${t}`).not.toContain(t);
	}
});

test("反向：白名单含 browser_navigate 时 --tools 含 browser_navigate（勾了才有）", async () => {
	const { fakes } = await startWhitelistedAgent(["browser_navigate"]);

	const tools = argValues(fakes[0].opts.args ?? [], "--tools").flatMap((v) =>
		v.split(","),
	);
	expect(tools).toContain("browser_navigate");
});

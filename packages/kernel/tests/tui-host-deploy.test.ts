// tui-host-deploy.test.ts —— 宿主扩展部署到 GENERATED_DIR 的落地测试
//
// 部署形态：入口 wa-pi-tui-host.extension.ts 落为 GENERATED_DIR/wa-pi-tui-host.ts，
// 其相对 import 的 tui-host/*.ts 5 个模块保持 tui-host/ 子目录结构一并落盘，
// 这样入口的相对路径在 GENERATED_DIR 下仍可解析（无需改写 import）。
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	deployTuiHostExtension,
	TUI_HOST_EXTENSION_FILES,
	TUI_HOST_EXTENSION_NAME,
} from "../src/tui-host-deploy.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wa-pi-tui-host-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("deployTuiHostExtension", () => {
	test("复制入口与 tui-host 目录到目标目录", async () => {
		const path = await deployTuiHostExtension(dir);
		expect(path).toBe(join(dir, `${TUI_HOST_EXTENSION_NAME}.ts`));
		expect(existsSync(path)).toBe(true);
		expect(existsSync(join(dir, "tui-host", "terminal.ts"))).toBe(true);
		expect(existsSync(join(dir, "tui-host", "panel.ts"))).toBe(true);
	});

	test("入口的相对 import 指向 ./tui-host/（部署后仍可解析）", async () => {
		const path = await deployTuiHostExtension(dir);
		const src = readFileSync(path, "utf-8");
		expect(src).toContain('from "./tui-host/');
	});

	test("重复部署幂等（覆盖写入，不抛错）", async () => {
		await deployTuiHostExtension(dir);
		await expect(deployTuiHostExtension(dir)).resolves.toContain(
			TUI_HOST_EXTENSION_NAME,
		);
	});
});

// 清单漂移护栏：清单是手写的（bun --compile 下必须逐文件嵌入，无法整目录 cp），
// 新增 tui-host 模块却忘了加进清单时，部署目录缺文件 → pi 加载扩展抛
// "Cannot find module './xxx.ts'" → pi rpc 进程退出 → **所有**新会话 agent 启动失败。
// 所以不能手写名单互相印证，直接以 src/tui-host/ 实际文件为准兜底。
test("部署清单覆盖 src/tui-host/ 下全部模块（新增模块忘加清单即红）", async () => {
	const srcDir = join(import.meta.dir, "..", "src", "tui-host");
	const modules = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
	expect(modules.length).toBeGreaterThan(0);
	const listed = new Set(TUI_HOST_EXTENSION_FILES.map(([source]) => source));
	for (const mod of modules) {
		expect(listed).toContain(`tui-host/${mod}`);
	}
	// 只断言清单条目不够：真部署一次，确认每个模块都落到了目标目录
	await deployTuiHostExtension(dir);
	for (const mod of modules) {
		expect(existsSync(join(dir, "tui-host", mod))).toBe(true);
	}
});

// 部署的最终目的：pi 经 -e 加载 GENERATED_DIR/wa-pi-tui-host.ts 能跑起来。
// 仅断言文件存在/文本含相对 import 不能证明这一点（import 写错也只会在 pi 里炸），
// 所以真的动态 import 一次部署产物，验证入口的相对 import 在目标布局下可解析。
// 目标目录放在 tests/ 下（而非 os.tmpdir()）：裸包 @earendil-works/pi-* 要靠上溯
// node_modules 解析，/tmp 下找不到。
test("部署后的入口可被动态 import 并注册 session 事件（相对 import 可解析）", async () => {
	const deployDir = join(import.meta.dir, ".tmp-tui-host-deploy-load");
	const envKeys = [
		"WA_PI_BRIDGE_URL",
		"WA_PI_BRIDGE_TOKEN",
		"WA_PI_SESSION_ID",
	] as const;
	const savedEnv = envKeys.map((key) => [key, process.env[key]] as const);
	try {
		rmSync(deployDir, { recursive: true, force: true });
		mkdirSync(deployDir, { recursive: true });
		// 有宿主环境变量才注册事件（无则视为子代理环境直接 return）
		for (const key of envKeys) process.env[key] = "http://test";

		const entry = await deployTuiHostExtension(deployDir);
		const mod = await import(pathToFileURL(entry).href);
		const events: string[] = [];
		mod.default({
			registerTool: () => {},
			registerCommand: () => {},
			on: (event: string) => {
				events.push(event);
			},
		});
		expect(events).toEqual(["session_start", "session_shutdown"]);
	} finally {
		rmSync(deployDir, { recursive: true, force: true });
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

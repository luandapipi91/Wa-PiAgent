import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
// WA_PI_DIR 由 bunfig preload 隔离；GENERATED_DIR 随之为临时目录，无需手工清理
import { ensureWebAccessExtension, WEB_ACCESS_EXTENSION_PATH } from "../src/web-access-deploy";

test("deploy 产出可加载的单文件 bundle（依赖全内联）", async () => {
	const out = await ensureWebAccessExtension();
	expect(out).toBe(WEB_ACCESS_EXTENSION_PATH);
	expect(existsSync(out)).toBe(true);
	const content = readFileSync(out, "utf8");
	// 裸 import 不得残留（typebox 已内联）
	expect(content).not.toContain('from "typebox"');
	// 内联产物必然大于源文件
	const src = readFileSync(new URL("../src/web-access.extension.ts", import.meta.url), "utf8");
	expect(content.length).toBeGreaterThan(src.length);
	// 动态加载产物：默认导出函数可注册两个工具（行为等价）
	const mod = await import(`${pathToFileURL(out).href}?t=${Date.now()}`);
	const registered: Record<string, any> = {};
	mod.default({ registerTool: (def: any) => { registered[def.name] = def; } });
	expect(Object.keys(registered).sort()).toEqual(["wa_fetch_content", "wa_web_search"]);
});

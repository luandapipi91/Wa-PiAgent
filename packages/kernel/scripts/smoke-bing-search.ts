// 真实网络冒烟：Bing 免费链路（加载扩展 → wa_web_search 搜索 → wa_fetch_content 本地抓取）。
// 用法：cd packages/kernel && bun run scripts/smoke-bing-search.ts ["查询词"]
// 仅本机手动跑（不打入测试套件——依赖真实外网）。
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "smoke-bing-"));
process.env.WA_PI_DIR = dir;
writeFileSync(
	join(dir, "settings.json"),
	JSON.stringify({ webSearch: { provider: "bing", searchEnabled: true, fetchEnabled: true } }),
);

const { default: webAccessExtension } = await import("../src/web-access.extension");
const registered: Record<string, any> = {};
webAccessExtension({
	registerTool: (def: any) => {
		registered[def.name] = def;
	},
} as any);

let failed = false;
const text = (r: any): string => r.content.map((c: any) => c.text).join("\n");

// 1) 搜索
const query = process.argv[2] ?? "deepseek harness";
const s = await registered["wa_web_search"].execute("smoke-s", { query, count: 5 }, undefined);
console.log(text(s));
const m = text(s).match(/共 (\d+) 条结果/);
if (!m || Number(m[1]) < 3) {
	console.error("SMOKE FAIL: Bing 搜索结果不足 3 条");
	failed = true;
}

// 2) 本地抓取（readability 链路）
const f = await registered["wa_fetch_content"].execute("smoke-f", { url: "https://example.com/" }, undefined);
console.log(text(f));
if (!text(f).includes("Example Domain")) {
	console.error("SMOKE FAIL: 本地抓取未拿到 example.com 内容");
	failed = true;
}

rmSync(dir, { recursive: true, force: true });
if (failed) process.exit(1);
console.log("SMOKE PASS");

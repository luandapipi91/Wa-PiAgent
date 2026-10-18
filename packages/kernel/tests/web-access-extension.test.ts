import { test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import webAccessExtension from "../src/web-access.extension";

// web-access 扩展（DeepSeek 搜索/抓取）单元测试：
// mock 全局 fetch，不发起真实网络请求；WA_PI_DIR 指向临时目录隔离 settings.json。
// 工具名带 wa_ 前缀（wa_web_search / wa_fetch_content）：避免与插件注册的
// web_search/fetch_content 同名冲突导致插件装不上（2026-10-18）。

let dir: string;
const registered: Record<string, any> = {};

function writeSettings(webSearch: unknown) {
	writeFileSync(
		join(dir, "settings.json"),
		JSON.stringify({ webSearch }),
		"utf8",
	);
}

/** 设置下一次（及后续）fetch 的响应 */
let fetchQueue: Array<{ status: number; body: unknown }> = [];
let fetchCalls: Array<{ url: string; init: any }> = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "web-access-ext-"));
	mkdirSync(dir, { recursive: true });
	process.env.WA_PI_DIR = dir;
	delete process.env.PI_CODING_AGENT_DIR;
	for (const k of Object.keys(registered)) delete registered[k];
	webAccessExtension({
		registerTool: (def: any) => {
			registered[def.name] = def;
		},
	} as any);
	fetchQueue = [];
	fetchCalls = [];
	(globalThis as any).fetch = (async (url: string, init: any) => {
		fetchCalls.push({ url, init });
		const next = fetchQueue.shift() ?? { status: 500, body: { error: { message: "no mock" } } };
		return new Response(JSON.stringify(next.body), {
			status: next.status,
			headers: { "content-type": "application/json" },
		});
	}) as any;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	rmSync(dir, { recursive: true, force: true });
});

function text(result: any): string {
	return result.content.map((c: any) => c.text).join("\n");
}

const SEARCH_200 = {
	status: 200,
	body: {
		results: [
			{
				rerank_score: 2.4,
				title: "DeepSeek V4 发布",
				url: "https://example.com/v4",
				snippet: "短摘要",
				summary: "长摘要：DeepSeek V4 已上线。",
				content: "正文内容",
				site_name: "Example",
				site_icon: null,
				date: "2026-06-01T00:00:00+00:00",
				authority: 3,
			},
		],
	},
};

// ———— 注册 ————

test("注册 wa_web_search 与 wa_fetch_content 两个工具", () => {
	expect(registered["wa_web_search"]).toBeDefined();
	expect(registered["wa_fetch_content"]).toBeDefined();
	// 旧名不得再注册（避免与插件注册的 web_search/fetch_content 冲突）
	expect(registered["web_search"]).toBeUndefined();
	expect(registered["fetch_content"]).toBeUndefined();
});

// ———— 加载期开关：关 = 不注册（模型直接看不到，而非看到但调用失败） ————

test("开关全关：扩展加载时两个工具都不注册", () => {
	writeSettings({ searchEnabled: false, fetchEnabled: false, apiKey: "sk-test" });
	const reg: Record<string, any> = {};
	webAccessExtension({
		registerTool: (def: any) => {
			reg[def.name] = def;
		},
	} as any);
	expect(reg["wa_web_search"]).toBeUndefined();
	expect(reg["wa_fetch_content"]).toBeUndefined();
});

test("只开搜索：仅注册 wa_web_search", () => {
	writeSettings({ searchEnabled: true, fetchEnabled: false, apiKey: "sk-test" });
	const reg: Record<string, any> = {};
	webAccessExtension({
		registerTool: (def: any) => {
			reg[def.name] = def;
		},
	} as any);
	expect(reg["wa_web_search"]).toBeDefined();
	expect(reg["wa_fetch_content"]).toBeUndefined();
});

// ———— wa_web_search ————

test("wa_web_search 正常调用：Bearer key / URL / body 正确，输出含标题与链接", async () => {
	writeSettings({ searchEnabled: true, fetchEnabled: true, apiKey: "sk-test" });
	fetchQueue.push(SEARCH_200);
	const r = await registered["wa_web_search"].execute(
		"t1",
		{ query: "DeepSeek V4" },
		undefined,
	);
	expect(fetchCalls).toHaveLength(1);
	expect(fetchCalls[0].url).toBe("https://api.deepseek.com/v1/tools/search");
	expect(fetchCalls[0].init.headers.Authorization).toBe("Bearer sk-test");
	const body = JSON.parse(fetchCalls[0].init.body);
	expect(body.query).toBe("DeepSeek V4");
	expect(body.count).toBe(10);
	expect(body.need_content).toBe(false);
	const out = text(r);
	expect(out).toContain("DeepSeek V4 发布");
	expect(out).toContain("https://example.com/v4");
	expect(out).toContain("长摘要");
});

test("搜索开关关闭：不发起请求，返回引导开启的文案", async () => {
	writeSettings({ searchEnabled: false, fetchEnabled: true, apiKey: "sk-test" });
	const r = await registered["wa_web_search"].execute(
		"t2",
		{ query: "x" },
		undefined,
	);
	expect(fetchCalls).toHaveLength(0);
	expect(text(r)).toContain("互联网搜索");
	expect(text(r)).toContain("设置");
});

test("未配置 key：返回引导配置文案，不发起请求", async () => {
	writeSettings({ searchEnabled: true, fetchEnabled: true, apiKey: "" });
	const r = await registered["wa_web_search"].execute(
		"t3",
		{ query: "x" },
		undefined,
	);
	expect(fetchCalls).toHaveLength(0);
	expect(text(r)).toContain("API Key");
});

test("settings.json 不存在时按默认配置走（开关开、无 key → 引导文案）", async () => {
	// 不写 settings.json
	const r = await registered["wa_web_search"].execute(
		"t4",
		{ query: "x" },
		undefined,
	);
	expect(fetchCalls).toHaveLength(0);
	expect(text(r)).toContain("API Key");
});

test("429 后重试第二次成功（重试 1 次即恢复）", async () => {
	writeSettings({ searchEnabled: true, fetchEnabled: true, apiKey: "sk-test" });
	fetchQueue.push({ status: 429, body: { error: { message: "rate limited" } } });
	fetchQueue.push(SEARCH_200);
	const r = await registered["wa_web_search"].execute(
		"t5",
		{ query: "q" },
		undefined,
	);
	expect(fetchCalls).toHaveLength(2);
	expect(text(r)).toContain("DeepSeek V4 发布");
}, 20000);

test("401：key 无效文案，不重试", async () => {
	writeSettings({ searchEnabled: true, fetchEnabled: true, apiKey: "sk-bad" });
	fetchQueue.push({ status: 401, body: { error: { message: "auth" } } });
	const r = await registered["wa_web_search"].execute(
		"t6",
		{ query: "q" },
		undefined,
	);
	expect(fetchCalls).toHaveLength(1);
	expect(text(r)).toContain("API Key");
	expect(text(r)).toContain("无效");
});

test("402：余额不足文案", async () => {
	writeSettings({ searchEnabled: true, fetchEnabled: true, apiKey: "sk-test" });
	fetchQueue.push({ status: 402, body: { error: { message: "insufficient" } } });
	const r = await registered["wa_web_search"].execute(
		"t7",
		{ query: "q" },
		undefined,
	);
	expect(text(r)).toContain("余额");
});

test("count 越界裁剪到 1-50；need_content 透传", async () => {
	writeSettings({ searchEnabled: true, fetchEnabled: true, apiKey: "sk-test" });
	fetchQueue.push(SEARCH_200);
	await registered["wa_web_search"].execute(
		"t8",
		{ query: "q", count: 99, need_content: true },
		undefined,
	);
	const body = JSON.parse(fetchCalls[0].init.body);
	expect(body.count).toBe(50);
	expect(body.need_content).toBe(true);
});

test("query 超长（>128 字符）直接拒绝，不发请求", async () => {
	writeSettings({ searchEnabled: true, fetchEnabled: true, apiKey: "sk-test" });
	const r = await registered["wa_web_search"].execute(
		"t9",
		{ query: "a".repeat(129) },
		undefined,
	);
	expect(fetchCalls).toHaveLength(0);
	expect(text(r)).toContain("128");
});

test("搜索无结果：空数组返回可读文案（不计费也不算错误）", async () => {
	writeSettings({ searchEnabled: true, fetchEnabled: true, apiKey: "sk-test" });
	fetchQueue.push({ status: 200, body: { results: [] } });
	const r = await registered["wa_web_search"].execute(
		"t10",
		{ query: "不存在的词" },
		undefined,
	);
	expect(text(r)).toContain("没有找到");
});

// ———— 供应商：bigmodel（智谱） ————

test("bigmodel 搜索：请求构造（URL/search_query/search_engine）+ 响应格式化", async () => {
	writeSettings({
		provider: "bigmodel",
		searchEnabled: true,
		fetchEnabled: true,
		apiKey: "",
		apiKeyBigmodel: "zhu-pu-key",
	} as any);
	fetchQueue.push({
		status: 200,
		body: {
			search_result: [
				{
					title: "智谱搜索结果",
					link: "https://example.cn/a",
					media: "ExampleCN",
					publish_date: "2026-10-15",
					content: "网页内容摘要".repeat(10),
				},
			],
		},
	});
	const r = await registered["wa_web_search"].execute(
		"bm1",
		{ query: "智谱 GLM" },
		undefined,
	);
	expect(fetchCalls[0].url).toBe(
		"https://open.bigmodel.cn/api/paas/v4/web_search",
	);
	expect(fetchCalls[0].init.headers.Authorization).toBe("Bearer zhu-pu-key");
	const body = JSON.parse(fetchCalls[0].init.body);
	expect(body.search_query).toBe("智谱 GLM");
	expect(body.search_engine).toBe("search_std");
	expect(body.count).toBe(10);
	// DeepSeek 专属参数不得出现
	expect(body.query).toBeUndefined();
	expect(body.ori_question).toBeUndefined();
	const out = text(r);
	expect(out).toContain("智谱搜索结果");
	expect(out).toContain("https://example.cn/a");
	expect(out).toContain("ExampleCN");
});

test("bigmodel query 超 70 字符自动截断（模型无感知，不报错）", async () => {
	writeSettings({
		provider: "bigmodel",
		searchEnabled: true,
		fetchEnabled: true,
		apiKey: "",
		apiKeyBigmodel: "zhu-pu-key",
	} as any);
	fetchQueue.push({ status: 200, body: { search_result: [] } });
	await registered["wa_web_search"].execute(
		"bm2",
		{ query: "a".repeat(120) },
		undefined,
	);
	const body = JSON.parse(fetchCalls[0].init.body);
	expect(body.search_query).toHaveLength(70);
});

test("bigmodel 网页阅读：POST /reader + reader_result 解析", async () => {
	writeSettings({
		provider: "bigmodel",
		searchEnabled: true,
		fetchEnabled: true,
		apiKey: "",
		apiKeyBigmodel: "zhu-pu-key",
	} as any);
	fetchQueue.push({
		status: 200,
		body: {
			reader_result: {
				title: "阅读标题",
				content: "# 正文 Markdown",
			},
		},
	});
	const r = await registered["wa_fetch_content"].execute(
		"bm3",
		{ url: "https://example.cn/page" },
		undefined,
	);
	expect(fetchCalls[0].url).toBe(
		"https://open.bigmodel.cn/api/paas/v4/reader",
	);
	expect(JSON.parse(fetchCalls[0].init.body)).toEqual({
		url: "https://example.cn/page",
		return_format: "markdown",
	});
	const out = text(r);
	expect(out).toContain("阅读标题");
	expect(out).toContain("# 正文 Markdown");
});

test("bigmodel 未配 key：文案带供应商名，不发请求", async () => {
	writeSettings({
		provider: "bigmodel",
		searchEnabled: true,
		fetchEnabled: true,
		apiKey: "",
		apiKeyBigmodel: "",
	} as any);
	const r = await registered["wa_web_search"].execute(
		"bm4",
		{ query: "x" },
		undefined,
	);
	expect(fetchCalls).toHaveLength(0);
	expect(text(r)).toContain("智谱 BigModel");
});

// ———— wa_fetch_content ————

test("wa_fetch_content 正常：POST /v1/tools/fetch，输出 title + Markdown 正文", async () => {
	writeSettings({ searchEnabled: true, fetchEnabled: true, apiKey: "sk-test" });
	fetchQueue.push({
		status: 200,
		body: { title: "Example Article", content: "# Example\n\n正文。" },
	});
	const r = await registered["wa_fetch_content"].execute(
		"f1",
		{ url: "https://example.com/a" },
		undefined,
	);
	expect(fetchCalls[0].url).toBe("https://api.deepseek.com/v1/tools/fetch");
	expect(JSON.parse(fetchCalls[0].init.body)).toEqual({
		url: "https://example.com/a",
	});
	const out = text(r);
	expect(out).toContain("Example Article");
	expect(out).toContain("# Example");
});

test("抓取开关关闭：引导文案，不发请求", async () => {
	writeSettings({ searchEnabled: true, fetchEnabled: false, apiKey: "sk-test" });
	const r = await registered["wa_fetch_content"].execute(
		"f2",
		{ url: "https://example.com" },
		undefined,
	);
	expect(fetchCalls).toHaveLength(0);
	expect(text(r)).toContain("网页抓取");
});

test("404：目标页不可抓取文案（不计费），不重试", async () => {
	writeSettings({ searchEnabled: true, fetchEnabled: true, apiKey: "sk-test" });
	fetchQueue.push({ status: 404, body: { error: { message: "not found" } } });
	const r = await registered["wa_fetch_content"].execute(
		"f3",
		{ url: "https://example.com/404" },
		undefined,
	);
	expect(fetchCalls).toHaveLength(1);
	expect(text(r)).toContain("无法抓取");
});

test("非法 URL（非 http/https）：不发请求", async () => {
	writeSettings({ searchEnabled: true, fetchEnabled: true, apiKey: "sk-test" });
	const r = await registered["wa_fetch_content"].execute(
		"f4",
		{ url: "file:///etc/passwd" },
		undefined,
	);
	expect(fetchCalls).toHaveLength(0);
	expect(text(r)).toMatch(/http/i);
});

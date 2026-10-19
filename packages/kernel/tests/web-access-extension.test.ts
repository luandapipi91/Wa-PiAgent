import { test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import webAccessExtension from "../src/web-access.extension";

// web-access 扩展（Bing 免费搜索+本地抓取 + DeepSeek/智谱 官方搜索抓取）单元测试：
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
let fetchQueue: Array<{
	status: number;
	body: unknown;
	contentType?: string;
	headers?: Record<string, string>;
}> = [];
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
		const isStream = next.body instanceof ReadableStream;
		const isHtml = typeof next.body === "string" || next.body instanceof Uint8Array;
		// 非 HTML（JSON 对象）需序列化：Response 构造函数会把普通对象退化成 "[object Object]"
		const body = isHtml || isStream ? next.body : JSON.stringify(next.body);
		return new Response(body as any, {
			status: next.status,
			headers: {
				"content-type": next.contentType ?? (isHtml || isStream ? "text/html" : "application/json"),
				...(next.headers ?? {}),
			},
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

const BING_HTML_200 = `<html><body>
<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9h&amp;ntb=1">示例标题 &amp; 实体</a></h2><p>摘要一</p></li>
<li class="b_algo"><h2><a href="https://example.org/b">第二条 <strong>高亮</strong> 词</a></h2><p>摘要二</p></li>
</body></html>`;

// ———— 本地抓取夹具（readability 抽取 / 空壳 / GBK 编码 / 大小上限） ————

const FETCH_ARTICLE_200 = `<!doctype html><html><head><title>页面标题 &amp; 测试</title>
<style>.a{color:red}</style><script>var x=1;console.log("不该出现");</script></head>
<body><nav>导航不该残留</nav>
<article><h1>正文大标题</h1><p>${"这是正文的第一段落，包含足够多的文字来让抽取器识别主要内容区域。".repeat(6)}</p></article>
<div class="sidebar"><ul><li>侧栏推荐一</li><li>侧栏推荐二</li></ul></div>
<footer>页脚不该残留</footer></body></html>`;

const FETCH_EMPTY_SHELL = `<!doctype html><html><head><title>空壳</title></head><body><div id="app"></div></body></html>`;

// GBK 字节段（iconv 预生成，JS 无 GBK 编码器）：
// "中文标题" → d6d0cec4b1eacce2；"中文测试" → d6d0cec4b2e2cad4
const GBK_TITLE = [0xd6, 0xd0, 0xce, 0xc4, 0xb1, 0xea, 0xcc, 0xe2];
const GBK_TEXT = [0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4];
function gbkFixture(metaCharset: boolean): Uint8Array {
	const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
	const head = metaCharset ? `<html><head><meta charset="gbk"><title>` : `<html><head><title>`;
	return Uint8Array.from([
		...ascii(head), ...GBK_TITLE, ...ascii("</title></head><body><p>"), ...GBK_TEXT, ...ascii("</p></body></html>"),
	]);
}

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
	writeSettings({ provider: "deepseek", searchEnabled: true, fetchEnabled: true, apiKey: "sk-test" });
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
	writeSettings({ provider: "deepseek", searchEnabled: true, fetchEnabled: true, apiKey: "" });
	const r = await registered["wa_web_search"].execute(
		"t3",
		{ query: "x" },
		undefined,
	);
	expect(fetchCalls).toHaveLength(0);
	expect(text(r)).toContain("API Key");
});

test("settings.json 不存在：默认供应商 bing，无需 Key 直接搜索", async () => {
	// 不写 settings.json
	fetchQueue.push({ status: 200, body: BING_HTML_200 });
	const r = await registered["wa_web_search"].execute(
		"t4",
		{ query: "q" },
		undefined,
	);
	expect(fetchCalls[0].url).toContain("www.bing.com/search");
	expect(text(r)).toContain("示例标题");
});

test("429 后重试第二次成功（重试 1 次即恢复）", async () => {
	writeSettings({ provider: "deepseek", searchEnabled: true, fetchEnabled: true, apiKey: "sk-test" });
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
	writeSettings({ provider: "deepseek", searchEnabled: true, fetchEnabled: true, apiKey: "sk-bad" });
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
	writeSettings({ provider: "deepseek", searchEnabled: true, fetchEnabled: true, apiKey: "sk-test" });
	fetchQueue.push({ status: 402, body: { error: { message: "insufficient" } } });
	const r = await registered["wa_web_search"].execute(
		"t7",
		{ query: "q" },
		undefined,
	);
	expect(text(r)).toContain("余额");
});

test("count 越界裁剪到 1-50；need_content 透传", async () => {
	writeSettings({ provider: "deepseek", searchEnabled: true, fetchEnabled: true, apiKey: "sk-test" });
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
	writeSettings({ provider: "deepseek", searchEnabled: true, fetchEnabled: true, apiKey: "sk-test" });
	const r = await registered["wa_web_search"].execute(
		"t9",
		{ query: "a".repeat(129) },
		undefined,
	);
	expect(fetchCalls).toHaveLength(0);
	expect(text(r)).toContain("128");
});

test("搜索无结果：空数组返回可读文案（不计费也不算错误）", async () => {
	writeSettings({ provider: "deepseek", searchEnabled: true, fetchEnabled: true, apiKey: "sk-test" });
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

// ———— 供应商：bing（免费，无需 Key） ————

test("bing 搜索：URL 构造 + b_algo 解析（实体清洗/ck/a 解包）+ 输出格式化", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	fetchQueue.push({ status: 200, body: BING_HTML_200 });
	const r = await registered["wa_web_search"].execute("b1", { query: "deepseek harness" }, undefined);
	expect(fetchCalls[0].url).toBe("https://www.bing.com/search?q=deepseek+harness");
	const out = text(r);
	expect(out).toContain("共 2 条结果");
	expect(out).toContain("https://example.com/a");      // ck/a 已解包
	expect(out).not.toContain("/ck/a");                   // 不透出包装链接
	expect(out).toContain("示例标题 & 实体");              // 实体解码
	expect(out).toContain("摘要一");
});

test("随机浏览器头：UA 属于池、sec-ch-ua 与平台自洽、sec-fetch 齐备", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	fetchQueue.push({ status: 200, body: BING_HTML_200 });
	await registered["wa_web_search"].execute("b2", { query: "q" }, undefined);
	const h = fetchCalls[0].init.headers;
	const ua = String(h["user-agent"]);
	const isWin = ua.includes("Windows");
	const isMac = ua.includes("Macintosh");
	expect(isWin || isMac).toBe(true);
	expect(ua).toMatch(/Chrome\/126|Edg\/126/);
	expect(String(h["sec-ch-ua-platform"])).toBe(isWin ? '"Windows"' : '"macOS"');
	expect(String(h["sec-ch-ua"])).toContain(ua.includes("Edg/") ? "Microsoft Edge" : "Chromium");
	expect(h["sec-fetch-mode"]).toBe("navigate");
	expect(String(h["accept-language"])).toContain("zh-CN");
});

test("随机浏览器头：20 次请求至少出现 2 种 UA（随机性生效）", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	for (let i = 0; i < 20; i++) fetchQueue.push({ status: 200, body: BING_HTML_200 });
	const seen = new Set<string>();
	for (let i = 0; i < 20; i++) {
		await registered["wa_web_search"].execute(`r${i}`, { query: "q" }, undefined);
		seen.add(String(fetchCalls[i].init.headers["user-agent"]));
	}
	expect(seen.size).toBeGreaterThanOrEqual(2);
});

test("bing 空 SERP：返回「没有找到」文案且不重试（1 次请求）", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	fetchQueue.push({ status: 200, body: "<html><body>no results</body></html>" });
	const r = await registered["wa_web_search"].execute("b3", { query: "不存在" }, undefined);
	expect(text(r)).toContain("没有找到");
	expect(fetchCalls).toHaveLength(1);
});

test("bing 429：限流文案且不重试（1 次请求）", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	fetchQueue.push({ status: 429, body: "" });
	const r = await registered["wa_web_search"].execute("b4", { query: "q" }, undefined);
	expect(text(r)).toContain("429");
	expect(fetchCalls).toHaveLength(1);
});

test("bing 500：重试 2 次后仍失败 → 失败文案（共 3 次请求）", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	fetchQueue.push({ status: 500, body: "" }, { status: 500, body: "" }, { status: 500, body: "" });
	const r = await registered["wa_web_search"].execute("b5", { query: "q" }, undefined);
	expect(text(r)).toContain("失败");
	expect(fetchCalls).toHaveLength(3);
});

test("bing 500 后第二次成功：重试恢复", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	fetchQueue.push({ status: 500, body: "" }, { status: 200, body: BING_HTML_200 });
	const r = await registered["wa_web_search"].execute("b6", { query: "q" }, undefined);
	expect(text(r)).toContain("共 2 条结果");
	expect(fetchCalls).toHaveLength(2);
});

test("bing：count 截断（count=1 → 只输出 1 条）", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	fetchQueue.push({ status: 200, body: BING_HTML_200 });
	const r = await registered["wa_web_search"].execute("b7", { query: "q", count: 1 }, undefined);
	expect(text(r)).toContain("共 1 条结果");
});

test("bing：query 超 128 字符直接拒绝，不发请求", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	const r = await registered["wa_web_search"].execute("b8", { query: "a".repeat(129) }, undefined);
	expect(fetchCalls).toHaveLength(0);
	expect(text(r)).toContain("128");
});

// ———— wa_fetch_content ————

test("wa_fetch_content 正常：POST /v1/tools/fetch，输出 title + Markdown 正文", async () => {
	writeSettings({ provider: "deepseek", searchEnabled: true, fetchEnabled: true, apiKey: "sk-test" });
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
	writeSettings({ provider: "deepseek", searchEnabled: true, fetchEnabled: false, apiKey: "sk-test" });
	const r = await registered["wa_fetch_content"].execute(
		"f2",
		{ url: "https://example.com" },
		undefined,
	);
	expect(fetchCalls).toHaveLength(0);
	expect(text(r)).toContain("网页抓取");
});

test("404：目标页不可抓取文案（不计费），不重试", async () => {
	writeSettings({ provider: "deepseek", searchEnabled: true, fetchEnabled: true, apiKey: "sk-test" });
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
	writeSettings({ provider: "deepseek", searchEnabled: true, fetchEnabled: true, apiKey: "sk-test" });
	const r = await registered["wa_fetch_content"].execute(
		"f4",
		{ url: "file:///etc/passwd" },
		undefined,
	);
	expect(fetchCalls).toHaveLength(0);
	expect(text(r)).toMatch(/http/i);
});

// ———— wa_fetch_content：bing 模式本地抓取（readability + turndown + 随机头） ————

test("bing 抓取：本地 GET + readability 正文抽取 + turndown 转换 + 随机头", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	fetchQueue.push({ status: 200, body: FETCH_ARTICLE_200 });
	const r = await registered["wa_fetch_content"].execute("f1", { url: "https://example.com/page" }, undefined);
	expect(fetchCalls[0].url).toBe("https://example.com/page");
	const h = fetchCalls[0].init.headers;
	expect(String(h["user-agent"])).toMatch(/Chrome\/126|Edg\/126/);
	expect(String(h["sec-ch-ua-platform"])).toBe(String(h["user-agent"]).includes("Windows") ? '"Windows"' : '"macOS"');
	const out = text(r);
	expect(out).toContain("# 页面标题 & 测试");       // readability 标题 + 实体解码
	expect(out).toContain("正文大标题");
	expect(out).toContain("这是正文的第一段落");
	expect(out).not.toContain("侧栏推荐");             // readability 丢弃侧栏（证明走库路径）
	expect(out).not.toContain("不该出现");              // script 内容不得残留
	expect(out).not.toContain("导航");
	expect(out).not.toContain("页脚");
});

test("bing 抓取：空壳页面（readability 未命中）→ 「没有可提取的正文内容」", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	fetchQueue.push({ status: 200, body: FETCH_EMPTY_SHELL });
	const r = await registered["wa_fetch_content"].execute("f2", { url: "https://example.com/app" }, undefined);
	expect(text(r)).toContain("没有可提取的正文内容");
});

test("bing 抓取：GBK 页面按 charset 解码（响应头与 meta 两种来源）", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	fetchQueue.push({ status: 200, body: gbkFixture(false), contentType: "text/html; charset=gbk" });
	const r1 = await registered["wa_fetch_content"].execute("f3", { url: "https://example.cn/a" }, undefined);
	expect(text(r1)).toContain("中文测试");
	fetchQueue.push({ status: 200, body: gbkFixture(true), contentType: "text/html" });
	const r2 = await registered["wa_fetch_content"].execute("f4", { url: "https://example.cn/b" }, undefined);
	expect(text(r2)).toContain("中文测试");
	expect(text(r2)).toContain("中文标题");
});

test("bing 抓取：非文本内容类型拒绝（不倒出内容、不重试）", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	fetchQueue.push({ status: 200, body: {}, contentType: "application/pdf" });
	const r = await registered["wa_fetch_content"].execute("f5", { url: "https://example.com/a.pdf" }, undefined);
	expect(text(r)).toContain("application/pdf");
	expect(text(r)).toContain("不支持");
	expect(fetchCalls).toHaveLength(1);
});

test("bing 抓取：content-length 超上限 → 中止下载文案，不重试", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	fetchQueue.push({ status: 200, body: "<html></html>", contentType: "text/html", headers: { "content-length": String(3 * 1024 * 1024) } });
	const r = await registered["wa_fetch_content"].execute("f6", { url: "https://example.com/big" }, undefined);
	expect(text(r)).toContain("过大");
	expect(fetchCalls).toHaveLength(1);
});

test("bing 抓取：500 重试 2 次后失败（3 次请求）；404 不重试（1 次请求）", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	fetchQueue.push({ status: 500, body: "" }, { status: 500, body: "" }, { status: 500, body: "" });
	const r1 = await registered["wa_fetch_content"].execute("f7", { url: "https://example.com/x" }, undefined);
	expect(text(r1)).toContain("失败");
	expect(fetchCalls).toHaveLength(3);
	fetchCalls.length = 0;
	fetchQueue.push({ status: 404, body: "" });
	const r2 = await registered["wa_fetch_content"].execute("f8", { url: "https://example.com/y" }, undefined);
	expect(text(r2)).toContain("404");
	expect(fetchCalls).toHaveLength(1);
});

test("bing 抓取：超长正文截断（>40000 字符带截断标记）", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	fetchQueue.push({ status: 200, body: `<html><body><article><p>${"长".repeat(45000)}</p></article></body></html>` });
	const r = await registered["wa_fetch_content"].execute("f9", { url: "https://example.com/long" }, undefined);
	expect(text(r)).toContain("已截断");
});

// ———— 修复轮 1：SSRF 拒绝表（本机/内网）+ 重定向逐跳校验 + 流式读取上限 ————

/** 造一个「按需生成」的超大 HTML 响应流：记录被拉取字节数与是否被 cancel（验证超限即停，而不是整读） */
function largeHtmlStreamFixture(chunks: number) {
	const enc = new TextEncoder();
	const prefix = enc.encode("<html><body><article><p>");
	let sent = 0;
	let pulled = 0;
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent === 0) {
				sent = 1;
				pulled += prefix.byteLength;
				controller.enqueue(prefix);
				return;
			}
			if (sent > chunks) {
				controller.close();
				return;
			}
			sent += 1;
			const part = enc.encode("长".repeat(300_000)); // 约 900KB/块（UTF-8 三字节/字）
			pulled += part.byteLength;
			controller.enqueue(part);
		},
		cancel() {
			cancelled = true;
		},
	});
	return { stream, pulledBytes: () => pulled, cancelled: () => cancelled };
}

test("bing 抓取：本机/内网地址直接拒绝，不发请求", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	const blocked = [
		"http://localhost:9778/api/health",
		"http://127.0.0.1:9333/secret",
		"http://10.0.0.5/admin",
		"http://172.20.3.4/internal",
		"http://192.168.1.1/",
		"http://169.254.169.254/latest/meta-data/",
		"http://[::1]:8080/x",
		"http://printer.local/status",
	];
	for (const url of blocked) {
		const r = await registered["wa_fetch_content"].execute("s1", { url }, undefined);
		expect(text(r)).toContain("不允许访问本地/内网地址");
		expect(text(r)).toContain(new URL(url).hostname.replace(/^\[|\]$/g, ""));
	}
	expect(fetchCalls).toHaveLength(0); // 拒绝发生在发请求之前（含 169.254 云元数据）
});

test("bing 抓取：公网地址照常抓取（拒绝表不误伤 + 手动重定向模式）", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	fetchQueue.push({ status: 200, body: FETCH_ARTICLE_200 });
	const r1 = await registered["wa_fetch_content"].execute("s2", { url: "https://example.com/page" }, undefined);
	expect(fetchCalls).toHaveLength(1);
	expect(fetchCalls[0].init.redirect).toBe("manual"); // 3xx 必须手动逐跳校验，不能自动跟随
	expect(text(r1)).toContain("正文大标题");
	fetchQueue.push({ status: 200, body: FETCH_ARTICLE_200 });
	const r2 = await registered["wa_fetch_content"].execute("s3", { url: "http://93.184.216.34/pub" }, undefined);
	expect(fetchCalls).toHaveLength(2); // 公网 IP 字面量不被拒绝
	expect(text(r2)).toContain("正文大标题");
});

test("bing 抓取：重定向到内网被拒（不发第二个请求）", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	fetchQueue.push({ status: 302, body: "", headers: { location: "http://127.0.0.1:9333/secret" } });
	const r = await registered["wa_fetch_content"].execute("s4", { url: "https://example.com/jump" }, undefined);
	expect(fetchCalls).toHaveLength(1); // 第二跳在发请求前被拦下
	expect(fetchCalls[0].url).toBe("https://example.com/jump");
	expect(text(r)).toContain("不允许访问本地/内网地址");
	expect(text(r)).toContain("127.0.0.1");
});

test("bing 抓取：相对 Location 按当前 URL 解析并跟随（≤3 跳）", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	fetchQueue.push({ status: 301, body: "", headers: { location: "/real-page" } });
	fetchQueue.push({ status: 200, body: FETCH_ARTICLE_200 });
	const r = await registered["wa_fetch_content"].execute("s5", { url: "https://example.com/jump" }, undefined);
	expect(fetchCalls).toHaveLength(2);
	expect(fetchCalls[1].url).toBe("https://example.com/real-page");
	expect(text(r)).toContain("正文大标题");
});

test("bing 抓取：重定向超过 3 跳失败（不无限跟跳）", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	for (let i = 0; i < 5; i++)
		fetchQueue.push({ status: 302, body: "", headers: { location: `https://example.com/hop${i + 1}` } });
	const r = await registered["wa_fetch_content"].execute("s6", { url: "https://example.com/hop0" }, undefined);
	expect(fetchCalls).toHaveLength(4); // 初始 + 最多 3 跳
	expect(text(r)).toContain("重定向");
});

test("bing 抓取：无 content-length 的超大页面按流截断（超限即取消下载，不整读）", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	const fixture = largeHtmlStreamFixture(40); // 总计约 36MB，远超 2MB 上限
	fetchQueue.push({ status: 200, body: fixture.stream, contentType: "text/html" });
	const r = await registered["wa_fetch_content"].execute("s7", { url: "https://example.com/huge" }, undefined);
	expect(fetchCalls).toHaveLength(1);
	expect(fixture.cancelled()).toBe(true); // 超限即 cancel，不再继续拉流
	// 上限 2MB + Bun 流内部预取窗口（实测约 4 块，~3.6MB）；整读实现会是 36MB
	expect(fixture.pulledBytes()).toBeLessThanOrEqual(5 * 1024 * 1024);
	expect(text(r)).toContain("已截断"); // 对外语义不变：仍按 2MB 截断后再走正文截断
	expect(text(r).length).toBeLessThan(50_000);
});

test("bing 抓取：重定向到非 HTTP(S) 协议被拒（file:// 不得读本机文件）", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	fetchQueue.push({ status: 302, body: "", headers: { location: "file:///tmp/secret.txt" } });
	const r = await registered["wa_fetch_content"].execute("s8", { url: "https://attacker.example/p" }, undefined);
	expect(fetchCalls).toHaveLength(1); // 不向 file:// 发请求（Bun 的 file: 抓取会直接返回文件内容）
	expect(fetchCalls.some((c) => String(c.url).startsWith("file:"))).toBe(false);
	expect(text(r)).toContain("重定向目标地址不合法");
});

test("bing 抓取：拒绝表 host 归一化（尾点 / 0.0.0.0 / v4-mapped IPv6 / IPv6 未指定）", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	const blocked = [
		"http://localhost.:9778/x", // 尾点：DNS 仍解析 127.0.0.1
		"http://[::ffff:127.0.0.1]/", // v4-mapped IPv6（解析器归一成 ::ffff:7f00:1）
		"http://0.0.0.0/", // 未指定地址（连本机）
		"http://[::]/", // IPv6 未指定
	];
	for (const url of blocked) {
		const r = await registered["wa_fetch_content"].execute("s9", { url }, undefined);
		expect(text(r)).toContain("不允许访问本地/内网地址");
	}
	expect(fetchCalls).toHaveLength(0); // 归一化后全部在发请求前拦下
});

test("bing 抓取：站点未声明 content-type → 明确文案（不是空括号）", async () => {
	writeSettings({ provider: "bing", searchEnabled: true, fetchEnabled: true });
	fetchQueue.push({ status: 200, body: "<html></html>", contentType: "" });
	const r = await registered["wa_fetch_content"].execute("s10", { url: "https://example.com/noct" }, undefined);
	expect(text(r)).toContain("未声明内容类型");
	expect(fetchCalls).toHaveLength(1);
});

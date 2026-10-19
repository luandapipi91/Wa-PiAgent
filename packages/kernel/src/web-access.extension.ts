// SPDX-License-Identifier: MIT
// web-access.extension.ts —— wa-pi 内置网络工具（多供应商：DeepSeek / 智谱 BigModel）
//
// 本文件由 ensureWebAccessExtension() 打包为单文件 bundle 后部署到 GENERATED_DIR/web-access.ts，
// pi 进程经 -e 加载（主会话 + 子代理同款注入）。
//
// 设计要点：
// - 替代第三方扩展 pi-web-access（2026-10-18 移除）：保留两个高频工具，供应商可配：
//   • bing（默认）：GET www.bing.com/search 解析 SERP（b_algo），免 Key 免费；每次请求取一份自洽随机浏览器头
//   • deepseek：POST /v1/tools/search | /v1/tools/fetch，Bearer 鉴权，
//     按次计费 5 元/千次成功请求，各自 QPS 5
//   • bigmodel（智谱）：POST /api/paas/v4/web_search | /api/paas/v4/reader，Bearer 鉴权
// - 配置（供应商 + 双开关 + 各自 API key）存 <agentDir>/settings.json 的 webSearch 字段，
//   每次工具执行时读取——开关变更保存后由 kernel markAllDirty 重建会话（注册面生效），
//   key 保存后即时生效。
// - 未配 key / 开关关闭时返回可操作的引导文案（不抛异常，对齐 bridge failResult 语义）。
// - 408/429/5xx 自动重试（官方建议），401/402/403/404/400 不重试（改请求才有意义）；
//   Bing 搜索例外：429 不重试（反爬限流下重试会被压得更狠），408/5xx/网络错误退避重试。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";
const BIGMODEL_SEARCH_URL = "https://open.bigmodel.cn/api/paas/v4/web_search";
const BIGMODEL_FETCH_URL = "https://open.bigmodel.cn/api/paas/v4/reader";

/** 供应商标识（与 settings-store 的 WebSearchProvider 保持一致；扩展自含不导入） */
type WebSearchProvider = "bing" | "deepseek" | "bigmodel";

const PROVIDERS: readonly WebSearchProvider[] = ["bing", "deepseek", "bigmodel"];

function normalizeProvider(v: unknown): WebSearchProvider {
	return PROVIDERS.includes(v as WebSearchProvider)
		? (v as WebSearchProvider)
		: "bing";
}

function providerLabel(p: WebSearchProvider): string {
	return p === "bigmodel" ? "智谱 BigModel" : p === "bing" ? "Bing" : "DeepSeek";
}

/** 智谱 web_search 的 query 上限（官方：建议 ≤70 字符，Maximum string length: 70） */
const BIGMODEL_QUERY_LIMIT = 70;
/** 智谱搜索引擎编码：search_std 基础版（搜索意由配置默认，不暴露 UI） */
const BIGMODEL_SEARCH_ENGINE = "search_std";

/** 单次请求兜底超时（ms）：搜索/抓取正常秒级返回，120s 足够宽容（智谱 reader 默认 20s 自身会超时返回） */
const REQUEST_TIMEOUT_MS = 120_000;
/** 可重试状态码（官方：408/429/5xx 等待后重试） */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
/** 最多重试次数（不含首次） */
const MAX_RETRIES = 2;

interface WebSearchConfig {
	provider: WebSearchProvider;
	searchEnabled: boolean;
	fetchEnabled: boolean;
	apiKey: string;
	apiKeyBigmodel: string;
}

const CONFIG_DEFAULTS: WebSearchConfig = {
	provider: "bing",
	searchEnabled: true,
	fetchEnabled: true,
	apiKey: "",
	apiKeyBigmodel: "",
};

/** settings.json 路径每次执行时求值：WA_PI_DIR / PI_CODING_AGENT_DIR 双源兜底
 *  （kernel spawn pi 时必注入 PI_CODING_AGENT_DIR=WA_PI_DIR，见 agent-manager）。 */
function settingsPath(): string {
	const dir =
		process.env.WA_PI_DIR ||
		process.env.PI_CODING_AGENT_DIR ||
		join(homedir(), ".pi", "agent");
	return join(dir, "settings.json");
}

/** 读取互联网搜索配置；文件缺失/字段缺失逐项回退默认值（读失败不打断工具） */
async function loadConfig(): Promise<WebSearchConfig> {
	try {
		const raw = JSON.parse(await readFile(settingsPath(), "utf8"));
		const ws = raw?.webSearch ?? {};
		return {
			provider: normalizeProvider(ws.provider),
			searchEnabled: ws.searchEnabled ?? CONFIG_DEFAULTS.searchEnabled,
			fetchEnabled: ws.fetchEnabled ?? CONFIG_DEFAULTS.fetchEnabled,
			apiKey: typeof ws.apiKey === "string" ? ws.apiKey : "",
			apiKeyBigmodel: typeof ws.apiKeyBigmodel === "string" ? ws.apiKeyBigmodel : "",
		};
	} catch {
		return { ...CONFIG_DEFAULTS };
	}
}

/** 同步版 loadConfig：扩展加载时用（决定是否注册工具），一次性读取无性能考量。
 *  开关关闭 → 不注册 → 模型直接看不到该工具（而非看到但调用失败，2026-10-18 用户裁决）。
 *  运行中改开关由 kernel 保存时 markAllDirty 重建会话 → 扩展重载 → 新注册面生效。 */
function loadConfigSync(): WebSearchConfig {
	try {
		const raw = JSON.parse(readFileSync(settingsPath(), "utf8"));
		const ws = raw?.webSearch ?? {};
		return {
			provider: normalizeProvider(ws.provider),
			searchEnabled: ws.searchEnabled ?? CONFIG_DEFAULTS.searchEnabled,
			fetchEnabled: ws.fetchEnabled ?? CONFIG_DEFAULTS.fetchEnabled,
			apiKey: typeof ws.apiKey === "string" ? ws.apiKey : "",
			apiKeyBigmodel: typeof ws.apiKeyBigmodel === "string" ? ws.apiKeyBigmodel : "",
		};
	} catch {
		return { ...CONFIG_DEFAULTS };
	}
}

/** 工具文本结果（对齐 bridge failResult 语义：失败也是文本结果 + details.error，不抛异常。
 *  details 恒定存在（可为 undefined 值），满足 pi AgentToolResult 的 required 形状 */
function textResult(text: string, error?: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: error === undefined ? undefined : { error },
	};
}

/** 从供应商错误响应体提取 message（OpenAI 兼容格式优先，智谱等其它格式回退 HTTP 状态） */
async function errorMessage(res: Response): Promise<string> {
	try {
		const body = await res.json();
		return body?.error?.message || body?.message || `HTTP ${res.status}`;
	} catch {
		return `HTTP ${res.status}`;
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 带重试的供应商 POST（DeepSeek/智谱同为 Bearer + JSON）：408/429/5xx 退避重试（1s/2s），
 *  其余状态一次性返回。返回 { ok: true, data } 或 { ok: false, status, message }。 */
async function postJson(
	url: string,
	apiKey: string,
	body: unknown,
	signal: AbortSignal | undefined,
): Promise<
	| { ok: true; data: any }
	| { ok: false; status: number; message: string }
> {
	// 120s 兜底超时与 pi 传入的 abort signal 叠加（任一触发即中止）
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const merged =
		signal && !signal.aborted
			? AbortSignal.any([signal, timeout])
			: (signal ?? timeout);
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (attempt > 0) await sleep(1000 * attempt); // 1s / 2s 线性退避
		let res: Response;
		try {
			res = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
				signal: merged,
			});
		} catch (err) {
			if (signal?.aborted) throw err; // 用户中止直接上抛
			// 网络错误（断网/DNS）：等价于暂时性失败，走重试
			if (attempt < MAX_RETRIES) continue;
			return {
				ok: false,
				status: 0,
				message: `网络请求失败：${err instanceof Error ? err.message : String(err)}`,
			};
		}
		if (res.ok) return { ok: true, data: await res.json() };
		const message = await errorMessage(res);
		if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) continue;
		return { ok: false, status: res.status, message };
	}
	return { ok: false, status: 0, message: "unreachable" }; // 循环必经 return，防御性兜底
}

/** 把 API 失败翻译成模型可操作的中文文案（引导用户/模型下一步动作）。
 *  DeepSeek 专属码（402 余额）在智谱侧不会出现，无害保留。 */
function failureText(kind: "搜索" | "抓取", provider: WebSearchProvider, status: number, message: string): string {
	const vendor = providerLabel(provider);
	if (status === 401)
		return `${kind}失败：${vendor} API Key 无效或缺失。请到 设置 → 联网 → 互联网搜索 检查当前供应商的 API Key。`;
	if (status === 402)
		return `${kind}失败：${vendor} 账号余额不足。请到 ${vendor} 平台充值后重试。`;
	if (status === 403)
		return `${kind}失败：请求被 ${vendor} 安全策略拒绝（HTTP 403）。${message}`;
	if (status === 404)
		return `${kind}失败：无法抓取该网页（URL 不可用、被站点拦截、内容类型不受支持或页面无可提取正文）。可换用 wa_web_search 搜索同主题信息。（该次调用不计费）`;
	if (status === 0) return `${kind}失败：${message}（已自动重试仍失败，请检查网络后重试）`;
	return `${kind}失败（HTTP ${status}）：${message}`;
}

// ———— Bing 免费搜索（免 Key）：随机浏览器头 + SERP 解析 ————

const BING_SEARCH_URL = "https://www.bing.com/search";
const BING_TIMEOUT_MS = 12_000;
const BING_MAX_RETRIES = 2;

/** 浏览器 UA 档案池：ua / brands / platform 逐项自洽，随机取用（随机模拟浏览器请求头） */
const BROWSER_PROFILES = [
	{ ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
	  brands: '"Chromium";v="126", "Not/A)Brand";v="24"', platform: '"Windows"' },
	{ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
	  brands: '"Chromium";v="126", "Not/A)Brand";v="24"', platform: '"macOS"' },
	{ ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
	  brands: '"Microsoft Edge";v="126", "Chromium";v="126", "Not/A)Brand";v="24"', platform: '"Windows"' },
	{ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
	  brands: '"Microsoft Edge";v="126", "Chromium";v="126", "Not/A)Brand";v="24"', platform: '"macOS"' },
] as const;

/** 每次调用现取一份自洽的浏览器请求头（抓取类请求专用；API 供应商请求头不受影响） */
function buildBrowserHeaders(): Record<string, string> {
	const p = BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)];
	return {
		"user-agent": p.ua,
		accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
		"accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
		"sec-ch-ua": p.brands,
		"sec-ch-ua-mobile": "?0",
		"sec-ch-ua-platform": p.platform,
		"sec-fetch-dest": "document",
		"sec-fetch-mode": "navigate",
		"sec-fetch-site": "none",
		"sec-fetch-user": "?1",
		"upgrade-insecure-requests": "1",
	};
}

/** 常见 HTML 实体解码（参考实现同款集合） */
function decodeEntities(text: string): string {
	return String(text)
		.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** 去标签 + 空白收敛 + 实体解码（Bing 标题含 <strong> 高亮，需清洗） */
function stripTags(html: string): string {
	return decodeEntities(String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

/** Bing 结果链接解包：bing.com/ck/a?…u=a1<base64url> → 真实 URL；非包装链接原样返回 */
function extractBingUrl(href: string): string {
	if (!href) return href;
	const url = decodeEntities(href);
	if (!/^https?:\/\/(www\.)?bing\.com\/ck\/a/i.test(url)) return href;
	try {
		const u = new URL(url).searchParams.get("u");
		if (!u) return href;
		const b64 = u.startsWith("a1") ? u.slice(2) : u;
		const decoded = Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
		return /^https?:\/\//i.test(decoded) ? decoded : href;
	} catch { return href; }
}

/** Bing 结果页解析：b_algo 块 → {title,url,summary}（url 已解包） */
function parseBingHtml(html: string): Array<{ title?: string; url: string; summary?: string }> {
	const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
	const out: Array<{ title?: string; url: string; summary?: string }> = [];
	for (const block of blocks) {
		const href = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"/)?.[1];
		if (!href) continue;
		const url = extractBingUrl(href);
		const titleHtml = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/)?.[1];
		const snippetHtml = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1];
		out.push({
			url,
			...(titleHtml ? { title: stripTags(titleHtml) } : {}),
			...(snippetHtml ? { summary: stripTags(snippetHtml) } : {}),
		});
	}
	return out;
}

/** Bing 搜索：GET SERP 页 → b_algo 解析（免 Key 免费）。
 *  429 不重试（反爬限流重试会被压得更狠）；408/5xx/网络错误退避重试（1s/2s，共 3 次）。 */
async function bingSearch(
	query: string,
	count: number,
	signal: AbortSignal | undefined,
): Promise<
	| { ok: true; results: Array<{ title?: string; url: string; summary?: string }> }
	| { ok: false; status: number; message: string }
> {
	// 不发 mkt：参考实测 mkt=zh-CN 在部分线路会返回空 SERP
	const url = `${BING_SEARCH_URL}?${new URLSearchParams({ q: query })}`;
	// 12s 兜底超时与 pi 传入的 abort signal 叠加（任一触发即中止）
	const timeout = AbortSignal.timeout(BING_TIMEOUT_MS);
	const merged =
		signal && !signal.aborted
			? AbortSignal.any([signal, timeout])
			: (signal ?? timeout);
	let lastError = "";
	for (let attempt = 0; attempt <= BING_MAX_RETRIES; attempt++) {
		if (attempt > 0) await sleep(1000 * attempt); // 1s / 2s 线性退避
		let res: Response;
		try {
			res = await fetch(url, {
				headers: buildBrowserHeaders(), // 每次尝试现取随机浏览器头
				signal: merged,
			});
		} catch (err) {
			if (signal?.aborted) throw err; // 用户中止直接上抛
			lastError = err instanceof Error ? err.message : String(err);
			if (attempt < BING_MAX_RETRIES) continue;
			return {
				ok: false,
				status: 0,
				message: `搜索失败：网络请求失败（${lastError}），请检查网络后重试。`,
			};
		}
		if (res.status === 429)
			return {
				ok: false,
				status: 429,
				message: "搜索失败：Bing 访问受限（HTTP 429，反爬限流），请稍后重试。",
			};
		if (res.ok) {
			const seen = new Set<string>();
			const parsed = parseBingHtml(await res.text());
			const results = parsed
				.filter((r) => {
					if (seen.has(r.url)) return false; // 同 URL 只保留首条
					seen.add(r.url);
					return true;
				})
				.slice(0, Math.min(50, Math.max(1, Math.round(count))));
			return { ok: true, results }; // 0 条为合法「无结果」，不重试
		}
		if ((res.status === 408 || res.status >= 500) && attempt < BING_MAX_RETRIES) continue;
		return {
			ok: false,
			status: res.status,
			message: `搜索失败：Bing 返回 HTTP ${res.status}，请稍后重试。`,
		};
	}
	return { ok: false, status: 0, message: `搜索失败：网络请求失败（${lastError}），请检查网络后重试。` }; // 循环必经 return，防御性兜底
}

// ———— 工具描述（模型选择依据：用途 + 返回内容 + 限制） ————
// 工具名带 wa_ 前缀：避免与插件（如 pi-web-access）注册的 web_search/fetch_content 同名冲突——
// 重名会触发插件安装/加载拦截，导致插件装不上（2026-10-18 用户实测）。

const SEARCH_DESCRIPTION = `联网搜索网页（供应商可在 设置 → 联网 选择：Bing（免费，无需 Key）/ DeepSeek / 智谱 BigModel）。返回结构化结果列表：标题、链接、摘要（DeepSeek 另含站点与日期）。query 支持 site: / -site: / "精确短语" 等搜索语法（lang:zh,en / after: / before: 与 need_content 仅 DeepSeek 支持）。Bing 免费；DeepSeek / 智谱按次计费。`;

const FETCH_DESCRIPTION = `抓取单个网页，返回页面标题与 Markdown 正文。适用于：读取 wa_web_search 结果中的具体页面、获取用户提供的 URL 内容。返回的是整页 Markdown，可能包含导航栏、页脚、日历组件、推广引导等噪声内容——引用信息前请自行过滤，优先采信正文主体。受目标站点可用性与访问策略影响，抓取失败不计费。`;

const SearchParams = Type.Object({
	query: Type.String({
		description:
			"搜索词，1-128 个字符，支持 site: -site: \"短语\" lang: after: before: 等搜索语法",
	}),
	count: Type.Optional(
		Type.Number({
			description: "返回条数，1-50，默认 10",
		}),
	),
	need_content: Type.Optional(
		Type.Boolean({
			description: "是否返回网页正文（每条截断至 4000 字符），默认 false",
		}),
	),
	ori_question: Type.Optional(
		Type.String({
			description: "触发搜索的用户原始问题（可选，帮助搜索引擎理解意图）",
		}),
	),
});

const FetchParams = Type.Object({
	url: Type.String({
		description: "要抓取的网页地址（HTTP/HTTPS，长度 ≤ 8192，不能携带用户名密码）",
	}),
});

/** need_content 模式下每条正文的截断长度 */
const CONTENT_TRUNCATE = 4000;

function formatSearchResults(
	query: string,
	results: any[],
): string {
	if (!Array.isArray(results) || results.length === 0) {
		return `没有找到与「${query}」相关的搜索结果。可尝试更换关键词、放宽过滤语法后重试。`;
	}
	const lines: string[] = [`共 ${results.length} 条结果（${query}）：`, ""];
	results.forEach((r, i) => {
		lines.push(`${i + 1}. [${r.title ?? "(无标题)"}](${r.url ?? ""})`);
		if (r.site_name) lines.push(`   站点：${r.site_name}${r.date ? ` · ${String(r.date).slice(0, 10)}` : ""}`);
		if (r.summary) lines.push(`   摘要：${r.summary}`);
		if (r.content) {
			const content =
				r.content.length > CONTENT_TRUNCATE
					? `${r.content.slice(0, CONTENT_TRUNCATE)}…（正文已截断）`
					: r.content;
			lines.push(`   正文：${content}`);
		}
		lines.push("");
	});
	return lines.join("\n");
}

/** 非 http/https 的 URL 一律拒绝（含 file:/ftp:/无协议等） */
function isFetchableUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
	} catch {
		return false;
	}
}

/** 当前供应商的 API Key（缺失返回空串） */
function keyFor(cfg: WebSearchConfig): string {
	return cfg.provider === "bigmodel" ? cfg.apiKeyBigmodel : cfg.apiKey;
}

/** 智谱 web_search 请求体：query 官方上限 70 字符（超长自动截断，模型无感知）；
 *  search_engine 固定基础版（search_std，不暴露 UI）；无 ori_question/need_content 对应参数 */
function bigmodelSearchBody(query: string, count: number) {
	return {
		search_query: query.slice(0, BIGMODEL_QUERY_LIMIT),
		search_engine: BIGMODEL_SEARCH_ENGINE,
		count: Math.min(50, Math.max(1, Math.round(count))),
	};
}

/** 智谱搜索结果格式化：search_result[]（title/link/media/publish_date/content）。
 *  content 为网页内容（长度不定），截 800 字符当摘要展示。 */
function formatBigmodelResults(query: string, results: any[]): string {
	if (!Array.isArray(results) || results.length === 0) {
		return `没有找到与「${query}」相关的搜索结果。可尝试更换关键词后重试。`;
	}
	const lines: string[] = [`共 ${results.length} 条结果（${query}）：`, ""];
	results.forEach((r, i) => {
		lines.push(`${i + 1}. [${r.title ?? "(无标题)"}](${r.link ?? ""})`);
		if (r.media)
			lines.push(
				`   站点：${r.media}${r.publish_date ? ` · ${String(r.publish_date).slice(0, 10)}` : ""}`,
			);
		if (r.content) {
			const c = String(r.content);
			const summary = c.length > 800 ? `${c.slice(0, 800)}…（已截断）` : c;
			lines.push(`   摘要：${summary}`);
		}
		lines.push("");
	});
	return lines.join("\n");
}

export default function webAccessExtension(pi: ExtensionAPI) {
	// 开关关闭 → 不注册：模型直接看不到该工具（而非看到但调用失败）。
	// 运行中改开关由 kernel 保存时 markAllDirty 重建会话 → 扩展重载 → 新注册面生效。
	const bootCfg = loadConfigSync();
	if (bootCfg.searchEnabled)
	pi.registerTool({
		name: "wa_web_search",
		label: "Web Search",
		description: SEARCH_DESCRIPTION,
		parameters: SearchParams,
		async execute(_toolCallId, params: Static<typeof SearchParams>, signal) {
			const cfg = await loadConfig();
			if (!cfg.searchEnabled)
				return textResult(
					"互联网搜索未开启。请到 设置 → 联网 → 互联网搜索 打开「网页搜索」开关后重试。",
					"web_search_disabled",
				);
			const query = params.query.trim();
			if (!query)
				return textResult(
					"搜索词不合法：query 不能为空。请提供搜索词后重试。",
					"invalid_query",
				);
			if (cfg.provider === "bing") {
				// Bing 免费（免 Key）：本地 GET 搜索，无需 key 校验
				if (query.length > 128)
					return textResult(
						"搜索词不合法：query 必须为 1-128 个字符。请缩短或调整后重试。",
						"invalid_query",
					);
				const res = await bingSearch(query, params.count ?? 10, signal);
				if (!res.ok) return textResult(res.message, `search_http_${res.status}`);
				return textResult(formatSearchResults(query, res.results));
			}
			const apiKey = keyFor(cfg);
			if (!apiKey)
				return textResult(
					`互联网搜索未配置 ${providerLabel(cfg.provider)} API Key。请到 设置 → 联网 → 互联网搜索 填入当前供应商的 API Key 后重试。`,
					"web_search_no_api_key",
				);
			if (cfg.provider === "bigmodel") {
				// 智谱 BigModel：query ≤70 超长自动截断；无 ori_question/need_content 对应参数
				const res = await postJson(
					BIGMODEL_SEARCH_URL,
					apiKey,
					bigmodelSearchBody(query, params.count ?? 10),
					signal,
				);
				if (!res.ok)
					return textResult(
						failureText("搜索", cfg.provider, res.status, res.message),
						`search_http_${res.status}`,
					);
				return textResult(
					formatBigmodelResults(query, res.data?.search_result ?? []),
				);
			}
			if (query.length > 128)
				return textResult(
					"搜索词不合法：query 必须为 1-128 个字符。请缩短或调整后重试。",
					"invalid_query",
				);
			const body: Record<string, unknown> = {
				query,
				count: Math.min(50, Math.max(1, Math.round(params.count ?? 10))),
				need_content: params.need_content ?? false,
			};
			if (params.ori_question) body.ori_question = params.ori_question;
			const res = await postJson(SEARCH_URL, apiKey, body, signal);
			if (!res.ok)
				return textResult(
					failureText("搜索", cfg.provider, res.status, res.message),
					`search_http_${res.status}`,
				);
			return textResult(formatSearchResults(query, res.data?.results ?? []));
		},
	});

	if (bootCfg.fetchEnabled)
	pi.registerTool({
		name: "wa_fetch_content",
		label: "Fetch Content",
		description: FETCH_DESCRIPTION,
		parameters: FetchParams,
		async execute(_toolCallId, params: Static<typeof FetchParams>, signal) {
			const cfg = await loadConfig();
			if (!cfg.fetchEnabled)
				return textResult(
					"网页抓取未开启。请到 设置 → 联网 → 互联网搜索 打开「网页抓取」开关后重试。",
					"fetch_disabled",
				);
			const apiKey = keyFor(cfg);
			if (!apiKey)
				return textResult(
					`网页抓取未配置 ${providerLabel(cfg.provider)} API Key。请到 设置 → 联网 → 互联网搜索 填入当前供应商的 API Key 后重试。`,
					"fetch_no_api_key",
				);
			if (!isFetchableUrl(params.url))
				return textResult(
					`URL 不合法：仅支持带主机名的 HTTP/HTTPS 地址（收到「${params.url.slice(0, 200)}」）。`,
					"invalid_url",
				);
			if (cfg.provider === "bigmodel") {
				// 智谱网页阅读：reader_result{content,title}，return_format=markdown 与工具语义一致
				const res = await postJson(
					BIGMODEL_FETCH_URL,
					apiKey,
					{ url: params.url, return_format: "markdown" },
					signal,
				);
				if (!res.ok)
					return textResult(
						failureText("抓取", cfg.provider, res.status, res.message),
						`fetch_http_${res.status}`,
					);
				const rr = res.data?.reader_result ?? {};
				const title = rr.title ?? "";
				const content = rr.content ?? "";
				if (!content)
					return textResult(
						"抓取成功但页面没有可提取的正文内容。",
						"fetch_empty_content",
					);
				return textResult(title ? `# ${title}\n\n${content}` : content);
			}
			const res = await postJson(
				FETCH_URL,
				apiKey,
				{ url: params.url },
				signal,
			);
			if (!res.ok)
				return textResult(
					failureText("抓取", cfg.provider, res.status, res.message),
					`fetch_http_${res.status}`,
				);
			const title = res.data?.title ?? "";
			const content = res.data?.content ?? "";
			if (!content)
				return textResult(
					"抓取成功但页面没有可提取的正文内容。",
					"fetch_empty_content",
				);
			return textResult(title ? `# ${title}\n\n${content}` : content);
		},
	});
}

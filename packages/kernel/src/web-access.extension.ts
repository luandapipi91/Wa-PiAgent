// SPDX-License-Identifier: MIT
// web-access.extension.ts —— wa-pi 内置网络工具（DeepSeek Search/Fetch API）
//
// 本文件由 ensureWebAccessExtension() 复制到 GENERATED_DIR/web-access.ts，
// pi 进程经 -e 加载（主会话 + 子代理同款注入）。
//
// 设计要点：
// - 替代第三方扩展 pi-web-access（2026-10-18 移除）：只保留 web_search / fetch_content
//   两个高频工具，实现改走 DeepSeek 自研搜索引擎（POST /v1/tools/search|fetch，
//   Bearer 鉴权，按次计费 5 元/千次成功请求，各自 QPS 5）。
// - 配置（双开关 + API key）存 <agentDir>/settings.json 的 webSearch 字段，
//   每次工具执行时读取——设置页改动即时生效，无需重建会话。
// - 未配 key / 开关关闭时返回可操作的引导文案（不抛异常，对齐 bridge failResult 语义）。
// - 408/429/5xx 自动重试（官方建议），401/402/403/404/400 不重试（改请求才有意义）。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";

/** 单次请求兜底超时（ms）：DeepSeek 搜索/抓取正常秒级返回，120s 足够宽容 */
const REQUEST_TIMEOUT_MS = 120_000;
/** 可重试状态码（官方：408/429/5xx 等待后重试） */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
/** 最多重试次数（不含首次） */
const MAX_RETRIES = 2;

interface WebSearchConfig {
	searchEnabled: boolean;
	fetchEnabled: boolean;
	apiKey: string;
}

const CONFIG_DEFAULTS: WebSearchConfig = {
	searchEnabled: true,
	fetchEnabled: true,
	apiKey: "",
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
			searchEnabled: ws.searchEnabled ?? CONFIG_DEFAULTS.searchEnabled,
			fetchEnabled: ws.fetchEnabled ?? CONFIG_DEFAULTS.fetchEnabled,
			apiKey: typeof ws.apiKey === "string" ? ws.apiKey : "",
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
			searchEnabled: ws.searchEnabled ?? CONFIG_DEFAULTS.searchEnabled,
			fetchEnabled: ws.fetchEnabled ?? CONFIG_DEFAULTS.fetchEnabled,
			apiKey: typeof ws.apiKey === "string" ? ws.apiKey : "",
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

/** 从 DeepSeek 错误响应体提取 message（OpenAI 兼容格式，可能缺省） */
async function errorMessage(res: Response): Promise<string> {
	try {
		const body = await res.json();
		return body?.error?.message || `HTTP ${res.status}`;
	} catch {
		return `HTTP ${res.status}`;
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 带重试的 DeepSeek POST：408/429/5xx 退避重试（1s/2s），其余状态一次性返回。
 *  返回 { ok: true, data } 或 { ok: false, status, message }。 */
async function deepSeekPost(
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

/** 把 API 失败翻译成模型可操作的中文文案（引导用户/模型下一步动作） */
function failureText(kind: "搜索" | "抓取", status: number, message: string): string {
	if (status === 401)
		return `${kind}失败：DeepSeek API Key 无效或缺失。请到 设置 → 联网 → 互联网搜索 检查 API Key。`;
	if (status === 402)
		return `${kind}失败：DeepSeek 账号余额不足。请到 DeepSeek 平台充值后重试。`;
	if (status === 403)
		return `${kind}失败：请求被 DeepSeek 安全策略拒绝（HTTP 403）。${message}`;
	if (status === 404)
		return `${kind}失败：无法抓取该网页（URL 不可用、被站点拦截、内容类型不受支持或页面无可提取正文）。可换用 wa_web_search 搜索同主题信息。（该次调用不计费）`;
	if (status === 0) return `${kind}失败：${message}（已自动重试仍失败，请检查网络后重试）`;
	return `${kind}失败（HTTP ${status}）：${message}`;
}

// ———— 工具描述（模型选择依据：用途 + 返回内容 + 限制） ————
// 工具名带 wa_ 前缀：避免与插件（如 pi-web-access）注册的 web_search/fetch_content 同名冲突——
// 重名会触发插件安装/加载拦截，导致插件装不上（2026-10-18 用户实测）。

const SEARCH_DESCRIPTION = `联网搜索网页（DeepSeek 搜索引擎）。返回结构化结果列表：标题、链接、短摘要（snippet，约 100-200 字符）、长摘要（summary，约 600-800 字符，适合模型阅读），need_content 为 true 时附带网页正文（每条截断至 4000 字符）。query 支持 site: / -site: / "精确短语" / lang:zh,en / after:2025-01-01 / before:2026 语法。按次计费，请在需要实时信息时使用。`;

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
			if (!cfg.apiKey)
				return textResult(
					"互联网搜索未配置 DeepSeek API Key。请到 设置 → 联网 → 互联网搜索 填入 API Key 后重试。",
					"web_search_no_api_key",
				);
			const query = params.query.trim();
			if (!query || query.length > 128)
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
			const res = await deepSeekPost(SEARCH_URL, cfg.apiKey, body, signal);
			if (!res.ok)
				return textResult(
					failureText("搜索", res.status, res.message),
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
			if (!cfg.apiKey)
				return textResult(
					"网页抓取未配置 DeepSeek API Key。请到 设置 → 联网 → 互联网搜索 填入 API Key 后重试。",
					"fetch_no_api_key",
				);
			if (!isFetchableUrl(params.url))
				return textResult(
					`URL 不合法：仅支持带主机名的 HTTP/HTTPS 地址（收到「${params.url.slice(0, 200)}」）。`,
					"invalid_url",
				);
			const res = await deepSeekPost(
				FETCH_URL,
				cfg.apiKey,
				{ url: params.url },
				signal,
			);
			if (!res.ok)
				return textResult(
					failureText("抓取", res.status, res.message),
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

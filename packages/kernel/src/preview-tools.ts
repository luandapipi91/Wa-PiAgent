// preview-tools.ts —— preview_open 工具：把网址或项目内 html 文件送到用户的内置 HTML 预览面板。
//
// 职责拆分：
// - resolvePreviewTarget：纯函数，校验 url / path 二选一与合法性，产出广播目标（可单测）；
// - createPreviewOpenTool：工具工厂，读项目列表 → 校验 → 广播 preview:open 事件。
// 与 browser_*（无头自动化，只回文本/截图）不同，本工具把页面呈现在用户眼前。

import { isAbsolute, extname } from "node:path";
import type { WSServerEvent } from "@wa-pi/shared";
import { PREVIEW_OPEN_DESCRIPTION } from "@wa-pi/shared";
import { isPathInProjects } from "./ws-server";

/** 广播目标：外部网址或项目内本地 html 文件，二选一 */
export type PreviewTarget =
	| { kind: "url"; url: string }
	| { kind: "local"; path: string };

export type ResolvePreviewResult =
	| { ok: true; target: PreviewTarget }
	| { ok: false; error: string; message: string };

/** url 目标校验：http/https + host 非空 + origin 不得是应用自身地址 */
function resolveUrlTarget(
	url: string,
	selfOrigins: string[],
): ResolvePreviewResult {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return {
			ok: false,
			error: "invalid_url",
			message: `不是合法的网址：${url}`,
		};
	}
	// host 非空为防御性校验：WHATWG 解析器对 http/https 已保证 host 非空
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		!parsed.host
	) {
		return {
			ok: false,
			error: "invalid_url",
			message: `只支持 http/https 网址：${url}`,
		};
	}
	if (selfOrigins.includes(parsed.origin)) {
		return {
			ok: false,
			error: "host_origin_forbidden",
			message: `不能打开应用自身地址（${parsed.origin}），请填写目标页面的真实网址`,
		};
	}
	return { ok: true, target: { kind: "url", url } };
}

/** local 目标校验：绝对路径 + .html/.htm 后缀 + 落在项目工作区内 + 文件存在 */
function resolveLocalTarget(
	path: string,
	projectCwds: string[],
): ResolvePreviewResult {
	if (!isAbsolute(path)) {
		return {
			ok: false,
			error: "invalid_path",
			message: `path 必须是绝对路径：${path}`,
		};
	}
	const ext = extname(path).toLowerCase();
	if (ext !== ".html" && ext !== ".htm") {
		return {
			ok: false,
			error: "invalid_path",
			message: `path 必须是 .html/.htm 文件：${path}`,
		};
	}
	// 复用项目内校验（realpath 口径，防 ../ 穿越与 symlink 逃逸）
	const r = isPathInProjects(
		path,
		projectCwds.map((cwd) => ({ cwd })),
	);
	if (r.kind === "forbidden") {
		return {
			ok: false,
			error: "path_forbidden",
			message: `文件不在任何项目工作区内：${path}`,
		};
	}
	if (r.kind === "missing") {
		return { ok: false, error: "file_not_found", message: `文件不存在：${path}` };
	}
	return { ok: true, target: { kind: "local", path } };
}

/**
 * 校验参数并解析预览目标：url 与 path 二选一。
 * 错误码：missing_target / ambiguous_target / invalid_url / host_origin_forbidden
 *        / invalid_path / path_forbidden / file_not_found。
 */
export function resolvePreviewTarget(
	params: { url?: string; path?: string },
	opts: { projectCwds: string[]; selfOrigins: string[] },
): ResolvePreviewResult {
	const url = params.url?.trim() ?? "";
	const path = params.path?.trim() ?? "";
	if (!url && !path) {
		return {
			ok: false,
			error: "missing_target",
			message: "必须提供 url 或 path 之一",
		};
	}
	if (url && path) {
		return {
			ok: false,
			error: "ambiguous_target",
			message: "url 与 path 只能提供一个，不要同时传",
		};
	}
	return url
		? resolveUrlTarget(url, opts.selfOrigins)
		: resolveLocalTarget(path, opts.projectCwds);
}

/** preview_open 工具返回（结构对齐 bridge 的 BridgeToolResult） */
export interface PreviewOpenResult {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
}

export interface PreviewOpenToolDeps {
	/** 项目列表来源：取所有项目 cwd 作为本地 html 的允许范围 */
	projectStore: { load(): Promise<{ projects: Array<{ cwd?: string }> }> };
	/** 应用自身 origin 列表（kernel 端口相关，惰性取值），命中即拒绝打开 */
	selfOrigins: () => string[];
	/** 事件广播出口（index.ts 接到 server.broadcast → SSE → 前端预览面板） */
	broadcast: (e: WSServerEvent) => void;
}

/** preview_open 工具定义（与 list_contacts 同款 kernel 侧工具格式） */
export interface PreviewOpenTool {
	name: "preview_open";
	description: string;
	inputSchema: {
		type: "object";
		properties: {
			url: { type: "string"; description: string };
			path: { type: "string"; description: string };
		};
		required: string[];
	};
	execute(
		params: { url?: string; path?: string },
		sessionId: string,
	): Promise<PreviewOpenResult>;
}

/** 构建 preview_open 工具：读项目列表 → 解析目标 → 广播 preview:open 事件。 */
export function createPreviewOpenTool(
	deps: PreviewOpenToolDeps,
): PreviewOpenTool {
	return {
		name: "preview_open",
		description: PREVIEW_OPEN_DESCRIPTION,
		inputSchema: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: "http/https 网址（如 http://localhost:5173/）",
				},
				path: {
					type: "string",
					description: "项目内 .html/.htm 文件绝对路径",
				},
			},
			required: [],
		},
		async execute(
			params: { url?: string; path?: string },
			sessionId: string,
		): Promise<PreviewOpenResult> {
			try {
				const { projects } = await deps.projectStore.load();
				const projectCwds = projects
					.map((p) => p.cwd)
					.filter((cwd): cwd is string => !!cwd);
				const resolved = resolvePreviewTarget(params ?? {}, {
					projectCwds,
					selfOrigins: deps.selfOrigins(),
				});
				if (!resolved.ok) {
					return {
						content: [
							{ type: "text", text: `打开预览失败：${resolved.message}` },
						],
						details: { error: resolved.error },
					};
				}
				deps.broadcast({
					type: "preview:open",
					sessionId,
					target: resolved.target,
				});
				const target =
					resolved.target.kind === "url"
						? resolved.target.url
						: resolved.target.path;
				return {
					content: [
						{
							type: "text",
							text: `已在内置预览中打开 ${target}（若未立即显示，请切回该会话查看）`,
						},
					],
					details: { ok: true, target: resolved.target },
				};
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `打开预览失败：${error}` }],
					details: { error },
				};
			}
		},
	};
}

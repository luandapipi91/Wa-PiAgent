/**
 * 文件系统域路由（阶段二·去 WS 化）
 */
import type { RouteRegistrar } from "./types";
import { readJsonBody } from "./types";
import { resolveCwdForFsRequest, uniquePath } from "../ws-server";
import { readdir, readFile, copyFile, stat, mkdir } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { sanitizeOpenEnv } from "@wa-pi/shared";

/** 展开路径开头的 ~ 为 HOME 目录 */
function expandTilde(p: string): string {
	if (p.startsWith("~")) return p.replace(/^~/, homedir());
	return p;
}

/** 系统默认应用打开文件/目录的命令（按平台）：mac open / win start / linux xdg-open */
export function defaultOpenCommand(platform: NodeJS.Platform): string {
	return platform === "darwin"
		? "open"
		: platform === "win32"
			? "start"
			: "xdg-open";
}

/**
 * spawn 系统打开命令：不经 shell（参数数组传递，避免用户路径含特殊字符时的命令注入）。
 * Windows 的 start 是 cmd 内置，经 cmd /c 调用且首参数为空串占位窗口标题。
 * 环境经 sanitizeOpenEnv 净化：剥离 WA_PI_* 内部变量，防止被打开的脚本
 * （如用户项目的 start.command）继承端口/目录变量后 killPort 抢占宿主实例端口。
 */
export function spawnOpen(cmd: string, target: string): void {
	const env = sanitizeOpenEnv(process.env);
	if (process.platform === "win32") {
		spawn("cmd", ["/c", cmd, "", target], { stdio: "ignore", env });
	} else {
		spawn(cmd, [target], { stdio: "ignore", env });
	}
}

/** 列出目录条目：showHidden=false 时过滤点开头项；symlink 解析目标类型（断链按文件处理） */
export async function listDir(
	path: string,
	showHidden?: boolean,
): Promise<DirEntry[]> {
	const dirents = await readdir(expandTilde(path), { withFileTypes: true });
	const entries: DirEntry[] = (
		await Promise.all(
			dirents.map(async (d) => {
				let isDir = d.isDirectory();
				if (d.isSymbolicLink()) {
					try {
						const s = await stat(join(expandTilde(path), d.name));
						isDir = s.isDirectory();
					} catch {
						isDir = false;
					}
				}
				return { name: d.name, isDir };
			}),
		)
	).filter((e) => showHidden || !e.name.startsWith("."));
	return entries;
}

/** 在目录下递归搜索指定文件名（限制深度 5 层），返回第一个匹配的绝对路径 */
async function findFileByBasename(
	root: string,
	name: string,
): Promise<string | null> {
	try {
		const entries = await readdir(root, { recursive: true });
		// readdir recursive 返回相对路径，按深度排序取最浅匹配
		const matches = entries
			.filter((e) => basename(e) === name)
			.sort((a, b) => a.split(/[/\\]/).length - b.split(/[/\\]/).length);
		if (matches.length === 1) return join(root, matches[0]);
	} catch {
		// 目录不可读则跳过
	}
	return null;
}

/** 预览上限：3MB，超过则跳过内容读取 */
const MAX_PREVIEW_BYTES = 3 * 1024 * 1024;

/** 检查文件是否可预览（文本类型 + 图片 + 大小不超标） */
export async function checkPreviewable(
	absPath: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const mime = getMimeType(absPath);
	const isText =
		mime.startsWith("text/") ||
		mime === "application/json" ||
		mime === "application/xml" ||
		mime === "image/svg+xml";
	// 放行图片预览：前端 FileViewer 拿到 base64 拼 data URI 展示，支持缩放
	const isImage = mime.startsWith("image/");
	if (!isText && !isImage)
		return { ok: false, reason: `不支持的文件类型: ${mime}` };
	try {
		const s = await stat(absPath);
		if (s.size > MAX_PREVIEW_BYTES)
			return {
				ok: false,
				reason: `文件过大 (${(s.size / 1024 / 1024).toFixed(1)}MB > ${MAX_PREVIEW_BYTES / 1024 / 1024}MB)`,
			};
	} catch {
		return { ok: false, reason: "无法获取文件信息" };
	}
	return { ok: true };
}
import type { DirEntry } from "@wa-pi/shared";
import { getMimeType } from "../ws-server";

export const registerFsRoutes: RouteRegistrar = (r, callApi, ctx) => {
	r.add("GET", "/api/fs/home", async () =>
		Response.json({ type: "fs:home", home: homedir() }),
	);

	r.add("GET", "/api/fs/roots", async () => {
		if (process.platform === "win32") {
			const roots: string[] = [];
			for (let i = 67; i <= 90; i++) {
				const drive = String.fromCharCode(i) + ":\\";
				if (existsSync(drive)) roots.push(drive);
			}
			return Response.json({ type: "fs:roots", roots });
		}
		return Response.json({ type: "fs:roots", roots: ["/"] });
	});

	// 搜索：进度帧经 callApi 自动转 SSE 总线（带 requestId），最终结果为响应体
	r.add("POST", "/api/fs/search", async (req) => {
		const b = await readJsonBody(req);
		return callApi({ type: "fs:search", ...b });
	});

	r.add("POST", "/api/fs/search/cancel", async (req) => {
		const b = await readJsonBody(req);
		return callApi({ type: "fs:search:cancel", requestId: b.requestId });
	});

	// POST /api/fs/list-dir：列出目录（showHidden=false 时过滤点开头项）
	r.add("POST", "/api/fs/list-dir", async (req) => {
		const b = await readJsonBody(req);
		const { path, showHidden } = b;
		if (typeof path !== "string")
			return Response.json({ error: "缺少 path" }, { status: 400 });
		try {
			const entries = await listDir(path, showHidden);
			return Response.json({ type: "fs:listDir", path, entries });
		} catch (e) {
			return Response.json({
				type: "fs:error",
				path,
				reason: String(e instanceof Error ? e.message : e),
			});
		}
	});

	// POST /api/fs/stat：轻量文件存在性探测（不读内容）
	r.add("POST", "/api/fs/stat", async (req) => {
		const b = await readJsonBody(req);
		const { path } = b;
		if (typeof path !== "string")
			return Response.json({ error: "缺少 path" }, { status: 400 });
		try {
			const absPath = expandTilde(path);
			const exists = existsSync(absPath);
			const isFile = exists && (await stat(absPath)).isFile();
			return Response.json({ type: "fs:stat", path, exists: isFile });
		} catch (e) {
			return Response.json({
				type: "fs:error",
				path,
				reason: String(e instanceof Error ? e.message : e),
			});
		}
	});

	// POST /api/fs/read-file：读取文件为 base64。ENOENT 时按 basename 递归搜索回退。
	r.add("POST", "/api/fs/read-file", async (req) => {
		const b = await readJsonBody(req);
		const { path } = b;
		if (typeof path !== "string")
			return Response.json({ error: "缺少 path" }, { status: 400 });
		try {
			const absPath = expandTilde(path);
			const check = await checkPreviewable(absPath);
			if (!check.ok)
				return Response.json({
					type: "fs:unsupported",
					path,
					reason: check.reason,
				});
			const buffer = await readFile(absPath);
			const content = buffer.toString("base64");
			const mimeType = getMimeType(path);
			return Response.json({ type: "fs:readFile", path, content, mimeType });
		} catch (e) {
			const reason = String(e instanceof Error ? e.message : e);
			// ENOENT 回退：在路径的最近存在祖先目录下递归搜索同名文件
			if (reason.includes("ENOENT")) {
				const resolved = expandTilde(path);
				const name = basename(resolved);
				let searchRoot = dirname(resolved);
				while (searchRoot && !existsSync(searchRoot)) {
					const parent = dirname(searchRoot);
					if (parent === searchRoot) {
						searchRoot = "";
						break;
					}
					searchRoot = parent;
				}
				if (searchRoot && name) {
					try {
						const found = await findFileByBasename(searchRoot, name);
						if (found) {
							const check2 = await checkPreviewable(found);
							if (!check2.ok)
								return Response.json({
									type: "fs:unsupported",
									path: found,
									reason: check2.reason,
								});
							const buffer = await readFile(found);
							const content = buffer.toString("base64");
							const mimeType = getMimeType(found);
							return Response.json({
								type: "fs:readFile",
								path,
								content,
								mimeType,
								resolvedPath: found,
							});
						}
					} catch {
						/* 搜索失败，回退到原始错误 */
					}
				}
			}
			return Response.json({ type: "fs:error", path, reason });
		}
	});

	// POST /api/fs/copy：复制文件/文件夹到项目 uploads
	r.add("POST", "/api/fs/copy", async (req) => {
		const b = await readJsonBody(req);
		const { projectId, source, sessionId } = b;
		if (!projectId || typeof source !== "string") {
			return Response.json(
				{ error: "缺少参数: projectId/source" },
				{ status: 400 },
			);
		}
		try {
			const cwd = await resolveCwdForFsRequest(
				ctx.projectStore,
				projectId,
				sessionId,
			);
			const expandedSource = expandTilde(source);
			const sourceStat = await stat(expandedSource);
			const isDir = sourceStat.isDirectory();
			if (isDir) {
				return Response.json({ type: "fs:copy", path: source });
			}
			const uploadDir = join(cwd, ".wa-pi", "uploads");
			await mkdir(uploadDir, { recursive: true });
			const name = basename(source);
			const destPath = await uniquePath(uploadDir, name);
			await copyFile(expandedSource, destPath);
			return Response.json({ type: "fs:copy", path: destPath });
		} catch (e) {
			return Response.json({
				type: "fs:copy",
				path: "",
				error: String(e instanceof Error ? e.message : e),
			});
		}
	});

	// POST /api/fs/reveal-file：在系统文件管理器中打开文件所在目录。
	// 文件不存在时按 basename 递归搜索回退（与 read-file 一致）。
	r.add("POST", "/api/fs/reveal-file", async (req) => {
		const b = await readJsonBody(req);
		const { path } = b;
		if (typeof path !== "string")
			return Response.json({ error: "缺少 path" }, { status: 400 });
		try {
			let absPath = expandTilde(path);
			if (!existsSync(absPath)) {
				// ENOENT 回退：在最近存在祖先目录下递归搜索同名文件
				const name = basename(absPath);
				let searchRoot = dirname(absPath);
				while (searchRoot && !existsSync(searchRoot)) {
					const parent = dirname(searchRoot);
					if (parent === searchRoot) {
						searchRoot = "";
						break;
					}
					searchRoot = parent;
				}
				if (searchRoot && name) {
					const found = await findFileByBasename(searchRoot, name);
					if (found) absPath = found;
				}
			}
			if (!existsSync(absPath)) {
				return Response.json({
					type: "fs:error",
					path,
					reason: `ENOENT: 文件不存在且搜索无结果: ${absPath}`,
				});
			}
			const dir = dirname(absPath);
			spawnOpen(defaultOpenCommand(process.platform), dir);
			return Response.json({
				type: "fs:reveal-file",
				path,
				resolvedPath: absPath,
			});
		} catch (e) {
			return Response.json({
				type: "fs:error",
				path,
				reason: String(e instanceof Error ? e.message : e),
			});
		}
	});

	// POST /api/fs/open-with-default-app：用系统默认应用打开文件本身（等同双击）。
	// 文件不存在时按 basename 递归搜索回退（与 reveal-file 一致）。
	r.add("POST", "/api/fs/open-with-default-app", async (req) => {
		const b = await readJsonBody(req);
		const { path } = b;
		if (typeof path !== "string")
			return Response.json({ error: "缺少 path" }, { status: 400 });
		try {
			let absPath = expandTilde(path);
			if (!existsSync(absPath)) {
				// ENOENT 回退：在最近存在祖先目录下递归搜索同名文件
				const name = basename(absPath);
				let searchRoot = dirname(absPath);
				while (searchRoot && !existsSync(searchRoot)) {
					const parent = dirname(searchRoot);
					if (parent === searchRoot) {
						searchRoot = "";
						break;
					}
					searchRoot = parent;
				}
				if (searchRoot && name) {
					const found = await findFileByBasename(searchRoot, name);
					if (found) absPath = found;
				}
			}
			if (!existsSync(absPath)) {
				return Response.json({
					type: "fs:error",
					path,
					reason: `ENOENT: 文件不存在且搜索无结果: ${absPath}`,
				});
			}
			// Windows 的 start 首参数是窗口标题，经 spawnOpen 内部 cmd /c 传空串占位
			spawnOpen(defaultOpenCommand(process.platform), absPath);
			return Response.json({
				type: "fs:open-with-default-app",
				path,
				resolvedPath: absPath,
			});
		} catch (e) {
			return Response.json({
				type: "fs:error",
				path,
				reason: String(e instanceof Error ? e.message : e),
			});
		}
	});
};

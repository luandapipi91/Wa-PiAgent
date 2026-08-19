// /api/share/* 分享路由（产物分享 · 固定项目 wapi 工作区模型）
//
// 事实源：workspaceDir（{WA_PI_DIR}/share-workspace）的 state.json。
// upload/deploy 会立即部署到线上；delete/clear 仅改本地，deploy 后才生效。
// cfg.token 为静态注入（生产置空，handler 内每次读最新分享设置，保存后无需重启）；
// cfg.cosFactory / pollIntervalMs 供测试注入。

import { basename, dirname, sep } from "node:path";
import { statSync } from "node:fs";
import { unzipSync } from "fflate";
import type { HttpRouter } from "../http-router";
import type { ShareProgressEvent } from "@wa-pi/shared";
import { readJsonBody } from "./types";
import {
	CF_SHARE_PROJECT_NAME,
	deployToCloudflare,
	getCloudflareAccountId,
	getProjectSubdomain,
} from "../share/cloudflare-pages-client";
import {
	deployWorkspace,
	detectBaseUrl,
	encipherUrl,
	getOrCreateProject,
	getPresetDomain,
	itemShareUrl,
	normalizeDomain,
	SHARE_PROJECT_NAME,
	type CosClient,
} from "../share/edgeone-client";
import { collectZipEntries, hashPaths } from "../share/pack";
import {
	addItem,
	buildDeployZip,
	clearItems,
	loadItems,
	loadLastDeployed,
	MAX_FILE_BYTES,
	pendingCount,
	removeItem,
	renameItem,
	saveLastDeployed,
	SHARE_ID_RE,
	totalSize,
} from "../share/workspace";
import { loadShareSettings } from "../settings-store";

export interface ShareRouteCfg {
	/** 静态 token（测试注入）；为空的场景由 handler 内 loadShareSettings 读取最新值 */
	token: string;
	/** 渠道兜底（测试注入）；生产注册处不再传死值，handler 内 loadShareSettings 恒有默认值 edgeone */
	channel?: string;
	/** 测试注入 fake COS 客户端 */
	cosFactory?: (creds: {
		SecretId: string;
		SecretKey: string;
		Token: string;
	}) => CosClient;
	/** 测试注入隔离的 settings 文件；缺省用真实的 ~/.pi/agent/settings.json */
	settingsFile?: string;
	/** 部署状态轮询间隔（ms），测试传小值让单测秒级完成 */
	pollIntervalMs?: number;
	/** 进度广播（SSE），ws-server 注入 this.broadcast；测试可注入 spy */
	broadcast?: (e: ShareProgressEvent) => void;
	/** 打开分享文件夹的系统打开器（测试注入 spy，避免真实弹 Finder）；缺省按平台 spawn */
	opener?: (dir: string) => void;
}

export function createShareRoutes(
	router: HttpRouter,
	cfg: ShareRouteCfg,
	workspaceDir: string,
): void {
	const wrap = (fn: (req: Request) => Promise<Response>) => {
		return async (req: Request) => {
			try {
				return await fn(req);
			} catch (e: any) {
				return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
			}
		};
	};

	/** 读取最新分享设置并校验 token；未配返回 400 Response */
	async function requireToken(): Promise<
		{ token: string; channel: string; customDomain: string } | Response
	> {
		const latest = await loadShareSettings(cfg.settingsFile);
		const token = latest.token || cfg.token;
		if (!token)
			return Response.json(
				{ error: "未配置分享 Token（设置 → 分享）" },
				{ status: 400 },
			);
		return {
			token,
			channel: latest.channel || cfg.channel || "edgeone",
			customDomain: latest.customDomain,
		};
	}

	/** 进度广播：packing → uploading（真实百分比）→ deploying → done / error */
	const emit = (e: Omit<ShareProgressEvent, "type">) =>
		cfg.broadcast?.({ type: "share:progress", ...e });

	/** 部署当前工作区到线上（按 settings.channel 分派：cloudflare → CF Pages，否则 edgeone）；
	 *  成功写部署快照；全程广播进度。 */
	async function deployNow(
		token: string,
		customDomain: string,
	): Promise<{ url: string; expiresAt: number; channel: string }> {
		const settings = await loadShareSettings(cfg.settingsFile);
		emit({ phase: "packing" });
		const zip = await buildDeployZip(workspaceDir);
		try {
			if (settings.channel === "cloudflare") {
				const files = unzipToFiles(zip);
				const result = await deployToCloudflare({
					token,
					accountId: settings.accountId ?? "",
					files,
					onProgress: (p) => emit(p),
					pollIntervalMs: cfg.pollIntervalMs,
				});
				await saveLastDeployed(workspaceDir, await loadItems(workspaceDir));
				emit({ phase: "done" });
				// expiresAt=0 表示永久（前端按此渲染）；CF 渠道无过期时间
				return { url: result.url, expiresAt: 0, channel: "cloudflare" };
			}

			// 原 edgeone 逻辑不变
			const r = await deployWorkspace({
				token,
				zip,
				customDomain,
				onProgress: (p) => emit(p),
				cosFactory: cfg.cosFactory,
				pollIntervalMs: cfg.pollIntervalMs,
			});
			await saveLastDeployed(workspaceDir, await loadItems(workspaceDir));
			emit({ phase: "done" });
			return { url: r.rootUrl, expiresAt: r.expiresAt, channel: "edgeone" };
		} catch (e) {
			emit({
				phase: "error",
				error: e instanceof Error ? e.message : String(e),
			});
			throw e;
		}
	}

	/** fflate 解压 zip 为 路径 -> Uint8Array（过滤目录条目） */
	function unzipToFiles(zip: Uint8Array): Record<string, Uint8Array> {
		const unzipped = unzipSync(zip);
		const files: Record<string, Uint8Array> = {};
		for (const [path, data] of Object.entries(unzipped)) {
			if (path.endsWith("/")) continue; // 目录
			files[path] = data;
		}
		return files;
	}

	router.add(
		"POST",
		"/api/share/upload",
		wrap(async (req) => {
			const b = await readJsonBody(req);
			const paths: string[] = b.paths ?? [];
			if (paths.length === 0)
				return Response.json({ error: "paths 为空" }, { status: 400 });

			const auth = await requireToken();
			if (auth instanceof Response) return auth;

			// 单文件夹分享：autoName 取文件夹名（下方 L190），但打包 root 统一用 commonRoot——
			// 文件夹本身作为一层保留（/慧来客/dist/...），不展开平铺
			const singleDir =
				paths.length === 1 && statSync(paths[0]).isDirectory() ? paths[0] : null;
			const entries = collectZipEntries(paths, commonRoot(paths));
			if (entries.length === 0)
				return Response.json({ error: "paths 为空" }, { status: 400 });
			const oversized = entries.find((e) => e.data.byteLength > MAX_FILE_BYTES);
			if (oversized)
				return Response.json(
					{ error: `文件超过 25MB 上限: ${oversized.name}` },
					{ status: 413 },
				);

			const id = hashPaths(paths);
			const autoName = singleDir
				? basename(singleDir)
				: entries.length === 1
					? (entries[0].name.split("/").pop() ?? entries[0].name)
					: `${entries.length} 个文件`;
			// 用户指定分享名（文件夹名/URL 子路径，穿透）；缺省用自动名。
			// 同名不再报错，addItem 内部合并（旧文件保留、新文件追加）；此处探测是否发生合并，供前端提示。
			const name =
				typeof b.name === "string" && b.name.trim() ? b.name.trim() : autoName;
			const existed = (await loadItems(workspaceDir)).some((i) => i.name === name);
			let item;
			try {
				item = await addItem(workspaceDir, id, name, entries);
			} catch (e: any) {
				if (/非法字符/.test(e?.message ?? ""))
					return Response.json({ error: e.message }, { status: 409 });
				throw e;
			}

			const { url, expiresAt, channel } = await deployNow(
				auth.token,
				auth.customDomain,
			);
			return Response.json({
				id: item.id,
				name: item.name,
				// 同名合并标志：该分享名之前已存在（本次为追加/覆盖合并）
				merged: existed,
				// 合并后文件总数（前端「已合并」提示用）
				filesCount: item.files.length,
				// 两渠道共用同一 buildDeployZip 布局（{name}/{rel}），统一复用 itemShareUrl。
				// 关键：URL 用「本次分享的文件」而非合并后 item.files 并集计算——
				// 同名合并后再单文件分享，链接直达当次文件（如 /慧来客/b.html），而非退化为目录；
				// 单文件夹分享（不展开）链接带文件夹名：/<name>/<文件夹名>/（否则指向根目录无内容）；
				// 本次多文件仍指向目录（目录已由 buildDeployZip 生成索引页，可正常访问）。
				url: singleDir
					? (() => {
							let u: URL;
							try {
								u = new URL(url);
							} catch {
								// 与 itemShareUrl 同款兜底：url 由内部 encipherUrl 生成，正常不会非法
								throw new Error(`无法解析分享链接: ${url}`);
							}
							u.pathname = `/${item.name}/${basename(singleDir)}/`;
							return u.toString();
						})()
					: itemShareUrl(url, {
							id: item.id,
							name: item.name,
							files: entries.map((e) => e.name),
						}),
				expiresAt,
				projectName: SHARE_PROJECT_NAME,
				channel,
			});
		}),
	);

	router.add(
		"GET",
		"/api/share/list",
		wrap(async () => {
			const items = await loadItems(workspaceDir);
			// 存储上限：云端真实配额无接口可查（EdgeOne/CF 均不可动态获取）→ 不显示，恒 0
			// （此前写死 5GB 会在买套餐后失真；前端对 0 只显示已用量）
			return Response.json({
				items,
				pending: await pendingCount(workspaceDir),
				totalSize: totalSize(items),
				totalLimit: 0,
				// 前端「打开分享文件夹」入口用
				workspaceDir,
			});
		}),
	);

	router.add(
		"POST",
		"/api/share/delete",
		wrap(async (req) => {
			const b = await readJsonBody(req);
			// id 直接拼进文件路径，必须严格校验格式防路径穿越
			if (typeof b.id !== "string" || !SHARE_ID_RE.test(b.id))
				return Response.json({ error: "id 非法" }, { status: 400 });
			await removeItem(workspaceDir, b.id);
			return Response.json({ ok: true });
		}),
	);

	router.add(
		"POST",
		"/api/share/rename",
		wrap(async (req) => {
			const b = await readJsonBody(req);
			if (typeof b.id !== "string" || !SHARE_ID_RE.test(b.id))
				return Response.json({ error: "id 非法" }, { status: 400 });
			if (typeof b.name !== "string" || !b.name.trim())
				return Response.json({ error: "名称不能为空" }, { status: 400 });
			try {
				const item = await renameItem(workspaceDir, b.id, b.name.trim());
				return Response.json({ ok: true, item });
			} catch (e: any) {
				if (/重复|非法字符|不存在/.test(e?.message ?? ""))
					return Response.json({ error: e.message }, { status: 409 });
				throw e;
			}
		}),
	);

	router.add(
		"POST",
		"/api/share/clear",
		wrap(async () => {
			await clearItems(workspaceDir);
			return Response.json({ ok: true });
		}),
	);

	// 打开分享文件夹：浏览器端（dev）没有 Electron 的 showItemInFolder，
	// 由 kernel 直接调系统打开器兜底（macOS open / Windows explorer / Linux xdg-open）
	router.add(
		"POST",
		"/api/share/open-folder",
		wrap(async () => {
			const { mkdir } = await import("node:fs/promises");
			await mkdir(workspaceDir, { recursive: true });
			if (cfg.opener) {
				cfg.opener(workspaceDir);
				return Response.json({ ok: true });
			}
			const { spawn } = await import("node:child_process");
			const cmd =
				process.platform === "darwin"
					? "open"
					: process.platform === "win32"
						? "explorer"
						: "xdg-open";
			const child = spawn(cmd, [workspaceDir], {
				detached: true,
				stdio: "ignore",
			});
			child.unref();
			return Response.json({ ok: true });
		}),
	);

	router.add(
		"POST",
		"/api/share/deploy",
		wrap(async () => {
			const auth = await requireToken();
			if (auth instanceof Response) return auth;
			const { expiresAt } = await deployNow(auth.token, auth.customDomain);
			return Response.json({ ok: true, expiresAt });
		}),
	);

	router.add(
		"POST",
		"/api/share/refresh-link",
		wrap(async (req) => {
			const b = await readJsonBody(req);
			const item = (await loadItems(workspaceDir)).find((i) => i.id === b.id);
			if (!item) return Response.json({ error: "分享不存在" }, { status: 404 });
			// 本地有记录但从未成功部署（不在部署快照里）→ 线上是 404，不出链接
			const deployed = await loadLastDeployed(workspaceDir);
			if (!deployed.some((i) => i.id === item.id))
				return Response.json(
					{ error: "内容尚未部署，请先立即部署" },
					{ status: 409 },
				);
			// 当前渠道实时读取设置；CF 渠道链接公开恒定，幂等返回条目子路径（不重签 token），
			// 拼法与 upload 端点 CF 分支一致：itemShareUrl 复用（单文件指向真实文件、分享名自动编码）
			const settings = await loadShareSettings(cfg.settingsFile);
			if (settings.channel === "cloudflare") {
				// .pages.dev 子域全局唯一：用真实项目子域拼链接，不硬编码 wapi-shares.pages.dev
				const accountId =
					settings.accountId || (await getCloudflareAccountId(settings.token));
				const subdomain = await getProjectSubdomain(
					settings.token,
					accountId,
					CF_SHARE_PROJECT_NAME,
				);
				return Response.json({
					url: itemShareUrl(`https://${subdomain}`, item),
					expiresAt: 0,
					channel: "cloudflare",
				});
			}
			const auth = await requireToken();
			if (auth instanceof Response) return auth;
			const baseUrl = await detectBaseUrl(auth.token);
			const projectId = await getOrCreateProject(
				baseUrl,
				auth.token,
				SHARE_PROJECT_NAME,
			);
			const preset = await getPresetDomain(baseUrl, auth.token, projectId);
			const domain = normalizeDomain(auth.customDomain) || preset;
			const rootUrl = await encipherUrl(baseUrl, auth.token, domain);
			return Response.json({
				url: itemShareUrl(rootUrl, item),
				expiresAt: Date.now() + 3 * 3600_000,
			});
		}),
	);
}

/** 公共父目录：多选路径共同根 */
export function commonRoot(paths: string[]): string {
	let root = dirname(paths[0]);
	for (const p of paths.slice(1)) {
		while (root.length > 1 && !p.startsWith(root + sep)) {
			const parent = dirname(root);
			// 兜底：Windows 跨盘时 dirname("D:\\") 恒等于自身（盘符根），
			// 不退出会死循环；此场景无公共根，保留当前 root 继续处理后续路径。
			if (parent === root) break;
			root = parent;
		}
	}
	return root;
}

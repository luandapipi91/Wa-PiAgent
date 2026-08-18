// /api/share/* 分享路由（产物分享 · 固定项目 wapi 工作区模型）
//
// 事实源：workspaceDir（{WA_PI_DIR}/share-workspace）的 state.json。
// upload/deploy 会立即部署到线上；delete/clear 仅改本地，deploy 后才生效。
// cfg.token 为静态注入（生产置空，handler 内每次读最新分享设置，保存后无需重启）；
// cfg.cosFactory / pollIntervalMs 供测试注入。

import { basename, dirname, sep } from "node:path";
import { statSync } from "node:fs";
import type { HttpRouter } from "../http-router";
import type { ShareProgressEvent } from "@wa-pi/shared";
import { readJsonBody } from "./types";
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
	TOTAL_STORAGE_BYTES,
} from "../share/workspace";
import { loadShareSettings } from "../settings-store";

export interface ShareRouteCfg {
	/** 静态 token（测试注入）；为空的场景由 handler 内 loadShareSettings 读取最新值 */
	token: string;
	channel: string;
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
				return Response.json(
					{ error: e?.message ?? String(e) },
					{ status: 500 },
				);
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
			channel: latest.channel || cfg.channel,
			customDomain: latest.customDomain,
		};
	}

	/** 进度广播：packing → uploading（真实百分比）→ deploying → done / error */
	const emit = (e: Omit<ShareProgressEvent, "type">) =>
		cfg.broadcast?.({ type: "share:progress", ...e });

	/** 部署当前工作区到线上，成功写部署快照；全程广播进度 */
	async function deployNow(
		token: string,
		customDomain: string,
	): Promise<{ rootUrl: string; expiresAt: number }> {
		emit({ phase: "packing" });
		const zip = await buildDeployZip(workspaceDir);
		try {
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
			return { rootUrl: r.rootUrl, expiresAt: r.expiresAt };
		} catch (e) {
			emit({
				phase: "error",
				error: e instanceof Error ? e.message : String(e),
			});
			throw e;
		}
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

			// 单个文件夹分享：以文件夹本身为根，内容平铺到 /<id>/ 下
			// （否则 commonRoot 取父目录，条目会多套一层文件夹名）
			const singleDir =
				paths.length === 1 && statSync(paths[0]).isDirectory()
					? paths[0]
					: null;
			const entries = collectZipEntries(paths, singleDir ?? commonRoot(paths));
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
			// 查重由 addItem 内置（不同 id 同名抛错），此处统一转 409。
			const name = typeof b.name === "string" && b.name.trim()
				? b.name.trim()
				: autoName;
			let item;
			try {
				item = await addItem(workspaceDir, id, name, entries);
			} catch (e: any) {
				if (/重复|非法字符/.test(e?.message ?? ""))
					return Response.json({ error: e.message }, { status: 409 });
				throw e;
			}

			const { rootUrl, expiresAt } = await deployNow(
				auth.token,
				auth.customDomain,
			);
			return Response.json({
				id: item.id,
				name: item.name,
				url: itemShareUrl(rootUrl, item),
				expiresAt,
				projectName: SHARE_PROJECT_NAME,
				channel: auth.channel,
			});
		}),
	);

	router.add(
		"GET",
		"/api/share/list",
		wrap(async () => {
			const items = await loadItems(workspaceDir);
			return Response.json({
				items,
				pending: await pendingCount(workspaceDir),
				totalSize: totalSize(items),
				totalLimit: TOTAL_STORAGE_BYTES,
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
			if (!item)
				return Response.json({ error: "分享不存在" }, { status: 404 });
			// 本地有记录但从未成功部署（不在部署快照里）→ 线上是 404，不出链接
			const deployed = await loadLastDeployed(workspaceDir);
			if (!deployed.some((i) => i.id === item.id))
				return Response.json(
					{ error: "内容尚未部署，请先立即部署" },
					{ status: 409 },
				);
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

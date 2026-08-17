// /api/share/* 分享路由（产物分享）
//
// createShareRoutes 工厂便于单测：cfg.token 为静态注入（ws-server 侧置空，由 handler
// 内每次请求读最新分享设置保证「保存后无需重启」）；historyFile 为 share-history.json
// 路径；rootBase 为测试注入的公共根。cfg.cosFactory 供测试注入 fake COS 客户端，
// 避免真实的网络上传。

import { dirname, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { HttpRouter } from "../http-router";
import { readJsonBody } from "./types";
import { deployShare } from "../share/edgeone-client";
import type { CosClient } from "../share/edgeone-client";
import { buildZip } from "../share/pack";
import {
	appendShare,
	loadShares,
	removeShare,
	type ShareRecord,
} from "../share-store";
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
}

export function createShareRoutes(
	router: HttpRouter,
	cfg: ShareRouteCfg,
	historyFile: string,
	rootBase: string,
): void {
	router.add("POST", "/api/share/upload", async (req) => {
		const b = await readJsonBody(req);
		const paths: string[] = b.paths ?? [];
		if (paths.length === 0)
			return Response.json({ error: "paths 为空" }, { status: 400 });

		// 每次请求读最新分享设置（token/channel），保存后无需重启即生效
		const latest = await loadShareSettings(cfg.settingsFile);
		const token = latest.token || cfg.token;
		if (!token)
			return Response.json(
				{ error: "未配置分享 Token（设置 → 分享）" },
				{ status: 400 },
			);
		const channel = latest.channel || cfg.channel;

		const isZip = paths.length > 1;
		const baseDir = commonRoot(paths);
		const zip = isZip ? buildZip(paths, baseDir) : undefined;
		const result = await deployShare({
			token,
			paths,
			baseDir,
			zip,
			isZip,
			channel,
			cosFactory: cfg.cosFactory,
		});

		const rec: ShareRecord = {
			id: randomUUID(),
			url: result.url,
			projectName: result.projectName,
			channel,
			createdAt: Date.now(),
			expiresAt: result.expiresAt,
			paths,
		};
		await appendShare(historyFile, rec);
		return Response.json({
			url: result.url,
			expiresAt: result.expiresAt,
			projectName: result.projectName,
			channel,
		});
	});

	router.add(
		"GET",
		"/api/share/list",
		async () => Response.json({ shares: await loadShares(historyFile) }),
	);

	router.add("POST", "/api/share/delete", async (req) => {
		const b = await readJsonBody(req);
		await removeShare(historyFile, b.id);
		return Response.json({ ok: true });
	});
}

/** 公共父目录：多选路径共同根 */
export function commonRoot(paths: string[]): string {
	let root = dirname(paths[0]);
	for (const p of paths.slice(1)) {
		while (root.length > 1 && !p.startsWith(root + sep)) root = dirname(root);
	}
	return root;
}

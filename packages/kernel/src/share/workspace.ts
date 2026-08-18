// share/workspace.ts — 分享工作区状态管理（固定项目 wapi 的本地事实源）
//
// 目录结构（dir = {WA_PI_DIR}/share-workspace）：
//   items/<shareId>/...   每个分享一个目录（shareId = 内容 hash）
//   state.json            分享记录 [{ id, name, files, size, createdAt }]
//   last-deployed.json    上次成功部署的快照（算「N 项变更未部署」）
//
// 不变量：state.json 是唯一事实源。手动塞进 items/ 的文件不部署不显示；
// 手动删 items/<id>/ 后，loadItems 读时自动对账剔除记录。

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { strToU8, zipSync } from "fflate";

/** 分享 id 合法格式：hashPaths 产物（sha256 hex 前 12 位）。
 *  所有把 id 拼进文件路径的入口必须先过这个校验，防路径穿越。 */
export const SHARE_ID_RE = /^[0-9a-f]{12}$/;

/** EdgeOne Pages 单文件上限 25MB */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** EdgeOne 免费版总存储上限 5GB */
export const TOTAL_STORAGE_BYTES = 5 * 1024 * 1024 * 1024;

export interface ShareItem {
	id: string;
	name: string;
	/** 相对 items/<id>/ 的文件路径（/ 分隔） */
	files: string[];
	size: number;
	createdAt: number;
}

const stateFile = (dir: string) => join(dir, "state.json");
const lastFile = (dir: string) => join(dir, "last-deployed.json");
const itemsDir = (dir: string) => join(dir, "items");

async function readState(file: string): Promise<{ items: ShareItem[] }> {
	try {
		const raw = JSON.parse(await readFile(file, "utf8"));
		return { items: Array.isArray(raw.items) ? raw.items : [] };
	} catch {
		return { items: [] };
	}
}

async function writeState(file: string, items: ShareItem[]): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify({ items }, null, 2), "utf8");
}

async function dirExists(p: string): Promise<boolean> {
	try {
		return (await stat(p)).isDirectory();
	} catch {
		return false;
	}
}

/** 读取分享记录（读时对账：目录已丢失或 id 非法的记录自动剔除并落盘） */
export async function loadItems(dir: string): Promise<ShareItem[]> {
	const { items } = await readState(stateFile(dir));
	const alive: ShareItem[] = [];
	let dropped = false;
	for (const it of items) {
		// 非法 id（如 "../.."）直接剔除：既防路径穿越，也防脏数据污染部署包
		if (!SHARE_ID_RE.test(it.id)) {
			dropped = true;
			continue;
		}
		if (await dirExists(join(itemsDir(dir), it.id))) alive.push(it);
		else dropped = true;
	}
	if (dropped) await writeState(stateFile(dir), alive);
	return alive;
}

/** 新增/覆盖一个分享：entries 写入 items/<id>/，同 id 覆盖 */
export async function addItem(
	dir: string,
	id: string,
	name: string,
	entries: { name: string; data: Uint8Array }[],
): Promise<ShareItem> {
	const target = join(itemsDir(dir), id);
	await rm(target, { recursive: true, force: true });
	let size = 0;
	for (const e of entries) {
		const fp = join(target, ...e.name.split("/"));
		await mkdir(dirname(fp), { recursive: true });
		await writeFile(fp, e.data);
		size += e.data.byteLength;
	}
	const item: ShareItem = {
		id,
		name,
		files: entries.map((e) => e.name),
		size,
		createdAt: Date.now(),
	};
	const items = (await loadItems(dir)).filter((i) => i.id !== id);
	items.unshift(item);
	await writeState(stateFile(dir), items);
	return item;
}

/** 删除单条（仅本地，不动线上）。id 非法（非 12 位 hex）直接返回 false，不做任何删除 */
export async function removeItem(dir: string, id: string): Promise<boolean> {
	if (!SHARE_ID_RE.test(id)) return false;
	await rm(join(itemsDir(dir), id), { recursive: true, force: true });
	await writeState(
		stateFile(dir),
		(await loadItems(dir)).filter((i) => i.id !== id),
	);
	return true;
}

/** 清空（仅本地，不动线上） */
export async function clearItems(dir: string): Promise<void> {
	await rm(itemsDir(dir), { recursive: true, force: true });
	await writeState(stateFile(dir), []);
}

/** 工作区总字节数（按 state 记录汇总） */
export function totalSize(items: ShareItem[]): number {
	return items.reduce((s, i) => s + i.size, 0);
}

/** 根 index.html：极简静态说明页（避免裸域名 404）。
 *  不做线上索引：分享链接需带时效 eo_token，列表里的是坏链；
 *  且把全部分享名公开渲染有泄密/注入面，spec 明确不要索引页。 */
export function renderIndexHtml(): string {
	return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>WaPi Shares</title></head>
<body><h1>WaPi Shares</h1><p>这是 WaPi 产物分享的托管站点。</p></body></html>
`;
}

/** 按 state.json 记录把工作区打成部署 zip（index.html + <id>/... 全量） */
export async function buildDeployZip(dir: string): Promise<Uint8Array> {
	const items = await loadItems(dir);
	const files: Record<string, Uint8Array> = {
		"index.html": strToU8(renderIndexHtml()),
	};
	for (const it of items) {
		for (const rel of it.files) {
			files[`${it.id}/${rel}`] = new Uint8Array(
				await readFile(join(itemsDir(dir), it.id, ...rel.split("/"))),
			);
		}
	}
	return zipSync(files);
}

/** 上次成功部署快照 */
export async function loadLastDeployed(dir: string): Promise<ShareItem[]> {
	return (await readState(lastFile(dir))).items;
}

export async function saveLastDeployed(
	dir: string,
	items: ShareItem[],
): Promise<void> {
	await writeState(lastFile(dir), items);
}

/** 未部署变更数：当前 state 与上次部署快照对比（新增/删除/内容变化各计 1） */
export async function pendingCount(dir: string): Promise<number> {
	const cur = await loadItems(dir);
	const last = await loadLastDeployed(dir);
	const sig = (i: ShareItem) => `${i.id}:${i.size}:${i.files.join(",")}`;
	const curSet = new Map(cur.map((i) => [i.id, sig(i)]));
	const lastSet = new Map(last.map((i) => [i.id, sig(i)]));
	let n = 0;
	for (const [id, s] of curSet) if (lastSet.get(id) !== s) n++;
	for (const id of lastSet.keys()) if (!curSet.has(id)) n++;
	return n;
}

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

/** 分享名（文件夹名/URL 子路径）合法字符：字母数字、中文、-_. 与空格；
 *  禁止路径分隔符与 . / ..（防路径穿越）。文件夹名与 URL 子路径共用此名。 */
export const SHARE_NAME_RE =
	/^[a-zA-Z0-9\u4e00-\u9fa5\-_. ]{1,64}$/;

/** EdgeOne Pages 单文件上限 25MB */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** EdgeOne 免费版总存储上限 5GB */
export const TOTAL_STORAGE_BYTES = 5 * 1024 * 1024 * 1024;

export interface ShareItem {
	id: string;
	/** 分享名：文件夹名（items/<name>/）与 URL 子路径（/<name>/），全库唯一 */
	name: string;
	/** 相对 items/<name>/ 的文件路径（/ 分隔） */
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
		if (await dirExists(join(itemsDir(dir), it.name))) alive.push(it);
		else dropped = true;
	}
	if (dropped) await writeState(stateFile(dir), alive);
	return alive;
}

/** 新增/覆盖一个分享：entries 写入 items/<name>/（name 为文件夹名，全库唯一）。
 *  同 id（同内容）同名 → 覆盖更新；不同 id 同名 → 抛错（名称重复）。 */
export async function addItem(
	dir: string,
	id: string,
	name: string,
	entries: { name: string; data: Uint8Array }[],
): Promise<ShareItem> {
	if (!SHARE_NAME_RE.test(name))
		throw new Error("分享名称含非法字符（仅限字母/数字/中文/-_./空格）");
	const existing = await loadItems(dir);
	const dup = existing.find((i) => i.name === name && i.id !== id);
	if (dup) throw new Error("已有分享名称重复，请使用其他名字");
	const target = join(itemsDir(dir), name);
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
	const items = existing.filter((i) => i.id !== id);
	items.unshift(item);
	await writeState(stateFile(dir), items);
	return item;
}

/** 重命名分享：校验新名合法 + 全库唯一（不同 id 同名拒绝），文件夹同步改名 */
export async function renameItem(
	dir: string,
	id: string,
	newName: string,
): Promise<ShareItem> {
	if (!SHARE_NAME_RE.test(newName))
		throw new Error("分享名称含非法字符（仅限字母/数字/中文/-_./空格）");
	const items = await loadItems(dir);
	const item = items.find((i) => i.id === id);
	if (!item) throw new Error("分享不存在");
	if (item.name === newName) return item;
	const dup = items.find((i) => i.name === newName && i.id !== id);
	if (dup) throw new Error("已有分享名称重复，请使用其他名字");
	await rm(join(itemsDir(dir), item.name), { recursive: true, force: true });
	await mkdir(join(itemsDir(dir), newName), { recursive: true });
	for (const rel of item.files) {
		const src = join(itemsDir(dir), item.name, ...rel.split("/"));
		const dst = join(itemsDir(dir), newName, ...rel.split("/"));
		await mkdir(dirname(dst), { recursive: true });
		await writeFile(dst, await readFile(src));
	}
	const renamed: ShareItem = { ...item, name: newName };
	await writeState(
		stateFile(dir),
		items.map((i) => (i.id === id ? renamed : i)),
	);
	return renamed;
}

/** 删除单条（仅本地，不动线上）。id 非法（非 12 位 hex）直接返回 false，不做任何删除 */
export async function removeItem(dir: string, id: string): Promise<boolean> {
	if (!SHARE_ID_RE.test(id)) return false;
	const items = await loadItems(dir);
	const target = items.find((i) => i.id === id);
	if (!target) return false;
	await rm(join(itemsDir(dir), target.name), { recursive: true, force: true });
	await writeState(
		stateFile(dir),
		items.filter((i) => i.id !== id),
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

/** 按 state.json 记录把工作区打成部署 zip（index.html + <name>/... 全量） */
export async function buildDeployZip(dir: string): Promise<Uint8Array> {
	const items = await loadItems(dir);
	const files: Record<string, Uint8Array> = {
		"index.html": strToU8(renderIndexHtml()),
	};
	for (const it of items) {
		for (const rel of it.files) {
			files[`${it.name}/${rel}`] = new Uint8Array(
				await readFile(join(itemsDir(dir), it.name, ...rel.split("/"))),
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

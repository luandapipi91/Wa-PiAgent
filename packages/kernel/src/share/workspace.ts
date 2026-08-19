// share/workspace.ts — 分享工作区状态管理（固定项目 wapi 的本地事实源）
//
// 目录结构（dir = {WA_PI_DIR}/share-workspace）：
//   items/<shareId>/...   每个分享一个目录（shareId = 内容 hash）
//   state.json            分享记录 [{ id, name, files, size, createdAt }]
//   last-deployed.json    上次成功部署的快照（算「N 项变更未部署」）
//
// 不变量：state.json 是唯一事实源。手动塞进 items/ 的文件不部署不显示；
// 手动删 items/<id>/ 后，loadItems 读时自动对账剔除记录。

import {
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { strToU8, zipSync } from "fflate";

/** 分享 id 合法格式：hashPaths 产物（sha256 hex 前 12 位）。
 *  所有把 id 拼进文件路径的入口必须先过这个校验，防路径穿越。 */
export const SHARE_ID_RE = /^[0-9a-f]{12}$/;

/** 分享名（文件夹名/URL 子路径）合法字符：字母数字、中文、-_. 与空格；
 *  禁止路径分隔符与 . / ..（防路径穿越）。文件夹名与 URL 子路径共用此名。 */
export const SHARE_NAME_RE = /^[a-zA-Z0-9\u4e00-\u9fa5\-_. ]{1,64}$/;

/** EdgeOne Pages 单文件上限 25MB（应用层全渠道入口拦截，CF 亦有同量级硬限） */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** EdgeOne 免费版总存储上限 5GB（仅 edgeone 渠道；cloudflare 渠道不限，list 端点按 channel 动态返回 0） */
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

/** 递归列目录下相对路径（/ 分隔），按名称排序保证确定性 */
async function listFilesRecursive(root: string, base = ""): Promise<string[]> {
	let out: string[] = [];
	let entries: string[] = [];
	try {
		entries = await readdir(root);
	} catch {
		return out;
	}
	entries.sort();
	for (const name of entries) {
		const p = join(root, name);
		const st = await stat(p).catch(() => null);
		if (!st) continue;
		if (st.isDirectory()) {
			out = out.concat(
				await listFilesRecursive(p, base ? `${base}/${name}` : name),
			);
		} else {
			out.push(base ? `${base}/${name}` : name);
		}
	}
	return out;
}

/** 旧格式（穿透改造前，文件夹 = items/<id>/）迁移：
 *  推断 name（单文件=文件名、多=N 个文件，与自动名规则一致；重名加后缀）、
 *  把文件夹重命名为 items/<name>/、重建 ShareItem。
 *  返回 null 表示 items/<id>/ 不存在（非旧格式）。 */
async function migrateLegacyItem(
	dir: string,
	id: string,
	existing: ShareItem[],
): Promise<ShareItem | null> {
	const legacyDir = join(itemsDir(dir), id);
	if (!(await dirExists(legacyDir))) return null;
	const files = await listFilesRecursive(legacyDir);
	const baseName =
		files.length === 1
			? (files[0].split("/").pop() ?? files[0])
			: `${files.length} 个文件`;
	let name = baseName;
	let n = 2;
	while (
		existing.some((i) => i.name === name) ||
		(await dirExists(join(itemsDir(dir), name)))
	) {
		name = `${baseName} ${n++}`;
	}
	let size = 0;
	for (const rel of files) {
		const fp = join(legacyDir, ...rel.split("/"));
		size += (await stat(fp).catch(() => ({ size: 0 }))).size ?? 0;
	}
	await rename(legacyDir, join(itemsDir(dir), name));
	return {
		id,
		name,
		files,
		size,
		createdAt: Date.now(),
	};
}

/** 读取分享记录（读时对账：目录已丢失或 id 非法的记录自动剔除并落盘；
 *  旧格式 items/<id>/ 文件夹自动迁移到 items/<name>/；items/ 下孤儿 id 文件夹恢复为记录）。 */
export async function loadItems(dir: string): Promise<ShareItem[]> {
	const { items } = await readState(stateFile(dir));
	const alive: ShareItem[] = [];
	let changed = false;
	for (const it of items) {
		// 非法 id（如 "../.."）直接剔除：既防路径穿越，也防脏数据污染部署包
		if (!SHARE_ID_RE.test(it.id)) {
			changed = true;
			continue;
		}
		if (await dirExists(join(itemsDir(dir), it.name))) {
			alive.push(it);
		} else {
			// 新格式目录缺失：回退检查旧格式 items/<id>/（穿透改造前的分享）→ 迁移恢复
			const migrated = await migrateLegacyItem(dir, it.id, alive);
			if (migrated) {
				alive.push(migrated);
				changed = true;
			} else {
				changed = true;
			}
		}
	}
	// 扫描 items/ 下孤儿 id 文件夹（state 缺失/被清空但文件还在的旧分享）→ 恢复
	let orphans: string[] = [];
	try {
		orphans = await readdir(itemsDir(dir));
	} catch {
		orphans = [];
	}
	for (const name of orphans) {
		if (!SHARE_ID_RE.test(name)) continue;
		if (alive.some((i) => i.id === name)) continue;
		const recovered = await migrateLegacyItem(dir, name, alive);
		if (recovered) {
			alive.push(recovered);
			changed = true;
		}
	}
	if (changed) await writeState(stateFile(dir), alive);
	return alive;
}

/** 统计目录下给定相对文件列表的总字节数（stat 失败的文件计 0，不抛错） */
async function dirSizeOf(dir: string, files: string[]): Promise<number> {
	let size = 0;
	for (const rel of files) {
		const fp = join(dir, ...rel.split("/"));
		size += (await stat(fp).catch(() => ({ size: 0 }))).size ?? 0;
	}
	return size;
}

/** 新增/合并一个分享：entries 写入 items/<name>/（name 为文件夹名）。
 *  同名（同 id 或不同 id）→ 合并：旧文件保留、新文件追加、同路径新覆盖旧；
 *  记录合并为一条（files 并集、size 重算、createdAt=本次时间）。 */
export async function addItem(
	dir: string,
	id: string,
	name: string,
	entries: { name: string; data: Uint8Array }[],
): Promise<ShareItem> {
	if (!SHARE_NAME_RE.test(name))
		throw new Error("分享名称含非法字符（仅限字母/数字/中文/-_./空格）");
	const existing = await loadItems(dir);
	const old = existing.find((i) => i.name === name);
	const target = join(itemsDir(dir), name);
	// 合并语义：不删旧目录，旧文件保留；新文件写入（同路径 writeFile 自然覆盖）
	await mkdir(target, { recursive: true });
	for (const e of entries) {
		const fp = join(target, ...e.name.split("/"));
		await mkdir(dirname(fp), { recursive: true });
		await writeFile(fp, e.data);
	}
	// files 并集去重（旧文件 + 新文件）。
	// 旧目录可能被用户改过（删/改名文件）：只保留磁盘上实际存在的旧文件，
	// 否则 state 引用缺失文件，后续 buildDeployZip 打包会 ENOENT（虽已容错跳过，但记录应自洽）
	const existingFiles = [];
	for (const rel of old?.files ?? []) {
		const fp = join(target, ...rel.split("/"));
		if (await stat(fp).catch(() => null)) existingFiles.push(rel);
	}
	const files = [
		...new Set([...existingFiles, ...entries.map((e) => e.name)]),
	];
	const size = await dirSizeOf(target, files);
	const item: ShareItem = {
		id,
		name,
		files,
		size,
		createdAt: Date.now(),
	};
	// 去掉旧记录（同 id 覆盖更新，或同 name 合并）
	const items = existing.filter((i) => i.id !== id && i.name !== name);
	items.unshift(item);
	await writeState(stateFile(dir), items);
	return item;
}

/** 重命名分享：校验新名合法；目标同名时合并（源目录文件移动进目标目录，同路径覆盖），
 *  目标记录保留 id，files 并集；目标不存在则原子改名。 */
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
	const srcDir = join(itemsDir(dir), item.name);
	const dstDir = join(itemsDir(dir), newName);
	if (await dirExists(dstDir)) {
		// 合并：把源目录文件逐个移入目标目录（同路径覆盖），再删源目录
		for (const rel of item.files) {
			const s = join(srcDir, ...rel.split("/"));
			const d = join(dstDir, ...rel.split("/"));
			await mkdir(dirname(d), { recursive: true });
			await rename(s, d).catch(async () => {
				// 跨设备/目标已存在且平台不支持覆盖时退化为复制
				const data = await readFile(s);
				await writeFile(d, data);
				await rm(s, { force: true });
			});
		}
		await rm(srcDir, { recursive: true, force: true });
		const target = items.find((i) => i.name === newName);
		const files = [...new Set([...(target?.files ?? []), ...item.files])];
		const size = await dirSizeOf(dstDir, files);
		const merged: ShareItem = target
			? { ...target, files, size }
			: { ...item, name: newName, files, size };
		await writeState(
			stateFile(dir),
			items.filter((i) => i.id !== id && i.name !== newName).concat([merged]),
		);
		return merged;
	}
	// 目标目录不存在：原子改名（同盘 rename）
	await rename(srcDir, dstDir);
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
/** 分享目录索引页：列出该目录内全部文件（相对链接），供多文件/合并后的目录 URL 直接访问。
 *  EdgeOne 目录 URL 带 eo_token/eo_time query——点击子链接会丢 query 导致 401，
 *  故用脚本从 location.search 读取 query 拼到每个链接上（仅本目录，不泄露其他分享）。 */
function renderDirIndexHtml(name: string, files: string[]): string {
	const esc = (s: string) =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
	const items = files
		.map(
			(rel) => `<li><a class="file-link" href="${esc(rel)}">${esc(rel)}</a></li>`,
		)
		.join("\n");
	return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>${esc(name)}</title></head>
<body><h1>${esc(name)}</h1><ul>
${items}
</ul>
<script>
// 保留目录 URL 携带的 token query（EdgeOne eo_token/eo_time），否则子文件链接 401
document.querySelectorAll(".file-link").forEach(function (a) {
  var href = a.getAttribute("href");
  if (href && location.search) a.setAttribute("href", href + location.search);
});
</script>
</body></html>`;
}

export async function buildDeployZip(dir: string): Promise<Uint8Array> {
	const items = await loadItems(dir);
	const files: Record<string, Uint8Array> = {
		"index.html": strToU8(renderIndexHtml()),
	};
	for (const it of items) {
		for (const rel of it.files) {
			// 容错：state 引用的文件在磁盘缺失（用户改过分享目录/手动删）时跳过，
			// 不崩溃、不进部署包——否则 buildDeployZip 整体失败，部署链路全断
			const data = await readFile(
				join(itemsDir(dir), it.name, ...rel.split("/")),
			).catch(() => null);
			if (data === null) continue;
			files[`${it.name}/${rel}`] = new Uint8Array(data);
		}
		// 目录索引页：仅当用户分享的文件里没有 index.html 时生成（有则用户文件作目录入口，不覆盖）
		if (!it.files.includes("index.html")) {
			files[`${it.name}/index.html`] = strToU8(
				renderDirIndexHtml(it.name, it.files),
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
	// 签名含 name：重命名（内容不变但名称变）也算未部署变更——线上路径/文件夹名需重新部署生效
	const sig = (i: ShareItem) =>
		`${i.id}:${i.name}:${i.size}:${i.files.join(",")}`;
	const curSet = new Map(cur.map((i) => [i.id, sig(i)]));
	const lastSet = new Map(last.map((i) => [i.id, sig(i)]));
	let n = 0;
	for (const [id, s] of curSet) if (lastSet.get(id) !== s) n++;
	for (const id of lastSet.keys()) if (!curSet.has(id)) n++;
	return n;
}

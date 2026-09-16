// 分享空间（CF 多空间）核心逻辑单测：
// 1. groupItemsBySpace：按 cfSpaceId 分组部署（缺失/"default" 归默认空间——存量数据兼容）
// 2. buildNewSpace：空间 CRUD 校验（重名/重项目名/非法项目名）
// 3. assertSpaceDeletable：有分享拒绝删除、默认空间不可删、未知空间报不存在
// 4. resolveShareSpace：缺失/未知空间 id 兜底默认空间
// 5. addItem 多空间语义：同名仅同空间合并；buildDeployZip 按空间过滤打包
// 6. saveShareSettings：未传 spaces 保留已存空间列表（前端保存设置不冲掉空间映射）
import { test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import {
	buildNewSpace,
	assertSpaceDeletable,
	resolveShareSpace,
} from "../src/share/spaces";
import { groupItemsBySpace } from "../src/share/workspace";
import { addItem, buildDeployZip } from "../src/share/workspace";
import { loadShareSettings, saveShareSettings } from "../src/settings-store";
import { KernelError } from "../src/kernel-error";
import { unzipSync } from "fflate";

let dir: string;
let workspaceDir: string;
let settingsFile: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "share-spaces-"));
	workspaceDir = join(dir, "share-workspace");
	settingsFile = join(dir, "settings.json");
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** 造一条内存分享记录（不落盘，供分组/删除校验用） */
const item = (
	id: string,
	name: string,
	cfSpaceId?: string,
): {
	id: string;
	name: string;
	files: string[];
	size: number;
	createdAt: number;
	cfSpaceId?: string;
} => ({
	id,
	name,
	files: ["a.txt"],
	size: 1,
	createdAt: 1,
	...(cfSpaceId ? { cfSpaceId } : {}),
});

// ===== groupItemsBySpace：按 cfSpaceId 分组 =====

test("groupItemsBySpace：按 cfSpaceId 分组，缺失或 default 归默认空间", () => {
	const groups = groupItemsBySpace([
		item("aaaaaaaaaaaa", "a"), // 无字段（存量）
		item("bbbbbbbbbbbb", "b", "default"),
		item("cccccccccccc", "c", "sp1"),
		item("dddddddddddd", "d", "sp1"),
	]);
	expect(groups.get("default")!.map((i) => i.name)).toEqual(["a", "b"]);
	expect(groups.get("sp1")!.map((i) => i.name)).toEqual(["c", "d"]);
	expect(groups.size).toBe(2);
});

test("groupItemsBySpace：空列表返回空分组", () => {
	expect(groupItemsBySpace([]).size).toBe(0);
});

// ===== buildNewSpace：新增空间校验 =====

test("buildNewSpace：合法输入生成空间（短随机 id、透传项目名）", () => {
	const sp = buildNewSpace("博客", "wapi-share-blog", []);
	expect(sp.name).toBe("博客");
	expect(sp.projectName).toBe("wapi-share-blog");
	expect(sp.id).toMatch(/^[0-9a-f]{8}$/);
	expect(sp.createdAt).toBeGreaterThan(0);
});

test("buildNewSpace：项目名非法（大写/下划线/前导连字符/超长/空）全部拒绝", () => {
	for (const bad of [
		"UpperCase",
		"with_underscore",
		"-leading-dash",
		"a".repeat(59), // CF 上限 58
		"",
		"含中文",
	]) {
		expect(() => buildNewSpace("x", bad, [])).toThrow(KernelError);
	}
	// 边界合法：58 字符、纯数字开头
	expect(() => buildNewSpace("x", "0".repeat(58), [])).not.toThrow();
});

test("buildNewSpace：显示名必填", () => {
	expect(() => buildNewSpace("  ", "ok-name", [])).toThrow(KernelError);
});

test("buildNewSpace：与已有空间重名/重项目名拒绝", () => {
	const existing = [buildNewSpace("博客", "wapi-share-blog", [])];
	// KernelError.message = code（构造器 super(code)），用 code 断言具体冲突类型
	try {
		buildNewSpace("博客", "other-name", existing);
		throw new Error("应拒绝重名");
	} catch (e) {
		expect((e as KernelError).code).toBe("share.spaceNameConflict");
	}
	try {
		buildNewSpace("另一个", "wapi-share-blog", existing);
		throw new Error("应拒绝重项目名");
	} catch (e) {
		expect((e as KernelError).code).toBe("share.spaceProjectConflict");
	}
	// 与内置默认空间项目名冲突也拒绝
	try {
		buildNewSpace("另一个", "wapi-shares", []);
		throw new Error("应拒绝与默认空间重项目名");
	} catch (e) {
		expect((e as KernelError).code).toBe("share.spaceProjectConflict");
	}
});

// ===== assertSpaceDeletable：删除空间校验 =====

test("assertSpaceDeletable：默认空间不可删除", () => {
	expect(() => assertSpaceDeletable("default", [], [])).toThrow(KernelError);
});

test("assertSpaceDeletable：空间不存在报错", () => {
	expect(() => assertSpaceDeletable("nosuch", [], [])).toThrow(KernelError);
});

test("assertSpaceDeletable：空间下有分享拒绝删除", () => {
	const spaces = [buildNewSpace("博客", "wapi-blog", [])];
	expect(() =>
		assertSpaceDeletable(spaces[0].id, spaces, [
			item("aaaaaaaaaaaa", "a", spaces[0].id),
		]),
	).toThrow(KernelError);
});

test("assertSpaceDeletable：空空间可删除（不抛错）", () => {
	const spaces = [buildNewSpace("博客", "wapi-blog", [])];
	expect(() => assertSpaceDeletable(spaces[0].id, spaces, [])).not.toThrow();
});

// ===== resolveShareSpace：解析空间 =====

test("resolveShareSpace：缺失/未知 id 兜底默认空间（wapi-shares）", () => {
	expect(resolveShareSpace([], undefined).projectName).toBe("wapi-shares");
	expect(resolveShareSpace([], "default").projectName).toBe("wapi-shares");
	expect(resolveShareSpace([], "gone").projectName).toBe("wapi-shares");
	const spaces = [buildNewSpace("博客", "wapi-blog", [])];
	expect(resolveShareSpace(spaces, spaces[0].id).projectName).toBe("wapi-blog");
});

// ===== addItem 多空间语义 =====

test("addItem：同名同空间合并；同名不同空间保持独立（隔离）", async () => {
	mkdirSync(join(workspaceDir, "items"), { recursive: true });
	await addItem(workspaceDir, "aaaaaaaaaaaa", "docs", [
		{ name: "a.txt", data: new Uint8Array([1]) },
	]);
	// 同名同空间（默认）→ 合并为一条
	await addItem(workspaceDir, "bbbbbbbbbbbb", "docs", [
		{ name: "b.txt", data: new Uint8Array([2]) },
	]);
	// 同名但 cfSpaceId=sp1 → 独立记录，不得并入默认空间那条
	const spItem = await addItem(
		workspaceDir,
		"cccccccccccc",
		"docs",
		[{ name: "c.txt", data: new Uint8Array([3]) }],
		"sp1",
	);
	expect(spItem.cfSpaceId).toBe("sp1");
	const { loadItems } = await import("../src/share/workspace");
	const items = await loadItems(workspaceDir);
	expect(items).toHaveLength(2);
	const def = items.find((i) => !i.cfSpaceId)!;
	expect(def.files.sort()).toEqual(["a.txt", "b.txt"]);
	expect(items.find((i) => i.cfSpaceId === "sp1")!.files).toEqual(["c.txt"]);
});

test("addItem：存量记录（无 cfSpaceId）视为默认空间参与同名合并", async () => {
	mkdirSync(join(workspaceDir, "items"), { recursive: true });
	await addItem(workspaceDir, "aaaaaaaaaaaa", "docs", [
		{ name: "a.txt", data: new Uint8Array([1]) },
	]);
	await addItem(workspaceDir, "bbbbbbbbbbbb", "docs", [
		{ name: "b.txt", data: new Uint8Array([2]) },
		// 不传 cfSpaceId = 默认空间 → 与上面的存量同名记录合并
	]);
	const { loadItems } = await import("../src/share/workspace");
	const items = await loadItems(workspaceDir);
	expect(items).toHaveLength(1);
	expect(items[0].files.sort()).toEqual(["a.txt", "b.txt"]);
});

// ===== buildDeployZip 按空间过滤 =====

test("buildDeployZip：filter 只打包指定空间的文件", async () => {
	mkdirSync(join(workspaceDir, "items"), { recursive: true });
	await addItem(workspaceDir, "aaaaaaaaaaaa", "a", [
		{ name: "a.txt", data: new Uint8Array([1]) },
	]);
	await addItem(
		workspaceDir,
		"cccccccccccc",
		"c",
		[{ name: "c.txt", data: new Uint8Array([3]) }],
		"sp1",
	);
	const groups = groupItemsBySpace(
		await import("../src/share/workspace").then((m) => m.loadItems(workspaceDir)),
	);
	const sp1 = groups.get("sp1")!;
	const zip = await buildDeployZip(workspaceDir, (it) =>
		sp1.some((x) => x.id === it.id),
	);
	const files = Object.keys(unzipSync(zip));
	expect(files).toContain("c/c.txt");
	expect(files).not.toContain("a/a.txt");
	// 全量打包（无 filter）行为不变
	const all = Object.keys(unzipSync(await buildDeployZip(workspaceDir)));
	expect(all).toContain("a/a.txt");
	expect(all).toContain("c/c.txt");
});

// ===== saveShareSettings：spaces 保留链路 =====

test("saveShareSettings：未传 spaces 保留已存列表；显式传入覆盖", async () => {
	await saveShareSettings(
		{ token: "t", channel: "cloudflare", customDomain: "", accountId: "acc" },
		settingsFile,
	);
	const sp = buildNewSpace("博客", "wapi-blog", []);
	await saveShareSettings(
		{
			token: "t",
			channel: "cloudflare",
			customDomain: "",
			accountId: "acc",
			spaces: [sp],
		},
		settingsFile,
	);
	const loaded = await loadShareSettings(settingsFile);
	expect(loaded.spaces).toHaveLength(1);
	expect(loaded.spaces![0].projectName).toBe("wapi-blog");
	// 前端保存设置（不带 spaces）不冲掉空间映射
	await saveShareSettings(
		{ token: "t2", channel: "cloudflare", customDomain: "", accountId: "acc" },
		settingsFile,
	);
	const again = await loadShareSettings(settingsFile);
	expect(again.spaces).toHaveLength(1);
	expect(again.token).toBe("t2");
	// 显式传空数组 → 清空（删空间走这里）
	await saveShareSettings(
		{
			token: "t2",
			channel: "cloudflare",
			customDomain: "",
			accountId: "acc",
			spaces: [],
		},
		settingsFile,
	);
	expect((await loadShareSettings(settingsFile)).spaces).toHaveLength(0);
});

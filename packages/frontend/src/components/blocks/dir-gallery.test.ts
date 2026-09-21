// 同目录画廊纯函数单测：目录路径推导、项目工作区判断、目录项 → 媒体清单、当前项定位。
import { test, expect } from "bun:test";
import type { MediaItem } from "./media-utils";
import {
	dirOf,
	indexOfPath,
	isInAnyCwd,
	joinPath,
	mediaItemsFromEntries,
} from "./dir-gallery";

test("dirOf：取所在目录，反斜杠归一并对齐正斜杠", () => {
	expect(dirOf("/a/b/c.png")).toBe("/a/b");
	expect(dirOf("C:\\a\\b\\c.png")).toBe("C:/a/b");
	expect(dirOf("/a/c.png")).toBe("/a");
});

test("joinPath：目录与文件名拼接（避免双斜杠、兼容反斜杠目录）", () => {
	expect(joinPath("/a/b", "c.png")).toBe("/a/b/c.png");
	expect(joinPath("/a/b/", "c.png")).toBe("/a/b/c.png");
	expect(joinPath("C:\\a\\b", "c.png")).toBe("C:/a/b/c.png");
});

test("mediaItemsFromEntries：只留图片/视频、排除目录，按名称自然序（b2 在 b10 前）", () => {
	const items = mediaItemsFromEntries("/dir", [
		{ name: "b10.png", isDir: false },
		{ name: "sub", isDir: true },
		{ name: "a.mp4", isDir: false },
		{ name: "notes.txt", isDir: false },
		{ name: "b2.png", isDir: false },
		{ name: "cover.webp", isDir: false },
	]);
	expect(items.map((i) => i.name)).toEqual([
		"a.mp4",
		"b2.png",
		"b10.png",
		"cover.webp",
	]);
	expect(items[0]).toEqual({ src: "/dir/a.mp4", kind: "video", name: "a.mp4" });
	expect(items[1].kind).toBe("image");
});

test("mediaItemsFromEntries：无媒体时返回空数组", () => {
	expect(
		mediaItemsFromEntries("/dir", [
			{ name: "a.txt", isDir: false },
			{ name: "sub", isDir: true },
		]),
	).toEqual([]);
});

test("isInAnyCwd：工作区内的子路径命中，工作区自身也算命中", () => {
	expect(isInAnyCwd("/proj/a.png", ["/proj"])).toBe(true);
	expect(isInAnyCwd("/proj/sub/a.png", ["/proj"])).toBe(true);
	expect(isInAnyCwd("/proj", ["/proj"])).toBe(true);
});

test("isInAnyCwd：仅前缀相同而非子路径不算命中（/project-x 不在 /proj 内）", () => {
	expect(isInAnyCwd("/project-x/a.png", ["/proj"])).toBe(false);
	expect(isInAnyCwd("/other/a.png", ["/proj"])).toBe(false);
});

test("isInAnyCwd：Windows 盘符大小写不同仍命中，反斜杠路径也命中", () => {
	expect(isInAnyCwd("C:/Proj/a.png", ["c:/proj"])).toBe(true);
	expect(isInAnyCwd("C:\\proj\\a.png", ["C:/proj"])).toBe(true);
});

test("indexOfPath：按绝对路径定位下标（反斜杠/大小写归一），找不到返回 -1", () => {
	const items: MediaItem[] = [
		{ src: "/d/a.png", kind: "image", name: "a.png" },
		{ src: "/d/b.png", kind: "image", name: "b.png" },
	];
	expect(indexOfPath(items, "/d/b.png")).toBe(1);
	expect(indexOfPath(items, "\\d\\a.png")).toBe(0);
	expect(indexOfPath(items, "/d/z.png")).toBe(-1);
});

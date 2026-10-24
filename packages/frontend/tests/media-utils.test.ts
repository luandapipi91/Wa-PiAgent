// media-utils.test.ts — collectMediaItems 按解析后绝对路径去重（画廊同图重复回归）
// 背景：agent 回复里同一张图常以绝对路径与相对文件名并存（如 `/w/123/image2.png` 与
// `image2.png`），旧去重按 src 字符串精确比较 → 画廊同一张图出现两次。
import { describe, test, expect, beforeEach } from "bun:test";
import { collectMediaItems, sameFilePath } from "../src/components/blocks/media-utils";
import { useProjectsStore } from "../src/store/projects";

describe("collectMediaItems：按解析后绝对路径去重", () => {
	beforeEach(() => {
		useProjectsStore.setState({
			projects: [
				{ id: "__system__", name: "默认工作区", cwd: "/w/workdir", createdAt: 0 },
			],
			sessions: [
				{
					id: "s1",
					projectId: "__system__",
					primaryAgent: "dev",
					title: "t",
					createdAt: 123,
					lastActivity: 0,
					piSessionFile: "",
				},
			],
		});
	});

	test("绝对路径与相对文件名指向同一物理文件时只保留一项（先出现者）", () => {
		const text =
			"产出：`/w/workdir/123/image2.png`\n\n两张图并存：`image.png`、`image2.png`";
		const items = collectMediaItems(text, "s1");
		expect(items.map((i) => i.name)).toEqual(["image2.png", "image.png"]);
	});

	test("不同文件不去重；同写法重复出现仍按 src 去重（不回归）", () => {
		const text = "`image.png`、`image.png`、`other.png`";
		const items = collectMediaItems(text, "s1");
		expect(items.map((i) => i.name)).toEqual(["image.png", "other.png"]);
	});
});

describe("sameFilePath：路径同一性比较", () => {
	test("反斜杠 / 正斜杠混用视为同一文件（Windows 上传路径 vs 画廊归一化 src）", () => {
		expect(
			sameFilePath(
				"C:\\work\\demo\\.wa-pi\\uploads\\a.png",
				"C:/work/demo/.wa-pi/uploads/a.png",
			),
		).toBe(true);
	});

	test("盘符与文件名大小写不敏感", () => {
		expect(
			sameFilePath(
				"C:/Work/Demo/.wa-pi/uploads/A.PNG",
				"c:/work/demo/.wa-pi/uploads/a.png",
			),
		).toBe(true);
	});

	test("重复分隔符归一后相等；不同文件 / 不同目录不相等", () => {
		expect(sameFilePath("/w//demo///a.png", "/w/demo/a.png")).toBe(true);
		expect(sameFilePath("/w/demo/a.png", "/w/demo/b.png")).toBe(false);
		expect(sameFilePath("/w/demo/a.png", "/w/other/a.png")).toBe(false);
	});
});

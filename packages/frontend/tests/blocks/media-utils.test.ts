import { test, expect } from "bun:test";
import {
	resolveMediaSrc,
	fileNameOf,
	joinBaseDir,
	matchVideoParagraph,
	matchFencedMedia,
	splitMediaParagraphs,
	collectMediaItems,
	resolveCopyPath,
	mediaUrlTransform,
} from "../../src/components/blocks/media-utils";
import { useProjectsStore } from "../../src/store/projects";

// resolveAbsolutePath 相对路径分支依赖项目 cwd（与 FilePill 同一口径）
useProjectsStore.setState({
	projects: [{ id: "p1", cwd: "/home/me/proj" } as any],
	sessions: [{ id: "s1", projectId: "p1" } as any],
});

test("resolveMediaSrc：http(s)/data/blob 原样返回", () => {
	expect(resolveMediaSrc("https://x.com/a.png", "s1")).toBe("https://x.com/a.png");
	expect(resolveMediaSrc("http://x.com/a.png", "s1")).toBe("http://x.com/a.png");
	expect(resolveMediaSrc("data:image/png;base64,AAA", "s1")).toBe(
		"data:image/png;base64,AAA",
	);
	expect(resolveMediaSrc("blob:http://x/1", "s1")).toBe("blob:http://x/1");
});

test("resolveMediaSrc：POSIX 绝对路径 → /file?path=", () => {
	expect(resolveMediaSrc("/home/me/proj/out/a.png", "s1")).toBe(
		"/file?path=" + encodeURIComponent("/home/me/proj/out/a.png"),
	);
});

test("resolveMediaSrc：Windows 盘符路径归一化正斜杠 → /file?path=", () => {
	expect(resolveMediaSrc("C:\\work\\a.png", "s1")).toBe(
		"/file?path=" + encodeURIComponent("C:/work/a.png"),
	);
});

test("resolveMediaSrc：相对路径拼项目 cwd → /file?path=", () => {
	expect(resolveMediaSrc("out/a.png", "s1")).toBe(
		"/file?path=" + encodeURIComponent("/home/me/proj/out/a.png"),
	);
});

test("fileNameOf：去 query/hash，兼容反斜杠", () => {
	expect(fileNameOf("/a/b/cat.png")).toBe("cat.png");
	expect(fileNameOf("C:\\x\\dog.jpg")).toBe("dog.jpg");
	expect(fileNameOf("https://x.com/a.png?v=2#f")).toBe("a.png");
});

test("joinBaseDir：baseDir 归一化后拼接", () => {
	expect(joinBaseDir("C:\\work\\docs\\", "img/a.png")).toBe("C:/work/docs/img/a.png");
});

test("matchVideoParagraph：裸路径整段命中", () => {
	expect(matchVideoParagraph("/home/me/proj/out/clip.mp4")).toEqual({
		src: "/home/me/proj/out/clip.mp4",
		name: "clip.mp4",
	});
});

test("matchVideoParagraph：markdown 链接形式命中，名字取链接文本", () => {
	expect(matchVideoParagraph("[演示视频](out/demo.webm)")).toEqual({
		src: "out/demo.webm",
		name: "演示视频",
	});
});

test("matchVideoParagraph：各视频扩展名 + 大写 + query", () => {
	for (const ext of ["mp4", "webm", "mov", "mkv", "avi", "m4v"]) {
		expect(matchVideoParagraph(`/v/c.${ext}`)).not.toBeNull();
	}
	expect(matchVideoParagraph("/v/C.MP4")).not.toBeNull();
	expect(matchVideoParagraph("https://x.com/v.mp4?token=1")).not.toBeNull();
});

test("matchVideoParagraph：句中夹杂路径不命中（走 FilePill 现状）", () => {
	expect(matchVideoParagraph("视频已保存到 /path/xxx.mp4")).toBeNull();
	expect(matchVideoParagraph("/path/xxx.mp4 已生成")).toBeNull();
});

test("matchVideoParagraph：非视频扩展名不命中", () => {
	expect(matchVideoParagraph("/a/b.png")).toBeNull();
	expect(matchVideoParagraph("/a/b.mp4.bak")).toBeNull();
	expect(matchVideoParagraph("普通文本")).toBeNull();
});

test("splitMediaParagraphs：视频段落单独成 part，其余合并回 markdown", () => {
	const parts = splitMediaParagraphs(
		"说明文字\n\n/v/clip.mp4\n\n![a](/x/a.png)\n\n结尾",
	);
	expect(parts).toEqual([
		{ kind: "markdown", text: "说明文字" },
		{ kind: "video", src: "/v/clip.mp4", name: "clip.mp4" },
		{ kind: "markdown", text: "![a](/x/a.png)\n\n结尾" },
	]);
});

test("splitMediaParagraphs：围栏代码块内空行不分段", () => {
	const text = "前文\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n后文";
	const parts = splitMediaParagraphs(text);
	expect(parts).toEqual([
		{ kind: "markdown", text: "前文" },
		{ kind: "markdown", text: "```ts\nconst a = 1;\n\nconst b = 2;\n```" },
		{ kind: "markdown", text: "后文" },
	]);
});

test("splitMediaParagraphs：代码块内形似视频路径的行（混在其他代码中）不抽为视频", () => {
	// 整块围栏恰为单个媒体路径是「产出路径写进 ```text 块」特性（见 matchFencedMedia）；
	// 这里锁定保护面：围栏内还有其他内容时仍按代码块渲染
	const text = "```\nls -l /v/clip.mp4\n```";
	expect(splitMediaParagraphs(text)).toEqual([{ kind: "markdown", text }]);
});

test("collectMediaItems：图片与视频按文档顺序收集", () => {
	const items = collectMediaItems(
		"![a](/x/a.png)\n\n/v/clip.mp4\n\n![b](https://y.com/b.jpg)",
	);
	expect(items).toEqual([
		{ src: "/x/a.png", kind: "image", name: "a" },
		{ src: "/v/clip.mp4", kind: "video", name: "clip.mp4" },
		{ src: "https://y.com/b.jpg", kind: "image", name: "b" },
	]);
});

test("collectMediaItems：代码块内的图片语法不收集", () => {
	expect(collectMediaItems("```\n![x](/x.png)\n```")).toEqual([]);
});

test("resolveCopyPath：http 原样，本地路径解析为绝对路径", () => {
	expect(resolveCopyPath("https://x.com/v.mp4", "s1")).toBe("https://x.com/v.mp4");
	expect(resolveCopyPath("out/v.mp4", "s1")).toBe("/home/me/proj/out/v.mp4");
});

test("mediaUrlTransform：Windows 盘符路径放行，注入协议仍消毒", () => {
	// react-markdown 默认 urlTransform 把 C:/... 误判为协议 "c" 清洗为空串
	expect(mediaUrlTransform("C:/work/a.png")).toBe("C:/work/a.png");
	expect(mediaUrlTransform("D:\\work\\b.png")).toBe("D:\\work\\b.png");
	expect(mediaUrlTransform("/home/x/a.png")).toBe("/home/x/a.png");
	expect(mediaUrlTransform("https://x.com/a.png")).toBe("https://x.com/a.png");
	expect(mediaUrlTransform("javascript:alert(1)")).toBe("");
});

test("collectMediaItems：反引号媒体路径按文档顺序收集（FilePill 同款场景）", () => {
	// 模型常用表格/行内代码列路径：`out/logo-blue.png`
	const items = collectMediaItems(
		"已保存：\n\n| 文件 | 路径 |\n| --- | --- |\n| 蓝 | `out/logo-blue.png` |\n\n视频在 `out/clip.mp4:12` 这里。",
	);
	expect(items).toEqual([
		{ src: "out/logo-blue.png", kind: "image", name: "logo-blue.png" },
		{ src: "out/clip.mp4", kind: "video", name: "clip.mp4" },
	]);
});

test("collectMediaItems：同一文件 ![]() 与反引号路径重复时去重（保留首次）", () => {
	const items = collectMediaItems("![a](/x/a.png)\n\n见 `/x/a.png` 与 `/x/b.png`。");
	expect(items).toEqual([
		{ src: "/x/a.png", kind: "image", name: "a" },
		{ src: "/x/b.png", kind: "image", name: "b.png" },
	]);
});

test("collectMediaItems：反引号内非媒体扩展名不收集", () => {
	expect(collectMediaItems("改一下 `src/index.ts` 和 `README.md`")).toEqual([]);
});

test("matchFencedMedia：整块围栏恰为单个媒体路径才命中", () => {
	expect(matchFencedMedia("```text\nH:\\work\\test_video.mp4\n```")).toEqual({
		src: "H:\\work\\test_video.mp4",
		kind: "video",
		name: "test_video.mp4",
	});
	expect(matchFencedMedia("```\n/x/a.png\n```")).toEqual({
		src: "/x/a.png",
		kind: "image",
		name: "a.png",
	});
	// 围栏内多行/非媒体/带说明文字 → 不命中
	expect(matchFencedMedia("```\npath: /x/a.png\n```")).toBeNull();
	expect(matchFencedMedia("```\n/x/a.png\n/x/b.png\n```")).toBeNull();
	expect(matchFencedMedia("```ts\nconst a = 1;\n```")).toBeNull();
	expect(matchFencedMedia("普通段落")).toBeNull();
});

test("splitMediaParagraphs：整块围栏媒体路径抽为媒体 part", () => {
	const parts = splitMediaParagraphs(
		"生成完毕。\n\n```text\n/v/test_video.mp4\n```\n\n查收。",
	);
	expect(parts).toEqual([
		{ kind: "markdown", text: "生成完毕。" },
		{ kind: "video", src: "/v/test_video.mp4", name: "test_video.mp4" },
		{ kind: "markdown", text: "查收。" },
	]);
});

test("collectMediaItems：整块围栏媒体路径收进画廊清单", () => {
	const items = collectMediaItems(
		"![a](/x/a.png)\n\n```text\n/v/clip.mp4\n```",
	);
	expect(items).toEqual([
		{ src: "/x/a.png", kind: "image", name: "a" },
		{ src: "/v/clip.mp4", kind: "video", name: "clip.mp4" },
	]);
});

test("collectMediaItems：反斜杠路径归一为正斜杠（Windows 模型输出口径）", () => {
	const items = collectMediaItems("见 `H:\\work\\proj\\logo.png`。");
	expect(items).toEqual([
		{ src: "H:/work/proj/logo.png", kind: "image", name: "logo.png" },
	]);
});

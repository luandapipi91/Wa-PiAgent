import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { createMarkdownComponents } from "../../src/components/blocks/markdown-components";
import { collectMediaItems } from "../../src/components/blocks/media-utils";
import { useSessionStore } from "../../src/store/session";

/** 用真实 markdown 渲染（与生产同路径）：text → ReactMarkdown + createMarkdownComponents */
function renderMd(text: string) {
	const items = collectMediaItems(text);
	return render(
		<ReactMarkdown components={createMarkdownComponents("s1", items)}>
			{text}
		</ReactMarkdown>,
	);
}

// happy-dom 在 about:blank 下无法解析相对 URL（/file?path=...），img 插入时同步 fire
// error 导致本地图片直接降级 FilePill。本文件把页面 URL 临时设为 http://localhost/
// 让相对 URL 可解析（enableImageFileLoading=false，不会真实加载），跑完恢复。
beforeAll(() => (window as any).happyDOM?.setURL?.("http://localhost/"));
afterAll(() => (window as any).happyDOM?.setURL?.("about:blank"));

beforeEach(() => {
	useSessionStore.setState({ mediaPreview: null });
});
afterEach(() => cleanup());

test("单图渲染为卡片：img src 经 resolveMediaSrc 映射（http 原样）", () => {
	renderMd("![cat](https://x.com/cat.png)");
	const card = screen.getByTestId("md-image-card");
	const img = card.querySelector("img")!;
	expect(img.getAttribute("src")).toBe("https://x.com/cat.png");
	expect(img.getAttribute("loading")).toBe("lazy");
	// 底部信息行显示文件名
	expect(card.textContent).toContain("cat.png");
});

test("本地绝对路径图片 src 映射为 /file?path=", () => {
	renderMd("![shot](/home/me/proj/out/shot.png)");
	const img = screen.getByTestId("md-image-card").querySelector("img")!;
	expect(img.getAttribute("src")).toBe(
		"/file?path=" + encodeURIComponent("/home/me/proj/out/shot.png"),
	);
});

test("onLoad 后从 naturalWidth/Height 填充尺寸", () => {
	renderMd("![cat](https://x.com/cat.png)");
	const img = screen.getByTestId("md-image-card").querySelector("img")!;
	Object.defineProperty(img, "naturalWidth", { value: 800, configurable: true });
	Object.defineProperty(img, "naturalHeight", { value: 600, configurable: true });
	fireEvent.load(img);
	expect(screen.getByTestId("md-image-dims").textContent).toBe("800×600");
});

test("点击卡片打开画廊：store mediaPreview 指向该图", () => {
	const text = "![cat](https://x.com/cat.png)";
	renderMd(text);
	fireEvent.click(screen.getByTestId("md-image-card"));
	expect(useSessionStore.getState().mediaPreview).toEqual({
		items: [{ src: "https://x.com/cat.png", kind: "image", name: "cat" }],
		index: 0,
		sessionId: "s1",
	});
});

test("本地图片加载失败降级（卡片消失，路径文本可见，不破图）", async () => {
	renderMd("![shot](/home/me/proj/out/shot.png)");
	const img = screen.getByTestId("md-image-card").querySelector("img")!;
	fireEvent.error(img);
	await waitFor(() =>
		expect(screen.queryByTestId("md-image-card")).toBeNull(),
	);
	// FilePill stat 失败/不存在时回退 <code>，至少路径文本保留
	expect(document.body.textContent).toContain("shot.png");
});

test("远程图片加载失败降级为普通链接", async () => {
	renderMd("![cat](https://x.com/cat.png)");
	fireEvent.error(screen.getByTestId("md-image-card").querySelector("img")!);
	await waitFor(() => expect(screen.queryByTestId("md-image-card")).toBeNull());
	const a = screen.getByRole("link");
	expect(a.getAttribute("href")).toBe("https://x.com/cat.png");
});

test("连续 2 图渲染为 2 列网格", () => {
	renderMd("![a](https://x.com/a.png)\n![b](https://x.com/b.png)");
	const grid = screen.getByTestId("md-image-grid");
	expect(grid.querySelectorAll('[data-testid="md-image-card"]').length).toBe(2);
});

test("超过 4 张只显示前 4 张，第 4 张叠 +N 遮罩", () => {
	const text = [1, 2, 3, 4, 5, 6]
		.map((i) => `![p${i}](https://x.com/p${i}.png)`)
		.join("\n");
	renderMd(text);
	expect(screen.getAllByTestId("md-image-card").length).toBe(4);
	expect(screen.getByTestId("md-image-more").textContent).toBe("+2");
});

test("点击 +N 遮罩从第 4 张进入画廊（items 为全部 6 张）", () => {
	const text = [1, 2, 3, 4, 5, 6]
		.map((i) => `![p${i}](https://x.com/p${i}.png)`)
		.join("\n");
	renderMd(text);
	fireEvent.click(screen.getByTestId("md-image-more"));
	const mp = useSessionStore.getState().mediaPreview;
	expect(mp?.items.length).toBe(6);
	expect(mp?.index).toBe(3);
});

test("空行分隔的图片不聚合（非连续）", () => {
	renderMd("![a](https://x.com/a.png)\n\n![b](https://x.com/b.png)");
	expect(screen.queryByTestId("md-image-grid")).toBeNull();
	expect(screen.getAllByTestId("md-image-card").length).toBe(2);
});

test("反引号图片路径（芯片场景）渲染为图片卡片而非 FilePill", () => {
	renderMd("| 文件 | 路径 |\n| --- | --- |\n| 蓝 | `/home/me/proj/out/logo-blue.png` |");
	const card = screen.getByTestId("md-image-card");
	const img = card.querySelector("img")!;
	expect(img.getAttribute("src")).toBe(
		"/file?path=" + encodeURIComponent("/home/me/proj/out/logo-blue.png"),
	);
	expect(screen.queryByTestId("file-pill")).toBeNull();
});

test("反引号视频路径渲染为内联播放器", () => {
	renderMd("成片：`/home/me/proj/out/clip.mp4` 查收");
	expect(screen.getByTestId("inline-video").querySelector("video")).toBeTruthy();
});

test("反引号非媒体路径仍渲染 FilePill", async () => {
	renderMd("改一下 `src/index.ts` 这里");
	// FilePill 需 stat 探测，未注入 transport 时 catch → fileExists=false → 回退纯文本 code；
	// 无论哪种结果都不应出现图片卡片
	await waitFor(() =>
		expect(screen.queryByTestId("md-image-card")).toBeNull(),
	);
});

test("表格里反斜杠路径芯片渲染为卡片，点击画廊收齐全部图片（真实场景回归）", () => {
	// 模型在 Windows 上写反斜杠路径：items 归一后与 parseFilePath 口径一致，画廊不再退化为单媒体
	const text =
		"| 文件 | 路径 |\n| --- | --- |\n| 蓝 | `H:\\work\\logo-blue.png` |\n| 橙 | `H:\\work\\logo-orange.png` |";
	renderMd(text);
	const cards = screen.getAllByTestId("md-image-card");
	expect(cards).toHaveLength(2);
	fireEvent.click(cards[0]);
	const mp = useSessionStore.getState().mediaPreview;
	expect(mp?.items).toEqual([
		{ src: "H:/work/logo-blue.png", kind: "image", name: "logo-blue.png" },
		{ src: "H:/work/logo-orange.png", kind: "image", name: "logo-orange.png" },
	]);
	expect(mp?.index).toBe(0);
});

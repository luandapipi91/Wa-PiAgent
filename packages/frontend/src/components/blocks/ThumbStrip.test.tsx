// 缩略图条组件测试：同目录画廊可能有上千张图，条内只渲染窗口内的项（虚拟滚动），
// 当前项/点击回调/图片与视频的渲染形态都要保持既有行为。
import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThumbStrip } from "./ThumbStrip";
import type { MediaItem } from "./media-utils";

function manyItems(n: number): MediaItem[] {
	return Array.from({ length: n }, (_, i) => ({
		src: `/dir/img-${i}.png`,
		kind: "image" as const,
		name: `img-${i}.png`,
	}));
}

test("窗口化：1000 项目录只渲染可见区间，不全量渲染", () => {
	render(
		<ThumbStrip items={manyItems(1000)} index={0} sessionId="s1" onSelect={() => {}} />,
	);
	const thumbs = screen.getAllByTestId("media-thumb");
	expect(thumbs.length).toBeGreaterThan(5);
	expect(thumbs.length).toBeLessThan(200);
});

test("当前项高亮（border-accent），其余不高亮", () => {
	render(
		<ThumbStrip items={manyItems(10)} index={3} sessionId="s1" onSelect={() => {}} />,
	);
	const thumbs = screen.getAllByTestId("media-thumb");
	expect(thumbs[3].className).toContain("border-accent");
	expect(thumbs[2].className).toContain("border-hairline");
});

test("点击缩略图回调其原始索引", () => {
	const clicks: number[] = [];
	render(
		<ThumbStrip
			items={manyItems(10)}
			index={0}
			sessionId="s1"
			onSelect={(i) => clicks.push(i)}
		/>,
	);
	fireEvent.click(screen.getAllByTestId("media-thumb")[4]);
	expect(clicks).toEqual([4]);
});

test("图片项渲染 img，视频项渲染播放图标（无 img）", () => {
	const items: MediaItem[] = [
		{ src: "/d/a.png", kind: "image", name: "a.png" },
		{ src: "/d/v.mp4", kind: "video", name: "v.mp4" },
	];
	render(
		<ThumbStrip items={items} index={0} sessionId="s1" onSelect={() => {}} />,
	);
	const thumbs = screen.getAllByTestId("media-thumb");
	expect(thumbs[0].querySelector("img")).toBeTruthy();
	expect(thumbs[1].querySelector("img")).toBeNull();
	expect(thumbs[1].querySelector("svg")).toBeTruthy();
});

test("当前项在窗口外：把该位置滚进窗口并渲染出来", () => {
	// 1000 项、index=900：窗口只覆盖开头时 900 项不会被渲染
	render(
		<ThumbStrip items={manyItems(1000)} index={900} sessionId="s1" onSelect={() => {}} />,
	);
	const srcs = screen
		.getAllByTestId("media-thumb")
		.map((el) => el.querySelector("img")?.getAttribute("src") ?? "");
	expect(srcs.some((s) => s.includes("img-900.png"))).toBe(true);
	// 当前项高亮一定在窗口内
	const active = screen
		.getAllByTestId("media-thumb")
		.find((el) => el.className.includes("border-accent"));
	expect(active?.querySelector("img")?.getAttribute("src")).toContain(
		"img-900.png",
	);
});

test("项数很少（单媒体）时也至少渲染当前项", () => {
	render(
		<ThumbStrip items={manyItems(1)} index={0} sessionId="s1" onSelect={() => {}} />,
	);
	expect(screen.getAllByTestId("media-thumb").length).toBe(1);
});

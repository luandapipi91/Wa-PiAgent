// FileChangeSummary：文件修改卡片（含失效路径 missing / movedTo 处理）
import { test, expect, describe, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { FileChangeSummary } from "../src/components/blocks/FileChangeSummary";

const openFileOrPreview = mock(() => {});
mock.module("../src/open-file-preview", () => ({ openFileOrPreview }));

const base = (over: Record<string, unknown> = {}) => ({
	path: "/prj/keep.html",
	before: "a",
	after: "b",
	...over,
});

function openList() {
	fireEvent.click(screen.getByText(/文件修改/));
}

describe("FileChangeSummary", () => {
	beforeEach(() => {
		openFileOrPreview.mockClear();
	});

	test("正常条目：路径可点打开原位置，预览/分享存在", () => {
		render(<FileChangeSummary sessionId="s1" files={[base()]} />);
		openList();
		fireEvent.click(screen.getByText("/prj/keep.html"));
		expect(openFileOrPreview).toHaveBeenCalledWith("/prj/keep.html", "s1");
		expect(
			screen.getByTestId("file-change-share-/prj/keep.html"),
		).toBeTruthy();
		expect(screen.getByText("预览")).toBeTruthy();
	});

	test("missing 且无 movedTo：失效徽标，路径不可点、无预览/分享（diff 仍可展开）", () => {
		render(
			<FileChangeSummary
				sessionId="s1"
				files={[base({ path: "/prj/gone.html", missing: true })]}
			/>,
		);
		openList();
		expect(screen.getByText("文件已移动或删除")).toBeTruthy();
		// 路径不再渲染为可点按钮（打开必然 ENOENT）
		expect(
			screen.queryByRole("button", { name: "/prj/gone.html" }),
		).toBeNull();
		expect(screen.getByText(/prj[/]gone[.]html/)).toBeTruthy();
		expect(screen.queryByText("预览")).toBeNull();
		expect(
			screen.queryByTestId("file-change-share-/prj/gone.html"),
		).toBeNull();
	});

	test("missing + movedTo：显示新路径，点击打开新位置，原路径留档", () => {
		render(
			<FileChangeSummary
				sessionId="s1"
				files={[
					base({
						path: "/prj/old/moved.html",
						missing: true,
						movedTo: "/prj/new/moved.html",
					}),
				]}
			/>,
		);
		openList();
		expect(screen.getByText("文件已移动或删除")).toBeTruthy();
		expect(screen.getByText(/原路径/)).toBeTruthy();
		const btn = screen.getByText("/prj/new/moved.html");
		fireEvent.click(btn);
		expect(openFileOrPreview).toHaveBeenCalledWith(
			"/prj/new/moved.html",
			"s1",
		);
		expect(
			screen.getByTestId("file-change-share-/prj/old/moved.html"),
		).toBeTruthy();
	});
});

describe("审查建议：gone 状态保留 diff 展开", () => {
	test("missing 且找不回新位置：diff 仍可展开查看内容变化", () => {
		render(
			<FileChangeSummary
				sessionId="s1"
				files={[base({ path: "/prj/gone.html", missing: true })]}
			/>,
		);
		fireEvent.click(screen.getByText(/文件修改/));
		fireEvent.click(screen.getByText(/展开/));
		expect(screen.getByTestId("diff-/prj/gone.html")).toBeTruthy();
	});
});

// DirTreePicker 暗色适配测试：硬编码颜色已移除、死类已清理、主按钮走 token 类。
import { test, expect, afterEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import { _setFsTransport } from "../fs-client";
import { DirTreePicker } from "./DirTreePicker";

function mockTransport() {
	_setFsTransport({
		get: async (path: string) => {
			if (path === "/api/fs/home") return { home: "C:\\Users\\co" };
			if (path === "/api/fs/roots") return { roots: ["C:\\"] };
			return {};
		},
		post: async (path: string) => {
			if (path === "/api/fs/list-dir")
				return {
					entries: [
						{ name: "src", isDir: true },
						{ name: "readme.md", isDir: false },
					],
				};
			return {};
		},
		del: async () => ({}),
	});
}

afterEach(() => {
	_setFsTransport(null);
});

test("面板无内联 background 硬编码，使用 bg-surface token 类", async () => {
	mockTransport();
	const { container } = render(
		<DirTreePicker onPick={() => {}} onCancel={() => {}} />,
	);
	await waitFor(() => expect(screen.getByTestId("dir-pick")).toBeTruthy());
	const panel = container.querySelector(".bg-surface");
	expect(panel).toBeTruthy();
	expect((panel as HTMLElement).style.background).toBe(""); // 不再有 #FFFFFF 内联覆盖
});

test("确定按钮用 bg-brand text-white（主按钮范式），无内联颜色", async () => {
	mockTransport();
	render(<DirTreePicker onPick={() => {}} onCancel={() => {}} />);
	const pick = (await screen.findByTestId("dir-pick")) as HTMLButtonElement;
	expect(pick.className).toContain("bg-brand");
	expect(pick.className).toContain("text-white");
	expect(pick.style.background).toBe("");
	expect(pick.style.color).toBe("");
});

test("死类已清理：标题/取消/搜索框不再含 text-text、text-subtext、bg-surface0、-blue", async () => {
	mockTransport();
	render(<DirTreePicker onPick={() => {}} onCancel={() => {}} />);
	const search = await screen.findByTestId("dir-search");
	expect(search.className).toContain("bg-surface-elevated");
	expect(search.className).toContain("text-primary");
	expect(search.className).toContain("focus:border-brand");
	expect(search.className).not.toMatch(
		/text-text|bg-surface0|border-surface0|text-subtext|text-blue|border-blue|border-t-blue/,
	);
	expect(screen.getByTestId("dir-cancel").className).toContain("text-secondary");
	expect(screen.getByTestId("dir-cancel").className).not.toContain("text-subtext");
});

test("树节点正常渲染（默认 showFiles=false：只显示目录，文件被过滤）", async () => {
	mockTransport();
	render(<DirTreePicker onPick={() => {}} onCancel={() => {}} />);
	await waitFor(() => expect(screen.getByText("src")).toBeTruthy());
	expect(screen.queryByText("readme.md")).toBeNull();
});

test("showFiles=true 时文件节点也渲染", async () => {
	mockTransport();
	render(<DirTreePicker onPick={() => {}} onCancel={() => {}} showFiles />);
	await waitFor(() => expect(screen.getByText("readme.md")).toBeTruthy());
});

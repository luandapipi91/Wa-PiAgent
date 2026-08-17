// ExplorerPanel 渲染契约测试：workspaceDir 空态 / 列表渲染 / 目录展开触发二次 listDir。
import { test, expect, afterEach } from "bun:test";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { _setFsTransport } from "../fs-client";
import { ExplorerPanel } from "./ExplorerPanel";

function mockTransport() {
	_setFsTransport({
		get: async () => ({}),
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

test("无 workspaceDir 时渲染空态提示", () => {
	const { container } = render(
		<ExplorerPanel workspaceDir="" onOpenFile={() => {}} />,
	);
	expect(container.querySelector(".ep-empty")).toBeTruthy();
});

test("列表渲染：目录与文件节点带正确 data-kind", async () => {
	mockTransport();
	render(<ExplorerPanel workspaceDir="C:\\proj" onOpenFile={() => {}} />);
	await waitFor(() => expect(screen.getByText("src")).toBeTruthy());
	expect(screen.getByText("readme.md")).toBeTruthy();
	const dirNode = screen.getByText("src").closest(".ep-node") as HTMLElement;
	const fileNode = screen
		.getByText("readme.md")
		.closest(".ep-node") as HTMLElement;
	expect(dirNode.dataset.kind).toBe("dir");
	expect(fileNode.dataset.kind).toBe("file");
});

test("点击目录展开触发 listDir 再次调用并渲染子节点", async () => {
	let listDirCalls = 0;
	_setFsTransport({
		get: async () => ({}),
		post: async (path: string) => {
			if (path === "/api/fs/list-dir") {
				listDirCalls++;
				return listDirCalls === 1
					? { entries: [{ name: "src", isDir: true }] }
					: { entries: [{ name: "index.ts", isDir: false }] };
			}
			return {};
		},
		del: async () => ({}),
	});
	render(<ExplorerPanel workspaceDir="C:\\proj" onOpenFile={() => {}} />);
	await waitFor(() => expect(screen.getByText("src")).toBeTruthy());
	fireEvent.click(screen.getByText("src"));
	await waitFor(() => expect(screen.getByText("index.ts")).toBeTruthy());
	expect(listDirCalls).toBeGreaterThanOrEqual(2);
});

test("右键文件菜单含「默认方式打开」，点击调用 open-with-default-app", async () => {
	const calls: Array<{ path: string; body?: unknown }> = [];
	_setFsTransport({
		get: async () => ({}),
		post: async (path: string, body?: unknown) => {
			calls.push({ path, body });
			if (path === "/api/fs/list-dir")
				return { entries: [{ name: "readme.md", isDir: false }] };
			return {};
		},
		del: async () => ({}),
	});
	render(<ExplorerPanel workspaceDir="/proj" onOpenFile={() => {}} />);
	await waitFor(() => expect(screen.getByText("readme.md")).toBeTruthy());
	const fileNode = screen
		.getByText("readme.md")
		.closest(".ep-node") as HTMLElement;
	fireEvent.contextMenu(fileNode);

	fireEvent.click(screen.getByText("默认方式打开"));

	await waitFor(() =>
		expect(calls.some((c) => c.path === "/api/fs/open-with-default-app")).toBe(
			true,
		),
	);
	const openCall = calls.find((c) => c.path === "/api/fs/open-with-default-app");
	expect(openCall?.body).toEqual({ path: "/proj/readme.md" });
});

test("右键目录菜单不含「默认方式打开」", async () => {
	_setFsTransport({
		get: async () => ({}),
		post: async (path: string) => {
			if (path === "/api/fs/list-dir")
				return { entries: [{ name: "src", isDir: true }] };
			return {};
		},
		del: async () => ({}),
	});
	render(<ExplorerPanel workspaceDir="/proj" onOpenFile={() => {}} />);
	await waitFor(() => expect(screen.getByText("src")).toBeTruthy());
	const dirNode = screen.getByText("src").closest(".ep-node") as HTMLElement;
	fireEvent.contextMenu(dirNode);

	expect(screen.queryByText("默认方式打开")).toBeNull();
});

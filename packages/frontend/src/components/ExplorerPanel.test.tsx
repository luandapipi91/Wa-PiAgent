// ExplorerPanel 渲染契约测试：workspaceDir 空态 / 列表渲染 / 目录展开触发二次 listDir。
import { test, expect, afterEach } from "bun:test";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { _setFsTransport } from "../fs-client";
import { _setShareTransport } from "../share-client";
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
	_setShareTransport(null);
});

// 预置 listDir 返回固定条目（目录优先排序由组件负责，这里按传入顺序渲染）
function mockListDir(entries: Array<{ name: string; isDir: boolean }>) {
	_setFsTransport({
		get: async () => ({}),
		post: async (path: string) => {
			if (path === "/api/fs/list-dir") return { entries };
			return {};
		},
		del: async () => ({}),
	});
}

// 定位节点容器（data-selected 挂在 .ep-node 上）
function nodeOf(text: string): HTMLElement {
	return screen.getByText(text).closest(".ep-node") as HTMLElement;
}

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

test("Ctrl/Cmd+点击多选：两个文件节点 data-selected=true，再点取消", async () => {
	mockListDir([
		{ name: "a.ts", isDir: false },
		{ name: "b.ts", isDir: false },
	]);
	render(<ExplorerPanel workspaceDir="/proj" onOpenFile={() => {}} />);
	await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
	const a = nodeOf("a.ts");
	const b = nodeOf("b.ts");

	// 无修饰键点击 = 单选
	fireEvent.click(a);
	expect(a.dataset.selected).toBe("true");
	expect(b.dataset.selected).toBe("false");

	// Ctrl+点击 = toggle 进选中集
	fireEvent.click(b, { ctrlKey: true });
	expect(a.dataset.selected).toBe("true");
	expect(b.dataset.selected).toBe("true");

	// 再 Ctrl+点击 = 从选中集移除
	fireEvent.click(b, { ctrlKey: true });
	expect(b.dataset.selected).toBe("false");
	expect(a.dataset.selected).toBe("true");
});

test("Shift+点击区间连选：锚点到当前节点全选中", async () => {
	mockListDir([
		{ name: "a.ts", isDir: false },
		{ name: "b.ts", isDir: false },
		{ name: "c.ts", isDir: false },
	]);
	render(<ExplorerPanel workspaceDir="/proj" onOpenFile={() => {}} />);
	await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
	const a = nodeOf("a.ts");
	const b = nodeOf("b.ts");
	const c = nodeOf("c.ts");

	fireEvent.click(a); // 锚点 = a
	fireEvent.click(c, { shiftKey: true }); // a..c 区间连选
	expect(a.dataset.selected).toBe("true");
	expect(b.dataset.selected).toBe("true");
	expect(c.dataset.selected).toBe("true");
});

test("多选状态右键：菜单只有「分享所选」", async () => {
	mockListDir([
		{ name: "a.ts", isDir: false },
		{ name: "b.ts", isDir: false },
		{ name: "c.ts", isDir: false },
	]);
	render(<ExplorerPanel workspaceDir="/proj" onOpenFile={() => {}} />);
	await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
	const a = nodeOf("a.ts");
	const b = nodeOf("b.ts");

	fireEvent.click(a);
	fireEvent.click(b, { metaKey: true }); // Cmd 路径
	fireEvent.contextMenu(b);

	expect(screen.getByTestId("ep-ctx-share-multi")).toBeTruthy();
	expect(screen.queryByTestId("ep-ctx-share")).toBeNull();
	expect(screen.queryByText("复制路径")).toBeNull();
	expect(screen.queryByText("默认方式打开")).toBeNull();
	expect(screen.queryByText(/在(资源管理器|文件管理器|访达)中打开/)).toBeNull();
});

test("单选右键：菜单含「分享」与原有项", async () => {
	mockListDir([{ name: "b.ts", isDir: false }]);
	render(<ExplorerPanel workspaceDir="/proj" onOpenFile={() => {}} />);
	const node = await waitFor(() => nodeOf("b.ts"));
	fireEvent.contextMenu(node);

	expect(screen.getByTestId("ep-ctx-share")).toBeTruthy();
	expect(screen.getByText("复制路径")).toBeTruthy();
	expect(screen.getByText("默认方式打开")).toBeTruthy();
	expect(screen.getByText(/在(资源管理器|文件管理器|访达)中打开/)).toBeTruthy();
	expect(screen.queryByTestId("ep-ctx-share-multi")).toBeNull();
});

test("多选右键「分享所选」：打开分享弹层且上传 paths 为选中项", async () => {
	const uploads: Array<{ path: string; body?: unknown }> = [];
	_setShareTransport({
		get: async () => ({
			share: { hasToken: true, channel: "edgeone" },
		}),
		post: async (path: string, body?: unknown) => {
			uploads.push({ path, body });
			if (path === "/api/share/upload")
				return {
					url: "https://share.edgeone.app/s/abc",
					expiresAt: Date.now() + 3 * 3600 * 1000,
					projectName: "proj",
					channel: "edgeone",
				};
			return {};
		},
		put: async () => ({}),
	});
	mockListDir([
		{ name: "a.ts", isDir: false },
		{ name: "b.ts", isDir: false },
		{ name: "c.ts", isDir: false },
	]);
	render(<ExplorerPanel workspaceDir="/proj" onOpenFile={() => {}} />);
	await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
	const a = nodeOf("a.ts");
	const b = nodeOf("b.ts");

	fireEvent.click(a);
	fireEvent.click(b, { ctrlKey: true });
	fireEvent.contextMenu(b);
	fireEvent.click(screen.getByTestId("ep-ctx-share-multi"));

	// 分享弹层打开（shareSettings 返回 token → 显示待分享文件列表）
	await waitFor(() =>
		expect(screen.getByTestId("share-result-modal")).toBeTruthy(),
	);
	expect(screen.getByText("2 个文件")).toBeTruthy();
	fireEvent.click(screen.getByTestId("share-generate-btn"));
	await waitFor(() =>
		expect(uploads.some((c) => c.path === "/api/share/upload")).toBe(true),
	);
	const upload = uploads.find((c) => c.path === "/api/share/upload");
	expect(upload?.body).toEqual({
		paths: ["/proj/a.ts", "/proj/b.ts"],
		sessionId: undefined,
	});

	// 关闭分享弹层：sharePaths 被清空，弹层卸载
	fireEvent.click(screen.getByTestId("share-close"));
	await waitFor(() =>
		expect(screen.queryByTestId("share-result-modal")).toBeNull(),
	);
});

test("多选右键分享：文件 + 目录混合选中，分享 paths 含文件与目录路径", async () => {
	const uploads: Array<{ path: string; body?: unknown }> = [];
	_setShareTransport({
		get: async () => ({
			share: { hasToken: true, channel: "edgeone" },
		}),
		post: async (path: string, body?: unknown) => {
			uploads.push({ path, body });
			if (path === "/api/share/upload")
				return {
					url: "https://share.edgeone.app/s/abc",
					expiresAt: Date.now() + 3 * 3600 * 1000,
					projectName: "proj",
					channel: "edgeone",
				};
			return {};
		},
		put: async () => ({}),
	});
	mockListDir([
		{ name: "src", isDir: true },
		{ name: "a.ts", isDir: false },
	]);
	render(<ExplorerPanel workspaceDir="/proj" onOpenFile={() => {}} />);
	await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
	const file = nodeOf("a.ts");
	const dir = nodeOf("src");

	fireEvent.click(file); // 单选文件
	fireEvent.click(dir, { ctrlKey: true }); // Ctrl+点击目录加入选中集（不展开）
	fireEvent.contextMenu(dir); // 右键选中集内目录 → 分享所选
	fireEvent.click(screen.getByTestId("ep-ctx-share-multi"));

	// 分享弹层打开并生成
	await waitFor(() =>
		expect(screen.getByTestId("share-result-modal")).toBeTruthy(),
	);
	fireEvent.click(screen.getByTestId("share-generate-btn"));
	await waitFor(() =>
		expect(uploads.some((c) => c.path === "/api/share/upload")).toBe(true),
	);
	const upload = uploads.find((c) => c.path === "/api/share/upload");
	expect(upload?.body).toEqual({
		paths: ["/proj/a.ts", "/proj/src"],
		sessionId: undefined,
	});
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

test("多选后无修饰键点击目录：清除多选、单选该目录（原多选不残留）", async () => {
	mockListDir([
		{ name: "src", isDir: true },
		{ name: "a.ts", isDir: false },
	]);
	render(<ExplorerPanel workspaceDir="/proj" onOpenFile={() => {}} />);
	await waitFor(() => expect(screen.getByText("src")).toBeTruthy());
	const src = nodeOf("src");
	const a = nodeOf("a.ts");

	// Ctrl+点击 a 和 src 形成多选
	fireEvent.click(a, { ctrlKey: true });
	fireEvent.click(src, { ctrlKey: true });
	expect(a.dataset.selected).toBe("true");
	expect(src.dataset.selected).toBe("true");

	// 无修饰键点击另一个目录（此处点击 src 本身即可验证：多选应被清除、单选 src）
	fireEvent.click(src);
	expect(a.dataset.selected).toBe("false");
	expect(src.dataset.selected).toBe("true");
});
